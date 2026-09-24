/**
 * DeepSeek Harness 内置运行时更新（版本检查 + 应用内热更新）
 *
 * 需求：监视 @deepseek-ai/dsh 是否有新版本，有新版本时提示用户，并支持在应用内直接升级。
 * 版本口径：**取源上版本号最大的那个，包含预发布版本**（dsh 只发 alpha/rc，
 * dist-tags.latest 常年停在旧版，例如 latest=0.1.5-rc.3 时源上已有 0.1.7-rc.1）。
 *
 * 为什么用「随包 npm」而不是自己写下载器：dsh 依赖树约 600 个包、2.6 万个文件，
 * 版本解析（依赖范围、可选依赖、平台过滤、peer、提升与冲突嵌套）是 npm 的活。
 * 目标机器上没有 Node/npm，因此把 npm 官方包（自带全部依赖，压缩后约 3MB）随包分发，
 * 更新时用 **Electron 自带的 Node**（ELECTRON_RUN_AS_NODE）执行它的 CLI 安装到暂存目录。
 *
 * 安装链路（全程不触碰正在运行的运行时，失败不影响现有服务）：
 *   1. 解包随包 npm 组件到 <userData>/updater（幂等，按标记复用）
 *   2. npm install --prefix <userData>/rt-new/dsh @deepseek-ai/dsh@<版本>（--ignore-scripts：
 *      dsh 依赖的 node-pty / sharp / koffi 都是**预编译包**，无需构建脚本）
 *   3. 校验入口与真实版本号 → 打 CREATE_NO_WINDOW 补丁（补丁点变化即中止，保留旧运行时）
 *   4. 停服务 → 目录交换（runtime ⇄ rt-new，失败自动回滚）→ 写热更新标记 → 重启服务
 *
 * 暂存目录取名 rt-new / rt-old（比 runtime 还短）：依赖树最深相对路径约 166 字符，
 * 长目录名会顶破 Windows 默认 260 字符上限。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const harnessPatch = require('./harness-patch')
const harnessRuntime = require('./harness-runtime')
const { isValidVersion, isNewer, compareVersions } = require('./version-compare')

/** dsh 包名与默认源（源可在配置里改：公司内网镜像） */
const PACKAGE = '@deepseek-ai/dsh'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** 自动检查间隔：6 小时（手动「检查更新」不受限制） */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 检查口径标记：口径本身变化时（如从只认 dist-tags.latest 改为含预发布的最新版），
 *  上次落盘的 lastCheckAt 不能把首次重查推后 6 小时——否则升级应用后界面仍显示旧结论 */
const CHECK_POLICY = 'any-version-1'
const CHECK_TIMEOUT_MS = 20000
/** 随包更新组件（npm 官方包） */
const UPDATER_ARCHIVE = 'harness-updater.tar.gz'
const UPDATER_MARKER = 'harness-updater.json'
/** 目录交换的重试次数（Windows 上进程刚被杀时文件句柄可能尚未释放） */
const SWAP_TRIES = 24
const SWAP_DELAY_MS = 500
/** 安装进度采样间隔 */
const PROGRESS_INTERVAL_MS = 1500

let emitter = () => {}
/** 运行期状态（不落盘的部分）：检查中 / 安装进度 */
let runtime = { checking: false, install: idleInstall() }

function idleInstall() {
  return {
    status: 'idle', // idle | preparing | downloading | installing | verifying | swapping | restarting | done | error
    version: '',
    fetched: 0,     // 已下载的包数（统计 npm 的 http fetch 日志行）
    packages: 0,    // 已落盘的包目录数
    startedAt: 0,
    finishedAt: 0,
    error: '',
    detail: '',
  }
}

