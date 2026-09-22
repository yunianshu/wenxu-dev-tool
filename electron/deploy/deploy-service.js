/**
 * 部署编排服务 —— 对应方案 §4/§10/§17/§27 的 DeployService：
 * 完整流程：本地检查 → 生成 ZIP → SSH 连接 → 上传+校验 → 服务器备份 →
 * 解压 → Docker 构建 → 启动 → 健康检查 → （失败自动回滚）→ 清理 → 记录历史。
 * 服务器端逻辑收敛在 deploy.sh（方案 §10.2），本模块只负责编排、日志流与阶段映射。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const { spawn } = require('child_process')
const ssh = require('./ssh-service')
const packager = require('./packager')
const projects = require('./deploy-projects')
const history = require('./history')
const releaseNotes = require('./release-notes')
const store = require('../store')
const automatic = require('./auto-deploy')
const moduleDataSync = require('./data-sync')
const { validateArtifact } = require('./artifact-check')
const { detectVersion, bumpVersionFiles } = require('./version-detector')

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
  { id: 'datasync', label: '数据同步' },
]

let emitFn = null
let activeRun = null // { id, conn, canceled }

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

function log(level, text) {
  if (activeRun?.redact) text = activeRun.redact(text)
  emit('deploy:log', { level, text, ts: ts() })
  if (logSink) logSink(level, text)
}

/** 日志落盘钩子：发布/回滚期间由运行任务设置，写历史日志用 */
let logSink = null

/** 阶段状态：running/success/failed/skipped/rollback；durationMs 仅阶段结束时非零 */
function stage(id, status, durationMs) {
  emit('deploy:stage', { stage: id, status, durationMs: durationMs || 0 })
}

function newStageTracker() {
  const state = Object.fromEntries(STAGES.map((s) => [s.id, { status: 'waiting', durationMs: 0 }]))
  const begin = (id) => { if (state[id]) { state[id].status = 'running'; stage(id, 'running') } }
  const end = (id, status, startedAt) => {
    if (state[id]) {
      state[id].status = status
      if (startedAt) state[id].durationMs = Date.now() - startedAt
      stage(id, status, state[id].durationMs)
    }
  }
  return { state, begin, end }
}

/** 判断是否被用户取消（连接被主动关闭后 exec 会抛错，用此区分报错类型） */
function isCanceled() {
  return !!(activeRun && activeRun.canceled)
}

/** 取消当前发布：断开 SSH（服务器脚本按 --auto-rollback 处理），并终止本地打包进程 */
function cancel() {
  if (!activeRun) return { ok: false, error: '当前没有进行中的发布' }
  activeRun.canceled = true
  activeRun.controller?.abort()
  if (activeRun.pkgChild) killTree(activeRun.pkgChild)
  ssh.close(activeRun.conn)
  return { ok: true }
}

function isBusy() {
  return !!activeRun
}

/** 解析脚本输出的控制标记，返回应显示的行或 null */
function parseMarker(line, tracker, resultBox) {
  const m = line.match(/^__STAGE__:([\w-]+)$/)
  if (m) {
    const map = {
      'backup-code': 'backup', 'backup-db': 'backup', extract: 'extract',
      build: 'build', start: 'start', health: 'health', rollback: 'rollback', datasync: 'datasync',
    }
    const sid = map[m[1]]
    if (sid === 'rollback') {
      log('warn', '发布失败，正在自动回滚……')
    } else if (sid) {
      if (sid === 'datasync') tracker.end('build', 'success')
      tracker.begin(sid)
    }
    return null
  }
  if (line === '__STAGE_OK__:datasync') {
    resultBox.dataSynced = true
    tracker.end('datasync', 'success')
    return null
  }
  const okM = line.match(/^__DEPLOY_OK__:(.*)$/)
  if (okM) { resultBox.ok = true; resultBox.message = okM[1] || '发布成功'; return null }
  const failM = line.match(/^__DEPLOY_FAIL__:(.*)$/)
  if (failM) { resultBox.ok = false; resultBox.message = failM[1] || '发布失败'; resultBox.rolledBack = /已自动回滚到/.test(resultBox.message); return null }
  return line
}

