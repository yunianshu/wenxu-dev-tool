/**
 * DeepSeek Harness（dsh web）服务 —— 生命周期管理
 *
 * 应用启动时自动拉起 `dsh web`（本地浏览器 GUI），退出时连同子进程树一起关闭，
 * 使本应用成为 Harness 的唯一入口：开软件即有服务，关软件即无残留。
 *
 * 关键约束：
 * - 内置 dsh 依赖树由 **Electron 自带的 Node** 执行（`ELECTRON_RUN_AS_NODE=1`），
 *   目标机器无需安装 dsh 或 Node；dsh 的 HMR 服务要求 `--expose-internals`。
 * - `dsh web` 就绪后会打印一行 `dsh web: http://127.0.0.1:<port>/?token=...`，
 *   该 token 是**一次性进程凭据**：浏览器首次访问它才会换取 HttpOnly +
 *   SameSite=Strict 的登录 cookie。因此内嵌 webview 必须先用这条带 token 的 URL
 *   导航（跨站导航不会带上 Strict cookie，直接开根地址会 401）。
 * - token 只在本进程与本应用渲染层之间流转，不写日志、不落盘。
 * - 子进程由 cmd/sh 包裹时，普通 kill 杀不掉真正的服务进程，Windows 用 taskkill /T，
 *   POSIX 用进程组负号信号；同时把 pid 落到 userData，异常退出后可清理残留。
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { ensureDefaultSettings } = require('./harness-defaults')
const harnessRuntime = require('./harness-runtime')

/** 默认监听端口（被占用时自动改用系统分配的空闲端口） */
const DEFAULT_PORT = 3080
/** 就绪等待上限：首次启动要加载插件与前端资源，留足时间 */
const READY_TIMEOUT_MS = 90000
/** 自启动失败后的重试间隔（秒级：给插件加载/资源竞争留缓冲，期间用户操作可打断） */
const RETRY_DELAY_MS = 8000
/** 服务就绪标志行 */
const URL_LINE = /dsh web:\s*(http:\/\/\S+)/
/** 诊断输出保留长度（出错时回传渲染层展示） */
const MAX_LOG_CHARS = 4000

let child = null
let starting = null
/** 启动序号：stop()/restart() 递增使进行中的启动作废（解包/等待就绪阶段没有 child 可杀，
 *  只能作废；作废的启动即使随后输出服务地址也按已停止处理，不覆盖 stop 设置的状态） */
let startSeq = 0
/** 当前 starting Promise 对应的序号（已被作废的 starting 允许被新 start() 替换，restart 依赖此行为） */
let startingToken = -1
let emitter = () => {}
let logBuffer = ''
let state = {
  status: 'stopped', // stopped | starting | running | error
  stage: '',         // starting 阶段的细分（extract=正在解包内置运行时）
  port: 0,
  pid: 0,
  url: '',          // 带 token，仅供内嵌 webview 首次导航
  displayUrl: '',   // 脱敏后的地址，供界面展示
  error: '',
  cli: '',          // 实际使用的 dsh 入口
  runtime: '',      // bundled（安装包内置）| system（本机全局安装）| path（PATH 解析）
  runtimeDir: '',   // 内置运行时目录
  home: '',
  defaults: '',     // 内置默认配置注入结果（诊断用）
  startedAt: 0,
}

/** Harness 主目录（dsh 的 $DSH_HOME，默认 ~/.dsh） */
function homeDir() {
  return (process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
}

/** 定位 dsh 可执行文件；找不到返回空串（交由 PATH 解析） */
function resolveCli() {
  const override = (process.env.DSH_CLI || '').trim()
  if (override) return override
  const candidates = []
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'dsh.cmd'))
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'dsh.cmd'))
  } else {
    candidates.push(
      '/usr/local/bin/dsh',
      '/usr/bin/dsh',
      path.join(os.homedir(), '.npm-global', 'bin', 'dsh'),
      path.join(os.homedir(), '.local', 'bin', 'dsh'),
    )
  }
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* noop */ }
  }
  return ''
}