function log(...args) {
  console.log('[harness-update]', ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/** 用户数据目录（解包根 runtime 的父目录；非 Electron 环境由 harness-runtime 兜底） */
function baseDir() {
  return path.dirname(harnessRuntime.extractBase())
}

/** 运行时安装目录（与随包解包同一位置：热更新即替换它） */
function runtimeDir() {
  return harnessRuntime.extractBase()
}

function stagingDir() {
  return path.join(baseDir(), 'rt-new')
}

function backupDir() {
  return path.join(baseDir(), 'rt-old')
}

/** 随包 npm 组件的解包位置（只在真正更新时才解包，不影响日常启动） */
function updaterDir() {
  return path.join(baseDir(), 'updater')
}

/** npm 缓存目录：独立于用户的全局 npm 缓存，互不干扰 */
function npmCacheDir() {
  return path.join(baseDir(), 'npm-cache')
}

/** 检查结果落盘文件（跨启动保留「有新版本」提示与已提示过的版本号） */
function stateFile() {
  return path.join(baseDir(), 'harness-update.json')
}

function readState() {
  return readJson(stateFile()) || {}
}

function writeState(patch) {
  try { writeJson(stateFile(), { ...readState(), ...patch }) } catch { /* 落盘失败不影响本次结果 */ }
}

/** 配置里的自定义源（配置读取依赖 Electron，故懒加载） */
function configRegistry() {
  try {
    const store = require('./store')
    const cfg = store.load()
    return String((cfg.harness && cfg.harness.registry) || '').trim()
  } catch { return '' }
}

function registryUrl(override) {
  const url = String(override || readState().registry || configRegistry() || DEFAULT_REGISTRY).trim()
  return url.replace(/\/+$/, '') || DEFAULT_REGISTRY
}

/**
 * 是否允许热更新。
 * 只有「随包归档解包到用户目录」这一种形态能安全替换；开发态源码目录、
 * DSH_RUNTIME_DIR 指定的目录都不是本应用该动的地方。
 */
function updateGuard() {
  if (!harnessRuntime.hasShippedRuntime()) {
    return { ok: false, reason: '当前未随包分发内置运行时（开发态），热更新不可用' }
  }
  const { source } = harnessRuntime.resolveRuntime()
  if (source === 'override') return { ok: false, reason: '运行时由 DSH_RUNTIME_DIR 指定，热更新不可用' }
  if (source === 'loose') return { ok: false, reason: '当前使用源码目录运行时，热更新不可用' }
  return { ok: true, reason: '' }
}

/** 对外状态快照（渲染层与自测共用） */
function status() {
  const current = harnessRuntime.currentRuntimeVersion()
  const latest = String(readState().latestVersion || '')
  const guard = updateGuard()
  const install = runtime.install
  return {
    ok: true,
    checking: runtime.checking,
    current,
    latest,
    // 只在两边都是合法版本时判断，脏值（如手改的标记文件）宁可漏报
    updateAvailable: isValidVersion(latest) && isValidVersion(current) && isNewer(latest, current),
    canUpdate: guard.ok,
    reason: guard.reason,
    checkedAt: Number(readState().lastCheckAt || 0),
    error: install.error || String(readState().lastError || ''),
    registry: registryUrl(),
    busy: install.status !== 'idle' && !['done', 'error'].includes(install.status),
    install: { ...install, elapsedMs: install.startedAt ? (install.finishedAt || Date.now()) - install.startedAt : 0 },
  }
}

function setEmitter(fn) {
  emitter = typeof fn === 'function' ? fn : () => {}
}

/** 状态变化 → 广播（extra 用于「首次发现新版本」这类一次性信号） */
function emit(extra) {
  const payload = { ...status(), ...(extra || {}) }
  try { emitter(payload) } catch { /* 渲染层可能已销毁 */ }
  return payload
}

function setInstall(patch) {
  runtime.install = { ...runtime.install, ...patch }
  return emit()
}

/** GET JSON：优先 Electron net.fetch（走系统代理，公司网络更可靠），回退全局 fetch。
 *  网络错误重试 2 次：本机安全软件对新生成的二进制首连可能瞬时掐断（实测
 *  ERR_CONNECTION_CLOSED，重试即过），源本身 4xx/5xx 不重试。 */
async function httpJson(url) {
  let fetchImpl = null
  try {
    const { net } = require('electron')
    if (net && typeof net.fetch === 'function') fetchImpl = net.fetch.bind(net)
  } catch { /* 非 Electron 环境（自测） */ }
  if (!fetchImpl) fetchImpl = globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持网络请求')

  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await sleep(attempt * 2000)
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`源返回 HTTP ${response.status}`)
      return JSON.parse(await response.text())
    } catch (err) {
      // HTTP 状态错误是源侧问题（重试无意义）；其余按网络瞬断重试
      if (/源返回 HTTP/.test(String(err && err.message))) throw err
      lastError = err
    }
  }
  throw lastError
}

