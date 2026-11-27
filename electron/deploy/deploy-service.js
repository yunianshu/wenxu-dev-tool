/**
 * 部署编排服务 —— 对应方案 §4/§10/§17/§27 的 DeployService：
 * 完整流程：本地检查 → 生成 ZIP → SSH 连接 → 上传+校验 → 服务器备份 →
 * 解压 → Docker 构建 → 启动 → 健康检查 → （失败自动回滚）→ 清理 → 记录历史。
 * 服务器端逻辑收敛在 deploy.sh（方案 §10.2），本模块只负责编排、日志流与阶段映射。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const ssh = require('./ssh-service')
const packager = require('./packager')
const projects = require('./deploy-projects')
const history = require('./history')
const releaseNotes = require('./release-notes')
const store = require('../store')
const automatic = require('./auto-deploy')
const { parse: parseYaml } = require('yaml')
const aiDeploy = require('./ai-deploy')
const moduleDataSync = require('./data-sync')
const moduleOpenClaw = require('./openclaw-sync')
const workspace = require('./build-workspace')
const { validateArtifact } = require('./artifact-check')
const { detectVersion, bumpVersionFiles, syncBackVersion } = require('./version-detector')

/** 服务端脚本随应用分发（asar 内也可 readFileSync） */
const DEPLOY_SCRIPT_PATH = path.join(__dirname, 'scripts', 'deploy.sh')

/** 发布阶段；直接挂载的数据在启动前同步，导入钩子在应用健康后执行。 */
const STAGES = [
  { id: 'check', label: '检查项目' },
  { id: 'package', label: '项目打包' },
  { id: 'upload', label: '上传文件' },
  { id: 'backup', label: '备份服务器' },
  { id: 'extract', label: '解压新版本' },
  { id: 'build', label: 'Docker构建' },
  { id: 'start', label: '启动服务' },
  { id: 'health', label: '健康检查' },
  { id: 'openclaw', label: 'OpenClaw 同步' },
  { id: 'datasync', label: '数据同步' },
]

let emitFn = null
const activeRuns = new Map()

function setEmitter(fn) {
  emitFn = fn
}

function emit(channel, payload) {
  if (emitFn) { try { emitFn(channel, payload) } catch { /* 窗口销毁时忽略 */ } }
}

function ts() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function emitStandaloneLog(level, text) {
  emit('deploy:log', { level, text, ts: ts() })
}

function newStageTracker(publish) {
  const state = Object.fromEntries(STAGES.map((s) => [s.id, { status: 'waiting', durationMs: 0 }]))
  const order = STAGES.map((s) => s.id)
  const stage = (id, status, durationMs = 0) => publish('deploy:stage', { stage: id, status, durationMs })
  const end = (id, status, startedAt) => {
    if (state[id]) {
      state[id].status = status
      if (startedAt) state[id].durationMs = Date.now() - startedAt
      stage(id, status, state[id].durationMs)
    }
  }
  const begin = (id) => {
    if (!state[id]) return
    // 服务器脚本只发「阶段开始」标记、不发结束标记：后一阶段开始即说明排在前面的阶段已经完成。
    // 不在此收尾的话，前面所有阶段都会一直挂着 running，运行面板的「当前阶段」停在最先开始的那个
    for (const previous of order.slice(0, order.indexOf(id))) {
      if (state[previous].status === 'running') end(previous, 'success')
    }
    state[id].status = 'running'
    stage(id, 'running')
  }
  return { state, begin, end }
}

/** 无项目 id 的旧调用仅在任务唯一时可取消，避免误伤其他项目。 */
function cancel(projectId, runId) {
  if (!projectId && activeRuns.size > 1) return { ok: false, error: '请指定要取消发布的项目' }
  const operation = projectId ? activeRuns.get(projectId) : activeRuns.values().next().value
  if (!operation || (runId && operation.id !== runId)) return { ok: false, error: '该发布任务已结束' }
  if (operation.controller.signal.aborted) return { ok: true }
  operation.controller.abort()
  if (operation.pkgChild) killTree(operation.pkgChild)
  ssh.close(operation.conn)
  for (const conn of operation.auxConns || []) ssh.close(conn)
  return { ok: true }
}

function isBusy(projectId) {
  return projectId ? activeRuns.has(projectId) : activeRuns.size > 0
}

function workspaceKey(dir) {
  if (!dir) return ''
  let resolved = path.resolve(dir)
  try { resolved = fs.realpathSync.native(resolved) } catch { /* 路径错误由项目检查报告 */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** 同项目互斥。共用宿主机或本地目录的操作按提交顺序执行。 */
async function withRun(projectId, targetId, type, execute, { version = '', requestId, releasePlan } = {}) {
  if (activeRuns.has(projectId)) throw new Error('该项目已有发布任务进行中，请等待完成或取消')
  const project = projects.list().find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请重新保存')
  const target = getTarget(project, targetId)
  if (!target) throw new Error('项目缺少部署目标，请先在配置中添加')
  if (releasePlan) {
    if (releasePlan.localPath !== project.localPath || releasePlan.host !== target.server.host
      || releasePlan.port !== (Number(target.server.port) || 22) || releasePlan.username !== (target.server.username || '')
      || releasePlan.remotePath !== target.remotePath) {
      throw new Error('部署地址或项目目录已变化，请刷新后重新确认发布')
    }
    if (releasePlan.versionOverride && (typeof releasePlan.versionOverride !== 'string' || !safeVersion(releasePlan.versionOverride))) {
      throw new Error('发布版本号无效')
    }
  }

  const host = String(target.server.host || '').trim().toLowerCase().replace(/\.$/, '')
  const dir = type === 'deploy' ? workspaceKey(project.localPath) : ''
  const blockers = [...activeRuns.values()].filter((other) =>
    (host && other.host === host) || (dir && other.dir === dir))
  const id = crypto.randomBytes(6).toString('hex')
  const controller = new AbortController()
  let release
  const released = new Promise((resolve) => { release = resolve })
  const publish = (channel, payload) => emit(channel, { ...payload, projectId, targetId: target.id, runId: id, requestId })
  const tracker = type === 'db-restore' ? null : newStageTracker(publish)
  const record = {
    id, projectId, projectName: project.name, type, targetId: target.id, targetName: target.name,
    version, oldVersion: '', status: 'running', startedAt: Date.now(), finishedAt: 0, durationMs: 0,
    host: `${target.server.host}:${target.server.port}`, remotePath: target.remotePath,
    message: '', logFile: '', ...(tracker && { stages: tracker.state }),
  }
  const lines = []
  const operation = {
    id, host, dir, controller, released, conn: null, queued: blockers.length > 0,
    // 环境同步会同时连接源环境服务器；取消与收尾时一并关闭
    auxConns: [],
    project, target, record, tracker, publish, releasePlan,
    log(level, text) {
      const safeText = operation.redact ? operation.redact(text) : text
      const time = ts()
      lines.push(`${time} [${level.toUpperCase()}] ${safeText}`)
      publish('deploy:log', { level, text: safeText, ts: time })
    },
    finish(status, message) {
      record.status = status
      record.message = message && operation.redact ? operation.redact(message) : message || ''
    },
  }
  const notifyStatus = () => publish('deploy:status', { type, queued: operation.queued, startedAt: record.startedAt, targetName: target.name })
  activeRuns.set(projectId, operation)
  try {
    notifyStatus()
    if (operation.queued) {
      const { signal } = controller
      let wake
      const aborted = new Promise((resolve) => { wake = resolve })
      signal.addEventListener('abort', wake, { once: true })
      try {
        if (!signal.aborted) await Promise.race([Promise.all(blockers.map((other) => other.released)), aborted])
      } finally {
        signal.removeEventListener('abort', wake)
      }
      if (signal.aborted) operation.finish('canceled', '已取消排队，任务尚未执行')
      else {
        operation.queued = false
        notifyStatus()
      }
    }
    if (record.status === 'running') await execute(operation)
    record.finishedAt = Date.now()
    record.durationMs = record.finishedAt - record.startedAt
    record.logFile = history.writeLog(id, lines.join('\n'))
    history.add(record)
  } finally {
    ssh.close(operation.conn)
    for (const conn of operation.auxConns) ssh.close(conn)
    activeRuns.delete(projectId)
    release()
  }

  if (type === 'deploy' && record.status === 'success' && record.gitCommits?.length) {
    releaseNotes.enrichRecord(id, () => publish('deploy:history:updated', { id }))
  }
  const result = JSON.parse(JSON.stringify(record))
  publish('deploy:done', { record: result })
  return result
}

/** 解析脚本输出的控制标记，返回应显示的行或 null */
function parseMarker(line, tracker, resultBox, log) {
  const m = line.match(/^__STAGE__:([\w-]+)$/)
  if (m) {
    const map = {
      'backup-code': 'backup', 'backup-db': 'backup', extract: 'extract',
      build: 'build', start: 'start', health: 'health', rollback: 'rollback', datasync: 'datasync', openclaw: 'openclaw',
    }
    const sid = map[m[1]]
    if (sid === 'rollback') {
      log('warn', '发布失败，正在自动回滚……')
    } else if (sid) {
      if (sid === 'datasync') tracker.end('build', 'success')
      if (sid === 'openclaw') {
        for (const id of ['backup', 'extract', 'build', 'start', 'health']) {
          if (tracker.state[id]?.status === 'running') tracker.end(id, 'success')
        }
      }
      tracker.begin(sid)
    }
    return null
  }
  if (line === '__STAGE_OK__:datasync') {
    resultBox.dataSynced = true
    tracker.end('datasync', 'success')
    return null
  }
  const guard = line.match(/^__DB_GUARD__:(db_guard_[\w.-]+\.sql)$/)
  if (guard) { resultBox.dataGuard = guard[1]; return null }
  if (line === '__STAGE_OK__:openclaw') {
    resultBox.openclawSynced = true
    tracker.end('openclaw', 'success')
    return null
  }
  if (line === '__STAGE_SKIP__:openclaw') { tracker.end('openclaw', 'skipped'); return null }
  if (line === '__STAGE_FAIL__:openclaw') { tracker.end('openclaw', 'failed'); return null }
  const okM = line.match(/^__DEPLOY_OK__:(.*)$/)
  if (okM) { resultBox.ok = true; resultBox.message = okM[1] || '发布成功'; return null }
  const failM = line.match(/^__DEPLOY_FAIL__:(.*)$/)
  if (failM) { resultBox.ok = false; resultBox.message = failM[1] || '发布失败'; resultBox.rolledBack = /已自动回滚到/.test(resultBox.message); return null }
  return line
}

/** 将脚本原始输出按行分流：控制标记解析 + 带等级的日志行 */
function pipeScriptOutput(chunk, tracker, resultBox, log) {
  for (const raw of String(chunk).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    const display = parseMarker(line, tracker, resultBox, log)
    if (display === null) continue
    let level = 'info'
    if (/^\[ERROR\]/.test(display)) level = 'error'
    else if (/^\[WARN\]/.test(display)) level = 'warn'
    else if (/^\[OK\]/.test(display)) level = 'success'
    log(level, display)
  }
}

/** SSH 数据包不等于完整行，分别缓冲两条流，避免结果标记被拆开后漏报。 */
async function execDeployScript(conn, command, tracker, resultBox, log) {
  const pending = { stdout: '', stderr: '' }
  const result = await ssh.exec(conn, command, (chunk, stream = 'stdout') => {
    pending[stream] += String(chunk)
    const end = pending[stream].lastIndexOf('\n')
    if (end < 0) return
    pipeScriptOutput(pending[stream].slice(0, end + 1), tracker, resultBox, log)
    pending[stream] = pending[stream].slice(end + 1)
  })
  for (const tail of Object.values(pending)) if (tail) pipeScriptOutput(tail, tracker, resultBox, log)
  return result
}

/** 读取随应用分发的 deploy.sh 内容（强制 LF：git autocrlf 可能把工作区文件
 *  检出为 CRLF，Linux bash 遇 \r 会直接语法错误，上传前必须规范化） */
function readDeployScript() {
  return fs.readFileSync(DEPLOY_SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n')
}

/** 自动探测结果与用户配置分开保存；服务器复用不改变项目的发布策略。 */
function healthFor(project, target) {
  if (project.deployMode === 'auto' && target.health?.strategy !== 'manual') {
    return target.autoHealth || target.health || {}
  }
  return target.health || {}
}

/** 数据库归属与服务器连接分离；自动识别结果不会覆盖手动配置或关闭选择。 */
function databaseFor(project, target) {
  if (project.deployMode === 'auto') {
    if (target.db?.strategy === 'off') return { enabled: false }
    if (target.db?.strategy !== 'manual') return target.autoDb || { enabled: false }
  }
  return target.db || {}
}

/** 拼装 deploy.sh 参数（服务器目录结构方案 §8：home 下 releases/uploads/backups/shared/deployer） */
function buildDeployArgs(project, target, pack, version) {
  const d = project.deploy || {}
  // 数据库备份配置按环境存放：同一项目发布到测试/生产时用的是各自的库
  const db = databaseFor(project, target)
  const h = healthFor(project, target)
  const mode = deployModeOf(project)
  const args = [
    'deploy',
    '--mode', mode,
    '--app', project.name,
    '--home', target.remotePath,
    '--package', pack.fileName,
    '--sha256', pack.sha256,
    '--version', version,
  ]
  if (project.releaseId) args.push('--release-id', project.releaseId)
  if (pack.dataSyncScript) args.push('--data-sync-script', pack.dataSyncScript)
  if (target.openclaw?.enabled) args.push('--openclaw-sync')
  if (project.composeProjectName) args.push('--project-name', project.composeProjectName)
  if (mode === 'docker') {
    args.push('--compose', resolveCompose(project).file)
  } else {
    const sm = project.scriptMode || {}
    args.push('--upgrade-script', sm.upgradeScript || 'upgrade.sh')
    args.push(sm.bootstrapJava ? '--bootstrap-java' : '--no-bootstrap-java')
    args.push(sm.bootstrapPgdump ? '--bootstrap-pgdump' : '--no-bootstrap-pgdump')
  }
  args.push(d.backupCode ? '--backup-code' : '--no-backup-code')
  if (db.enabled) {
    args.push('--backup-db', '--db-type', db.type || 'postgres')
    if (db.service) args.push('--db-service', db.service)
    else args.push('--db-container', db.container || '', '--db-name', db.name || '', '--db-user', db.user || '')
  } else {
    args.push('--no-backup-db')
  }
  args.push(d.autoRollback ? '--auto-rollback' : '--no-auto-rollback')
  if (h.enabled && h.url) {
    args.push('--health-url', h.url, '--health-timeout', String(h.timeout || 90), '--health-interval', String(h.interval || 3))
  } else {
    args.push('--no-health')
  }
  args.push('--keep-releases', String(d.keepReleases ?? 10), '--keep-backups', String(d.keepBackups ?? 10))
  args.push(d.deleteUploadAfterSuccess ? '--delete-upload' : '--keep-upload')
  // 多环境项目留存原始发布包：环境同步据此把已验证的版本原样搬到其他环境
  if (keepsReleasePackage(project)) args.push('--keep-package')
  return args
}

function quoteArg(v) {
  // 单引号包裹，内部单引号转义，防止服务器端命令注入
  return `'${String(v).replace(/'/g, `'\\''`)}'`
}

/** 版本号安全字符（进入服务器端 releases/ 路径与 rm -rf，拒绝路径注入） */
function safeVersion(v) {
  return /^[\w][\w.+~-]*$/.test(String(v)) && String(v).length <= 64
}

/** 生成完整版本号：手动优先，否则自动检测 */
function resolveVersion(project) {
  if (project.version && project.version.strategy === 'manual' && project.version.manual) {
    const manual = String(project.version.manual).trim()
    if (!safeVersion(manual)) return { version: '', source: '' }
    return { version: manual, source: '手动输入' }
  }
  const det = detectVersion(project.localPath)
  if (det.version && safeVersion(det.version)) return det
  return { version: '', source: '' }
}

/** Compose 常见命名（Docker Compose V2 官方首选 compose.yaml） */
const COMPOSE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']

/**
 * 解析实际使用的 compose 文件（docker 形态）：
 * 配置的文件存在则原样使用；否则在项目根按常见命名自动回退（如项目用 compose.yaml）。
 * 返回 { file, fallback }；都不存在时返回配置值（由前置检查报错）。
 */
function resolveCompose(project) {
  if (project.deployMode === 'auto') return { file: automatic.COMPOSE, fallback: false }
  const configured = String(project.composeFile || 'docker-compose.yml').trim() || 'docker-compose.yml'
  const root = project.localPath
  if (!root || !fs.existsSync(root)) return { file: configured, fallback: false }
  if (fs.existsSync(path.join(root, configured))) return { file: configured, fallback: false }
  // 配置的是子目录路径（如 deploy/xxx.yml）时不做根目录回退，避免解析到错误文件
  if (configured.includes('/')) return { file: configured, fallback: false }
  const hit = COMPOSE_CANDIDATES.find((c) => c !== configured && fs.existsSync(path.join(root, c)))
  return hit ? { file: hit, fallback: true } : { file: configured, fallback: false }
}

/** 脚本部署支持的发布包扩展名（V2 tar.gz 优先） */
const ARTIFACT_EXTS = ['.tar.gz', '.tgz', '.zip']

/**
 * 解析脚本部署产物（script 形态）：在 artifactDir 中选「文件名含当前版本」的最新发布包。
 * 版本不匹配的旧包不自动选用——宁可失败也不发布过期产物。
 * 返回 { ok, fileName, filePath, sizeBytes } 或 { ok: false, problem }。
 */
function resolveArtifact(project, version) {
  const sm = project.scriptMode || {}
  const dir = path.resolve(project.localPath, sm.artifactDir || 'release')
  if (!fs.existsSync(dir)) return { ok: false, problem: `产物目录不存在: ${sm.artifactDir || 'release'}（请先执行项目打包）` }
  if (!fs.statSync(dir).isDirectory()) return { ok: false, problem: `产物目录不是文件夹: ${sm.artifactDir || 'release'}` }
  let files = []
  try {
    const visit = (folder, depth) => {
      for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
        const fp = path.join(folder, e.name)
        if (e.isDirectory() && depth < 2) visit(fp, depth + 1)
        else if (e.isFile() && ARTIFACT_EXTS.some((ext) => e.name.toLowerCase().endsWith(ext))) files.push({ fileName: e.name, filePath: fp, mtime: fs.statSync(fp).mtimeMs })
      }
    }
    visit(dir, 0)
  } catch { /* 目录不可读，按空处理 */ }
  if (!files.length) return { ok: false, problem: `产物目录 ${sm.artifactDir || 'release'} 中没有发布包（支持 ${ARTIFACT_EXTS.join(' / ')}）` }
  const escaped = String(version || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const versionPattern = new RegExp(`(?:^|[-_])v?${escaped}(?=$|[-_]|\\.(?:tar\\.gz|tgz|zip)$)`)
  const matched = files.filter((f) => version && versionPattern.test(f.fileName)).sort((a, b) => b.mtime - a.mtime)
  if (!matched.length) {
    const newest = [...files].sort((a, b) => b.mtime - a.mtime)[0].fileName
    return { ok: false, problem: `产物目录中没有文件名含版本 ${version} 的发布包（最新为 ${newest}），请先重新打包` }
  }
  const best = matched[0]
  return { ok: true, fileName: best.fileName, filePath: best.filePath, sizeBytes: fs.statSync(best.filePath).size }
}

/** 文件 SHA256（流式读取，发布包可达数百 MB） */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(filePath)
    s.on('error', reject)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/** 发布包文件名对应的 release 目录名（去扩展名；包内顶层目录与文件同名的约定） */
function releaseDirNameOf(fileName) {
  return String(fileName).replace(/\.(tar\.gz|tgz|zip)$/i, '')
}

/** 项目部署形态（缺省 docker，向后兼容旧配置） */
function deployModeOf(project) {
  return project.deployMode === 'script' ? 'script' : 'docker'
}

/** 配置了两个及以上环境的项目发布后留存原始发布包（服务器 releases/.packages/），供环境同步原样搬运 */
function keepsReleasePackage(project) {
  return (Array.isArray(project.targets) ? project.targets : []).filter((t) => t && t.server && t.server.host).length >= 2
}

/** 终止进程树：Windows 下 child.kill() 不杀子进程（mvn→java / npm→node），用 taskkill */
function killTree(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* noop */ }
  } else {
    try { child.kill('SIGTERM') } catch { /* noop */ }
  }
}

/**
 * 自动打包前同步项目版本号：手动指定的发布版本与项目版本文件不一致时，
 * 把项目内解析值等于旧版本的版本声明改写为发布版本——package.sh 等打包脚本
 * 读的是项目内版本号，不同步则产物永远落后于发布版本、匹配必然失败。
 * 自动识别版本即来自项目文件，天然一致，无需同步。返回日志文本（无需同步时为空）。
 * 版本推进的另一半在发布成功后（syncBackAfterRelease）：只有发布真正成功才写回源项目。
 */
function syncProjectVersionForPackage(project, ver) {
  if (ver.source !== '手动输入') return ''
  const cur = detectVersion(project.localPath)
  if (!cur.version || cur.version === ver.version) return ''
  if ((project.scriptMode || {}).autoBumpVersion === false) {
    return `项目版本文件为 ${cur.version}（${cur.source}），与发布版本 ${ver.version} 不一致且未开启自动同步，打包产物可能不含目标版本`
  }
  const changed = bumpVersionFiles(project.localPath, cur.version, ver.version)
  if (!changed.length) {
    return `项目版本文件为 ${cur.version}（${cur.source}），与发布版本 ${ver.version} 不一致，且未能自动同步版本文件；打包产物可能不含目标版本`
  }
  return `已将项目版本 ${cur.version} → ${ver.version}（同步 ${changed.join('、')}；仅修改本次构建副本）`
}

/**
 * 发布成功后把源项目版本文件写回发布版本：打包阶段的同步只发生在临时构建副本，
 * 源项目不跟上则版本文件永远停在旧值（如一直 1.0.5 起步）。只在全部发布步骤成功
 * 且未回滚时推进——失败/回滚/取消不留半改状态；不自动提交，工作区改动随用户下次提交。
 * 返回日志文本（无需写回时为空，发布结果不受写回成败影响）。
 */
function syncBackAfterRelease(project, ver) {
  if (ver.source !== '手动输入') return ''
  if ((project.scriptMode || {}).autoBumpVersion === false) return ''
  const back = syncBackVersion(project.localPath, ver.version)
  if (!back.version || back.version === ver.version) return ''
  if (!back.changed.length) {
    return `源项目版本仍为 ${back.version}，与发布版本 ${ver.version} 不一致且未能写回版本文件`
  }
  return `已将源项目版本 ${back.version} → ${ver.version}（同步 ${back.changed.join('、')}；不自动提交，随下次代码提交入库）`
}

/**
 * 打包前补齐发布说明文件：部分项目的打包脚本要求发布说明随版本提供
 * （如 Vantage 的 package.sh：docs/release-notes-<版本>.md 缺失即中止打包）。
 * 项目遵循该约定而目标版本文件缺失时，依据本次发布采集到的提交自动生成初稿，
 * 让「版本升级 → 打包」在工具内闭环，不必先回项目手工准备。返回日志文本（无需生成时为空）。
 */
function ensureReleaseNotesForPackage(project, ver, gitInfo) {
  if ((project.scriptMode || {}).autoReleaseNotes === false) return ''
  const ok = !!(gitInfo && gitInfo.ok && gitInfo.info)
  const commits = ok && Array.isArray(gitInfo.info.commits) ? gitInfo.info.commits : []
  const anchorLabel = ok ? gitInfo.info.anchorLabel : ''
  const r = releaseNotes.ensureNotesFile(project.localPath, ver.version, {
    appName: project.name, anchorLabel, commits,
  })
  if (!r.convention) return ''
  if (r.error) return `发布说明初稿生成失败：${r.error}（打包脚本可能因缺文件中止，可手工补写后重试）`
  if (!r.wrote) return ''
  return `已生成发布说明 ${r.file}（依据 ${commits.length} 条提交自动整理的初稿${anchorLabel ? `，${anchorLabel}` : ''}；仅写入本次构建副本）`
}

/**
 * Windows：定位 Git Bash 的 bin 目录。应用的进程 PATH 通常只有 Git\cmd（不含 bash.exe），
 * 裸 bash 命令会命中 System32 的 WSL bash——WSL 里跑不了 Windows 的打包工具链
 * （如 uv/maven，bash 的 exec 也不解析 .exe 后缀）。返回 null 表示未装 Git。
 */
function findGitBashDir(baseEnv = process.env) {
  if (process.platform !== 'win32') return null
  const roots = []
  for (const raw of String(envValue(baseEnv, 'Path') || '').split(';')) {
    const dir = raw.trim().replace(/[\\/]+$/, '')
    if (/[\\/]cmd$/i.test(dir)) roots.push(dir.slice(0, -4))
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const base = envValue(baseEnv, key)
    if (base) roots.push(key === 'LOCALAPPDATA' ? path.join(base, 'Programs', 'Git') : path.join(base, 'Git'))
  }
  for (const root of roots) {
    if (fs.existsSync(path.join(root, 'bin', 'bash.exe'))) {
      return path.join(root, 'bin')
    }
  }
  return null
}

/** Windows 环境键忽略大小写，避免同时生成 Path/PATH 后被 spawn 丢弃其中一个。 */
function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

/** 只读当前持久构建配置；桌面应用可能早于 Maven 安装启动，不能只依赖旧 process.env。 */
function readWindowsBuildEnv(baseEnv) {
  const systemRoot = envValue(baseEnv, 'SystemRoot') || 'C:/Windows'
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$snapshot = @{}
foreach ($scope in @('Machine', 'User')) {
  $key = if ($scope -eq 'Machine') {
    [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')
  } else { [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment') }
  $values = @{}
  try {
    if ($key) { foreach ($name in @('Path', 'JAVA_HOME', 'MAVEN_HOME', 'M2_HOME')) {
      $value = $key.GetValue($name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($value -is [string]) { $values[$name] = $value }
    } }
  } finally { if ($key) { $key.Dispose() } }
  $snapshot[$scope] = $values
}
$snapshot | ConvertTo-Json -Compress
`
  try {
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    })
    if (result.status === 0) return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ''))
  } catch { /* 无法读取时沿用继承配置，不阻断其他工具链。 */ }
  return {}
}

