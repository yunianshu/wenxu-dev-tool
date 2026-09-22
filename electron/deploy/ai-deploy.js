/**
 * AI 部署助手 —— 面向「首次接入部署」的项目（新项目，或已有部署方式与本工具的
 * 部署契约不匹配的项目）：
 *
 *   scanLocal   本地项目静态体检（纯 Node，不依赖 AI）：技术栈、部署文件、版本来源、
 *               Compose 关键信息、数据目录候选、敏感文件、与当前配置不符的问题
 *   scanRemote  服务器体检（SSH）：工具链、磁盘、部署目录现状、已有部署与容器、端口占用
 *   diagnose    把两份体检 + 部署契约交给 AI，产出结构化「部署方案」：
 *               部署形态 / 脚本模式 / 版本 / 健康检查 / 数据库备份 / 数据同步结论 /
 *               需要生成或改写的部署文件 / 首次部署前置条件 / 风险
 *   writeFiles  把方案中的文件写入项目（路径白名单 + 先备份 + 绝不越出项目目录）
 *   applyPlan   把方案写回部署配置（形态、compose、脚本模式、版本、目标的健康检查/数据库/数据同步）
 *
 * 设计要点：确定性体检 + 启发式方案（buildHeuristicPlan）保底，AI 只做增强。
 * AI 未配置或调用失败时，功能仍给出可用的确定性结论，界面上明确标注结论来源。
 */
const fs = require('fs')
const path = require('path')
const { parse: parseYaml } = require('yaml')
const projects = require('./deploy-projects')
const ssh = require('./ssh-service')
const store = require('../store')
const aiService = require('../ai-service')
const { detectVersion } = require('./version-detector')

/** 体检时单个文本文件的读取上限（Compose / 脚本内容） */
const MAX_TEXT_BYTES = 24 * 1024
/** 送给 AI 的既有部署文件内容总量上限（超出则截断并标注） */
const AI_FILE_PAYLOAD_BYTES = 48 * 1024
/** 单个生成文件的内容上限（防御 AI 输出异常） */
const MAX_GENERATED_BYTES = 400 * 1024

/** 技术栈标记文件（存在即认为项目使用该技术栈） */
const STACK_MARKERS = [
  ['package.json', 'node', 'Node.js'],
  ['pom.xml', 'java', 'Java / Maven'],
  ['build.gradle', 'java', 'Java / Gradle'],
  ['build.gradle.kts', 'java', 'Java / Gradle'],
  ['settings.gradle', 'java', 'Java / Gradle'],
  ['requirements.txt', 'python', 'Python'],
  ['pyproject.toml', 'python', 'Python'],
  ['manage.py', 'python', 'Django'],
  ['go.mod', 'go', 'Go'],
  ['Cargo.toml', 'rust', 'Rust'],
  ['pubspec.yaml', 'flutter', 'Flutter / Dart'],
  ['composer.json', 'php', 'PHP'],
  ['Gemfile', 'ruby', 'Ruby'],
  ['mix.exs', 'elixir', 'Elixir'],
  ['CMakeLists.txt', 'cpp', 'C / C++'],
]

/** Compose 常见命名（与 deploy-service 保持一致） */
const COMPOSE_CANDIDATES = [
  'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'deploy/docker-compose.yml', 'deploy/docker-compose.yaml', 'deploy/compose.yml', 'deploy/compose.yaml',
]

/** 部署文件清单一：存在即收录（用于判断项目「有没有部署方式」） */
const DEPLOY_FILE_SPECS = [
  { rel: 'Dockerfile', kind: 'docker', label: '镜像构建文件' },
  { rel: '.dockerignore', kind: 'docker', label: '构建上下文忽略规则' },
  { rel: '.deployignore', kind: 'package', label: '发布包忽略规则' },
  { rel: 'docker-compose.yml', kind: 'compose', label: 'Compose 编排' },
  { rel: 'docker-compose.yaml', kind: 'compose', label: 'Compose 编排' },
  { rel: 'compose.yml', kind: 'compose', label: 'Compose 编排' },
  { rel: 'compose.yaml', kind: 'compose', label: 'Compose 编排' },
  { rel: '.env.example', kind: 'env', label: '环境变量样例' },
  { rel: '.env.sample', kind: 'env', label: '环境变量样例' },
  { rel: '.env.template', kind: 'env', label: '环境变量样例' },
  { rel: 'package.sh', kind: 'release', label: '发布包构建脚本' },
  { rel: 'package.bat', kind: 'release', label: '发布包构建脚本' },
  { rel: 'release-common.sh', kind: 'release', label: '发布脚本公共库' },
  { rel: 'upgrade.sh', kind: 'release', label: '升级入口脚本' },
  { rel: 'start.sh', kind: 'release', label: '启动脚本' },
  { rel: 'stop.sh', kind: 'release', label: '停止脚本' },
  { rel: 'backup.sh', kind: 'release', label: '备份脚本' },
  { rel: 'restore.sh', kind: 'release', label: '恢复脚本' },
  { rel: 'VERSION', kind: 'version', label: '版本文件' },
]

/** 部署契约里「脚本部署」必须存在的文件（缺失即不满足部署条件） */
const SCRIPT_CONTRACT_REQUIRED = [
  { rel: 'upgrade.sh', why: '脚本部署要求发布包根目录提供升级脚本（部署工具以 INSTALL_ROOT=<安装根> 调用它）' },
  { rel: 'start.sh', why: '回滚依赖 start.sh 拉起旧版本' },
]

/** 数据目录候选名（相对项目根的运行时数据，通常是升级时必须保留的东西） */
const DATA_DIR_RE = /^(data|datasource|data_source|output|outputs|storage|upload|uploads|files|runtime|db|database|sqlite|logs?|backups?|secrets?|static|media)$/i

/** 发布产物目录候选（脚本部署的 artifactDir） */
const ARTIFACT_DIR_CANDIDATES = ['dist', 'release', 'releases', 'output', 'target', 'build/dist']
const ARTIFACT_EXTS = ['.tar.gz', '.tgz', '.zip']

/** 拒绝路径中的链接（含 junction 和悬空链接），避免读写跟随链接越界。 */
function resolveProjectFile(root, rel) {
  const base = fs.realpathSync(root)
  const abs = path.resolve(base, rel)
  const relative = path.relative(base, abs)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('目标路径越出项目目录')
  }
  let current = base
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    try {
      const st = fs.lstatSync(current)
      if (st.isSymbolicLink()) throw new Error('部署文件路径不得经过符号链接或 junction')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }
  return abs
}