/** 将脚本原始输出按行分流：控制标记解析 + 带等级的日志行 */
function pipeScriptOutput(chunk, tracker, resultBox) {
  for (const raw of String(chunk).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line) continue
    const display = parseMarker(line, tracker, resultBox)
    if (display === null) continue
    let level = 'info'
    if (/^\[ERROR\]/.test(display)) level = 'error'
    else if (/^\[WARN\]/.test(display)) level = 'warn'
    else if (/^\[OK\]/.test(display)) level = 'success'
    log(level, display)
  }
}

/** SSH 数据包不等于完整行，分别缓冲两条流，避免结果标记被拆开后漏报。 */
async function execDeployScript(conn, command, tracker, resultBox) {
  const pending = { stdout: '', stderr: '' }
  const result = await ssh.exec(conn, command, (chunk, stream = 'stdout') => {
    pending[stream] += String(chunk)
    const end = pending[stream].lastIndexOf('\n')
    if (end < 0) return
    pipeScriptOutput(pending[stream].slice(0, end + 1), tracker, resultBox)
    pending[stream] = pending[stream].slice(end + 1)
  })
  for (const tail of Object.values(pending)) if (tail) pipeScriptOutput(tail, tracker, resultBox)
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
 * 执行项目打包命令（script 形态产物缺失时自动构建）：
 * 在项目根以 shell 运行 packageCommand，输出按行流到发布日志（[打包] 前缀）；
 * 超时杀整棵进程树；用户取消时同样终止。返回 { ok, problem? }。
 */
function runPackageCommand(project) {
  const sm = project.scriptMode || {}
  const cmd = String(sm.packageCommand || '').trim()
  const timeoutMs = Math.max(30, Number(sm.packageTimeoutSec) || 900) * 1000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, { shell: true, cwd: project.localPath, env: process.env, windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, problem: `打包命令无法启动: ${(e && e.message) || e}` })
    }
    if (activeRun) activeRun.pkgChild = child
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (activeRun && activeRun.pkgChild === child) activeRun.pkgChild = null
      resolve(r)
    }
    const timer = setTimeout(() => {
      log('error', `打包超时（>${timeoutMs / 1000}s），终止进程树……`)
      killTree(child)
      finish({ ok: false, problem: `打包命令超时（>${Math.round(timeoutMs / 1000)} 秒）已终止，可调整超时或检查构建环境` })
    }, timeoutMs)
    // 按行流式转发（npm/vite 的 \r 进度条会被行缓冲自然吸收）
    let pending = { out: '', err: '' }
    const pump = (key, chunk) => {
      if (isCanceled()) { killTree(child); return }
      pending[key] += String(chunk)
      const lines = pending[key].split(/\r?\n/)
      pending[key] = lines.pop() || ''
      for (const line of lines) if (line.trim()) log('info', `[打包] ${line.replace(/\s+$/, '').slice(0, 500)}`)
    }
    child.stdout.on('data', (c) => pump('out', c))
    child.stderr.on('data', (c) => pump('err', c))
    child.on('error', (e) => finish({ ok: false, problem: `打包命令执行失败: ${(e && e.message) || e}` }))
    child.on('close', (code) => {
      for (const key of ['out', 'err']) {
        if (pending[key].trim()) log('info', `[打包] ${pending[key].trim().slice(0, 500)}`)
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

/**
 * 执行完整发布（按部署目标）。所有事件经 emit 推送：
 *   deploy:stage {stage,status} / deploy:log {level,text,ts}
 *   deploy:progress {kind,percent} / deploy:done {record}
 */
async function run(projectId, targetId) {
  if (activeRun) throw new Error('已有发布任务进行中，请等待完成或取消')
  const list = projects.list()
  const project = list.find((p) => p.id === projectId)
  if (!project) throw new Error('项目配置不存在，请重新保存')
  const target = getTarget(project, targetId)
  if (!target) throw new Error('项目缺少部署目标，请先在配置中添加')
  const creds = projects.getCredentials(projectId, target.id) || { password: '', passphrase: '' }

  const runId = crypto.randomBytes(6).toString('hex')
  const tracker = newStageTracker()
  const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
  const logBuf = []
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)

  const record = {
    id: runId,
    projectId: project.id,
    projectName: project.name,
    targetId: target.id,
    targetName: target.name,
    type: 'deploy',
    version: '',
    oldVersion: '',
    status: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
    durationMs: 0,
    host: `${target.server.host}:${target.server.port}`,
    remotePath: target.remotePath,
    message: '',
    logFile: '',
    stages: tracker.state,
  }

  const finish = (status, message) => {
    record.status = status
    record.message = message || record.message
    record.finishedAt = Date.now()
    record.durationMs = record.finishedAt - record.startedAt
    record.logFile = history.writeLog(runId, logBuf.join('\n'))
    history.add(record)
    // 发布成功且采集到提交：后台整理成通俗中文更新说明（AI 优先、失败退回本地整理），
    // 生成后再通知渲染层刷新历史；不阻塞发布完成事件
    if (status === 'success' && Array.isArray(record.gitCommits) && record.gitCommits.length) {
      releaseNotes.enrichRecord(record.id, () => emit('deploy:history:updated', { id: record.id }))
    }
    activeRun = null
    emit('deploy:done', { record: JSON.parse(JSON.stringify(record)) })
    return JSON.parse(JSON.stringify(record))
  }

  let conn = null
  let pack = null
  let dataPack = null
  let prepared = null
  let buildWorkspace = null
  const autoMode = project.deployMode === 'auto'
  const controller = new AbortController()
  activeRun = { id: runId, conn: null, canceled: false, controller }
  const setC = (c) => { if (activeRun) activeRun.conn = c; conn = c }

  try {
    // ── 阶段 1：本地检查 ─────────────────────────────
    tracker.begin('check')
    const t0 = Date.now()
    let ver = resolveVersion(project)
    if (autoMode) {
      if (!target.server?.host) throw new Error('请先设置正式服务器地址与登录凭据')
      if (!fs.existsSync(project.localPath)) throw new Error('本地项目目录不存在')
      if (!ver.version) ver = { version: new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14), source: '自动发布编号' }
      project.releaseId = `${ver.version}-${runId}`
      setC(await ssh.connect({ ...target.server, password: creds.password, passphrase: creds.passphrase }))
      prepared = await automatic.prepare(project, target, { conn, uploadText: uploadTextFile, log, signal: controller.signal, releaseId: project.releaseId })
      if (activeRun) activeRun.redact = prepared.redact
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
    if (!autoMode && list.some((p) => p.id !== project.id && p.targets.some((t) => t.server?.host === target.server.host && Number(t.server.port || 22) === Number(target.server.port || 22) && String(t.remotePath).replace(/\/+$/, '') === String(target.remotePath).replace(/\/+$/, '')))) {
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
        buildWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'onedeploy-build-'))
        const artifactRoot = path.resolve(project.localPath, project.scriptMode?.artifactDir || 'release')
        await fs.promises.cp(project.localPath, buildWorkspace, { recursive: true, dereference: false, filter: (source) => {
          const rel = path.relative(project.localPath, source)
          if (!rel) return true
          if (/^(?:\.git|\.local|release|releases)$/.test(rel.split(path.sep)[0])) return false
          const artifactRel = path.relative(artifactRoot, source)
          return !(artifactRel && !artifactRel.startsWith('..') && ARTIFACT_EXTS.some((ext) => source.toLowerCase().endsWith(ext)))
        } })
        if (isCanceled()) throw new Error('发布已取消')
        const buildProject = { ...project, localPath: buildWorkspace }
        const syncNote = syncProjectVersionForPackage(buildProject, ver)
        if (syncNote) log('warn', syncNote)
        const rnNote = ensureReleaseNotesForPackage(buildProject, ver, gitInfo)
        if (rnNote) log('warn', rnNote)
        const pc = await runPackageCommand(buildProject)
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
        onProgress: (count) => emit('deploy:progress', { kind: 'package', count }),
        includeBuild: true,
        files: prepared?.files,
        safeRoot: autoMode,
        exclude: autoMode ? prepared.exclude : undefined,
      })
      log('success', `ZIP 生成完成：${pack.fileName}（${(pack.sizeBytes / 1024 / 1024).toFixed(1)} MB，${pack.fileCount} 个文件）`)
    }
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
        emit('deploy:progress', { kind: 'datasync', percent: total ? Math.round((done / total) * 100) : 0 })
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
      emit('deploy:progress', { kind: 'upload', percent: total ? Math.round((done / total) * 100) : 0 })
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
    let res = await execDeployScript(conn, cmd, tracker, resultBox)
    // 自动方案的构建失败可用真实错误修正一次；此时服务器尚未停止旧服务。
    if (autoMode && !resultBox.ok && !isCanceled() && tracker.state.build.status === 'running' && tracker.state.start.status === 'waiting' && tracker.state.datasync.status === 'waiting') {
      log('warn', '构建未通过，正在依据构建日志自动修复部署方案并重试一次…')
      const fixed = await automatic.prepare(project, target, {
        conn, uploadText: uploadTextFile, log, signal: controller.signal, releaseId: project.releaseId,
        previousRecipe: prepared.recipe, feedback: prepared.redact((res.stdout || '') + '\n' + (res.stderr || '')),
      })
      if (isCanceled()) throw new Error('发布已取消')
      if (activeRun) activeRun.redact = fixed.redact
      prepared = fixed
      target.autoHealth = fixed.health
      target.autoDb = fixed.db
      projects.save(project)
      try { fs.unlinkSync(pack.zipPath) } catch { /* 临时包可能已清理 */ }
      tracker.begin('package')
      pack = await packager.buildPackage({ projectDir: project.localPath, appName: project.name, version: ver.version, files: fixed.files, includeBuild: true, safeRoot: true, exclude: fixed.exclude })
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
      res = await execDeployScript(conn, retryCmd, tracker, resultBox)
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
      // 全部发布步骤成功后才打标，固定到开始时采集的提交，避免部署期间 HEAD 变化。
      if (isCanceled()) return finish('canceled', '用户取消')
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
    ssh.close(conn)
    logSink = null
    if (activeRun && activeRun.id === runId) activeRun = null
    // 清理本地残留 zip（失败场景；成功路径已在 finish 前删除；脚本形态产物包保留）
    try { if (pack && !pack.keepLocal && fs.existsSync(pack.zipPath)) fs.unlinkSync(pack.zipPath) } catch { /* noop */ }
    try { if (dataPack && fs.existsSync(dataPack.zipPath)) fs.unlinkSync(dataPack.zipPath) } catch { /* 临时数据包清理失败不改变发布结果 */ }
    if (buildWorkspace && path.dirname(path.resolve(buildWorkspace)) === path.resolve(os.tmpdir()) && path.basename(buildWorkspace).startsWith('onedeploy-build-')) {
      fs.rmSync(buildWorkspace, { recursive: true, force: true })
    }
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
  const creds = projects.getCredentials(projectId, target.id) || { password: '', passphrase: '' }
  const conn = await ssh.connect({
    host: target.server.host,
    port: target.server.port,
    username: target.server.username,
    authType: target.server.authType,
    password: creds.password,
    keyPath: target.server.keyPath,
    passphrase: creds.passphrase,
  })
  return { project, target, conn }
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

/** 标签同时限定项目和服务；多副本不能猜测要恢复哪一个数据库。 */
async function resolveRestoreDb(conn, project, target, db) {
  if (!db.auto) return db
  const docker = `${dbSudo(project, target)}docker`
  const result = await ssh.exec(conn, `${docker} ps -q --filter ${quoteArg(`label=com.docker.compose.project=${automatic.identity(project, target.id)}`)} --filter ${quoteArg(`label=com.docker.compose.service=${db.service}`)} --filter status=running`)
  const ids = (result.stdout || '').trim().split(/\s+/).filter(Boolean)
  if (result.code !== 0 || ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0])) {
    throw new Error('无法唯一定位当前项目的运行中数据库容器，请检查服务状态后重试')
  }
  const readNames = [
    'db_user="${POSTGRES_USER:-}"',
    'if [ -z "$db_user" ] && [ -n "${POSTGRES_USER_FILE:-}" ]; then db_user="$(cat "$POSTGRES_USER_FILE")"; fi',
    'db_user="${db_user:-postgres}"',
    'db_name="${POSTGRES_DB:-}"',
    'if [ -z "$db_name" ] && [ -n "${POSTGRES_DB_FILE:-}" ]; then db_name="$(cat "$POSTGRES_DB_FILE")"; fi',
    'db_name="${db_name:-$db_user}"',
    'printf "%s\\n%s\\n" "$db_user" "$db_name"',
  ].join('\n')
  const names = await ssh.exec(conn, `${docker} exec ${quoteArg(ids[0])} sh -ceu ${quoteArg(readNames)}`)
  const rows = (names.stdout || '').replace(/\r?\n$/, '').split('\n')
  if (names.code !== 0 || rows.length !== 2 || rows.some((value) => !value || /[\x00-\x1f\x7f]/.test(value))) {
    throw new Error('无法读取数据库现有库名和用户，请检查容器的 PostgreSQL 环境配置')
  }
  return { ...db, container: ids[0], user: rows[0], name: rows[1] }
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
 *   保底备份当前库 → 杀连接并重建空库 → 灌入备份 SQL（出错即停）→ 重启同 compose 项目容器。
 * 保底备份失败则中止——绝不覆盖「唯一可能完好的当前数据」。
 */
