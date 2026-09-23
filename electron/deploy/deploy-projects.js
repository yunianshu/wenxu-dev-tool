/**
 * 部署项目配置管理 —— 对应方案 §5.1 / §21 / §22：
 *   - 多项目配置（名称、本地目录、版本策略、部署选项）
 *   - 每个项目支持多个部署目标 targets[]（测试/生产等多环境）：
 *     各目标引用共享服务器，远程部署目录、健康检查与数据库备份独立配置
 *   - 持久化到 userData/deploy-projects.json；旧连接自动迁移到 servers 集合
 *   - SSH 密码/私钥口令由服务器统一经 safeStorage 加密落盘，明文不出主进程
 */
const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const store = require('../store')

function file() {
  return path.join(app.getPath('userData'), 'deploy-projects.json')
}

function genId() {
  return `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function defaultServer() {
  return { host: '', port: 22, username: 'root', authType: 'password', keyPath: '' }
}

/** 目标级数据同步配置：发布时把本地数据推送到本项目共享目录 */
function normalizeDataSync(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const str = (v, fallback) => {
    const out = String(v ?? fallback).trim()
    return out
  }
  return {
    enabled: s.enabled === true,
    // 相对项目根的数据目录；禁止绝对路径与 ..（防越界打包）
    localDir: str(s.localDir, 'data'),
    // 相对远程部署目录；shared/ 跨版本共享，发布/回滚不影响数据
    remoteDir: str(s.remoteDir, 'shared/data'),
    // 同步后导入钩子：'none' | 'command'——发布同步文件后在服务器上执行导入命令
    importMode: s.importMode === 'command' ? 'command' : 'none',
    // 占位符：{dataDir}=远端数据目录绝对路径 {user}/{secret}=下方账号凭据
    importCommand: typeof s.importCommand === 'string' ? s.importCommand : '',
    importUser: str(s.importUser, ''),
    // importSecret 原样保留（明文字符串或加密对象），由 save() 的 mergeSecret 统一加密合并
    importSecret: s.importSecret ?? null,
  }
}

/** 目标级数据库备份配置：容器名/库名按环境不同（测试库与生产库是两个实例） */
function normalizeDb(raw) {
  const d = raw && typeof raw === 'object' ? raw : {}
  return {
    strategy: ['auto', 'manual', 'off'].includes(d.strategy) ? d.strategy
      : d.enabled === true ? 'manual' : (d.container || d.name ? 'off' : 'auto'),
    enabled: d.enabled === true,
    type: d.type === 'mysql' ? 'mysql' : 'postgres',
    container: String(d.container ?? '').trim(),
    name: String(d.name ?? '').trim(),
    user: String(d.user ?? '').trim(),
  }
}

function normalizeHealth(raw) {
  const h = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: true, url: '', timeout: 90, interval: 3,
    ...h,
    // 旧配置显式关闭的检查继续关闭；仅未配置的新目标默认自动探测。
    strategy: ['auto', 'manual'].includes(h.strategy) ? h.strategy : h.enabled === false ? 'manual' : 'auto',
  }
}

function sameServerEndpoint(a, b) {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username
}

function clearAutomaticRuntime(target) {
  target.remotePath = ''
  delete target.autoSudo
  delete target.autoHealth
  delete target.autoDb
}

/** 单个部署目标（环境） */
function defaultTarget() {
  return {
    id: genId(),
    name: '默认环境',
    serverId: '',
    server: defaultServer(),
    remotePath: '',
    health: normalizeHealth(),
    db: normalizeDb(),
    dataSync: normalizeDataSync(),
  }
}

function defaultProject() {
  return {
    id: genId(),
    name: '',
    description: '',
    localPath: '',
    status: 'active',
    tags: [],
    notes: '',
    version: { strategy: 'auto', manual: '' },
    // 默认自动发布；docker/script 保留显式 Compose 与项目脚本部署。
    deployMode: 'auto',
    productionTargetId: '',
    autoDeploy: { port: 0 },
    composeFile: 'docker-compose.yml',
    // 脚本部署：产物目录（相对项目根，放 tar.gz/tgz/zip 发布包）与升级入口脚本名；
    // 环境引导开关：服务器缺 Java17 / pg_dump 时自动装用户态环境（不动系统）；
    // 打包命令：配置后每次在隔离项目副本中执行（如 bash package.sh）；
    // 版本同步：只更新本次构建副本的版本声明，失败不改变源项目；
    // 发布说明：项目遵循「release-notes-<版本>.md 随版本提供」约定而目标版本缺失时，打包前自动生成初稿
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', bootstrapJava: false, bootstrapPgdump: false, packageCommand: '', packageTimeoutSec: 900, autoBumpVersion: true, autoReleaseNotes: true },
    // 项目级发布策略：跨环境统一的开关与保留份数；数据库备份配置按环境存放于 targets[].db
    deploy: {
      backupCode: true,
      autoRollback: true,
      deleteUploadAfterSuccess: true,
      keepReleases: 10,
      keepBackups: 10,
    },
    targets: [defaultTarget()],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * 旧版迁移：项目根上的 server/health/remotePath → targets[0]。
 * 读取与保存路径统一走此函数，保证任何入口拿到的都是新结构。
 */
function normalizeProject(p) {
  const source = JSON.parse(JSON.stringify(p || {}))
  const defaults = defaultProject()
  const c = {
    ...defaults,
    ...source,
    version: { ...defaults.version, ...(source.version || {}) },
    deploy: { ...defaults.deploy, ...(source.deploy || {}) },
    scriptMode: { ...defaults.scriptMode, ...(source.scriptMode || {}) },
  }
  // 数据库备份配置原为项目级（deploy.backupDatabase/dbType/dbContainer/dbName/dbUser）：
  // 多环境下测试库与生产库是两个实例，现将该组配置改为按部署目标存放。
  // 此处取出旧值供下方迁移到各目标，并从项目级删除——两份真源并存会导致
  // 「界面改的是环境级配置、发布读的仍是项目级旧值」。
  const legacyDb = normalizeDb(source.deploy && {
    enabled: source.deploy.backupDatabase,
    type: source.deploy.dbType,
    container: source.deploy.dbContainer,
    name: source.deploy.dbName,
    user: source.deploy.dbUser,
  })
  for (const k of ['backupDatabase', 'dbType', 'dbContainer', 'dbName', 'dbUser']) delete c.deploy[k]
  // 版本号进入服务器端路径（releases/$VERSION，且会被 rm -rf）：只放行安全字符，
  // 非法值清空由发布前检查报错，杜绝路径注入
  const manual = String(c.version.manual || '').trim()
  c.version.manual = /^[\w][\w.+~-]*$/.test(manual) && manual.length <= 64 ? manual : ''
  // 已有服务器配置保留旧部署行为；未配置的新项目默认自动发布。
  c.deployMode = ['auto', 'script', 'docker'].includes(source.deployMode)
    ? source.deployMode : (source.server || source.deployMode || source.targets?.some((t) => t.server?.host) ? 'docker' : 'auto')
  c.autoDeploy = { port: Math.min(65535, Math.max(0, Math.floor(Number(source.autoDeploy?.port) || 0))) }
  c.composeFile = String(c.composeFile || 'docker-compose.yml').trim()
  // 产物目录/脚本名进入远端命令，仅放行安全字符（防注入/防越界）
  c.scriptMode.artifactDir = String(c.scriptMode.artifactDir || 'release').trim()
  c.scriptMode.upgradeScript = String(c.scriptMode.upgradeScript || 'upgrade.sh').trim()
  if (!/^[\w./-]+$/.test(c.scriptMode.artifactDir) || c.scriptMode.artifactDir.includes('..')) {
    c.scriptMode.artifactDir = 'release'
  }
  if (!/^[\w./-]+$/.test(c.scriptMode.upgradeScript) || c.scriptMode.upgradeScript.split('/').some((s) => !s || s === '.' || s === '..')) {
    c.scriptMode.upgradeScript = 'upgrade.sh'
  }
  c.scriptMode.bootstrapJava = c.scriptMode.bootstrapJava === true
  c.scriptMode.bootstrapPgdump = c.scriptMode.bootstrapPgdump === true
  // 打包命令（本地执行，非远端）：仅字符串清洗；超时 30s~1h 夹取
  c.scriptMode.packageCommand = String(c.scriptMode.packageCommand || '').trim().slice(0, 500)
  const t = Number(c.scriptMode.packageTimeoutSec)
  c.scriptMode.packageTimeoutSec = Number.isFinite(t) && t >= 30 ? Math.min(Math.floor(t), 3600) : 900
  // 打包前自动同步项目版本号（手动版本与项目版本文件不一致时升级版本声明），默认开
  c.scriptMode.autoBumpVersion = c.scriptMode.autoBumpVersion !== false
  // 打包前自动生成缺失的发布说明初稿（项目有 release-notes-*.md 约定时），默认开
  c.scriptMode.autoReleaseNotes = c.scriptMode.autoReleaseNotes !== false
  c.name = String(c.name || '').trim()
  c.description = String(c.description || '')
  c.localPath = String(c.localPath || '')
  c.status = ['active', 'paused', 'archived'].includes(c.status) ? c.status : 'active'
  c.tags = [...new Set((Array.isArray(c.tags) ? c.tags : []).map((x) => String(x).trim()).filter(Boolean))]
  c.notes = String(c.notes || '')
  // 本地调试模式：bat = 运行根目录 start.bat（默认）；off = 该项目不需要本地调试
  c.debugMode = c.debugMode === 'off' ? 'off' : 'bat'

  if (!Array.isArray(source.targets) || !source.targets.length) {
    const t = defaultTarget()
    t.health = normalizeHealth(source.health)
    if (source.server && (source.server.host || source.server.remotePath || source.remotePath)) {
      t.server = { ...defaultServer(), ...source.server }
      // 旧格式 remotePath 位于 server 内部（deploy-service 旧版读 project.server.remotePath）
      t.remotePath = (source.server && source.server.remotePath) || source.remotePath || ''
      t.name = '默认环境'
    }
    // 旧格式无环境级 db 配置：项目级 legacy 值迁移到唯一目标
    t.db = normalizeDb(legacyDb)
    c.targets = [t]
  } else {
    c.targets = source.targets
  }
  c.targets = c.targets.map((t) => ({
    ...defaultTarget(),
    ...t,
    server: { ...defaultServer(), ...(t.server || {}) },
    health: normalizeHealth(t.health),
    // 旧数据的目标没有 db 字段，而 defaultTarget() 的默认值会经展开注入，
    // 不能用真值判断「是否自带配置」——显式判所属键，缺失时迁移 legacy 值
    db: normalizeDb(Object.prototype.hasOwnProperty.call(t, 'db') ? t.db : legacyDb),
    dataSync: normalizeDataSync(t.dataSync),
  }))
  delete c.server
  delete c.health
  delete c.remotePath
  return c
}

/** 掩码展示用 */
function maskSecret(s) {
  if (!s) return '••••••'
  if (s.length <= 6) return '••••••'
  return `••••••${s.slice(-3)}`
}

/** 旧版密文仅用于展示迁移状态，绝不在列表读取时阻断整个项目集合。 */
function displaySecret(value) {
  const plain = store.decryptText(value, { allowUnavailable: true })
  return { plain, needsReentry: process.env.PLM_NODE_BACKEND === '1' && !!value?.enc && !plain }
}

function normalizeServer(s) {
  return {
    id: s.id || genId(), name: String(s.name || s.host || '服务器').trim(),
    host: String(s.host || '').trim(), port: Number(s.port || 22),
    username: String(s.username || 'root').trim(), authType: s.authType === 'key' ? 'key' : 'password',
    keyPath: String(s.keyPath || '').trim(),
    ...(s.secret ? { secret: s.secret } : {}), ...(s.passphrase ? { passphrase: s.passphrase } : {}),
  }
}

function serverView(s) {
  const secret = displaySecret(s.secret), pass = displaySecret(s.passphrase)
  const out = { ...s,
    secretConfigured: !!secret.plain, secretMasked: secret.plain ? maskSecret(secret.plain) : '', secretNeedsReentry: secret.needsReentry,
    passphraseConfigured: !!pass.plain, passphraseNeedsReentry: pass.needsReentry,
  }
  delete out.secret; delete out.passphrase
  return out
}

/** 凭据解密失败不能视为空值并错误合并；仍保留原加密信息。 */
function connectionKey(s) {
  const credential = (v) => !v ? '' : store.decryptText(v, { allowUnavailable: true }) || JSON.stringify(v)
  return JSON.stringify([s.host.toLowerCase(), s.port, s.username, s.authType, s.keyPath, credential(s.secret), credential(s.passphrase)])
}

function registerServer(doc, raw) {
  const server = normalizeServer({ ...raw, id: '' })
  const found = doc.servers.find((s) => connectionKey(s) === connectionKey(server))
  if (found) return found.id
  doc.servers.push(server)
  return server.id
}

/** 项目和服务器一起替换落盘，迁移不会留下半份引用。 */
function writeDocument(doc) {
  const projects = doc.projects.map((p) => ({ ...p, targets: p.targets.map((t) => {
    const out = { ...t }
    if (out.serverId) delete out.server
    return out
  }) }))
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  const temp = `${file()}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 2, servers: doc.servers, projects }, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, file())
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
}