/** 发给模型前隐藏常见凭据字面量；保留纯环境变量引用。 */
function redactAiText(value) {
  const text = String(value || '').replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
    '[已隐藏私钥]',
  )
  let blockIndent = -1
  return text.split('\n').map((line) => {
    const indent = line.match(/^\s*/)[0].length
    if (blockIndent >= 0 && (indent > blockIndent || !line.trim())) return ''
    blockIndent = -1
    // 不把敏感变量的默认值当成安全引用，例如 ${PASSWORD:-真实密码}。
    const literal = line.replace(/\$\{[A-Za-z_][\w]*\}|\$[A-Za-z_][\w]*/g, '[变量引用]')
    const assignment = literal.match(/(?:[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)[\w.-]*["']?\s*[:=]\s*)(.*)/i)
    const credential = assignment && assignment[1].replace(/["'\s,}]/g, '') !== '[变量引用]'
    if (credential || /:\/\/[^\s/@]+:[^\s/@]+@|\b(?:Bearer|Basic)\s+\S+|(?:^|\s)(?:--password|--token|--secret|--api-key|--user|-u|-p)\s+\S+/i.test(literal)) {
      if (credential) blockIndent = indent
      return `${' '.repeat(indent)}# [已隐藏凭据内容]`
    }
    return line
  }).join('\n')
}

function safeAiValue(value) {
  if (typeof value === 'string') return redactAiText(value)
  if (Array.isArray(value)) return value.map(safeAiValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safeAiValue(v)]))
  return value
}

function readTextCapped(file, maxBytes = MAX_TEXT_BYTES) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return ''
    const fd = fs.openSync(file, 'r')
    try {
      const len = Math.min(st.size, maxBytes)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, 0)
      return buf.toString('utf8') + (st.size > len ? '\n…（内容已截断）' : '')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 目录规模（文件数 + 字节数）：带上限，避免在大目录上耗时过久 */
function dirStats(dir, limit = 4000) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    if (files >= limit) return
    for (const ent of listDirSafe(d)) {
      if (files >= limit) return
      if (ent.isSymbolicLink()) continue
      const abs = path.join(d, ent.name)
      if (ent.isDirectory()) {
        if (['node_modules', '.git', '__pycache__', '.venv', 'venv'].includes(ent.name)) continue
        walk(abs)
      } else if (ent.isFile()) {
        files += 1
        try { bytes += fs.statSync(abs).size } catch { /* 读不到大小则忽略 */ }
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

/** 解析 Compose 文本的关键信息（轻量行解析：services / image / ports / 绑定挂载 / secrets / 变量） */
function parseCompose(text) {
  const services = []
  const images = []
  const ports = []
  const bindMounts = []
  const secretFiles = []
  const requiredEnv = new Set()
  if (!text) return { services, images, ports, bindMounts, secretFiles, requiredEnv: [] }
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    const secM = line.match(/^([a-zA-Z_][\w-]*):\s*$/)
    if (secM) {
      section = secM[1]
      continue
    }
    // services 下的二级键即服务名
    if (section === 'services') {
      const svc = line.match(/^ {2}([a-zA-Z_][\w.-]*):\s*$/)
      if (svc) services.push(svc[1])
    }
    const img = line.match(/^\s+image:\s*["']?([^"'\s]+)/)
    if (img) images.push(img[1])
    // 端口映射：- "127.0.0.1:8080:80" / - 8080:80
    const port = line.match(/^\s+-\s*["']?((?:[^"'\s:]+:)?\d+:\d+)["']?/)
    if (port) ports.push(port[1])
    // 绑定挂载：- ./runtime/x:/app/x  /  - ${VAR:-./x}:/app/x
    const bind = line.match(/^\s+-\s*["']?(\.[^"':\s]+):(\/[^"'\s:]+)/)
    if (bind) bindMounts.push({ host: bind[1], container: bind[2] })
    const bindVar = line.match(/^\s+-\s*["']?\$\{[^}]*:-(\.[^}]*)\}:(\/[^"'\s:]+)/)
    if (bindVar) bindMounts.push({ host: bindVar[1], container: bindVar[2] })
    const secFile = line.match(/^\s+file:\s*["']?([^"'\s]+)/)
    if (secFile) secretFiles.push(secFile[1])
    for (const m of line.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g)) requiredEnv.add(m[1])
  }
  return {
    services: [...new Set(services)],
    images: [...new Set(images)],
    ports: [...new Set(ports)],
    bindMounts,
    secretFiles: [...new Set(secretFiles)],
    requiredEnv: [...requiredEnv],
  }
}

/** 读取 env 样例文件，只取键名（不取值的具体内容，避免把真实凭据送进 AI） */
function parseEnvKeys(text) {
  const keys = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    const value = m[2].trim()
    keys.push({ key: m[1], placeholder: !value || /chang|xxx|your|示例|替换/i.test(value) })
  }
  return keys
}

/**
 * 本地项目体检。返回结构化报告（不依赖 AI，也不读取任何真实凭据文件内容）。
 */
function scanLocal(project) {
  const root = String((project && project.localPath) || '').trim()
  const report = {
    root,
    exists: false,
    entryCount: 0,
    entries: [],
    stack: [],
    deployFiles: { present: [], missing: [] },
    compose: { files: [] },
    releaseScripts: {},
    version: { version: '', source: '' },
    envExamples: [],
    dataCandidates: [],
    sensitive: [],
    artifactDirs: [],
    risks: [],
    fileContents: [],
  }
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    report.risks.push(`本地项目目录不存在：${root || '（未配置）'}`)
    return report
  }
  report.exists = true
  const rootEntries = listDirSafe(root)
  report.entryCount = rootEntries.length
  report.entries = rootEntries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort().slice(0, 80)

  const scanStack = (dir, prefix, depth) => {
    for (const [file, kind, label] of STACK_MARKERS) {
      if (fs.existsSync(path.join(dir, file))) report.stack.push({ file: prefix + file, kind, label })
    }
    if (depth >= 2) return
    for (const e of listDirSafe(dir)) {
      if (!e.isDirectory() || e.name.startsWith('.') || /^(node_modules|target|build|dist|vendor|venv|release|releases|tests|design|docs)$/i.test(e.name)) continue
      scanStack(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1)
    }
  }
  scanStack(root, '', 0)

  for (const spec of DEPLOY_FILE_SPECS) {
    if (fs.existsSync(path.join(root, spec.rel))) report.deployFiles.present.push(spec)
  }
  // 发布契约必需文件缺失时给出提示（脚本形态）
  const hasReleaseScript = report.deployFiles.present.some((f) => f.kind === 'release' && f.rel === 'upgrade.sh')
  if (hasReleaseScript) {
    for (const req of SCRIPT_CONTRACT_REQUIRED) {
      if (!fs.existsSync(path.join(root, req.rel))) report.deployFiles.missing.push({ path: req.rel, why: req.why })
    }
  }

  // Compose 文件：配置指定的优先看，其余按常见命名收录
  const composeSeen = new Set()
  const configured = String((project && project.composeFile) || '').trim()
  const composeList = [...new Set([configured, ...COMPOSE_CANDIDATES].filter(Boolean))]
  for (const rel of composeList) {
    if (composeSeen.has(rel)) continue
    composeSeen.add(rel)
    let abs
    try { abs = resolveProjectFile(root, rel) } catch { report.risks.push(`跳过不安全的部署文件路径：${rel}`); continue }
    if (!fs.existsSync(abs)) continue
    const text = readTextCapped(abs)
    report.compose.files.push({ path: rel, ...parseCompose(text), bytes: text.length })
    report.fileContents.push({ path: rel, content: text })
  }

  // 发布相关脚本内容（供 AI 改写/生成时参考）
  for (const name of ['upgrade.sh', 'start.sh', 'stop.sh', 'package.sh', 'backup.sh', 'restore.sh', 'release-common.sh', 'Dockerfile', '.env.example']) {
    let abs
    try { abs = resolveProjectFile(root, name) } catch { report.risks.push(`跳过不安全的部署文件路径：${name}`); continue }
    if (!fs.existsSync(abs)) continue
    const text = readTextCapped(abs)
    if (name === '.env.example') {
      report.envExamples.push({ path: name, keys: parseEnvKeys(text) })
    } else if (!report.compose.files.some((c) => c.path === name)) {
      report.fileContents.push({ path: name, content: text })
    }
  }
  for (const f of report.deployFiles.present) {
    if (f.kind === 'release') report.releaseScripts[f.rel.replace(/\.(sh|bat)$/, '')] = f.rel
  }

  report.version = detectVersion(root) || { version: '', source: '' }

  // 敏感文件（只报路径，不读内容）
  for (const rel of ['.env', 'secrets', '.secrets', 'id_rsa', 'secrets.env']) {
    if (fs.existsSync(path.join(root, rel))) report.sensitive.push(rel)
  }
  for (const ent of rootEntries) {
    if (/\.(pem|key|p12|jks)$/i.test(ent.name)) report.sensitive.push(ent.name)
  }

  // 数据目录候选：项目根一级 + runtime/* 二级（含 Compose 绑定挂载的宿主目录）
  const mountedHosts = new Set()
  for (const c of report.compose.files) {
    for (const b of c.bindMounts) mountedHosts.add(path.posix.normalize(b.host.replace(/^\.\//, '')))
  }
  const candidates = []
  const consider = (rel) => {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) return
    let st
    try { st = fs.statSync(abs) } catch { return }
    if (!st.isDirectory()) return
    const stats = dirStats(abs)
    candidates.push({
      path: rel,
      files: stats.files,
      sizeBytes: stats.bytes,
      mounted: mountedHosts.has(rel) || [...mountedHosts].some((h) => h.startsWith(`${rel}/`)),
      kind: 'dir',
    })
  }
  for (const ent of rootEntries) {
    if (ent.isDirectory() && DATA_DIR_RE.test(ent.name)) consider(ent.name)
  }
  const runtime = path.join(root, 'runtime')
  if (fs.existsSync(runtime)) {
    for (const ent of listDirSafe(runtime)) {
      if (ent.isDirectory()) {
        consider(`runtime/${ent.name}`)
        for (const sub of listDirSafe(path.join(runtime, ent.name))) {
          if (sub.isDirectory() && DATA_DIR_RE.test(sub.name)) consider(`runtime/${ent.name}/${sub.name}`)
        }
      }
    }
  }
  report.dataCandidates = candidates
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 20)

  // 发布产物目录
  for (const dir of ARTIFACT_DIR_CANDIDATES) {
    const abs = path.join(root, dir)
    if (!fs.existsSync(abs)) continue
    let hits = []
    try {
      hits = fs.readdirSync(abs).filter((f) => ARTIFACT_EXTS.some((e) => f.toLowerCase().endsWith(e)))
    } catch { /* 不可读则忽略 */ }
    if (hits.length) report.artifactDirs.push({ path: dir, samples: hits.slice(-3) })
  }

  // 与当前配置不符的风险项（与 deploy-service 的发布前检查同口径，提前暴露）
  if (!report.version.version) report.risks.push('未识别到版本号（可改用手动版本）')
  if (report.compose.files.length && !report.deployFiles.present.some((f) => f.kind === 'compose')) {
    report.risks.push(`Compose 文件位于非标准路径：${report.compose.files[0].path}（部署配置需填写该路径）`)
  }
  if (!report.deployFiles.present.some((f) => f.kind === 'compose') && !report.deployFiles.present.some((f) => f.kind === 'release')) {
    report.risks.push('项目没有 Compose 编排，也没有发布脚本：需要先为其生成部署文件')
  }
  return report
}

/** 生成给 AI 的本地文件内容清单（总量受控） */
function pickFileContentsForAi(local) {
  const out = []
  let total = 0
  for (const f of local.fileContents || []) {
    if (total + f.content.length > AI_FILE_PAYLOAD_BYTES) {
      out.push({ path: f.path, content: '…（内容过长，已省略）' })
      continue
    }
    total += f.content.length
    out.push({ ...f, content: redactAiText(f.content) })
  }
  return out
}

function quoteArg(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`
}

/**
 * 服务器体检（SSH）：工具链、资源、部署目录现状、已有部署与容器、端口占用。
 * 任一步失败都返回 { ok:false, error }，不阻断本地结论。
 */
async function scanRemote(project, target) {
  if (!target || !target.server || !target.server.host) {
    return { ok: false, error: '当前环境未配置服务器地址' }
  }
  const home = String(target.remotePath || '').trim()
  const creds = projects.getCredentials(project.id, target.id) || { password: '', passphrase: '' }
  let conn
  try {
    conn = await ssh.connect({
      host: target.server.host,
      port: target.server.port,
      username: target.server.username,
      authType: target.server.authType,
      password: creds.password,
      keyPath: target.server.keyPath,
      passphrase: creds.passphrase,
    })
    const cmd = [
      'echo __SEC_OS__', 'uname -srm', 'id -un',
      'echo __SEC_TOOLS__',
      'docker --version 2>&1 || echo MISSING',
      'docker compose version 2>&1 || echo MISSING',
      'for c in unzip tar curl sha256sum git java pg_dump ss lsof nc; do printf "%s=%s\\n" "$c" "$(command -v $c >/dev/null 2>&1 && echo yes || echo no)"; done',
      'echo __SEC_RES__',
      'df -Ph "$HOME" 2>/dev/null | tail -1',
      'awk \'/MemTotal|MemAvailable/{printf "%s %s %s\\n", $1, $2, $3}\' /proc/meminfo 2>/dev/null',
      'echo __SEC_DIR__',
      home ? `if [ -d ${quoteArg(home)} ]; then echo DIR_EXISTS; ls -A ${quoteArg(home)} | head -60; else echo DIR_MISSING; fi` : 'echo DIR_UNSET',
      'echo __SEC_COMPOSE__',
      'docker compose ls -a --format "{{.Name}}|{{.Status}}|{{.ConfigFiles}}" 2>/dev/null | head -40',
      'echo __SEC_MANAGED__',
      home ? `cat ${quoteArg(ssh.remoteJoin(home, 'CURRENT'))} 2>/dev/null` : 'true',
      home ? `readlink ${quoteArg(ssh.remoteJoin(home, 'current'))} 2>/dev/null` : 'true',
      home ? `ls -1 ${quoteArg(ssh.remoteJoin(home, 'releases'))} 2>/dev/null | head -20` : 'true',
      'echo __SEC_DOCKER__',
      'docker ps -a --format "{{.Names}}|{{.Status}}|{{.Image}}" 2>/dev/null | head -120',
      'echo __SEC_VOLUMES__',
      'docker volume ls --format "{{.Name}}" 2>/dev/null | head -200',
      'echo __SEC_PORTS__',
      '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk \'NR>1{print $4}\' | head -120',
      'echo __SEC_END__',
    ].join('; ')
    const res = await ssh.exec(conn, cmd)
    return parseRemoteSections(res.stdout || '', home)
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  } finally {
    ssh.close(conn)
  }
}

/** 解析 scanRemote 的分段输出 */
function parseRemoteSections(stdout, home) {
  const sec = {}
  let cur = ''
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^__SEC_(\w+)__$/)
    if (m) { cur = m[1]; sec[cur] = []; continue }
    if (cur && line !== '') sec[cur].push(line)
  }
  const one = (k, i = 0) => (sec[k] && sec[k][i]) || ''
  const tools = {}
  for (const line of sec.TOOLS || []) {
    const m = line.match(/^(\w+)=(yes|no)$/)
    if (m) tools[m[1]] = m[2] === 'yes'
  }
  const dockerVersion = (sec.TOOLS || []).find((l) => /^Docker version/i.test(l)) || ''
  const composeVersion = (sec.TOOLS || []).find((l) => /^Docker Compose version/i.test(l)) || ''
  // docker / compose 版本行单独解析，工具清单里补上二者的可用状态，便于界面统一判断
  tools.docker = !!dockerVersion
  tools.compose = !!composeVersion
  const dirLine = one('DIR')
  const reports = { ok: true, os: one('OS'), user: (sec.OS || [])[1] || '', docker: dockerVersion, compose: composeVersion, tools }
  reports.disk = one('RES')
  reports.memory = (sec.RES || [])[1] || ''
  reports.path = home
  reports.pathExists = dirLine === 'DIR_EXISTS'
  reports.pathEntries = reports.pathExists ? (sec.DIR || []).slice(1, 41) : []
  reports.composeProjects = (sec.COMPOSE || []).map((l) => {
    const [name, status, configFiles] = l.split('|')
    return { name, status, configFiles }
  })
  reports.managed = {
    current: one('MANAGED'),
    currentLink: one('MANAGED', 1),
    releases: (sec.MANAGED || []).slice(2).filter(Boolean),
  }
  reports.containers = (sec.DOCKER || []).map((l) => {
    const [name, status, image] = l.split('|')
    return { name, status, image }
  })
  reports.volumes = (sec.VOLUMES || []).slice()
  reports.listenPorts = (sec.PORTS || []).slice()
  return reports
}

/** 名称归一化：用于把容器名/卷名/Compose 项目名与项目名做包含匹配 */
function slugify(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 旧版（非本工具）部署的典型文件，用来判断目录里躺着的是不是一个可运行的部署 */
const LEGACY_DEPLOY_MARKERS = [
  'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml',
  '.env', '.git', 'runtime', 'data', 'output', 'dataSource', 'secrets', 'Dockerfile',
]

/**
 * 已有部署识别（确定性，不依赖 AI）——首次接入部署前必须回答的问题：
 *   服务器上是不是已经部署过同一个服务？是手工部署（legacy）还是本工具部署过（managed）？
 * 证据：deploy 目录内容、受管指针（CURRENT/current/releases）、`docker compose ls` 项目、
 *       同名容器、同名数据卷、Compose 声明的宿主端口是否已被占用。
 * 结论 kind：managed（本工具部署过）/ legacy（有部署但非本工具）/ content（目录有内容但看不出是部署）
 *            / empty（目录存在但为空）/ none（目录不存在）；remote 体检失败时为 unknown。
 */
function detectExistingDeployment(project, target, local, remote) {
  const slug = slugify(project.name)
  if (!remote || !remote.ok) {
    return { checked: false, kind: 'unknown', slug, error: (remote && remote.error) || '未执行服务器体检', evidence: [], containers: [], volumes: [], portConflicts: [], adopt: false, requiredSteps: [], risks: [] }
  }
  const managed = remote.managed || {}
  const entries = remote.pathEntries || []
  const legacyMarkers = entries.filter((e) => LEGACY_DEPLOY_MARKERS.includes(e))
  const containers = (remote.containers || []).filter((c) => slug && slugify(c.name).includes(slug))
  const volumes = (remote.volumes || []).filter((v) => slug && slugify(v).includes(slug))
  const composeProjects = (remote.composeProjects || []).filter((p) => slug && slugify(p.name).includes(slug))
  // Compose 声明的宿主端口：与服务器已在监听的端口求交集（同服务已占用端口 = 已有部署在跑）
  const composePorts = []
  for (const c of local.compose.files) {
    for (const p of c.ports) {
      const hp = hostPortOf(p)
      if (hp && !composePorts.includes(hp)) composePorts.push(hp)
    }
  }
  const listen = (remote.listenPorts || []).map((x) => String(x).split(':').pop())
  const portConflicts = composePorts.filter((p) => listen.includes(p)).map((p) => ({ port: p, listen: listen.filter((x) => x === p).length }))
  const runningContainers = containers.filter((c) => /^Up\b/i.test(c.status || ''))

  const evidence = []
  if (managed.current || (managed.releases || []).length) evidence.push(`部署目录存在本工具的版本指针（CURRENT=${managed.current || '—'}，历史版本 ${(managed.releases || []).length} 个）`)
  if (composeProjects.length) evidence.push(`docker compose 项目：${composeProjects.map((p) => `${p.name}（${p.status}，配置 ${p.configFiles}）`).join('；')}`)
  if (containers.length) evidence.push(`同名容器 ${containers.length} 个：${containers.slice(0, 5).map((c) => `${c.name}[${c.status}]`).join('、')}`)
  if (volumes.length) evidence.push(`同名数据卷 ${volumes.length} 个：${volumes.slice(0, 6).join('、')}（Compose 项目名不变即可复用，改名等于丢数据）`)
  if (legacyMarkers.length) evidence.push(`部署目录内已有部署文件：${legacyMarkers.join('、')}`)
  if (portConflicts.length) evidence.push(`Compose 声明的端口已被占用：${portConflicts.map((p) => `:${p.port}`).join('、')}`)

  let kind = 'none'
  if (managed.current || (managed.releases || []).length) kind = 'managed'
  else if (composeProjects.length || runningContainers.length || (remote.pathExists && legacyMarkers.length)) kind = 'legacy'
  else if (remote.pathExists && entries.length) kind = 'content'
  else if (remote.pathExists) kind = 'empty'

  // 需要跨版本保留的数据：Compose 挂载的宿主目录 + 服务器上已存在的同名共享目录
  const sharedGuess = []
  for (const c of local.compose.files) {
    for (const b of c.bindMounts) {
      const hostRel = path.posix.normalize(String(b.host).replace(/^\.\//, ''))
      if (hostRel.startsWith('..') || path.posix.isAbsolute(hostRel)) continue
      sharedGuess.push({ localDir: hostRel, containerPath: b.container, sharedDir: `shared/${path.posix.basename(hostRel)}` })
    }
  }

  const requiredSteps = []
  const risks = []
  if (kind === 'legacy' || kind === 'content') {
    requiredSteps.push('首次接管前做一次完整备份：部署目录打包 + 数据库导出（PostgreSQL/ClickHouse）')
    requiredSteps.push('把可变数据（运行配置 .env、数据目录）迁移到 <安装根>/shared 下，发布版本目录只放不可变内容')
    requiredSteps.push('停止旧容器（docker compose down，保留具名卷）后清空部署目录里的旧文件，再执行首次发布')
    if (volumes.length) requiredSteps.push(`发布时 Compose 项目名必须保持为「${slug}」或原项目名，确保继续挂载已有数据卷 ${volumes.slice(0, 3).join('、')}`)
    if (runningContainers.length) requiredSteps.push('发布窗口内旧服务会短暂停机：确认可接受停机后再执行')
    risks.push('服务器上已有运行中的实例：首次接入是「接管」而非全新部署，必须按上面的步骤迁移，否则数据（卷/配置/上传文件）会丢')
    if (portConflicts.length) risks.push(`端口 ${portConflicts.map((p) => `:${p.port}`).join('、')} 已被占用的实例占用；旧实例未停止时新实例无法启动，发布脚本会失败并回滚`)
  }
  if (kind === 'managed') {
    requiredSteps.push('已有本工具的受管部署：直接发布新版本即可，工具会自动备份旧版本并保留 shared 目录')
    risks.push(`该目标已被本工具接管（当前版本 ${managed.current || '未知'}）：确认本次要发布到同一环境，避免误覆盖`)
  }
  if (kind === 'none') requiredSteps.push('服务器部署目录不存在：首次发布将自动创建目录结构，无需额外迁移')

  return {
    checked: true,
    kind,
    slug,
    evidence,
    dirExists: !!remote.pathExists,
    dirEntries: entries.slice(0, 20),
    legacyMarkers,
    composeProjects,
    containers: containers.slice(0, 10),
    runningContainers: runningContainers.length,
    volumes,
    composePorts,
    portConflicts,
    dataToPreserve: sharedGuess,
    adopt: kind === 'legacy' || kind === 'content' || kind === 'managed',
    requiredSteps,
    risks,
  }
}

/** 从 Compose 端口映射中取「宿主端口」（"127.0.0.1:8080:80" → 8080） */
function hostPortOf(mapping) {
  const parts = String(mapping).replace(/["'?]/g, '').split(':')
  if (parts.length >= 2) {
    const p = parts[parts.length - 2]
    return /^\d+$/.test(p) ? p : ''
  }
  return ''
}

/**
 * 启发式方案（AI 不可用时的保底结论，也作为 AI 输出的校验基线）。
 */
function buildHeuristicPlan(project, target, local, remote) {
  const hasCompose = local.compose.files.length > 0
  const hasDockerfile = local.deployFiles.present.some((f) => f.rel === 'Dockerfile')
  const hasRelease = local.deployFiles.present.some((f) => f.kind === 'release')
  const composeMain = local.compose.files[0] || null
  const bindMountCount = composeMain ? composeMain.bindMounts.length : 0
  const hasNamedVolumes = (() => {
    if (!composeMain) return false
    return /^\s{2}\w[\w-]*:\s*$/m.test(readNamedVolumesText(local, composeMain.path))
  })()

  // 判定部署形态：项目自带发布脚本（发布包 + upgrade.sh）优先按脚本部署；
  // 只有 Compose 时按 Docker 编排——但如果 Compose 依赖 MUST-HAVE 变量且把运行时数据挂在
  // 项目目录里（版本目录整体替换会丢数据），脚本部署更安全
  let deployMode = 'docker'
  const reasons = []
  if (hasRelease && local.releaseScripts.upgrade) {
    deployMode = 'script'
    reasons.push('项目自带发布包构建与升级脚本，按其自身发布约定部署')
  }
  if (!hasRelease && hasCompose && (bindMountCount > 0 || hasNamedVolumes)) {
    deployMode = 'docker'
    reasons.push('项目提供 Compose 编排，按 Docker 形态部署')
  }
  if (!hasCompose && !hasRelease) {
    deployMode = 'script'
    reasons.push('项目缺少 Compose 编排与发布脚本：需要生成部署文件后才可部署')
  }

  // 健康检查：取 Compose 第一个宿主端口，探测 127.0.0.1
  const port = composeMain ? (composeMain.ports.map(hostPortOf).find(Boolean) || '') : ''
  const health = port
    ? { enabled: true, url: `http://127.0.0.1:${port}/`, timeout: 180, interval: 5 }
    : { enabled: false, url: '', timeout: 90, interval: 3 }

  // 数据库：Compose 中 postgres/mysql 服务 + 容器名（由远端同名容器推断）
  let db = { enabled: false, type: 'postgres', container: '', name: '', user: '' }
  const dbImage = composeMain ? composeMain.images.find((i) => /postgres|mysql|mariadb/i.test(i)) : ''
  if (dbImage) {
    const type = /mysql|mariadb/i.test(dbImage) ? 'mysql' : 'postgres'
    const envGuess = guessDbFromEnv(project, local)
    // 容器名优先取「与本项目同名」的数据库容器：服务器上往往同时跑着多个 postgres，
    // 按镜像取第一个会挑错实例（如把 printer-pim-postgres 当成本项目的库）
    const slug = String(project.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const dbRe = new RegExp(type === 'postgres' ? 'postgres' : 'mysql|mariadb', 'i')
    const cands = (remote && remote.containers ? remote.containers : [])
      .filter((c) => dbRe.test(c.image || '') || dbRe.test(c.name || ''))
    const scored = cands.map((c) => {
      const name = String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      let score = 0
      if (slug && name.includes(slug)) score += 10
      if (/^U/.test(c.status || '')) score += 3
      if (/healthy/.test(c.status || '')) score += 2
      return { c, score }
    }).sort((a, b) => b.score - a.score)
    const best = scored.length ? scored[0].c : null
    db = {
      enabled: true,
      type,
      container: (best && best.name) || envGuess.container || '',
      name: envGuess.name || '',
      user: envGuess.user || '',
    }
  }

  // 数据同步：要区分两件常被混为一谈的事——
  //   ① 跨版本共享（share）：Compose 把运行时数据挂在项目目录下，版本目录整体替换会丢，
  //      必须迁到 <安装根>/shared 并让 Compose 指向它（属于部署文件/布局问题，不是"同步"）；
  //   ② 本地推送（upload）：本地目录里有服务器自己不会产生的数据（初始数据、种子文件），
  //      才需要用工具的数据同步在发布后推上去。
  // 只有 ② 才把 dataSync.needed 置真；① 通过 shared 目录与 compose 覆盖文件解决。
  const dataItems = []
  for (const b of (composeMain && composeMain.bindMounts) || []) {
    const hostRel = path.posix.normalize(String(b.host).replace(/^\.\//, ''))
    if (hostRel.startsWith('..') || path.posix.isAbsolute(hostRel)) continue
    const hit = local.dataCandidates.find((d) => d.path === hostRel) || { path: hostRel, files: 0, sizeBytes: 0 }
    const base = path.posix.basename(hostRel)
    dataItems.push({
      localDir: hostRel,
      remoteDir: `shared/${base}`,
      mountedTo: b.container,
      files: hit.files,
      sizeBytes: hit.sizeBytes,
      kind: 'share',
    })
  }
  for (const d of local.dataCandidates) {
    if (dataItems.some((x) => x.localDir === d.path)) continue
    if (!/^(data|datasource|output|uploads?|files|storage)$/i.test(path.posix.basename(d.path))) continue
    // 未被 Compose 挂载、但本地有文件的目录：可能是需要推给服务器的初始数据（由 AI 复核）
    dataItems.push({
      localDir: d.path,
      remoteDir: `shared/${path.posix.basename(d.path)}`,
      mountedTo: '',
      files: d.files,
      sizeBytes: d.sizeBytes,
      kind: d.files > 0 ? 'upload?' : 'share',
    })
  }
  const uploadItems = dataItems.filter((x) => x.kind === 'upload?')

  const missingFiles = []
  if (deployMode === 'docker' && !hasCompose) {
    missingFiles.push({ path: 'docker-compose.yml', why: 'Docker 形态部署需要 Compose 编排文件' })
  }
  if (deployMode === 'docker' && !hasDockerfile) {
    missingFiles.push({ path: 'Dockerfile', why: 'Compose 里 build 型服务需要 Dockerfile' })
  }
  if (deployMode === 'script') {
    for (const req of SCRIPT_CONTRACT_REQUIRED) {
      if (!fs.existsSync(path.join(local.root, req.rel))) missingFiles.push({ path: req.rel, why: req.why })
    }
    if (!(project.scriptMode && project.scriptMode.packageCommand) && !local.releaseScripts.package) {
      missingFiles.push({ path: 'package.sh', why: '脚本部署需要能产出「单一顶层目录」的发布包（tar.gz/zip），否则每次发布都要人工打包' })
    }
  }
  if (!local.envExamples.length && (composeMain && composeMain.requiredEnv.length)) {
    missingFiles.push({ path: '.env.example', why: 'Compose 依赖环境变量（如数据库密码），需要提供样例文件说明必填项' })
  }

  const prerequisites = []
  if (composeMain && composeMain.requiredEnv.length) {
    prerequisites.push({
      item: `运行配置 ${composeMain.requiredEnv.join(' / ')}`,
      why: 'Compose 启动时必须有这些变量，缺失会直接拒绝启动',
      how: '首次部署前在服务器共享目录准备 .env（可从 .env.example 复制并生成随机密码）',
    })
  }
  if (composeMain && composeMain.secretFiles.length) {
    prerequisites.push({
      item: `Docker secret 文件：${composeMain.secretFiles.join(' / ')}`,
      why: 'secret 文件是宿主机路径，缺失时 Compose 会报错',
      how: '首次部署前生成随机 Token 文件（如 openssl rand -hex 32）',
    })
  }

  const notes = []
  if (remote && remote.ok && !remote.pathExists && local.root) {
    notes.push(`服务器部署目录尚不存在（${remote.path || '未配置'}），首次部署将自动创建`)
  }
  if (remote && remote.ok && remote.pathExists && remote.pathEntries.length) {
    notes.push(`服务器部署目录已有内容（含 ${remote.pathEntries.slice(0, 5).join('、')} 等）：首次接管需确认数据迁移方式`)
  }

  // 部署文件待办清单（确定性）：缺文件 / 已有脚本与本工具契约冲突时给出可生成的行
  const fileRows = []
  const addRow = (rel, action, purpose) => {
    if (fileRows.some((r) => r.path === rel)) return
    fileRows.push({ path: rel, action, purpose, content: '', exists: fs.existsSync(path.join(local.root, rel)) })
  }
  if (deployMode === 'script') {
    const upName = local.releaseScripts.upgrade
    if (upName) {
      const upText = readTextCapped(path.join(local.root, upName))
      // 契约要求 upgrade.sh 从 INSTALL_ROOT 环境变量取安装根（部署工具以该变量传入且不传参数）：
      // 只认 --install-root 参数或带项目前缀的变量（如 SHOPMETRICS_INSTALL_ROOT）的脚本必须改写
      if (upText && !/\$\{?INSTALL_ROOT\b/.test(upText)) {
        addRow(upName, 'update', '升级脚本未从 INSTALL_ROOT 环境变量读取安装根（部署工具以该变量传入且不传参数），需改写以适配部署契约')
      }
    } else {
      addRow('upgrade.sh', 'create', '脚本部署契约要求的升级入口（以 INSTALL_ROOT 定位安装根并启动新版本）')
    }
    if (!local.releaseScripts.start) addRow('start.sh', 'create', '回滚依赖的启动脚本（升级失败时用它拉起旧版本）')
    if (!local.releaseScripts.stop) addRow('stop.sh', 'create', '停止脚本（发布与回滚都会调用）')
    if (!local.releaseScripts.package) addRow('package.sh', 'create', '构建发布包（单一顶层目录、文件名含版本号，供部署工具上传）')
  }
  if (deployMode === 'docker') {
    if (!hasCompose) addRow('docker-compose.yml', 'create', 'Docker 形态部署需要的 Compose 编排文件')
    if (!hasDockerfile) addRow('Dockerfile', 'create', 'Compose 中 build 型服务的镜像构建文件')
  }
  if (!local.envExamples.length && composeMain && composeMain.requiredEnv.length) {
    addRow('.env.example', 'create', `Compose 依赖 ${composeMain.requiredEnv.length} 个变量（如数据库密码/绑定地址），需样例文件说明必填项`)
  }

  // 已有部署识别（「服务器是否已经部署过同一个服务」）——首次部署是否具备条件的核心一项
  const existing = detectExistingDeployment(project, target, local, remote)

  const plan = {
    source: 'heuristic',
    checks: { root: local.root, localExists: local.exists, detectedVersion: local.version.version,
      serverConfigured: !!(target && target.server && target.server.host), remotePathConfigured: !!(target && target.remotePath),
      remoteOk: !!(remote && remote.ok), tools: (remote && remote.tools) || {} },
    summary: deployMode === 'script'
      ? '按项目自带发布脚本（发布包 + upgrade.sh）部署'
      : '按 Compose 编排部署',
    deployMode,
    deployModeReason: reasons.join('；') || '按项目已有文件推断',
    composeFile: deployMode === 'docker'
      ? ((composeMain && composeMain.path) || (project.composeFile || 'docker-compose.yml'))
      : (project.composeFile || 'docker-compose.yml'),
    scriptMode: {
      artifactDir: (local.artifactDirs[0] && local.artifactDirs[0].path) || (project.scriptMode && project.scriptMode.artifactDir) || 'release',
      upgradeScript: local.releaseScripts.upgrade || 'upgrade.sh',
      packageCommand: (project.scriptMode && project.scriptMode.packageCommand)
        || (local.releaseScripts.package ? `bash ${local.releaseScripts.package}` : ''),
      bootstrapJava: !!(project.scriptMode && project.scriptMode.bootstrapJava),
      bootstrapPgdump: local.stack.some((s) => s.kind === 'java') || !!(project.scriptMode && project.scriptMode.bootstrapPgdump),
      autoBumpVersion: true,
      autoReleaseNotes: true,
    },
    version: local.version.version
      ? { strategy: 'auto', manual: '' }
      : { strategy: 'manual', manual: (project.version && project.version.manual) || '' },
    remotePath: target.remotePath || '',
    health,
    db,
    dataSync: {
      needed: uploadItems.length > 0,
      mode: uploadItems.length > 0 ? 'upload' : 'share',
      reason: dataItems.length
        ? (uploadItems.length
          ? `Compose 把运行时数据挂在项目目录（${dataItems.filter((d) => d.kind === 'share').map((d) => d.localDir).join('、') || '无'}），需迁到 <安装根>/shared 跨版本共享；另有本地目录 ${uploadItems.map((d) => d.localDir).join('、')} 需要推送到服务器`
          : `Compose 把运行时数据挂在项目目录（${dataItems.map((d) => d.localDir).join('、')}），必须迁到 <安装根>/shared 并让 Compose 指向它（跨版本共享），不需要把本地数据推送到服务器`)
        : '未发现需要从本地同步到服务器的数据目录',
      sharedDirs: dataItems.filter((d) => d.kind === 'share').map((d) => d.localDir),
      items: dataItems,
      importMode: 'none',
      importCommand: '',
    },
    missingFiles,
    prerequisites,
    risks: [...local.risks, ...(remote && !remote.ok ? [`服务器体检未完成：${remote.error}`] : []), ...existing.risks],
    notes,
    existing,
    migrationPlan: existing.requiredSteps,
    blockers: [],
    readyToDeploy: false,
    fileRequests: fileRows,
    files: fileRows.map((r) => ({ ...r })),
  }
  refreshReadiness(plan)
  return plan
}

/** 基于本地证据和最终形态重算；AI 只能补充缺项，不能清除确定性检查。 */
function refreshReadiness(plan, extraMissing = []) {
  const checks = plan.checks
  if (!checks) return
  const missing = []
  const requireFile = (rel, why) => {
    try {
      if (fs.statSync(resolveProjectFile(checks.root, rel)).isFile()) return
    } catch { /* 不存在或不安全均视为未就绪 */ }
    missing.push({ path: rel, why })
  }
  if (plan.deployMode === 'script') {
    requireFile(plan.scriptMode.upgradeScript || 'upgrade.sh', '脚本部署需要升级入口')
    requireFile('start.sh', '回滚需要启动脚本')
    if (!plan.scriptMode.packageCommand) requireFile('package.sh', '需要发布包构建脚本或打包命令')
  } else {
    requireFile(plan.composeFile, 'Docker 部署需要 Compose 编排')
    // 仅 build 型服务需要 Dockerfile；镜像型编排不应被误报。
    try {
      const composePath = resolveProjectFile(checks.root, plan.composeFile)
      const compose = parseYaml(readTextCapped(composePath))
      for (const service of Object.values(compose?.services || {})) {
        const build = service && service.build
        if (!build || build.dockerfile_inline) continue
        const context = (typeof build === 'string' ? build : build.context) || '.'
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(context) || context.startsWith('git@')) continue
        const dockerfile = (typeof build === 'object' && build.dockerfile) || 'Dockerfile'
        requireFile(path.posix.join(path.posix.dirname(plan.composeFile), context, dockerfile), 'Compose 的 build 服务需要镜像构建文件')
      }
    } catch { missing.push({ path: plan.composeFile, why: 'Compose 内容不可解析或路径不安全' }) }
  }
  plan.missingFiles = [...new Map([...missing, ...extraMissing].map((m) => [m.path, m])).values()]
  const blockers = plan.missingFiles.map((m) => `缺少部署文件：${m.path}（${m.why}）`)
  if (!checks.localExists) blockers.push('本地项目目录不存在或不可读')
  const version = String(plan.version.strategy === 'manual' ? plan.version.manual : checks.detectedVersion || '').trim()
  if (!/^[\w][\w.+~-]*$/.test(version) || version.length > 64) blockers.push('未识别到有效版本号：请填写手动版本或补齐项目版本文件')
  if (!checks.serverConfigured) blockers.push('未配置服务器地址')
  if (!checks.remotePathConfigured) blockers.push('未配置远程部署目录')
  if (!checks.remoteOk) blockers.push('服务器体检未完成，尚不能确认部署条件')
  if (plan.deployMode === 'docker' && checks.remoteOk) {
    for (const tool of ['docker', 'compose', 'unzip', 'tar', 'sha256sum']) {
      if (checks.tools[tool] === false) blockers.push(`服务器缺少部署工具：${tool}`)
    }
  }
  if (plan.existing?.kind !== 'managed') {
    for (const p of plan.prerequisites || []) blockers.push(`缺少首次部署前置条件：${p.item}`)
  }
  if (plan.existing?.checked && ['legacy', 'content'].includes(plan.existing.kind)) blockers.push('服务器上已存在旧部署：需先完成接管步骤')
  plan.blockers = [...new Set(blockers)]
  plan.readyToDeploy = plan.blockers.length === 0
}

/** 从项目 .env.example / Compose 文本里猜数据库名与用户（仅用于启发式默认值） */
function guessDbFromEnv(project, local) {
  const text = [
    ...(local.fileContents || []).filter((f) => /(^|\/)\.env|compose/i.test(f.path)).map((f) => f.content),
  ].join('\n')
  const pick = (re) => { const m = text.match(re); return m ? String(m[1]).trim() : '' }
  return {
    name: pick(/POSTGRES_DB\s*[:=]\s*\$?\{?([\w-]+)/i) || pick(/MYSQL_DATABASE\s*[:=]\s*\$?\{?([\w-]+)/i) || (project && project.name ? String(project.name).toLowerCase().replace(/[^\w-]/g, '') : ''),
    user: pick(/POSTGRES_USER\s*[:=]\s*\$?\{?([\w-]+)/i) || pick(/MYSQL_USER\s*[:=]\s*\$?\{?([\w-]+)/i) || 'postgres',
  }
}

/** Compose 文本中是否存在具名卷段（用于启发式判断数据是否在卷里） */
function readNamedVolumesText(local, composePath) {
  const f = (local.fileContents || []).find((x) => x.path === composePath)
  if (!f) return ''
  const idx = f.content.search(/^volumes:\s*$/m)
  return idx < 0 ? '' : f.content.slice(idx)
}

/**
 * 部署契约文本（提示词与文件生成共用）：说清楚「谁负责什么」——
 * AI 生成/改写部署脚本时必须遵守，否则会出现两套版本指针、重复安装等冲突。
 */
const DEPLOY_CONTRACT = `本工具的服务器端部署契约（生成的文件必须与之兼容）：

【脚本部署 script —— 版本目录与指针由本工具负责，项目脚本不得重复管理】
1. 客户端把发布包（.tar.gz/.tgz/.zip，只含单一顶层目录，文件名含版本号）上传到 <安装根>/uploads/，
   解压为 <安装根>/releases/<顶层目录名>/ —— 这一步由本工具完成，项目脚本不要再复制/移动版本目录；
2. 本工具以「当前目录 = 该 release 目录」执行 bash ./upgrade.sh，只传环境变量 INSTALL_ROOT=<安装根>，不带任何参数；
3. 版本指针由本工具维护：<安装根>/CURRENT 文件内容 = release 目录名。项目脚本不得再创建/切换
   current、current.txt 等第二套指针，也不得把 release 复制到 releases/<VERSION> 造成重复安装；
4. 因此 upgrade.sh 的职责只有三件事：① 确保 <安装根>/shared 布局与运行配置就绪（缺配置时报错退出）；
   ② 启动当前 release（调用本目录的 start.sh 或 docker compose up）；③ 失败时以非零退出码返回，
   由本工具回滚（工具会用 <安装根>/releases/<旧目录名>/stop.sh 与 start.sh 拉回旧版本）；
5. 发布包内必须有 VERSION 与 start.sh；stop.sh 可选但推荐；
6. 目录约定：<安装根>/{releases,uploads,backups,shared,deployer}；跨版本保留的数据必须放 <安装根>/shared，
   绝不能放在 release 目录（该目录会被整体替换）。

【Docker 编排 docker】
1. 客户端把整个项目（按 .deployignore 过滤）打成 ZIP 上传解压到 <安装根>/releases/<版本>/；
2. 执行 docker compose -f <composeFile> build 与 up -d，健康检查通过后 <安装根>/current 软链指向该版本；
3. Compose 依赖的 .env 由 <安装根>/shared/.env 软链进版本目录。`

/** 生成 AI 提示词（含部署契约，保证产出的文件能被本工具直接使用） */
function buildPrompt({ project, target, local, remote, heuristic, compressed, omitFiles }) {
  // 已有部署识别结果（由启发式方案携带）：作为「是否已经部署过同一服务」的确定性证据
  const existing = (heuristic && heuristic.existing) || null
  const localDigest = {
    root: local.root,
    entries: local.entries,
    stack: local.stack,
    presentDeployFiles: local.deployFiles.present.map((f) => f.rel),
    version: local.version,
    envExamples: local.envExamples,
    dataCandidates: local.dataCandidates,
    artifactDirs: local.artifactDirs,
    sensitive: local.sensitive,
    risks: local.risks,
    compose: local.compose.files,
    // 压缩模式（推理模型输出被截断时的第二次尝试）：只保留正文摘要，不带既有文件全文
    fileContents: compressed ? [] : pickFileContentsForAi(local),
  }
  const safeTarget = {
    name: target.name,
    remotePath: target.remotePath,
    os: remote && remote.ok ? remote.os : '',
    docker: remote && remote.ok ? remote.docker : '',
    compose: remote && remote.ok ? remote.compose : '',
    tools: remote && remote.ok ? remote.tools : {},
    disk: remote && remote.ok ? remote.disk : '',
    pathExists: remote && remote.ok ? remote.pathExists : null,
    pathEntries: remote && remote.ok ? remote.pathEntries : [],
    managed: remote && remote.ok ? remote.managed : null,
    containers: remote && remote.ok ? (remote.containers || []).slice(0, 30) : [],
    volumes: remote && remote.ok ? (remote.volumes || []).slice(0, 40) : [],
    listenPorts: remote && remote.ok ? (remote.listenPorts || []).slice(0, 40) : [],
    error: remote && !remote.ok ? remote.error : '',
  }
  const contract = DEPLOY_CONTRACT
  const safeExisting = existing ? {
    checked: existing.checked,
    kind: existing.kind,
    evidence: existing.evidence,
    dirExists: existing.dirExists,
    dirEntries: existing.dirEntries,
    containers: existing.containers,
    runningContainers: existing.runningContainers,
    volumes: existing.volumes,
    composeProjects: existing.composeProjects,
    composePorts: existing.composePorts,
    portConflicts: existing.portConflicts,
    dataToPreserve: existing.dataToPreserve,
  } : null

  const requirement = `请完成「首次部署方案设计」，输出严格 JSON（不要 markdown 代码块、不要多余文字）：
{
  "summary": "一句话结论",
  "deployMode": "script 或 docker",
  "deployModeReason": "选择该形态的理由（结合项目文件与服务器现状）",
  "composeFile": "docker 形态使用的 compose 相对路径",
  "scriptMode": {"artifactDir":"发布包目录（相对项目根）","upgradeScript":"升级脚本名","packageCommand":"本地打包命令，无则空串","bootstrapJava":false,"bootstrapPgdump":false,"autoBumpVersion":true,"autoReleaseNotes":true},
  "version": {"strategy":"auto 或 manual","manual":"manual 时的版本号，否则空串"},
  "health": {"enabled":true,"url":"http://127.0.0.1:端口/路径","timeout":180,"interval":5},
  "db": {"enabled":false,"type":"postgres 或 mysql","container":"容器名","name":"库名","user":"用户名"},
  "existingDeployment": {"alreadyDeployed":true,"kind":"managed|legacy|none","summary":"服务器上是否已经部署过同一服务的判断与依据","mustPreserve":["必须原样保留的东西（数据卷名、共享目录、配置文件）"],"adoptPlan":["接管已有部署的步骤，按顺序"]},
  "dataSync": {"needed":true,"mode":"upload 或 share","reason":"是否需要同步数据、依据是什么；mode=share 表示只需跨版本共享（迁到 shared 并让 Compose 指向），mode=upload 表示本地有服务器不会自己产生的数据需要推送","items":[{"kind":"share 或 upload（每项必须明确用途）","localDir":"相对项目根","remoteDir":"相对安装根，如 shared/data","note":"为什么"}],"importMode":"none 或 command","importCommand":"如需要，给出一条在服务器上把数据导入应用的命令，用 {dataDir}/{user}/{secret} 占位"},
  "missingFiles": [{"path":"相对项目根","why":"为什么缺它就不能部署"}],
  "prerequisites": [{"item":"首次部署前置条件","why":"不做会怎样","how":"如何准备"}],
  "risks": ["部署风险与注意事项"],
  "fileRequests": [{"path":"相对项目根","action":"create 或 update","purpose":"这个文件要解决什么问题"}]${omitFiles ? '' : ',\n  "files": [{"path":"相对项目根","action":"create 或 update","purpose":"一句话","content":"完整文件内容（不要省略、不要用 … 代替；单个文件不超过 8000 字符，最多 3 个文件；写不下就只放到 fileRequests 里由后续单独生成）"}]'}
}

约束：
- 必须先回答「服务器上是否已经部署过同一个服务」：existingDeployment 的结论只能基于给出的证据（部署目录内容、docker compose 项目、同名容器、同名数据卷、端口占用），逐条对应；证据不足时如实写 kind=none 并说明依据；
- 若已有部署：adoptPlan 必须给出「备份 → 迁移可变数据到 shared → 停旧实例（保留具名卷）→ 清理目录 → 首次发布」的可执行顺序，mustPreserve 必须点名数据库卷名与共享目录；
- files 只允许部署相关文件：Dockerfile、.dockerignore、.deployignore、.env.example、docker-compose*.yml/yaml、compose*.yml/yaml、根目录或 deploy/、scripts/ 下的 *.sh、migrations/*.sh；
- 项目已有 deploy 脚本与本契约冲突时，用 action=update 输出改写后的完整文件（例如 upgrade.sh 不认识 INSTALL_ROOT 环境变量时必须改写）；
- 不要生成或修改业务代码、测试、文档；不要输出任何真实密码/密钥，需要占位时写 <生成随机密码>；
- dataSync 必须明确回答「这个项目是否需要把本地数据同步到服务器、需要同步哪些目录、依据是什么」；
  并区分两种情况：只需跨版本共享（数据由服务器自己产生，mode=share，needed=false）vs 本地有服务器不会产生的数据需要推送（mode=upload，needed=true）；
- 整体保持简洁：除 files[].content 外，每个字符串字段不超过 80 字，数组每项不超过 5 个元素；证据引用用短标签（如「同名容器 3 个」「卷 shopmetrics_postgres-data」），不要逐条复述原始数据；${omitFiles ? '\n- 本轮不要输出任何文件内容（files 字段必须省略），只给出 fileRequests 清单。' : ''}
${contract}`

  return [
    { role: 'system', content: '你是资深 Linux/Docker 部署工程师，负责为一个项目设计首次部署方案并产出可直接使用的部署文件。回答必须是单个 JSON 对象，字段缺失即视为失败。' },
    { role: 'user', content: `${requirement}\n\n【项目配置】\n${JSON.stringify(safeAiValue({ name: project.name, deployMode: project.deployMode, composeFile: project.composeFile, scriptMode: project.scriptMode, version: project.version }), null, 2)}\n\n【部署目标】\n${JSON.stringify(safeAiValue(safeTarget), null, 2)}\n\n【服务器已有部署识别（确定性证据，必须逐条回应）】\n${JSON.stringify(safeAiValue(safeExisting), null, 2)}\n\n【本地体检】\n${JSON.stringify(safeAiValue(localDigest), null, 2)}\n\n【确定性启发式结论（可纠正，但若推翻请在 deployModeReason/risks 说明理由）】\n${JSON.stringify(safeAiValue(heuristic), null, 2)}` },
  ]
}

/** 从 AI 回复里抠出 JSON 对象（容忍 ```json 围栏与前后废话） */
function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0) return null
  const candidate = end > start ? body.slice(start, end + 1) : body.slice(start)
  const direct = tryParse(candidate)
  if (direct) return direct
  // 输出被 token 上限截断时（JSON 中途断掉）尝试修复：回退到上一个分隔符并补齐括号。
  // 修复结果标记 __repaired：末尾元素可能是半截内容，调用方（mergePlan）据此丢弃不可信字段
  const repaired = repairTruncatedJson(candidate)
  if (repaired) {
    Object.defineProperty(repaired, '__repaired', { value: true, enumerable: false })
    return repaired
  }
  return null
}

function tryParse(s) {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * 截断 JSON 修复：从尾部逐步回退到最近的逗号/括号边界，补齐未闭合的字符串与括号后重试。
 * 只用于「AI 输出被长度上限截断」这一种可预期情况；仍失败时返回 null（调用方降级为确定性结论）。
 */
function repairTruncatedJson(s) {
  const closeTail = (str) => {
    let inStr = false
    let esc = false
    const stack = []
    for (const c of str) {
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') stack.push(c)
      else if (c === '}' || c === ']') stack.pop()
    }
    let tail = inStr ? '"' : ''
    for (let i = stack.length - 1; i >= 0; i--) tail += stack[i] === '{' ? '}' : ']'
    return tail
  }
  let cur = String(s)
  for (let i = 0; i < 400 && cur.length; i++) {
    const trimmed = cur.replace(/[\s,]+$/, '')
    const fixed = tryParse(trimmed + closeTail(trimmed))
    if (fixed) return fixed
    const cut = Math.max(cur.lastIndexOf(','), cur.lastIndexOf('{'), cur.lastIndexOf('['))
    if (cut <= 0) return null
    cur = cur.slice(0, cut)
  }
  return null
}

/** 生成文件的路径白名单（只允许部署相关文件，防止 AI 覆盖业务代码） */
function assertWritablePath(relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').trim()
  if (!rel || rel.startsWith('/') || rel.includes('..') || /^[a-zA-Z]:/.test(rel)) {
    return { ok: false, error: `非法路径: ${relPath}` }
  }
  const base = path.posix.basename(rel)
  const dir = path.posix.dirname(rel)
  const inRoot = dir === '.'
  const inDeployDir = ['deploy', 'scripts', 'ops', 'migrations'].includes(dir.split('/')[0])
  if (/^(Dockerfile|\.dockerignore|\.deployignore|\.env\.example|\.env\.sample|VERSION|Makefile)$/.test(base)) return { ok: true, rel }
  if (/^(docker-compose|compose)[\w.-]*\.ya?ml$/i.test(base)) return { ok: true, rel }
  if (/\.sh$/.test(base) && (inRoot || inDeployDir)) return { ok: true, rel }
  if (/\.(conf|service|timer)$/.test(base) && inDeployDir) return { ok: true, rel }
  return { ok: false, error: `不在允许生成的部署文件白名单内: ${rel}` }
}

/** 合并 AI 计划与启发式计划（AI 字段合法才覆盖，防止 AI 幻觉破坏配置） */
function mergePlan(heuristic, ai) {
  if (!ai || typeof ai !== 'object') return { ...heuristic }
  const out = JSON.parse(JSON.stringify(heuristic))
  out.source = 'ai'
  const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)
  if (ai.deployMode === 'script' || ai.deployMode === 'docker') out.deployMode = ai.deployMode
  out.summary = str(ai.summary, out.summary)
  out.deployModeReason = str(ai.deployModeReason, out.deployModeReason)
  out.composeFile = str(ai.composeFile, out.composeFile)
  if (ai.scriptMode && typeof ai.scriptMode === 'object') {
    out.scriptMode = {
      ...out.scriptMode,
      artifactDir: str(ai.scriptMode.artifactDir, out.scriptMode.artifactDir).replace(/^\/+|\/+$/g, ''),
      upgradeScript: path.posix.basename(str(ai.scriptMode.upgradeScript, out.scriptMode.upgradeScript)),
      packageCommand: typeof ai.scriptMode.packageCommand === 'string' ? ai.scriptMode.packageCommand.slice(0, 500) : out.scriptMode.packageCommand,
      bootstrapJava: ai.scriptMode.bootstrapJava === true,
      bootstrapPgdump: ai.scriptMode.bootstrapPgdump === true,
      autoBumpVersion: ai.scriptMode.autoBumpVersion !== false,
      autoReleaseNotes: ai.scriptMode.autoReleaseNotes !== false,
    }
    if (!/^[\w./-]+$/.test(out.scriptMode.artifactDir) || out.scriptMode.artifactDir.includes('..')) {
      out.scriptMode.artifactDir = heuristic.scriptMode.artifactDir
    }
  }
  if (ai.version && typeof ai.version === 'object') {
    const strategy = ai.version.strategy === 'manual' ? 'manual' : 'auto'
    out.version = { strategy, manual: strategy === 'manual' ? str(ai.version.manual, '') : '' }
  }
  if (ai.health && typeof ai.health === 'object') {
    out.health = {
      enabled: ai.health.enabled !== false && !!str(ai.health.url, ''),
      url: str(ai.health.url, out.health.url),
      timeout: Math.min(Math.max(num(ai.health.timeout, out.health.timeout), 10), 900),
      interval: Math.min(Math.max(num(ai.health.interval, out.health.interval), 1), 60),
    }
    if (!/^https?:\/\//.test(out.health.url)) out.health = { ...heuristic.health }
  }
  if (ai.db && typeof ai.db === 'object') {
    const safe = (v) => (/^[\w.-]*$/.test(String(v ?? '')) ? String(v ?? '').trim() : '')
    out.db = {
      enabled: ai.db.enabled === true,
      type: ai.db.type === 'mysql' ? 'mysql' : 'postgres',
      container: safe(ai.db.container),
      name: safe(ai.db.name),
      user: safe(ai.db.user),
    }
    if (out.db.enabled && (!out.db.container || !out.db.name)) {
      // 启用备份但信息不全时降级为不备份，避免发布时才失败
      out.db.enabled = false
      out.risks = [...(out.risks || []), 'AI 建议开启数据库备份但容器名/库名不完整，已自动关闭（请在部署设置中补全后再开启）']
    }
  }
  if (ai.dataSync && typeof ai.dataSync === 'object') {
    out.dataSync = {
      needed: ai.dataSync.needed === true,
      mode: ai.dataSync.needed === true ? 'upload' : 'share',
      reason: str(ai.dataSync.reason, out.dataSync.reason),
      sharedDirs: out.dataSync.sharedDirs,
      items: Array.isArray(ai.dataSync.items)
        ? ai.dataSync.items.slice(0, 10).map((it) => ({
          localDir: str(it && it.localDir, ''),
          remoteDir: str(it && it.remoteDir, ''),
          note: str(it && it.note, ''),
          kind: ['share', 'upload', 'upload?'].includes(it && it.kind) ? it.kind : 'unknown',
        })).filter((it) => it.localDir)
        : out.dataSync.items,
      importMode: ai.dataSync.importMode === 'command' ? 'command' : 'none',
      importCommand: typeof ai.dataSync.importCommand === 'string' ? ai.dataSync.importCommand.slice(0, 1000) : '',
    }
  }
  if (Array.isArray(ai.missingFiles)) {
    out.missingFiles = ai.missingFiles.slice(0, 30)
      .map((m) => ({ path: str(m && m.path, ''), why: str(m && m.why, '') }))
      .filter((m) => m.path)
  }
  if (Array.isArray(ai.prerequisites)) {
    out.prerequisites = [...out.prerequisites, ...ai.prerequisites.slice(0, 20)
      .map((p) => ({ item: str(p && p.item, ''), why: str(p && p.why, ''), how: str(p && p.how, '') }))
      .filter((p) => p.item)]
    out.prerequisites = [...new Map(out.prerequisites.map((p) => [p.item, p])).values()]
  }
  if (Array.isArray(ai.risks)) out.risks = ai.risks.map((r) => String(r)).filter(Boolean).slice(0, 20)
  // 已有部署结论：证据来自确定性体检，AI 只能补充判断、必须点名必须保留的东西与接管步骤
  if (ai.existingDeployment && typeof ai.existingDeployment === 'object' && out.existing) {
    const ex = ai.existingDeployment
    out.existing = {
      ...out.existing,
      aiSummary: str(ex.summary, ''),
      aiKind: ['managed', 'legacy', 'none'].includes(ex.kind) ? ex.kind : '',
      mustPreserve: Array.isArray(ex.mustPreserve) ? ex.mustPreserve.map((x) => String(x)).filter(Boolean).slice(0, 10) : [],
    }
    if (Array.isArray(ex.adoptPlan) && ex.adoptPlan.length) {
      out.migrationPlan = ex.adoptPlan.map((x) => String(x)).filter(Boolean).slice(0, 12)
    }
  }
  // 文件行：以启发式的「待办清单」为底，AI 的 files（含内容）与 fileRequests（仅清单）覆盖同路径项
  const rows = [...(out.files || [])]
  const upsert = (row) => {
    const i = rows.findIndex((r) => r.path === row.path)
    if (i < 0) rows.push(row)
    else rows[i] = { ...rows[i], ...row, content: row.content || rows[i].content || '' }
  }
  // 被截断修复过的 JSON：生成文件的内容可能只有半截，写入会产出坏脚本，一律丢弃
  const aiFiles = Array.isArray(ai.files) && !ai.__repaired ? ai.files.slice(0, 12) : []
  if (Array.isArray(ai.files) && ai.__repaired) {
    out.risks = [...(out.risks || []), 'AI 输出被长度上限截断，已丢弃其生成的部署文件内容（避免写入半截脚本）：请在文件清单中逐个生成后再写入']
  }
  for (const f of aiFiles) {
    const p = assertWritablePath(f && f.path)
    if (!p.ok) {
      out.risks = [...(out.risks || []), `AI 建议生成的文件被拒绝（${f && f.path}）：${p.error}`]
      continue
    }
    const content = (typeof (f && f.content) === 'string' ? f.content : '').replace(/\r\n/g, '\n')
    if (!content.trim()) continue // 空内容不作为「已生成」采纳，留待界面按需生成
    if (Buffer.byteLength(content, 'utf8') > MAX_GENERATED_BYTES) {
      out.risks = [...(out.risks || []), `AI 生成的文件过大已丢弃：${p.rel}`]
      continue
    }
    upsert({ path: p.rel, action: f.action === 'update' ? 'update' : 'create', purpose: str(f && f.purpose, ''), content })
  }
  for (const f of Array.isArray(ai.fileRequests) ? ai.fileRequests.slice(0, 8) : []) {
    const p = assertWritablePath(f && f.path)
    if (!p.ok) continue
    upsert({
      path: p.rel,
      action: (f && f.action) === 'update' ? 'update' : 'create',
      purpose: str(f && f.purpose, ''),
      content: '',
    })
  }
  out.files = rows
  refreshReadiness(out, Array.isArray(ai.missingFiles) ? out.missingFiles : [])
  return out
}

/**
 * 完整诊断：本地体检 → 服务器体检 → AI 方案（可选）。
 * @returns {Promise<{local, remote, plan, ai:{used, error, model}, heuristic}>}
 */
async function diagnose(projectId, targetId, opts = {}) {
  const project = projects.list().find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请先保存项目')
  const targets = Array.isArray(project.targets) ? project.targets : []
  const target = targets.find((t) => t.id === targetId) || targets[0] || null
  const local = scanLocal(project)
  let remote = { ok: false, error: '未执行服务器体检' }
  if (opts.skipRemote !== true) {
    try {
      remote = await scanRemote(project, target)
    } catch (err) {
      remote = { ok: false, error: (err && err.message) || String(err) }
    }
  }
  const heuristic = buildHeuristicPlan(project, target || {}, local, remote)
  // AI 增强：未配置 Key/模型或调用失败时静默降级为启发式结论
  const result = { local, remote, heuristic, plan: heuristic, ai: { used: false, error: '', model: '' } }
  if (opts.useAi === false) return result
  const cfg = store.load()
  const apiKey = store.getApiKey()
  const model = (opts.model || cfg.ai.model || '').trim()
  if (!apiKey || !model) {
    result.ai.error = !apiKey ? '未配置 AI Key（设置 → AI 模型）' : '未配置模型名称'
    return result
  }
  try {
    // 结构化输出：优先关闭推理（reasoning_effort=none）——推理型模型会把输出预算全用在
    // 思考上，导致正文为空（实测 24KB 提示词可产生 3 万字推理）；网关不支持该参数时回落。
    const ask = async (compressed, omitFiles, effort) => aiService.complete({
      baseUrl: cfg.ai.baseUrl,
      apiKey,
      model,
      temperature: 0.2,
      maxTokens: 16384,
      reasoningEffort: effort,
      messages: buildPrompt({ project, target: target || {}, local, remote, heuristic, compressed, omitFiles }),
    })
    const askWithFallback = async (compressed, omitFiles) => {
      try {
        return await ask(compressed, omitFiles, 'none')
      } catch (e) {
        if (e && (e.status === 400 || e.status === 422)) return ask(compressed, omitFiles, undefined)
        throw e
      }
    }
    let res = await askWithFallback(false, false)
    let truncated = res.finishReason === 'length'
    let parsed = String(res.text || '').trim() ? extractJson(res.text) : null
    // 正文为空（模型忽略 reasoning_effort）或输出被截断：压缩提示词（去掉既有文件全文），
    // 且改为「只要方案 + 文件清单」，文件内容留到用户点「生成」时按单个文件单独生成
    if (!parsed || truncated || parsed.__repaired) {
      const res2 = await askWithFallback(true, true)
      const parsed2 = String(res2.text || '').trim() ? extractJson(res2.text) : null
      if (parsed2 && !parsed2.__repaired) {
        parsed = parsed2
        truncated = false
      } else if (!parsed) {
        parsed = parsed2
        truncated = res2.finishReason === 'length'
      }
    }
    if (!parsed) {
      result.ai.error = truncated
        ? '模型输出被长度上限截断（推理内容占满预算）：建议在设置中改用非推理模型，或提高模型输出上限'
        : 'AI 未返回可解析的 JSON（可重试；已给出确定性结论）'
      return result
    }
    result.plan = mergePlan(heuristic, parsed)
    // 文件行标注本地是否已存在（界面据此提示「覆盖会先备份」）
    for (const f of result.plan.files || []) {
      f.exists = fs.existsSync(path.join(local.root, f.path))
      f.hasContent = !!(f.content && f.content.trim())
    }
    result.ai.used = true
    result.ai.model = res.model || model
    if (truncated || parsed.__repaired) {
      result.plan.filesPending = true
      result.plan.risks = [...(result.plan.risks || []), 'AI 输出达到长度上限：本轮只采纳部署方案，部署文件内容请在「④ 生成 / 改写部署文件」中逐个生成后再写入']
    }
  } catch (err) {
    result.ai.error = (err && err.message) || String(err)
  }
  return result
}

/**
 * 按需生成单个部署文件的完整内容（纯文本输出，不走 JSON——脚本里有大量引号与换行，
 * 放进 JSON 既浪费输出预算又容易被截断成坏脚本）。
 * @param {{path, action, purpose}} req
 * @returns {Promise<{ok, path, content, error}>}
 */
async function generateFileContent(projectId, targetId, req) {
  const project = projects.list().find((p) => p.id === projectId)
  if (!project) return { ok: false, error: '项目配置不存在' }
  const p = assertWritablePath(req && req.path)
  if (!p.ok) return { ok: false, error: p.error }
  const targets = Array.isArray(project.targets) ? project.targets : []
  const target = targets.find((t) => t.id === targetId) || targets[0] || {}
  const cfg = store.load()
  const apiKey = store.getApiKey()
  const model = cfg.ai.model
  if (!apiKey || !model) return { ok: false, error: '未配置 AI Key 或模型（设置 → AI 模型）' }

  const local = scanLocal(project)
  let current
  try { current = readTextCapped(resolveProjectFile(local.root, p.rel), 12 * 1024) } catch (e) { return { ok: false, error: e.message } }
  const refs = (local.fileContents || [])
    .filter((f) => f.path !== p.rel)
    .slice(0, 5)
    .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 2500)}`)
    .join('\n\n')
  const contract = DEPLOY_CONTRACT
  const messages = [
    { role: 'system', content: '你是资深 Linux/Docker 部署工程师。直接输出文件的完整内容（纯文本，第一行就是 shebang 或文件首行），不要任何解释、不要 markdown 代码围栏。' },
    { role: 'user', content: `请为项目「${project.name}」生成/改写部署文件：${p.rel}
目标动作：${req && req.action === 'update' ? '改写（保持原有能力，只做必要修改）' : '新建'}
要解决的问题：${req && req.purpose ? req.purpose : '使其满足部署契约'}

${contract}

【项目信息】
技术栈：${local.stack.map((s) => s.label).join('、') || '未知'}
版本来源：${local.version.version ? `${local.version.source}=${local.version.version}` : '未识别'}
Compose：${local.compose.files.map((c) => `${c.path}（服务 ${c.services.join('/')}，端口 ${c.ports.join('/')}）`).join('；') || '无'}
部署脚本：${Object.entries(local.releaseScripts || {}).map(([k, v]) => `${k}=${v}`).join('、') || '无'}
数据目录候选：${local.dataCandidates.map((d) => d.path).join('、') || '无'}
部署目标：${target.name || ''} ${target.remotePath || ''}（服务器 ${(target.server && target.server.host) || ''}）

【该文件当前内容】
${current || '（文件不存在，需要新建）'}

【其他部署文件参考（可能被截断）】
${refs || '（无）'}

要求：输出完整文件内容，不要省略、不要写“其余保持不变”、不要加代码围栏；注释用中文；脚本必须 set -Eeuo pipefail 并兼容 bash 4；不要写入任何真实密码。` },
  ]
  try {
    const ask = async (effort) => aiService.complete({
      baseUrl: cfg.ai.baseUrl, apiKey, model, temperature: 0.2, maxTokens: 16384, reasoningEffort: effort, messages: safeAiValue(messages),
    })
    let res
    try {
      res = await ask('none')
    } catch (e) {
      if (e && (e.status === 400 || e.status === 422)) res = await ask(undefined)
      else throw e
    }
    let content = String(res.text || '').trim()
    if (!content && res.reasoning) {
      res = await ask(undefined)
      content = String(res.text || '').trim()
    }
    // 容忍模型仍带 markdown 围栏
    const fence = content.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/)
    if (fence) content = fence[1]
    if (!content) {
      return { ok: false, error: res.finishReason === 'length' ? 'AI 输出被长度上限截断，未能生成完整文件（可改用输出上限更高的模型）' : 'AI 未返回内容' }
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_GENERATED_BYTES) {
      return { ok: false, error: `生成内容过大（${Buffer.byteLength(content, 'utf8')} 字节），已拒绝写入` }
    }
    return { ok: true, path: p.rel, content: content.replace(/\r\n/g, '\n') + '\n', truncated: res.finishReason === 'length', model: res.model || model }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
}

/**
 * 写入生成的部署文件：路径白名单 + 项目目录内 + 先备份已有文件。
 * @returns {{results: Array<{path, action, bytes, backup, error}>}}
 */
function writeFiles(projectId, files) {
  const project = projects.list().find((p) => p.id === projectId)
  if (!project) return { results: [], error: '项目配置不存在' }
  const root = path.resolve(project.localPath || '')
  if (!project.localPath || !fs.existsSync(root)) return { results: [], error: `本地项目目录不存在：${project.localPath}` }
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const results = []
  for (const f of Array.isArray(files) ? files : []) {
    const p = assertWritablePath(f && f.path)
    if (!p.ok) {
      results.push({ path: (f && f.path) || '', action: 'rejected', error: p.error })
      continue
    }
    let abs
    try { abs = resolveProjectFile(root, p.rel) } catch (e) {
      results.push({ path: p.rel, action: 'rejected', error: e.message })
      continue
    }
    const content = String((f && f.content) || '')
    if (!content.trim()) {
      results.push({ path: p.rel, action: 'rejected', error: '内容为空' })
      continue
    }
    try {
      let backup = ''
      let existed = false
      if (fs.existsSync(abs)) {
        existed = true
        backup = `${abs}.bak-${stamp}-${require('crypto').randomUUID()}`
        fs.copyFileSync(abs, backup, fs.constants.COPYFILE_EXCL)
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content.replace(/\r\n/g, '\n'), { encoding: 'utf8', mode: 0o755 })
      try { fs.chmodSync(abs, 0o755) } catch { /* Windows 上无意义 */ }
      results.push({
        path: p.rel,
        action: existed ? 'updated' : 'created',
        bytes: Buffer.byteLength(content, 'utf8'),
        backup: backup ? path.basename(backup) : '',
      })
    } catch (err) {
      results.push({ path: p.rel, action: 'failed', error: (err && err.message) || String(err) })
    }
  }
  return { results }
}

/**
 * 把方案写回部署配置（走 deploy-projects.save，凭据按 id 原样保留）。
 * plan 里只取部署形态相关字段；凭据、服务器地址等敏感配置不在方案内，不会被改动。
 */
function applyPlan(projectId, targetId, plan) {
  const all = projects.list()
  const project = all.find((p) => p.id === projectId)
  if (!project) return { ok: false, error: '项目配置不存在，请先保存项目' }
  if (!plan || typeof plan !== 'object') return { ok: false, error: '方案为空' }
  const payload = JSON.parse(JSON.stringify(project))
  if (plan.deployMode === 'script' || plan.deployMode === 'docker') payload.deployMode = plan.deployMode
  if (typeof plan.composeFile === 'string' && plan.composeFile.trim()) payload.composeFile = plan.composeFile.trim()
  if (plan.scriptMode && typeof plan.scriptMode === 'object') {
    payload.scriptMode = { ...payload.scriptMode, ...plan.scriptMode, packageCommand: String(plan.scriptMode.packageCommand || '') }
  }
  if (plan.version && typeof plan.version === 'object') {
    payload.version = plan.version.strategy === 'manual'
      ? { strategy: 'manual', manual: String(plan.version.manual || '').trim() }
      : { strategy: 'auto', manual: '' }
  }
  const target = targetId ? (payload.targets || []).find((t) => t.id === targetId) : payload.targets[0]
  if (!target) return { ok: false, error: '部署环境已不存在，请重新体检' }
  if (target) {
    if (plan.health && typeof plan.health === 'object') target.health = { ...target.health, ...plan.health }
    if (plan.db && typeof plan.db === 'object') target.db = { ...target.db, ...plan.db }
    if (plan.dataSync && typeof plan.dataSync === 'object') {
      const items = Array.isArray(plan.dataSync.items) ? plan.dataSync.items : []
      const uploads = items.filter((it) => it.kind === 'upload' || it.kind === 'upload?')
      if (plan.dataSync.needed && (uploads.length !== 1 || items.some((it) => !['share', 'upload', 'upload?'].includes(it.kind)))) {
        return { ok: false, error: '数据同步仅支持一个明确的上传目录；请重新生成带目录用途的方案，或在部署设置中手动选择，尚未套用任何配置' }
      }
      const first = uploads[0] || {}
      target.dataSync = {
        ...target.dataSync,
        enabled: plan.dataSync.needed === true && uploads.length === 1,
        localDir: first.localDir || target.dataSync.localDir,
        remoteDir: first.remoteDir || target.dataSync.remoteDir,
        importMode: plan.dataSync.importMode === 'command' ? 'command' : 'none',
        importCommand: plan.dataSync.importCommand || '',
      }
    }
  }
  const r = projects.save(payload)
  return { ok: !!(r && r.ok), id: (r && r.id) || projectId }
}

module.exports = {
  redactAiText,
  scanLocal, scanRemote, diagnose, writeFiles, applyPlan, generateFileContent,
  buildHeuristicPlan, mergePlan, assertWritablePath, parseCompose, parseEnvKeys, extractJson,
  buildPrompt, pickFileContentsForAi, detectExistingDeployment,
}
