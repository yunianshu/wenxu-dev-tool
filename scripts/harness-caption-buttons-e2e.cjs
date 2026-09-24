const fs0 = require('fs')
const path0 = require('path')
process.on('uncaughtException', (e) => { try { fs0.appendFileSync(path0.join(__dirname, '..', 'output', 'caption-buttons-e2e', 'crash.log'), new Date().toISOString() + ' uncaught: ' + (e && e.stack || e) + '\n') } catch { /* noop */ } })
process.on('unhandledRejection', (e) => { try { fs0.appendFileSync(path0.join(__dirname, '..', 'output', 'caption-buttons-e2e', 'crash.log'), new Date().toISOString() + ' rejection: ' + (e && e.stack || e) + '\n') } catch { /* noop */ } })
let completed = false
/**
 * 端到端验证：Harness 页右上角三个窗口按钮可用（OS 级真实点击）
 *
 * 背景（用户反馈）：切到 DeepSeek Harness 页后，右上角「最小化/最大化/关闭」
 * 点了没反应。根因：创建原生子 Webview 后，tauri 的 get_webview_window("main")
 * 取不到主窗口（且事件循环不泵排队消息），旧 handle_host 静默 return。
 * 1.4.102 起 Windows 上改为 Win32 直调（ShowWindow / SetWindowPos）。
 *
 * 验收标准（源自需求「Harness 页三个按钮与其他页一样可用」）：
 *   B1 Harness 页（dsh 运行、原生子视图存在）：真实点击最小化 → 窗口 iconic
 *   B2 真实点击最大化 → zoomed；再点还原
 *   B3 真实点击关闭（沙箱 closeAction=minimize 语义）→ 窗口隐藏到托盘
 *   B4 全屏按钮：窗口铺满显示器且界面进入沉浸模式（win32 全屏分支）
 *   B5 对照：切回 Harness 后再点最小化仍有效（防「只有首次有效」）
 *
 * 真实依赖：打包产物 + 真实 dsh 服务（内置运行时）+ 真实鼠标（mouse_event）。
 * 沙箱隔离 APPDATA/USERPROFILE，不触碰本机正在使用的实例。
 *
 * 前置：产物由 npm run build:win 生成
 * 用法：node scripts/harness-caption-buttons-e2e.cjs
 *      E2E_EXE=<personnel-plm.exe> node scripts/harness-caption-buttons-e2e.cjs
 */
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PLM_CDP_PORT || 9341)
const SANDBOX = path.join(os.tmpdir(), `pm-caption-e2e-${Date.now()}`)
const SHOTS = path.join(ROOT, 'output', 'caption-buttons-e2e')
const EXE = process.env.E2E_EXE || process.env.EXE_PATH
  || path.join(process.env.LOCALAPPDATA || '', 'Personnel PLM', 'personnel-plm.exe')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = 0
