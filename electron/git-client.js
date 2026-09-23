/**
 * Git 服务代理（主进程侧）—— 把仓库扫描 / 提交收集转发给 electron/git-worker.js
 *
 * 主进程只保留「协调」职责：转发调用、把进度事件按 tag 路由给渲染层。
 * 重型同步工作（readdirSync 扫盘、为每个仓库建 git 子进程）全在工作进程里，
 * 主进程事件循环不再被预热任务挤占，打开应用期间窗口绘制与 IPC 保持流畅。
 *
 * 接口与 electron/git-service.js 对齐，调用方（main.js）无需关心实现位置：
 *   scanReposCached(roots, excludes, { force, tag }) → Promise<string[] 仓库路径>
 *   collectCommits(repos, opts, { tag })             → Promise<提交数组>
 *   repoInfo(repo) / identity() / invalidateScanCache()
 *
 * tag 约定（进度事件的路由方式）：
 *   'broadcast'      广播给所有窗口（预热、设置页手动扫描）
 *   `wc:<id>`        只发给指定 webContents（报告页生成报告时自己的收集进度）
 */
const path = require('path')
const { utilityProcess, webContents } = require('electron')
const { todayLocal, tomorrowLocal } = require('./git-service')

let child = null
let spawnTask = null
let isReady = false
/** 就绪握手完成前先入队，避免端口建立前投递丢失 */
let outbox = []
let seq = 0
const pending = new Map()
let eventSink = () => {}

/** 工作进程启动等待上限（首次 fork 含进程创建，本机建进程偏慢，留足余量） */
const SPAWN_TIMEOUT_MS = 20000

function debug(...args) {
  if (process.env.GIT_WORKER_DEBUG === '1') console.log('[git-worker]', ...args)
}

/** 投递消息；返回 false 表示当前没有可投递的工作进程（调用方必须自行失败，不能留下悬挂的 pending） */
function post(message) {
  if (!child) return false
  if (!isReady) { outbox.push(message); return true }
  try { child.postMessage(message) } catch { outbox.push(message) }
  return true
}

function flushOutbox() {
  if (!child || !isReady) return
  const queue = outbox
  outbox = []
  for (const message of queue) {
    try { child.postMessage(message) } catch { /* 工作进程已退出，pending 会在 exit 中统一失败 */ }
  }
}

/** 工作进程退出：所有在途调用立即失败，并复位以便下次调用重新拉起 */
function handleExit(code) {
  const error = new Error(`git 工作进程已退出（code=${code === null ? 'null' : code}）`)
  for (const record of pending.values()) record.reject(error)
  pending.clear()
  child = null
  spawnTask = null
  isReady = false
  outbox = []
  debug('工作进程退出', code)
  // 通知调用方（main.js 据此广播 scanDone，避免渲染层「正在扫描」状态悬挂）
  try { eventSink({ event: 'workerExit', tag: 'broadcast', payload: { code } }) } catch { /* noop */ }
}

function handleMessage(raw) {
  const message = raw && raw.data !== undefined && raw.event === undefined ? raw.data : raw
  if (!message) return
  if (message.event === 'ready') {
    isReady = true
    flushOutbox()
    return
  }
  if (message.event) {
    try { eventSink(message) } catch { /* 渲染层可能已销毁 */ }
    return
  }
  const record = pending.get(message.id)
  if (!record) return
  pending.delete(message.id)
  if (message.ok) record.resolve(message.result)
  else record.reject(new Error(message.error || 'git 工作进程调用失败'))
}

function ensureChild() {
  if (spawnTask) return spawnTask
  const entry = path.join(__dirname, 'git-worker.js')
  child = utilityProcess.fork(entry, [], { serviceName: 'git-service', stdio: 'pipe' })
  child.on('message', handleMessage)
  child.on('exit', handleExit)
  if (child.stdout) child.stdout.on('data', (d) => debug('stdout', String(d).trim()))
  if (child.stderr) child.stderr.on('data', (d) => debug('stderr', String(d).trim()))
  spawnTask = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('git 工作进程启动超时')), SPAWN_TIMEOUT_MS)
    if (timer.unref) timer.unref()
    child.once('spawn', () => { clearTimeout(timer); resolve(child) })
  })
  spawnTask.catch((err) => {
    // 启动失败：复位，下次调用重试（避免永久卡在失败的 spawnTask 上）
    spawnTask = null
    console.error('[git-worker] 启动失败：', err.message)
  })
  return spawnTask
}

/**
 * 发起一次工作进程调用。无超时（与原先主进程直连 git 的行为一致）；
 * 工作进程崩溃时由 handleExit 统一 reject。
 * 工作进程恰好在 await 期间退出时 handleExit 已清空 pending，此处的投递会失败——
 * 必须就地失败，否则该调用既不 resolve 也不 reject，IPC 永久悬挂（界面停在「正在收集」）。
 */
async function call(cmd, args) {
  await ensureChild()
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    if (!post({ id, cmd, args })) {
      pending.delete(id)
      reject(new Error('git 工作进程不可用（可能已退出），请重新扫描'))
    }
  })
}

/** 注册进度事件消费者（main.js 接线到渲染层广播） */
function setEventSink(fn) {
  eventSink = typeof fn === 'function' ? fn : () => {}
}

function scanReposCached(roots, excludes, opts = {}) {
  return call('scan', { roots, excludes, force: !!opts.force, tag: opts.tag || 'broadcast' })
}

function collectCommits(repos, opts, callOpts = {}) {
  return call('collect', { repos, opts, tag: callOpts.tag || 'broadcast' })
}

function getRepoInfo(repo) {
  return call('repoInfo', { repo })
}

function getIdentity() {
  return call('identity', {})
}

function invalidateScanCache() {
  return call('invalidateScanCache', {})
}

/** 结束工作进程（应用退出时调用，避免残留孤儿进程） */
function stop() {
  if (!child) return
  try { child.kill() } catch { /* 已退出 */ }
}

module.exports = {
  scanReposCached,
  collectCommits,
  getRepoInfo,
  getIdentity,
  invalidateScanCache,
  setEventSink,
  stop,
  todayLocal,
  tomorrowLocal,
  /** 供 main.js 判断进度事件路由：`wc:<id>` 只回发起窗口，其余广播 */
  isWindowTag: (tag) => typeof tag === 'string' && tag.startsWith('wc:'),
  windowTag: (id) => `wc:${id}`,
  /** 由 tag 解析目标 webContents（不存在时返回 null） */
  windowFromTag: (tag) => {
    const id = Number(String(tag || '').slice(3))
    return Number.isInteger(id) ? webContents.fromId(id) : null
  },
}