/** 只为本次打包补齐工具链与 Git Bash；有效继承 HOME 优先，当前持久 PATH 追加。 */
function localShellEnv(baseEnv, configuredEnv) {
  const env = { ...(baseEnv || process.env) }
  if (process.platform !== 'win32') return env
  const current = configuredEnv || readWindowsBuildEnv(env)
  const machine = current.Machine || {}
  const user = current.User || {}
  const variables = Object.fromEntries([machine, user, env].flatMap((source) =>
    Object.entries(source).map(([name, value]) => [name.toLowerCase(), value])))
  const expand = (value) => {
    let result = String(value || '').trim().replace(/^"(.*)"$/, '$1')
    for (let i = 0; i < 5; i++) {
      const next = result.replace(/%([^%]+)%/g, (match, name) => envValue(variables, name) || match)
      if (next === result) break
      result = next
    }
    return result
  }
  const toolDirs = []
  for (const name of ['JAVA_HOME', 'MAVEN_HOME', 'M2_HOME']) {
    const entry = name === 'JAVA_HOME' ? 'java.exe' : 'mvn'
    for (const source of [env, user, machine]) {
      const home = expand(envValue(source, name))
      if (!home || !fs.existsSync(path.join(home, 'bin', entry))) continue
      for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key]
      env[name] = home
      for (const key of Object.keys(variables)) if (key.toUpperCase() === name) delete variables[key]
      variables[name] = home
      toolDirs.push(path.join(home, 'bin'))
      break
    }
  }
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path')
  const pathKey = pathKeys[0] || 'Path'
  const inherited = pathKeys.flatMap((key) => String(env[key] || '').split(';'))
  const dirs = [...toolDirs, ...inherited, ...String(envValue(machine, 'Path') || '').split(';'),
    ...String(envValue(user, 'Path') || '').split(';')].map(expand).filter(Boolean)
  for (const key of pathKeys) delete env[key]
  env[pathKey] = dirs.join(';')
  const bashDir = findGitBashDir(env)
  const seen = new Set()
  env[pathKey] = [...(bashDir ? [bashDir] : []), ...dirs].filter((dir) => {
    const normalized = path.normalize(dir).replace(/[\\/]$/, '').toLowerCase()
    if (seen.has(normalized)) return false
    seen.add(normalized)
    return true
  }).join(';')
  return env
}

/**
 * 执行项目打包命令（script 形态产物缺失时自动构建）：
 * 在项目根以 shell 运行 packageCommand，输出按行流到发布日志（[打包] 前缀）；
 * sourceDir 为源项目根（在构建副本里执行时与 cwd 不同），经
 * PLM_SOURCE_PROJECT_DIR 传给打包命令，供其定位源项目伴生资源（如仓库旁的 .tools）；
 * 超时杀整棵进程树；用户取消时同样终止。返回 { ok, problem? }。
 */
function runPackageCommand(project, sourceDir, operation) {
  const log = operation?.log || emitStandaloneLog
  const isCanceled = () => operation?.controller.signal.aborted
  const sm = project.scriptMode || {}
  const cmd = String(sm.packageCommand || '').trim()
  const timeoutMs = Math.max(30, Number(sm.packageTimeoutSec) || 900) * 1000
  const baseEnv = sourceDir && sourceDir !== project.localPath
    ? { ...process.env, PLM_SOURCE_PROJECT_DIR: sourceDir }
    : process.env
  return new Promise((resolve) => {
    let child
    let tempWorkspace
    const cleanupTemp = () => {
      try { workspace.removeBuildWorkspace(tempWorkspace) } catch (e) {
        log('warn', `打包临时目录清理失败：${e.message || e}`)
      }
    }
    try {
      const env = localShellEnv(baseEnv)
      if (process.platform === 'win32') {
        // JDK 默认套接字目录来自 TEMP；仅迁移构建副本无法覆盖未显式配置的项目。
        tempWorkspace = workspace.createBuildWorkspace()
        for (const key of Object.keys(env)) {
          if (/^(temp|tmp)$/i.test(key)) delete env[key]
        }
        env.TEMP = tempWorkspace.dir
        env.TMP = tempWorkspace.dir
      }
      child = spawn(cmd, { shell: true, cwd: project.localPath, env, windowsHide: true })
    } catch (e) {
      cleanupTemp()
      return resolve({ ok: false, problem: `打包命令无法启动: ${(e && e.message) || e}` })
    }
    if (operation) operation.pkgChild = child
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (operation?.pkgChild === child) operation.pkgChild = null
      resolve(r)
    }
    const timer = setTimeout(() => {
      log('error', `打包超时（>${timeoutMs / 1000}s），终止进程树……`)
      killTree(child)
      finish({ ok: false, problem: `打包命令超时（>${Math.round(timeoutMs / 1000)} 秒）已终止，可调整超时或检查构建环境` })
    }, timeoutMs)
    // 按字节缓冲完整行，避免多字节字符跨数据块丢失；Windows 工具链兼容 GBK 输出。
    const utf8 = new TextDecoder('utf-8', { fatal: true })
    const legacy = process.platform === 'win32' ? new TextDecoder('gb18030') : null
    const decode = (bytes) => {
      try { return utf8.decode(bytes) } catch { return legacy ? legacy.decode(bytes) : bytes.toString('utf8') }
    }
    const writeLine = (bytes) => {
      const line = decode(bytes).replace(/\s+$/, '')
      if (line.trim()) log('info', `[打包] ${line.slice(0, 500)}`)
    }
    const pending = { out: Buffer.alloc(0), err: Buffer.alloc(0) }
    const pump = (key, chunk) => {
      if (isCanceled()) { killTree(child); return }
      const bytes = Buffer.concat([pending[key], chunk])
      let start = 0
      let end
      while ((end = bytes.indexOf(10, start)) !== -1) {
        writeLine(bytes.subarray(start, end))
        start = end + 1
      }
      pending[key] = bytes.subarray(start)
    }
    child.stdout.on('data', (c) => pump('out', c))
    child.stderr.on('data', (c) => pump('err', c))
    child.on('error', (e) => finish({ ok: false, problem: `打包命令执行失败: ${(e && e.message) || e}` }))
    child.on('close', (code) => {
      // 超时/取消时等子进程真正退出后清理，避免删除仍在使用的临时文件。
      cleanupTemp()
      for (const key of ['out', 'err']) {
        if (pending[key].length) writeLine(pending[key])
      }
      if (isCanceled()) return finish({ ok: false, problem: '打包已取消' })
      if (code === 0) {
        log('success', '打包命令执行完成')
        return finish({ ok: true })
      }
      finish({ ok: false, problem: `打包命令退出码 ${code}（详见上方 [打包] 日志）` })
    })
  })
}

/**
 * 执行发布副本准备命令（docker 形态、开启凭证校验且未发现匹配副本时）：
 * 在项目根运行，{version} 占位符替换为本次发布版本。命令由项目方提供
 * （把发布链的 prepare 参数化成稳定脚本），产出 output/<发布目录>/source/release-evidence.json。
 * 进程管理与打包命令一致：超时杀进程树、取消终止、行缓冲与 GBK 兼容日志。
 */
function runReleasePrepare(project, ver, operation) {
  const log = operation?.log || emitStandaloneLog
  const isCanceled = () => operation?.controller.signal.aborted
  const docker = project.docker || {}
  const cmd = String(docker.prepareCommand || '').trim().replaceAll('{version}', ver.version)
  const timeoutMs = Math.max(30, Number(docker.prepareTimeoutSec) || 900) * 1000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, { shell: true, cwd: project.localPath, env: localShellEnv(process.env), windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, problem: `准备命令无法启动: ${(e && e.message) || e}` })
    }
    if (operation) operation.pkgChild = child
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (operation?.pkgChild === child) operation.pkgChild = null
      resolve(r)
    }
    const timer = setTimeout(() => {
      log('error', `准备命令超时（>${timeoutMs / 1000}s），终止进程树……`)
      killTree(child)
      finish({ ok: false, problem: `准备命令超时（>${Math.round(timeoutMs / 1000)} 秒）已终止，可调整超时或检查准备脚本` })
    }, timeoutMs)
    // 按字节缓冲完整行，避免多字节字符跨数据块丢失；Windows 工具链兼容 GBK 输出。
    const utf8 = new TextDecoder('utf-8', { fatal: true })
    const legacy = process.platform === 'win32' ? new TextDecoder('gb18030') : null
    const decode = (bytes) => {
      try { return utf8.decode(bytes) } catch { return legacy ? legacy.decode(bytes) : bytes.toString('utf8') }
    }
    const writeLine = (bytes) => {
      const line = decode(bytes).replace(/\s+$/, '')
      if (line.trim()) log('info', `[发布副本] ${line.slice(0, 500)}`)
    }
    const pending = { out: Buffer.alloc(0), err: Buffer.alloc(0) }
    const pump = (key, chunk) => {
      if (isCanceled()) { killTree(child); return }
      const bytes = Buffer.concat([pending[key], chunk])
      let start = 0
      let end
      while ((end = bytes.indexOf(10, start)) !== -1) {
        writeLine(bytes.subarray(start, end))
        start = end + 1
      }
      pending[key] = bytes.subarray(start)
    }
    child.stdout.on('data', (c) => pump('out', c))
    child.stderr.on('data', (c) => pump('err', c))
    child.on('error', (e) => finish({ ok: false, problem: `准备命令执行失败: ${(e && e.message) || e}` }))
    child.on('close', (code) => {
      for (const key of ['out', 'err']) {
        if (pending[key].length) writeLine(pending[key])
      }
      if (isCanceled()) return finish({ ok: false, problem: '准备命令已取消' })
      if (code === 0) {
        log('success', '准备命令执行完成')
        return finish({ ok: true })
      }
      finish({ ok: false, problem: `准备命令退出码 ${code}（详见上方 [发布副本] 日志）` })
    })
  })
}

/** 发布前本地检查（方案 §23 的关键项；按部署形态分别校验） */
function preCheckLocal(project, target, version, autoMode = false) {
  const problems = []
  if (!project.name) problems.push('缺少项目名称')
  if (!project.localPath || !fs.existsSync(project.localPath)) problems.push(`本地项目目录不存在: ${project.localPath}`)
  else if (!autoMode && deployModeOf(project) === 'docker') {
    const rc = resolveCompose(project)
    if (!fs.existsSync(path.join(project.localPath, rc.file))) {
      problems.push(`Docker Compose 文件不存在: ${rc.file}（已尝试 ${COMPOSE_CANDIDATES.join(' / ')}），可在部署设置改用脚本部署形态`)
    }
  }
  if (!version) problems.push('未识别到版本号（可改用手动输入）')
  // 数据库备份参数缺失在客户端就拦截：否则要等发布到服务器备份阶段才失败
  const db = databaseFor(project, target)
  if (db.enabled) {
    if (!db.service && (!String(db.container || '').trim() || !String(db.name || '').trim())) {
      problems.push(`[${target.name}] 已启用「发布前备份数据库」但未配置数据库容器名或库名（部署设置 → 数据库备份中补全）`)
    }
  }
  const health = healthFor(project, target)
  if (health.enabled && project.deployMode === 'auto' && target.health?.strategy === 'manual') {
    if (!/^https?:\/\/[^\s]+$/i.test(String(health.url || '').trim())) {
      problems.push(`[${target.name}] 请填写本项目有效的 HTTP 健康检查地址，或使用自动识别/关闭 HTTP 检查`)
    }
  }
  const s = target.server || {}
  if (!s.host) problems.push(`[${target.name}] 未配置服务器地址`)
  if (!target.remotePath) problems.push(`[${target.name}] 未配置远程部署目录`)
  if (s.authType === 'key' && (!s.keyPath || !fs.existsSync(s.keyPath))) problems.push(`[${target.name}] SSH 私钥文件不存在: ${s.keyPath}`)
  return problems
}

