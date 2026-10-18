/** OpenClaw 产物随项目发布；只收集项目内已构建文件，不安装依赖或修改授权。 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const yaml = require('yaml')
const { createMatcher } = require('./packager')

const PREFIX = '.onedeploy-openclaw'
const ID = /^[a-z0-9][a-z0-9_-]{0,100}$/
function normalizeOpenClaw(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const home = String(c.home || '/root/.openclaw').trim()
  return { enabled: c.enabled === true, container: String(c.container || '').trim(),
    pluginDir: String(c.pluginDir || '').trim(), skillDir: String(c.skillDir || '').trim(),
    home, workspace: String(c.workspace || `${home}/workspace`).trim() }
}
function directory(projectDir, relative) {
  if (!relative || path.posix.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(s => !s || s === '.' || s === '..') || /^[A-Za-z]:/.test(relative)) {
    throw new Error('OpenClaw 来源必须是项目内相对目录，不能包含上级路径')
  }
  const root = fs.realpathSync(projectDir)
  let current = root
  for (const part of relative.split('/')) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('OpenClaw 来源不能经过符号链接')
  }
  if (!fs.statSync(current).isDirectory() || !fs.realpathSync(current).startsWith(root + path.sep)) throw new Error('OpenClaw 来源目录越界')
  return current
}
function containerPath(value) {
  return /^\/[\w./-]+$/.test(value) && value.split('/').every(s => s !== '.' && s !== '..')
    && !['/', '/root', '/home', '/tmp', '/etc', '/usr', '/var', '/opt'].includes(value.replace(/\/+$/, ''))
}
function prepareOpenClaw(project, target) {
  const config = normalizeOpenClaw(target?.openclaw)
  if (!config.enabled) return null
  if (project.deployMode === 'script') throw new Error('OpenClaw 同步仅支持 Docker 或自动 Docker 发布')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(config.container)) throw new Error('请填写有效的 OpenClaw 容器名')
  if (!containerPath(config.home) || !containerPath(config.workspace)) throw new Error('OpenClaw 根目录和工作区必须是安全的容器内绝对目录')
  if (!config.pluginDir && !config.skillDir) throw new Error('请至少配置插件或 Skill 来源目录')
  if (fs.existsSync(path.join(project.localPath, PREFIX))) throw new Error(`${PREFIX} 为部署工具保留目录，请调整项目中的同名目录`)
  const rules = fs.existsSync(path.join(project.localPath, '.deployignore')) ? fs.readFileSync(path.join(project.localPath, '.deployignore'), 'utf8').split(/\r?\n/) : []
  const matcher = createMatcher(rules, { includeBuild: true })
  const files = [], resources = []
  let bytes = 0
  function collect(relative, kind) {
    const source = directory(project.localPath, relative)
    const metadata = name => {
      const file = path.join(source, name)
      if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('OpenClaw 元数据必须是来源目录内的普通文件')
      return fs.readFileSync(file, 'utf8')
    }
    let id, version = '', publishMatcher = null
    if (kind === 'plugin') {
      const meta = JSON.parse(metadata('openclaw.plugin.json'))
      const pkg = JSON.parse(metadata('package.json'))
      id = meta.id; version = pkg.version
      if (Array.isArray(pkg.files)) {
        publishMatcher = createMatcher(['*', ...['package.json', 'openclaw.plugin.json', 'README*', 'LICENSE*', ...pkg.files]
          .filter(p => typeof p === 'string').map(p => '!/' + p.replace(/^\.\//, ''))], { includeBuild: true })
      }
      if (!version || meta.version !== version) throw new Error('OpenClaw 插件 package 与 manifest 版本必须一致')
      if (!Array.isArray(pkg.openclaw?.extensions) || !pkg.openclaw.extensions.length) throw new Error('插件缺少 openclaw.extensions 构建入口')
      for (const entry of pkg.openclaw.extensions) {
        const resolved = path.resolve(source, entry)
        if (!resolved.startsWith(source + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('插件构建入口不存在或越界，请先构建插件')
      }
    } else {
      const skill = metadata('SKILL.md').replace(/\r\n/g, '\n')
      const header = skill.match(/^---\n([\s\S]*?)\n---/)
      id = header && yaml.parse(header[1])?.name
    }
    if (!ID.test(id || '')) throw new Error('OpenClaw 插件或 Skill 标识无效')
    const entries = []
    function walk(dir, rel = '') {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = rel ? `${rel}/${item.name}` : item.name
        const from = path.join(dir, item.name)
        // 凭证与本机依赖不作为插件发布内容；依赖须预先构建到产物中。
        if (item.name === 'node_modules' || /^(?:\.env(?:\..*)?|id_rsa.*|id_ed25519.*)$/.test(item.name) || /\.(?:pem|key|pfx|p12)$/i.test(item.name)) continue
        if (matcher.ignored(`${relative}/${name}`)) continue
        if (item.isSymbolicLink()) throw new Error('OpenClaw 发布目录不能包含符号链接')
        if (item.isDirectory()) walk(from, name)
        else if (item.isFile()) {
          if (publishMatcher?.ignored(name)) continue
          const content = fs.readFileSync(from)
          bytes += content.length
          if (bytes > 100 * 1024 * 1024 || files.length >= 10000) throw new Error('OpenClaw 发布目录过大，请提供独立构建产物')
          const sha256 = crypto.createHash('sha256').update(content).digest('hex')
          entries.push({ path: name, sha256, mode: fs.statSync(from).mode & 0o111 ? 0o755 : 0o644 })
          files.push({ path: `${PREFIX}/${kind}/${name}`, content })
        }
      }
    }
    walk(source)
    const required = kind === 'plugin' ? ['package.json', 'openclaw.plugin.json', ...JSON.parse(fs.readFileSync(path.join(source, 'package.json'))).openclaw.extensions.map(p => p.replace(/^\.\//, ''))] : ['SKILL.md']
    if (required.some(p => !entries.some(e => e.path === p))) throw new Error('OpenClaw 必需文件被发布忽略规则排除，请调整来源或 .deployignore')
    resources.push({ kind, id, version, files: entries })
  }
  if (config.pluginDir) collect(config.pluginDir, 'plugin')
  if (config.skillDir) collect(config.skillDir, 'skill')
  const manifest = { format: 1, home: config.home, workspace: config.workspace, resources }
  const shell = fs.readFileSync(path.join(__dirname, 'scripts/openclaw-sync.sh'), 'utf8').replace(/\r\n/g, '\n')
  files.push({ path: `${PREFIX}/manifest.json`, content: JSON.stringify(manifest) })
  files.push({ path: `${PREFIX}/worker.mjs`, content: fs.readFileSync(path.join(__dirname, 'scripts/openclaw-worker.mjs'), 'utf8').replace(/\r\n/g, '\n') })
  files.push({ path: `${PREFIX}/sync.sh`, content: shell.replace('__CONTAINER_NAME__', config.container) })
  return { config, files, manifest }
}
module.exports = { normalizeOpenClaw, prepareOpenClaw, PREFIX }
