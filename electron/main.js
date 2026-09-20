/**
 * 主进程入口
 */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, webContents, Tray, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const gitService = require('./git-client')
const store = require('./store')
const reportHistory = require('./report-history')
const aiService = require('./ai-service')
const projectService = require('./project-service')
const extensionsService = require('./extensions-service')
const terminalService = require('./terminal-service')
const ptyService = require('./pty-service')
const terminalLayout = require('./terminal-layout')
const uiPrefs = require('./ui-prefs')
const localDebugService = require('./local-debug-service')
const deployService = require('./deploy/deploy-service')
const deployProjects = require('./deploy/deploy-projects')
const deployHistory = require('./deploy/history')
const releaseNotes = require('./deploy/release-notes')
const aiDeploy = require('./deploy/ai-deploy')
const fillService = require('./fill-service')
const zentaoService = require('./zentao-service')
const hanprintService = require('./hanprint-service')
const harnessService = require('./harness-service')
const harnessUpdate = require('./harness-update')

// 统一数据目录为 ASCII 固定值，与产品显示名（productName，可中文）解耦：
// dev / 打包 GUI / 无头 CLI 三模式共用同一份配置，改名或换产品名不丢数据
app.setPath('userData', process.env.PROJECT_MANAGER_USER_DATA || path.join(app.getPath('appData'), 'dev-project-manager'))

// 冒烟自动化依赖稳定的定时器时序：窗口被遮挡/失焦时 Chromium 会强制节流渲染层
// 的链式 setTimeout（最严 1 次/分钟），SMOKE_EVAL 的轮询会停滞到超出退出时限，
// 表现为「取不到渲染层结果」。必须在 app ready 前关闭这些节流（仅冒烟模式）。
if (process.env.SMOKE_EXIT_MS) {
  app.commandLine.appendSwitch('disable-background-timer-throttling')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
}

// 一次性迁移：旧版本默认数据目录 %APPDATA%/git-report-desktop（更名前）。
// 仅在新目录还没有任何配置、且未通过 PROJECT_MANAGER_USER_DATA 显式指定数据目录时，
// 把旧数据文件复制过来（复制而非移动，旧目录保留作备份）。
if (!process.env.PROJECT_MANAGER_USER_DATA) {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'git-report-desktop')
    const currentDir = app.getPath('userData')
    const legacyFiles = ['config.json', 'deploy-projects.json', 'deploy-history.json', 'reports.json']
    const legacyDirs = ['reports', 'deploy-logs']
    if (legacyDir !== currentDir && fs.existsSync(path.join(legacyDir, 'config.json')) && !fs.existsSync(path.join(currentDir, 'config.json'))) {
      fs.mkdirSync(currentDir, { recursive: true })
      for (const f of legacyFiles) {
        const src = path.join(legacyDir, f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(currentDir, f))
      }
      for (const d of legacyDirs) {
        const src = path.join(legacyDir, d)
        if (fs.existsSync(src)) fs.cpSync(src, path.join(currentDir, d), { recursive: true })
      }
      console.log('[migrate] 已从旧数据目录 git-report-desktop 迁移配置')
    }
  } catch (e) {
    console.error('[migrate] 旧数据目录迁移失败（不影响启动）', e.message)
  }
}

let mainWindow

// 关闭行为（最小化到托盘）配套单实例锁：进程常驻托盘后再次启动应唤起已有窗口，
// 而不是双开第二个实例（冒烟自动化同样参与抢锁，保持与真实运行一致的行为）。
const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
} else {
  // 已有实例常驻（含最小化到托盘）时，再次启动直接唤起已有窗口
  app.on('second-instance', () => showMainWindow())
}

/** 真正退出中（托盘退出 / 关闭对话框选退出 / app.quit）：close 事件直接放行 */
let isQuitting = false
/** 系托盘实例（关闭最小化后窗口的唯一常驻入口） */
let tray = null

/** 显示并聚焦主窗口（托盘双击 / 菜单 / 二次启动唤起） */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (process.env.SMOKE_EXIT_MS) console.log('[SMOKE][win-shown]')
}

/** 隐藏窗口到托盘（关闭行为的默认动作；程序继续后台运行） */
function hideToTray() {
  mainWindow.hide()
  if (process.env.SMOKE_EXIT_MS) console.log('[SMOKE][win-hidden]')
}

/** 关闭询问状态：渲染层弹 Element Plus 风格询问框（与项目 UI 一致），结果经 win:closeConfirm 回传 */
let pendingAskClose = false
let askCloseTimer = null

/** 关闭窗口前询问用户：默认最小化到托盘（程序继续后台运行），可选直接退出（close 事件已 preventDefault） */
function askOnClose() {
  // 防重入：询问框已开着时（用户连续点 × / Alt+F4）只保留一次询问
  if (pendingAskClose) return
  pendingAskClose = true
  // 渲染层无响应兜底（页面卡死/未就绪）：按默认语义最小化，绝不直接杀死程序
  askCloseTimer = setTimeout(() => {
    if (!pendingAskClose) return
    pendingAskClose = false
    hideToTray()
  }, 8000)
  broadcast('win:askClose')
}

