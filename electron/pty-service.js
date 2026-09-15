/**
 * 终端工作台服务 —— 应用内嵌真实终端会话（node-pty）
 *
 * 定位：一窗格 = 一个项目会话，四宫格平铺同时盯多个项目的 CLI。
 * 与 electron/terminal-service.js 的区别：那个是「在项目目录弹一个外部窗口」，
 * 这个把 pty 会话放在**主进程**里常驻——渲染层切走页面只销毁 xterm 视图，
 * 进程与输出都还在，切回来 attach 即恢复画面（含最近输出回放）。
 *
 * 关键设计：
 * - 会话表在模块级（跨渲染层页面切换存活）；渲染层只持有 sessionId
 * - 每个会话维护**有界输出环形缓冲**（上限 OUTPUT_LIMIT 字节），attach 时回放，
 *   避免长时间运行的 dev server 把内存吃穿；被丢弃的头部以「已截断」提示标出
 * - 输出经 setEmitter 注入的 broadcast 推给主窗口；会话仍在但窗口已销毁时不报错
 * - stop() 为同步整树终止，供 app 退出钩子使用（与 harness/git 服务同约定）
 * - 安全：pty 内的命令以当前用户权限直接执行，不经过 Harness 沙箱与审批；
 *   不注入任何自动执行的命令，只把工作目录设为项目目录
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 单会话输出缓冲上限（字节）：够回放最近的构建日志，又不至于把内存吃穿 */
const OUTPUT_LIMIT = 256 * 1024
/** 同时存在的会话上限：四宫格够用，防止异常调用把机器打满 */
const MAX_SESSIONS = 12
/** 回放时提示「更早的输出已被丢弃」的标记 */
const TRUNCATED_NOTICE = '\r\n\x1b[2m── 更早的输出已超出缓冲上限，未显示 ──\x1b[0m\r\n'

/** 会话表：sessionId → session */
const sessions = new Map()
let seq = 0
/** 主进程 → 渲染层事件出口，由 main.js 注入（与 harness/deploy 服务同约定） */
let emitter = null

function setEmitter(fn) {
  emitter = typeof fn === 'function' ? fn : null
}

function emit(channel, payload) {
  if (!emitter) return
  try {
    emitter(channel, payload)
  } catch {
    /* 窗口销毁等场景：事件丢失不影响会话继续运行 */
  }
}

/** 在 PATH 中同步探测可执行文件（非 Windows 的 shell 探测用）。支持传绝对路径。 */
function findOnPath(cmd) {
  if (cmd.includes(path.sep) || cmd.includes('/')) {
    return fs.existsSync(cmd) ? cmd : null
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        return full
      } catch { /* 继续探测 */ }
    }
  }
  return null
}

/** Windows 内置 PowerShell 5.1 的固定位置（不依赖 PATH，因为它不一定在 PATH 里） */
function windowsPowerShellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(candidate) ? candidate : null
}

/** PowerShell 7 的常见安装位置（PATH 里没有时的兜底） */
function pwshFallbackPath() {
  const candidates = []
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'))
  return candidates.find((p) => fs.existsSync(p)) || null
}

/**
 * 解析可用的 shell：pwsh 7 → PATH 上的 pwsh → Windows PowerShell 5.1。
 * 与 Harness（dsh）解析 pwsh 的优先级保持一致，避免同一个应用里两个终端行为不同。
 * 返回 { path, args, label }；都找不到时抛错（非 Windows 平台回落到系统默认 shell）。
 */
function resolveShell(preferred) {
  if (process.platform === 'win32') {
    const wanted = String(preferred || '').trim()
    if (wanted) {
      const found = findOnPath(wanted)
      if (!found) throw new Error(`指定的 shell 不存在：${wanted}`)
      return { path: found, args: shellArgsFor(found), label: shellLabel(found) }
    }
    const pwsh = findOnPath('pwsh.exe') || pwshFallbackPath()
    if (pwsh) return { path: pwsh, args: shellArgsFor(pwsh), label: 'PowerShell 7' }
    const legacy = windowsPowerShellPath()
    if (legacy) return { path: legacy, args: shellArgsFor(legacy), label: 'Windows PowerShell 5.1' }
    const cmd = findOnPath('cmd.exe')
    if (cmd) return { path: cmd, args: [], label: 'cmd' }
    throw new Error('未找到可用的 shell（pwsh / Windows PowerShell / cmd 均不可用）')
  }
  const fallback = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const found = findOnPath(fallback) || findOnPath('/bin/sh')
  if (!found) throw new Error('未找到可用的 shell')
  return { path: found, args: ['-l'], label: path.basename(found) }
}

/** 各 shell 的启动参数：只抑制 banner/提示，不执行任何用户未输入的命令 */
function shellArgsFor(shellPath) {
  const base = path.basename(shellPath).toLowerCase()
  if (base.startsWith('pwsh') || base === 'powershell.exe') {
    // -NoLogo 去掉版权横幅；保留用户 profile（他们熟悉的环境不能被剥夺）
    return ['-NoLogo']
  }
  return []
}

