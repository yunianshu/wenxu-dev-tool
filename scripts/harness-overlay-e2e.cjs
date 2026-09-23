/**
 * 端到端验证：Harness 内嵌原生子视图与应用浮层/容器跟随
 *
 * 背景（用户反馈「点更新出现一个弹窗」）：Tauri 版内嵌 Harness 是**原生子 Webview**，
 * 永远盖在主页面之上。主页面里的浮层（更新确认框、服务设置对话框、关闭询问）被它
 * 整块遮住——屏幕上只剩外壳变暗、对话框看不见；同时 capabilities 里没放行
 * set_webview_position/size，positionTauriWebview() 被 ACL 拒绝且异常被吞掉，
 * 侧栏收起/沉浸全屏时内嵌页停在旧位置。
 *
 * 验收标准（源自需求「浮层要能看见、内嵌页要跟着容器」）：
 *   O1 点顶栏「更新到 x.y.z」→ 确认框在 DOM 中可见，且原生子视图此刻被隐藏
 *   O2 取消 → 没有真的开始安装，原生子视图恢复显示，内嵌页仍可访问
 *   O3 顶栏「服务设置」对话框同样可见（同一根因），关闭后原生子视图恢复
 *   O4 内嵌原生子视图几何跟随容器：侧栏收起、沉浸全屏后都与 .harness-frame 一致
 *   O5 无回归：服务运行中、内嵌页可加载、窗口外壳可正常切换
 *
 * 真实依赖：已安装/已打包的 Tauri 产物 + 真实 WebView2 原生子视图 + 真实 dsh 服务。
 * 沙箱隔离 APPDATA / USERPROFILE / userData / 运行时缓存，不触碰本机正在使用的实例。
 *
 * 前置：产物由 `npm run build:win` 或 `npm run update:local` 生成
 * 用法：node scripts/harness-overlay-e2e.cjs
 *      E2E_EXE=<personnel-plm.exe> node scripts/harness-overlay-e2e.cjs
 *      KEEP=1 保留沙箱与截图目录
 */
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PLM_CDP_PORT || 9337)
const SANDBOX = path.join(os.tmpdir(), `pm-harness-overlay-e2e-${Date.now()}`)
const SHOTS = path.join(ROOT, 'output', 'harness-overlay-e2e')
const EXE = process.env.E2E_EXE || process.env.EXE_PATH
  || path.join(process.env.LOCALAPPDATA || '', 'Personnel PLM', 'personnel-plm.exe')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = 0
const log = (...args) => console.log(...args)
function check(name, cond, detail = '') {
  if (cond) log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
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

/** 原生子视图枚举：WRY_WEBVIEW 窗口的可见性与矩形（ASCII-only 脚本，避免 PS 编码坑） */
function nativeViews() {
  const ps = path.join(SANDBOX, 'views.ps1')
  fs.writeFileSync(ps, `
param([int]$ProcId)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class NatViews {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static List<string> Rows = new List<string>();
  public static void Walk(IntPtr h, int depth) {
    if (depth > 2) return;
    StringBuilder cls = new StringBuilder(128);
    GetClassName(h, cls, 128);
    string name = cls.ToString();
    if (name == "WRY_WEBVIEW" || name == "Tauri Window") {
      RECT r; GetWindowRect(h, out r);
      Rows.Add(name + " " + IsWindowVisible(h) + " " + r.Left + " " + r.Top + " " + (r.Right - r.Left) + " " + (r.Bottom - r.Top));
    }
    EnumChildWindows(h, (c, p) => { Walk(c, depth + 1); return true; }, IntPtr.Zero);
  }
}
"@
$p = Get-Process -Id $ProcId
if ($p.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output "NONE"; exit 0 }
[NatViews]::Rows.Clear()
[NatViews]::Walk($p.MainWindowHandle, 0)
[NatViews]::Rows | ForEach-Object { Write-Output $_ }
`)
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, String(pidCurrent)], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [cls, vis, x, y, w, h] = line.trim().split(/\s+/)
      return { cls, visible: vis === 'True', x: Number(x), y: Number(y), w: Number(w), h: Number(h) }
    }).filter((item) => item.cls === 'WRY_WEBVIEW')
  } catch (err) {
    return [{ error: err.message }]
  }
}

function shootWindow(outFile) {
  const ps = path.join(SANDBOX, 'shot.ps1')
  if (!fs.existsSync(ps)) {
    fs.writeFileSync(ps, `
param([int]$ProcId, [string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Shot {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$p = Get-Process -Id $ProcId
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output "NO_WINDOW"; exit 1 }
[Shot]::ShowWindow($h, 9) | Out-Null
[Shot]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
[Shot]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 700
$r = New-Object Shot+RECT
[Shot]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
[Shot]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) | Out-Null
`)
  }
  try { fs.mkdirSync(path.dirname(outFile), { recursive: true }); execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, String(pidCurrent), outFile], { encoding: 'utf8' }) } catch { /* 截图非致命 */ }
}

