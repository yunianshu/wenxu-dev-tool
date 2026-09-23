/**
 * Git 工作进程（Electron utilityProcess）—— 仓库扫描 / 提交收集全部移出主进程
 *
 * 为什么必须独立进程：Windows 上 child_process 建进程的同步部分（CreateProcess
 * 及安全软件的进程扫描）发生在**调用它的那个线程**上，实测本机单次 git.exe 建进程
 * 100~200ms。启动预热要为 77 个仓库各起一个 git 进程，实测 execFile 同步部分累计
 * 4037ms/77 次（单次最长 202ms）——这些同步开销原先全落在主进程事件循环上，期间
 * 窗口绘制与 IPC 被挤在后面（首页 configLoad 往返最大 452ms）。放进 utilityProcess
 * 后，同步建进程只阻塞工作进程，主进程事件循环不再受影响。
 *
 * 为什么不选 worker_threads：打包后脚本位于 app.asar 内，而 Node 内部模块加载不经
 * Electron 打过补丁的 fs，asar 内的 worker 脚本有加载失败风险；utilityProcess 是
 * Electron 官方为「Node 子进程 + 消息通道」提供的入口，对 asar 友好。
 *
 * 通信协议（与 electron/git-client.js 配对）：
 *   主 → 工作进程   { id, cmd, args }
 *   工作进程 → 主   { id, ok: true, result } / { id, ok: false, error }
 *   进度事件        { event, tag, payload }（tag 由主进程决定路由：广播 or 只回发起窗口）
 */
const gitService = require('./git-service')

const port = process.parentPort || {
  postMessage: (message) => process.send?.(message),
  on: (event, listener) => process.on(event, listener),
}

function post(message) {
  try { port.postMessage(message) } catch { /* 主进程已退出 */ }
}

/** 进度事件：tag 原样回传，主进程据此决定广播还是只发给发起窗口 */
function emit(event, tag, payload) {
  post({ event, tag, payload })
}

const HANDLERS = {
  /** 目录扫描（结果进程内缓存 + 进行中去重都在本进程，与原先语义一致） */
  async scan({ roots, excludes, force, tag }) {
    return gitService.scanReposCached(roots, excludes, {
      force: !!force,
      onProgress: (progress) => emit('scanProgress', tag, progress),
      onRepo: (repo) => emit('scanRepoFound', tag, repo),
    })
  },
  /** 提交收集（并发池 + 增量缓存同样留在本进程，报告页生成报告可直接命中预热结果） */
  async collect({ repos, opts, tag }) {
    return gitService.collectCommits(repos, opts, (progress) => emit('collectProgress', tag, progress))
  },
  async repoInfo({ repo }) {
    return gitService.getRepoInfo(repo)
  },
  async identity() {
    return gitService.getIdentity()
  },
  async invalidateScanCache() {
    gitService.invalidateScanCache()
    return true
  },
}

port.on('message', async (messageEvent) => {
  // utilityProcess 的 parentPort 是 Web 风格 MessagePort：数据在 event.data
  const msg = messageEvent && messageEvent.data !== undefined ? messageEvent.data : messageEvent
  const { id, cmd, args } = msg || {}
  const handler = HANDLERS[cmd]
  if (!handler) {
    post({ id, ok: false, error: `未知命令：${cmd}` })
    return
  }
  try {
    const result = await handler(args || {})
    post({ id, ok: true, result })
  } catch (err) {
    post({ id, ok: false, error: (err && err.message) || String(err) })
  }
})

// 就绪握手：主进程收到后才开始投递请求，避免端口建立前的消息丢失
post({ event: 'ready' })