/** 发布副本的凭证文件名（项目自有 prepare→deploy 发布链的契约） */
const RELEASE_EVIDENCE_FILE = 'release-evidence.json'

function readEvidence(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, RELEASE_EVIDENCE_FILE), 'utf8')) } catch { return null }
}

/**
 * 发现可用的发布副本（发布链 prepare 产出到 output/<发布目录>/source）：
 * 发布目录根已带匹配凭证（发布链 deploy.cjs 的调用形态）时无需查找；否则在
 * 各发布目录的 source 下取凭证版本等于发布版本的最新一份。返回 { dir, rel } 或 null。
 */
function findReleaseCopy(project, ver) {
  if (!ver.version || project.docker?.requireReleaseEvidence !== true) return null
  const root = project.localPath
  if (!root || !fs.existsSync(root)) return null
  const rootEvidence = readEvidence(root)
  if (rootEvidence && rootEvidence.version === ver.version) return null
  const outputDir = path.join(root, 'output')
  let names = []
  try { names = fs.readdirSync(outputDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return null }
  let best = null
  for (const name of names) {
    const dir = path.join(outputDir, name, 'source')
    const evidence = readEvidence(dir)
    if (!evidence || evidence.version !== ver.version) continue
    const stamp = String(evidence.preparedAt || '')
    if (!best || stamp > best.stamp) best = { dir, rel: `output/${name}/source`, stamp }
  }
  return best ? { dir: best.dir, rel: best.rel } : null
}

/**
 * 发布内容门禁（docker 形态，check 阶段、连服务器之前执行）：
 * 上传内容自带的版本声明必须与发布版本一致，开启凭证校验的项目只允许
 * 上传发布链产出的发布副本，避免工作区快照带着陈旧版本号被打成「成功」发布。
 */
function releaseContentProblems(project, ver) {
  const problems = []
  if (!ver.version) return problems
  const root = project.localPath
  if (!root || !fs.existsSync(root)) return problems // 目录缺失由 preCheckLocal 先报错
  // 发布副本凭证：开启后发布目录根必须含 release-evidence.json 且版本一致，
  // 拒绝工作区目录直传（凭证问题放最前，作为此类项目的主指引）
  let evidenceBlocked = false
  if (project.docker?.requireReleaseEvidence) {
    const evidence = readEvidence(root)
    if (!evidence || evidence.version !== ver.version) {
      evidenceBlocked = true
      const found = evidence?.version ? `凭证版本为 ${evidence.version}` : '缺少可用的 release-evidence.json'
      problems.push(`已启用发布副本凭证校验：${found}，与发布版本 ${ver.version} 不符；请先运行项目发布链的 prepare 生成该版本的发布副本（output/<发布目录>/source），不要直接发布工作区目录`)
    }
  }
  // 手动版本与项目内版本声明错位：auto 策略的版本本就取自同一目录，天然一致。
  // 凭证项目已被拦下时不再叠加此检查——其版本由发布副本的凭证保证，
  // 此时提示「对齐项目版本文件」会诱导手改工作区（1.1.57 事故的成因）
  if (!evidenceBlocked && project.version?.strategy === 'manual') {
    const det = detectVersion(root)
    if (det.version && det.version !== ver.version) {
      problems.push(`项目版本声明为 ${det.version}（${det.source}），与发布版本 ${ver.version} 不一致；请先对齐项目版本文件，或改用自动识别版本`)
    }
  }
  return problems
}

/** 从项目取部署目标（targetId 省略时用第一个目标） */
function getTarget(project, targetId) {
  const targets = Array.isArray(project.targets) ? project.targets : []
  return targetId ? targets.find((t) => t.id === targetId) : targets.find((t) => t.id === project.productionTargetId) || targets[0]
}

/** 解析目标的数据同步配置（缺省关闭） */
function getDataSync(target) {
  const s = (target && target.dataSync) || {}
  return {
    enabled: s.enabled === true,
    localDir: String(s.localDir || 'data').trim(),
    remoteDir: String(s.remoteDir || 'shared/data').trim(),
  }
}

/**
 * 校验数据同步配置与本地数据目录。
 * 返回 { ok, sourceDir, problem }：ok=false 时 problem 为用户可读原因。
 */
function validateDataSync(project, dataSync) {
  return moduleDataSync.validateDataSync(project, dataSync)
}

/** 服务器端数据同步命令：建目录 → 解压覆盖 → 删包（单条命令，任一步失败整体失败） */
function buildDataSyncCommand(dataZipRemote, remoteDestDir, remoteHome) {
  return moduleDataSync.buildDataSyncCommand(dataZipRemote, remoteDestDir, remoteHome)
}

/** 解析目标的数据导入钩子配置（凭据经 getDataSyncCredentials 从原始数据解密，list() 脱敏版不含） */
function getDataImport(projectId, target, targetId) {
  const s = (target && target.dataSync) || {}
  return {
    mode: s.importMode === 'command' ? 'command' : 'none',
    command: String(s.importCommand || ''),
    user: String(s.importUser || ''),
    secret: projectId ? projects.getDataSyncCredentials(projectId, targetId) : '',
  }
}

/**
 * 展开导入命令占位符：{dataDir}=远端数据目录 {user}/{secret}=应用账号凭据。
 * 替换值按 POSIX 单引号规则转义，防止凭据/路径中的特殊字符破坏命令结构。
 */
function renderImportCommand(command, { dataDir, user, secret }) {
  const shQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`
  return String(command || '')
    .replaceAll('{dataDir}', shQuote(dataDir))
    .replaceAll('{user}', shQuote(user))
    .replaceAll('{secret}', shQuote(secret))
}

function run(projectId, targetId, requestId, releasePlan) {
  const version = releasePlan?.versionOverride || releasePlan?.expectedVersion || ''
  return withRun(projectId, targetId, 'deploy', runDeployment, { requestId, version, releasePlan })
}

async function runDeployment(operation) {
  const { project, target, record, tracker, log, publish, finish, controller, releasePlan, id: runId } = operation
  const { projectId } = record
  const isCanceled = () => controller.signal.aborted
  const creds = projects.getCredentials(projectId, target.id) || { password: '', passphrase: '' }
  const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
  let conn = null
  let pack = null
  let dataPack = null
  let prepared = null
  let buildWorkspace = null
  let autoMode = project.deployMode === 'auto'
  const setC = (c) => {
    conn = operation.conn = c
    if (isCanceled()) throw new Error('发布已取消')
  }

  try {
    // ── 阶段 1：本地检查 ─────────────────────────────
    tracker.begin('check')
    const t0 = Date.now()
    if (isCanceled()) return finish('canceled', '任务尚未执行')
    if (releasePlan?.versionOverride) {
      const version = { strategy: 'manual', manual: releasePlan.versionOverride }
      const saved = projects.save({ id: projectId, version })
      if (!saved?.ok) throw new Error(saved?.error || '发布版本保存失败')
      project.version = version
      record.requestedVersion = version.manual
      log('info', `本次发布版本已设置为 ${version.manual}`)
    }
    // 极简配置：发布前按项目自动生成部署配置。用户输入的三项（服务器选择、服务器项目
    // 地址、是否同步本地数据）不被动；部署形态/脚本参数/健康检查/数据库备份/同步明细
    // 每次发布重新生成，保证不同项目、以及同一项目演进后的配置始终贴合实际。
    if (project.configMode === 'quick') {
      const gen = await aiDeploy.generateQuickConfig(projectId, target.id, { log })
      if (!gen.ok) {
        log('error', gen.error)
        tracker.end('check', 'failed', t0)
        return finish('failed', gen.error)
      }
      Object.assign(project, gen.project)
      const freshTarget = (gen.project.targets || []).find((t) => t.id === target.id) || (gen.project.targets || [])[0]
      if (freshTarget) Object.assign(target, freshTarget)
      autoMode = project.deployMode === 'auto'
    }
    let ver = resolveVersion(project)
    if (releasePlan?.expectedVersion && ver.version !== releasePlan.expectedVersion) {
      throw new Error(`发布版本已变化（确认 ${releasePlan.expectedVersion}，当前 ${ver.version || '未识别'}），请重新确认`)
    }
    if (autoMode) {
      if (!target.server?.host) throw new Error('请先设置正式服务器地址与登录凭据')
      if (!fs.existsSync(project.localPath)) throw new Error('本地项目目录不存在')
      if (!ver.version) ver = { version: new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14), source: '自动发布编号' }
      project.releaseId = `${ver.version}-${runId}`
      setC(await ssh.connect({ ...target.server, password: creds.password, passphrase: creds.passphrase }))
      prepared = await automatic.prepare(project, target, { conn, uploadText: uploadTextFile, log, signal: controller.signal, releaseId: project.releaseId })
      operation.redact = prepared.redact
      if (isCanceled()) throw new Error('发布已取消')
      target.remotePath = prepared.remotePath
      target.autoHealth = prepared.health
      target.autoDb = prepared.db
      if (target.db?.strategy !== 'manual' && target.db?.strategy !== 'off' && prepared.db?.reason) log('info', prepared.db.reason)
      target.autoSudo = prepared.sudo
      project.composeProjectName = automatic.identity(project, target.id)
      project.composeFile = automatic.COMPOSE
      record.remotePath = target.remotePath
      record.releaseId = project.releaseId
      record.serviceUrl = `http://${target.server.host.includes(':') ? '[' + target.server.host + ']' : target.server.host}:${prepared.port}`
      // 保存解析后的归属与健康检查，供查询与回滚复用；不保存生成文件或运行密钥。
      projects.save(project)
    }
    record.version = ver.version
    // 更新内容：采集本次发布包含的 Git 提交（非仓库/无提交时静默跳过，绝不因此中断发布）
    const anchor = releaseNotes.anchorFromRecords(history.list(project.id), project.id, target.id)
    const gitInfo = await releaseNotes.captureFor(project, { anchor, version: ver.version })
    if (gitInfo.ok) {
      Object.assign(record, gitInfo.fields)
      const scope = gitInfo.info.anchorLabel || ''
      log('info', `本次更新内容：${gitInfo.info.commits.length} 条提交${scope ? `（${scope}）` : ''}`)
    }
    const mode = deployModeOf(project)
    const problems = preCheckLocal(project, target, ver.version, autoMode)
    if (mode === 'docker' && !autoMode) {
      // 发布链 prepare 产出的发布副本就绪时自动改用该副本：工具只做传输，内容以副本为准，
      // 工作区保持不动（与发布链 deploy.cjs 覆盖 localPath 的调用方式等价）。
      // 未就绪且配置了准备命令时先执行它生成副本——一键发布不需要去别处跑 prepare
      let copy = findReleaseCopy(project, ver)
      if (!copy && project.docker?.requireReleaseEvidence && String(project.docker?.prepareCommand || '').trim()) {
        log('info', `未发现版本 ${ver.version} 的发布副本，执行准备命令生成……`)
        const prep = await runReleasePrepare(project, ver, operation)
        if (!prep.ok) {
          log('error', prep.problem)
          tracker.end('check', 'failed', t0)
          return finish('failed', prep.problem)
        }
        copy = findReleaseCopy(project, ver)
        if (!copy) {
          const msg = `准备命令执行完成，但未生成版本 ${ver.version} 的发布副本（output/<发布目录>/source/release-evidence.json）`
          log('error', msg)
          tracker.end('check', 'failed', t0)
          return finish('failed', msg)
        }
      }
      if (copy) {
        log('info', `发现版本 ${ver.version} 的发布副本：${copy.rel}，本次发布该副本（工作区保持不动）`)
        project.localPath = copy.dir
      }
      problems.push(...releaseContentProblems(project, ver))
    }
    if (!autoMode && projects.list().some((p) => p.id !== project.id && p.targets.some((t) => t.server?.host === target.server.host && Number(t.server.port || 22) === Number(target.server.port || 22) && String(t.remotePath).replace(/\/+$/, '') === String(target.remotePath).replace(/\/+$/, '')))) {
      problems.push('该服务器部署目录已被其他项目配置使用，请为当前项目设置独立目录')
    }
    if (mode === 'docker') {
      const rc = resolveCompose(project)
      if (rc.fallback) log('warn', `配置的 Compose 文件不存在，自动改用项目根下的 ${rc.file}`)
    }
    let artifact = null
    if (!problems.length && mode === 'script') {
      artifact = resolveArtifact(project, ver.version)
      // 配置了构建命令时每次重新构建，避免同版本代码改动继续复用旧包。
      if (String(project.scriptMode?.packageCommand || '').trim()) artifact = { ok: false, problem: '按当前代码重新构建发布包' }
      if (!artifact.ok) {
        // 产物缺失/版本不匹配：配置了打包命令则推迟到打包阶段自动构建，否则检查阶段即失败
        if (String((project.scriptMode || {}).packageCommand || '').trim()) {
          log('warn', `产物未就绪（${artifact.problem}），将在打包阶段自动执行打包命令`)
          artifact = null
        } else {
          problems.push(artifact.problem)
        }
      }
    }
    if (problems.length) {
      for (const p of problems) log('error', p)
      tracker.end('check', 'failed', t0)
      return finish('failed', problems[0])
    }
    const openclaw = moduleOpenClaw.prepareOpenClaw(project, target)
    if (openclaw) log('info', `OpenClaw 同步已启用：${openclaw.config.container}，发布包包含已校验的插件与 Skill`)
    // 数据同步前置校验：目录缺失等问题在检查阶段就失败，避免发布到一半才发现
    const dataSyncCfg = getDataSync(target)
    if (dataSyncCfg.enabled) {
      const vds = validateDataSync(project, dataSyncCfg)
      if (!vds.ok) {
        const msg = `[数据同步] ${vds.problem}`
        log('error', msg)
        tracker.end('check', 'failed', t0)
        return finish('failed', msg)
      }
      log('info', `数据同步已启用：${dataSyncCfg.localDir} → ${dataSyncCfg.remoteDir}`)
    }
    log('info', `开始发布 ${project.name} ${ver.version} → ${target.name}（${target.server.host}）`)
    log('success', `项目检查通过（版本来源: ${ver.source}${mode === 'script' ? '，脚本部署形态' : ''}）`)
    tracker.end('check', 'success', t0)

    // ── 阶段 2：生成 ZIP（docker 形态）/ 定位或构建发布包（script 形态） ──
    tracker.begin('package')
    const t1 = Date.now()
    if (mode === 'script') {
      if (!artifact) {
        const command = String(project.scriptMode?.packageCommand || '')
        const entry = command.match(/^\s*(?:bash|sh)\s+["']?([^"'\s]+\.sh)/)
        if (entry && !fs.existsSync(path.resolve(project.localPath, entry[1]))) throw new Error(`打包入口不存在: ${entry[1]}；可切换为自动发布，由程序生成部署方案`)
        buildWorkspace = workspace.createBuildWorkspace()
        log('info', `本次构建工作区：${buildWorkspace.dir}`)
        const copied = await workspace.copyProject(project.localPath, buildWorkspace.dir, { artifactDir: project.scriptMode?.artifactDir, artifactExts: ARTIFACT_EXTS })
        if (copied.skipped.length) {
          const head = copied.skipped.slice(0, 3).join('、')
          log('warn', `已跳过 ${copied.skipped.length} 个本机读不了的条目（WSL 建的符号链接在 Windows 上无法访问）：${head}${copied.skipped.length > 3 ? ' 等' : ''}`)
        }
        if (isCanceled()) throw new Error('发布已取消')
        const buildProject = { ...project, localPath: buildWorkspace.dir }
        const syncNote = syncProjectVersionForPackage(buildProject, ver)
        if (syncNote) log('warn', syncNote)
        const rnNote = ensureReleaseNotesForPackage(buildProject, ver, gitInfo)
        if (rnNote) log('warn', rnNote)
        const pc = await runPackageCommand(buildProject, project.localPath, operation)
        if (!pc.ok) {
          log('error', pc.problem)
          tracker.end('package', 'failed', t1)
          return finish('failed', pc.problem)
        }
        artifact = resolveArtifact(buildProject, ver.version)
        if (!artifact.ok) {
          // 打包成功但版本仍不匹配时，指出项目版本文件与发布版本的偏差，给出可操作方向
          const cur = detectVersion(project.localPath)
          let msg = `打包后仍无匹配产物：${artifact.problem}`
          if (cur.version && cur.version !== ver.version) {
            msg += `；项目版本文件仍为 ${cur.version}（${cur.source}），与发布版本 ${ver.version} 不一致`
          }
          log('error', msg)
          tracker.end('package', 'failed', t1)
          return finish('failed', msg)
        }
      }
      const sizeMb = (artifact.sizeBytes / 1024 / 1024).toFixed(1)
      await validateArtifact(artifact.filePath, project.scriptMode?.upgradeScript || 'upgrade.sh')
      log('info', `计算发布包校验和：${artifact.fileName} ……`)
      pack = {
        fileName: artifact.fileName,
        zipPath: artifact.filePath,
        sizeBytes: artifact.sizeBytes,
        fileCount: 0,
        sha256: await sha256File(artifact.filePath),
        keepLocal: true, // 产物目录是用户的构建结果，发布后不删除
      }
      log('success', `发布包就绪：${artifact.fileName}（${sizeMb} MB）`)
    } else {
      log('info', '正在生成发布包……')
      pack = await packager.buildPackage({
        projectDir: project.localPath,
        appName: project.name,
        version: ver.version,
        onProgress: (count) => publish('deploy:progress', { kind: 'package', count }),
        includeBuild: true,
        files: [...(prepared?.files || []), ...(openclaw?.files || [])],
        safeRoot: autoMode,
        exclude: autoMode ? prepared.exclude : undefined,
      })
      log('success', `ZIP 生成完成：${pack.fileName}（${(pack.sizeBytes / 1024 / 1024).toFixed(1)} MB，${pack.fileCount} 个文件）`)
    }
    if (isCanceled()) throw new Error('发布已取消')
    tracker.end('package', 'success', t1)

    // ── 阶段 3：连接 + 上传 ─────────────────────────
    tracker.begin('upload')
    const t2 = Date.now()
    log('info', `连接服务器 ${target.server.host}:${target.server.port}……`)
    if (!conn) setC(await ssh.connect({
      host: target.server.host,
      port: target.server.port,
      username: target.server.username,
      authType: target.server.authType,
      password: creds.password,
      keyPath: target.server.keyPath,
      passphrase: creds.passphrase,
    }))
    log('success', 'SSH 连接成功')

    const remoteHome = target.remotePath
    let dataZipRemote = ''
    const uploadDataPackage = async () => {
      if (dataZipRemote) return dataZipRemote
      if (isCanceled()) throw new Error('发布已取消')
      const checked = validateDataSync(project, dataSyncCfg)
      if (!checked.ok) throw new Error(checked.problem)
      log('info', `正在打包数据目录 ${dataSyncCfg.localDir} ……`)
      dataPack = await packager.buildDataPackage({ projectDir: project.localPath, dataDir: dataSyncCfg.localDir, appName: project.name, version: ver.version })
      const destination = ssh.remoteJoin(remoteHome, 'uploads', dataPack.fileName)
      await ssh.upload(conn, dataPack.zipPath, destination, (done, total) => {
        publish('deploy:progress', { kind: 'datasync', percent: total ? Math.round((done / total) * 100) : 0 })
      })
      const sum = await ssh.exec(conn, `sha256sum ${quoteArg(destination)} | awk '{print $1}'`)
      if ((sum.stdout || '').trim() !== dataPack.sha256) throw new Error('数据包上传校验失败（SHA256 不一致）')
      dataZipRemote = destination
      return destination
    }
    const prepareStartupSync = async () => {
      if (!autoMode || !dataSyncCfg.enabled || !prepared?.syncBeforeStart) return
      const dataFile = await uploadDataPackage()
      const destination = ssh.remoteJoin(remoteHome, dataSyncCfg.remoteDir)
      pack.dataSyncScript = ssh.remoteJoin(remoteHome, 'deployer', 'data-sync.sh')
      await uploadTextFile(conn, '#!/usr/bin/env bash\n' + buildDataSyncCommand(dataFile, destination, remoteHome) + '\n', pack.dataSyncScript)
      log('info', '本项目数据将在备份和构建通过后、启动新版本前同步')
    }
    if (dataSyncCfg.enabled) {
      const checked = await ssh.exec(conn, moduleDataSync.buildDataSyncPreflightCommand(remoteHome, dataSyncCfg.remoteDir))
      if (checked.code !== 0 || !/__DATA_SYNC_PATH_OK__/.test(checked.stdout || '')) {
        throw new Error(`数据同步目录检查失败：${String(checked.stderr || checked.stdout || '无法确认项目目录归属').trim()}`)
      }
    }
    log('info', '初始化远程目录结构…')
    await ssh.mkdirp(conn, ssh.remoteJoin(remoteHome, 'uploads'))
    await ssh.mkdirp(conn, ssh.remoteJoin(remoteHome, 'deployer'))

    // 上传 deploy.sh（每次覆盖，保证与客户端版本一致）
    const scriptRemote = ssh.remoteJoin(remoteHome, 'deployer', 'deploy.sh')
    log('info', '上传部署脚本…')
    await uploadTextFile(conn, readDeployScript(), scriptRemote)
    log('success', '部署脚本已就绪')

    // 查询当前线上版本（供历史记录与结果展示；docker=current 软链接，script=CURRENT 指针文件）
    const curCmd = mode === 'script'
      ? `cat ${quoteArg(ssh.remoteJoin(remoteHome, 'CURRENT'))} 2>/dev/null`
      : `readlink ${quoteArg(ssh.remoteJoin(remoteHome, 'current'))} 2>/dev/null`
    const cur = await ssh.exec(conn, `${curCmd} || true`)
    resultBox.oldVersion = cur.stdout.trim().split('/').pop() || ''
    record.oldVersion = resultBox.oldVersion
    if (resultBox.oldVersion) log('info', `线上当前版本: ${resultBox.oldVersion}`)

    // 脚本部署：线上已在运行同一发布包时立即终止——项目升级脚本会拒绝重复升级，
    // 且继续执行会在解压阶段删除并覆盖正在运行的 release 目录
    if (mode === 'script' && resultBox.oldVersion === releaseDirNameOf(pack.fileName)) {
      const msg = `线上已运行同一版本（${resultBox.oldVersion}），重复发布同一发布包无意义；请先重新打包生成新时间戳的发布包`
      log('error', msg)
      throw new Error(msg)
    }

    const zipRemote = ssh.remoteJoin(remoteHome, 'uploads', pack.fileName)
    await ssh.upload(conn, pack.zipPath, zipRemote, (done, total) => {
      publish('deploy:progress', { kind: 'upload', percent: total ? Math.round((done / total) * 100) : 0 })
    })
    log('success', '上传完成，校验文件完整性……')
    const sum = await ssh.exec(conn, `sha256sum ${quoteArg(zipRemote)} | awk '{print $1}'`)
    const remoteSha = (sum.stdout || '').trim()
    if (remoteSha !== pack.sha256) {
      throw new Error(`上传校验失败（本地 ${pack.sha256.slice(0, 8)} / 远端 ${remoteSha.slice(0, 8)}）`)
    }
    log('success', 'SHA256 校验通过')
    await prepareStartupSync()
    tracker.end('upload', 'success', t2)

    // ── 阶段 4~8：服务器端执行 deploy.sh ────────────
    if (isCanceled()) throw new Error('发布已取消')
    const cmd = `${target.autoSudo && autoMode ? 'sudo -n ' : ''}bash ${quoteArg(scriptRemote)} ${buildDeployArgs(project, target, pack, ver.version).map(quoteArg).join(' ')}`
    let res = await execDeployScript(conn, cmd, tracker, resultBox, log)
    // 自动方案的构建失败可用真实错误修正一次；此时服务器尚未停止旧服务。
    if (autoMode && !resultBox.ok && !isCanceled() && tracker.state.build.status === 'running' && tracker.state.start.status === 'waiting' && tracker.state.datasync.status === 'waiting') {
      log('warn', '构建未通过，正在依据构建日志自动修复部署方案并重试一次…')
      const fixed = await automatic.prepare(project, target, {
        conn, uploadText: uploadTextFile, log, signal: controller.signal, releaseId: project.releaseId,
        previousRecipe: prepared.recipe, feedback: prepared.redact((res.stdout || '') + '\n' + (res.stderr || '')),
      })
      if (isCanceled()) throw new Error('发布已取消')
      operation.redact = fixed.redact
      prepared = fixed
      target.autoHealth = fixed.health
      target.autoDb = fixed.db
      projects.save(project)
      try { fs.unlinkSync(pack.zipPath) } catch { /* 临时包可能已清理 */ }
      tracker.begin('package')
      pack = await packager.buildPackage({ projectDir: project.localPath, appName: project.name, version: ver.version, files: [...fixed.files, ...(openclaw?.files || [])], includeBuild: true, safeRoot: true, exclude: fixed.exclude })
      tracker.end('package', 'success')
      tracker.begin('upload')
      const remote = ssh.remoteJoin(remoteHome, 'uploads', pack.fileName)
      await ssh.upload(conn, pack.zipPath, remote)
      const verify = await ssh.exec(conn, `sha256sum ${quoteArg(remote)} | awk '{print $1}'`)
      if (verify.stdout.trim() !== pack.sha256) throw new Error('修复后的发布包上传校验失败')
      await prepareStartupSync()
      tracker.end('upload', 'success')
      Object.assign(resultBox, { ok: false, message: '', rolledBack: false })
      const retryCmd = `${target.autoSudo ? 'sudo -n ' : ''}bash ${quoteArg(scriptRemote)} ${buildDeployArgs(project, target, pack, ver.version).map(quoteArg).join(' ')}`
      res = await execDeployScript(conn, retryCmd, tracker, resultBox, log)
    }

    if (resultBox.ok && res.code === 0) {
      // 补齐脚本未显式标记的阶段（backup/health 可能仍处于 running，统一收尾）
      for (const s of ['backup', 'extract', 'build', 'start', 'health']) {
        const st = tracker.state[s] ? tracker.state[s].status : ''
        if (st === 'running') tracker.end(s, 'success')
        else if (st === 'waiting') {
          // 脚本模式：build（无 Docker 构建）与 backup（项目脚本自备份）显示跳过
          const skipped = s === 'health' || (mode === 'script' && (s === 'build' || s === 'backup'))
          tracker.end(s, skipped ? 'skipped' : 'success')
        }
      }
      if (openclaw && !resultBox.openclawSynced) throw new Error('服务器未确认 OpenClaw 同步完成，不能将本次发布视为成功')
      if (!openclaw) tracker.end('openclaw', 'skipped')
      log('success', `发布成功：${ver.version}`)
      // 成功后删除本地临时 zip（脚本形态的产物包保留）
      if (!pack.keepLocal) {
        try { fs.unlinkSync(pack.zipPath) } catch { /* 清理失败不影响结果 */ }
      }

      // 直接挂载的数据已在启动前同步；其余数据和应用导入在健康检查后执行。
      if (dataSyncCfg.enabled && !resultBox.rolledBack) {
        tracker.begin('datasync')
        const tds = Date.now()
        try {
          const destDir = ssh.remoteJoin(remoteHome, dataSyncCfg.remoteDir)
          if (pack.dataSyncScript) {
            if (!resultBox.dataSynced) throw new Error('服务器未确认启动前数据同步完成，请检查发布日志')
          } else {
            const dataFile = await uploadDataPackage()
            log('info', `解压覆盖到 ${dataSyncCfg.remoteDir} ……`)
            const dres = await ssh.exec(conn, buildDataSyncCommand(dataFile, destDir, remoteHome))
            if (dres.code !== 0 || !/__DATA_SYNC_OK__/.test(dres.stdout || '')) {
              throw new Error(`服务器执行数据同步失败（退出码 ${dres.code}）`)
            }
          }
          if (isCanceled()) throw new Error('发布已取消')
          // ── 同步后导入钩子：把数据写入应用（如调用应用导入接口） ──
          const di = getDataImport(projectId, target, target.id)
          if (di.mode === 'command' && di.command.trim()) {
            log('info', '执行数据导入命令……')
            const finalCmd = renderImportCommand(di.command, { dataDir: destDir, user: di.user, secret: di.secret })
            const ires = await ssh.exec(conn, finalCmd, (chunk) => {
              for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim()) log('info', `[导入] ${line.replace(/\s+$/, '')}`)
              }
            })
            if (ires.code !== 0) {
              throw new Error(`数据导入命令执行失败（退出码 ${ires.code}），详见日志`)
            }
            log('success', '数据导入完成')
          }
          tracker.end('datasync', 'success', tds)
          log('success', `数据同步完成 → ${dataSyncCfg.remoteDir}`)
        } catch (dsErr) {
          tracker.end('datasync', 'failed', tds)
          const msg = `数据同步失败: ${(dsErr && dsErr.message) || dsErr}`
          log('error', msg)
          log('warn', '代码已发布，数据同步或导入未完成；已写入数据不会自动撤回，请排查后重试')
          return finish('failed', msg)
        }
      } else {
        tracker.end('datasync', 'skipped')
      }
      // 全部发布步骤成功后才推进源项目版本与打标，避免失败/回滚留下已推进的版本号；
      // 标签固定到开始时采集的提交，不受写回版本产生的工作区改动影响。
      if (isCanceled()) return finish('canceled', '用户取消')
      if (!resultBox.rolledBack && !isCanceled()) {
        const backNote = syncBackAfterRelease(project, ver)
        if (backNote) log(backNote.startsWith('已将') ? 'success' : 'warn', backNote)
      }
      if (!resultBox.rolledBack && !isCanceled() && record.gitHead) {
        const tagName = releaseNotes.defaultTagName(record.version)
        const tagged = await releaseNotes.createTag(project.localPath, tagName, record.gitHead)
        if (tagged.ok) {
          record.gitTag = tagged.tag
          log('success', `发布标签已${tagged.existed ? '确认' : '创建'}：${tagged.tag}`)
        } else {
          record.gitTag = ''
          record.gitTagError = tagged.error
          log('warn', `部署已成功，但自动打标签失败：${tagged.error}`)
        }
      }
      return finish(resultBox.rolledBack ? 'rolled_back' : 'success', resultBox.message)
    }
    if (isCanceled()) {
      log('warn', '发布已取消，服务器脚本将自动回滚')
      return finish('canceled', '用户取消')
    }
    if (tracker.state.datasync.status === 'waiting') tracker.end('datasync', 'skipped')
    for (const s of STAGES) {
      if (tracker.state[s.id].status === 'running') tracker.end(s.id, resultBox.rolledBack ? 'rollback' : 'failed')
    }
    log('error', resultBox.message || `部署脚本退出码 ${res.code}`)
    return finish(resultBox.rolledBack ? 'rolled_back' : 'failed', resultBox.message || '发布失败')
  } catch (err) {
    if (isCanceled()) {
      log('warn', '发布已取消')
      return finish('canceled', '用户取消')
    }
    const msg = (err && err.message) || String(err)
    log('error', `发布异常: ${msg}`)
    for (const s of STAGES) {
      if (tracker.state[s.id].status === 'running') tracker.end(s.id, 'failed')
    }
    return finish('failed', msg)
  } finally {
    // 清理本地残留 zip（失败场景；成功路径已在 finish 前删除；脚本形态产物包保留）
    try { if (pack && !pack.keepLocal && fs.existsSync(pack.zipPath)) fs.unlinkSync(pack.zipPath) } catch { /* noop */ }
    try { if (dataPack && fs.existsSync(dataPack.zipPath)) fs.unlinkSync(dataPack.zipPath) } catch { /* 临时数据包清理失败不改变发布结果 */ }
    try { workspace.removeBuildWorkspace(buildWorkspace) } catch (e) { log('warn', `构建工作区清理失败：${e.message}`) }
  }
}

