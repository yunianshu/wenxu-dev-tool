/**
 * 发布包生成 —— 按方案 §6/§7 生成 ZIP：
 *   - 默认排除常见构建/缓存目录与临时文件
 *   - 支持项目自定义 .deployignore 规则（与 .gitignore 语法子集）
 *   - ZIP 内文件平铺在根目录（服务器端 unzip -d 后即为项目根）
 *   - 同时计算 SHA256，上传后用于服务器端完整性校验
 * 纯 Node 实现（archiver），可独立单测。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const archiver = require('archiver')

/** 方案 §6.1 默认排除规则 */
const DEFAULT_EXCLUDES = [
  '.git', '.idea', '.vscode', 'node_modules', 'target', 'build', 'dist',
  '.gradle', 'logs', 'tmp', 'temp', '*.log', '*.tmp',
]

/**
 * 将一条忽略规则编译为匹配器。支持语法子集：
 *   - 注释行（#）与空行忽略
 *   - 「名称」：匹配任意层级的同名文件/目录（如 node_modules、.git）
 *   - 「*.后缀」：匹配任意层级的通配文件（如 *.log）
 *   - 「dir/」：匹配任意层级的目录（排除其下所有内容）
 *   - 「a/b」或「/a/b」：相对项目根的路径匹配
 */
function compileRule(raw) {
  let line = raw.trim()
  if (!line || line.startsWith('#')) return null
  const include = line.startsWith('!')
  if (include) line = line.slice(1)
  // gitignore 语义：前导 / 表示锚定项目根，必须先判断再去掉
  const anchored = line.startsWith('/')
  line = line.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!line) return null
  const regexStr = line
    .split('/')
    .map((seg) => seg
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]'))
    .join('/')
  if (anchored || line.includes('/')) {
    // 锚定根或带路径：只从根匹配（注意不能误伤路径中段的同名目录）
    return { re: new RegExp(`^${regexStr}(/.*)?$`, 'i'), include, pattern: line }
  }
  // 纯名称/通配：匹配任意层级的段
  return { re: new RegExp(`(^|/)${regexStr}(/.*)?$`, 'i'), include, pattern: line }
}

/** 忽略规则集合 */
function createMatcher(extraRules, { includeBuild = false } = {}) {
  const defaults = includeBuild ? DEFAULT_EXCLUDES.filter((r) => !['dist', 'build', 'target'].includes(r)) : DEFAULT_EXCLUDES
  const rules = [...defaults, ...(extraRules || [])]
    .map(compileRule)
    .filter(Boolean)
  return {
    /** relPath 使用 POSIX 分隔符；返回 true 表示忽略 */
    ignored(relPath) {
      let ignored = false
      for (const r of rules) if (r.re.test(relPath)) ignored = !r.include
      return ignored
    },
    mayInclude(relPath) { return rules.some((r) => r.include && r.pattern.startsWith(`${relPath}/`)) },
  }
}

/** 指向目录的符号链接也按目录下钻（项目里链接的子目录必须进发布包，否则服务器端缺文件） */
function isWalkableDir(ent, abs) {
  if (ent.isDirectory()) return true
  if (ent.isSymbolicLink()) {
    try {
      return fs.statSync(abs).isDirectory()
    } catch {
      return false // 悬空链接
    }
  }
  return false
}

/** 递归收集未被忽略的文件（POSIX 相对路径）；visited 按 realpath 防符号链接环路 */
function collectFiles(rootDir, matcher, onFile, safeRoot = false, exclude) {
  const base = fs.realpathSync(rootDir)
  const inside = (p) => { const r = path.relative(base, fs.realpathSync(p)); return !r.startsWith('..') && !path.isAbsolute(r) }
  const visited = new Set()
  const walk = (dir, rel) => {
    let realDir
    try {
      realDir = fs.realpathSync(dir)
    } catch {
      return
    }
    if (visited.has(realDir)) return // 环路或同一目录被多条链接指向
    visited.add(realDir)
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name
      if (exclude?.(relPath)) continue
      const abs = path.join(dir, ent.name)
      if (safeRoot && ent.isSymbolicLink() && !inside(abs)) throw new Error(`发布文件越出项目目录: ${relPath}`)
      if (matcher.ignored(relPath) && !(isWalkableDir(ent, abs) && matcher.mayInclude(relPath))) continue
      if (isWalkableDir(ent, abs)) {
        walk(abs, relPath)
      } else if (ent.isFile()) {
        onFile(abs, relPath)
      } else if (ent.isSymbolicLink()) {
        // 符号链接指向文件时按文件收录（archiver 收内容，解压后为普通文件）；悬空链接跳过
        try {
          if (fs.statSync(abs).isFile()) onFile(abs, relPath)
        } catch { /* 悬空链接 */ }
      }
    }
  }
  walk(rootDir, '')
}