/**
 * 挑选源上的最新版本：**取所有已发布版本里版本号最大的一个，包含预发布版本**。
 *
 * 不读 dist-tags.latest：dsh 只在 alpha/rc 上迭代，latest tag 常年落后
 * （实测 latest=0.1.5-rc.3、next=0.1.7-rc.1，只认 latest 会一直提示装旧版）。
 * 候选来自 versions 全集的键，另加 dist-tags 的值兜底（个别源的 packument
 * 精简到只带 dist-tags）。非法版本号（tag 指向分支名等脏值）直接跳过。
 */
function pickLatestVersion(packument) {
  const versions = (packument && packument.versions) || {}
  const distTags = (packument && packument['dist-tags']) || {}
  const candidates = [...Object.keys(versions), ...Object.values(distTags)]
  let best = ''
  for (const candidate of candidates) {
    const text = String(candidate == null ? '' : candidate).trim().replace(/^v/, '')
    if (!isValidVersion(text)) continue
    if (!best || compareVersions(text, best) > 0) best = text
  }
  return best
}

/** 查询源上的最新版本（scoped 包名需转义斜杠） */
async function fetchLatest(registry) {
  const url = `${registry}/${PACKAGE.replace('/', '%2f')}`
  const packument = await httpJson(url)
  const latest = pickLatestVersion(packument)
  if (!isValidVersion(latest)) throw new Error('源上未找到有效的版本号')
  return { latest, distTags: packument['dist-tags'] || {} }
}

/**
 * 检查更新（默认 6 小时内不重复查；force 用于手动检查）。
 * 首次发现某个新版本时返回的广播带 notify=true，渲染层据此弹一次提示。
 */
async function check(opts = {}) {
  if (runtime.install.status !== 'idle' && !['done', 'error'].includes(runtime.install.status)) return status()
  const state = readState()
  // 口径变化时忽略节流：只查一次就写回新口径，之后恢复正常 6 小时节流
  const policyStale = state.checkPolicy !== CHECK_POLICY
  if (!opts.force && !policyStale && Date.now() - Number(state.lastCheckAt || 0) < CHECK_INTERVAL_MS) return status()

  runtime.checking = true
  emit()
  try {
    const registry = registryUrl(opts.registry)
    const { latest } = await fetchLatest(registry)
    const current = harnessRuntime.currentRuntimeVersion()
    const updateAvailable = isValidVersion(current) && isNewer(latest, current)
    // 同一个新版本只提示一次（用户可能反复启动应用）
    const notify = updateAvailable && state.notifiedVersion !== latest
    writeState({
      lastCheckAt: Date.now(),
      checkPolicy: CHECK_POLICY,
      latestVersion: latest,
      registry,
      lastError: '',
      ...(notify ? { notifiedVersion: latest } : {}),
    })
    runtime.checking = false
    log(`检查更新：本地 ${current || '未知'}，源上 ${latest}${updateAvailable ? '（有新版本）' : ''}`)
    return emit({ notify })
  } catch (err) {
    const message = (err && err.message) || String(err)
    runtime.checking = false
    // 失败不推进 lastCheckAt：开机时网络/VPN 未就绪导致的失败，不能把下一次自动检查推到 6 小时后
    writeState({ lastError: `检查更新失败：${message}` })
    log('检查更新失败：', message)
    return emit({ notify: false })
  }
}