function shellLabel(shellPath) {
  const base = path.basename(shellPath).toLowerCase()
  if (base.startsWith('pwsh')) return 'PowerShell 7'
  if (base === 'powershell.exe') return 'Windows PowerShell 5.1'
  if (base === 'cmd.exe' || base === 'cmd') return 'cmd'
  return path.basename(shellPath)
}

/** 会话可用性快照（渲染层据此渲染下拉选项与提示） */
function shellOptions() {
  const options = []
  if (process.platform === 'win32') {
    const pwsh = findOnPath('pwsh.exe') || pwshFallbackPath()
    if (pwsh) options.push({ id: 'pwsh', label: 'PowerShell 7', path: pwsh })
    const legacy = windowsPowerShellPath()
    if (legacy) options.push({ id: 'windows-powershell', label: 'Windows PowerShell 5.1', path: legacy })
    const cmd = findOnPath('cmd.exe')
    if (cmd) options.push({ id: 'cmd', label: 'cmd', path: cmd })
  } else {
    try {
      const shell = resolveShell()
      options.push({ id: 'default', label: shell.label, path: shell.path })
    } catch { /* 无可用 shell：返回空列表，渲染层显示不可用 */ }
  }
  return options
}

/** 解析要启动的 shell（供渲染层按 id 选择）：空=按优先级自动 */
function shellPathForId(shellId) {
  const id = String(shellId || '').trim()
  if (!id || id === 'auto') return null
  const hit = shellOptions().find((o) => o.id === id)
  return hit ? hit.path : null
}

/**
 * 加载 node-pty 原生模块。
 *
 * 打包后它是 asar 外的原生二进制（见 package.json 的 asarUnpack）；这里把加载失败
 * 转成可读错误 —— 如果原生模块缺失（打包配置出错、平台不支持），用户应该看到
 * 一句能懂的话，而不是整个主进程抛异常。
 */
function loadPty() {
  try {
    return require('node-pty')
  } catch (err) {
    throw new Error(`终端组件加载失败（node-pty 不可用）：${(err && err.message) || err}`)
  }
}

/** 取会话；不存在时抛错（避免渲染层拿着过期 id 静默失败） */
function requireSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) throw new Error('终端会话不存在或已结束')
  return session
}

/** 追加输出到环形缓冲：超出上限时从头部丢弃整块，保证不切断转义序列 */
function appendOutput(session, data) {
  session.chunks.push(data)
  session.bytes += data.length
  while (session.bytes > OUTPUT_LIMIT && session.chunks.length > 1) {
    session.bytes -= session.chunks.shift().length
    session.truncated = true
  }
  session.lastActivity = Date.now()
}

/**
 * 创建会话。
 * options: { projectId, projectName, cwd, cols, rows, shellId }
 * 返回可结构化克隆的会话信息（pty 对象不可跨进程传递，只留 sessionId）。
 */
function create(options = {}) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`终端会话数已达上限（${MAX_SESSIONS}），请先关闭不用的窗格`)
  }
  const dir = String(options.cwd || '').trim() || os.homedir()
  if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`)
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目录：${dir}`)

  const pty = loadPty()
  const preferredPath = shellPathForId(options.shellId)
  const shell = resolveShell(preferredPath)
  const cols = Math.max(20, Number(options.cols) || 100)
  const rows = Math.max(4, Number(options.rows) || 30)
  const id = `pty-${Date.now().toString(36)}-${(seq += 1).toString(36)}`

  const term = pty.spawn(shell.path, shell.args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: dir,
    env: {
      ...process.env,
      // 让子进程里的 CLI 知道自己是终端、以及终端能力（颜色/宽度由 xterm 决定）
      TERM: 'xterm-256color',
      // 应用自己的进程标识，便于用户脚本识别「跑在项目工具里」
      DEVPM_TERMINAL: '1',
      DEVPM_PROJECT_ID: String(options.projectId || ''),
    },
    useConpty: process.platform === 'win32',
  })

  const session = {
    id,
    projectId: String(options.projectId || ''),
    projectName: String(options.projectName || ''),
    cwd: dir,
    shellPath: shell.path,
    shellLabel: shell.label,
    pid: term.pid,
    cols,
    rows,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    exited: false,
    exitCode: null,
    truncated: false,
    chunks: [],
    bytes: 0,
    term,
  }
  sessions.set(id, session)

  term.onData((data) => {
    appendOutput(session, data)
    // 会话回放靠 attach；实时输出只推给已附加的会话（渲染层用同一 sessionId 区分窗格）
    emit('terminal:data', { sessionId: id, data })
  })
  term.onExit(({ exitCode, signal }) => {
    session.exited = true
    session.exitCode = typeof exitCode === 'number' ? exitCode : null
    session.term = null
    emit('terminal:exit', { sessionId: id, exitCode: session.exitCode, signal: signal || null })
  })

  return info(session)
}