let pidCurrent = 0

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

/** 浮层可见性 + 原生子视图几何（读命令已放行的 webview_position/size） */
const PROBE = `(async () => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
  const visible = (sel) => [...document.querySelectorAll(sel)].filter((el) => getComputedStyle(el).display !== 'none').length
  const invoke = window.__TAURI_INTERNALS__.invoke
  const pos = await invoke('plugin:webview|webview_position', { label: 'harness' }).catch(() => null)
  const size = await invoke('plugin:webview|webview_size', { label: 'harness' }).catch(() => null)
  return {
    frameRect: rect(document.querySelector('.harness-frame')),
    visibleMessageBoxes: visible('.el-message-box'),
    visibleDialogs: visible('.el-dialog'),
    nativePos: pos, nativeSize: size,
  }
})()`

function sameRect(a, b, tolerance = 2) {
  if (!a || !b) return false
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.w - b.w) <= tolerance && Math.abs(a.h - b.h) <= tolerance
}

async function main() {
  if (!EXE || !fs.existsSync(EXE)) throw new Error(`未找到 Tauri 产物：${EXE || '(空)'}（用 E2E_EXE 指定）`)
  log(`=== Harness 浮层 / 原生子视图 E2E ===`)
  log(`产物：${EXE}`)
  log(`沙箱：${SANDBOX}`)

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
    const waitRunning = Date.now() + 240000
    while (Date.now() < waitRunning) {
      status = await cdp.eval(`window.gitReport.harnessStatus()`).catch(() => null)
      if (status && status.status === 'running') break
      await sleep(2000)
    }
    check('O5 服务运行中（前置）', !!status && status.status === 'running', status && status.displayUrl)

    const inner = await waitTarget((t) => /^http:\/\/127\.0\.0\.1:\d+/.test(String(t.url)), 30000, '内嵌 Harness 页面')
    const innerCdp = await Cdp.connect(inner.webSocketDebuggerUrl)
    await sleep(2500)

    // 基线：原生子视图几何 == 容器矩形；两个原生子视图（主页面 + 内嵌页）都可见
    const base = await cdp.eval(PROBE)
    const baseViews = nativeViews()
    check('O4 基线：原生子视图几何 == .harness-frame', sameRect({ x: base.nativePos?.x, y: base.nativePos?.y, w: base.nativeSize?.width, h: base.nativeSize?.height }, base.frameRect),
      JSON.stringify({ native: { ...base.nativePos, ...base.nativeSize }, frame: base.frameRect }))
    check('O5 基线：主页面与内嵌页两个原生子视图都可见', baseViews.filter((v) => v.visible).length === 2, JSON.stringify(baseViews))

    // O1：顶栏「更新到 x.y.z」→ 确认框可见 + 原生子视图让位
    const update = await cdp.eval(`window.gitReport.harnessUpdateCheck()`).catch(() => null)
    const clicked = await cdp.eval(`(() => { const b = [...document.querySelectorAll('#app-topbar-slot button')].find((x) => x.textContent.trim().startsWith('更新到')); if (!b) return ''; b.click(); return b.textContent.trim() })()`)
    await sleep(1500)
    const afterClick = await cdp.eval(PROBE)
    const clickViews = nativeViews()
    check('O1 顶栏更新入口存在并点击', !!clicked, clicked || '未找到「更新到 …」按钮')
    check('O1 确认框在 DOM 中可见', afterClick.visibleMessageBoxes === 1, `messageBoxes=${afterClick.visibleMessageBoxes}`)
    check('O1 确认框打开时原生子视图被隐藏（浮层可见的必要条件）', clickViews.filter((v) => v.visible).length === 1,
      JSON.stringify(clickViews))
    shootWindow(path.join(SHOTS, 'o1-update-confirm.png'))

    // O2：取消 → 未安装、原生子视图恢复、内嵌页仍可用
    const cancelled = await cdp.eval(`(() => { const box = document.querySelector('.el-message-box'); const cancel = box && [...box.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消'); if (!cancel) return false; cancel.click(); return true })()`)
    await sleep(1500)
    const afterCancel = await cdp.eval(`(async () => ({ install: (await window.gitReport.harnessUpdateStatus()).install, ...(await (${PROBE})) }))()`)
    const cancelViews = nativeViews()
    check('O2 取消失败/未安装', cancelled === true && afterCancel.install.status === 'idle', JSON.stringify(afterCancel.install))
    check('O2 取消后原生子视图恢复可见', cancelViews.filter((v) => v.visible).length === 2, JSON.stringify(cancelViews))
    check('O2 取消后几何仍与容器一致', sameRect({ x: afterCancel.nativePos?.x, y: afterCancel.nativePos?.y, w: afterCancel.nativeSize?.width, h: afterCancel.nativeSize?.height }, afterCancel.frameRect))
    const innerAlive = await innerCdp.eval(`({ href: location.href, title: document.title, body: document.body ? document.body.childElementCount : 0 })`).catch((err) => ({ error: err.message }))
    check('O2 内嵌页仍可访问（未被隐藏/恢复影响）', !!innerAlive && !innerAlive.error && innerAlive.body > 0, JSON.stringify(innerAlive))

    // O3：服务设置对话框同样要看得见
    await cdp.eval(`(() => { const b = [...document.querySelectorAll('#app-topbar-slot button')].find((x) => x.textContent.trim() === '服务设置'); if (b) b.click(); return !!b })()`)
    await sleep(1500)
    const settings = await cdp.eval(PROBE)
    const settingsViews = nativeViews()
    check('O3 服务设置对话框在 DOM 中可见', settings.visibleDialogs >= 1, `dialogs=${settings.visibleDialogs}`)
    check('O3 对话框打开时原生子视图被隐藏', settingsViews.filter((v) => v.visible).length === 1, JSON.stringify(settingsViews))
    shootWindow(path.join(SHOTS, 'o3-settings-dialog.png'))
    await cdp.eval(`(() => { const c = [...document.querySelectorAll('.el-dialog button')].find((b) => b.textContent.trim() === '取消'); if (c) c.click(); return true })()`)
    await sleep(1500)
    check('O3 关闭对话框后原生子视图恢复', nativeViews().filter((v) => v.visible).length === 2, JSON.stringify(nativeViews()))

    // O4：侧栏收起 → 原生子视图跟随新容器几何
    await cdp.eval(`(() => { const t = document.querySelector('.sidebar-toggle, .app-sidebar .toggle, .app-sidebar button'); if (t) t.click(); return !!t })()`)
    await sleep(1800)
    const collapsed = await cdp.eval(PROBE)
    check('O4 侧栏收起后原生子视图跟随容器', sameRect({ x: collapsed.nativePos?.x, y: collapsed.nativePos?.y, w: collapsed.nativeSize?.width, h: collapsed.nativeSize?.height }, collapsed.frameRect),
      JSON.stringify({ native: { ...collapsed.nativePos, ...collapsed.nativeSize }, frame: collapsed.frameRect }))
    await cdp.eval(`(() => { const t = document.querySelector('.sidebar-toggle, .app-sidebar .toggle, .app-sidebar button'); if (t) t.click(); return !!t })()`)
    await sleep(1500)

    // O4：沉浸全屏 → 原生子视图让出顶部悬浮条（y = 容器 top + 48）
    await cdp.eval(`(() => { const b = [...document.querySelectorAll('#app-topbar-slot button')].find((x) => x.textContent.trim() === '全屏'); if (b) b.click(); return !!b })()`)
    await sleep(2500)
    const fullscreen = await cdp.eval(PROBE)
    const fsRect = fullscreen.frameRect
    const expectedY = (fsRect?.y || 0) + 48
    check('O4 沉浸全屏后原生子视图让出顶部悬浮条', !!fullscreen.nativePos && Math.abs(fullscreen.nativePos.y - expectedY) <= 3,
      JSON.stringify({ native: fullscreen.nativePos, expectY: expectedY, frame: fsRect }))
    shootWindow(path.join(SHOTS, 'o4-immersive.png'))
    await cdp.eval(`(async () => { await window.gitReport.winSetFullScreen(false); return true })()`)
    await sleep(2000)

    // O5：外壳与页面仍然可用
    const shell = await cdp.eval(`({ sidebar: !!document.querySelector('.app-sidebar'), topbar: !!document.querySelector('.app-topbar'), title: document.querySelector('#app-topbar-slot .topbar-page-title')?.textContent || '' })`)
    check('O5 退出全屏后外壳恢复', shell.sidebar && shell.topbar, JSON.stringify(shell))
    log('  渲染层 stderr 尾部：', stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' | '))
    innerCdp.close()
  } catch (err) {
    log('!! 出错：', err.message)
    log('  进程 stderr：', stderr.split(/\r?\n/).filter(Boolean).slice(-8).join(' | '))
    failed += 1
  } finally {
    cdp?.close()
    try { execFileSync('taskkill', ['/PID', String(pidCurrent), '/T', '/F'], { stdio: 'ignore' }) } catch { /* noop */ }
    await sleep(1500)
    if (!process.env.KEEP) { try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ } }
  }

  log(failed ? `\n结果：${failed} 项未通过（截图：${SHOTS}）` : `\n结果：全部通过（截图：${SHOTS}）`)
  process.exitCode = failed ? 1 : 0
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