/** 创建系统托盘：最小化到托盘后的常驻入口（显示窗口 / 退出） */
function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, '../build/icon.png')
  try {
    const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    if (image.isEmpty()) throw new Error(`托盘图标为空：${iconPath}`)
    tray = new Tray(image)
    tray.setToolTip('Personnel PLM（后台运行中）')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出程序', click: () => { isQuitting = true; app.quit() } },
    ]))
    // Windows 习惯：双击托盘图标直接唤起窗口
    tray.on('double-click', () => showMainWindow())
  } catch (e) {
    // Linux 无托盘支持等场景：不创建托盘，二次启动实例仍可通过单实例锁唤起窗口
    console.error('[tray] 托盘创建失败（最小化功能仍可用）', e.message)
  }
}

/** 向主窗口广播事件（预热等主进程主动任务无 sender，统一走此通道） */
function broadcast(channel, payload) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
  if (wc) { try { wc.send(channel, payload) } catch { /* noop */ } }
}

function createWindow() {
  const smokeWidth = Number(process.env.SMOKE_WIDTH) || 1320
  const smokeHeight = Number(process.env.SMOKE_HEIGHT) || 860
  mainWindow = new BrowserWindow({
    width: smokeWidth,
    height: smokeHeight,
    frame: false, // 无边框：原生标题栏隐藏，最小化/最大化/关闭由顶栏自定义按钮承担
    minWidth: 1080,
    minHeight: 700,
    title: 'Personnel PLM',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // DeepSeek Harness 内嵌页：webview 是独立的 guest WebContents，
      // 不受父页 CSP / X-Frame-Options 限制，且能带上 SameSite=Strict 的登录 cookie
      webviewTag: true,
    },
  })

  // 最大化状态同步给渲染层（自定义标题栏按钮图标切换）
  mainWindow.on('maximize', () => broadcast('win:maximized', true))
  mainWindow.on('unmaximize', () => broadcast('win:maximized', false))

  // 关闭行为拦截：ask（默认，弹询问框）/ minimize（直接最小化到托盘）/ quit（直接退出）；
  // 真正退出（托盘退出 / 询问框选退出 / app.quit）时 isQuitting 已置位，直接放行
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    const action = store.load().closeAction
    if (action === 'quit') return
    event.preventDefault()
    if (action === 'minimize') {
      hideToTray()
      return
    }
    askOnClose()
  })

  // 沉浸全屏（Harness 内嵌页铺满整屏）：窗口全屏状态是唯一真源，渲染层据此隐藏应用外壳
  mainWindow.on('enter-full-screen', () => broadcast('win:fullscreen', true))
  mainWindow.on('leave-full-screen', () => broadcast('win:fullscreen', false))
  // webview 是独立 webContents，焦点在 guest 内时按键不会冒泡到宿主页：全屏下按 Esc
  // 退出必须由主进程在 guest 侧监听，否则用户在 dsh 界面里按 Esc 会被困在全屏。
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guest.on('before-input-event', (_e, input) => {
      const isEscape = input && (input.key === 'Escape' || input.code === 'Escape')
      if (isEscape && input.type === 'keyDown' && mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false)
      }
    })
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 兜底：渲染层首帧上报缺失（页面异常/无渲染层场景）时，窗口加载完成后自行启动后台任务，
  // 不能因为少了一个上报就让预热与内置 Harness 永不启动
  mainWindow.webContents.once('did-finish-load', () => {
    const timer = setTimeout(() => startBackgroundTasks('兜底计时'), BACKGROUND_FALLBACK_MS)
    if (timer.unref) timer.unref()
  })
}

/**
 * 启动预热 —— 把「扫描 + 收集默认范围（今天）」提前到后台执行：
 * 用户点「生成报告」时，仓库列表与今日提交缓存均已就绪，报告近乎即时生成。
 * 幂等：预热进行中/已完成的重复触发直接复用（scanReposCached/collectCommits 内部去重）。
 */
let warmupTask = null

/**
 * 已发现仓库快照 —— 渲染层接线（onMounted 注册监听器）与预热启动之间没有严格先后：
 * 兜底路径（did-finish-load 后计时）或设置页手动扫描都可能早于监听器就绪，
 * 只靠事件累积会让「Git 活动源」数量少于收集进度的总数。渲染层接线后主动拉取本快照补齐。
 */
let knownRepos = []

/** 发现仓库：先入快照再广播，保证快照不落后于事件 */
function rememberRepo(repoPath) {
  if (repoPath && !knownRepos.includes(repoPath)) knownRepos.push(repoPath)
  broadcast('git:scanRepoFound', repoPath)
}

async function warmupPipeline() {
  const task = (async () => {
    const cfg = store.load()
    if (!cfg.roots || !cfg.roots.length) return []
    // 扫描与收集的实际执行都在 git 工作进程内（见 electron/git-worker.js）：
    // 进度/发现事件经 handleGitEvent 转发，主进程只做协调
    const repos = await gitService.scanReposCached(cfg.roots, cfg.excludes, { tag: 'broadcast' })
    knownRepos = [...repos] // 扫描结果为权威列表（缓存命中时不会触发 onRepo）
    // 预热路径同样广播 scanDone：渲染层扫描态复位不依赖用户手动扫描
    broadcast('git:scanDone', { total: repos.length })
    if (!repos.length) return repos
    // 预收集「日报=今天」范围（与报告页默认参数一致，可精确命中缓存）
    await gitService.collectCommits(repos, {
      since: gitService.todayLocal(),
      until: gitService.tomorrowLocal(),
      authors: [],
      includeMerges: false,
    }, { tag: 'broadcast' })
    return repos
  })()
  warmupTask = task.catch(() => {
    // 失败同样广播 scanDone，渲染层扫描态不得悬挂
    broadcast('git:scanDone', { total: 0 })
    warmupTask = null // 失败允许下次触发重试
  })
  return warmupTask
}