/** 会话信息（不含 pty 对象，可安全 IPC） */
function info(session) {
  return {
    id: session.id,
    projectId: session.projectId,
    projectName: session.projectName,
    cwd: session.cwd,
    shellPath: session.shellPath,
    shellLabel: session.shellLabel,
    pid: session.pid,
    cols: session.cols,
    rows: session.rows,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    exited: session.exited,
    exitCode: session.exitCode,
  }
}

/** 全部会话（渲染层挂载时同步一次，恢复切页前留下的窗格） */
function list() {
  return [...sessions.values()].map(info)
}

/** 单个会话的信息（不带输出缓冲，供状态查询用） */
function getInfo(sessionId) {
  return info(requireSession(sessionId))
}

/** 写入输入（键盘输入 / 粘贴内容原样透传） */
function write(sessionId, data) {
  const session = requireSession(sessionId)
  if (session.exited || !session.term) throw new Error('会话已结束，无法写入')
  session.term.write(String(data == null ? '' : data))
  return true
}

/** 调整尺寸（列/行由 xterm 的 fit 计算后下发） */
function resize(sessionId, cols, rows) {
  const session = requireSession(sessionId)
  const c = Math.max(20, Number(cols) || 0)
  const r = Math.max(4, Number(rows) || 0)
  if (!c || !r) return false
  session.cols = c
  session.rows = r
  if (!session.exited && session.term) session.term.resize(c, r)
  return true
}

/**
 * 附加：回放缓冲输出。渲染层切回页面时调用，先 reset 再写快照，
 * 让 xterm 从干净状态重绘（避免上次残留的滚屏内容与新内容交错）。
 * 缓冲被截断过时在开头插入提示，用户能知道「上面还有更早的输出没显示」。
 */
function attach(sessionId) {
  const session = requireSession(sessionId)
  const body = (session.truncated ? TRUNCATED_NOTICE : '') + session.chunks.join('')
  return { ...info(session), output: body, truncated: session.truncated }
}

/** 关闭会话：先终止进程树，再从表中移除 */
function close(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) return false
  sessions.delete(sessionId)
  killTree(session)
  emit('terminal:closed', { sessionId })
  return true
}

/** Windows 系统工具绝对路径：不依赖 PATH（Electron GUI 进程的 PATH 可能被裁剪，spawn 会 ENOENT） */
function systemToolPath(name) {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const full = path.join(root, 'System32', `${name}.exe`)
  return fs.existsSync(full) ? full : name
}

/**
 * 终止会话进程。
 *
 * 顺序很重要：先把 shell 进程树连同子进程（dev server 等）结束掉，**再**调用 pty.kill()。
 * 原因：node-pty 在 Windows 上 kill 时会 fork 一个 `conpty_console_list_agent` 去
 * AttachConsole(innerPid) 拿控制台进程列表；如果先关掉 pty 句柄，那个辅助进程会
 * attach 失败并把堆栈打到本进程的 stderr。留出一个 tick 的窗口，让辅助进程正常完成。
 * 我们自己已经用 taskkill 整树清理，不依赖它的列表。
 */
function killTree(session) {
  const term = session.term
  session.term = null
  if (!term) return
  if (process.platform === 'win32' && session.pid) {
    // spawn 的 error 事件必须挂监听：taskkill 缺失或被安全软件拦截时，
    // 未处理的 'error' 会直接崩掉主进程（ENOENT 异步抛出，try/catch 拦不住）
    try {
      const killer = spawn(systemToolPath('taskkill'), ['/pid', String(session.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      killer.on('error', () => { /* taskkill 不可用：下面的 pty.kill 仍会结束 shell 进程 */ })
      killer.unref?.()
    } catch { /* 参数非法等同步异常忽略 */ }
    setTimeout(() => { try { term.kill() } catch { /* 进程可能已退出 */ } }, 200).unref?.()
    return
  }
  try {
    term.kill()
  } catch { /* 进程可能已退出 */ }
}

/**
 * 关闭全部会话（应用退出钩子；同步执行，不留下残留进程）。
 * 幂等：before-quit / will-quit / exit 三个钩子都会调用，重复调用必须零开销
 * （否则会在退出瞬间重复拉起 taskkill 与 node-pty 的辅助进程）。
 */
function stop() {
  if (!sessions.size) return
  for (const session of [...sessions.values()]) {
    sessions.delete(session.id)
    killTree(session)
  }
}

module.exports = {
  setEmitter,
  shellOptions,
  resolveShell,
  create,
  list,
  info,
  getInfo,
  attach,
  write,
  resize,
  close,
  stop,
  OUTPUT_LIMIT,
  MAX_SESSIONS,
}