/** 上传内存文本到远端（用于 deploy.sh 等；asar 内文件需先读内容再写） */
function uploadTextFile(conn, text, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      const stream = sftp.createWriteStream(remotePath, { mode: 0o600 })
      const done = (fn) => (v) => { sftp.end(); fn(v) } // 及时释放通道
      stream.on('error', done(reject))
      stream.on('close', done(() => resolve(remotePath)))
      stream.end(text, 'utf8')
    })
  })
}

/** 按目标连接服务器（公共取配置+连接逻辑） */
async function connectTarget(projectId, targetId) {
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请先保存')
  const target = getTarget(project, targetId)
  if (!target) throw new Error('项目缺少部署目标，请先在配置中添加')
  const conn = await connectProjectTarget(project, target)
  return { project, target, conn }
}

function connectProjectTarget(project, target) {
  const creds = projects.getCredentials(project.id, target.id) || { password: '', passphrase: '' }
  return ssh.connect({
    host: target.server.host,
    port: target.server.port,
    username: target.server.username,
    authType: target.server.authType,
    password: creds.password,
    keyPath: target.server.keyPath,
    passphrase: creds.passphrase,
  })
}

/** 测试连接：返回服务器环境信息（Docker/Compose/unzip/tar/java/磁盘） */
async function testConnection(projectId, targetId) {
  const { project, target, conn } = await connectTarget(projectId, targetId)
  try {
    const cmd = [
      'echo __CONN_OK__',
      'uname -srm',
      'docker --version 2>&1 || echo DOCKER_MISSING',
      'docker compose version 2>&1 || echo COMPOSE_MISSING',
      'unzip -v 2>/dev/null | head -1 || echo UNZIP_MISSING',
      'tar --version 2>/dev/null | head -1 || echo TAR_MISSING',
      'java -version 2>&1 | head -1 || echo JAVA_MISSING',
      'df -h / | tail -1',
    ].join('; ')
    const res = await ssh.exec(conn, cmd)
    const out = res.stdout || ''
    const grab = (re) => { const m = out.match(re); return m ? m[1].trim() : '' }
    return {
      ok: /__CONN_OK__/.test(out) && res.code === 0,
      os: grab(/__CONN_OK__\s*\n(.+)/),
      docker: /DOCKER_MISSING/.test(out) ? '' : grab(/(Docker version [^\n]+)/),
      compose: /COMPOSE_MISSING/.test(out) ? '' : grab(/(Docker Compose version [^\n]+)/),
      unzip: /UNZIP_MISSING/.test(out) ? '' : '已安装',
      tar: /TAR_MISSING/.test(out) ? '' : '已安装',
      java: /JAVA_MISSING/.test(out) ? '' : (out.match(/(openjdk|java) version[^\n]*/i) || [''])[0],
      disk: grab(/(\d+%)\s+\/\s*$/m) || grab(/\/\s+(\d+%)$/m),
    }
  } finally {
    ssh.close(conn)
  }
}

/** 服务器 releases 目录列表 + 当前指向（方案 §19/§20 的版本管理基础）
 *  docker 形态：current 软链接；script 形态：CURRENT 指针文件（内容 = release 目录名） */