/** 渲染层首帧兜底等待上限：渲染层异常未上报时，主进程自行启动后台任务（可注入，便于自测） */
const BACKGROUND_FALLBACK_MS = Number(process.env.BACKGROUND_FALLBACK_MS) > 0
  ? Number(process.env.BACKGROUND_FALLBACK_MS)
  : 8000
/** 后台任务（仓库预热 + 内置 Harness）是否已启动；两项自身均幂等 */
let backgroundStarted = false

/**
 * 启动后台任务（仓库预热 + 内置 Harness）。
 *
 * 触发时机是「渲染层首帧已绘制」（渲染层经 app:uiReady 上报），而不是 app ready：
 * 预热要为每个仓库建 git 子进程，而 Windows 上建进程是同步阻塞调用线程的，放在首帧前
 * 会与首屏渲染抢主进程和磁盘（实测首屏 FCP 因此多花约 90~150ms，且打开后头 4 秒
 * 首页 IPC 往返被拖到 100~452ms）。did-finish-load 后仍未收到上报时由计时器兜底，
 * 保证渲染层异常或无渲染层的场景下预热与 Harness 不会缺席。
 */
function startBackgroundTasks(source) {
  if (backgroundStarted) return
  backgroundStarted = true
  if (process.env.SMOKE_EXIT_MS) console.log(`[startup] 后台任务启动（${source}）`)
  warmupPipeline()
  startHarnessIfEnabled()
  startHarnessUpdateWatch()
}

/** 内置 DeepSeek Harness 自启动（autoStart=false 时不启动；冒烟模式默认跳过） */
function startHarnessIfEnabled() {
  // 冒烟模式默认跳过（服务启动会占用 90s 级时序），需要时用 SMOKE_HARNESS=1 显式开启
  if (process.env.SMOKE_EXIT_MS && process.env.SMOKE_HARNESS !== '1') return
  const cfg = store.load()
  if (cfg.harness && cfg.harness.autoStart === false) return
  harnessService.start({ port: cfg.harness && cfg.harness.port, retryOnFail: true })
    .then((snapshot) => {
      if (snapshot.status === 'running') console.log('[harness] 已启动', snapshot.displayUrl)
      else console.log('[harness] 启动未就绪：', snapshot.error || snapshot.status)
    })
    .catch((err) => console.log('[harness] 启动失败：', (err && err.message) || String(err)))
}

/** 首次检查更新的延迟：错开启动高峰（Harness 自启与仓库预热都在抢主进程与网络） */
const UPDATE_FIRST_DELAY_MS = Number(process.env.HARNESS_UPDATE_DELAY_MS) >= 0
  ? Number(process.env.HARNESS_UPDATE_DELAY_MS)
  : 15000
/** 复查周期（harness-update 内部按 6 小时节流，未到期时 check 立即返回） */
const UPDATE_POLL_MS = 30 * 60 * 1000
let updateWatch = null

/**
 * 监视 DeepSeek Harness 新版本：启动后延迟首查，之后每 30 分钟复查（实际按 6 小时节流）。
 * 发现新版本经 harness:update 广播，界面据此提示，用户可直接在应用内热更新。
 */
function startHarnessUpdateWatch() {
  // 冒烟模式跳过（会引入真实网络请求与时长抖动），需要时用 SMOKE_HARNESS_UPDATE=1 显式开启
  if (process.env.SMOKE_EXIT_MS && process.env.SMOKE_HARNESS_UPDATE !== '1') return
  if (updateWatch) return
  const first = setTimeout(() => { harnessUpdate.check().catch(() => {}) }, UPDATE_FIRST_DELAY_MS)
  if (first.unref) first.unref()
  const timer = setInterval(() => { harnessUpdate.check().catch(() => {}) }, UPDATE_POLL_MS)
  if (timer.unref) timer.unref()
  updateWatch = { first, timer }
}

/**
 * 转发 git 工作进程的进度事件到渲染层。
 * tag 为 `wc:<id>` 时只发给发起窗口（报告页生成报告自己的收集进度），其余一律广播。
 */
function handleGitEvent({ event, tag, payload }) {
  if (event === 'workerExit') {
    // 工作进程异常退出：立即复位扫描态，避免渲染层「正在扫描」永久悬挂
    broadcast('git:scanDone', { total: knownRepos.length })
    return
  }
  if (event === 'scanRepoFound') {
    rememberRepo(payload) // 内部已广播，保证快照不落后于事件
    return
  }
  const channel = `git:${event}`
  if (gitService.isWindowTag(tag)) {
    const wc = gitService.windowFromTag(tag)
    if (wc) { try { wc.send(channel, payload) } catch { /* noop */ } }
    return
  }
  broadcast(channel, payload)
}

