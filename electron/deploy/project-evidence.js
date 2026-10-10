/**
 * 部署证据的统一入口：只读取受限项目文本，供助手和自动部署共同使用。
 * 项目资料只是证据；运行凭据、同步数据、链接与项目外路径不得进入模型。
 */
const fs = require('fs')
const path = require('path')
const { TextDecoder } = require('util')
const { parse, stringify } = require('yaml')

const MAX_FILE_BYTES = 12000
const MAX_TOTAL_BYTES = 60000
const MAX_DEPTH = 6
const MAX_DIRECTORIES = 600
const MAX_VISITED_ENTRIES = 12000
const MAX_DIRECTORY_ENTRIES = 1000
const MAX_INDEX_FILES = 1000
const MAX_INDEX_BYTES = 24000
const MAX_COMPOSE_FILES = 40
const COMPOSE_BYTES = 96000
const OMITTED = '\n…（内容已截断）'
const OMITTED_BYTES = Buffer.byteLength(OMITTED)
const SKIP_DIRECTORY = /^(?:node_modules|vendor|venv|env|__pycache__|target|dist|build|out|output|outputs|bin|obj|release|releases|coverage|site-packages|bower_components|Pods|DerivedData)$/i
const ENV_EXAMPLE = /^\.env\.(?:example|sample|template)$/i
const COMPOSE_NAME = /^(?:docker-compose|compose)(?:[.-][\w.-]+)?\.ya?ml$/i
const LOCK_NAME = /^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|pdm\.lock|go\.sum|Cargo\.lock|composer\.lock|Gemfile\.lock|packages\.lock\.json|gradle\.lockfile)$/i
const MARKERS = new Map([
  ['package.json', ['node', 'Node.js']],
  ['pom.xml', ['java', 'Java / Maven']],
  ['build.gradle', ['java', 'Java / Gradle']],
  ['build.gradle.kts', ['java', 'Java / Gradle']],
  ['settings.gradle', ['java', 'Java / Gradle']],
  ['settings.gradle.kts', ['java', 'Java / Gradle']],
  ['requirements.txt', ['python', 'Python']],
  ['pyproject.toml', ['python', 'Python']],
  ['Pipfile', ['python', 'Python']],
  ['setup.py', ['python', 'Python']],
  ['manage.py', ['python', 'Django']],
  ['go.mod', ['go', 'Go']],
  ['Cargo.toml', ['rust', 'Rust']],
  ['composer.json', ['php', 'PHP']],
  ['Gemfile', ['ruby', 'Ruby']],
  ['pubspec.yaml', ['flutter', 'Flutter / Dart']],
  ['mix.exs', ['elixir', 'Elixir']],
  ['CMakeLists.txt', ['cpp', 'C / C++']],
])
const BUILD_NAME = /^(?:Makefile|Procfile|requirements(?:[-_.][\w.-]+)?\.txt|setup\.cfg|tox\.ini|go\.work|Directory\.(?:Build|Packages)\.(?:props|targets)|global\.json|NuGet\.config|gradle\.properties|gradle-wrapper\.properties|\.nvmrc|\.node-version|\.python-version|\.tool-versions|tsconfig(?:\.[\w.-]+)?\.json|(?:vite|next|nuxt|webpack|svelte|astro)\.config\.[\w.]+)$/i
const ENTRY_NAME = /^(?:(?:main|app|server|index|worker|cli|wsgi|asgi|__main__|manage)\.(?:py|js|ts|mjs|cjs|jsx|tsx|go|rs|php|rb|c|cc|cpp|cxx|dart)|Program\.(?:cs|fs|vb)|Startup\.cs|config\.ru|Rakefile)$/i
const APP_CONFIG = /^(?:application(?:[-.][\w.-]+)?\.(?:ya?ml|properties)|appsettings(?:\.[\w.-]+)?\.json|(?:config|settings)\.(?:py|rb|php|toml|ini|ya?ml|json)|database\.yml|routes\.rb|nginx\.conf)$/i
const TEXT_EXTENSION = /\.(?:[cm]?js|jsx|tsx?|py|java|kt|kts|scala|go|rs|php|rb|cs|fs|vb|csproj|fsproj|vbproj|sln|slnx|props|targets|gradle|xml|json|toml|ya?ml|properties|ini|conf|config|md|txt|sh|bat|ps1|html?|css|scss|sql|sum|lock|exs?|cmake|c|cc|cpp|cxx|h|hh|hpp|hxx|dart)$/i

