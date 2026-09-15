/**
 * E2E：顶栏空白处能拖动窗口（Windows 命中测试 + 真实鼠标拖动）
 *
 * 背景：窗口是无边框（frame: false），顶栏是唯一的拖拽区。曾经 .topbar-slot
 * （flex: 1 占满顶栏中段）整条设了 no-drag，于是能拖的只剩左右两条 28px 内边距，
 * 顶栏中间这一大片空白怎么拖都不动窗口。这类问题 DOM 断言看不出来——按钮/空白
 * 是否被拖拽区吃掉，由 Windows 的命中测试决定，所以要问系统，而不是问页面。
 *
 * 验收标准（源自需求）：
 *   D1 顶栏中段空白：命中测试返回 HTCAPTION（按住即拖窗口）
 *   D2 顶栏里的控件：命中测试返回 HTCLIENT（仍可点击，没被拖拽区吃掉）
 *   D3 真实鼠标在空白处按住拖动：窗口位置真的跟着变
 *   D4 真实鼠标点顶栏控件仍然生效（OS 级点击，不是 DOM click）
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/topbar-window-drag-e2e.cjs
 *       E2E_EXE=<打包产物 exe> node scripts/topbar-window-drag-e2e.cjs
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-topdrag-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOTS = path.join(SANDBOX, 'shots')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9357
const EXE = process.env.EXE_PATH || process.env.E2E_EXE || ''

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = ['src', 'electron'].map((dir, index) => ({
  id: `proj-${index + 1}`,
  name: `自测项目 ${index + 1}`,
  description: '',
  localPath: path.join(ROOT, dir),
  status: 'active',
  tags: [],
}))

fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))

// ─── CDP 极简客户端（Node 自带 WebSocket） ───
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
      if (msg.error) slot.reject(new Error(msg.error.message))
      else slot.resolve(msg.result)
    })
    return client
  }

  send(method, params = {}) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) reject(new Error(`CDP 超时：${method}`)) }, 20000).unref?.()
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description || ''}`)
    return res.result.value
  }

  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
  }

  close() { try { this.ws.close() } catch { /* noop */ } }
}