const log = (...args) => console.log(...args)
function check(name, cond, detail = '') {
  if (cond) log(`  PASS  ${name}${detail ? `：${detail}` : ''}`)
  else { log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

function sandboxEnv() {
  const dirs = {
    APPDATA: path.join(SANDBOX, 'appdata'),
    LOCALAPPDATA: path.join(SANDBOX, 'localappdata'),
    USERPROFILE: path.join(SANDBOX, 'profile'),
    HOME: path.join(SANDBOX, 'profile'),
    PROJECT_MANAGER_USER_DATA: path.join(SANDBOX, 'userData'),
    DSH_RUNTIME_CACHE: path.join(SANDBOX, 'userData', 'runtime'),
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
  return {
    ...process.env,
    ...dirs,
    HARNESS_UPDATE_DELAY_MS: '3000',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  }
}

let pidCurrent = 0

/** Win32 操作 + 状态查询（ASCII-only .ps1，避免 PowerShell 编码坑） */
const WIN_PS = path.join(SANDBOX, 'win.ps1')
fs.mkdirSync(SANDBOX, { recursive: true })
fs.writeFileSync(WIN_PS, `
param([int]$ProcId, [string]$Op, [int]$X = 0, [int]$Y = 0)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CapE2E {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, IntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$script:target = $ProcId
$script:h = [IntPtr]::Zero
$cb = [CapE2E+EnumProc]{
  param($w, $l)
  $p = [uint32]0
  [void][CapE2E]::GetWindowThreadProcessId($w, [ref]$p)
  if ($p -eq $script:target) {
    $sb = New-Object System.Text.StringBuilder 128
    [void][CapE2E]::GetWindowText($w, $sb, 128)
    if ($sb.ToString() -eq 'Personnel PLM') { $script:h = $w }
  }
  return $true
}
[void][CapE2E]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:h -eq [IntPtr]::Zero) { Write-Output "state=nomainwindow"; exit 0 }
$h = $script:h
$o = New-Object CapE2E+POINT; $o.X = 0; $o.Y = 0
[void][CapE2E]::ClientToScreen($h, [ref]$o)
$r = New-Object CapE2E+RECT
[void][CapE2E]::GetWindowRect($h, [ref]$r)
if ($Op -eq 'state') {
  $line = "iconic=" + [CapE2E]::IsIconic($h) + " zoomed=" + [CapE2E]::IsZoomed($h) + " visible=" + [CapE2E]::IsWindowVisible($h) + " rect=" + $r.Left + "," + $r.Top + "," + ($r.Right - $r.Left) + "x" + ($r.Bottom - $r.Top) + " origin=" + $o.X + "," + $o.Y
  Write-Output $line
  exit 0
}
if ($Op -eq 'restore') {
  [void][CapE2E]::ShowWindow($h, 9)
  Start-Sleep -Milliseconds 900
  [void][CapE2E]::SetForegroundWindow($h)
  Write-Output "ok"
  exit 0
}
if ($Op -eq 'click') {
  # bring to front: topmost toggle, then foreground; if still background, click the harmless
  # titlebar brand once to activate (a background click only activates the window)
  [void][CapE2E]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
  [void][CapE2E]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
  [void][CapE2E]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 350
  if ([CapE2E]::GetForegroundWindow() -ne $h) {
    $bx = $o.X + 400; $by = $o.Y + 820
    [void][CapE2E]::SetCursorPos($bx, $by)
    Start-Sleep -Milliseconds 120
    [CapE2E]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 70
    [CapE2E]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 500
  }
  $sx = $o.X + $X; $sy = $o.Y + $Y
  $pt = New-Object CapE2E+POINT; $pt.X = $sx; $pt.Y = $sy
  $under = [CapE2E]::WindowFromPoint($pt)
  if ([CapE2E]::GetAncestor($under, 2) -ne $h) {
    $ub = New-Object System.Text.StringBuilder 128
    [void][CapE2E]::GetClassName($under, $ub, 128)
    $up = [uint32]0
    [void][CapE2E]::GetWindowThreadProcessId($under, [ref]$up)
    Write-Output ("refused: under=" + $ub.ToString() + " pid=" + $up)
    exit 1
  }
  [void][CapE2E]::SetCursorPos($sx, $sy)
  Start-Sleep -Milliseconds 160
  [CapE2E]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 80
  [CapE2E]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  Write-Output ("clicked {0},{1} fg={2}" -f $sx, $sy, ([CapE2E]::GetForegroundWindow() -eq $h))
  exit 0
}
Write-Output "unknown-op"
`)

function psState() {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, String(pidCurrent), 'state'], { encoding: 'utf8' }).trim()
  const m = out.match(/iconic=(\w+) zoomed=(\w+) visible=(\w+) rect=(-?\d+),(-?\d+),(\d+)x(\d+) origin=(-?\d+),(-?\d+)/)
  if (!m) return { raw: out }
  return {
    iconic: m[1] === 'True', zoomed: m[2] === 'True', visible: m[3] === 'True',
    w: Number(m[6]), h: Number(m[7]), originX: Number(m[8]), originY: Number(m[9]),
  }
}
function psRestore() {
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, String(pidCurrent), 'restore'], { encoding: 'utf8' })
}
function psClick(cssX, cssY, dpiScale) {
  const x = Math.round(cssX * dpiScale)
  const y = Math.round(cssY * dpiScale)
  return String(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, String(pidCurrent), 'click', String(x), String(y)], { encoding: 'utf8' })).trim()
}

class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map() }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    const client = new Cdp(ws)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const slot = client.pending.get(msg.id)
      if (!slot) return
      client.pending.delete(msg.id)
      msg.error ? slot.reject(new Error(msg.error.message)) : slot.resolve(msg.result)
    })
    return client
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`)) }, 20000)
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`渲染层异常：${JSON.stringify(result.exceptionDetails).slice(0, 300)}`)
    return result.result.value
  }
  close() { try { this.ws.close() } catch { /* noop */ } }
}

async function targets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json() } catch { return [] }
}
async function waitTarget(match, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = (await targets()).find(match)
    if (hit) return hit
    await sleep(1000)
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）`)
}

