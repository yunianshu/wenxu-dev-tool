/** 部署文件集的只读静态校验；虚拟生成文件覆盖磁盘内容，不构建、不部署、不访问网络。 */
const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')
const { parseDocument } = require('yaml')

const MAX_GENERATED_BYTES = 400 * 1024
const MAX_READ_BYTES = 2 * 1024 * 1024
const VERSION_RE = /^[\w][\w.+~-]{0,63}$/
const COMPOSE_RE = /^(?:docker-compose|compose)[\w.-]*\.ya?ml$/i
const DOCKERFILE_RE = /^Dockerfile(?:[._-][\w.-]+)?$/i
const GENERATED_ENV_NAMES = new Set(['DB_PASSWORD', 'POSTGRES_PASSWORD', 'MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'APP_ENCRYPTION_KEY', 'SESSION_SECRET', 'JWT_SECRET', 'WORKER_SERVICE_TOKEN'])
const isDynamic = (value) => /\$|\{\{/.test(value)
const isRemote = (value) => /^(?:[a-z][a-z\d+.-]*:\/\/|git@)/i.test(value)
const keyOf = (value) => process.platform === 'win32' ? value.toLowerCase() : value

function normalizeRelative(value, allowRoot = false) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n:]/.test(value)) throw new Error('部署路径无效')
  const rel = value.trim().replace(/\\/g, '/')
  if (rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('部署路径越出项目目录')
  const normalized = path.posix.normalize(rel).replace(/\/$/, '') || '.'
  if (normalized === '.' && !allowRoot) throw new Error('部署文件不能使用项目根目录')
  if (normalized.split('/').some((part) => /[. ]$/.test(part) && part !== '.')) throw new Error('部署路径含不明确的尾随点或空格')
  if (process.platform === 'win32' && normalized.split('/').some((part) => /[<>"|?*]/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('部署路径含 Windows 非法文件名')
  return normalized
}

function defaultWritable(rel) {
  const base = path.posix.basename(rel)
  const dir = path.posix.dirname(rel)
  if (rel.split('/').some((part) => ['.git', '.ssh', 'node_modules', '.venv'].includes(part.toLowerCase()))) return false
  if (DOCKERFILE_RE.test(base) || COMPOSE_RE.test(base) || /^(?:\.dockerignore|\.deployignore|\.env\.(?:example|sample|template)|VERSION|Makefile)$/.test(base)) return true
  const inDeploy = ['deploy', 'scripts', 'ops', 'migrations'].includes(dir.split('/')[0])
  return (/\.sh$/i.test(base) && (dir === '.' || inDeploy)) || (/\.(?:conf|service|timer)$/i.test(base) && inDeploy)
}

function safeResolve(root, rel) {
  const abs = path.resolve(root, rel)
  const inside = path.relative(root, abs)
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('部署路径越出项目目录')
  let current = root
  for (const part of inside.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('部署路径不得经过符号链接或 junction')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return abs
}

function placeholder(value) {
  return /^(?:change[-_ ]?me|replace(?:[-_ ].*)?|example|dummy|sample|placeholder|password|secret|token|your(?:[-_ ].*)?|x{3,}|\*{3,}|<[^>]+>|请填写.*|待配置.*)$/i.test(value)
}

function credentialName(value) {
  return /(?:^|[_-])(?:password|passwd|pwd|secret|token|credentials?|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key|encryption[_-]?key|signing[_-]?key|service[_-]?key)(?:[_-](?:base|value|hex|base64))?$/i.test(value)
    || /(?:Password|Passwd|Pwd|Secret|Token|Credentials?|ApiKey|AccessKey|PrivateKey|EncryptionKey|SigningKey|ServiceKey)$/.test(value)
}

function credentialReference(value, sample) {
  let invalidDefault = false
  let references = 0
  const rest = value.replace(/\$(?:\{([A-Za-z_]\w*)(?:(:?[-+?])([^}]*))?\}|([A-Za-z_]\w*))/g, (all, name, operator, fallback) => {
    references++
    if (operator && /[-+]/.test(operator) && fallback?.trim() && !(sample && placeholder(fallback.trim()))) invalidDefault = true
    return ''
  })
  return references > 0 && !invalidDefault && !rest.trim()
}

function hasLiteralCredential(content, sample) {
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(content)) return true
  for (const line of content.split('\n')) {
    if (/^\s*(?:#|\/\/)/.test(line)) continue
    const matches = [...line.matchAll(/\b([A-Za-z_][\w.-]*)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|(?:\$\{[^}\n]*\}|[^\s])+)?/g)]
    const env = line.match(/^\s*(?:ENV|ARG)\s+([A-Za-z_][\w.-]*)\s+([^\n]*)/i)
    if (env) { env.index = line.indexOf(env[1]); matches.push(env) }
    for (const match of matches) {
      if (!credentialName(match[1])) continue
      if (line.slice(Math.max(0, match.index - 2), match.index) === '${' || /(?:_FILE|_PATH)$/i.test(match[1])) continue
      let value = String(match[2] || '').trim().replace(/\s+#.*$/, '').trim()
      const quoted = value.match(/^["']([^"']*)["']/)
      if (quoted) value = quoted[1]
      if (!value || credentialReference(value, sample) || /^(?:null|~|\[\]|\{\})$/.test(value)) continue
      if (sample && placeholder(value)) continue
      return true
    }
    for (const match of line.matchAll(/\$\{([A-Za-z_]\w*)(:?[-+])([^}]+)\}/g)) {
      if (credentialName(match[1]) && match[3].trim() && !(sample && placeholder(match[3].trim()))) return true
    }
    for (const match of line.matchAll(/[a-z][a-z\d+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/ig)) {
      if (!credentialReference(match[1], sample) && !(sample && placeholder(match[1]))) return true
    }
    const auth = line.match(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+((?:\$\{[^}\n]*\}|[^\s"'])+)/i)
    if (auth && !credentialReference(auth[1], sample) && !(sample && placeholder(auth[1]))) return true
  }
  return false
}

function bashCandidates() {
  const candidates = []
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)) {
      candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'), path.join(base, 'Git', 'usr', 'bin', 'bash.exe'))
    }
  }
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'bash.exe' : 'bash')
    // System32 的 bash.exe 是 WSL 启动器，不能当作 Git Bash 语法检查器。
    if (process.platform !== 'win32' || !/[\\/]windows[\\/]system32[\\/]/i.test(candidate)) candidates.push(candidate)
  }
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate))
}

function dockerLines(content) {
  const escape = /^\s*#\s*escape\s*=\s*`/im.test(content) ? '`' : '\\'
  const lines = []
  let current = ''
  let heredoc = null
  for (const raw of content.split('\n')) {
    if (heredoc) { if (raw.trim() === heredoc) heredoc = null; continue }
    if (!current && /^\s*#/.test(raw)) continue
    const trimmed = raw.trimEnd()
    if (trimmed.endsWith(escape)) { current += trimmed.slice(0, -1) + ' '; continue }
    const line = (current + raw).trim()
    current = ''
    lines.push(line)
    const marker = line.match(/<<-?["']?(\w+)["']?/)
    if (marker) heredoc = marker[1]
  }
  if (current) lines.push(current)
  return lines
}

/** options 的两个回调分别兼容 resolveProjectFile(root, rel) 与 assertWritablePath(rel)。 */
function validateDeploymentFiles(project, plan, files, { resolveFile, assertWritable } = {}) {
  const errors = []
  const warnings = []
  const fail = (message) => { if (!errors.includes(message)) errors.push(message) }
  const warn = (message) => { if (!warnings.includes(message)) warnings.push(message) }
  let root
  try {
    if (!project?.localPath) throw new Error('未关联项目')
    root = fs.realpathSync(project.localPath)
    if (!fs.statSync(root).isDirectory()) throw new Error('项目不是目录')
  } catch { return { ok: false, errors: ['本地项目目录不存在或不可读取'], warnings } }
  const overlay = new Map()
  const virtualDirs = new Set(['.'])
  const checkedScripts = new Set()
  let bash
  let bashChecked = false
  const resolve = (value, allowRoot = false) => {
    const rel = normalizeRelative(value, allowRoot)
    const abs = safeResolve(root, rel)
    if (resolveFile && rel !== '.') {
      const provided = resolveFile(root, rel)
      if (typeof provided !== 'string' || path.resolve(provided) !== abs) throw new Error('部署路径解析结果不一致')
    }
    return { rel, abs }
  }
  const locate = (value, label, allowRoot = false) => {
    try { return resolve(value, allowRoot) } catch { fail(`${label}路径不安全，必须位于项目内且不能经过链接`); return null }
  }
  const fileExists = (entry) => {
    if (!entry) return false
    if (overlay.has(keyOf(entry.rel))) return true
    try { return fs.statSync(entry.abs).isFile() } catch { return false }
  }
  const directoryExists = (entry) => {
    if (!entry) return false
    if (virtualDirs.has(keyOf(entry.rel))) return true
    try { return fs.statSync(entry.abs).isDirectory() } catch { return false }
  }
  const read = (entry, label) => {
    if (!entry) return null
    if (overlay.has(keyOf(entry.rel))) return overlay.get(keyOf(entry.rel)).content
    try {
      const stat = fs.statSync(entry.abs)
      if (!stat.isFile()) { fail(`${label}不是文件：${entry.rel}`); return null }
      if (stat.size > MAX_READ_BYTES) { fail(`${label}过大，无法完整静态校验：${entry.rel}`); return null }
      return fs.readFileSync(entry.abs, 'utf8').replace(/\r\n/g, '\n')
    } catch { fail(`${label}不存在或不可读取：${entry.rel}`); return null }
  }
  const checkShell = (rel, content) => {
    if (checkedScripts.has(keyOf(rel))) return
    checkedScripts.add(keyOf(rel))
    if (!bashChecked) { bash = bashCandidates()[0]; bashChecked = true }
    if (!bash) { warn('未找到 Bash，未完成脚本语法校验；Windows 可安装 Git Bash 后重新校验'); return }
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (/^(?:BASH_ENV|ENV|SHELLOPTS|BASHOPTS)$/i.test(name)) delete env[name]
    let result
    try { result = childProcess.spawnSync(bash, ['--noprofile', '--norc', '-n'], { input: content, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true, env }) } catch { result = { error: true } }
    if (result.error || result.status === null) { warn('Bash 不可用或语法检查超时，未完成脚本语法校验'); return }
    if (result.status !== 0) {
      const line = String(result.stderr || '').match(/line (\d+)/)
      // bash 的错误输出可能包含源代码，校验结果只展示行号，不回显凭据。
      fail(`${rel} 的 Bash 语法校验未通过${line ? `（第 ${line[1]} 行）` : ''}`)
    }
  }
  const parseCompose = (content, rel) => {
    try {
      const doc = parseDocument(content, { uniqueKeys: true })
      if (doc.errors.length) { fail(`${rel} 的 Compose YAML 语法无效`); return null }
      const data = doc.toJS({ maxAliasCount: 100 })
      if (!data || !data.services || typeof data.services !== 'object' || Array.isArray(data.services) || !Object.keys(data.services).length) {
        fail(`${rel} 必须包含非空 services`); return null
      }
      for (const [name, service] of Object.entries(data.services)) {
        if (!service || typeof service !== 'object' || Array.isArray(service)) fail(`${rel} 的服务 ${name} 定义无效`)
        else {
          const hasImage = typeof service.image === 'string' && service.image.trim()
          const hasBuild = (typeof service.build === 'string' && service.build.trim()) || (service.build && typeof service.build === 'object' && !Array.isArray(service.build))
          if (!hasImage && !hasBuild) fail(`${rel} 的服务 ${name} 缺少 image 或 build`)
          if (service.image !== undefined && !hasImage) fail(`${rel} 的服务 ${name} image 配置无效`)
          if (service.build !== undefined && !hasBuild) fail(`${rel} 的服务 ${name} build 配置无效`)
        }
      }
      return data
    } catch { fail(`${rel} 的 Compose YAML 无法完整解析`); return null }
  }
  const checkDockerfile = (content, rel, context) => {
    const lines = dockerLines(content)
    if (!lines.some((line) => /^FROM\s+\S+/i.test(line))) fail(`${rel} 缺少有效 FROM 指令`)
    if (/\\\s*$/.test(content.trimEnd()) && !/^\s*#/.test(content.trimEnd().split('\n').pop())) fail(`${rel} 以未完成的续行结尾，可能已截断`)
    if (!context) return
    for (const line of lines) {
      const match = line.match(/^(COPY|ADD)\s+(.+)$/i)
      if (!match) continue
      let args = match[2]
      if (/^--from(?:=|\s)/i.test(args) || /(?:^|\s)--from=/i.test(args)) continue
      args = args.replace(/^(?:--[\w-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?\s+)+/, '')
      let parts
      if (args.startsWith('[')) {
        try { parts = JSON.parse(args) } catch { fail(`${rel} 的 ${match[1]} JSON 参数无效`); continue }
        if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string')) { fail(`${rel} 的 ${match[1]} 参数必须为字符串数组`); continue }
      } else parts = (args.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((part) => part.replace(/^["']|["']$/g, ''))
      if (parts.length < 2) { fail(`${rel} 的 ${match[1]} 缺少来源或目标`); continue }
      for (const source of parts.slice(0, -1)) {
        if (/^<</.test(source) || (match[1].toUpperCase() === 'ADD' && isRemote(source))) continue
        if (isDynamic(source) || /[*?\[\]\\]/.test(source)) { warn(`${rel} 含动态或通配符构建源，需在实际构建时验证`); continue }
        const relSource = source.replace(/^\/+/, '')
        const normalized = path.posix.normalize(relSource)
        if (normalized === '..' || normalized.startsWith('../')) { fail(`${rel} 的构建源越出 build context`); continue }
        const entry = locate(path.posix.join(context.rel, normalized), `${rel} 的构建源`, true)
        if (entry && !fileExists(entry) && !directoryExists(entry)) fail(`${rel} 的构建源不存在：${path.posix.join(context.rel, normalized)}`)
      }
    }
  }

  if (!Array.isArray(files)) { fail('生成文件清单必须为数组'); files = [] }
  for (const file of files) {
    const entry = locate(file?.path, '生成文件')
    if (!entry) continue
    let writable
    try { writable = assertWritable ? assertWritable(entry.rel) : defaultWritable(entry.rel) } catch { writable = false }
    if (writable !== true && !writable?.ok) { fail(`不在允许生成的部署文件白名单内：${entry.rel}`); continue }
    if (overlay.has(keyOf(entry.rel))) { fail(`生成文件路径重复：${entry.rel}`); continue }
    if (virtualDirs.has(keyOf(entry.rel))) { fail(`生成文件路径与目录冲突：${entry.rel}`); continue }
    let parent = path.posix.dirname(entry.rel)
    let parentFile = false
    while (parent !== '.') { if (overlay.has(keyOf(parent))) parentFile = true; parent = path.posix.dirname(parent) }
    if (parentFile) { fail(`生成文件父目录已被文件占用：${entry.rel}`); continue }
    if (fs.existsSync(entry.abs) && !fs.statSync(entry.abs).isFile()) { fail(`生成文件路径已被目录占用：${entry.rel}`); continue }
    const content = typeof file.content === 'string' ? file.content.replace(/\r\n/g, '\n') : ''
    if (!content.trim()) { fail(`生成文件内容为空：${entry.rel}`); continue }
    if (Buffer.byteLength(content, 'utf8') > MAX_GENERATED_BYTES) { fail(`生成文件超过 400 KiB 上限：${entry.rel}`); continue }
    if (file.truncated || file.finishReason === 'length' || /^\s*```/m.test(content) || /^\s*(?:\.{3}|…+)\s*$/m.test(content) || /其余保持不变|内容已截断|此处省略|省略其余|TODO\s*[:：]\s*(?:实现|补充|填写)|YOUR_PROJECT_NAME/i.test(content)) fail(`生成文件含截断或未完成的占位内容：${entry.rel}`)
    if (hasLiteralCredential(content, /^\.env\.(?:example|sample|template)$/.test(path.posix.basename(entry.rel)))) fail(`生成文件包含凭据字面量，请改用环境变量引用：${entry.rel}`)
    overlay.set(keyOf(entry.rel), { rel: entry.rel, content })
    let dir = path.posix.dirname(entry.rel)
    while (dir !== '.') { virtualDirs.add(keyOf(dir)); dir = path.posix.dirname(dir) }
  }

  for (const { rel, content } of overlay.values()) {
    const base = path.posix.basename(rel)
    if (/\.sh$/i.test(base)) checkShell(rel, content)
    if (COMPOSE_RE.test(base)) parseCompose(content, rel)
    if (DOCKERFILE_RE.test(base)) checkDockerfile(content, rel)
    if (base === 'VERSION' && !VERSION_RE.test(content.trim())) fail(`${rel} 的版本号格式无效`)
  }

  // 未指定形态时仅校验本次文件本身，允许用户分步生成尚未齐全的部署文件集。
  if (plan?.deployMode === 'docker') {
    const compose = locate(plan.composeFile || project.composeFile || 'docker-compose.yml', 'Compose 文件')
    const content = read(compose, 'Compose 文件')
    const doc = content === null ? null : parseCompose(content, compose.rel)
    if (doc) {
      const composeDir = path.posix.dirname(compose.rel)
      const envKeys = new Set(Object.keys(process.env).filter((name) => process.env[name]))
      const metadata = doc['x-onedeploy']
      if (plan.executionMode === 'auto' && metadata && typeof metadata === 'object') {
        if (Object.hasOwn(metadata, 'generatedEnv')) {
          if (!Array.isArray(metadata.generatedEnv)) fail('自动部署 generatedEnv 元数据必须为数组')
          else {
            const names = new Set()
            for (const declaration of metadata.generatedEnv) {
              if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)
                || !GENERATED_ENV_NAMES.has(declaration.name) || !['hex', 'base64'].includes(declaration.kind)
                || Object.keys(declaration).some((name) => !['name', 'kind'].includes(name))) {
                fail('自动部署内部凭据声明无效：仅允许白名单变量名与 hex/base64 类型，不得包含口令值')
                continue
              }
              if (names.has(declaration.name)) { fail(`自动部署内部凭据声明重复：${declaration.name}`); continue }
              names.add(declaration.name)
              envKeys.add(declaration.name)
            }
          }
        }
        if (Object.hasOwn(metadata, 'healthPath') && (typeof metadata.healthPath !== 'string' || !/^\/[\w/?.=&%-]*$/.test(metadata.healthPath))) {
          fail('自动部署 healthPath 元数据必须是以 / 开始的安全 HTTP 路径')
        }
      }
      for (const envRel of new Set(['.env', path.posix.join(composeDir, '.env')])) {
        let entry
        try { entry = resolve(envRel) } catch { warn('项目环境配置路径不安全，未读取其变量'); continue }
        if (!fileExists(entry)) continue
        const envContent = read(entry, '环境配置文件')
        for (const match of String(envContent || '').matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/gm)) if (match[2].trim().replace(/^["']|["']$/g, '')) envKeys.add(match[1])
      }
      for (const match of content.matchAll(/(?<!\$)\$(?:\{([A-Za-z_]\w*)(?:(:?[-+?])[^}]*)?\}|([A-Za-z_]\w*))/g)) {
        const name = match[1] || match[3]
        if (!envKeys.has(name) && !['-', ':-', '+', ':+'].includes(match[2])) warn(`外部环境变量尚未配置：${name}；请在部署前提供`)
      }
      for (const [name, service] of Object.entries(doc.services)) {
        if (!service || typeof service !== 'object' || Array.isArray(service)) continue
        for (const envFile of [].concat(service.env_file || [])) {
          const value = typeof envFile === 'string' ? envFile : envFile?.path
          if (typeof value !== 'string' || !value.trim()) { fail(`服务 ${name} 的 env_file 路径无效`); continue }
          if (isDynamic(value)) { warn(`服务 ${name} 的 env_file 含变量路径，需配置后验证`); continue }
          if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) { fail(`服务 ${name} 的 env_file 必须位于项目内`); continue }
          const entry = locate(path.posix.join(composeDir, value), `服务 ${name} 的 env_file`)
          if (entry && directoryExists(entry)) { fail(`服务 ${name} 的 env_file 不是文件：${entry.rel}`); continue }
          if (entry && !fileExists(entry) && !(typeof envFile === 'object' && envFile.required === false)) fail(`服务 ${name} 必需的 env_file 不存在：${entry.rel}`)
        }
        if (!service.build) continue
        const build = typeof service.build === 'string' ? { context: service.build } : service.build
        if (!build || typeof build !== 'object' || Array.isArray(build)) { fail(`服务 ${name} 的 build 配置无效`); continue }
        const contextValue = build.context ?? '.'
        if (typeof contextValue !== 'string' || !contextValue.trim()) { fail(`服务 ${name} 的 build context 无效`); continue }
        if (isDynamic(contextValue) || isRemote(contextValue)) { warn(`服务 ${name} 使用动态或远端构建上下文，无法静态验证构建文件与来源`); continue }
        if (path.posix.isAbsolute(contextValue) || /^[A-Za-z]:/.test(contextValue)) { fail(`服务 ${name} 的 build context 必须位于项目内`); continue }
        const context = locate(path.posix.join(composeDir, contextValue), `服务 ${name} 的 build context`, true)
        if (!context) continue
        if (!directoryExists(context)) { fail(`服务 ${name} 的 build context 目录不存在：${context.rel}`); continue }
        if (typeof build.dockerfile_inline === 'string') { checkDockerfile(build.dockerfile_inline, `${compose.rel} 的服务 ${name} 内联 Dockerfile`, context); continue }
        const dockerfileValue = build.dockerfile || 'Dockerfile'
        if (typeof dockerfileValue !== 'string') { fail(`服务 ${name} 的 Dockerfile 路径无效`); continue }
        if (isDynamic(dockerfileValue)) { warn(`服务 ${name} 的 Dockerfile 含变量路径，需配置后验证`); continue }
        if (path.posix.isAbsolute(dockerfileValue) || /^[A-Za-z]:/.test(dockerfileValue)) { fail(`服务 ${name} 的 Dockerfile 必须位于项目内`); continue }
        const dockerfile = locate(path.posix.join(context.rel, dockerfileValue), `服务 ${name} 的 Dockerfile`)
        const dockerContent = read(dockerfile, 'Dockerfile')
        if (dockerContent !== null) checkDockerfile(dockerContent, dockerfile.rel, context)
      }
      if (doc.include) warn('Compose 含 include，外部编排内容需由 Docker Compose 实际校验')
    }
  } else if (plan?.deployMode === 'script') {
    const scriptMode = { ...project.scriptMode, ...plan.scriptMode }
    for (const rel of new Set([scriptMode.upgradeScript || 'upgrade.sh', 'start.sh', ...(!String(scriptMode.packageCommand || '').trim() ? ['package.sh'] : [])])) {
      const entry = locate(rel, '脚本部署入口')
      const content = read(entry, '脚本部署入口')
      if (content !== null && /\.sh$/i.test(entry.rel)) checkShell(entry.rel, content)
    }
    const version = plan.version || project.version || {}
    let detected = ''
    if (version.strategy === 'manual') detected = String(version.manual || '').trim()
    else {
      const entry = locate('VERSION', '版本文件')
      if (fileExists(entry)) detected = String(read(entry, '版本文件') || '').trim()
      else detected = String(plan.checks?.detectedVersion || plan.detectedVersion || '').trim()
    }
    if (!VERSION_RE.test(detected)) fail('脚本部署尚无可用版本号；请提供 VERSION、已识别的项目版本或计划中的手动版本')
  }
  return { ok: errors.length === 0, errors, warnings }
}

module.exports = { validateDeploymentFiles }