// ─── Windows 命中测试 / 真实鼠标（user32） ───
const PS_SCRIPT = String.raw`
param([string]$ReqFile, [string]$ResFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
}
"@
function Write-Res($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText($ResFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}
# 注意别把局部变量命名成 $Req/$Res：param 的 [string] 类型约束会跟着变量名走（PowerShell 大小写不敏感），
# ConvertFrom-Json 的结果会被强转成字符串，读出来的字段全是空的
$cfg = Get-Content -LiteralPath $ReqFile -Raw -Encoding UTF8 | ConvertFrom-Json

# 找应用窗口：spawn 出来的 pid 是 electron/cli.js 的 node 进程，拿不到窗口；
# Node 侧会在进程树里找到真正的 electron 主进程 pid 传进来。
$targetPid = [int]$cfg.pid
$wantTitle = [string]$cfg.title
function Get-WinTitle($hWnd) {
  $len = [Win32]::GetWindowTextLength($hWnd)
  if ($len -le 0) { return '' }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
  return $sb.ToString()
}
$visibleTitles = @()
$script:targetPid2 = $targetPid
$script:want2 = $wantTitle
$script:pidTitle = [IntPtr]::Zero   # 该进程 + 标题匹配（最准）
$script:pidAny = [IntPtr]::Zero     # 该进程的任一可见窗口
$script:anyTitle = [IntPtr]::Zero   # 标题匹配（兜底，本机可能装着正式版同名窗口，所以放最后）
$script:pidWins = @()               # 该进程的可见窗口清单（诊断用）
$cb = [Win32+EnumWindowsProc]{
  param($hWnd, $lParam)
  if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }
  $t = Get-WinTitle $hWnd
  if ($t) { $script:visibleTitles += $t }
  $wpid = [uint32]0
  [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$wpid)
  $byPid = ($wpid -eq $script:targetPid2)
  $byTitle = ($script:want2 -and $t -like "*$($script:want2)*")
  if ($byPid) {
    $wr = New-Object Win32+RECT
    [void][Win32]::GetWindowRect($hWnd, [ref]$wr)
    $script:pidWins += @{ hwnd = [int64]$hWnd; title = $t; left = $wr.Left; top = $wr.Top; right = $wr.Right; bottom = $wr.Bottom; iconic = [Win32]::IsIconic($hWnd) }
  }
  if ($byPid -and $byTitle -and $script:pidTitle -eq [IntPtr]::Zero) { $script:pidTitle = $hWnd }
  if ($byPid -and $script:pidAny -eq [IntPtr]::Zero) { $script:pidAny = $hWnd }
  if ($byTitle -and $script:anyTitle -eq [IntPtr]::Zero) { $script:anyTitle = $hWnd }
  return $true
}
[void][Win32]::EnumWindows($cb, [IntPtr]::Zero)
$h = $script:pidTitle
if ($h -eq [IntPtr]::Zero) {
  # 优先挑没有被最小化的窗口：最小化的窗口位置是 -32000，命中测试和坐标换算都没意义
  $best = $script:pidWins | Where-Object { -not $_.iconic } | Select-Object -First 1
  if ($best) { $h = [IntPtr]$best.hwnd }
}
if ($h -eq [IntPtr]::Zero) { $h = $script:pidAny }
if ($h -eq [IntPtr]::Zero) {
  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($p) { $p.Refresh(); if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $h = $p.MainWindowHandle } }
}
if ($h -eq [IntPtr]::Zero) { $h = $script:anyTitle }
if ($h -eq [IntPtr]::Zero) {
  Write-Res @{ ok = $false; error = "找不到应用窗口（pid=$targetPid，标题「$wantTitle」）"; windows = $script:visibleTitles }
  exit 0
}

# 客户区原点 → 屏幕坐标；DOM 的 CSS px 乘 scale 得到屏幕物理 px
$origin = New-Object Win32+POINT
$origin.X = 0; $origin.Y = 0
[void][Win32]::ClientToScreen($h, [ref]$origin)
$scale = [double]$cfg.scale
function To-Screen($x, $y) {
  return @{ x = [int]($origin.X + [Math]::Round($x * $scale)); y = [int]($origin.Y + [Math]::Round($y * $scale)) }
}
function Hit-Test($sx, $sy) {
  # lParam：低 16 位是 x，高 16 位是 y（各按有符号 16 位取）
  $lp = [IntPtr]((($sy -band 0xFFFF) -shl 16) -bor ($sx -band 0xFFFF))
  return [int]([Win32]::SendMessage($h, 0x0084, [IntPtr]::Zero, $lp).ToInt64())
}
function Get-Rect() {
  $r = New-Object Win32+RECT
  [void][Win32]::GetWindowRect($h, [ref]$r)
  return @{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom }
}
function Get-Cursor() {
  $p = New-Object Win32+POINT
  [void][Win32]::GetCursorPos([ref]$p)
  return @{ x = $p.X; y = $p.Y }
}
function Get-Monitor() {
  $mi = New-Object Win32+MONITORINFO
  $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32+MONITORINFO])
  $mon = [Win32]::MonitorFromWindow($h, 2)   # MONITOR_DEFAULTTONEAREST
  [void][Win32]::GetMonitorInfo($mon, [ref]$mi)
  return @{ left = $mi.rcMonitor.Left; top = $mi.rcMonitor.Top; right = $mi.rcMonitor.Right; bottom = $mi.rcMonitor.Bottom }
}
# 确保窗口在前台：后台进程调 SetForegroundWindow 常被系统拒绝，
# 置顶再取消置顶是经典的抢前台手法（否则拖动/点击都会落到别的窗口上，测出来是假失败）
function Ensure-Foreground() {
  if ([int64][Win32]::GetForegroundWindow() -eq [int64]$h) { return $true }
  [void][Win32]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 200
  if ([int64][Win32]::GetForegroundWindow() -eq [int64]$h) { return $true }
  [void][Win32]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002)   # HWND_TOPMOST
  [void][Win32]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002)   # HWND_NOTOPMOST
  [void][Win32]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 200
  if ([int64][Win32]::GetForegroundWindow() -eq [int64]$h) { return $true }
  # 第三招：把自己线程的输入队列挂到当前前台线程上，再抢一次（前台锁最硬的情况靠这个）
  $fg = [Win32]::GetForegroundWindow()
  $fgPid = [uint32]0
  $fgThread = [Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $curThread = [Win32]::GetCurrentThreadId()
  [void][Win32]::AttachThreadInput($curThread, $fgThread, $true)
  [void][Win32]::BringWindowToTop($h)
  [void][Win32]::SetForegroundWindow($h)
  [void][Win32]::AttachThreadInput($curThread, $fgThread, $false)
  Start-Sleep -Milliseconds 250
  return ([int64][Win32]::GetForegroundWindow() -eq [int64]$h)
}
# 置前失败时先点一下顶栏空白（物理点击会激活窗口），再确认；仍失败就让调用方放弃这次点击——
# 窗口没在前台时点击会落到别的窗口上，既污染桌面又给出假失败
function Bring-ToFront() {
  if (Ensure-Foreground) { return $true }
  if ($script:activatePoint) {
    $a = To-Screen $script:activatePoint.x $script:activatePoint.y
    [void][Win32]::SetCursorPos($a.x, $a.y)
    Start-Sleep -Milliseconds 120
    [Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  return ([int64][Win32]::GetForegroundWindow() -eq [int64]$h)
}

$out = @{ ok = $true; hwnd = [int64]$h; scale = $scale; clientOrigin = @{ x = $origin.X; y = $origin.Y }; rect = Get-Rect; monitor = Get-Monitor; cursor = Get-Cursor; minimized = [Win32]::IsIconic($h); maximized = [Win32]::IsZoomed($h); foreground = ([int64][Win32]::GetForegroundWindow() -eq [int64]$h); screen = @{ w = [Win32]::GetSystemMetrics(0); h = [Win32]::GetSystemMetrics(1) }; pidWindows = $script:pidWins }

if ($cfg.action -eq 'hit') {
  $hits = @()
  foreach ($p in $cfg.points) {
    $s = To-Screen $p.x $p.y
    $hits += @{ name = $p.name; kind = $p.kind; cssX = $p.x; cssY = $p.y; screenX = $s.x; screenY = $s.y; hit = (Hit-Test $s.x $s.y) }
  }
  $out.hits = $hits
} elseif ($cfg.action -eq 'drag') {
  $script:activatePoint = $cfg.activateAt
  $out.foregroundBeforeDrag = Bring-ToFront
  if (-not $out.foregroundBeforeDrag) {
    # 窗口没抢到前台时不能硬拖：鼠标按下会落到别的窗口上，既污染桌面又给出假失败
    $out.ok = $false
    $out.reason = 'not-foreground'
    $out.rectBefore = Get-Rect
    $out.rectAfter = $out.rectBefore
  } else {
    $s = To-Screen $cfg.x $cfg.y
    [void][Win32]::SetCursorPos($s.x, $s.y)
    Start-Sleep -Milliseconds 150
    $out.rectBefore = Get-Rect
    [Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # LEFTDOWN
    Start-Sleep -Milliseconds 150
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      [void][Win32]::SetCursorPos([int]($s.x + $cfg.dx * $i / $steps), [int]($s.y + $cfg.dy * $i / $steps))
      Start-Sleep -Milliseconds 25
    }
    Start-Sleep -Milliseconds 100
    [Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # LEFTUP
    Start-Sleep -Milliseconds 250
    $out.rectAfter = Get-Rect
    $out.dxWanted = [int]$cfg.dx
    $out.dyWanted = [int]$cfg.dy
  }
} elseif ($cfg.action -eq 'click') {
  $script:activatePoint = $cfg.activateAt
  $out.foregroundBeforeClick = Bring-ToFront
  if (-not $out.foregroundBeforeClick) {
    $out.ok = $false
    $out.reason = 'not-foreground'
  } else {
    $s = To-Screen $cfg.x $cfg.y
    [void][Win32]::SetCursorPos($s.x, $s.y)
    Start-Sleep -Milliseconds 150
    [Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 200
  }
} elseif ($cfg.action -eq 'dblclick') {
  $script:activatePoint = $cfg.activateAt
  $out.foregroundBeforeDblclick = Bring-ToFront
  if (-not $out.foregroundBeforeDblclick) {
    $out.ok = $false
    $out.reason = 'not-foreground'
  } else {
    $s = To-Screen $cfg.x $cfg.y
    [void][Win32]::SetCursorPos($s.x, $s.y)
    Start-Sleep -Milliseconds 150
    for ($i = 0; $i -lt 2; $i++) {
      [Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 60
      [Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    Start-Sleep -Milliseconds 400
  }
  $out.maximized = [Win32]::IsZoomed($h)
  $out.rect = Get-Rect
} elseif ($cfg.action -eq 'restore') {
  # 最小化/最大化的窗口先恢复：否则 SetWindowPos 只改位置，窗口仍是 -32000 隐藏态或满屏态，
  # 后面的命中测试/点击全都会落到错误的基线上
  $trace = @()
  $trace += @{ at = 'entry'; iconic = [Win32]::IsIconic($h); rect = (Get-Rect) }
  if ($cfg.state -eq 'maximized') {
    [void][Win32]::ShowWindow($h, 3)   # SW_MAXIMIZE（此时不能再 SetWindowPos，会把最大化取消）
    Start-Sleep -Milliseconds 300
  } else {
    if ($cfg.state -eq 'minimized') { [void][Win32]::ShowWindow($h, 6) }   # SW_MINIMIZE
    else { [void][Win32]::ShowWindow($h, 9) }                              # SW_RESTORE
    Start-Sleep -Milliseconds 250
    $trace += @{ at = 'afterShowWindow'; iconic = [Win32]::IsIconic($h); rect = (Get-Rect) }
    $flags = 0x0001 -bor 0x0004 -bor 0x0010   # NOSIZE | NOZORDER | NOACTIVATE
    if ($cfg.width -and $cfg.height) { $flags = 0x0004 -bor 0x0010 }   # 带尺寸恢复时不要 NOSIZE
    [void][Win32]::SetWindowPos($h, [IntPtr]::Zero, [int]$cfg.left, [int]$cfg.top, [int]$cfg.width, [int]$cfg.height, $flags)
    $trace += @{ at = 'afterSetWindowPos'; iconic = [Win32]::IsIconic($h); rect = (Get-Rect) }
    if ($cfg.activate) { [void](Ensure-Foreground) }
    Start-Sleep -Milliseconds 250
    $trace += @{ at = 'afterForeground'; iconic = [Win32]::IsIconic($h); rect = (Get-Rect) }
  }
  if ($cfg.cursor -and -not $cfg.keepCursor) { [void][Win32]::SetCursorPos([int]$cfg.cursor.x, [int]$cfg.cursor.y) }
  $out.trace = $trace
  $out.rect = Get-Rect
  $out.minimized = [Win32]::IsIconic($h)
  $out.maximized = [Win32]::IsZoomed($h)
  $out.foreground = ([int64][Win32]::GetForegroundWindow() -eq [int64]$h)
}
Write-Res $out
`