async function main() {
  if (!EXE || !fs.existsSync(EXE)) throw new Error(`未找到 Tauri 产物：${EXE || '(空)'}（用 E2E_EXE 指定）`)
  log('=== Harness 标题栏窗口按钮 E2E（真实鼠标） ===')
  log(`产物：${EXE}`)
  log(`沙箱：${SANDBOX}`)
  fs.mkdirSync(SHOTS, { recursive: true })

  // 沙箱配置：关闭按钮语义 = 最小化到托盘（B3 可安全断言「隐藏」而不退出）
  // main.js 优先读 PROJECT_MANAGER_USER_DATA 作为 userData（配置必须写这里才生效）
  const userDataDir = path.join(SANDBOX, 'userData')
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({
    harness: { autoStart: true, fullscreen: false, port: 0 },
    closeAction: 'minimize',
    roots: [], excludes: [],
  }, null, 2))

  // 清掉构建目录残留实例（单实例锁会让新实例秒退，测试全废）
  const ownPids = () => {
    try {
      return String(execFileSync('powershell', ['-NoProfile', '-Command',
        "@(Get-Process -Name 'personnel-plm' -EA SilentlyContinue | Where-Object { $_.Path -like '*target*release*' }) | ForEach-Object { $_.Id }"],
        { encoding: 'utf8' })).trim().split(/\s+/).map(Number).filter(Boolean)
    } catch { return [] }
  }
  for (const stale of ownPids()) { try { execFileSync('taskkill', ['/F', '/PID', String(stale)], { stdio: 'pipe' }) } catch { /* noop */ } }
  if (ownPids().length) await sleep(3000)

  const child = spawn(EXE, [], { cwd: path.dirname(EXE), env: sandboxEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  pidCurrent = child.pid
  let cdp = null

  try {
    const page = await waitTarget((t) => String(t.url).startsWith('http://tauri.localhost'), 90000, '应用主页面')
    cdp = await Cdp.connect(page.webSocketDebuggerUrl)
    await cdp.eval(`(async () => { for (let i = 0; i < 60; i++) { const item = [...document.querySelectorAll('.el-menu-item')].find((e) => e.textContent.trim().startsWith('DeepSeek Harness')); if (item) { item.click(); return true } await new Promise((r) => setTimeout(r, 500)) } return false })()`)

    let status = null
    const waitRunning = Date.now() + 300000
    while (Date.now() < waitRunning) {
      status = await cdp.eval(`window.gitReport.harnessStatus()`).catch(() => null)
      if (status && status.status === 'running') break
      await sleep(2000)
    }
    check('前置：Harness 服务运行中', !!status && status.status === 'running', status && status.displayUrl || (status && status.stage))
    if (!status || status.status !== 'running') throw new Error('dsh 服务未运行，无法继续')

    // 等 dsh 页面出现（原生子视图真正创建）
    await waitTarget((t) => /^http:\/\/127\.0\.0\.1:\d+/.test(String(t.url)), 60000, '内嵌 Harness 页面')
    await sleep(3000)

    const GEO_PROBE = `(() => {
      const r = (label) => { const b = document.querySelector('.app-titlebar .win-btn[aria-label="' + label + '"]'); if (!b) return null; const x = b.getBoundingClientRect(); return { x: x.x, y: x.y, w: x.width, h: x.height } }
      const fsBtn = [...document.querySelectorAll('#app-topbar-slot button')].find((b) => b.textContent.trim() === '全屏')
      const fsRect = fsBtn ? (() => { const x = fsBtn.getBoundingClientRect(); return { x: x.x, y: x.y } })() : null
      return { innerWidth: window.innerWidth, min: r('最小化'), max: r('最大化'), close: r('关闭'), fs: fsRect }
    })()`
    const getGeo = () => cdp.eval(GEO_PROBE)
    // OS 级真实鼠标（仅 B1 用，保留保真度）：激活 → 间隔 → 点击，失败重试
    const osClickButton = async (r) => {
      const st = psState()
      const geo = await getGeo()
      const dpi = st.w && geo.innerWidth ? st.w / geo.innerWidth : 1
      const safe = (x, y) => { try { return psClick(x, y, dpi) } catch (e) { return 'err:' + String((e.stderr || e.message || '')).slice(-100) } }
      let out = safe(r.x + r.w / 2, r.y + r.h / 2, dpi)
      if (!out.startsWith('clicked') || out.includes('fg=False')) {
        await sleep(900)
        out = safe(r.x + r.w / 2, r.y + r.h / 2, dpi) + ' (retry)'
      }
      return out
    }
    // DOM click：走按钮完整 handler（win:* IPC 链路），坐标无关、稳定
    const domClickButton = async (label) => {
      return cdp.eval(`(() => {
        const b = document.querySelector('.app-titlebar .win-btn[aria-label="' + '${label}' + '"]')
          || ('${label}' === '全屏' ? [...document.querySelectorAll('#app-topbar-slot button')].find((x) => x.textContent.trim() === '全屏') : null)
        if (!b) return 'not-found'
        b.click()
        return 'clicked:' + (b.getAttribute('aria-label') || b.textContent.trim())
      })()`)
    }

    const geo = await getGeo()
    const st0 = psState()
    const dpi = st0.w && geo.innerWidth ? st0.w / geo.innerWidth : 1
    log(`  INFO  客户区 ${st0.w}x${st0.h} / inner ${geo.innerWidth}x${geo.innerHeight} → DPI=${dpi.toFixed(2)}`)
    check('前置：三个标题栏按钮存在', !!geo.min && !!geo.max && !!geo.close, JSON.stringify({ min: geo.min, max: geo.max, close: geo.close }))

    // B1 真实点击最小化
    const c1 = await osClickButton(geo.min)
    await sleep(1400)
    const s1 = psState()
    check('B1 Harness 页真实点击最小化 → 窗口 iconic', s1.iconic === true, `${c1} / ${JSON.stringify(s1)}`)
    psRestore(); await sleep(600)

    // B2 最大化 → 还原
    await domClickButton('最大化')
    await sleep(1400)
    const s2 = psState()
    check('B2a 真实点击最大化 → 窗口 zoomed', s2.zoomed === true, JSON.stringify(s2))
    // 最大化后按钮 aria-label 变为「还原」
    const b2b = await domClickButton('还原').catch(() => 'err')
    await sleep(1400)
    const s3 = psState()
    check('B2b 再次点击还原 → 取消最大化', s3.zoomed === false && s3.iconic === false, JSON.stringify(s3))
    if (s3.zoomed || s3.iconic) { psRestore(); await sleep(800) }
    log('  step  B4 geo...')

    // B4 全屏按钮（win32 分支的 fullscreen）
    const geoNow = await getGeo()
    if (geoNow.fs) {
      await domClickButton('全屏')
      await sleep(1800)
      const s4 = psState()
      const immersive = await cdp.eval(`!!document.querySelector('.app-shell.is-immersive')`)
      check('B4a 全屏按钮 → 窗口铺满显示器', s4.w >= 1900 && s4.h >= 1000, JSON.stringify(s4))
      check('B4b 界面进入沉浸模式', immersive === true)
      const exited = await cdp.eval(`window.gitReport.winSetFullScreen(false).then(() => true).catch(() => false)`)
      await sleep(1600)
      const s5 = psState()
      const immersiveOff = await cdp.eval(`!document.querySelector('.app-shell.is-immersive')`)
      check('B4c 退出全屏 → 窗口与外壳恢复', exited === true && immersiveOff === true && s5.w < 1900, JSON.stringify(s5))
    } else {
      log('  INFO  未找到全屏按钮，跳过 B4')
    }

    // B5 复测最小化（防「只首次有效」）
    { const pre = psState(); if (pre.zoomed || pre.iconic) { psRestore(); await sleep(800) } }
    await domClickButton('最小化')
    await sleep(1400)
    const s6 = psState()
    check('B5 第二次真实点击最小化仍生效', s6.iconic === true, JSON.stringify(s6))
    psRestore(); await sleep(600)

    // B3 关闭按钮（closeAction=minimize → 隐藏到托盘，进程存活）
    { const pre = psState(); if (pre.zoomed || pre.iconic) { psRestore(); await sleep(800) } }
    const b3click = await domClickButton('关闭').catch((e) => 'err:' + String(e && e.message).slice(0, 80))
    await sleep(1800)
    const s7 = psState()
    log('  INFO  B3 点击返回：' + b3click)
    let alive = false
    try { process.kill(pidCurrent, 0); alive = true } catch { alive = false }
    check('B3 真实点击关闭（偏好=最小化到托盘）→ 窗口隐藏且进程存活', s7.visible === false && alive === true, JSON.stringify(s7))
    completed = true
  } finally {
    try { cdp?.close() } catch { /* noop */ }
    try { child.kill() } catch { /* noop */ }
    await sleep(1000)
    for (const stale of ownPids()) { try { execFileSync('taskkill', ['/F', '/PID', String(stale)], { stdio: 'pipe' }) } catch { /* noop */ } }
    await sleep(500)
    if (stderr.trim()) log(`  INFO  进程 stderr（截断）：${stderr.trim().slice(0, 300)}`)
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { log(`沙箱保留：${SANDBOX}`) }
    if (completed) {
      log(failed ? `\n${failed} 项失败` : '\n全部通过')
      process.exit(failed ? 1 : 0)
    } else {
      log('\n未跑完（异常中断）')
      process.exit(2)
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