const key = (rel) => process.platform === 'win32' ? rel.toLowerCase() : rel

/** 不依赖调用方的路径过滤，Windows 盘符、ADS、UNC 与父目录段都直接拒绝。 */
function normalizeRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 1000 || /[\\:\0\r\n]/.test(rel) || rel.startsWith('/') || path.isAbsolute(rel)) throw new Error('文件路径必须是项目内的相对路径')
  const parts = rel.split('/')
  if (parts.some((part) => part === '..' || (process.platform === 'win32' && /[ .]$/.test(part)))) throw new Error('文件路径不得越出项目或使用特殊路径段')
  const normalized = path.posix.normalize(rel)
  if (!normalized || normalized === '.') throw new Error('文件路径不能为空')
  return normalized
}

function rootFor(project) {
  const root = String(project?.localPath || '').trim()
  if (!root) throw new Error('项目目录不存在，请先关联本地项目')
  const stat = fs.lstatSync(root)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('项目根目录必须是目录且不得为链接')
  return fs.realpathSync(root)
}

function safeFile(root, rel) {
  const normalized = normalizeRelative(rel)
  let current = root
  for (const part of normalized.split('/')) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('文件路径不得经过符号链接或 junction')
  }
  const canonical = fs.realpathSync(current)
  if (key(path.relative(root, canonical).replace(/\\/g, '/')) !== key(normalized)) throw new Error('文件路径不得经过链接或越出项目')
  if (!fs.lstatSync(current).isFile()) throw new Error('目标不是普通文件')
  return current
}

function isPrivate(rel) {
  const parts = rel.split('/')
  if (parts.some((part) => /\.bak-/i.test(part))) return true
  if (parts.some((part) => /^(?:secrets?|credentials?|\.git|\.ssh|\.aws|\.azure|\.gcloud)$/i.test(part))) return true
  const base = parts[parts.length - 1]
  if (/^\.env(?:\..*)?$/i.test(base) && !ENV_EXAMPLE.test(base)) return true
  return /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|sqlite3?|db)$/i.test(base) || /^(?:id_(?:rsa|ed25519|dsa|ecdsa)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.[\w.-]+)?|secrets?(?:[.-][\w.-]+)?|.*[-_.](?:credentials|secrets?)\.[\w.-]+)$/i.test(base)
}

function isToolPath(rel) {
  const dirs = rel.split('/').slice(0, -1)
  return dirs.some((part) => SKIP_DIRECTORY.test(part) || (part.startsWith('.') && !/^(?:\.onedeploy|\.deploy)$/.test(part)))
}

function readableName(rel) {
  const base = path.posix.basename(rel)
  return TEXT_EXTENSION.test(base) || MARKERS.has(base) || BUILD_NAME.test(base) || ENTRY_NAME.test(base) || LOCK_NAME.test(base) || /^(?:Dockerfile(?:\.[\w.-]+)?|Containerfile(?:\.[\w.-]+)?|README(?:\.[\w.-]+)?|Gemfile|Pipfile|Makefile|Procfile|Rakefile|VERSION|\.dockerignore|\.deployignore|\.env\.(?:example|sample|template))$/i.test(base)
}

function excluded(rel, exclude) {
  if (typeof exclude !== 'function') return false
  // 目录级排除也作用于所有子文件；过滤器异常时不读取该路径。
  const parts = rel.split('/')
  try {
    for (let i = 1; i <= parts.length; i++) if (exclude(parts.slice(0, i).join('/'))) return true
    return false
  } catch { return true }
}

