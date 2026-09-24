/**
 * 版本号自动识别 —— 按方案 §5.2 的优先级从项目目录读取版本号：
 *   VERSION → 项目类型标准版本文件 → CHANGELOG → 手动指定（由调用方决定）
 * 支持：VERSION / package.json / pom.xml / build.gradle(.kts) / pubspec.yaml / *.csproj
 *       / CHANGELOG.md（Keep a Changelog）；根目录均无时探测一级子目录（前后端分离项目）。
 * 纯 Node 实现，不依赖 Electron，可独立单测。
 */
const fs = require('fs')
const path = require('path')

const VERSION_RE = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/

function readFirstLine(p) {
  const text = fs.readFileSync(p, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t) return t
  }
  return ''
}

/** package.json：取顶层 version 字段（忽略 workspaces 子包） */
function fromPackageJson(dir) {
  const p = path.join(dir, 'package.json')
  if (!fs.existsSync(p)) return ''
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
    return typeof v === 'string' ? v.trim() : ''
  } catch {
    return ''
  }
}

/** pom.xml：取 <project> 直属的 <version>（跳过 dependencies 内的版本） */
function fromPom(dir) {
  const p = path.join(dir, 'pom.xml')
  if (!fs.existsSync(p)) return ''
  try {
    const xml = fs.readFileSync(p, 'utf8')
    // 去掉 parent 块后取第一个 <version>，即项目自身版本
    const body = xml.replace(/<parent>[\s\S]*?<\/parent>/, '')
    const m = body.match(/<version>([^<]+)<\/version>/)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

/** build.gradle(.kts)：version 'x.y.z' / version = "x.y.z" */
function fromGradle(dir) {
  for (const name of ['build.gradle', 'build.gradle.kts']) {
    const v = fromGradleFile(path.join(dir, name))
    if (v) return v
  }
  return ''
}

/** pubspec.yaml（Flutter）：version: 1.2.3(+build) */
function fromPubspec(dir) {
  return fromPubspecFile(path.join(dir, 'pubspec.yaml'))
}

/** *.csproj（.NET）：<Version> 优先，其次 <VersionPrefix> / <AssemblyVersion> */
function fromCsproj(dir) {
  let candidates = []
  try {
    candidates = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csproj'))
  } catch {
    return ''
  }
  for (const name of candidates) {
    try {
      const xml = fs.readFileSync(path.join(dir, name), 'utf8')
      for (const tag of ['Version', 'VersionPrefix', 'AssemblyVersion']) {
        const m = xml.match(new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`, 'i'))
        if (m) return m[1].trim()
      }
    } catch { /* 尝试下一个 csproj */ }
  }
  return ''
}

/** CHANGELOG.md / CHANGELOG（Keep a Changelog）：取最新非 Unreleased 的 [x.y.z] 版本段 */
function fromChangelog(dir) {
  for (const name of ['CHANGELOG.md', 'CHANGELOG']) {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) continue
    try {
      const text = fs.readFileSync(p, 'utf8')
      const re = /^##\s*\[([^\]]+)\]/gm
      let m
      while ((m = re.exec(text))) {
        const v = m[1].trim()
        if (v && !/^unreleased$/i.test(v) && VERSION_RE.test(v)) return v
      }
    } catch { /* 尝试下一个文件名 */ }
  }
  return ''
}

/** 子目录探测时跳过的依赖/产物目录 */
const SUBDIR_SKIP = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'output', 'target',
  'vendor', 'venv', '.venv', '__pycache__', '.idea', '.vscode', 'release', 'releases',
  'coverage', 'tmp',
])

/** 一级子目录中的标准版本文件（前后端分离项目），source 带子目录前缀便于界面定位 */
function fromSubdirs(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SUBDIR_SKIP.has(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return null
  }
  for (const sub of names) {
    const subDir = path.join(dir, sub)
    const attempts = [
      { v: fromPackageJson(subDir), s: `${sub}/package.json` },
      { v: fromPom(subDir), s: `${sub}/pom.xml` },
      { v: fromGradle(subDir), s: `${sub}/build.gradle` },
      { v: fromPubspec(subDir), s: `${sub}/pubspec.yaml` },
      { v: fromCsproj(subDir), s: `${sub}/*.csproj` },
    ]
    for (const a of attempts) {
      if (a.v && VERSION_RE.test(a.v)) return a
    }
  }
  return null
}

/**
 * 检测项目版本号。
 * @returns {{ version: string, source: string }} source 标明来源，便于界面展示
 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 各版本文件的单处版本声明改写器：rewrite 收到未转义的旧版本值，
 * 定位「被 detect 解析为版本」的那一处值并替换；无匹配时返回原文（调用方比较后决定是否写回）。
 */
const FILE_REWRITERS = [
  {
    file: 'VERSION',
    detect: (dir) => { const p = path.join(dir, 'VERSION'); return fs.existsSync(p) ? readFirstLine(p) : '' },
    rewrite: (text, oldV, nv) => text.replace(oldV, nv),
  },
  {
    file: 'package.json',
    detect: fromPackageJson,
    rewrite: (text, oldV, nv) => text.replace(new RegExp(`("version"\\s*:\\s*")${escapeRe(oldV)}(")`), `$1${nv}$2`),
  },
  {
    file: 'pom.xml',
    detect: fromPom,
    // 只替换 parent 块之后的第一个直属 <version>（与 fromPom 的定位一致）
    rewrite: (text, oldV, nv) => {
      const o = escapeRe(oldV)
      const pm = text.match(/<parent>[\s\S]*?<\/parent>/)
      const start = pm ? pm.index + pm[0].length : 0
      const out = text.slice(start).replace(new RegExp(`(<version>\\s*)${o}(\\s*</version>)`), `$1${nv}$2`)
      return out === text.slice(start) ? text : text.slice(0, start) + out
    },
  },
  {
    file: 'build.gradle',
    detect: (dir) => fromGradleFile(path.join(dir, 'build.gradle')),
    rewrite: rewriteGradleVersion,
  },
  {
    file: 'build.gradle.kts',
    detect: (dir) => fromGradleFile(path.join(dir, 'build.gradle.kts')),
    rewrite: rewriteGradleVersion,
  },
  {
    file: 'pubspec.yaml',
    detect: (dir) => fromPubspecFile(path.join(dir, 'pubspec.yaml')),
    rewrite: (text, oldV, nv) => text.replace(new RegExp(`(^version:\\s*['"]?)${escapeRe(oldV)}(['"]?\\s*$)`, 'm'), `$1${nv}$2`),
  },
]

/** build.gradle(.kts)：version 'x.y.z' / version = "x.y.z"（与 fromGradle 同一定位） */
function rewriteGradleVersion(text, oldV, nv) {
  return text.replace(new RegExp(`(^([\\t ]*)version\\s*=?\\s*['"])${escapeRe(oldV)}(['"])`, 'm'), `$1${nv}$3`)
}

function fromGradleFile(p) {
  if (!fs.existsSync(p)) return ''
  const m = fs.readFileSync(p, 'utf8').match(/^\s*version\s*=?\s*['"]([^'"]+)['"]/m)
  return m ? m[1].trim() : ''
}

function fromPubspecFile(p) {
  if (!fs.existsSync(p)) return ''
  const m = fs.readFileSync(p, 'utf8').match(/^version:\s*(['"]?)([^'"\s]+)\1\s*$/m)
  return m ? m[2].trim() : ''
}

/** csproj 版本标签（与 fromCsproj 的候选顺序一致），返回改写后文本或原文 */
function rewriteCsprojVersion(text, oldV, nv) {
  const o = escapeRe(oldV)
  for (const tag of ['Version', 'VersionPrefix', 'AssemblyVersion']) {
    const re = new RegExp(`(<${tag}>\\s*)${o}(\\s*</${tag}>)`, 'i')
    if (re.test(text)) return text.replace(re, `$1${nv}$2`)
  }
  return text
}

/**
 * 把项目内版本声明同步到新版本：根目录与一级子目录（跳过依赖/产物目录）中，
 * 解析值恰好等于 oldVersion 的版本文件改写为 newVersion（如根 VERSION 与 server/pom.xml 联动）。
 * 只动版本声明处，parent / 依赖等其他版本号不受影响；返回改动的文件相对路径列表。
 */
function bumpVersionFiles(projectDir, oldVersion, newVersion) {
  const changed = []
  if (!projectDir || !oldVersion || !newVersion || !VERSION_RE.test(newVersion) || oldVersion === newVersion) {
    return changed
  }

  const bumpInDir = (dir, prefix) => {
    for (const spec of FILE_REWRITERS) {
      const p = path.join(dir, spec.file)
      let text
      try {
        if (!fs.existsSync(p)) continue
        if (spec.detect(dir) !== oldVersion) continue
        text = fs.readFileSync(p, 'utf8')
      } catch { continue }
      const out = spec.rewrite(text, oldVersion, newVersion)
      if (out !== text) {
        try {
          fs.writeFileSync(p, out, 'utf8')
          changed.push(prefix + spec.file)
        } catch { /* 只读/被占用则跳过该文件 */ }
      }
    }
    // *.csproj 可能多个，逐个尝试（值等于旧版本的标签才被替换）
    let names = []
    try {
      names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csproj'))
    } catch { return }
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        const text = fs.readFileSync(p, 'utf8')
        const out = rewriteCsprojVersion(text, oldVersion, newVersion)
        if (out !== text) {
          fs.writeFileSync(p, out, 'utf8')
          changed.push(prefix + name)
        }
      } catch { /* 尝试下一个 */ }
    }
  }

  bumpInDir(projectDir, '')
  // 一级子目录：前后端分离 / jar 在子模块的项目（Vantage 形态 = 根 VERSION + server/pom.xml）
  try {
    const subs = fs.readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SUBDIR_SKIP.has(e.name))
      .map((e) => e.name)
      .sort()
    for (const sub of subs) bumpInDir(path.join(projectDir, sub), `${sub}/`)
  } catch { /* 项目根不可读时只处理根目录 */ }
  return changed
}

/**
 * 发布成功后把源项目版本写回发布版本：手动输入的发布版本只改过构建副本，
 * 源项目版本文件不跟上，则每次发布都显示旧版本起步（如 1.0.5 → 1.0.9）。
 * 与 bumpVersionFiles 同一定位规则（解析值等于当前版本才替换），失败零改动、幂等。
 * 返回 { version, changed }：version 为写回前检测到的版本（空表示无可识别版本），
 * changed 为改动的文件相对路径列表。
 */
function syncBackVersion(projectDir, releasedVersion) {
  const cur = detectVersion(projectDir)
  if (!cur.version || !releasedVersion || cur.version === releasedVersion) {
    return { version: cur.version, changed: [] }
  }
  return { version: cur.version, changed: bumpVersionFiles(projectDir, cur.version, releasedVersion) }
}

function detectVersion(projectDir) {
  const dir = projectDir
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { version: '', source: '' }
  }

  const versionFile = path.join(dir, 'VERSION')
  if (fs.existsSync(versionFile)) {
    const v = readFirstLine(versionFile)
    if (v && VERSION_RE.test(v)) return { version: v, source: 'VERSION' }
  }

  const attempts = [
    { v: fromPackageJson(dir), s: 'package.json' },
    { v: fromPom(dir), s: 'pom.xml' },
    { v: fromGradle(dir), s: 'build.gradle' },
    { v: fromPubspec(dir), s: 'pubspec.yaml' },
    { v: fromCsproj(dir), s: '*.csproj' },
    { v: fromChangelog(dir), s: 'CHANGELOG.md' },
  ]
  for (const a of attempts) {
    if (a.v && VERSION_RE.test(a.v)) return { version: a.v, source: a.s }
  }
  // 根目录与 CHANGELOG 均无 → 前后端分离等项目，探测一级子目录
  const sub = fromSubdirs(dir)
  if (sub) return { version: sub.v, source: sub.s }
  return { version: '', source: '' }
}

module.exports = { detectVersion, bumpVersionFiles, syncBackVersion }