function registerIpc() {
  // 窗口控制（无边框窗口的自定义标题栏按钮）
  ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize())
  ipcMain.handle('win:toggleMaximize', () => {
    if (!mainWindow) return false
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('win:close', () => mainWindow && mainWindow.close())
  // 渲染层询问框（win:askClose 广播）的结果回传：action=minimize|quit，remember 时写入偏好
  ipcMain.handle('win:closeConfirm', (_e, payload) => {
    clearTimeout(askCloseTimer)
    const wasPending = pendingAskClose
    pendingAskClose = false
    const action = payload && payload.action
    // 非 pending（超时兜底已执行 / 伪造回传）一律忽略，不重复执行
    if (!wasPending) return { ok: false }
    // 取消（询问框 × / ESC）：只清掉上面的超时兜底，窗口原样保留
    if (action === 'cancel') return { ok: true }
    if (action !== 'minimize' && action !== 'quit') return { ok: false }
    if (payload.remember) {
      const cfg = store.load()
      cfg.closeAction = action
      if (store.save(cfg) !== true) console.error('[close] 关闭行为偏好写入失败（下次仍会询问）')
    }
    if (action === 'minimize') hideToTray()
    else { isQuitting = true; app.quit() }
    return { ok: true }
  })
  ipcMain.handle('win:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()))
  // 全屏开关（Harness 沉浸模式）：返回窗口实际状态，避免渲染层与窗口状态不一致
  ipcMain.handle('win:setFullScreen', (_e, flag) => {
    if (!mainWindow) return false
    mainWindow.setFullScreen(!!flag)
    return mainWindow.isFullScreen()
  })
  ipcMain.handle('win:isFullScreen', () => !!(mainWindow && mainWindow.isFullScreen()))

  // 界面偏好（侧栏收起等纯外观状态）：独立文件落盘，不被设置页的整份配置回写覆盖
  ipcMain.handle('ui:prefsLoad', () => uiPrefs.load())
  ipcMain.handle('ui:prefsSave', (_e, prefs) => uiPrefs.save(prefs))

  // 配置
  ipcMain.handle('config:load', () => store.load())
  ipcMain.handle('config:save', (_e, cfg) => {
    const r = store.save(cfg)
    if (r !== true) return { ok: false, error: '配置写入失败（数据目录只读或磁盘异常），修改未保存' }
    // 根目录/排除规则变化 → 失效扫描缓存并重新预热（新配置的仓库列表与提交即时就绪）
    const before = store.load()
    const after = store.load()
    const sig = (c) => JSON.stringify([c.roots || [], (c.excludes || []).slice().sort()])
    if (sig(before) !== sig(after)) {
      gitService.invalidateScanCache()
      warmupPipeline()
    }
    return { ok: true }
  })

  // 目录选择
  ipcMain.handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // 文件选择（如 SSH 私钥）
  ipcMain.handle('dialog:pickFile', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // git 服务（实际执行在 git 工作进程内，这里只转发调用与事件）
  // 扫描统一走 scanReposCached：同参数并发共享一次扫盘，预热完成后瞬时返回；
  // 进度/发现事件经 handleGitEvent 广播，无论预热还是用户触发，渲染端都能收到进度流
  gitService.setEventSink(handleGitEvent)
  ipcMain.handle('git:scanRepos', (_e, { roots, excludes, force }) => {
    return gitService.scanReposCached(roots, excludes, { force: !!force, tag: 'broadcast' })
      .then((result) => {
        knownRepos = [...result] // 命中缓存时不触发 onRepo，用返回值校准快照
        broadcast('git:scanDone', { total: result.length })
        return result
      })
  })
  ipcMain.handle('git:repoInfo', (_e, repo) => gitService.getRepoInfo(repo))
  ipcMain.handle('git:collectCommits', async (e, payload) => {
    // 报告页自己的收集：进度只回发起窗口（预热走 broadcast，见 handleGitEvent）
    return gitService.collectCommits(payload.repos, payload.opts, { tag: gitService.windowTag(e.sender.id) })
  })
  ipcMain.handle('git:identity', () => gitService.getIdentity())

  // 启动预热：渲染端在配置就绪后调用（幂等，首次调用会拉起工作进程），返回预热到的仓库列表
  ipcMain.handle('git:warmup', () => {
    if (!warmupTask) warmupPipeline()
    return warmupTask
  })
  // 已发现仓库快照：渲染层接线晚于预热启动时，用它补齐错过的 git:scanRepoFound 事件
  ipcMain.handle('git:reposSnapshot', () => knownRepos)

  // 渲染层首帧已绘制：据此启动后台任务（仓库预热 + 内置 Harness），见 startBackgroundTasks
  ipcMain.handle('app:uiReady', () => {
    startBackgroundTasks('渲染层首帧')
    return true
  })

  // 报告导出
  ipcMain.handle('report:save', async (_e, { defaultName, content }) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '保存报告',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (r.canceled || !r.filePath) return { saved: false }
    try {
      fs.writeFileSync(r.filePath, content, 'utf8')
      return { saved: true, path: r.filePath }
    } catch (err) {
      return { saved: false, error: err.message }
    }
  })

  // 报告历史
  ipcMain.handle('report:saveAuto', (_e, payload) => reportHistory.save(payload))
  ipcMain.handle('report:listHistory', () => reportHistory.list())
  ipcMain.handle('report:readHistory', (_e, id) => reportHistory.read(id))
  ipcMain.handle('report:deleteHistory', (_e, id) => reportHistory.remove(id))

  // AI 对话（流式）：每个 sender 一个 AbortController 支持停止
  // 安全：明文 API Key 由主进程从 store 解析（getApiKey），渲染层不持有、也不接收
  const aiControllers = new WeakMap()
  ipcMain.handle('ai:chat', async (e, payload) => {
    const { messages, opts } = payload || {}
    const wc = e.sender
    const cfg = store.load()
    const controller = new AbortController()
    aiControllers.set(wc, controller)
    try {
      const full = await aiService.chat({
        baseUrl: (opts && opts.baseUrl) || cfg.ai.baseUrl,
        apiKey: store.getApiKey(), // 忽略渲染层传入的 Key
        model: (opts && opts.model) || cfg.ai.model,
        temperature: opts && opts.temperature !== undefined ? opts.temperature : cfg.ai.temperature,
        messages,
        signal: controller.signal,
        onDelta: (text) => {
          try { wc.send('ai:chatDelta', text) } catch { /* noop */ }
        },
      })
      return { ok: true, text: full }
    } catch (err) {
      if (err && err.name === 'AbortError') return { ok: false, aborted: true, error: '' }
      return { ok: false, error: (err && err.message) || String(err) }
    } finally {
      aiControllers.delete(wc)
    }
  })
  ipcMain.handle('ai:stop', (e) => {
    const c = aiControllers.get(e.sender)
    if (c) { try { c.abort() } catch { /* noop */ } }
    return true
  })
  ipcMain.handle('ai:test', async (_e, opts) => {
    const o = opts || {}
    try {
      return await aiService.test({
        baseUrl: o.baseUrl,
        apiKey: o.apiKey || store.getApiKey(), // 允许测试未保存的新 Key
        model: o.model,
      })
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('ai:models', async (_e, opts) => {
    const o = opts || {}
    try {
      const models = await aiService.listModels({
        baseUrl: o.baseUrl,
        apiKey: o.apiKey || store.getApiKey(),
      })
      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // 剪贴板（写：选区复制等；读：终端 Ctrl+V 粘贴 —— 无菜单 Electron 下浏览器
  // 不派发原生 paste 事件，宿主要自己读剪贴板喂给 xterm，见 TerminalPane）
  ipcMain.handle('clipboard:write', (_e, text) => {
    if (text) clipboard.writeText(String(text))
    return true
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())

  // 项目中心：项目是 AI、活动报告与部署共享的一等上下文
  ipcMain.handle('projects:list', () => projectService.list())
  ipcMain.handle('projects:save', (_e, project) => projectService.save(project))
  ipcMain.handle('projects:remove', (_e, projectId) => projectService.remove(projectId))

  // 扩展管理：统一管理 Claude Code / Codex / Kimi CLI / Zcode 的技能与插件
  ipcMain.handle('extensions:list', () => extensionsService.listAll())
  ipcMain.handle('extensions:toggleSkill', (_e, { platform, name, enable }) => {
    try {
      return { ok: true, ...extensionsService.toggleSkill(platform, name, enable) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('extensions:togglePlugin', (_e, { platform, id, enable }) => {
    try {
      return { ok: true, ...extensionsService.togglePlugin(platform, id, enable) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('extensions:readSkill', (_e, { platform, name }) => {
    try {
      return { ok: true, ...extensionsService.readSkillDoc(platform, name) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // 在项目目录打开系统终端（Windows 为 PowerShell）
  ipcMain.handle('terminal:open', (_e, dir) => {
    try {
      // 只回传可克隆字段（child 进程对象不可结构化克隆）
      const { cwd, child } = terminalService.openTerminal(dir)
      return { ok: true, cwd, pid: child?.pid }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // ─── 终端工作台（内嵌真终端：一窗格 = 一个项目会话） ───
  ptyService.setEmitter((ch, payload) => broadcast(ch, payload))
  // 会话表在主进程常驻，渲染层切页只销毁视图，进程与输出都还在
  ipcMain.handle('terminal:shellOptions', () => {
    try {
      return { ok: true, options: ptyService.shellOptions() }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err), options: [] }
    }
  })
  ipcMain.handle('terminal:create', (_e, options) => {
    try {
      return { ok: true, session: ptyService.create(options || {}) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('terminal:list', () => {
    try {
      return { ok: true, sessions: ptyService.list() }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err), sessions: [] }
    }
  })
  // attach 一次性取回会话信息 + 回放输出（切回页面恢复画面用）
  ipcMain.handle('terminal:attach', (_e, sessionId) => {
    try {
      return { ok: true, ...ptyService.attach(sessionId) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('terminal:write', (_e, { sessionId, data }) => {
    try {
      ptyService.write(sessionId, data)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('terminal:resize', (_e, { sessionId, cols, rows }) => {
    try {
      return { ok: true, applied: ptyService.resize(sessionId, cols, rows) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('terminal:close', (_e, sessionId) => {
    try {
      return { ok: true, closed: ptyService.close(sessionId) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  // 多窗口布局：窗格顺序 + 绑定项目 + shell 选择 + 分屏比例，独立文件持久化
  ipcMain.handle('terminal:layoutGet', () => {
    try {
      return { ok: true, layout: terminalLayout.load() }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('terminal:layoutSave', (_e, layout) => {
    try {
      return terminalLayout.save(layout)
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('terminal:layoutClear', () => {
    try {
      return terminalLayout.clear()
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // 本地调试：探测 / 运行 / 生成项目根目录 start.bat
  ipcMain.handle('debug:status', (_e, dir) => {
    try {
      return { ok: true, ...localDebugService.status(dir) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('debug:run', (_e, dir) => {
    try {
      const { cwd, batPath } = localDebugService.run(dir)
      return { ok: true, cwd, batPath }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('debug:generate', (_e, dir) => {
    try {
      return { ok: true, ...localDebugService.generate(dir) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // 系统
  ipcMain.handle('shell:openPath', (_e, p) => {
    if (p && fs.existsSync(p)) {
      shell.showItemInFolder(p)
      return { ok: true }
    }
    return { ok: false } // 目标不存在时必须告知调用方，否则点击「打开目录」毫无反馈
  })

  // ─── 一键部署模块（OneDeploy） ───
  deployService.setEmitter((ch, payload) => broadcast(ch, payload))
  ipcMain.handle('deploy:projects:list', () => deployProjects.list())
  ipcMain.handle('deploy:projects:save', (_e, p) => deployProjects.save(p))
  ipcMain.handle('deploy:projects:copyConfig', (_e, args) => deployProjects.copyConfig(args))
  ipcMain.handle('deploy:projects:remove', (_e, id) => deployProjects.remove(id))
  ipcMain.handle('deploy:detectVersion', (_e, project) => deployService.resolveVersion(project || {}))
  ipcMain.handle('deploy:testConnection', async (_e, { projectId, targetId }) => {
    try {
      const info = await deployService.testConnection(projectId, targetId)
      return { ok: true, ...info }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:run', async (_e, { projectId, targetId }) => {
    try {
      const record = await deployService.run(projectId, targetId)
      return { ok: record.status === 'success', record }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:cancel', () => deployService.cancel())
  ipcMain.handle('deploy:releases', async (_e, { projectId, targetId }) => {
    try {
      const info = await deployService.listReleases(projectId, targetId)
      return { ok: true, ...info }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:rollback', async (_e, { projectId, targetId, version }) => {
    try {
      const record = await deployService.rollback(projectId, version, targetId)
      return { ok: record.status === 'success', record }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:history:list', (_e, projectId) => deployHistory.list(projectId))
  ipcMain.handle('deploy:history:readLog', (_e, logFile) => deployHistory.readLog(logFile))
  ipcMain.handle('deploy:history:clear', (_e, projectId) => deployHistory.clear(projectId))
  // 更新内容：按提交记录生成通俗中文说明（AI 优先、失败退回本地整理）
  ipcMain.handle('deploy:history:summarize', async (_e, { recordId, refresh } = {}) => {
    try {
      return await releaseNotes.summarizeRecord(recordId, { refresh: refresh === true })
    } catch (err) {
      return { ok: false, summary: '', source: '', error: (err && err.message) || String(err) }
    }
  })
  // 给某次发布打 Git 标签（标签名默认 v+版本号；已存在同名标签时如实返回 existed，不覆盖）
  ipcMain.handle('deploy:history:tag', async (_e, { recordId, tag } = {}) => {
    try {
      const record = deployHistory.get(recordId)
      if (!record) return { ok: false, error: '发布记录不存在' }
      const project = deployProjects.list().find((p) => p.id === record.projectId)
      if (!project) return { ok: false, error: '项目配置不存在，无法定位本地仓库' }
      const name = String(tag || '').trim() || releaseNotes.defaultTagName(record.version)
      if (!name) return { ok: false, error: '版本号为空，无法自动生成标签名，请手动填写' }
      const r = await releaseNotes.createTag(project.localPath, name, record.gitHead)
      // 打标签成功后把标签写回历史：下一次发布可直接以该标签为采集起点，界面也据此显示
      if (r && r.ok) deployHistory.update(recordId, { gitTag: r.tag })
      return r
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  // 数据库备份：列出服务器 backups/ 下的 pg_dump 备份并支持一键恢复
  ipcMain.handle('deploy:dbBackups', async (_e, { projectId, targetId }) => {
    try {
      return { ok: true, ...(await deployService.listDbBackups(projectId, targetId)) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:dbRestore', async (_e, { projectId, targetId, fileName }) => {
    try {
      const record = await deployService.restoreDbBackup(projectId, targetId, fileName)
      return { ok: record.status === 'success', record }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  // AI 部署助手（新项目首次接入部署：体检 → 生成部署文件 → 套用配置）
  ipcMain.handle('deploy:ai:scanLocal', (_e, { projectId }) => {
    try {
      const project = deployProjects.list().find((p) => p.id === projectId)
      if (!project) return { ok: false, error: '项目配置不存在，请先保存项目' }
      return { ok: true, local: aiDeploy.scanLocal(project) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:ai:scanRemote', async (_e, { projectId, targetId }) => {
    try {
      const project = deployProjects.list().find((p) => p.id === projectId)
      if (!project) return { ok: false, error: '项目配置不存在，请先保存项目' }
      const target = (project.targets || []).find((t) => t.id === targetId) || project.targets[0]
      const remote = await aiDeploy.scanRemote(project, target)
      return { ok: true, remote }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:ai:diagnose', async (_e, { projectId, targetId }) => {
    try {
      return { ok: true, ...(await aiDeploy.diagnose(projectId, targetId)) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:ai:writeFiles', (_e, { projectId, files }) => {
    try {
      return { ok: true, ...aiDeploy.writeFiles(projectId, files) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:ai:generateFile', async (_e, { projectId, targetId, req }) => {
    try {
      return await aiDeploy.generateFileContent(projectId, targetId, req)
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('deploy:ai:apply', (_e, { projectId, targetId, plan }) => {
    try {
      return aiDeploy.applyPlan(projectId, targetId, plan)
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // ─── 一键填报模块（Git 提交 → 工时计划 → 禅道任务工时） ───
  ipcMain.handle('fill:plan', async (_e, payload) => {
    try {
      return { ok: true, ...(await fillService.plan(payload)) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('fill:submit', async (_e, payload) => {
    try {
      return { ok: true, ...(await fillService.submit(payload)) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  // 提交记录（fill-log 留痕摘要）与按记录重新提交（重放存档载荷，已有记录按 ID 更新覆盖）
  ipcMain.handle('fill:log', (_e, limit) => {
    try {
      return { ok: true, entries: fillService.listLog(limit) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('fill:resubmit', async (_e, at) => {
    try {
      return { ok: true, ...(await fillService.resubmit(at)) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('fill:ztTasks', async () => {
    try {
      // 绑定任务用：进行中 + 近一个月完成的（完成后仍可能要补填工时）
      const tasks = await zentaoService.ensureClient().then((c) => c.myTaskOptions())
      return { ok: true, tasks }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('fill:testLogin', async (_e, opts) => {
    try {
      await zentaoService.ensureClient(zentaoService.normalizeOverrides(opts))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('fill:hpTest', async (_e, opts) => {
    try {
      await hanprintService.ensureClient(hanprintService.normalizeOverrides(opts))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('fill:bindings', () => fillService.listBindings())
  ipcMain.handle('fill:bind', (_e, { projectId, taskId, taskName }) => {
    try {
      return { ok: true, binding: fillService.bindProject(projectId, taskId, taskName) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('fill:unbind', (_e, projectId) => ({ ok: fillService.unbindProject(projectId) }))

  // ─── DeepSeek Harness（内置 dsh web 服务） ───
  // 状态变化（启动/就绪/崩溃/关闭）经 broadcast 推送，界面无需轮询
  harnessService.setEmitter((snapshot) => broadcast('harness:status', snapshot))
  ipcMain.handle('harness:status', () => harnessService.status())
  ipcMain.handle('harness:start', async (_e, opts) => {
    try {
      return { ok: true, ...(await harnessService.start(opts || {})) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('harness:stop', () => ({ ok: true, ...harnessService.stop() }))
  ipcMain.handle('harness:restart', async (_e, opts) => {
    try {
      return { ok: true, ...(await harnessService.restart(opts || {})) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  // 系统浏览器打开：必须用带 token 的地址完成一次握手换取登录 cookie
  ipcMain.handle('harness:openExternal', async () => {
    const snapshot = harnessService.status()
    if (!snapshot.url) return { ok: false, error: 'Harness 服务未运行' }
    try {
      await shell.openExternal(snapshot.url)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })

  // ─── DeepSeek Harness 内置运行时更新（检查新版本 + 应用内热更新） ───
  // 检查/安装进度经 harness:update 广播：安装可达分钟级，界面需要实时状态
  harnessUpdate.setEmitter((payload) => broadcast('harness:update', payload))
  ipcMain.handle('harness:updateStatus', () => harnessUpdate.status())
  ipcMain.handle('harness:updateCheck', async (_e, opts) => {
    try {
      return { ...(await harnessUpdate.check({ ...(opts || {}), force: true })) }
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
  ipcMain.handle('harness:updateInstall', async (_e, opts) => {
    try {
      return await harnessUpdate.install(opts || {})
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) }
    }
  })
}

app.whenReady().then(() => {
  // 抢锁失败的第二实例已在上方 app.quit()，不再初始化任何窗口/服务
  if (!gotSingleLock) return
  // 移除默认应用菜单栏（File/Edit/View/Window/Help）
  Menu.setApplicationMenu(null)
  registerIpc()
  createWindow()
  createTray() // 托盘常驻入口：窗口最小化到托盘后从这里恢复/退出
  // 仓库预热与内置 Harness 都不在这里启动：统一推迟到「渲染层首帧已绘制」之后
  // （渲染层经 app:uiReady 上报，见 startBackgroundTasks），避免与首屏渲染抢占主进程
  // 冒烟测试钩子（仅供自动化验证）：设置 SMOKE_EXIT_MS 后自动退出，
  // 并将渲染层 error/warning 控制台消息转发到 stdout 以便断言
  if (process.env.SMOKE_EXIT_MS) {
    const wc = mainWindow.webContents
    // 冒烟自动化依赖稳定的 timer/IPC 时序：后台或被遮挡窗口的链式 setTimeout 会被
    // Chromium 强制节流（最严 1 次/分钟），SMOKE_EVAL 的轮询断言会因此失真——
    // 冒烟运行禁用渲染节流，eval 期间保持窗口前台（仅冒烟模式，不影响正常使用）
    wc.setBackgroundThrottling(false)
    if (process.env.SMOKE_EVAL) {
      mainWindow.show()
      mainWindow.focus()
    }
    wc.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[SMOKE][renderer:${level >= 3 ? 'error' : 'warn'}]`, message)
    })
    wc.on('did-fail-load', (_e, code, desc) => console.log('[SMOKE][did-fail-load]', code, desc))
    // 调试用：SMOKE_GUEST_KEY=Escape 时周期性地向 webview guest 注入按键，
    // 验证「焦点在 dsh 页面内按 Esc 退出全屏」（宿主页收不到 guest 的按键）
    if (process.env.SMOKE_GUEST_KEY) {
      const key = process.env.SMOKE_GUEST_KEY
      const startMs = Number(process.env.SMOKE_GUEST_KEY_MS) || 50000
      const times = Number(process.env.SMOKE_GUEST_KEY_TIMES) || 4
      for (let i = 0; i < times; i++) {
        setTimeout(() => {
          try {
            const guests = webContents.getAllWebContents().filter((c) => c.getType() === 'webview')
            for (const guest of guests) {
              guest.sendInputEvent({ type: 'keyDown', keyCode: key })
              guest.sendInputEvent({ type: 'keyUp', keyCode: key })
            }
            console.log('[SMOKE][guest-key]', key, `→ ${guests.length} 个 guest`)
          } catch (err) { console.log('[SMOKE][guest-key-err]', err.message) }
        }, startMs + i * 5000)
      }
    }
    // 点击打开目标视图（SMOKE_VIEW，默认「部署」），验证应用壳与各页面可正常挂载
    setTimeout(() => {
      wc.executeJavaScript(`(() => {
        const items = [...document.querySelectorAll('.el-menu-item')]
        const view = ${JSON.stringify(process.env.SMOKE_VIEW || '部署')}
        const target = items.find((e) => e.textContent.trim() === view)
        if (target) target.click()
        return items.map((e) => e.textContent.trim())
      })()`).then((menu) => console.log('[SMOKE][menu]', JSON.stringify(menu))).catch((e) => console.log('[SMOKE][click-err]', e.message))
    }, Number(process.env.SMOKE_CLICK_MS) || 3000)
    // 调试用：SMOKE_WATCH_MS=间隔 时周期性 dump 内容区根节点 class，观察视图切换过程
    if (process.env.SMOKE_WATCH_MS) {
      const watchTimer = setInterval(() => {
        wc.executeJavaScript(`(() => {
          const kids = [...document.querySelectorAll('.content-area > *')]
          return kids.map((k) => k.className)
        })()`).then((c) => console.log('[SMOKE][watch]', JSON.stringify(c))).catch(() => {})
      }, Number(process.env.SMOKE_WATCH_MS))
      watchTimer.unref?.()
    }
    // 调试用：SMOKE_EVAL=表达式 时在渲染层执行并打印结果（端到端验证 IPC 链路用）
    if (process.env.SMOKE_EVAL) {
      setTimeout(() => {
        // eval-start 打点：结果行缺失时用于区分「未开始执行」与「执行未返回」
        console.log('[SMOKE][eval-start]', new Date().toISOString())
        wc.executeJavaScript(`(${process.env.SMOKE_EVAL})`).then((r) => console.log('[SMOKE][eval]', JSON.stringify(r))).catch((e) => console.log('[SMOKE][eval-err]', e.message))
      }, Number(process.env.SMOKE_EVAL_MS) || 4000)
    }
    // 渲染进程异常（崩溃/无响应）在自动化里必须可见，否则表现为「eval 结果凭空消失」
    wc.on('render-process-gone', (_e, details) => console.log('[SMOKE][render-gone]', JSON.stringify(details)))
    mainWindow.on('unresponsive', () => console.log('[SMOKE][unresponsive]'))
    if (process.env.SMOKE_SCREENSHOT_PATH) {
      setTimeout(async () => {
        try {
          const output = path.resolve(process.env.SMOKE_SCREENSHOT_PATH)
          fs.mkdirSync(path.dirname(output), { recursive: true })
          mainWindow.show()
          mainWindow.focus()
          const domInfo = await wc.executeJavaScript(`(() => {
            const root = document.querySelector('.content-area > *')
            // 页面标题：工具页（终端工作台 / Harness）把标题栏投递到了顶栏，一并查
            return { content: root ? root.className : '(empty)', title: document.querySelector('.content-area h1, .content-area .page-title, .app-topbar h1')?.textContent || '' }
          })()`).catch(() => null)
          if (domInfo) console.log('[SMOKE][dom]', JSON.stringify(domInfo))
          const image = await wc.capturePage()
          if (image.isEmpty()) throw new Error('渲染截图为空')
          fs.writeFileSync(output, image.toPNG())
          console.log('[SMOKE][screenshot]', output)
        } catch (err) {
          console.log('[SMOKE][screenshot-err]', err.message)
        }
      }, Number(process.env.SMOKE_SHOT_MS) || 4500)
    }
    setTimeout(() => app.quit(), Number(process.env.SMOKE_EXIT_MS) || 8000)
  }
  app.on('activate', () => {
    // macOS Dock 点击：窗口在（可能被最小化到托盘）则唤起，没有则新建
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 关闭软件即关闭内置 Harness 服务、git 工作进程与终端会话（stop 均为同步的进程终止，可安全用于退出钩子）
// before-quit 同时置 isQuitting：此后各窗口的 close 事件直接放行，不再弹询问框
app.on('before-quit', () => { isQuitting = true; harnessService.stop(); gitService.stop(); ptyService.stop() })
app.on('will-quit', () => { harnessService.stop(); gitService.stop(); ptyService.stop() })
process.on('exit', () => { harnessService.stop(); gitService.stop(); ptyService.stop() })