async function listReleases(projectId, targetId) {
  const { project, target, conn } = await connectTarget(projectId, targetId)
  const home = target.remotePath
  const mode = deployModeOf(project)
  try {
    const curCmd = mode === 'script'
      ? `cat ${quoteArg(ssh.remoteJoin(home, 'CURRENT'))} 2>/dev/null`
      : `readlink ${quoteArg(ssh.remoteJoin(home, 'current'))} 2>/dev/null`
    const res = await ssh.exec(conn,
      `ls -1 ${quoteArg(ssh.remoteJoin(home, 'releases'))} 2>/dev/null; echo __CUR__$(${curCmd})`)
    const lines = (res.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const curIdx = lines.findIndex((l) => l.startsWith('__CUR__'))
    const current = curIdx >= 0 ? lines[curIdx].replace('__CUR__', '').split('/').pop() : ''
    return { releases: lines.slice(0, curIdx < 0 ? lines.length : curIdx).filter(Boolean), current }
  } finally {
    ssh.close(conn)
  }
}

/** 校验数据库备份文件名（防路径注入：仅允许 db_ 前缀 + 安全字符） */
function assertDbBackupName(fileName) {
  if (typeof fileName !== 'string' || !/^db_[\w.-]+\.sql$/.test(fileName)) {
    throw new Error(`非法的备份文件名：${fileName}`)
  }
}

/** 使用项目自己的数据库策略；自动识别结果不要求用户填写容器名和库名。 */
function requireDbConfig(project, target, forRestore = false) {
  const d = databaseFor(project, target)
  const env = (target && target.name) || '当前环境'
  if (!d.enabled) throw new Error(`[${env}] 未启用「发布前备份数据库」${d.reason ? `：${d.reason}` : '，请先发布以识别数据库，或在部署设置中配置数据库信息'}`)
  if (!['postgres', 'mysql'].includes(d.type)) throw new Error(`[${env}] 数据库类型不支持备份管理`)
  if (forRestore && d.type !== 'postgres') throw new Error(`[${env}] MySQL 备份可以查看；当前仅支持 PostgreSQL 备份恢复`)
  if (!String(target.remotePath || '').trim()) throw new Error(`[${env}] 尚无已部署目录，请先完成发布`)
  const auto = project.deployMode === 'auto' && (target.db?.strategy || 'auto') === 'auto'
  if (auto) {
    const service = String(d.service || '').trim()
    if (!/^[a-zA-Z0-9_.-]+$/.test(service)) throw new Error(`[${env}] 自动识别的数据库服务无效，请重新发布以更新识别结果`)
    return { ...d, auto: true, service }
  }
  // 列表只读备份目录，不依赖容器仍在运行或完整的恢复参数。
  if (!forRestore) return d
  const container = String(d.container || '').trim()
  const name = String(d.name || '').trim()
  const user = String(d.user || 'postgres').trim()
  if (!container || !name) throw new Error(`[${env}] 数据库容器名或库名未配置`)
  if (!/^[a-zA-Z0-9_.-]+$/.test(container)) throw new Error(`[${env}] 数据库容器名含非法字符`)
  if ([name, user].some((value) => !value || /[\x00-\x1f\x7f]/.test(value))) throw new Error(`[${env}] 数据库名称或用户无效`)
  return { ...d, container, name, user, auto: false }
}

function dbSudo(project, target) {
  return project.deployMode === 'auto' && target.autoSudo ? 'sudo -n ' : ''
}

/** 容器内读取 PostgreSQL 现有库名和用户（环境变量或 *_FILE）；密码不经输出传递 */
const POSTGRES_NAMES_SCRIPT = [
  'db_user="${POSTGRES_USER:-}"',
  'if [ -z "$db_user" ] && [ -n "${POSTGRES_USER_FILE:-}" ]; then db_user="$(cat "$POSTGRES_USER_FILE")"; fi',
  'db_user="${db_user:-postgres}"',
  'db_name="${POSTGRES_DB:-}"',
  'if [ -z "$db_name" ] && [ -n "${POSTGRES_DB_FILE:-}" ]; then db_name="$(cat "$POSTGRES_DB_FILE")"; fi',
  'db_name="${db_name:-$db_user}"',
  'printf "%s\\n%s\\n" "$db_user" "$db_name"',
].join('\n')

async function readPostgresNames(conn, docker, container) {
  const names = await ssh.exec(conn, `${docker} exec ${quoteArg(container)} sh -ceu ${quoteArg(POSTGRES_NAMES_SCRIPT)}`)
  const rows = (names.stdout || '').replace(/\r?\n$/, '').split('\n')
  if (names.code !== 0 || rows.length !== 2 || rows.some((value) => !value || /[\x00-\x1f\x7f]/.test(value))) {
    throw new Error('无法读取数据库现有库名和用户，请检查容器的 PostgreSQL 环境配置')
  }
  return { user: rows[0], name: rows[1] }
}

/** 标签同时限定项目和服务；多副本不能猜测要恢复哪一个数据库。 */
async function resolveRestoreDb(conn, project, target, db) {
  if (!db.auto) return db
  const docker = `${dbSudo(project, target)}docker`
  const result = await ssh.exec(conn, `${docker} ps -q --filter ${quoteArg(`label=com.docker.compose.project=${automatic.identity(project, target.id)}`)} --filter ${quoteArg(`label=com.docker.compose.service=${db.service}`)} --filter status=running`)
  const ids = (result.stdout || '').trim().split(/\s+/).filter(Boolean)
  if (result.code !== 0 || ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) {
    throw new Error('无法唯一定位当前项目的运行中数据库容器，请检查服务状态后重试')
  }
  return { ...db, container: ids[0], ...(await readPostgresNames(conn, docker, ids[0])) }
}

/** 密码始终在容器内读取，不经 inspect、SSH 输出、客户端变量或日志传递。 */
function postgresCommand(docker, db, tool, args, stdin = false) {
  const script = [
    'if [ -z "${PGPASSWORD:-}" ]; then',
    '  PGPASSWORD="${POSTGRES_PASSWORD:-}"',
    '  if [ -z "$PGPASSWORD" ] && [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; fi',
    '  export PGPASSWORD',
    'fi',
    `exec ${tool} "$@"`,
  ].join('\n')
  return `${docker} exec ${stdin ? '-i ' : ''}${quoteArg(db.container)} sh -ceu ${quoteArg(script)} -- ${args.map(quoteArg).join(' ')}`
}

function sqlIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

function sqlLiteral(value) {
  return `E'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

/** 列出服务器 backups/ 下的数据库备份（按时间倒序） */
async function listDbBackups(projectId, targetId) {
  const { project, target, conn } = await connectTarget(projectId, targetId)
  const home = target.remotePath
  try {
    requireDbConfig(project, target)
    const res = await ssh.exec(conn,
      // glob 展开为全路径，awk 内取 basename；$5=大小 $6/$7=日期时间
      `${dbSudo(project, target)}ls -lht --time-style=+%Y-%m-%d\\ %H:%M ${quoteArg(ssh.remoteJoin(home, 'backups'))}/db_*.sql 2>/dev/null | awk '{n=split($8,a,"/"); print $5, $6, $7, a[n]}'`)
    const backups = (res.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(db_[\w.-]+\.sql)$/)
      return m ? { size: m[1], time: `${m[2]} ${m[3]}`, fileName: m[4] } : null
    }).filter(Boolean)
    return { backups }
  } finally {
    ssh.close(conn)
  }
}

/**
 * 恢复数据库备份（高危操作，编排全程写部署日志并记入发布历史）：
 *   保底备份当前库 → 暂存库导入与切换 → 重启同 Compose 项目的容器。
 * 保底备份失败则中止——绝不覆盖「唯一可能完好的当前数据」。
 */
async function restoreDbBackup(projectId, targetId, fileName, requestId) {
  if (activeRuns.has(projectId)) throw new Error('该项目已有发布任务进行中，请等待完成或取消')
  assertDbBackupName(fileName)
  return withRun(projectId, targetId, 'db-restore', (operation) => runDbRestore(operation, fileName), { version: fileName, requestId })
}

async function runDbRestore(operation, fileName) {
  const { project, target, log, finish, controller, id: runId } = operation
  const conn = operation.conn = await connectProjectTarget(project, target)
  if (controller.signal.aborted) throw new Error('数据库恢复已取消')
  const db = await resolveRestoreDb(conn, project, target, requireDbConfig(project, target, true))
  if (controller.signal.aborted) throw new Error('数据库恢复已取消')
  const home = target.remotePath
  const backupDir = ssh.remoteJoin(home, 'backups')
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const sudo = dbSudo(project, target)

  try {
    const sqlFile = ssh.remoteJoin(backupDir, fileName)
    const has = await ssh.exec(conn, `${sudo}test -f ${quoteArg(sqlFile)} && echo Y || echo N`)
    if ((has.stdout || '').trim() !== 'Y') throw new Error(`备份文件不存在：${fileName}`)

    log('info', `开始恢复数据库：${fileName}（库 ${db.name}@${db.container}）`)
    await replaceDatabaseWithSql(conn, project, target, db, sqlFile, { stamp, runId, log })
    log('success', `数据库恢复完成：${fileName}`)
    return finish('success', `数据库已恢复到备份 ${fileName}`)
  } catch (err) {
    const msg = (err && err.message) || String(err)
    log('error', `数据库恢复异常: ${msg}`)
    return finish('failed', msg)
  }
}

/**
 * 用服务器上的 SQL 文件整体替换数据库（数据库恢复与环境同步的数据同步共用）：
 * 保底备份当前库 → 暂存库导入与切换 → 重启同 Compose 项目的容器。
 * 保底备份失败则中止——绝不覆盖「唯一可能完好的当前数据」。返回保底备份文件名。
 */
async function replaceDatabaseWithSql(conn, project, target, db, sqlFile, { stamp, runId, log, onImported = () => {} }) {
  const backupDir = ssh.remoteJoin(target.remotePath, 'backups')
  const sudo = dbSudo(project, target)
  const docker = `${sudo}docker`

  // 1. 保底备份当前库（失败即中止）
  const guardName = `db_guard_${stamp}_${runId}.sql`
  const guardFile = ssh.remoteJoin(backupDir, guardName)
  log('info', '恢复前先保底备份当前数据库……')
  const dump = postgresCommand(docker, db, 'pg_dump', ['-U', db.user, '--', db.name])
  // sudo docker 不会提升 shell 重定向的权限，备份文件也须在相同权限下写入。
  const partial = quoteArg(`${guardFile}.partial`)
  const dumpToFile = sudo ? `${dump} | ${sudo}tee ${partial} >/dev/null` : `${dump} > ${partial}`
  const guard = await ssh.exec(conn, `bash -o pipefail -c ${quoteArg(`umask 077; trap '${sudo}rm -f -- "$1"' EXIT; ${dumpToFile} && ${sudo}chmod 600 ${partial} && ${sudo}mv -- ${partial} ${quoteArg(guardFile)} && echo __GUARD_OK__`)} -- ${partial}`)
  if (guard.code !== 0 || !/__GUARD_OK__/.test(guard.stdout || '')) {
    throw new Error('保底备份失败，已中止恢复（当前数据未做任何改动）')
  }
  log('success', `保底备份完成：${guardName}`)

  // 2. 先导入独立数据库，SQL 执行成功后才切换应用所用的数据库名称。
  log('info', '正在将备份灌入暂存数据库……')
  // 默认库本身可能是 postgres，维护连接不能连接即将删除的数据库。
  const maintenance = db.name === 'postgres' ? 'template1' : 'postgres'
  const psql = (sql) => postgresCommand(docker, db, 'psql', ['-U', db.user, '-d', maintenance, '-v', 'ON_ERROR_STOP=1', '-c', sql])
  const importSql = (database) => {
    const cmd = postgresCommand(docker, db, 'psql', ['-U', db.user, '-d', database, '-v', 'ON_ERROR_STOP=1'], true)
    return sudo ? `${sudo}cat ${quoteArg(sqlFile)} | ${cmd}` : `${cmd} < ${quoteArg(sqlFile)}`
  }
  const restoreSteps = buildDatabaseSwap({ db, runId, psql, importSql })
  const restoreCmd = `bash -c ${quoteArg(restoreSteps)}`
  const res = await ssh.exec(conn, restoreCmd, (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const t = line.replace(/\s+$/, '')
      if (t && !/^(__DB_RESTORE_OK__|DROP DATABASE|CREATE DATABASE|pg_terminate_backend)/.test(t)) log('info', `[恢复] ${t}`)
    }
  })
  if (res.code !== 0 || !/^__DB_RESTORE_OK__$/m.test(res.stdout || '')) {
    throw new Error(`数据库导入或切换失败（退出码 ${res.code}），请检查日志；保底备份 ${guardName}`)
  }
  onImported(guardName)
  log('success', '备份已灌入')

  // 刚灌入的库还没有查询计划统计信息（autovacuum 要过一阵才收集）：应用重启后马上就查，先刷新；
  // 失败只提醒，不影响已灌入的数据
  const analyzed = await ssh.exec(conn, postgresCommand(docker, db, 'psql', ['-U', db.user, '-d', db.name, '-q', '-v', 'ON_ERROR_STOP=1', '-c', 'ANALYZE;']))
  if (analyzed.code === 0) log('success', '查询计划统计信息已刷新')
  else log('warn', '查询计划统计信息刷新失败（不影响已灌入的数据），应用刚启动时的查询可能偏慢')

  // 3. 重启同 compose 项目的容器（应用连接池指向已重建的库）
  log('info', '重启应用容器……')
  const projectName = db.auto ? quoteArg(automatic.identity(project, target.id))
    : `$(${docker} inspect ${quoteArg(db.container)} --format '{{index .Config.Labels "com.docker.compose.project"}}')`
  const restarted = await ssh.exec(conn,
    `PROJ=${projectName}; if [ -n "$PROJ" ]; then CONTAINERS=$(${docker} ps --filter "label=com.docker.compose.project=$PROJ" -q) && [ -n "$CONTAINERS" ] && ${docker} restart $CONTAINERS; else echo __NO_COMPOSE__; fi`)
  if (restarted.code !== 0) throw new Error('数据库已恢复，但应用容器重启失败，请检查服务状态')
  return guardName
}

/** 导入失败时清理暂存库，切换时把两次改名放在同一个 PostgreSQL 事务内。 */
function buildDatabaseSwap({ db, runId, psql, importSql, allowMissing = false }) {
  const staging = `plm_import_${runId}`
  const previous = `plm_previous_${runId}`
  const target = sqlIdentifier(db.name)
  const staged = sqlIdentifier(staging)
  const old = sqlIdentifier(previous)
  const rename = `ALTER DATABASE ${staged} RENAME TO ${target};`
  return [
    'set -euo pipefail',
    `${psql(`CREATE DATABASE ${staged} OWNER ${sqlIdentifier(db.user)};`)} </dev/null`,
    `trap ${quoteArg(`${psql(`DROP DATABASE IF EXISTS ${staged} WITH (FORCE);`)} </dev/null >/dev/null 2>&1 || true`)} EXIT`,
    importSql(staging),
    ...(allowMissing ? ['if [ "$exists" = 0 ]; then', `  ${psql(rename)} </dev/null`, 'else'] : []),
    `${psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlLiteral(db.name)} AND pid <> pg_backend_pid();`)} </dev/null`,
    `${psql(`ALTER DATABASE ${target} RENAME TO ${old}; ${rename}`)} </dev/null`,
    ...(allowMissing ? ['fi'] : []),
    'trap - EXIT',
    'echo __DB_RESTORE_OK__',
    `${psql(`DROP DATABASE IF EXISTS ${old} WITH (FORCE);`)} </dev/null || echo ${quoteArg(`[WARN] 旧数据库副本 ${previous} 清理失败，请在确认数据后处理`)}`,
  ].join('\n')
}

/** 手动回滚到指定版本（方案 §20：直接使用服务器已有 release，不重新上传） */
async function rollback(projectId, version, targetId, requestId) {
  if (!safeVersion(version)) throw new Error('回滚版本无效，请重新选择')
  return withRun(projectId, targetId, 'rollback', (operation) => runRollback(operation, version), { version, requestId })
}

async function runRollback(operation, version) {
  const { project, target, record, tracker, log, finish, controller } = operation
  const isCanceled = () => controller.signal.aborted
  const home = target.remotePath
  const h = healthFor(project, target)
  log('info', `开始回滚 ${project.name}（${target.name}）→ ${version}`)

  try {
    const conn = operation.conn = await connectProjectTarget(project, target)
    if (isCanceled()) return finish('canceled', '回滚已取消，尚未修改服务器')
    await ssh.mkdirp(conn, ssh.remoteJoin(home, 'deployer'))
    const scriptRemote = ssh.remoteJoin(home, 'deployer', 'deploy.sh')
    // 每次补传当前脚本，历史服务器也能使用新的失败恢复逻辑。
    await uploadTextFile(conn, readDeployScript(), scriptRemote)
    const curCmd = deployModeOf(project) === 'script'
      ? `cat ${quoteArg(ssh.remoteJoin(home, 'CURRENT'))} 2>/dev/null`
      : `readlink ${quoteArg(ssh.remoteJoin(home, 'current'))} 2>/dev/null`
    const current = await ssh.exec(conn, `${curCmd} || true`)
    record.oldVersion = (current.stdout || '').trim().split('/').pop() || ''
    if (isCanceled()) return finish('canceled', '回滚已取消，尚未切换服务')
    const args = [
      'rollback', '--mode', deployModeOf(project),
      '--app', project.name, '--home', home, '--version', version,
    ]
    if (target.openclaw?.enabled) args.push('--openclaw-sync')
    if (deployModeOf(project) === 'docker') {
      args.push('--compose', resolveCompose(project).file)
      if (project.deployMode === 'auto') args.push('--project-name', automatic.identity(project, target.id))
    }
    if (h.enabled && h.url) {
      args.push('--health-url', h.url, '--health-timeout', String(h.timeout || 90), '--health-interval', String(h.interval || 3))
    } else {
      args.push('--no-health')
    }
    const cmd = `${project.deployMode === 'auto' && target.autoSudo ? 'sudo -n ' : ''}bash ${quoteArg(scriptRemote)} ${args.map(quoteArg).join(' ')}`
    const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
    const res = await execDeployScript(conn, cmd, tracker, resultBox, log)
    if (isCanceled()) return finish('canceled', '回滚已取消，请查询线上版本确认服务器恢复结果')
    if (resultBox.ok && res.code === 0) {
      for (const id of ['start', 'health']) {
        if (tracker.state[id].status === 'running') tracker.end(id, 'success')
      }
      log('success', `回滚成功，当前版本: ${version}`)
      return finish('success', `回滚到 ${version}`)
    }
    log('error', resultBox.message || `回滚失败（退出码 ${res.code}）`)
    for (const id of ['start', 'health']) {
      if (tracker.state[id].status === 'running') tracker.end(id, 'failed')
    }
    return finish('failed', resultBox.message || '回滚失败')
  } catch (err) {
    if (isCanceled()) return finish('canceled', '回滚已取消，请查询线上版本确认服务器恢复结果')
    const msg = (err && err.message) || String(err)
    log('error', `回滚异常: ${msg}`)
    return finish('failed', msg)
  }
}

// ═════════════════════════ 环境同步（测试 → 正式） ═════════════════════════
// 把源环境正在运行的版本原样发布到目标环境，可选把源环境的 PostgreSQL 数据灌入目标环境。
// 版本来源优先是服务器留存的原始发布包（发布时的上传包，与已验证的内容逐字节一致）；
// 旧版本没有留存包时回退为重新打包版本目录，并剔除环境专属文件与运行期文件。
// 首次发布在应用启动前灌库，已有版本则在版本切换后同步数据。

/** 版本目录名会进入服务器路径与命令，只放行安全字符 */
function safeReleaseName(name) {
  return /^[\w][\w.+~-]*$/.test(String(name)) && String(name).length <= 128
}

function normalizeHome(target) {
  const home = String((target && target.remotePath) || '').trim()
  return home ? path.posix.normalize(home).replace(/\/+$/, '') : ''
}

function sameSshHost(a, b) {
  const { host, port } = a.server || {}
  const other = b.server || {}
  const hostname = (value) => String(value || '').trim().toLowerCase()
  return !!hostname(host) && hostname(host) === hostname(other.host) && (Number(port) || 22) === (Number(other.port) || 22)
}