/** 读取项目 .deployignore（存在时追加到默认规则） */
function readDeployIgnore(projectDir) {
  const p = path.join(projectDir, '.deployignore')
  if (!fs.existsSync(p)) return []
  try {
    return fs.readFileSync(p, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * 生成发布包。
 * @param {object} opts { projectDir, appName, version, onProgress?(percent, fileCount) }
 * @returns {Promise<{zipPath, fileName, sha256, fileCount, sizeBytes}>}
 */
function buildPackage(opts) {
  const { projectDir, appName, version, onProgress } = opts || {}
  if (!fs.existsSync(projectDir)) return Promise.reject(new Error(`项目目录不存在: ${projectDir}`))

  const matcher = createMatcher(readDeployIgnore(projectDir), { includeBuild: opts.includeBuild })
  const overlays = opts.files || []
  for (const f of overlays) {
    if (!f.path || path.posix.isAbsolute(f.path) || f.path.includes('\\') || f.path.split('/').some((s) => !s || s === '..')) {
      return Promise.reject(new Error('生成的部署文件路径不安全'))
    }
  }
  const stamp = formatStamp(new Date())
  const safeName = (appName || 'app').replace(/[^\w.-]+/g, '_')
  const fileName = `${safeName}-${version || 'unknown'}-${stamp}.zip`
  // 输出到系统临时目录而非项目目录：避免残留 zip 后续被卷进发布包，
  // 也避免在用户项目里留临时文件（上传后由 deploy-service 统一清理）
  const zipPath = path.join(os.tmpdir(), 'onedeploy', fileName)
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 6 } })
    let fileCount = 0
    let settled = false
    const done = (fn) => (v) => { if (!settled) { settled = true; fn(v) } }

    output.on('close', done(() => {
      // 流式计算哈希：同步 readFileSync 会把整个包读进内存并阻塞主进程（大包数百 MB）
      sha256FileStream(zipPath)
        .then((sha256) => resolve({ zipPath, fileName, sha256, fileCount, sizeBytes: archive.pointer() }))
        .catch(reject)
    }))
    output.on('error', done(reject))
    archive.on('error', done(reject))
    archive.on('progress', (data) => {
      fileCount = data.entries.processed
      if (onProgress) onProgress(fileCount)
    })
    archive.pipe(output)

    const selfZipName = fileName // 输出 zip 就写在项目目录里，绝不能把自己打进去
    collectFiles(projectDir, matcher, (abs, rel) => {
      // .deployignore 是本工具的忽略规则文件；.dockerignore 必须保留（服务器端 docker build 依赖它过滤构建上下文）
      if (rel === selfZipName || rel === '.deployignore' || overlays.some((f) => f.path === rel)) return
      if (opts.exclude && opts.exclude(rel)) return
      archive.file(abs, { name: rel })
    }, opts.safeRoot, opts.exclude)
    for (const f of overlays) archive.append(f.content, { name: f.path })
    archive.finalize()
  })
}

function formatStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 文件 SHA256（流式读取，发布包可达数百 MB，不能同步整读阻塞主进程） */
function sha256FileStream(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(p)
    s.on('error', reject)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * 生成数据同步包：把项目内指定数据目录完整打为 ZIP（不做任何忽略过滤，
 * 数据目录内容所见即所得），服务器端解压覆盖到共享目录。
 * @param {object} opts { projectDir, dataDir(相对项目根), appName, version }
 * @returns {Promise<{zipPath, fileName, sha256, fileCount, sizeBytes, sourceDir}>}
 */
function buildDataPackage(opts) {
  const { projectDir, dataDir, appName, version } = opts || {}
  if (!dataDir || typeof dataDir !== 'string') {
    return Promise.reject(new Error('未指定数据目录'))
  }
  const sourceDir = path.resolve(projectDir, dataDir)
  if (!fs.existsSync(sourceDir)) return Promise.reject(new Error(`数据目录不存在: ${sourceDir}`))
  if (!fs.statSync(sourceDir).isDirectory()) return Promise.reject(new Error(`数据目录不是文件夹: ${sourceDir}`))

  const stamp = formatStamp(new Date())
  const safeName = (appName || 'app').replace(/[^\w.-]+/g, '_')
  const fileName = `${safeName}-data-${version || 'unknown'}-${stamp}.zip`
  const zipPath = path.join(os.tmpdir(), 'onedeploy', fileName)
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath)
    const archive = archiver('zip', { zlib: { level: 6 } })
    let fileCount = 0
    let settled = false
    const done = (fn) => (v) => { if (!settled) { settled = true; fn(v) } }

    output.on('close', done(() => {
      sha256FileStream(zipPath)
        .then((sha256) => resolve({ zipPath, fileName, sha256, fileCount, sizeBytes: archive.pointer(), sourceDir }))
        .catch(reject)
    }))
    output.on('error', done(reject))
    archive.on('error', done(reject))
    archive.pipe(output)

    // 完整收集：数据目录内容所见即所得（空目录打包为目录条目，保留结构）
    const walk = (dir, rel) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name)
        const relPath = rel ? `${rel}/${ent.name}` : ent.name
        if (ent.isDirectory()) {
          archive.append(null, { name: `${relPath}/` })
          walk(abs, relPath)
        } else if (ent.isFile()) {
          archive.file(abs, { name: relPath })
          fileCount += 1 // 只统计文件（目录条目不计数）
        }
      }
    }
    walk(sourceDir, '')
    archive.finalize()
  })
}

module.exports = { buildPackage, buildDataPackage, createMatcher, DEFAULT_EXCLUDES }