/**
 * 内置运行时目录（随安装包分发）：
 * 打包后为解包到用户数据目录的运行时（安装包实际分发的是 harness-runtime.tar.gz，
 * 见 electron/harness-runtime.js），开发态为 <repo>/build/harness-runtime。
 *
 * 统一走 harness-runtime 的解析链（DSH_RUNTIME_DIR → 随包原样目录 → 用户目录已解包
 * 或应用内热更新装出来的运行时）：这样「热更新装到用户目录」与「服务实际启动哪个目录」
 * 永远是同一个判断，不会出现更新成功但服务仍跑旧目录的情况。
 */
function bundledRuntimeDir() {
  // DSH_RUNTIME_DIR 显式指定运行时目录（不设时按安装包/开发态默认位置查找）
  const override = (process.env.DSH_RUNTIME_DIR || '').trim()
  if (override) {
    try { return fs.existsSync(path.join(override, 'dsh')) ? override : '' } catch { return '' }
  }
  return harnessRuntime.resolveRuntime().dir
}

function bundledEntry(dir) {
  const entry = path.join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return fs.existsSync(entry) ? entry : ''
}

/**
 * 解析启动方式，优先级：内置依赖树 → 系统全局 dsh → PATH。
 *
 * 内置依赖树用 **Electron 自带的 Node** 运行（`ELECTRON_RUN_AS_NODE=1`），
 * 目标机器无需另装 Node。Electron 40+ 内置 Node 24，具备 dsh 需要的
 * `node:sqlite` 与 `import.meta.main`；dsh 的 HMR 服务还要求 `--expose-internals`
 * （不加会在加载 cordis-plugin-hmr 时抛错退出）。
 *
 * @returns {{runtime: string, command: string, prefixArgs: string[], shell: boolean, runtimeDir: string, extraEnv?: object}}
 */
function resolveLaunch() {
  const dir = bundledRuntimeDir()
  if (dir) {
    const entry = bundledEntry(dir)
    if (entry) {
      return {
        runtime: 'bundled',
        command: process.execPath,
        prefixArgs: ['--expose-internals', entry],
        shell: false,
        runtimeDir: dir,
        extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      }
    }
  }
  const cli = resolveCli()
  if (cli) return { runtime: 'system', command: cli, prefixArgs: [], shell: process.platform === 'win32', runtimeDir: '' }
  return { runtime: 'path', command: 'dsh', prefixArgs: [], shell: process.platform === 'win32', runtimeDir: '' }
}

/** dsh 的 npm shim 内部依赖 PATH 中的 node，尽量把 node 目录补进子进程环境 */
function resolveNodeDir() {
  if (process.platform !== 'win32') return ''
  const candidates = []
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node.exe'))
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'))
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return path.dirname(candidate) } catch { /* noop */ }
  }
  try {
    const result = spawnSync('where', ['node'], { windowsHide: true, encoding: 'utf8' })
    const first = String(result.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first) return path.dirname(first)
  } catch { /* noop */ }
  return ''
}

function buildEnv() {
  const env = { ...process.env }
  const nodeDir = resolveNodeDir()
  if (nodeDir) env.PATH = `${nodeDir}${path.delimiter}${env.PATH || ''}`
  return env
}

/** 是否已安装 Harness（内置运行时 / 随包归档 / CLI / 已有 ~/.dsh 主目录任一存在） */
function isInstalled() {
  if (bundledRuntimeDir()) return true
  if (harnessRuntime.hasShippedRuntime()) return true // 归档在、尚未解包也算可用
  if (resolveCli()) return true
  try { return fs.existsSync(homeDir()) } catch { return false }
}

/** 残留进程记录文件（Electron 未就绪时退回临时目录，便于脱离 Electron 单测） */
function pidFile() {
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'harness.json')
  } catch { /* 非 Electron 环境 */ }
  return path.join(os.tmpdir(), 'dev-project-manager-harness.json')
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(pidFile(), 'utf8')) } catch { return null }
}

function writePidFile(payload) {
  try { fs.writeFileSync(pidFile(), JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 }) } catch { /* noop */ }
}

function clearPidFile() {
  try { fs.rmSync(pidFile(), { force: true }) } catch { /* noop */ }
}

function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(true)
    const server = net.createServer()
    const done = (free) => { try { server.close() } catch { /* noop */ } resolve(free) }
    server.once('error', () => resolve(false))
    server.once('listening', () => done(true))
    server.listen(port, '127.0.0.1')
  })
}

/** 结束整棵子进程树（Windows 必须 /T，否则 node 子进程会残留） */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* noop */ }
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* noop */ } }
}