function allowPath(rel, exclude) {
  return !isPrivate(rel) && !isToolPath(rel) && !excluded(rel, exclude)
}

function utf8Prefix(text, size) {
  const data = Buffer.from(String(text), 'utf8')
  return data.length <= size ? String(text) : new TextDecoder('utf-8').decode(data.subarray(0, size), { stream: true })
}

function cappedText(text, limit, alreadyTruncated = false) {
  const truncated = alreadyTruncated || Buffer.byteLength(text, 'utf8') > limit
  if (!truncated) return { content: text, truncated: false }
  if (limit <= OMITTED_BYTES) return { content: utf8Prefix(OMITTED, limit), truncated: true }
  return { content: utf8Prefix(text, limit - OMITTED_BYTES) + OMITTED, truncated: true }
}

function readText(root, rel, limit) {
  const file = safeFile(root, rel)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error('目标不是普通文件')
    const buffer = Buffer.alloc(Math.min(stat.size, limit))
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    const data = buffer.subarray(0, bytes)
    if (data.includes(0) || [...data].filter((b) => b < 32 && b !== 9 && b !== 10 && b !== 13).length > Math.max(2, bytes * 0.01)) throw new Error('文件是二进制，不能作为部署证据')
    const truncated = stat.size > bytes
    let content
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: truncated }) } catch { throw new Error('文件不是有效 UTF-8 文本') }
    return { content, truncated }
  } finally { fs.closeSync(fd) }
}