/** 统计已落盘的包数（含 @scope 目录，便于显示进度） */
function countPackages(prefix) {
  const nm = path.join(prefix, 'node_modules')
  let total = 0
  let entries = []
  try { entries = fs.readdirSync(nm) } catch { return 0 }
  for (const name of entries) {
    if (name.startsWith('@')) {
      try { total += fs.readdirSync(path.join(nm, name)).length } catch { /* noop */ }
    } else total += 1
  }
  return total
}

/**
 * 解包随包 npm 组件（幂等）。返回其 CLI 入口路径。
 * 与内置 dsh 运行时同一套解包实现（系统 tar 优先，JS 兜底）。
 */
async function ensureUpdater() {
  const cli = path.join(updaterDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const expected = readJson(harnessRuntime.shippedFile(UPDATER_MARKER))
  const done = readJson(path.join(updaterDir(), '.complete'))
  if (fs.existsSync(cli) && expected && done && JSON.stringify(done) === JSON.stringify(expected)) {
    return { cli, version: String(expected.npmVersion || '') }
  }
  const archive = harnessRuntime.shippedFile(UPDATER_ARCHIVE)
  if (!archive) throw new Error(`随包缺少更新组件（${UPDATER_ARCHIVE}），请重新安装应用`)
  log(`解包更新组件：${archive} → ${updaterDir()}`)
  setInstall({ status: 'preparing' })
  await harnessRuntime.extractArchive(archive, updaterDir(), {
    entry: (dir) => fs.existsSync(path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  })
  if (expected) writeJson(path.join(updaterDir(), '.complete'), expected)
  return { cli, version: String((expected || {}).npmVersion || '') }
}

/** 结束整棵子进程树（Windows 必须 /T：npm 的 node 子进程普通 kill 杀不掉） */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try { require('child_process').spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* noop */ }
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* noop */ } }
}

/**
 * 解析系统代理为 npm 可用的环境变量。
 * npm 子进程跑在纯 Node 下（undici），不认 Windows 系统代理设置——而这台类机器
 * 往往正因直连 npmjs 不稳定才配了本地代理（实测直连会间歇性挂死/EIDLETIMEOUT）。
 * 用 Electron 会话的 resolveProxy（读系统设置）拿到代理地址传给 npm，
 * 使安装链路与检查链路（net.fetch 走系统代理）一致。
 */
async function proxyEnvFor(url) {
  try {
    const { session } = require('electron')
    const rules = String(await session.defaultSession.resolveProxy(url) || '')
    const matched = rules.match(/PROXY\s+([^;]+)/i)
    if (!matched) return {}
    const proxy = matched[1].trim()
    return { HTTP_PROXY: `http://${proxy}`, HTTPS_PROXY: `http://${proxy}`, NO_PROXY: 'localhost,127.0.0.1' }
  } catch { return {} }
}

