/**
 * 部署编排服务 —— 对应方案 §4/§10/§17/§27 的 DeployService：
 * 完整流程：本地检查 → 生成 ZIP → SSH 连接 → 上传+校验 → 服务器备份 →
 * 解压 → Docker 构建 → 启动 → 健康检查 → （失败自动回滚）→ 清理 → 记录历史。
 * 服务器端逻辑收敛在 deploy.sh（方案 §10.2），本模块只负责编排、日志流与阶段映射。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const ssh = require('./ssh-service')
const packager = require('./packager')
const projects = require('./deploy-projects')
const history = require('./history')
const releaseNotes = require('./release-notes')
const store = require('../store')
const { detectVersion, bumpVersionFiles } = require('./version-detector')

/** 服务端脚本随应用分发（asar 内也可 readFileSync） */
const DEPLOY_SCRIPT_PATH = path.join(__dirname, 'scripts', 'deploy.sh')

/** 9 个发布阶段，渲染层按此渲染进度；datasync 在发布成功后由客户端执行 */
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
  if (activeRun.pkgChild) killTree(activeRun.pkgChild)
  ssh.close(activeRun.conn)
  return { ok: true }
}

function isBusy() {
  return !!activeRun
}

/** 解析脚本输出的控制标记，返回应显示的行或 null */
function parseMarker(line, tracker, resultBox) {
  const m = line.match(/^__STAGE__:(\w+)$/)
  if (m) {
    const map = {
      'backup-code': 'backup', 'backup-db': 'backup', extract: 'extract',
      build: 'build', start: 'start', health: 'health', rollback: 'rollback',
    }
    const sid = map[m[1]]
    if (sid === 'rollback') {
      resultBox.rolledBack = true
      log('warn', '发布失败，正在自动回滚……')
    } else if (sid) tracker.begin(sid)
    return null
  }
  const okM = line.match(/^__DEPLOY_OK__:(.*)$/)
  if (okM) { resultBox.ok = true; resultBox.message = okM[1] || '发布成功'; return null }
  const failM = line.match(/^__DEPLOY_FAIL__:(.*)$/)
  if (failM) { resultBox.ok = false; resultBox.message = failM[1] || '发布失败'; return null }
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

/** 读取随应用分发的 deploy.sh 内容（强制 LF：git autocrlf 可能把工作区文件
 *  检出为 CRLF，Linux bash 遇 \r 会直接语法错误，上传前必须规范化） */
function readDeployScript() {
  return fs.readFileSync(DEPLOY_SCRIPT_PATH, 'utf8').replace(/\r\n/g, '\n')
}

/** 拼装 deploy.sh 参数（服务器目录结构方案 §8：home 下 releases/uploads/backups/shared/deployer） */
function buildDeployArgs(project, target, pack, version) {
  const d = project.deploy || {}
  // 数据库备份配置按环境存放：同一项目发布到测试/生产时用的是各自的库
  const db = target.db || {}
  const h = target.health || {}
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
    args.push('--backup-db', '--db-type', db.type || 'postgres',
      '--db-container', db.container || '', '--db-name', db.name || '',
      '--db-user', db.user || '')
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
    files = fs.readdirSync(dir)
      .filter((f) => ARTIFACT_EXTS.some((e) => f.toLowerCase().endsWith(e)))
      .map((f) => {
        const fp = path.join(dir, f)
        return { fileName: f, filePath: fp, mtime: fs.statSync(fp).mtimeMs }
      })
  } catch { /* 目录不可读，按空处理 */ }
  if (!files.length) return { ok: false, problem: `产物目录 ${sm.artifactDir || 'release'} 中没有发布包（支持 ${ARTIFACT_EXTS.join(' / ')}）` }
  const matched = files.filter((f) => version && f.fileName.includes(version)).sort((a, b) => b.mtime - a.mtime)
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
  return `已将项目版本 ${cur.version} → ${ver.version}（同步 ${changed.join('、')}；改动在本地工作区，请随代码提交）`
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
  return `已生成发布说明 ${r.file}（依据 ${commits.length} 条提交自动整理的初稿${anchorLabel ? `，${anchorLabel}` : ''}；文件尚未提交，可润色后随代码提交）`
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
function preCheckLocal(project, target, version) {
  const problems = []
  if (!project.name) problems.push('缺少项目名称')
  if (!project.localPath || !fs.existsSync(project.localPath)) problems.push(`本地项目目录不存在: ${project.localPath}`)
  else if (deployModeOf(project) === 'docker') {
    const rc = resolveCompose(project)
    if (!fs.existsSync(path.join(project.localPath, rc.file))) {
      problems.push(`Docker Compose 文件不存在: ${rc.file}（已尝试 ${COMPOSE_CANDIDATES.join(' / ')}），可在部署设置改用脚本部署形态`)
    }
  }
  if (!version) problems.push('未识别到版本号（可改用手动输入）')
  // 数据库备份参数缺失在客户端就拦截：否则要等发布到服务器备份阶段才失败
  const db = target.db || {}
  if (db.enabled) {
    if (!String(db.container || '').trim() || !String(db.name || '').trim()) {
      problems.push(`[${target.name}] 已启用「发布前备份数据库」但未配置数据库容器名或库名（部署设置 → 数据库备份中补全）`)
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
  return targets.find((t) => t.id === targetId) || targets[0]
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
  if (!dataSync.localDir) return { ok: false, problem: '数据目录未填写' }
  const sourceDir = path.resolve(project.localPath, dataSync.localDir)
  // 防越界：数据目录必须位于项目目录内（resolve 后前缀校验）
  const projectRoot = path.resolve(project.localPath)
  if (sourceDir !== projectRoot && !sourceDir.startsWith(projectRoot + path.sep)) {
    return { ok: false, problem: `数据目录必须在项目目录内: ${dataSync.localDir}` }
  }
  if (sourceDir === projectRoot) {
    return { ok: false, problem: '数据目录不能是项目根目录本身' }
  }
  if (!fs.existsSync(sourceDir)) return { ok: false, problem: `数据目录不存在: ${sourceDir}` }
  if (!fs.statSync(sourceDir).isDirectory()) return { ok: false, problem: `数据目录不是文件夹: ${sourceDir}` }
  if (!dataSync.remoteDir || dataSync.remoteDir.includes('..')) {
    return { ok: false, problem: `远程数据目录非法: ${dataSync.remoteDir}` }
  }
  return { ok: true, sourceDir }
}

/** 服务器端数据同步命令：建目录 → 解压覆盖 → 删包（单条命令，任一步失败整体失败） */
function buildDataSyncCommand(dataZipRemote, remoteDestDir) {
  return `mkdir -p ${quoteArg(remoteDestDir)} && unzip -o ${quoteArg(dataZipRemote)} -d ${quoteArg(remoteDestDir)} && rm -f ${quoteArg(dataZipRemote)} && echo __DATA_SYNC_OK__`
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
  activeRun = { id: runId, conn: null, canceled: false }
  const setC = (c) => { if (activeRun) activeRun.conn = c; conn = c }

  try {
    // ── 阶段 1：本地检查 ─────────────────────────────
    tracker.begin('check')
    const t0 = Date.now()
    const ver = resolveVersion(project)
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
    const problems = preCheckLocal(project, target, ver.version)
    if (mode === 'docker') {
      const rc = resolveCompose(project)
      if (rc.fallback) log('warn', `配置的 Compose 文件不存在，自动改用项目根下的 ${rc.file}`)
    }
    let artifact = null
    if (!problems.length && mode === 'script') {
      artifact = resolveArtifact(project, ver.version)
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
        const syncNote = syncProjectVersionForPackage(project, ver)
        if (syncNote) log('warn', syncNote)
        const rnNote = ensureReleaseNotesForPackage(project, ver, gitInfo)
        if (rnNote) log('warn', rnNote)
        const pc = await runPackageCommand(project)
        if (!pc.ok) {
          log('error', pc.problem)
          tracker.end('package', 'failed', t1)
          return finish('failed', pc.problem)
        }
        artifact = resolveArtifact(project, ver.version)
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
      })
      log('success', `ZIP 生成完成：${pack.fileName}（${(pack.sizeBytes / 1024 / 1024).toFixed(1)} MB，${pack.fileCount} 个文件）`)
    }
    tracker.end('package', 'success', t1)

    // ── 阶段 3：连接 + 上传 ─────────────────────────
    tracker.begin('upload')
    const t2 = Date.now()
    log('info', `连接服务器 ${target.server.host}:${target.server.port}……`)
    setC(await ssh.connect({
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
    tracker.end('upload', 'success', t2)

    // ── 阶段 4~8：服务器端执行 deploy.sh ────────────
    const cmd = `bash ${quoteArg(scriptRemote)} ${buildDeployArgs(project, target, pack, ver.version).map(quoteArg).join(' ')}`
    const res = await ssh.exec(conn, cmd, (chunk) => pipeScriptOutput(chunk, tracker, resultBox))

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

      // ── 阶段 9：数据同步（可选，发布成功后推送本地数据到服务器共享目录） ──
      if (dataSyncCfg.enabled && !resultBox.rolledBack) {
        tracker.begin('datasync')
        const tds = Date.now()
        try {
          const vds = validateDataSync(project, dataSyncCfg)
          if (!vds.ok) throw new Error(vds.problem)
          log('info', `正在打包数据目录 ${dataSyncCfg.localDir} ……`)
          const dataPack = await packager.buildDataPackage({
            projectDir: project.localPath,
            dataDir: dataSyncCfg.localDir,
            appName: project.name,
            version: ver.version,
          })
          log('info', `数据包 ${dataPack.fileName}（${dataPack.fileCount} 项，${(dataPack.sizeBytes / 1024 / 1024).toFixed(1)} MB）`)
          const dataZipRemote = ssh.remoteJoin(remoteHome, 'uploads', dataPack.fileName)
          await ssh.upload(conn, dataPack.zipPath, dataZipRemote, (done, total) => {
            emit('deploy:progress', { kind: 'datasync', percent: total ? Math.round((done / total) * 100) : 0 })
          })
          const dsum = await ssh.exec(conn, `sha256sum ${quoteArg(dataZipRemote)} | awk '{print $1}'`)
          if ((dsum.stdout || '').trim() !== dataPack.sha256) {
            throw new Error('数据包上传校验失败（SHA256 不一致）')
          }
          const destDir = ssh.remoteJoin(remoteHome, dataSyncCfg.remoteDir)
          log('info', `解压覆盖到 ${dataSyncCfg.remoteDir} ……`)
          const dres = await ssh.exec(conn, buildDataSyncCommand(dataZipRemote, destDir))
          if (dres.code !== 0 || !/__DATA_SYNC_OK__/.test(dres.stdout || '')) {
            throw new Error(`服务器执行数据同步失败（退出码 ${dres.code}）`)
          }
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
          try { fs.unlinkSync(dataPack.zipPath) } catch { /* noop */ }
          tracker.end('datasync', 'success', tds)
          log('success', `数据同步完成 → ${dataSyncCfg.remoteDir}`)
        } catch (dsErr) {
          tracker.end('datasync', 'failed', tds)
          const msg = `数据同步失败: ${(dsErr && dsErr.message) || dsErr}`
          log('error', msg)
          log('warn', '代码已发布成功但数据未同步，请排查后重新发布')
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
  }
}

/** 上传内存文本到远端（用于 deploy.sh 等；asar 内文件需先读内容再写） */
function uploadTextFile(conn, text, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      const stream = sftp.createWriteStream(remotePath)
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

/** 数据库恢复所需配置（沿用该环境在部署设置中填写的 db 配置） */
function requireDbConfig(target) {
  const d = (target && target.db) || {}
  const env = (target && target.name) || '当前环境'
  if (!d.enabled) throw new Error(`[${env}] 未启用「发布前备份数据库」，无法恢复（请先在部署设置中开启并配置数据库信息）`)
  const container = String(d.container || '').trim()
  const name = String(d.name || '').trim()
  const user = String(d.user || 'postgres').trim()
  if (!container || !name) throw new Error(`[${env}] 数据库容器名或库名未配置`)
  // 容器名/库名/用户名进入 shell 与 SQL 标识符位置，只放行安全字符
  for (const v of [container, name, user]) {
    if (!/^[\w.-]+$/.test(v)) throw new Error(`[${env}] 数据库配置含非法字符：${v}`)
  }
  if (d.type !== 'postgres') throw new Error(`[${env}] 当前仅支持 PostgreSQL 备份恢复`)
  return { container, name, user }
}

/** 列出服务器 backups/ 下的数据库备份（按时间倒序） */
async function listDbBackups(projectId, targetId) {
  const { target, conn } = await connectTarget(projectId, targetId)
  requireDbConfig(target) // 未配置数据库信息时列表也无意义
  const home = target.remotePath
  try {
    const res = await ssh.exec(conn,
      // glob 展开为全路径，awk 内取 basename；$5=大小 $6/$7=日期时间
      `ls -lht --time-style=+%Y-%m-%d\\ %H:%M ${quoteArg(ssh.remoteJoin(home, 'backups'))}/db_*.sql 2>/dev/null | awk '{n=split($8,a,"/"); print $5, $6, $7, a[n]}'`)
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
  const { project, target, conn } = await connectTarget(projectId, targetId)
  const db = requireDbConfig(target)
  const home = target.remotePath
  const backupDir = ssh.remoteJoin(home, 'backups')
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)

  const runId = crypto.randomBytes(6).toString('hex')
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
  activeRun = { id: runId, conn, canceled: false }
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
    const has = await ssh.exec(conn, `test -f ${quoteArg(sqlFile)} && echo Y || echo N`)
    if (!/Y/.test(has.stdout || '')) throw new Error(`备份文件不存在：${fileName}`)

    log('info', `开始恢复数据库：${fileName}（库 ${db.name}@${db.container}）`)
    // 1. 保底备份当前库（失败即中止）
    const guardFile = ssh.remoteJoin(backupDir, `db_guard_${stamp}.sql`)
    log('info', '恢复前先保底备份当前数据库……')
    const guard = await ssh.exec(conn, `docker exec ${quoteArg(db.container)} pg_dump -U ${quoteArg(db.user)} ${quoteArg(db.name)} > ${quoteArg(guardFile)} && echo __GUARD_OK__`)
    if (guard.code !== 0 || !/__GUARD_OK__/.test(guard.stdout || '')) {
      throw new Error('保底备份失败，已中止恢复（当前数据未做任何改动）')
    }
    log('success', `保底备份完成：db_guard_${stamp}.sql`)

    // 2. 杀连接 + 重建空库 + 灌入（单条命令链，任一步失败整体失败）
    log('info', '重建数据库并灌入备份……')
    const restoreCmd = [
      `docker exec ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${db.name}' AND pid <> pg_backend_pid();"`,
      `docker exec ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d postgres -c "DROP DATABASE ${db.name} WITH (FORCE);"`,
      `docker exec ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d postgres -c "CREATE DATABASE ${db.name} OWNER ${db.user};"`,
      `docker exec -i ${quoteArg(db.container)} psql -U ${quoteArg(db.user)} -d ${quoteArg(db.name)} -v ON_ERROR_STOP=1 < ${quoteArg(sqlFile)}`,
      `echo __DB_RESTORE_OK__`,
    ].join(' && ')
    const res = await ssh.exec(conn, restoreCmd, (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const t = line.replace(/\s+$/, '')
        if (t && !/^(__DB_RESTORE_OK__|DROP DATABASE|CREATE DATABASE|pg_terminate_backend)/.test(t)) log('info', `[恢复] ${t}`)
      }
    })
    if (res.code !== 0 || !/__DB_RESTORE_OK__/.test(res.stdout || '')) {
      throw new Error(`数据库恢复失败（退出码 ${res.code}），可用保底备份 db_guard_${stamp}.sql 再次恢复`)
    }
    log('success', '备份已灌入')

    // 3. 重启同 compose 项目的容器（应用连接池指向已重建的库）
    log('info', '重启应用容器……')
    await ssh.exec(conn,
      `PROJ=$(docker inspect ${quoteArg(db.container)} --format '{{index .Config.Labels "com.docker.compose.project"}}') && [ -n "$PROJ" ] && docker restart $(docker ps --filter label=com.docker.compose.project=$PROJ -q) || echo __NO_COMPOSE__`)
    log('success', `数据库恢复完成：${fileName}`)
    return finish('success', `数据库已恢复到备份 ${fileName}`)
  } catch (err) {
    const msg = (err && err.message) || String(err)
    log('error', `数据库恢复异常: ${msg}`)
    return finish('failed', msg)
  } finally {
    ssh.close(conn)
    logSink = null
    activeRun = null
  }
}

/** 手动回滚到指定版本（方案 §20：直接使用服务器已有 release，不重新上传） */
async function rollback(projectId, version, targetId) {
  if (activeRun) throw new Error('已有发布任务进行中')
  const { project, target, conn } = await connectTarget(projectId, targetId)
  const home = target.remotePath
  const h = target.health || {}
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
    }
    if (h.enabled && h.url) {
      args.push('--health-url', h.url, '--health-timeout', String(h.timeout || 90), '--health-interval', String(h.interval || 3))
    } else {
      args.push('--no-health')
    }
    const cmd = `bash ${quoteArg(scriptRemote)} ${args.map(quoteArg).join(' ')}`
    const tracker = newStageTracker()
    const resultBox = { ok: false, message: '', rolledBack: false, oldVersion: '' }
    const res = await ssh.exec(conn, cmd, (chunk) => pipeScriptOutput(chunk, tracker, resultBox))
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