let appTitle = '' // 应用窗口标题（窗口按 PID + 标题定位，见 PS 脚本里的说明）

/** 在进程树里找真正的 electron 主进程：spawn 出来的 pid 是 electron/cli.js 的 node 进程 */
function findAppPid(rootPid) {
  const cmd = [
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name`,
    `$frontier = @(${Number(rootPid)}); $found = @()`,
    `while ($frontier.Count -gt 0) {`,
    `  $next = @()`,
    `  foreach ($p in $frontier) { foreach ($k in ($all | Where-Object { $_.ParentProcessId -eq $p })) { $found += $k; $next += $k.ProcessId } }`,
    `  $frontier = $next`,
    `}`,
    `($found | Where-Object { $_.Name -match '^(electron|.*项目.*)\\.exe$' } | Select-Object -First 1).ProcessId`,
  ].join('; ')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 30000 })
  const pid = Number(String(r.stdout || '').trim())
  return Number.isFinite(pid) && pid > 0 ? pid : 0
}

function runPs(req) {
  const reqFile = path.join(SANDBOX, 'req.json')
  const resFile = path.join(SANDBOX, 'res.json')
  const psFile = path.join(SANDBOX, 'win.ps1')
  // 带 BOM 写入：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI 解码，脚本里的中文注释会破坏引号配对
  fs.writeFileSync(psFile, `\uFEFF${PS_SCRIPT}`, 'utf8')
  fs.writeFileSync(reqFile, JSON.stringify({ title: appTitle, ...req }), 'utf8')
  if (fs.existsSync(resFile)) fs.unlinkSync(resFile)
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, reqFile, resFile], {
    encoding: 'utf8',
    timeout: 60000,
  })
  if (r.error) throw r.error
  if (!fs.existsSync(resFile)) {
    throw new Error(`PowerShell 未产出结果（退出码 ${r.status}）：${(r.stderr || '').slice(0, 400)}`)
  }
  return JSON.parse(fs.readFileSync(resFile, 'utf8').replace(/^\uFEFF/, ''))
}

function startApp() {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '180000',
    SMOKE_CLICK_MS: '600000', // 不让冒烟钩子自己切页，巡检由本脚本驱动
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = EXE
    ? spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  return { child, log: () => log }
}

async function waitForPage(port, child) {
  for (let i = 0; i < 60; i += 1) {
    if (child && child.exitCode !== null) throw new Error(`应用进程已退出（exit=${child.exitCode}）`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 端口还没起来 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等待渲染页调试端点超时')
}

async function waitFor(cdp, expression, label, timeout = 20000) {
  const start = Date.now()
  for (;;) {
    if (await cdp.eval(expression)) return true
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** 取当前页顶栏的空白点与控件点（CSS px，视口坐标） */
const POINTS_EXPR = `(() => {
  const bar = document.querySelector('.app-topbar')
  if (!bar) return null
  const barRect = bar.getBoundingClientRect()
  const slot = document.querySelector('#app-topbar-slot')
  const slotRect = slot ? slot.getBoundingClientRect() : null
  const winBox = document.querySelector('.win-controls')
  const winRect = winBox ? winBox.getBoundingClientRect() : null
  const midY = Math.round(barRect.top + barRect.height / 2)
  const blanks = []
  // 插槽内容最右边界（插槽是 flex:1 撑满的，内容右边界之后到窗口按钮之间就是"标题栏空白"）
  let contentRight = slotRect ? slotRect.left : barRect.left
  if (slot) {
    for (const el of slot.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && r.right > contentRight) contentRight = r.right
    }
  }
  const gapLeft = Math.round(contentRight) + 6
  const gapRight = Math.round((winRect ? winRect.left : barRect.right) - 18)
  if (gapRight - gapLeft >= 40) blanks.push({ name: 'topbar-gap', x: Math.round((gapLeft + gapRight) / 2), y: midY })
  blanks.push({ name: 'topbar-left-pad', x: Math.round(barRect.left + 12), y: midY })
  // 页标题文字上方/下方 1px 处也属于顶栏（保证"标题旁边"也是拖拽区）
  const title = slot ? slot.querySelector('.topbar-page-title') : null
  if (title) {
    const t = title.getBoundingClientRect()
    blanks.push({ name: 'topbar-title-band', x: Math.round(t.left + t.width / 2), y: Math.round(t.top - 3) })
  }
  // 控件中心点（按中心去重，避免 el-select 的 wrapper 与内部 input 重复）
  const controls = []
  const seen = new Set()
  const sel = 'button, .el-select__wrapper, .el-radio-button, .el-switch, .el-checkbox, .el-input__wrapper'
  for (const el of bar.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(r.top + r.height / 2)
    const key = x + ',' + y
    if (seen.has(key)) continue
    seen.add(key)
    const label = (el.textContent || el.className || '').replace(/\\s+/g, ' ').trim().slice(0, 18)
    controls.push({ name: 'ctrl:' + (label || el.tagName.toLowerCase()), x, y })
  }
  return { dpr: window.devicePixelRatio, barHeight: Math.round(barRect.height), blanks, controls }
})()`

const MENU_PAGES = [
  { menu: '工作台', label: '工作台' },
  { menu: '项目', label: '项目' },
  { menu: '部署', label: '部署' },
  { menu: '终端工作台', label: '终端工作台' },
  { menu: '活动报告', label: '活动报告' },
  { menu: '设置', label: '设置' },
]

const HT_CLIENT = 1
const HT_CAPTION = 2

async function main() {
  const app = startApp()
  let cdp = null
  let ps = null
  let originalRect = null
  let originalCursor = null
  let originalMinimized = false
  let originalMaximized = false
  let originalSize = { w: 0, h: 0 }
  try {
    cdp = await Cdp.connect(await waitForPage(PORT, app.child))
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await waitFor(cdp, `!!document.querySelector('.app-topbar')`, '顶栏渲染')

    const go = (label) => cdp.eval(`(() => {
      const m = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.includes('${label}'))
      if (m) m.click()
      return !!m
    })()`)
    await waitFor(cdp, `!!document.querySelector('.app-menu .el-menu-item')`, '侧栏菜单渲染')

    // 窗口位置/光标先记下来，验证完恢复（拖动会真的挪窗口、挪鼠标）
    appTitle = (await cdp.eval('document.title')) || ''
    const appPid = EXE ? app.child.pid : (findAppPid(app.child.pid) || app.child.pid)
    const geom0 = runPs({ pid: appPid, scale: 1, action: 'geom' })
    ps = { pid: appPid, scale: 1 }
    if (!geom0.ok) throw new Error(`找不到应用窗口（pid=${appPid}，标题「${appTitle}」）：${geom0.error}\n可见窗口：${JSON.stringify(geom0.windows || [])}`)
    originalRect = geom0.rect
    originalCursor = geom0.cursor
    originalMinimized = !!geom0.minimized
    originalMaximized = !!geom0.maximized
    originalSize = { w: originalRect.right - originalRect.left, h: originalRect.bottom - originalRect.top }
    // 只做必要的窗口干预：状态恢复（最小化/最大化 → 正常）。窗口位置不摆、尺寸不设、结束时也不还原——
    // 这是沙箱测试实例，位置由系统给，坐标一律按 geom 实时换算。教训：用 SetWindowPos 改窗口会让
    // Electron 的窗口尺寸计算与原生窗口不同步，之后每个点的命中测试都变成 resize 边框（全 HTBOTTOMRIGHT）。
    const dpr = await cdp.eval('window.devicePixelRatio')
    runPs({ pid: appPid, scale: 1, action: 'restore', state: 'normal' })
    await new Promise((r) => setTimeout(r, 600))
    const geom = runPs({ pid: appPid, scale: dpr && dpr !== 1 ? dpr : 1, action: 'geom', keepCursor: true })
    if (!geom.ok) throw new Error(`重置窗口后仍找不到窗口：${geom.error}`)
    ps.scale = geom.scale || 1
    const ww = geom.rect.right - geom.rect.left
    const wh = geom.rect.bottom - geom.rect.top
    if (geom.minimized) throw new Error(`窗口处于最小化状态，无法作为测试基线（rect=${JSON.stringify(geom.rect)}）`)
    if (ww < 1000 || wh < 640) throw new Error(`窗口尺寸异常，不能作为基线：${ww}×${wh}`)
    console.log(`窗口句柄 ${geom.hwnd}，窗口 ${geom.rect.left},${geom.rect.top} ${ww}×${wh}（dpr=${dpr}，显示器 ${JSON.stringify(geom.monitor)}），` +
      `窗口${geom.foreground ? '在前台' : '不在前台'}；本轮开始前窗口状态：位置 ${originalRect.left},${originalRect.top} ${originalSize.w}×${originalSize.h}` +
      `${originalMinimized ? '（最小化）' : originalMaximized ? '（最大化）' : ''}`)

    console.log('\n[D1/D2] 顶栏空白可拖、控件可点（Windows WM_NCHITTEST）')
    // 窗口被最小化时页面 visibilityState 会变 hidden：用它当廉价探针，异常时才出声
    const vis = () => cdp.eval(`document.visibilityState + '/focus=' + document.hasFocus()`)
    const visCheck = async (label) => {
      const v = await vis()
      if (!String(v).startsWith('visible')) console.log(`  [探针] ${label} 后窗口不可见：${v}`)
    }
    const pagePoints = {}
    for (const page of MENU_PAGES) {
      await go(page.menu)
      try {
        await waitFor(cdp, `(() => {
          const t = document.querySelector('#app-topbar-slot .topbar-page-title')
          return t && t.textContent.trim() === ${JSON.stringify(page.label)}
        })()`, `顶栏出现「${page.label}」`, 8000)
      } catch { /* 下面统一断言 */ }
      await new Promise((r) => setTimeout(r, 500))
      const info = await cdp.eval(POINTS_EXPR)
      if (!info) { check(`「${page.menu}」顶栏可取点`, false, '未找到 .app-topbar'); continue }
      ps.scale = info.dpr
      const points = [...info.blanks.map((p) => ({ ...p, kind: 'blank' })), ...info.controls.map((p) => ({ ...p, kind: 'control' }))]
      const res = runPs({ pid: ps.pid, scale: info.dpr, action: 'hit', points })
      if (!res.ok) { check(`「${page.menu}」命中测试`, false, res.error); continue }
      pagePoints[page.menu] = { info, res }
      const blanks = res.hits.filter((h) => h.kind === 'blank')
      const controls = res.hits.filter((h) => h.kind === 'control')
      const gap = blanks.find((b) => b.name === 'topbar-gap')
      check(`「${page.menu}」顶栏中段空白返回 HTCAPTION（可拖窗口）`, !!gap && gap.hit === HT_CAPTION,
        gap ? `${gap.name}@${gap.cssX},${gap.cssY} → hit=${gap.hit}` : '插槽右侧没有足够空白（内容撑满）')
      const badBlanks = blanks.filter((b) => b.hit !== HT_CAPTION)
      check(`「${page.menu}」全部空白点可拖（${blanks.length} 个）`, badBlanks.length === 0,
        badBlanks.map((b) => `${b.name}@${b.cssX}→${b.hit}`).join(' '))
      const badControls = controls.filter((c) => c.hit !== HT_CLIENT)
      check(`「${page.menu}」${controls.length} 个顶栏控件返回 HTCLIENT（可点击）`, badControls.length === 0 && controls.length > 0,
        badControls.map((c) => `${c.name}@${c.cssX}→${c.hit}`).join(' '))
      await cdp.shot(path.join(SHOTS, `drag-${page.menu}.png`)).catch(() => { /* 截图仅存档，失败不影响结论 */ })
      await visCheck(`「${page.menu}」`)
    }

    console.log('\n[D3] 真实鼠标在顶栏空白处按下拖动 → 窗口真的移动')
    const target = pagePoints['工作台'] || Object.values(pagePoints)[0]
    if (!target) throw new Error('没有可用的顶栏取点结果')
    const blank = target.res.hits.find((h) => h.kind === 'blank' && h.hit === HT_CAPTION)
    if (!blank) throw new Error('找不到命中为 HTCAPTION 的顶栏空白点')
    // 拖动方向和距离要挑安全的：鼠标终点离屏幕边缘太近会触发 Windows 的 Aero Snap 吸附
    // （吸附会把窗口吸到屏幕角落，位移与鼠标位移不再相等，那样测出来的是吸附不是拖拽）。
    // 起点在顶栏（贴着屏幕顶部），垂直余量天然很小，所以按窗口所在显示器逐级降级挑方向。
    const scale = ps.scale
    const geomNow = runPs({ pid: ps.pid, scale, action: 'geom' })
    const cur = geomNow.ok ? geomNow : geom
    const startX = cur.clientOrigin.x + Math.round(blank.cssX * scale)
    const startY = cur.clientOrigin.y + Math.round(blank.cssY * scale)
    const mon = cur.monitor || { left: 0, top: 0, right: 1920, bottom: 1080 }
    const margin = 40
    const candidates = [[80, 40], [-80, 40], [80, -40], [-80, -40], [80, 0], [-80, 0], [0, 40], [0, -40]]
    let delta = null
    for (const [dx, dy] of candidates) {
      const cx = startX + dx
      const cy = startY + dy
      if (cx < mon.left + margin || cy < mon.top + margin || cx > mon.right - margin || cy > mon.bottom - margin) continue
      const r = cur.rect
      if (r.left + dx < mon.left || r.top + dy < mon.top || r.right + dx > mon.right || r.bottom + dy > mon.bottom) continue
      delta = [dx, dy]
      break
    }
    if (!delta) throw new Error(`找不到安全的拖动方向（起点 ${startX},${startY}，窗口 ${JSON.stringify(cur.rect)}，显示器 ${JSON.stringify(mon)}）`)
    const [dx, dy] = delta
    const drag = runPs({ pid: ps.pid, scale, action: 'drag', x: blank.cssX, y: blank.cssY, dx, dy, activateAt: blank })
    if (!drag.ok) throw new Error(`拖动失败：${drag.error}`)
    const movedX = drag.rectAfter.left - drag.rectBefore.left
    const movedY = drag.rectAfter.top - drag.rectBefore.top
    if (drag.reason === 'not-foreground') {
      check('空白处拖动后窗口跟随移动', false, '窗口无法置前，已跳过拖动以免误操作其他窗口')
    } else {
      // 起点在顶栏空白处，窗口应整体跟随鼠标移动（允许系统把移动量四舍五入到偶数像素）
      const okX = Math.abs(movedX - dx) <= 8
      const okY = Math.abs(movedY - dy) <= 8
      check('空白处拖动后窗口跟随移动', okX && okY,
        `期望位移约 ${dx},${dy}，实际 ${movedX},${movedY}（窗口 ${drag.rectBefore.left},${drag.rectBefore.top} → ${drag.rectAfter.left},${drag.rectAfter.top}；拖动前前台=${drag.foregroundBeforeDrag}）`)
    }

    console.log('\n[D4] 真实鼠标点顶栏控件仍然生效（OS 级点击）')
    await go('项目')
    await waitFor(cdp, `!!document.querySelector('#app-topbar-slot .el-button')`, '项目页出现操作按钮')
    await new Promise((r) => setTimeout(r, 500))
    const btn = await cdp.eval(`(() => {
      const el = document.querySelector('#app-topbar-slot .el-button')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: el.textContent.trim() }
    })()`)
    if (!btn) throw new Error('项目页顶栏没有按钮')
    const projInfo = await cdp.eval(POINTS_EXPR)
    const projBlank = projInfo?.blanks?.[0] || null
    const hot = runPs({ pid: ps.pid, scale: ps.scale, action: 'hit', points: [{ name: 'btn', kind: 'control', x: btn.x, y: btn.y }] })
    check(`顶栏「${btn.text}」按钮命中返回 HTCLIENT`, hot.ok && hot.hits[0].hit === HT_CLIENT,
      `dom=${btn.x},${btn.y} → screen=${hot.hits?.[0]?.screenX},${hot.hits?.[0]?.screenY} hit=${hot.hits?.[0]?.hit}`)
    const READ_PANEL = `(() => {
      const el = [...document.querySelectorAll('.el-drawer, .el-dialog')]
        .find((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      return el ? el.textContent.replace(/\\s+/g, ' ').slice(0, 40) : ''
    })()`
    let panelText = ''
    let osFailReason = ''
    for (let attempt = 1; attempt <= 2 && !panelText; attempt += 1) {
      const osClick = runPs({ pid: ps.pid, scale: ps.scale, action: 'click', x: btn.x, y: btn.y, activateAt: projBlank })
      if (osClick.ok === false) { osFailReason = osClick.reason || osClick.error; break }
      await new Promise((r) => setTimeout(r, 1300))
      panelText = await cdp.eval(READ_PANEL)
    }
    if (panelText) {
      check(`真实鼠标点顶栏「${btn.text}」打开了表单`, true, panelText)
    } else if (osFailReason) {
      check('真实鼠标点顶栏按钮生效', false, `窗口无法置前（${osFailReason}），已跳过点击以免误点其他窗口`)
    } else {
      // OS 级点击没生效时，用 DOM 点击做对照：区分「按钮真的坏了」和「焦点/输入被别的窗口截走」
      await cdp.eval(`(() => { const b = document.querySelector('#app-topbar-slot .el-button'); if (b) b.click(); return !!b })()`)
      await new Promise((r) => setTimeout(r, 1000))
      const domPanel = await cdp.eval(READ_PANEL)
      check(`真实鼠标点顶栏「${btn.text}」打开了表单`, false,
        domPanel ? `OS 级点击未生效但 DOM 点击打开了表单（按钮本身可用，是输入焦点问题）：${domPanel}` : 'OS 级与 DOM 点击都没打开表单')
    }
    // 收尾：不管表单有没有打开，都点掉可能的抽屉，避免影响后面的用例
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.el-drawer .el-button, .el-dialog .el-button')].find((x) => /取消|关闭/.test(x.textContent))
      if (b) b.click()
      return true
    })()`)
    await new Promise((r) => setTimeout(r, 400))

    console.log('\n[D5] 顶栏空白处双击 → 窗口最大化 / 再双击还原')
    const info5 = await cdp.eval(POINTS_EXPR)
    const blank5 = info5?.blanks?.[0]
    if (!blank5) throw new Error('顶栏没有可取点的空白位置')
    const zoomIn = runPs({ pid: ps.pid, scale: ps.scale, action: 'dblclick', x: blank5.x, y: blank5.y, activateAt: blank5 })
    if (zoomIn.ok === false) {
      check('双击顶栏空白处窗口最大化', false, `窗口无法置前（${zoomIn.reason}），已跳过双击以免误点其他窗口`)
    } else {
      check('双击顶栏空白处窗口最大化', zoomIn.maximized === true,
        `maximized=${zoomIn.maximized} rect=${JSON.stringify(zoomIn.rect)}`)
      if (zoomIn.maximized === true) {
        // 最大化后窗口变宽，顶栏空白的位置跟着变，必须重新取点（沿用旧坐标会落到按钮上）
        const info5b = await cdp.eval(POINTS_EXPR)
        const blank5b = info5b?.blanks?.[0] || blank5
        const zoomOut = runPs({ pid: ps.pid, scale: ps.scale, action: 'dblclick', x: blank5b.x, y: blank5b.y, activateAt: blank5b })
        check('再次双击顶栏空白处还原', zoomOut.ok !== false && zoomOut.maximized === false,
          zoomOut.ok === false ? `窗口无法置前（${zoomOut.reason}）` : `maximized=${zoomOut.maximized}`)
      } else {
        check('再次双击顶栏空白处还原', false, '第一次双击没有最大化，跳过还原（避免在非最大化状态下双击）')
      }
    }

    console.log(`\n截图：${SHOTS}`)
    console.log(`沙箱：${SANDBOX}`)
  } catch (err) {
    console.error('\n巡检异常：', (err && err.stack) || err)
    console.error('应用日志尾部：')
    console.error(String(app.log()).split('\n').slice(-20).join('\n'))
    failed += 1
  } finally {
    // 只把鼠标还回去：窗口是沙箱测试实例，位置/尺寸不必还原（动它反而会引入状态不同步）
    if (originalCursor && ps) {
      try {
        const rc = runPs({ pid: ps.pid, scale: ps.scale, action: 'restore', state: 'normal', cursor: originalCursor })
        if (rc?.ok) console.log(`\n窗口状态：${rc.minimized ? '最小化' : rc.maximized ? '最大化' : '正常'}，鼠标已复位`)
      } catch (e) { console.log(`\n鼠标复位失败（不影响结论）：${e.message}`) }
    }
    cdp?.close()
    try { app.child.kill() } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 1000))
    console.log(`\n顶栏拖拽巡检：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main()