/** 清理上次异常退出遗留的 Harness 进程（需 pid 存活且记录端口仍被占用，避免误杀复用的 PID） */
async function cleanupStale() {
  const record = readPidFile()
  if (!record || !record.pid) return
  if (!isAlive(record.pid)) { clearPidFile(); return }
  if (record.port && !(await isPortFree(record.port))) killTree(record.pid)
  clearPidFile()
}

/**
 * 清理 dsh profiles 模块锁的孤儿残留。dsh 每次启动都会持
 * `<home>/profiles/node_modules.lock` 校验/重建模块回退链接（更新运行时后必触发），
 * 锁内容是持有者 PID；进程被 taskkill /F 强杀（本应用的 stop 与更新流程都会）时
 * 锁文件不会随之消失，dsh 的锁协议也不自行回收孤儿锁，之后每次启动都会在 2 秒
 * 锁等待上超时失败，只能人工删锁。仅在锁内 PID 已死时删除：PID 存活说明有真实
 * 持有者（或 PID 已被其它进程复用，保守起见不动），交回正常的锁等待。
 */
function clearOrphanModuleLock() {
  const lockPath = path.join(homeDir(), 'profiles', 'node_modules.lock')
  let pid
  try {
    pid = Number(String(fs.readFileSync(lockPath, 'utf8')).trim())
  } catch {
    return // 无锁（ENOENT）或读不了都不抢戏：后者留给 dsh 自己报错
  }
  if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) return
  // 复读确认仍是那个死 PID：与其它清理者/新持有者交错的窗口内内容变了就不动
  try {
    if (Number(String(fs.readFileSync(lockPath, 'utf8')).trim()) !== pid) return
    fs.rmSync(lockPath, { force: true })
    console.log(`[harness] 已清理孤儿模块锁（持有者 PID ${pid} 已退出）：`, lockPath)
  } catch { /* noop */ }
}

function snapshot() {
  return {
    ...state,
    installed: isInstalled(),
    // 当前运行时里的 dsh 版本（界面展示 + 更新提示的比较基准）
    dshVersion: harnessRuntime.currentRuntimeVersion(),
    detail: logBuffer.slice(-MAX_LOG_CHARS),
  }
}

function setState(patch) {
  state = { ...state, ...patch }
  try { emitter(snapshot()) } catch { /* 渲染层可能已销毁 */ }
}

function setEmitter(fn) {
  emitter = typeof fn === 'function' ? fn : () => {}
}

/**
 * 拉起子进程：
 * - 内置依赖树：用 Electron 自身以 Node 模式执行 dsh 的 bin.js（无 shell、无需外部 Node）
 * - 系统 dsh：Windows 的 .cmd shim 必须经 cmd.exe；POSIX 用独立进程组以便整组关闭
 */