/** 两个目标是否同一台服务器（同主机、端口、账号即同一 SSH 连接端点） */
function sameEndpoint(a, b) {
  return sameSshHost(a, b) && String(a.server.username || '').trim() === String(b.server.username || '').trim()
}

/** 校验源环境与目标环境，返回两个目标与阻塞项（不连接服务器） */
function promoteEnvironments(project, sourceTargetId, destTargetId) {
  const targets = Array.isArray(project.targets) ? project.targets : []
  const source = targets.find((t) => t && t.id === sourceTargetId)
  const dest = targets.find((t) => t && t.id === destTargetId)
  if (!source || !dest) throw new Error('部署环境不存在，请重新选择')
  if (source.id === dest.id) throw new Error('源环境与目标环境不能相同')
  const problems = []
  for (const [label, target] of [['源环境', source], ['目标环境', dest]]) {
    if (!(target.server && target.server.host)) problems.push(`${label}「${target.name}」未配置服务器`)
    if (!String(target.remotePath || '').trim()) problems.push(`${label}「${target.name}」未配置部署目录`)
  }
  if (sameSshHost(source, dest) && normalizeHome(source) === normalizeHome(dest)) {
    problems.push('源环境与目标环境是同一个部署目录')
  }
  // deployModeOf() 会把 auto 归并为 docker，这里必须看原始值
  if (project.deployMode !== 'docker' && project.deployMode !== 'script') {
    problems.push('自动发布形态的版本包含环境专属配置，暂不支持环境同步')
  }
  return { source, dest, problems }
}

/** 线上当前版本：docker 形态读 current 软链接，脚本形态读 CURRENT 指针文件 */
function currentVersionCommand(home, mode) {
  return mode === 'script'
    ? `cat ${quoteArg(ssh.remoteJoin(home, 'CURRENT'))} 2>/dev/null || true`
    : `readlink ${quoteArg(ssh.remoteJoin(home, 'current'))} 2>/dev/null || true`
}

async function readCurrentVersion(conn, home, mode) {
  const res = await ssh.exec(conn, currentVersionCommand(home, mode))
  if (res.code !== 0) throw new Error(`读取线上版本失败：${(res.stderr || '').trim().slice(0, 200) || `退出码 ${res.code}`}`)
  return (res.stdout || '').trim().split('/').pop() || ''
}

/**
 * 源环境版本的可搬运来源：留存的原始发布包优先（返回 { package }）；
 * 没有留存包时列出版本目录内指向源环境自身的绝对链接（这些链接搬到目标后仍指回源环境，必须拦下）。
 */
async function inspectSourceRelease(conn, home, release) {
  const dir = ssh.remoteJoin(home, 'releases', release)
  const pkgDir = ssh.remoteJoin(home, 'releases', '.packages')
  const res = await ssh.exec(conn, [
    `if [ -d ${quoteArg(dir)} ]; then echo __RELEASE_OK__; else echo __RELEASE_MISSING__; fi`,
    `pkg=''; for ext in zip tar.gz tgz; do f=${quoteArg(pkgDir)}/${release}."$ext"; if [ -f "$f" ]; then pkg="$f"; break; fi; done`,
    'printf \'__PKG__%s\\n\' "$pkg"',
  ].join('; '))
  const out = res.stdout || ''
  if (res.code !== 0 || !out.includes('__RELEASE_OK__')) return { missing: true, package: '', links: [] }
  const pkg = ((out.match(/__PKG__(.*)/) || [])[1] || '').trim()
  if (pkg) return { missing: false, package: pkg, links: [] }
  // deploy.sh 链接的 .env 指向本环境 shared/.env，重新打包时本就剔除，不算越界
  const links = await ssh.exec(conn, [
    `cd ${quoteArg(dir)} && find . -type l -printf '%p\\t%l\\n' 2>/dev/null`,
    `awk -F'\\t' -v home=${quoteArg(`${normalizeHome({ remotePath: home })}/`)} 'index($2, home) == 1 && $1 !~ /(^|\\/)\\.env$/ {print $1 " -> " $2}' | head -5`,
  ].join(' | ') + ' || true')
  return { missing: false, package: '', links: (links.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }
}

/** 源环境版本目录里的 Compose 文件：配置的文件存在则原样使用，否则按常见命名回退 */
async function findReleaseCompose(conn, dir, configured) {
  const candidates = [...new Set([String(configured || 'docker-compose.yml').trim() || 'docker-compose.yml', ...COMPOSE_CANDIDATES])]
  const res = await ssh.exec(conn, `for f in ${candidates.map(quoteArg).join(' ')}; do if [ -f ${quoteArg(dir)}/"$f" ]; then printf '%s\\n' "$f"; break; fi; done; true`)
  return (res.stdout || '').trim()
}

/** 读远端文本文件的内容；读不到返回空串 */
async function readRemoteText(conn, file) {
  try {
    const res = await ssh.exec(conn, `cat ${quoteArg(file)}`)
    return res.code === 0 ? String(res.stdout || '') : ''
  } catch {
    return ''
  }
}

/**
 * 读源环境版本目录里的 Compose 声明，找出发布流程不会创建、目标服务器必须预先具备的东西：
 * 声明为 external 的网络（缺少时服务启动必然失败）与绝对路径的宿主机挂载（缺少时只会被建成空目录）。
 * 读不到或解析失败返回 null，不因此阻塞同步。
 */
async function readReleasePrerequisites(conn, dir, composeFile) {
  try {
    const res = await ssh.exec(conn, `cat ${quoteArg(ssh.remoteJoin(dir, composeFile))}`)
    if (res.code !== 0 || !res.stdout.trim()) return null
    const doc = parseYaml(res.stdout)
    if (!doc || typeof doc !== 'object') return null
    const networks = []
    for (const [name, spec] of Object.entries(doc.networks || {})) {
      if (!spec || typeof spec !== 'object' || spec.external === undefined || spec.external === false) continue
      const external = spec.external
      networks.push(typeof external === 'string' ? external : (external && typeof external.name === 'string' ? external.name : spec.name || name))
    }
    const paths = new Set()
    for (const service of Object.values(doc.services || {})) {
      for (const volume of [].concat((service && service.volumes) || [])) {
        const source = typeof volume === 'string' ? volume.split(':')[0] : volume && volume.source
        // 含变量占位的来源运行时才确定，无法提前检查
        if (typeof source === 'string' && source.startsWith('/') && !source.includes('$')) paths.add(source.replace(/\/+$/, ''))
      }
    }
    return { networks, paths: [...paths] }
  } catch {
    return null
  }
}

/** 目标服务器是否已具备这些前提；返回缺失的外部网络与宿主机目录 */
async function checkDestPrerequisites(conn, prerequisites) {
  if (!prerequisites) return { networks: [], paths: [] }
  const networks = prerequisites.networks.filter((name) => /^[\w.-]+$/.test(name))
  const probe = [
    ...networks.map((name) => `docker network inspect ${quoteArg(name)} >/dev/null 2>&1 || echo ${quoteArg(`NET:${name}`)};`),
    ...prerequisites.paths.map((dir) => `[ -e ${quoteArg(dir)} ] || echo ${quoteArg(`PATH:${dir}`)};`),
  ].join(' ')
  if (!probe) return { networks: [], paths: [] }
  const res = await ssh.exec(conn, probe)
  if (res.code !== 0) throw new Error('无法检查目标服务器的 Compose 外部依赖')
  const out = new Set((res.stdout || '').split(/\r?\n/))
  return {
    networks: networks.filter((name) => out.has(`NET:${name}`)),
    paths: prerequisites.paths.filter((dir) => out.has(`PATH:${dir}`)),
  }
}

/**
 * 重新打包版本目录的命令：docker 形态平铺（与发布 ZIP 同形），脚本形态保留单一顶层目录（发布包契约）。
 * 剔除环境专属的 .env、socket/FIFO，以及运行期写入版本目录的
 * pid/日志/启动标记/字节码缓存（项目脚本把 pid 写进版本目录时，带到目标环境会让启动脚本误判已在运行）。
 */
function buildReleaseArchiveScript(home, release, output, { flat = false, toStdout = false } = {}) {
  const base = flat ? ssh.remoteJoin(home, 'releases', release) : ssh.remoteJoin(home, 'releases')
  const filter = `find ${quoteArg(flat ? '.' : release)} -name __pycache__ -type d -prune -o `
    + `\\( ! -name .env ! -type s ! -type p ! -name '*.pid' ! -name '*.log' ! -name '*.sock' ! -name .started \\) -print0`
  return [
    'set -uo pipefail',
    `cd ${quoteArg(base)}`,
    `{ ${filter} | tar --null --no-recursion -czf ${toStdout ? '-' : quoteArg(output)} -T -; }`,
    'rc=$?',
    // tar 退出码 1 只表示归档期间有文件变化（运行中的日志等），归档仍可用；更高退出码才是失败
    '[ "$rc" -eq 0 ] || [ "$rc" -eq 1 ] || exit "$rc"',
    toStdout ? 'echo __ARCHIVE_OK__ >&2' : 'echo __ARCHIVE_OK__',
  ].join('\n')
}

/** 镜像对应的数据库产品：官方或名称含 postgres 的兼容产品归为 PostgreSQL，MySQL/MariaDB 单列 */
function databaseEngine(image) {
  const repo = String(image || '').trim().toLowerCase()
    .replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, '').replace(/^library\//, '').split(/[@:]/)[0]
  if (/(^|\/)(mysql|mariadb)(-|$)/.test(repo)) return 'mysql'
  if (/(^|\/)(postgres|postgresql)(-|$)/.test(repo) || /pgvector|timescale|postgis|postgres/.test(repo)) return 'postgres'
  return ''
}

/** 按部署目录识别环境的数据库容器：Compose 工作目录位于该环境 releases/ 下的数据库镜像容器 */
async function detectComposeDatabase(conn, home) {
  const prefix = `${normalizeHome({ remotePath: home })}/releases/`
  const res = await ssh.exec(conn, 'docker ps --format \'{{.Names}}\\t{{.Image}}\\t{{.Label "com.docker.compose.project.working_dir"}}\'')
  if (res.code !== 0) return { problem: `无法查询容器：${(res.stderr || res.stdout || '').trim().slice(0, 200) || `退出码 ${res.code}`}` }
  const found = []
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    const [name, image, dir] = line.split('\t')
    const engine = databaseEngine(image)
    if (name && engine && String(dir || '').startsWith(prefix)) found.push({ name: name.trim(), engine })
  }
  const mysql = found.find((item) => item.engine === 'mysql')
  if (mysql) return { problem: `环境的数据库 ${mysql.name} 是 MySQL/MariaDB，仅支持 PostgreSQL` }
  const names = [...new Set(found.map((item) => item.name))]
  if (!names.length) return { problem: '未识别到数据库容器，可在部署设置的数据库备份中指定' }
  if (names.length > 1) return { problem: `识别到多个数据库容器（${names.join('、')}），请在部署设置的数据库备份中指定` }
  return { db: { container: names[0], type: 'postgres', ...(await readPostgresNames(conn, 'docker', names[0])) } }
}

/** 环境要同步的 PostgreSQL：优先数据库备份配置；未配置或已关闭时按部署目录识别 */
async function resolveSyncDatabase(conn, project, target) {
  const d = databaseFor(project, target)
  let db
  if (d.enabled) {
    if (d.type !== 'postgres' || d.service) {
      return { problem: `配置的数据库${d.type === 'mysql' ? '是 MySQL' : d.service ? '由自动发布识别' : `类型为 ${d.type || '未知'}`}，仅支持手动指定的 PostgreSQL` }
    }
    const container = String(d.container || '').trim()
    const name = String(d.name || '').trim()
    if (!container || !name) return { problem: '数据库容器名或库名未配置' }
    db = { container, name, user: String(d.user || '').trim() || 'postgres' }
  } else {
    const found = await detectComposeDatabase(conn, target.remotePath)
    if (found.problem) return found
    db = found.db
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(db.container)) return { problem: `数据库容器名含非法字符：${db.container}` }
  if (!db.name || !db.user || [db.name, db.user].some((value) => /[\x00-\x1f\x7f]/.test(value))) return { problem: '数据库名称或用户无效' }
  return { db }
}

/** 数据库版本、大小、字符集与排序规则；读不到时返回 problem */
async function describeDatabase(conn, db) {
  const sql = "select current_setting('server_version'), pg_size_pretty(pg_database_size(current_database())), "
    + '(select encoding from pg_database where datname = current_database()), (select datcollate from pg_database where datname = current_database())'
  try {
    const res = await ssh.exec(conn, postgresCommand('docker', db, 'psql', ['-U', db.user, '-d', db.name, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]))
    const row = (res.stdout || '').trim().split('|').map((s) => s.trim())
    if (res.code !== 0 || row.length !== 4) return { problem: `无法读取数据库信息：${(res.stderr || '').trim().slice(0, 200) || `退出码 ${res.code}`}` }
    return { version: row[0], size: row[1], encoding: row[2], collate: row[3] }
  } catch (err) {
    return { problem: (err && err.message) || String(err) }
  }
}

/** 逐表精确行数（不用统计估算值）：同步前后核对源库与目标库的数据量 */
const ROW_COUNT_SQL = "select json_build_array(schemaname, tablename, (xpath('/row/c/text()', "
  + "query_to_xml(format('select count(*) as c from %I.%I', schemaname, tablename), false, true, '')))[1]::text) "
  + "from pg_tables where schemaname not in ('pg_catalog', 'information_schema') order by schemaname, tablename"

function parseRowCounts(res) {
  if (res.code !== 0) return null
  const counts = new Map()
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('[')) continue
    const [schema, table, count] = JSON.parse(line)
    counts.set(JSON.stringify([schema, table]), BigInt(count))
  }
  return { counts, tables: counts.size, rows: [...counts.values()].reduce((sum, count) => sum + count, 0n) }
}

async function countDatabaseRows(conn, db) {
  try {
    const res = await ssh.exec(conn, postgresCommand('docker', db, 'psql', ['-U', db.user, '-d', db.name, '-At', '-v', 'ON_ERROR_STOP=1',
      '-c', "SET statement_timeout = '120s'", '-c', ROW_COUNT_SQL]))
    return parseRowCounts(res)
  } catch {
    return null
  }
}

/**
 * 两侧 shared/.env 中同名的应用密钥（KEY / SECRET / TOKEN，不含数据库口令）取值是否一致。
 * 只返回「名称 + 取值哈希」，取值本身不出服务器；应用用它加密的数据换环境后要靠同一把密钥才能解开。
 */
async function secretEnvKeys(conn, home) {
  const file = ssh.remoteJoin(home, 'shared', '.env')
  const script = [
    `[ -f ${quoteArg(file)} ] || exit 0`,
    `grep -E '^[A-Za-z_][A-Za-z0-9_]*(KEY|SECRET|TOKEN)[A-Za-z0-9_]*=' ${quoteArg(file)} | while IFS= read -r line; do`,
    '  name="${line%%=*}"',
    `  printf '%s\\t%s\\n' "$name" "$(printf %s "\${line#*=}" | sha256sum | cut -c1-16)"`,
    'done',
  ].join('\n')
  const res = await ssh.exec(conn, `bash -c ${quoteArg(script)}`)
  const map = {}
  for (const line of (res.stdout || '').split(/\r?\n/)) {
    const [name, hash] = line.trim().split('\t')
    if (name && hash) map[name] = hash
  }
  return map
}

/**
 * 数据同步可行性（只读）：识别两侧数据库并拦截同一库、非 PostgreSQL、源版本高于目标。
 * available=false 时 reason 为用户可读原因；已识别出的一侧仍随 source / dest 返回。
 * 目标环境尚未部署时：编排里能确定唯一的数据库服务就按
 * 「应用首次启动前灌入」处理（available=true、fresh=true，dest 给出服务名与库账号），否则提示先只同步版本。
 */
async function inspectDataSync({ srcConn, dstConn, project, source, dest, srcDeployed = true, dstDeployed = true, composeText = null }) {
  const unavailable = (reason, identified = {}) => ({ available: false, reason, source: identified.source || null, dest: identified.dest || null })
  try {
    const a = await resolveSyncDatabase(srcConn, project, source)
    if (a.problem) return unavailable(srcDeployed ? `源环境${a.problem}` : '源环境尚未部署，没有可同步的数据库')
    const describedSource = await describeDatabase(srcConn, a.db)
    if (describedSource.problem) return unavailable(`源环境${describedSource.problem}`)
    const src = { ...a.db, ...describedSource }
    const b = await resolveSyncDatabase(dstConn, project, dest)
    if (b.db && sameSshHost(source, dest) && a.db.container === b.db.container && a.db.name === b.db.name) {
      return unavailable('源环境与目标环境是同一个数据库', { source: src })
    }
    if (!dstDeployed && composeText) {
      const configured = databaseFor(project, dest)
      if (configured.enabled && b.problem) return unavailable(`目标环境${b.problem}`, { source: src })
      const db = composeDatabase(composeText, b.db)
      if (db) {
        if (b.db && (b.db.name !== db.name || b.db.user !== db.user)) {
          return unavailable('目标已有数据库与本次 Compose 声明的库名或用户不一致，请先核对配置', { source: src })
        }
        return { available: true, fresh: true, reason: '', source: src, dest: db }
      }
      return unavailable('目标环境尚未部署，且无法从版本目录的编排里确定数据库服务；请先只同步版本，再同步数据库', { source: src })
    }
    if (b.problem) return unavailable(`目标环境${b.problem}`, { source: src })
    const dst = await describeDatabase(dstConn, b.db)
    if (dst.problem) return unavailable(`目标环境${dst.problem}`, { source: src })
    const major = (version) => Number.parseInt(version, 10) || 0
    if (major(src.version) > major(dst.version)) {
      return unavailable(`源数据库 PostgreSQL ${src.version} 高于目标 ${dst.version}，无法保证导入成功`, { source: src, dest: { ...b.db, ...dst } })
    }
    return { available: true, reason: '', source: src, dest: { ...b.db, ...dst } }
  } catch (err) {
    return unavailable((err && err.message) || String(err))
  }
}