/** 在暂存目录里用随包 npm 安装目标版本（流式进度 + 看门狗） */
async function installTree({ cli, prefix, version, registry, proxy = {} }) {
  fs.rmSync(path.dirname(prefix), { recursive: true, force: true }) // 清理上次失败的残留
  fs.mkdirSync(prefix, { recursive: true })
  fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ name: 'harness-runtime', private: true }, null, 2))

  const args = [
    '--expose-internals', cli, 'install',
    '--prefix', prefix,
    '--no-audit', '--no-fund', '--no-package-lock',
    // dsh 的 node-pty / sharp / koffi 都是预编译包，安装脚本在无 Node 的机器上既无必要也跑不动
    '--ignore-scripts',
    '--loglevel', 'http',
    '--registry', registry,
    // 显式网络超时与重试：默认配置下 socket 挂死（如本地代理瞬断）不会触发超时，
    // npm 会无限期卡住，表现为「下载依赖」永远转圈（实测下载 68MB 后卡死 12 分钟）
    '--fetch-timeout', '60000',
    '--fetch-retries', '3',
    '--fetch-retry-mintimeout', '2000',
    '--fetch-retry-maxtimeout', '30000',
    `${PACKAGE}@${version}`,
  ]
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    npm_config_cache: npmCacheDir(),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_progress: 'false',
    ...proxy,
  }
  log(`安装 ${PACKAGE}@${version} → ${prefix}`)
  // 先落到「下载依赖」：npm 总是先解析/拉取再落盘，不能只靠轮询（安装可能比轮询间隔还快）
  setInstall({ status: 'downloading', fetched: 0, packages: 0 })
  // detached 仅 POSIX：进程组整组可杀；Windows 用 taskkill /T
  const proc = spawn(process.execPath, args, {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  let tail = ''
  let fetched = 0
  let lastActivityAt = Date.now()
  const onChunk = (chunk) => {
    const text = String(chunk)
    tail = (tail + text).slice(-4000)
    // npm --loglevel=http 每取一个包打一行；按行数近似「已下载包数」作为下载阶段进度
    fetched += (text.match(/http fetch (?:GET|POST)/g) || []).length
    lastActivityAt = Date.now()
  }
  proc.stdout.on('data', onChunk)
  proc.stderr.on('data', onChunk)

  // 看门狗：输出与磁盘包数双双静止超过阈值视为挂死（超时参数失守、代理黑洞等），
  // 主动终止安装并报错——保留旧运行时，用户可重试；否则 UI 会永远停在「下载依赖」
  const STALL_LIMIT_MS = 5 * 60 * 1000
  let stalled = false
  const watchdog = setInterval(() => {
    const packages = countPackages(prefix)
    if (packages !== runtime.install.packages) lastActivityAt = Date.now()
    if (Date.now() - lastActivityAt > STALL_LIMIT_MS) {
      stalled = true
      log(`安装 ${STALL_LIMIT_MS / 60000} 分钟无进展，终止（已下载 ${fetched} 行 / ${packages} 包）`)
      killTree(proc.pid)
    }
  }, 10000)
  if (watchdog.unref) watchdog.unref()

  const timer = setInterval(() => {
    const packages = countPackages(prefix)
    setInstall({ fetched, packages, status: packages > 0 ? 'installing' : 'downloading' })
  }, PROGRESS_INTERVAL_MS)
  if (timer.unref) timer.unref()

  const code = await new Promise((resolve) => {
    proc.once('error', () => resolve(-1))
    proc.once('exit', (c) => resolve(c === null ? (stalled ? -2 : -1) : c))
  })
  clearInterval(timer)
  clearInterval(watchdog)
  if (stalled) throw new Error('安装过程长时间无进展（网络中断？），已终止；原有运行时未受影响，可重试')
  setInstall({ fetched, packages: countPackages(prefix) })
  if (code !== 0) {
    throw new Error(`安装失败（npm 退出码 ${code}）${tail.trim() ? `：${tail.trim().split('\n').slice(-3).join(' ')}` : ''}`)
  }
  return tail
}

/** 校验暂存树：入口存在、磁盘版本一致、CREATE_NO_WINDOW 补丁可打（打不上即中止，保留旧运行时） */
function verifyTree(staging, version) {
  setInstall({ status: 'verifying' })
  const entry = harnessRuntime.runtimeEntry(staging)
  if (!fs.existsSync(entry)) throw new Error('安装后未找到 dsh 入口文件')
  const installed = harnessRuntime.installedVersion(staging)
  if (installed !== version) throw new Error(`安装出的版本不符：期望 ${version}，实际 ${installed || '未识别'}`)
  const patched = harnessPatch.patchRuntime(staging)
  if (process.platform === 'win32' && !harnessPatch.isRuntimePatched(staging)) {
    throw new Error('CREATE_NO_WINDOW 补丁未生效')
  }
  log(`暂存树校验通过：${installed}（补丁 ${patched.patched ? '已应用' : '无需'}）`)
}

/** 带重试的目录操作（Windows 上刚结束的进程可能短暂占用文件） */
async function withRetry(action, label) {
  let last = null
  for (let i = 0; i < SWAP_TRIES; i += 1) {
    try { return action() } catch (err) {
      last = err
      await sleep(SWAP_DELAY_MS)
    }
  }
  throw new Error(`${label}失败：${(last && last.message) || String(last)}`)
}

/** 目录交换：旧目录保留到新服务确认就绪，才能删除备份。 */
async function swapRuntimes() {
  setInstall({ status: 'swapping' })
  const target = runtimeDir()
  const staging = stagingDir()
  const backup = backupDir()
  if (fs.existsSync(backup)) throw new Error(`发现尚未清理的旧运行时备份：${backup}；请先检查恢复状态`)
  const hadTarget = fs.existsSync(target)
  if (hadTarget) await withRetry(() => fs.renameSync(target, backup), '备份现有运行时')
  try {
    await withRetry(() => fs.renameSync(staging, target), '切换到新运行时')
  } catch (err) {
    if (hadTarget) {
      try { await withRetry(() => fs.renameSync(backup, target), '回滚运行时') } catch { /* 已尽力 */ }
    }
    throw err
  }
  return hadTarget
}

/** 新服务启动失败时，把旧运行时放回原位。新目录移至暂存区后由失败清理处理。 */
async function rollbackRuntime() {
  const target = runtimeDir()
  const staging = stagingDir()
  const backup = backupDir()
  if (!fs.existsSync(backup)) return
  if (fs.existsSync(staging)) throw new Error(`暂存目录仍存在，无法安全回滚：${staging}`)
  if (fs.existsSync(target)) await withRetry(() => fs.renameSync(target, staging), '暂存失败的新运行时')
  try {
    await withRetry(() => fs.renameSync(backup, target), '恢复旧运行时')
  } catch (error) {
    if (fs.existsSync(staging) && !fs.existsSync(target)) {
      try { await withRetry(() => fs.renameSync(staging, target), '恢复新运行时') } catch { /* 保留现场 */ }
    }
    throw error
  }
}

/** 写入热更新标记：harness-runtime 据此在启动时复用这棵树而不是被随包归档覆盖 */
function writeHotMarker(version, registry) {
  let appVersion = ''
  try { appVersion = require('electron').app.getVersion() } catch { /* 非 Electron（自测） */ }
  writeJson(harnessRuntime.hotMarkerPath(runtimeDir()), {
    dshVersion: version,
    win32NoWindowPatch: harnessPatch.WIN32_NO_WINDOW_PATCH,
    platform: process.platform,
    arch: process.arch,
    source: 'registry',
    registry,
    appVersion,
    installedAt: Date.now(),
  })
}

/** 重启 Harness 服务以使用新运行时（端口沿用配置） */
async function restartService() {
  setInstall({ status: 'restarting' })
  let port = 0
  try { port = Number(require('./store').load().harness.port) || 0 } catch { /* 非 Electron（自测） */ }
  const harnessService = require('./harness-service')
  const snapshot = await harnessService.restart(port ? { port } : {})
  return snapshot
}

/**
 * 应用内热更新：安装指定版本（缺省用最近一次检查到的最新版）并重启服务。
 * 失败时保留原有运行时（暂存目录被清掉），服务状态由调用方按返回的 error 处理。
 */
async function install(opts = {}) {
  if (runtime.install.status !== 'idle' && !['done', 'error'].includes(runtime.install.status)) {
    return { ok: false, error: '更新正在进行中' }
  }
  const guard = updateGuard()
  if (!guard.ok) return { ok: false, error: guard.reason }

  const registry = registryUrl(opts.registry)
  let version = String(opts.version || readState().latestVersion || '').trim().replace(/^v/, '')
  if (!isValidVersion(version)) {
    // 未指定版本（或记录已失效）时现查一次源
    try {
      version = (await fetchLatest(registry)).latest
    } catch (err) {
      return { ok: false, error: `无法确定要安装的版本：${(err && err.message) || String(err)}` }
    }
  }

  runtime.install = { ...idleInstall(), status: 'preparing', version, startedAt: Date.now() }
  emit()
  log(`开始热更新：${PACKAGE}@${version}（源 ${registry}）`)
  let stopBeforeSwap = false
  let swapped = false
  let hadPreviousRuntime = false
  let wasActive = false
  try {
    const { cli } = await ensureUpdater()
    const proxy = await proxyEnvFor(registry)
    if (proxy.HTTPS_PROXY) log(`npm 走系统代理：${proxy.HTTPS_PROXY}`)
    await installTree({ cli, prefix: path.join(stagingDir(), 'dsh'), version, registry, proxy })
    verifyTree(stagingDir(), version)

    // 交换前必须先停服务：Windows 上正在运行的 dsh 会锁住依赖树里的 .node 文件；
    // starting 态同样要停（其进程正跑在旧目录上），且安装完需要重启拉到新目录
    setInstall({ status: 'swapping' })
    const harnessService = require('./harness-service')
    wasActive = ['running', 'starting'].includes(harnessService.status().status)
    harnessService.stop()
    stopBeforeSwap = true
    hadPreviousRuntime = await swapRuntimes()
    swapped = true
    writeHotMarker(version, registry)

    if (wasActive) {
      const snapshot = await restartService()
      if (snapshot.status !== 'running') throw new Error(`新版本服务未能启动：${snapshot.error || snapshot.status}`)
    }
    if (hadPreviousRuntime) fs.rmSync(backupDir(), { recursive: true, force: true })
    fs.rmSync(stagingDir(), { recursive: true, force: true })
    writeState({ latestVersion: version, lastError: '', lastInstalledAt: Date.now() })
    // 统计的是 <runtime>/dsh 下的 node_modules（与安装 prefix 同级），不是 runtime 根
    setInstall({ status: 'done', packages: countPackages(path.join(runtimeDir(), 'dsh')), finishedAt: Date.now() })
    log(`热更新完成：dsh ${version}`)
    return { ok: true, version, ...status() }
  } catch (err) {
    let message = (err && err.message) || String(err)
    log('热更新失败：', message)
    if (swapped && hadPreviousRuntime) {
      try {
        require('./harness-service').stop()
        await rollbackRuntime()
      } catch (rollbackError) {
        message += `；旧运行时回滚失败：${rollbackError.message}（保留备份 ${backupDir()}）`
      }
    }
    if (!fs.existsSync(backupDir())) {
      try { fs.rmSync(stagingDir(), { recursive: true, force: true }) } catch { /* noop */ }
    }
    writeState({ lastError: `更新失败：${message}` })
    setInstall({ status: 'error', error: message, finishedAt: Date.now() })
    // 启动阶段失败：服务已停，尽力恢复原运行时并把服务拉起来
    if (stopBeforeSwap && wasActive) {
      try {
        const harnessService = require('./harness-service')
        await harnessService.start({ retryOnFail: true })
      } catch { /* 用户可手动重启 */ }
    }
    return { ok: false, error: message }
  }
}

/** 供自测把状态复位（避免套件间互相影响） */
function resetForTest() {
  runtime = { checking: false, install: idleInstall() }
}

module.exports = {
  check,
  install,
  status,
  setEmitter,
  updateGuard,
  registryUrl,
  fetchLatest,
  pickLatestVersion,
  ensureUpdater,
  countPackages,
  runtimeDir,
  stagingDir,
  backupDir,
  updaterDir,
  npmCacheDir,
  stateFile,
  DEFAULT_REGISTRY,
  CHECK_INTERVAL_MS,
  CHECK_POLICY,
  resetForTest,
}