/** 即使未注入现有脱敏器，也隐藏常见凭据；样例环境变量还会额外清除字面值。 */
function redactDefault(value) {
  const text = String(value || '').replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[已隐藏私钥]')
  let hiddenIndent = -1
  return text.split('\n').map((line) => {
    const indent = line.match(/^\s*/)[0].length
    if (hiddenIndent >= 0 && (indent > hiddenIndent || !line.trim())) return ''
    hiddenIndent = -1
    const literal = line.replace(/\$\{[A-Za-z_][\w]*\}|\$[A-Za-z_][\w]*/g, '[变量引用]')
    const assignment = literal.match(/(?:[\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|encryption[_-]?key|signing[_-]?key|service[_-]?key|authorization|credential|connection[_-]?string|dsn)[\w.-]*["']?\s*[:=]\s*)(.*)/i)
    if ((assignment && assignment[1].replace(/["'\s,}]/g, '') !== '[变量引用]') || /:\/\/[^\s/@]+:[^\s/@]+@|\b(?:Bearer|Basic)\s+\S+|(?:^|\s)(?:--password|--token|--secret|--api-key|--user|-u|-p)\s+\S+/i.test(literal)) {
      if (assignment) hiddenIndent = indent
      return `${' '.repeat(indent)}# [已隐藏凭据内容]`
    }
    return line
  }).join('\n')
}

function redactContent(text, rel, redact) {
  let content = redactDefault(typeof redact === 'function' ? redact(text) : text)
  if (ENV_EXAMPLE.test(path.posix.basename(rel))) {
    content = content.split('\n').map((line) => {
      const assignment = line.match(/^(\s*(?:export\s+)?[A-Za-z_][\w]*\s*=\s*)(.*)$/)
      if (!assignment) return line
      const value = assignment[2].trim()
      if (!value || /^(?:\$\{[A-Za-z_][\w]*\}|\$[A-Za-z_][\w]*)$/.test(value)) return line
      return assignment[1] + '[已隐藏示例值]'
    }).join('\n')
  }
  return content
}

function stackMarker(rel) {
  const base = path.posix.basename(rel)
  const marker = MARKERS.get(base) || (/\.(?:csproj|fsproj|vbproj)$/i.test(base) ? ['dotnet', '.NET'] : null)
  return marker ? { file: rel, kind: marker[0], label: marker[1] } : null
}

function priority(rel) {
  const base = path.posix.basename(rel)
  if (stackMarker(rel)) return 0
  if (COMPOSE_NAME.test(base)) return 1
  if (/^README(?:\.[\w.-]+)?$/i.test(base)) return 2
  if (BUILD_NAME.test(base) || /^(?:Dockerfile|Containerfile)(?:\.[\w.-]+)?$/i.test(base)) return 3
  if (APP_CONFIG.test(base) || ENV_EXAMPLE.test(base)) return 4
  if (ENTRY_NAME.test(base) || /(?:Application|Main)\.(?:java|kt)$/i.test(base)) return 5
  if (/^(?:package|upgrade|start|stop|backup|restore|release-common)\.(?:sh|bat|ps1)$|^(?:\.dockerignore|\.deployignore|VERSION)$/i.test(base)) return 6
  return 20
}

/** 目录读取、遍历总量与模型索引均有上限，跳过链接而不是跟随。 */
function inventory(root, exclude) {
  const files = [], entries = [], queue = [{ rel: '', depth: 0 }]
  let visited = 0, directories = 0, truncated = false
  while (queue.length) {
    if (directories >= MAX_DIRECTORIES || visited >= MAX_VISITED_ENTRIES) { truncated = true; break }
    const item = queue.shift()
    directories++
    let directory
    try { directory = fs.opendirSync(path.join(root, item.rel)) } catch { continue }
    const batch = []
    try {
      let ent
      while ((ent = directory.readSync())) {
        if (batch.length >= MAX_DIRECTORY_ENTRIES || visited >= MAX_VISITED_ENTRIES) { truncated = true; break }
        visited++
        batch.push(ent)
      }
    } finally { directory.closeSync() }
    batch.sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of batch) {
      const rel = item.rel ? `${item.rel}/${ent.name}` : ent.name
      let normalized
      try { normalized = normalizeRelative(rel) } catch { continue }
      if (ent.isSymbolicLink() || !allowPath(normalized, exclude)) continue
      if (ent.isDirectory()) {
        if (SKIP_DIRECTORY.test(ent.name) || (ent.name.startsWith('.') && !/^(?:\.onedeploy|\.deploy)$/.test(ent.name))) continue
        if (!item.rel && entries.length < 80) entries.push(`${ent.name}/`)
        if (item.depth < MAX_DEPTH) queue.push({ rel: normalized, depth: item.depth + 1 })
        else truncated = true
      } else if (ent.isFile()) {
        if (!item.rel && entries.length < 80) entries.push(ent.name)
        if (readableName(normalized)) files.push(normalized)
      }
    }
  }
  return { files, entries, truncated }
}

/** Compose 的相对声明以文件目录为基准；允许项目内 ../，不展开本机环境变量。 */
function declarationPath(value, baseDir) {
  if (typeof value !== 'string' || !value || /[\\\0\r\n]/.test(value) || value.startsWith('/')) return null
  const defaults = value.replace(/\$\{[A-Za-z_][\w]*(?::-|-)([^}]*)\}/g, (_match, fallback) => fallback)
  if (/\$/.test(defaults)) return { unresolved: true }
  if (defaults.includes(':') || defaults.startsWith('/')) return null
  const joined = path.posix.normalize(path.posix.join(baseDir, defaults))
  try { return { rel: normalizeRelative(joined) } } catch { return null }
}

function composeContext(root, project, indexed, local, exclude) {
  const declared = new Set(), docs = new Map(), queue = [], seen = new Set()
  let uncertain = false, truncated = false
  const addCompose = (rel) => {
    try {
      const normalized = normalizeRelative(rel)
      if (!allowPath(normalized, exclude) || seen.has(key(normalized))) return
      seen.add(key(normalized)); queue.push(normalized)
    } catch { /* 不使用项目外或敏感目录中的编排 */ }
  }
  indexed.filter((rel) => COMPOSE_NAME.test(path.posix.basename(rel))).forEach(addCompose)
  if (project?.composeFile) addCompose(project.composeFile)
  for (const file of local?.compose?.files || []) if (file?.path) addCompose(file.path)
  const addRuntime = (value, dir) => {
    const resolved = declarationPath(value, dir)
    if (resolved?.unresolved) uncertain = true
    if (resolved?.rel) declared.add(key(resolved.rel))
  }
  const addIncluded = (value, dir) => {
    const resolved = declarationPath(value, dir)
    if (resolved?.unresolved) uncertain = true
    if (resolved?.rel) addCompose(resolved.rel)
  }
  while (queue.length) {
    if (docs.size >= MAX_COMPOSE_FILES) { uncertain = true; truncated = true; break }
    const rel = queue.shift(), dir = path.posix.dirname(rel)
    let doc
    try {
      const text = readText(root, rel, COMPOSE_BYTES)
      if (text.truncated) { uncertain = true; truncated = true; continue }
      doc = parse(text.content, { maxAliasCount: 20, uniqueKeys: true })
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue
    } catch (err) {
      // 不存在的候选文件无需阻止其余证据；存在但不能可靠解析的编排按安全侧处理。
      if (err.code !== 'ENOENT') uncertain = true
      continue
    }
    docs.set(key(rel), { rel, doc })
    for (const svc of Object.values(doc.services || {})) {
      if (!svc || typeof svc !== 'object') continue
      for (const env of [].concat(svc.env_file || [])) addRuntime(typeof env === 'string' ? env : env?.path, dir)
      if (svc.extends && typeof svc.extends === 'object') addIncluded(svc.extends.file, dir)
    }
    for (const section of [doc.secrets, doc.configs]) {
      for (const config of Object.values(section || {})) if (config && typeof config === 'object') addRuntime(config.file, dir)
    }
    for (const included of [].concat(doc.include || [])) {
      for (const value of [].concat(typeof included === 'string' ? included : included?.path || [])) addIncluded(value, dir)
      if (included && typeof included === 'object') for (const env of [].concat(included.env_file || [])) addRuntime(typeof env === 'string' ? env : env?.path, dir)
    }
  }
  return { declared, docs, uncertain, truncated }
}

function sanitizedCompose(doc) {
  // Compose 内嵌的运行配置也可能包含任意名称的凭据，不把其正文发送给模型。
  const copy = structuredClone(doc)
  for (const section of [copy.secrets, copy.configs]) for (const config of Object.values(section || {})) {
    if (config && typeof config === 'object' && Object.hasOwn(config, 'content')) config.content = '[已隐藏运行配置内容]'
  }
  return stringify(copy)
}

function contextFor(project, { local, exclude } = {}) {
  const root = rootFor(project)
  const indexed = inventory(root, exclude)
  const compose = composeContext(root, project, indexed.files, local, exclude)
  const allFiles = [...new Set([...indexed.files, ...[...compose.docs.values()].map((entry) => entry.rel)])]
    .filter((rel) => !compose.declared.has(key(rel)))
  return { root, indexed, compose, allFiles }
}

function readOne(context, rel, { redact, exclude, limit }) {
  const normalized = normalizeRelative(rel)
  if (!allowPath(normalized, exclude) || !readableName(normalized) || context.compose.declared.has(key(normalized))) throw new Error('文件属于运行凭据、同步数据或不可发送的部署证据')
  const composeDoc = context.compose.docs.get(key(normalized))
  if (context.compose.uncertain && !composeDoc) throw new Error('Compose 运行配置声明无法可靠解析，已保护项目文件内容')
  // 已解析的编排仍重新检查路径，防止索引后换成链接。
  let text
  if (composeDoc) { safeFile(context.root, normalized); text = { content: sanitizedCompose(composeDoc.doc), truncated: false } }
  else text = readText(context.root, normalized, MAX_FILE_BYTES)
  return { path: normalized, ...cappedText(redactContent(text.content, normalized, redact), limit, text.truncated) }
}

function collectEvidence(project, { local, redact, exclude } = {}) {
  const context = contextFor(project, { local, exclude })
  const { indexed, compose } = context
  const sorted = context.allFiles.sort((a, b) => priority(a) - priority(b) || a.split('/').length - b.split('/').length || a.localeCompare(b))
  const stack = [], seenStack = new Set(), files = [], lockFiles = []
  for (const rel of sorted) {
    const marker = stackMarker(rel)
    if (marker && !seenStack.has(key(rel))) { stack.push(marker); seenStack.add(key(rel)) }
    if (LOCK_NAME.test(path.posix.basename(rel))) lockFiles.push(rel)
  }
  // 兼容既有扫描器识别的其他技术栈，但只保留经过同一安全边界的真实文件。
  for (const marker of local?.stack || []) {
    try {
      const rel = normalizeRelative(marker.file)
      if (!seenStack.has(key(rel)) && allowPath(rel, exclude) && !compose.declared.has(key(rel))) {
        safeFile(context.root, rel); stack.push({ ...marker, file: rel }); seenStack.add(key(rel))
      }
    } catch { /* 旧体检不能绕过共享证据边界 */ }
  }
  let remaining = MAX_TOTAL_BYTES, truncated = indexed.truncated || compose.truncated || compose.uncertain
  const candidates = sorted.filter((rel) => priority(rel) < 20 || compose.docs.has(key(rel)))
  for (const rel of candidates) {
    if (remaining <= OMITTED_BYTES) { truncated = true; break }
    try {
      const result = readOne(context, rel, { redact, exclude, limit: Math.min(MAX_FILE_BYTES, remaining) })
      remaining -= Buffer.byteLength(result.content, 'utf8')
      truncated ||= result.truncated
      files.push({ path: result.path, content: result.content })
    } catch { /* 私有、二进制、不完整或无法读取的文件不作为初始证据 */ }
  }
  const availableFiles = []
  const indexCandidates = sorted.filter((rel) => !compose.uncertain || compose.docs.has(key(rel)))
  let indexBytes = 0
  for (const rel of indexCandidates) {
    const bytes = Buffer.byteLength(rel) + 4
    if (availableFiles.length >= MAX_INDEX_FILES || indexBytes + bytes > MAX_INDEX_BYTES) break
    availableFiles.push(rel); indexBytes += bytes
  }
  return { stack, entries: indexed.entries.filter((entry) => !compose.declared.has(key(entry.replace(/\/$/, '')))), files, lockFiles,
    availableFiles, truncated: truncated || indexCandidates.length > availableFiles.length, runtimeEnvFiles: [...compose.declared].sort() }
}

function readEvidence(project, paths, { local, redact, exclude, maxTotal = MAX_TOTAL_BYTES } = {}) {
  const requests = Array.isArray(paths) ? paths.slice(0, 32) : []
  let context
  try { context = contextFor(project, { local, exclude }) } catch { return requests.map((rel) => ({ path: rel, error: '项目目录不存在或不是安全的目录' })) }
  let remaining = Number.isFinite(maxTotal) ? Math.max(0, Math.min(MAX_TOTAL_BYTES, Math.floor(maxTotal))) : MAX_TOTAL_BYTES
  return requests.map((rel) => {
    try {
      if (remaining <= 0) throw new Error('部署证据内容已达到总量上限')
      const result = readOne(context, rel, { redact, exclude, limit: Math.min(MAX_FILE_BYTES, remaining) })
      remaining -= Buffer.byteLength(result.content, 'utf8')
      return { path: result.path, content: result.content }
    } catch (err) {
      const message = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code) ? '文件不存在或不可读取' : err.message
      return { path: rel, error: message }
    }
  })
}

module.exports = { collectEvidence, readEvidence }