async function restoreDbBackup(projectId, targetId, fileName) {
  if (activeRun) throw new Error('已有发布任务进行中，请等待完成或取消')
  assertDbBackupName(fileName)
  const runId = crypto.randomBytes(6).toString('hex')
  activeRun = { id: runId, conn: null, canceled: false }
  let project, target, conn, db
  try {
    ;({ project, target, conn } = await connectTarget(projectId, targetId))
    activeRun.conn = conn
    db = requireDbConfig(project, target, true)
    db = await resolveRestoreDb(conn, project, target, db)
    if (isCanceled()) throw new Error('数据库恢复已取消')
  } catch (error) {
    ssh.close(conn)
    if (activeRun?.id === runId) activeRun = null
    throw error
  }
  const home = target.remotePath
  const backupDir = ssh.remoteJoin(home, 'backups')
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
  const sudo = dbSudo(project, target)
  const docker = `${sudo}docker`

  const logBuf = []
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)
  const record = {
    id: runId, projectId: project.id, projectName: project.name, type: 'db-restore',
    targetId: target.id, targetName: target.name,
    version: fileName, oldVersion: '', status: 'running',
    startedAt: Date.now(), finishedAt: 0, durationMs: 0,
    host: `${target.server.host}:${target.server.port}`, remotePath: home,
    message: '', logFile: '',
  }
  const finish = (status, message) => {
    record.status = status
    record.message = message || ''
    record.finishedAt = Date.now()
    record.durationMs = record.finishedAt - record.startedAt
    record.logFile = history.writeLog(runId, logBuf.join('\n'))
    history.add(record)
    emit('deploy:done', { record: JSON.parse(JSON.stringify(record)) })
    return JSON.parse(JSON.stringify(record))
  }

  try {
    const sqlFile = ssh.remoteJoin(backupDir, fileName)
    const has = await ssh.exec(conn, `${sudo}test -f ${quoteArg(sqlFile)} && echo Y || echo N`)
    if ((has.stdout || '').trim() !== 'Y') throw new Error(`备份文件不存在：${fileName}`)

    log('info', `开始恢复数据库：${fileName}（库 ${db.name}@${db.container}）`)
    // 1. 保底备份当前库（失败即中止）
    const guardName = `db_guard_${stamp}_${runId}.sql`
    const guardFile = ssh.remoteJoin(backupDir, guardName)
    log('info', '恢复前先保底备份当前数据库……')
    const dump = postgresCommand(docker, db, 'pg_dump', ['-U', db.user, '--', db.name])
    // sudo docker 不会提升 shell 重定向的权限，备份文件也须在相同权限下写入。
    const dumpToFile = sudo ? `${dump} | ${sudo}tee ${quoteArg(guardFile)} >/dev/null` : `${dump} > ${quoteArg(guardFile)}`
    const guard = await ssh.exec(conn, `bash -o pipefail -c ${quoteArg(`umask 077; ${dumpToFile} && ${sudo}chmod 600 ${quoteArg(guardFile)} && echo __GUARD_OK__`)}`)
    if (guard.code !== 0 || !/__GUARD_OK__/.test(guard.stdout || '')) {
      throw new Error('保底备份失败，已中止恢复（当前数据未做任何改动）')
    }
    log('success', `保底备份完成：${guardName}`)

    // 2. 杀连接 + 重建空库 + 灌入（单条命令链，任一步失败整体失败）
    log('info', '重建数据库并灌入备份……')
    // 默认库本身可能是 postgres，维护连接不能连接即将删除的数据库。
    const maintenance = db.name === 'postgres' ? 'template1' : 'postgres'
    const psql = (sql) => postgresCommand(docker, db, 'psql', ['-U', db.user, '-d', maintenance, '-v', 'ON_ERROR_STOP=1', '-c', sql])
    const importSql = postgresCommand(docker, db, 'psql', ['-U', db.user, '-d', db.name, '-v', 'ON_ERROR_STOP=1'], true)
    const restoreSteps = [
      psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${sqlLiteral(db.name)} AND pid <> pg_backend_pid();`),
      psql(`DROP DATABASE ${sqlIdentifier(db.name)} WITH (FORCE);`),
      psql(`CREATE DATABASE ${sqlIdentifier(db.name)} OWNER ${sqlIdentifier(db.user)};`),
      sudo ? `${sudo}cat ${quoteArg(sqlFile)} | ${importSql}` : `${importSql} < ${quoteArg(sqlFile)}`,
      `echo __DB_RESTORE_OK__`,
    ].join(' && ')
    const restoreCmd = `bash -o pipefail -c ${quoteArg(restoreSteps)}`
    const res = await ssh.exec(conn, restoreCmd, (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.replace(/\s+$/, '')
        if (t && !/^(__DB_RESTORE_OK__|DROP DATABASE|CREATE DATABASE|pg_terminate_backend)/.test(t)) log('info', `[恢复] ${t}`)
      }
    })
    if (res.code !== 0 || !/__DB_RESTORE_OK__/.test(res.stdout || '')) {
      throw new Error(`数据库恢复失败（退出码 ${res.code}），可用保底备份 ${guardName} 再次恢复`)
    }
    log('success', '备份已灌入')

    // 3. 重启同 compose 项目的容器（应用连接池指向已重建的库）
    log('info', '重启应用容器……')
    const projectName = db.auto ? quoteArg(automatic.identity(project, target.id))
      : `$(${docker} inspect ${quoteArg(db.container)} --format '{{index .Config.Labels "com.docker.compose.project"}}')`
    const restarted = await ssh.exec(conn,
      `PROJ=${projectName}; if [ -n "$PROJ" ]; then CONTAINERS=$(${docker} ps --filter "label=com.docker.compose.project=$PROJ" -q) && [ -n "$CONTAINERS" ] && ${docker} restart $CONTAINERS; else echo __NO_COMPOSE__; fi`)
    if (restarted.code !== 0) throw new Error('数据库已恢复，但应用容器重启失败，请检查服务状态')
    log('success', `数据库恢复完成：${fileName}`)
    return finish('success', `数据库已恢复到备份 ${fileName}`)
  } catch (err) {
    const msg = (err && err.message) || String(err)
    log('error', `数据库恢复异常: ${msg}`)
    return finish('failed', msg)
  } finally {
    ssh.close(conn)
    logSink = null
    if (activeRun?.id === runId) activeRun = null
  }
}

/** 手动回滚到指定版本（方案 §20：直接使用服务器已有 release，不重新上传） */
async function rollback(projectId, version, targetId) {
  if (activeRun) throw new Error('已有发布任务进行中')
  const { project, target, conn } = await connectTarget(projectId, targetId)
  const home = target.remotePath
  const h = healthFor(project, target)
  const logBuf = []
  const runId = crypto.randomBytes(6).toString('hex')
  const record = {
    id: runId, projectId: project.id, projectName: project.name, type: 'rollback',
    targetId: target.id, targetName: target.name,
    version, oldVersion: '', status: 'running',
    startedAt: Date.now(), finishedAt: 0, durationMs: 0,
    host: `${target.server.host}:${target.server.port}`, remotePath: home,
    message: '', logFile: '',
  }
  logSink = (level, text) => logBuf.push(`${ts()} [${level.toUpperCase()}] ${text}`)
  log('info', `开始回滚 ${project.name}（${target.name}）→ ${version}`)
  const finish = (status, message) => {
    record.status = status
    record.message = message || ''
    record.finishedAt = Date.now()
    record.durationMs = record.finishedAt - record.startedAt
    record.logFile = history.writeLog(runId, logBuf.join('\n'))
    history.add(record)
    emit('deploy:done', { record: JSON.parse(JSON.stringify(record)) })
    return JSON.parse(JSON.stringify(record))
  }

  activeRun = { id: runId, conn, canceled: false }
  try {
    await ssh.mkdirp(conn, ssh.remoteJoin(home, 'deployer'))
    const scriptRemote = ssh.remoteJoin(home, 'deployer', 'deploy.sh')
    // 脚本缺失时自动补传（首次接管旧项目也能回滚）
    const has = await ssh.exec(conn, `test -f ${quoteArg(scriptRemote)} && echo Y || echo N`)
    if (!/Y/.test(has.stdout)) {
      await uploadTextFile(conn, readDeployScript(), scriptRemote)
    }
    const args = [
      'rollback', '--mode', deployModeOf(project),
      '--app', project.name, '--home', home, '--version', version,
    ]
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
    const tracker = newStageTracker()
    const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
    const res = await execDeployScript(conn, cmd, tracker, resultBox)
    if (resultBox.ok && res.code === 0) {
      log('success', `回滚成功，当前版本: ${version}`)
      return finish('success', `回滚到 ${version}`)
    }
    log('error', resultBox.message || `回滚失败（退出码 ${res.code}）`)
    return finish('failed', resultBox.message || '回滚失败')
  } catch (err) {
    const msg = (err && err.message) || String(err)
    log('error', `回滚异常: ${msg}`)
    return finish('failed', msg)
  } finally {
    ssh.close(conn)
    logSink = null
    activeRun = null
  }
}

module.exports = {
  run, cancel, isBusy, testConnection, listReleases, rollback,
  listDbBackups, restoreDbBackup, assertDbBackupName,
  setEmitter, STAGES, resolveVersion, buildDeployArgs,
  resolveCompose, resolveArtifact, sha256File, releaseDirNameOf, deployModeOf, runPackageCommand,
  getDataSync, validateDataSync, buildDataSyncCommand,
  getDataImport, renderImportCommand, ensureReleaseNotesForPackage,
}