function loadDocument() {
  let raw = {}
  if (fs.existsSync(file())) raw = JSON.parse(fs.readFileSync(file(), 'utf8'))
  const doc = { servers: (raw.servers || []).map(normalizeServer), projects: (raw.projects || []).map(normalizeProject) }
  // 旧项目即使尚未配置连接，也要固定归一化生成的目标 ID，不能每次读取都换 ID。
  let migrated = raw.schemaVersion !== 2 && doc.projects.length > 0
  for (const p of doc.projects) for (const t of p.targets) {
    if (!t.serverId && t.server.host) { t.serverId = registerServer(doc, t.server); migrated = true }
    if (t.serverId) {
      const server = doc.servers.find((s) => s.id === t.serverId)
      t.server = server ? { ...server } : defaultServer()
    }
  }
  if (migrated) writeDocument(doc)
  return doc
}

function listServers() {
  const doc = loadDocument()
  return doc.servers.map((s) => ({ ...serverView(s), projects: doc.projects.filter((p) => p.targets.some((t) => t.serverId === s.id)).map((p) => ({ id: p.id, name: p.name })) }))
}

function saveServer(input = {}) {
  const doc = loadDocument()
  const old = input.id ? doc.servers.find((s) => s.id === input.id) : null
  if (input.id && !old) return { ok: false, error: '服务器不存在，请刷新列表' }
  const s = normalizeServer(input)
  if (!s.host || /[\s/]/.test(s.host) || !s.username || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return { ok: false, error: '请填写有效的服务器地址、账号与 SSH 端口（地址不含 http://）' }
  for (const [key, clear] of [['secret', 'clearSecret'], ['passphrase', 'clearPassphrase']]) {
    s[clear] = input[clear] === true
    mergeSecret(s, old?.[key], key, clear)
  }
  if (old) doc.servers[doc.servers.indexOf(old)] = s
  else doc.servers.push(s)
  if (old && !sameServerEndpoint(old, s)) {
    for (const project of doc.projects) {
      if (project.deployMode !== 'auto') continue
      for (const target of project.targets) {
        if (target.serverId === s.id) clearAutomaticRuntime(target)
      }
    }
  }
  writeDocument(doc)
  return { ok: true, id: s.id }
}

function removeServer(id) {
  const doc = loadDocument()
  const used = doc.projects.filter((p) => p.targets.some((t) => t.serverId === id))
  if (used.length) return { ok: false, error: `服务器仍被以下项目使用：${used.map((p) => p.name).join('、')}。请先切换或解除项目关联` }
  doc.servers = doc.servers.filter((s) => s.id !== id)
  writeDocument(doc)
  return { ok: true }
}

/** 读取全部项目（脱敏）：明文凭据不出主进程 */
function list() {
  return loadAllRaw().map((p) => {
    p.targets = p.targets.map((t) => {
      const secret = displaySecret(t.server && t.server.secret)
      const pass = displaySecret(t.server && t.server.passphrase)
      const s = { ...t.server }
      delete s.secret
      delete s.passphrase
      s.secretConfigured = !!secret.plain
      s.secretMasked = secret.plain ? maskSecret(secret.plain) : ''
      s.secretNeedsReentry = secret.needsReentry
      s.passphraseConfigured = !!pass.plain
      s.passphraseNeedsReentry = pass.needsReentry
      // 数据同步导入凭据：加密对象不出主进程，只回配置状态与掩码
      const ds = { ...(t.dataSync || {}) }
      const importSecret = displaySecret(ds.importSecret)
      delete ds.importSecret
      ds.importSecretConfigured = !!importSecret.plain
      ds.importSecretNeedsReentry = importSecret.needsReentry
      if (importSecret.plain) ds.importSecretMasked = maskSecret(importSecret.plain)
      return { ...t, server: s, dataSync: ds }
    })
    return p
  })
}

function loadAllRaw() {
  return loadDocument().projects
}

/** 主进程专用：取某项目某目标的明文凭据（targetId 省略时用第一个目标） */
function getCredentials(projectId, targetId) {
  const p = loadAllRaw().find((x) => x.id === projectId)
  if (!p) return null
  const t = p.targets.find((x) => x.id === targetId) || p.targets[0]
  if (!t) return { password: '', passphrase: '' }
  return {
    password: store.decryptText(t.server && t.server.secret),
    passphrase: store.decryptText(t.server && t.server.passphrase),
  }
}

/** 主进程专用：取数据同步导入钩子的明文凭据（list() 脱敏后不含，需走原始数据） */
function getDataSyncCredentials(projectId, targetId) {
  const p = loadAllRaw().find((x) => x.id === projectId)
  const t = p && (p.targets.find((x) => x.id === targetId) || p.targets[0])
  return store.decryptText(t && t.dataSync && t.dataSync.importSecret)
}

function persistAll(projects, doc = loadDocument()) {
  writeDocument({ ...doc, projects })
}

/**
 * 按目标合并凭据（与 AI Key 相同规则）：
 *   - 传入 secret 非空 → 加密替换；空且未要求清除 → 保留该目标既有；clearSecret → 清除
 *   - passphrase 同理
 */
function mergeSecret(s, oldSecret, key, clearKey) {
  const plain = s[key] || ''
  delete s[key]
  const clearFlag = s[clearKey]
  delete s[clearKey]
  if (plain) {
    s[key] = store.encryptText(plain)
  } else if (clearFlag) {
    delete s[key]
  } else if (oldSecret) {
    s[key] = oldSecret // 字节原样保留，不触发解密
  }
}

/**
 * 保存项目（新增或更新）。targets 为完整数组，按 id 匹配旧目标保留凭据。
 */
function save(input) {
  const doc = loadDocument()
  const projects = doc.projects
  const incoming = normalizeProject(JSON.parse(JSON.stringify(input || {})))
  if (!incoming.id) incoming.id = genId()
  if (!incoming.createdAt) incoming.createdAt = Date.now()
  incoming.updatedAt = Date.now()

  const idx = projects.findIndex((p) => p.id === incoming.id)
  const old = idx >= 0 ? projects[idx] : null
  if (incoming.targets.some((t) => t.serverId && !doc.servers.some((s) => s.id === t.serverId))) return { ok: false, error: '所选服务器不存在，请重新选择' }

  incoming.targets = incoming.targets.map((t) => {
    const oldT = old && old.targets.find((x) => x.id === t.id)
    if (t.serverId) {
      // 项目表单里的 server 只是查询快照，不能覆盖共享服务器的最新连接与口令。
      const server = doc.servers.find((s) => s.id === t.serverId)
      const staleEndpoint = t.server.host && !sameServerEndpoint(normalizeServer(t.server), server)
      if (incoming.deployMode === 'auto' && ((oldT && oldT.serverId !== t.serverId) || staleEndpoint)) {
        // 连接变化只使该服务器的探测结果失效，旧表单也不能恢复过期探测结果。
        clearAutomaticRuntime(t)
      }
      t.server = { ...server }
    } else {
      const oldConnection = oldT?.serverId ? null : oldT?.server
      mergeSecret(t.server, oldConnection?.secret, 'secret', 'clearSecret')
      mergeSecret(t.server, oldConnection?.passphrase, 'passphrase', 'clearPassphrase')
      if (t.server.host) t.serverId = registerServer(doc, t.server)
    }
    // 数据同步导入凭据：与 server.secret 同一合并规则
    if (t.dataSync) {
      mergeSecret(t.dataSync, oldT && oldT.dataSync && oldT.dataSync.importSecret, 'importSecret', 'clearImportSecret')
    }
    return t
  })

  if (idx >= 0) projects[idx] = { ...old, ...incoming }
  else {
    // 项目专属参数不能跨项目继承；服务器连接仅在用户显式复制时复用。
    projects.push(incoming)
  }
  persistAll(projects, doc)
  return { ok: true, id: incoming.id }
}

function remove(projectId) {
  const projects = loadAllRaw().filter((p) => p.id !== projectId)
  persistAll(projects)
  return { ok: true }
}

/**
 * 显式复制服务器引用到目标项目；项目专属部署参数不复制。
 * SSH 凭据继续由共享服务器保管，目标只复用 serverId。复制的目标一律重新生成 id。
 * 返回复制的环境数量。
 */
function applyCopyConfig(from, to) {
  const copied = (from.targets || []).filter((t) => t.server?.host).map((t) => ({
    ...defaultTarget(), name: t.name, serverId: t.serverId, server: JSON.parse(JSON.stringify(t.server)),
  }))
  to.targets.push(...copied)
  to.updatedAt = Date.now()
  return copied.length
}

/** 显式复制入口（部署设置抽屉「从其他项目复制」） */
function copyConfig({ fromProjectId, toProjectId } = {}) {
  const projects = loadAllRaw()
  const from = projects.find((p) => p.id === fromProjectId)
  const to = projects.find((p) => p.id === toProjectId)
  if (!from) return { ok: false, error: '源项目不存在' }
  if (!to) return { ok: false, error: '目标项目不存在' }
  if (fromProjectId === toProjectId) return { ok: false, error: '不能从项目自身复制' }
  const copiedTargets = applyCopyConfig(from, to)
  persistAll(projects)
  return { ok: true, id: to.id, copiedTargets }
}

module.exports = { list, save, remove, copyConfig, listServers, saveServer, removeServer, getCredentials, getDataSyncCredentials, defaultProject, defaultTarget, normalizeProject }