function spawnHarness(launch, args, cwd) {
  // cwd 不存在会让 spawn 直接 ENOENT：兜底到确实存在的目录
  let workdir = cwd
  try { if (!workdir || !fs.existsSync(workdir)) workdir = os.homedir() } catch { workdir = undefined }
  const options = {
    cwd: workdir,
    env: { ...buildEnv(), ...(launch.extraEnv || {}) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  if (!launch.shell) {
    return spawn(launch.command, [...launch.prefixArgs, ...args], {
      ...options,
      detached: process.platform !== 'win32',
    })
  }
  // 显式走 cmd /d /s /c：比 shell:true 少一层隐式拼接（避免 DEP0190），
  // 参数均为固定字面量，不引入外部输入
  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
  const line = [launch.command, ...args].join(' ')
  return spawn(comspec, ['/d', '/s', '/c', line], options)
}

async function doStart(opts = {}, token = startSeq) {
  // 上一轮超时保留的现场进程（超时不清进程是刻意的，供迟到就绪行翻正）：
  // 本轮要重新拉起服务，先回收避免泄漏与端口冲突
  if (child && child.exitCode === null) {
    killTree(child.pid)
    child = null
    clearPidFile()
  }

  // 先清理上次异常退出遗留的进程，避免它们占着旧的运行时目录导致解包删不掉
  await cleanupStale()
  // 同理清掉强杀留下的孤儿模块锁，否则 dsh 启动会卡在锁等待上超时
  clearOrphanModuleLock()

  // 内置运行时以单文件归档随包分发：首次使用（或升级换版本）需解包到用户数据目录，约 1 分钟
  await harnessRuntime.ensureBundledRuntime({
    onStage: (stage) => {
      if (stage !== 'extract' || token !== startSeq) return
      setState({
        status: 'starting', stage, error: '', port: 0, pid: 0, url: '', displayUrl: '',
        startedAt: Date.now(), runtime: 'bundled', cli: '', runtimeDir: '',
      })
    },
  })
  // 解包耗时可达分钟级：期间用户可能已点停止/重启，作废的启动不再拉起进程
  if (token !== startSeq) return snapshot()

  const launch = resolveLaunch()
  const bundled = launch.runtime === 'bundled'
  if (!bundled && !resolveCli() && !fs.existsSync(homeDir())) {
    setState({
      status: 'error', stage: '',
      error: '未检测到 DeepSeek Harness（dsh）。请先安装：npm i -g @deepseek-ai/dsh',
      cli: '', runtime: launch.runtime, runtimeDir: '', home: homeDir(),
    })
    return snapshot()
  }

  const home = homeDir()
  // 内置默认 provider/模型（不含密钥）：只补缺失项、一次性注入，失败不阻塞启动
  let defaultsNote = ''
  try {
    const defaults = ensureDefaultSettings({ home })
    if (defaults.injected.length) defaultsNote = `已注入内置默认配置：${defaults.injected.join('、')}`
    else if (defaults.reason && defaults.reason !== 'already-injected') defaultsNote = `内置默认配置未注入（${defaults.reason}）`
  } catch (err) {
    defaultsNote = `内置默认配置注入失败：${(err && err.message) || String(err)}`
  }
  if (defaultsNote) console.log('[harness]', defaultsNote)

  const preferred = Number.isInteger(opts.port) && opts.port > 0 && opts.port < 65536 ? opts.port : DEFAULT_PORT
  const port = (await isPortFree(preferred)) ? preferred : 0 // 端口被占用时交给系统分配，地址以启动输出为准
  // 就绪等待上限可注入（自测用短超时触发翻正/重试路径），默认 90 秒
  const readyTimeoutMs = Number.isInteger(opts.readyTimeoutMs) && opts.readyTimeoutMs > 0
    ? opts.readyTimeoutMs : READY_TIMEOUT_MS
  const args = ['web', '--no-open', '--host', '127.0.0.1', '--port', String(port)]

  logBuffer = ''
  setState({
    status: 'starting', stage: '', error: '', port, pid: 0, url: '', displayUrl: '', home, startedAt: Date.now(),
    runtime: launch.runtime,
    runtimeDir: launch.runtimeDir,
    defaults: defaultsNote,
    cli: bundled ? launch.prefixArgs[0] : launch.command,
  })

  return await new Promise((resolve) => {
    // 解包后的端口探测等 await 期间 stop() 可能已介入：不再拉起进程
    if (token !== startSeq) return resolve(snapshot())

    let settled = false
    let timer = null
    const finish = (patch) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      // 旧启动只结束自己的等待，不能改写停止状态或后来实例的运行状态。
      if (token !== startSeq) {
        resolve(snapshot())
        return
      }
      setState(patch)
      resolve(snapshot())
    }

    let proc
    try {
      proc = spawnHarness(launch, args, os.homedir())
    } catch (err) {
      finish({ status: 'error', error: `启动 dsh 失败：${(err && err.message) || String(err)}` })
      return
    }
    child = proc
    setState({ pid: proc.pid })
    // spawn 落在 stop() 之后（极窄窗口）：立即回收，避免无人管理的泄漏进程
    if (token !== startSeq) {
      killTree(proc.pid)
      clearPidFile()
      return finish({ status: 'stopped', url: '', displayUrl: '', port: 0, pid: 0, error: '' })
    }

    timer = setTimeout(() => {
      // 超时不清进程：插件加载可能仍在继续，保留现场供用户重试/查看日志；
      // 服务随后打印地址时由 onChunk 翻正回 running
      finish({
        status: 'error',
        error: `启动超时（${Math.round(readyTimeoutMs / 1000)} 秒内未输出服务地址）`,
      })
    }, readyTimeoutMs)
    if (timer.unref) timer.unref()

    const onChunk = (chunk) => {
      if (token !== startSeq || child !== proc) return
      const text = String(chunk)
      logBuffer = (logBuffer + text).slice(-MAX_LOG_CHARS)
      const matched = text.match(URL_LINE) || logBuffer.match(URL_LINE)
      if (!matched) return
      const url = matched[1]
      let actualPort = preferred
      try { actualPort = Number(new URL(url).port) || actualPort } catch { /* 保留预期端口 */ }
      if (settled) {
        // 超时后迟到的就绪行：服务实际已起来（超时只是等待上限），翻正状态；
        // 已被 stop()/restart() 作废的启动不得翻正（进程已被杀）
        if (token !== startSeq || child !== proc) return
        writePidFile({ pid: proc.pid, port: actualPort, startedAt: Date.now() })
        setState({
          status: 'running', url,
          displayUrl: `http://127.0.0.1:${actualPort}`,
          port: actualPort, pid: proc.pid, error: '',
        })
        return
      }
      if (state.status !== 'starting') return
      writePidFile({ pid: proc.pid, port: actualPort, startedAt: Date.now() })
      finish({
        status: 'running',
        url,
        displayUrl: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        pid: proc.pid,
        error: '',
      })
    }
    proc.stdout.on('data', onChunk)
    proc.stderr.on('data', onChunk)

    proc.on('error', (err) => {
      if (child === proc) child = null
      finish({ status: 'error', error: `启动 dsh 失败：${(err && err.message) || String(err)}` })
    })

    proc.on('exit', (code, signal) => {
      // taskkill/SIGTERM 的退出事件可能晚于重启就绪；记录与状态归当前实例所有。
      if (token !== startSeq || child !== proc) {
        finish({})
        return
      }
      child = null
      clearPidFile()
      const reason = `Harness 服务已退出（code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''}）`
      if (settled && state.status === 'running') {
        // 运行中崩溃：更新状态供界面提示并允许重启
        setState({ status: 'error', url: '', displayUrl: '', pid: 0, error: reason })
        return
      }
      finish({ status: 'error', url: '', displayUrl: '', pid: 0, error: reason })
    })
  })
}

/** 启动服务（幂等：运行中直接返回当前状态，启动中且未被作废时复用同一个 Promise） */
async function start(opts = {}) {
  if (state.status === 'running' && child && child.exitCode === null) return snapshot()
  if (starting && startingToken === startSeq) return starting
  const token = ++startSeq
  startingToken = token
  starting = (opts.retryOnFail === true ? startWithRetry(opts, token) : doStart(opts, token))
    .finally(() => { if (startingToken === token) starting = null })
  return starting
}

/**
 * 自启动专用：失败后延迟重试一次。启动失败多为插件加载慢/瞬态资源竞争
 * （启动即拉起会与仓库扫描预热并发），隔几秒重来通常即可就绪；重试间隔内
 * 用户手动操作（停止/重启）会作废 token，随即放弃重试交还控制权。
 */
async function startWithRetry(opts, token) {
  let result = await doStart(opts, token)
  if (result.status !== 'error') return result
  // 注意保持 timer 引用（不 unref）：重试是关键路径，unref 会让纯 Node 场景
  // （自测）在等待期因事件循环清空而直接退出
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  if (token !== startSeq) return snapshot()
  console.log('[harness] 自启动未就绪，自动重试一次')
  result = await doStart(opts, token)
  if (result.status === 'error') console.log('[harness] 重试后仍未就绪：', result.error || result.status)
  return result
}

/** 关闭服务：连同子进程树一起结束，并清理残留记录 */
function stop() {
  startSeq += 1 // 作废进行中的启动（解包阶段无 child 可杀）
  const proc = child
  child = null
  if (proc) killTree(proc.pid)
  clearPidFile()
  logBuffer = '' // 主动停止时清空日志，避免下次进入页面残留旧输出
  setState({ status: 'stopped', port: 0, pid: 0, url: '', displayUrl: '', error: '' })
  return snapshot()
}

/** 重启：先关后开（返回新状态） */
async function restart(opts = {}) {
  stop()
  return start(opts)
}

function status() {
  return snapshot()
}

module.exports = {
  start,
  stop,
  restart,
  status,
  setEmitter,
  resolveCli,
  resolveLaunch,
  bundledRuntimeDir,
  isInstalled,
  homeDir,
  clearOrphanModuleLock,
  DEFAULT_PORT,
}