/** 环境同步预检（只读，不改服务器）：两侧当前版本、可搬运来源、数据库识别与全部阻塞项 */
async function promotePreview(projectId, { sourceTargetId, destTargetId } = {}) {
  const project = projects.list().find((p) => p.id === projectId)
  if (!project) return { ok: false, error: '项目配置不存在，请重新保存' }
  let pair
  try {
    pair = promoteEnvironments(project, sourceTargetId, destTargetId)
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
  const { source, dest, problems } = pair
  const mode = deployModeOf(project)
  const sameServer = sameEndpoint(source, dest)
  const preview = {
    ok: true, mode, sameServer,
    source: { targetId: source.id, name: source.name, host: String((source.server || {}).host || ''), remotePath: source.remotePath, version: '', package: '' },
    dest: { targetId: dest.id, name: dest.name, host: String((dest.server || {}).host || ''), remotePath: dest.remotePath, version: '' },
    needDeploy: false,
    dataSync: { available: false, reason: '', source: null, dest: null },
    warnings: [],
    problems,
  }
  if (problems.length) return preview
  let srcConn = null
  let dstConn = null
  try {
    srcConn = await connectProjectTarget(project, source)
    dstConn = sameServer ? srcConn : await connectProjectTarget(project, dest)
    preview.source.version = await readCurrentVersion(srcConn, source.remotePath, mode)
    if (!preview.source.version) throw new Error(`源环境「${source.name}」尚未发布任何版本`)
    if (!safeReleaseName(preview.source.version)) throw new Error('源环境的版本目录名含非法字符')
    const info = await inspectSourceRelease(srcConn, source.remotePath, preview.source.version)
    if (info.missing) throw new Error(`源环境版本目录不存在：releases/${preview.source.version}`)
    if (info.links.length) throw new Error(`源环境版本目录含指向源环境的链接：${info.links.join('；')}`)
    preview.source.package = info.package ? 'kept' : 'archive'
    const releaseDir = ssh.remoteJoin(source.remotePath, 'releases', preview.source.version)
    const composeFile = mode === 'docker' ? await findReleaseCompose(srcConn, releaseDir, project.composeFile) : ''
    if (mode === 'docker' && !composeFile) {
      throw new Error(`源环境版本目录中没有 Compose 文件（${project.composeFile || 'docker-compose.yml'}）`)
    }
    preview.dest.version = await readCurrentVersion(dstConn, dest.remotePath, mode)
    preview.needDeploy = preview.dest.version !== preview.source.version
    // 版本已一致时不会打包，不必提醒
    if (!info.package && preview.needDeploy) preview.warnings.push('该版本发布时未留存原始发布包，将重新打包服务器上的版本目录')
    if (preview.needDeploy && composeFile) {
      // 目标服务器必须预先具备、而发布流程不会创建的东西：缺外部网络服务启动必然失败，缺宿主机目录只会被建成空目录
      const missing = await checkDestPrerequisites(dstConn, await readReleasePrerequisites(srcConn, releaseDir, composeFile))
      for (const name of missing.networks) preview.problems.push(`目标服务器缺少编排声明的外部网络：${name}（服务启动会失败，请先在目标服务器创建）`)
      for (const dir of missing.paths) preview.warnings.push(`目标服务器缺少编排挂载的宿主机目录：${dir}（发布时会被建成空目录，需要的内容请提前放到目标服务器）`)
    }
    preview.dataSync = await inspectDataSync({
      srcConn, dstConn, project, source, dest,
      srcDeployed: !!preview.source.version, dstDeployed: !!preview.dest.version,
      composeText: composeFile ? await readRemoteText(srcConn, ssh.remoteJoin(releaseDir, composeFile)) : null,
    })
    if (preview.dataSync.available) {
      const a = preview.dataSync.source
      const b = preview.dataSync.dest
      if (!preview.dataSync.fresh && (a.encoding !== b.encoding || a.collate !== b.collate)) {
        preview.warnings.push(`数据库字符集或排序规则不同（源 ${a.encoding}/${a.collate}，目标 ${b.encoding}/${b.collate}）`)
      }
      // 应用密钥各环境独立生成时，用密钥加密保存的数据换环境后无法解开；运行配置不随数据同步，必须提前说明
      const srcKeys = await secretEnvKeys(srcConn, source.remotePath)
      const dstKeys = await secretEnvKeys(dstConn, dest.remotePath)
      const differing = Object.keys(srcKeys).filter((name) => dstKeys[name] && dstKeys[name] !== srcKeys[name])
      if (differing.length) {
        preview.warnings.push(`两侧运行配置中 ${differing.join('、')} 取值不同：数据库里若有用这些密钥加密保存的内容，同步后需在目标环境对齐`)
      }
    } else if (!preview.needDeploy) {
      preview.problems.push('目标环境已是该版本，没有可同步的内容')
    }
  } catch (err) {
    preview.problems.push((err && err.message) || String(err))
  } finally {
    ssh.close(srcConn)
    if (dstConn !== srcConn) ssh.close(dstConn)
  }
  return preview
}

function promote(projectId, { sourceTargetId, destTargetId, options, requestId } = {}) {
  const plan = { sourceTargetId, destTargetId, options: options || {} }
  return withRun(projectId, destTargetId, 'promote', (operation) => runPromotion(operation, plan), {
    requestId, version: String(plan.options.expectedVersion || ''),
  })
}

async function runPromotion(operation, { sourceTargetId, options = {} }) {
  const { project, target: dest, record, tracker, log, finish, controller, publish, id: runId } = operation
  const isCanceled = () => controller.signal.aborted
  const syncData = options.syncData === true
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
  let srcConn = null
  let dstConn = null
  let localPackage = ''
  let remotePackage = ''
  let remoteDump = ''
  let remoteDataScript = ''
  let deployed = false
  let synced = false

  try {
    // ── 阶段 1：检查源环境与目标环境 ─────────────────────────────
    tracker.begin('check')
    const t0 = Date.now()
    if (isCanceled()) return finish('canceled', '任务尚未执行')
    if (project.configMode === 'quick' && project.localPath && fs.existsSync(project.localPath)) {
      // 与发布一致：极简配置在执行前按项目重新生成目标环境的派生配置
      const gen = await aiDeploy.generateQuickConfig(project.id, dest.id, { log })
      if (!gen.ok) throw new Error(gen.error || '自动生成部署配置失败')
      Object.assign(project, gen.project)
      const freshTarget = (gen.project.targets || []).find((t) => t.id === dest.id) || (gen.project.targets || [])[0]
      if (freshTarget) Object.assign(dest, freshTarget)
    } else if (project.configMode === 'quick') {
      log('warn', '本地项目目录不可用，沿用已保存的部署配置')
    }
    if (isCanceled()) throw new Error('同步已取消')
    // 同步的版本目录名就是源环境当前版本，不能带上以往自动发布留下的版本目录后缀
    delete project.releaseId
    const mode = deployModeOf(project)
    const { source, problems } = promoteEnvironments(project, sourceTargetId, dest.id)
    if (problems.length) {
      for (const problem of problems) log('error', problem)
      tracker.end('check', 'failed', t0)
      return finish('failed', problems[0])
    }
    const sameServer = sameEndpoint(source, dest)
    if (sameServer) {
      dstConn = operation.conn = await connectProjectTarget(project, dest)
      srcConn = dstConn
    } else {
      srcConn = await connectProjectTarget(project, source)
      operation.auxConns.push(srcConn)
      dstConn = operation.conn = await connectProjectTarget(project, dest)
    }
    if (isCanceled()) throw new Error('同步已取消')
    const sourceVersion = await readCurrentVersion(srcConn, source.remotePath, mode)
    if (!sourceVersion) throw new Error(`源环境「${source.name}」尚未发布任何版本`)
    if (!safeReleaseName(sourceVersion)) throw new Error('源环境的版本目录名含非法字符')
    if (options.expectedVersion && options.expectedVersion !== sourceVersion) {
      throw new Error(`源环境版本已变化（确认 ${options.expectedVersion}，当前 ${sourceVersion}），请重新检查`)
    }
    const releaseInfo = await inspectSourceRelease(srcConn, source.remotePath, sourceVersion)
    if (releaseInfo.missing) throw new Error(`源环境版本目录不存在：releases/${sourceVersion}`)
    if (releaseInfo.links.length) throw new Error(`源环境版本目录含指向源环境的链接：${releaseInfo.links.join('；')}`)
    const composeFile = mode === 'docker'
      ? await findReleaseCompose(srcConn, ssh.remoteJoin(source.remotePath, 'releases', sourceVersion), project.composeFile) : ''
    if (mode === 'docker' && !composeFile) {
      throw new Error(`源环境版本目录中没有 Compose 文件（${project.composeFile || 'docker-compose.yml'}）`)
    }
    const destVersion = await readCurrentVersion(dstConn, dest.remotePath, mode)
    if (typeof options.expectedDestVersion === 'string' && options.expectedDestVersion !== destVersion) {
      throw new Error(`目标环境版本已变化（确认 ${options.expectedDestVersion || '未部署'}，当前 ${destVersion || '未部署'}），请重新检查`)
    }
    const needDeploy = destVersion !== sourceVersion
    if (needDeploy && mode === 'docker') {
      // 目标服务器的前提在动服务器之前核对：缺外部网络时服务启动必然失败，不必等镜像构建完才发现
      const missing = await checkDestPrerequisites(dstConn, await readReleasePrerequisites(srcConn, ssh.remoteJoin(source.remotePath, 'releases', sourceVersion), composeFile))
      for (const dir of missing.paths) log('warn', `目标服务器缺少编排挂载的宿主机目录：${dir}（发布时会被建成空目录，需要的内容请提前放到目标服务器）`)
      if (missing.networks.length) {
        throw new Error(`目标服务器缺少编排声明的外部网络：${missing.networks.join('、')}（服务启动会失败，请先在目标服务器创建后再同步）`)
      }
    }
    record.version = sourceVersion
    record.releaseId = sourceVersion
    record.oldVersion = destVersion
    record.sourceTargetId = source.id
    record.sourceTargetName = source.name
    // 界面据此区分「版本已切换」与「只同步数据」，失败时同样能判断服务器处于哪种状态
    record.deployed = false
    record.dataSynced = false
    let srcDb = null
    let dstDb = null
    let preload = null
    if (syncData) {
      const plan = await inspectDataSync({
        srcConn, dstConn, project, source, dest, dstDeployed: !!destVersion,
        composeText: composeFile ? await readRemoteText(srcConn, ssh.remoteJoin(source.remotePath, 'releases', sourceVersion, composeFile)) : null,
      })
      if (!plan.available) throw new Error(`数据同步不可用：${plan.reason}`)
      srcDb = plan.source
      dstDb = plan.dest
      // 全新目标：数据库随本次发布才会创建。把「先发版本、再灌数据」倒过来——
      // 先把源库灌进去再启动应用，否则应用得先在空库上启动（很多应用空库根本起不来，或要跑漫长的初始化）
      if (plan.fresh) preload = { db: plan.dest }
    }
    if (!needDeploy && !syncData) throw new Error(`目标环境已是该版本（${destVersion}），没有可同步的内容`)
    if (!destVersion && !syncData && composeFile) log('warn', '目标环境尚未部署，仅同步版本可能触发空库初始化')
    if (composeFile && composeFile !== String(project.composeFile || '').trim()) log('warn', `配置的 Compose 文件不在版本目录中，改用 ${composeFile}`)
    log('info', `源环境「${source.name}」当前版本 ${sourceVersion}（${releaseInfo.package ? '留存原始发布包' : '重新打包版本目录'}），目标环境「${dest.name}」当前版本 ${destVersion || '无'}`)
    if (syncData && preload) log('info', `数据同步：${srcDb.container}/${srcDb.name}（PostgreSQL ${srcDb.version}）→ 全新目标，数据库服务 ${preload.db.service} 里的 ${preload.db.name}（应用首次启动前灌入）`)
    else if (syncData) log('info', `数据同步：${srcDb.container}/${srcDb.name}（PostgreSQL ${srcDb.version}）→ ${dstDb.container}/${dstDb.name}（PostgreSQL ${dstDb.version}）`)
    log('success', needDeploy ? '环境检查通过' : '目标环境已是该版本，跳过版本同步')
    tracker.end('check', 'success', t0)

    let pack = null
    if (needDeploy) {
      // ── 阶段 2：把源环境的版本搬到目标环境的上传目录 ─────────────
      tracker.begin('package')
      const t1 = Date.now()
      // 留存包文件名是 <版本目录名>.<扩展名>；重新打包的固定为 tar.gz
      const ext = releaseInfo.package ? path.posix.basename(releaseInfo.package).slice(sourceVersion.length + 1) : 'tar.gz'
      const fileName = `promote_${runId}.${ext}`
      remotePackage = ssh.remoteJoin(dest.remotePath, 'uploads', fileName)
      await ssh.mkdirp(dstConn, ssh.remoteJoin(dest.remotePath, 'uploads'))
      const uploadPercent = (done, total) => publish('deploy:progress', { kind: 'upload', percent: total ? Math.round((done / total) * 100) : 0 })
      if (sameServer) {
        log('info', releaseInfo.package ? '源环境与目标环境在同一台服务器，复制留存的原始发布包……' : '源环境与目标环境在同一台服务器，正在打包版本目录……')
        const made = await ssh.exec(dstConn, releaseInfo.package
          ? `cp -f ${quoteArg(releaseInfo.package)} ${quoteArg(remotePackage)} && sha256sum ${quoteArg(releaseInfo.package)} ${quoteArg(remotePackage)} | awk '{print $1}' && echo __PACKAGE_OK__`
          : `bash -c ${quoteArg(buildReleaseArchiveScript(source.remotePath, sourceVersion, remotePackage, { flat: mode === 'docker' }))} && sha256sum ${quoteArg(remotePackage)} | awk '{print $1}' && echo __PACKAGE_OK__`)
        const sums = (made.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[a-f0-9]{64}$/.test(line))
        const sha256 = sums[releaseInfo.package ? 1 : 0] || ''
        if (made.code !== 0 || !/__PACKAGE_OK__|__ARCHIVE_OK__/.test(made.stdout || '') || !sha256 || (releaseInfo.package && sums[0] !== sha256)) {
          throw new Error(`生成发布包失败：${(made.stderr || '').trim().slice(0, 300) || `退出码 ${made.code}`}`)
        }
        pack = { fileName, zipPath: '', sha256, keepLocal: true }
      } else {
        // 跨服务器：发布包经本机中转，两端各算一次 SHA256
        localPackage = path.join(os.tmpdir(), `plm-env-sync-${runId}.${ext}`)
        const fetched = await ssh.execToFile(srcConn, releaseInfo.package
          ? `cat ${quoteArg(releaseInfo.package)}`
          : `bash -c ${quoteArg(buildReleaseArchiveScript(source.remotePath, sourceVersion, '', { flat: mode === 'docker', toStdout: true }))}`, localPackage)
        if (fetched.code !== 0 || !fetched.bytes || (!releaseInfo.package && !/__ARCHIVE_OK__/.test(fetched.stderr || ''))) {
          throw new Error(`获取发布包失败：${(fetched.stderr || '').trim().slice(0, 300) || `退出码 ${fetched.code}`}`)
        }
        pack = { fileName, zipPath: localPackage, sha256: await sha256File(localPackage), keepLocal: false }
      }
      log('success', `发布包就绪：${releaseInfo.package ? path.posix.basename(releaseInfo.package) : `${sourceVersion}.tar.gz`}`)
      tracker.end('package', 'success', t1)

      // ── 阶段 3：部署脚本与发布包就位 ────────────────────────────
      tracker.begin('upload')
      const t2 = Date.now()
      await ssh.mkdirp(dstConn, ssh.remoteJoin(dest.remotePath, 'deployer'))
      const scriptRemote = ssh.remoteJoin(dest.remotePath, 'deployer', 'deploy.sh')
      log('info', '上传部署脚本……')
      await uploadTextFile(dstConn, readDeployScript(), scriptRemote)
      if (localPackage) {
        log('info', `正在传输发布包到 ${dest.name}……`)
        await ssh.upload(dstConn, localPackage, remotePackage, uploadPercent)
        const sum = await ssh.exec(dstConn, `sha256sum ${quoteArg(remotePackage)} | awk '{print $1}'`)
        const remoteSha = (sum.stdout || '').trim()
        if (remoteSha !== pack.sha256) throw new Error(`发布包传输校验失败（本机 ${pack.sha256.slice(0, 8)} / 目标 ${remoteSha.slice(0, 8)}）`)
        log('success', '发布包 SHA256 校验通过')
      }
      // 全新目标 + 同步数据：先把源库导出到目标服务器，并备好服务器脚本——
      // 部署脚本会在镜像构建之后、启动服务之前执行它，把数据库灌好再拉起应用
      if (preload) {
        log('info', `全新目标环境：先把【${source.name}】的数据库 ${srcDb.name} 灌入【${dest.name}】的数据库服务 ${preload.db.service}，再启动应用……`)
        preload.srcCount = await countDatabaseRows(srcConn, srcDb)
        preload.dumpFile = ssh.remoteJoin(dest.remotePath, 'uploads', `promote_${runId}.sql`)
        remoteDump = preload.dumpFile
        await exportDatabaseToDest({ srcConn, dstConn, srcDb, dumpFile: preload.dumpFile })
        preload.guardName = `db_guard_${stamp}_${runId}.sql`
        remoteDataScript = pack.dataSyncScript = ssh.remoteJoin(dest.remotePath, 'deployer', `data-sync-${runId}.sh`)
        await uploadTextFile(dstConn, buildPreloadScript({
          home: dest.remotePath, release: ssh.remoteJoin(dest.remotePath, 'releases', sourceVersion), composeFile, db: preload.db,
          dumpFile: preload.dumpFile, guardName: preload.guardName, runId, sourceVersion: srcDb.version,
        }), pack.dataSyncScript)
        log('success', `源数据库已导出到目标服务器：${path.posix.basename(preload.dumpFile)}`)
      }
      tracker.end('upload', 'success', t2)

      // ── 阶段 4~8：目标环境按常规发布流程切换版本 ─────────────────
      if (isCanceled()) throw new Error('同步已取消')
      if (await readCurrentVersion(dstConn, dest.remotePath, mode) !== destVersion) throw new Error('准备发布期间目标环境版本已变化，请重新检查')
      if (composeFile) project.composeFile = composeFile
      const args = [...buildDeployArgs(project, dest, pack, sourceVersion), '--expected-current', destVersion]
      const cmd = `bash ${quoteArg(scriptRemote)} ${args.map(quoteArg).join(' ')}`
      const res = await execDeployScript(dstConn, cmd, tracker, resultBox, log)
      if (preload && resultBox.dataSynced) {
        synced = true
        record.dataSynced = true
        remoteDump = ''
      }
      if (preload && resultBox.dataGuard) record.dataGuard = resultBox.dataGuard
      if (!(resultBox.ok && res.code === 0)) {
        if (tracker.state.datasync.status === 'waiting') tracker.end('datasync', 'skipped')
        for (const s of STAGES) {
          if (tracker.state[s.id].status === 'running') tracker.end(s.id, resultBox.rolledBack ? 'rollback' : 'failed')
        }
        const msg = `${synced ? '数据库已灌入，' : ''}${resultBox.message || `部署脚本退出码 ${res.code}`}`
        log('error', msg)
        return finish(resultBox.rolledBack ? 'rolled_back' : 'failed', msg)
      }
      for (const s of ['backup', 'extract', 'build', 'start', 'health']) {
        const status = tracker.state[s] ? tracker.state[s].status : ''
        if (status === 'running') tracker.end(s, 'success')
        else if (status === 'waiting') tracker.end(s, s === 'health' || (mode === 'script' && (s === 'build' || s === 'backup')) ? 'skipped' : 'success')
      }
      // 版本此刻已在目标环境生效：后续数据同步或 OpenClaw 校验失败时，界面与历史据此判断服务器状态
      deployed = true
      record.deployed = true
      remotePackage = ''
      if (dest.openclaw && dest.openclaw.enabled && !resultBox.openclawSynced) throw new Error('服务器未确认 OpenClaw 同步完成，不能将本次同步视为成功')
      log('success', `版本已同步：${dest.name} 当前版本 ${sourceVersion}`)
      if (preload) {
        // 数据是部署脚本在应用首次启动前灌入的：脚本确认过才算完成
        if (!resultBox.dataSynced) throw new Error('服务器未确认启动前的数据灌入完成，不能将数据同步视为成功')
        const dstCount = await countDatabaseRowsCompose(dstConn, { release: ssh.remoteJoin(dest.remotePath, 'releases', sourceVersion), composeFile, db: preload.db })
        logRowCounts(log, preload.srcCount, dstCount)
      }
    } else {
      for (const id of ['package', 'upload', 'backup', 'extract', 'build', 'start', 'health', 'openclaw']) tracker.end(id, 'skipped')
    }

    // ── 阶段 9：数据同步（已有运行版本的目标环境：新版本启动之后，再灌入同版本的数据库内容） ──
    if (syncData && !preload) {
      tracker.begin('datasync')
      const tds = Date.now()
      try {
        if (isCanceled()) throw new Error('同步已取消（目标数据库未改动）')
        const current = await readCurrentVersion(dstConn, dest.remotePath, mode)
        if (current !== (needDeploy ? sourceVersion : destVersion)) throw new Error('目标环境版本已变化，目标数据库未改动，请重新检查')
        await syncDatabaseData({ srcConn, dstConn, project, dest, srcDb, dstDb, runId, stamp, log, isCanceled, onImported: (guardName) => {
          record.dataGuard = guardName
          synced = true
          record.dataSynced = true
        } })
        tracker.end('datasync', 'success', tds)
      } catch (dsErr) {
        tracker.end('datasync', 'failed', tds)
        const msg = (dsErr && dsErr.message) || String(dsErr)
        log('error', `数据同步失败: ${msg}`)
        if (synced) log('warn', `目标库已更新，可用保底备份 ${record.dataGuard} 恢复同步前的数据`)
        return finish('failed', `${deployed ? '版本已发布，' : ''}数据同步失败：${msg}`)
      }
    } else if (tracker.state.datasync.status === 'waiting') {
      // 全新目标的灌库由部署脚本在启动服务之前完成并已标记成功，这里不再覆盖
      tracker.end('datasync', 'skipped')
    }
    if (isCanceled()) return finish('canceled', '同步已取消')
    const parts = []
    if (deployed) parts.push(`版本 ${sourceVersion} 已发布到 ${dest.name}`)
    if (synced) parts.push(preload
      ? `数据库 ${preload.db.name} 已同步到 ${dest.name}（应用首次启动前灌入）`
      : `数据库 ${dstDb.name} 已同步到 ${dstDb.container}`)
    log('success', `环境同步完成：${parts.join('，')}`)
    return finish('success', `环境同步完成：${parts.join('，')}`)
  } catch (err) {
    if (isCanceled()) {
      log('warn', '同步已取消')
      return finish('canceled', '同步已取消')
    }
    const msg = (err && err.message) || String(err)
    log('error', `环境同步异常: ${msg}`)
    for (const s of STAGES) {
      if (tracker.state[s.id].status === 'running') tracker.end(s.id, 'failed')
    }
    return finish('failed', `${deployed ? '版本已发布，' : ''}${msg}`)
  } finally {
    // 中转文件与未被部署脚本消费的发布包、数据库导出随手清理；用户取消时不碰服务器（脚本可能正在回滚）
    if (localPackage) {
      try { fs.rmSync(localPackage, { force: true }) } catch { /* 本机临时文件清理失败不影响结果 */ }
    }
    if (dstConn && !isCanceled()) {
      for (const file of [remotePackage, remoteDump, remoteDataScript].filter(Boolean)) {
        try { await ssh.exec(dstConn, `rm -f ${quoteArg(file)}`) } catch { /* 服务器残留由部署脚本的历史包清理兜底 */ }
      }
    }
  }
}

/**
 * 把源环境的数据库灌入目标环境：导出到目标环境 backups/db_sync_*.sql → 校验导出完整 →
 * 保底备份目标库后重建灌入 → 重启应用容器 → 核对行数 → 等待健康检查。返回保底备份文件名。
 */
async function syncDatabaseData({ srcConn, dstConn, project, dest, srcDb, dstDb, runId, stamp, log, isCanceled, onImported }) {
  const dumpName = `db_sync_${stamp}_${runId}.sql`
  const dumpFile = ssh.remoteJoin(dest.remotePath, 'backups', dumpName)
  const srcCount = await countDatabaseRows(srcConn, srcDb)
  await exportDatabaseToDest({ srcConn, dstConn, srcDb, dumpFile })
  if (isCanceled()) throw new Error('同步已取消（目标数据库未改动）')
  log('success', `源数据库已导出：${dumpName}`)
  const guardName = await replaceDatabaseWithSql(dstConn, project, dest, dstDb, dumpFile, { stamp, runId, log, onImported })
  if (await waitDatabaseReady(dstConn, dstDb)) logRowCounts(log, srcCount, await countDatabaseRows(dstConn, dstDb))
  else throw new Error(`数据已灌入，但数据库重启后未在 60 秒内就绪（保底备份 ${guardName}）`)

  const health = healthFor(project, dest)
  if (health.enabled && health.url && !(await waitForHttpHealth(dstConn, health.url, health.timeout, health.interval))) {
    throw new Error(`数据已灌入，但应用健康检查未通过：${health.url}（可用保底备份 ${guardName} 恢复）`)
  }
  log('success', `数据同步完成，目标数据库同步前的保底备份：${guardName}`)
}

/** 逐表精确行数的核对结果写进日志：不一致只提醒（源环境在导出期间可能有写入） */
function logRowCounts(log, srcCount, dstCount) {
  if (!srcCount || !dstCount) {
    log('warn', '未能完成逐表行数核对，请检查数据库权限或查询超时')
    return
  }
  const tables = new Set([...srcCount.counts.keys(), ...dstCount.counts.keys()])
  const difference = [...tables].filter((name) => srcCount.counts.get(name) !== dstCount.counts.get(name)).length
  if (!difference) {
    log('success', `行数核对一致：${dstCount.tables} 张表 ${dstCount.rows} 行`)
  } else {
    log('warn', `行数核对不一致：${difference} 张表有差异，源 ${srcCount.tables} 张表 ${srcCount.rows} 行，目标 ${dstCount.tables} 张表 ${dstCount.rows} 行（源环境在同步期间可能有写入，请核对）`)
  }
}

/** 全新目标环境里数据库是按编排服务名操作的（容器随本次发布才创建，没有可用的容器名）：用 compose exec 做同样的行数统计 */
async function countDatabaseRowsCompose(conn, { release, composeFile, db }) {
  try {
    const res = await ssh.exec(conn, `cd ${quoteArg(release)} && docker compose -f ${quoteArg(composeFile)} exec -T ${quoteArg(db.service)} psql -U ${quoteArg(db.user)} -d ${quoteArg(db.name)} -At -v ON_ERROR_STOP=1 -c ${quoteArg("SET statement_timeout = '120s'")} -c ${quoteArg(ROW_COUNT_SQL)}`)
    return parseRowCounts(res)
  } catch {
    return null
  }
}

/**
 * 把源环境的数据库导出到目标服务器上的某个文件（数据同步放 backups/db_sync_*.sql；
 * 全新目标先灌数据时放 uploads/）。同一台服务器直接落盘，跨服务器经本机中转并两端核对 SHA256；
 * 导出缺少结束标记即视为不完整并删除。此步不改动目标数据库。
 * 导出去掉属主与权限语句：目标库对象归目标库用户所有，不依赖源库的角色。
 */
async function exportDatabaseToDest({ srcConn, dstConn, srcDb, dumpFile }) {
  const dump = postgresCommand('docker', srcDb, 'pg_dump', ['--no-owner', '--no-privileges', '-U', srcDb.user, '--', srcDb.name])
  await ssh.mkdirp(dstConn, path.posix.dirname(dumpFile))
  const created = await ssh.exec(dstConn, `umask 077; (set -C; : > ${quoteArg(dumpFile)})`)
  if (created.code !== 0) throw new Error('无法创建受限权限的目标数据库导出文件（目标数据库未改动）')
  let completed = false
  try {
    if (srcConn === dstConn) {
      const res = await ssh.exec(dstConn, `${dump} > ${quoteArg(dumpFile)}`)
      if (res.code !== 0) {
        throw new Error(`源数据库导出失败：${(res.stderr || '').trim().slice(0, 300) || `退出码 ${res.code}`}（目标数据库未改动）`)
      }
    } else {
      const local = path.join(os.tmpdir(), `plm-env-sync-${crypto.randomBytes(6).toString('hex')}.sql`)
      try {
        const got = await ssh.execToFile(srcConn, dump, local)
        if (got.code !== 0 || !got.bytes) {
          throw new Error(`源数据库导出失败：${(got.stderr || '').trim().slice(0, 300) || `退出码 ${got.code}`}（目标数据库未改动）`)
        }
        await ssh.upload(dstConn, local, dumpFile)
        const sum = await ssh.exec(dstConn, `sha256sum ${quoteArg(dumpFile)} | awk '{print $1}'`)
        if (sum.code !== 0 || (sum.stdout || '').trim() !== await sha256File(local)) throw new Error('数据库导出传输校验失败（目标数据库未改动）')
      } finally {
        try { fs.rmSync(local, { force: true }) } catch { /* 本机临时文件清理失败不影响结果 */ }
      }
    }
    const complete = await ssh.exec(dstConn, `tail -c 400 ${quoteArg(dumpFile)} | grep -q 'PostgreSQL database dump complete'`)
    if (complete.code !== 0) throw new Error('源数据库导出不完整（缺少结束标记），目标数据库未改动')
    completed = true
  } finally {
    if (!completed) {
      try { await ssh.exec(dstConn, `rm -f ${quoteArg(dumpFile)}`) } catch { /* 保留原始错误 */ }
    }
  }
}

/**
 * 全新目标环境的数据库参数：从源环境版本目录的编排里找唯一的 PostgreSQL 服务，取服务名与库账号。
 * 服务名用来在应用首次启动前单独拉起数据库（docker compose exec 按服务名操作，不需要容器名）。
 * 库账号在编排里写成变量引用时无法提前解析，退回目标环境手动配置的值；确定不了返回 null。
 */
function composeDatabase(composeText, fallback = {}) {
  let doc
  try { doc = parseYaml(composeText) } catch { return null }
  const found = Object.entries((doc && doc.services) || {}).filter(([, service]) => databaseEngine(service && service.image) === 'postgres')
  if (found.length !== 1) return null
  const [service, spec] = found[0]
  const env = {}
  for (const item of [].concat(spec.environment || [])) {
    if (typeof item === 'string' && item.includes('=')) {
      const index = item.indexOf('=')
      env[item.slice(0, index).trim()] = item.slice(index + 1).trim()
    } else if (item && typeof item === 'object') {
      Object.assign(env, item)
    }
  }
  const literal = (value, fallbackValue) => (typeof value === 'string' && value.trim() && !value.includes('${') ? value.trim() : fallbackValue)
  const user = String(literal(env.POSTGRES_USER, fallback.user) || 'postgres')
  const name = String(literal(env.POSTGRES_DB, fallback.name) || user)
  if (!/^[a-zA-Z0-9_]+$/.test(service) || [user, name].some((value) => !value || /[\x00-\x1f\x7f'"\\]/.test(value))) return null
  return { service, user, name, type: 'postgres', fresh: true }
}

/**
 * 全新目标环境「先灌数据再启动应用」的服务器脚本：部署脚本在镜像构建之后、docker compose up 之前执行它。
 * 单独拉起数据库服务 → 等它可连接 → 目标库里若已有内容（如上次中断的残留）先保底备份 →
 * 重建空库 → 灌入源库导出。应用第一次启动时数据库已就绪，不必在空库上先跑一遍初始化。
 */
function buildPreloadScript({ home, release, composeFile, db, dumpFile, guardName, runId, sourceVersion }) {
  const compose = `docker compose -f ${quoteArg(composeFile)}`
  const psql = (args) => `${compose} exec -T ${quoteArg(db.service)} psql -U ${quoteArg(db.user)} -v ON_ERROR_STOP=1 -q ${args}`
  // 维护连接不能连接即将改名的数据库。
  const maintenance = db.name === 'postgres' ? 'template1' : 'postgres'
  const maintenanceSql = (sql) => psql(`-d ${quoteArg(maintenance)} -c ${quoteArg(sql)}`)
  const guardPath = ssh.remoteJoin(home, 'backups', guardName)
  const sourceMajor = Number.parseInt(sourceVersion, 10) || 0
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `cd ${quoteArg(release)}`,
    'log() { echo "[数据] $*"; }',
    `log "启动数据库服务 ${db.service}…"`,
    `${compose} up -d ${quoteArg(db.service)} >/dev/null`,
    'ready=0',
    'for i in $(seq 1 90); do',
    `  if ${compose} exec -T ${quoteArg(db.service)} pg_isready -U ${quoteArg(db.user)} >/dev/null 2>&1; then ready=1; break; fi`,
    '  sleep 2',
    'done',
    '[ "$ready" = 1 ] || { echo "[ERROR] 数据库服务 180 秒内未就绪"; exit 1; }',
    `target_version=$(${psql(`-d ${quoteArg(maintenance)} -Atc 'SHOW server_version_num'`)} </dev/null)`,
    `[[ "$target_version" =~ ^[0-9]+$ ]] && (( target_version / 10000 >= ${sourceMajor} )) || { echo "[ERROR] 无法确认目标 PostgreSQL 版本，或其主版本低于源环境 ${sourceMajor}，目标数据库未改动"; exit 1; }`,
    `exists=$(${psql(`-d ${quoteArg(maintenance)} -Atc ${quoteArg(`SELECT count(*) FROM pg_database WHERE datname = ${sqlLiteral(db.name)}`)}`)} </dev/null)`,
    '[[ "$exists" = 0 || "$exists" = 1 ]] || { echo "[ERROR] 无法确认目标数据库是否存在"; exit 1; }',
    'if [ "$exists" = 1 ]; then',
    `  ${psql(`-d ${quoteArg(db.name)} -Atc 'SELECT 1'`)} </dev/null >/dev/null || { echo ${quoteArg(`[ERROR] 目标库 ${db.name} 已存在但无法读取，目标数据库未改动`)}; exit 1; }`,
    `  mkdir -p ${quoteArg(ssh.remoteJoin(home, 'backups'))}`,
    `  (umask 077; trap ${quoteArg(`rm -f -- ${quoteArg(`${guardPath}.partial`)}`)} EXIT; ${compose} exec -T ${quoteArg(db.service)} pg_dump -U ${quoteArg(db.user)} -- ${quoteArg(db.name)} > ${quoteArg(`${guardPath}.partial`)} && mv -- ${quoteArg(`${guardPath}.partial`)} ${quoteArg(guardPath)})`,
    `  log ${quoteArg(`目标库已先保底备份：${guardName}`)}`,
    `  echo ${quoteArg(`__DB_GUARD__:${guardName}`)}`,
    'fi',
    'log "灌入源环境数据库……"',
    buildDatabaseSwap({ db, runId, psql: maintenanceSql, importSql: (database) => `${psql(`-d ${quoteArg(database)}`)} < ${quoteArg(dumpFile)}`, allowMissing: true }),
    `rm -f -- ${quoteArg(dumpFile)} || log '数据库导出文件清理失败'`,
    // 刚灌入的库还没有查询计划统计信息（autovacuum 要过一阵才收集）：应用一启动就查，先刷新，头几分钟不至于走错执行计划
    'log "刷新查询计划统计信息……"',
    `  ${psql(`-d ${quoteArg(db.name)} -c "ANALYZE;"`)} </dev/null || log "统计信息刷新失败（不影响已灌入的数据）"`.trim(),
    'log "数据库已就绪，接下来启动应用"',
    '',
  ].join('\n')
}

/** 容器重启后 PostgreSQL 需要几秒才接受连接：等到 pg_isready 通过或超时 */
async function waitDatabaseReady(conn, db) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const ready = await ssh.exec(conn, postgresCommand('docker', db, 'pg_isready', ['-U', db.user, '-d', db.name]))
    if (ready.code === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

/** 等目标环境的 HTTP 健康检查恢复（容器重启后应用需要启动时间） */
async function waitForHttpHealth(conn, url, timeout, interval) {
  const step = Number(interval) > 0 ? Number(interval) : 3
  const tries = Math.max(1, Math.floor((Number(timeout) || 90) / step))
  const res = await ssh.exec(conn, `for i in $(seq 1 ${tries}); do if curl -fsS --max-time 5 ${quoteArg(url)} >/dev/null 2>&1; then echo __HEALTH_OK__; exit 0; fi; sleep ${step}; done; echo __HEALTH_FAIL__; exit 1`)
  return res.code === 0 && /__HEALTH_OK__/.test(res.stdout || '')
}

module.exports = {
  run, cancel, isBusy, testConnection, listReleases, rollback, promote, promotePreview,
  keepsReleasePackage, safeReleaseName, sameEndpoint, promoteEnvironments, readCurrentVersion, inspectSourceRelease,
  findReleaseCompose, buildReleaseArchiveScript, databaseEngine, resolveSyncDatabase, inspectDataSync, composeDatabase, buildPreloadScript,
  countDatabaseRows, replaceDatabaseWithSql, newStageTracker,
  listDbBackups, restoreDbBackup, assertDbBackupName,
  setEmitter, STAGES, resolveVersion, buildDeployArgs, preCheckLocal, releaseContentProblems, findReleaseCopy, runReleasePrepare,
  resolveCompose, resolveArtifact, sha256File, releaseDirNameOf, deployModeOf, runPackageCommand,
  findGitBashDir, localShellEnv,
  getDataSync, validateDataSync, buildDataSyncCommand,
  getDataImport, renderImportCommand, ensureReleaseNotesForPackage,
}
