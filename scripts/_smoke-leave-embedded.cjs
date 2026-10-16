// 临时冒烟：一键请假内嵌登录。临时 APPDATA + 独立 WebView2 数据目录，CDP 驱动真实界面。
// 验证链路：点「连接北森」→ 创建 leave-italent 独立窗口（能力放行）→ 加载北森 → probe 经 eval+HTTP 回调往返。
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EXE = process.env.E2E_EXE || path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'personnel-plm.exe')
const PORT = Number(process.env.PLM_CDP_PORT || 9231)
const APPDATA = path.join(os.tmpdir(), `pm-leave-smoke-${Date.now()}`)
const WEBVIEW_DIR = path.join(os.tmpdir(), `pm-leave-smoke-wv-${Date.now()}`)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
fs.mkdirSync(APPDATA, { recursive: true })
fs.mkdirSync(WEBVIEW_DIR, { recursive: true })
if (!fs.existsSync(EXE)) { console.error('exe 不存在: ' + EXE); process.exit(2) }
const child = spawn(EXE, [], {
  cwd: path.dirname(EXE),
  // 默认走通道链（本机有 Kimi 也不得借用，应落内嵌）；SMOKE_ADAPTER=embedded|browser 强制指定通道。
  env: {
    ...process.env, APPDATA, WEBVIEW2_USER_DATA_FOLDER: WEBVIEW_DIR, PLM_CDP_PORT: String(PORT),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    ...(process.env.SMOKE_ADAPTER === 'browser' ? { PLM_LEAVE_ADAPTER: 'browser' } : {}),
    ...(process.env.SMOKE_ADAPTER === 'embedded' ? { PLM_LEAVE_ADAPTER: 'embedded' } : {}),
  },
  stdio: 'ignore', detached: true,
})
child.unref()
const cleanup = () => { try { process.kill(-child.pid) } catch { try { spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)]) } catch { /* 退出路径 */ } } }
process.on('exit', cleanup)

async function pages() { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) }
async function openMain() {
  const page = (await pages()).find((p) => p.url.startsWith('http://tauri.localhost/'))
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  ws.eval = (expression) => new Promise((res, rej) => {
    const id = ++seq
    const timer = setTimeout(() => rej(new Error('evaluate 超时')), 60000)
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      ws.removeEventListener('message', onMessage)
      clearTimeout(timer)
      if (message.result?.exceptionDetails) rej(new Error(message.result.exceptionDetails.exception?.description || 'evaluate 异常'))
      else res(message.result?.result?.value)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  return ws
}
let seq = 0

async function main() {
  let ws = null
  for (let i = 0; i < 60 && !ws; i++) {
    try { ws = await openMain() } catch { /* 等主窗口 */ }
    if (!ws) sleep(2000)
  }
  if (!ws) throw new Error('主窗口 CDP 未就绪')
  const ready = await ws.eval(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<80;i++){if(document.querySelector('.app-menu [aria-label="一键请假"]'))break;await sleep(500)}return !!document.querySelector('.app-menu [aria-label="一键请假"]')})()`)
  if (!ready) throw new Error('侧栏未出现一键请假入口')
  await ws.eval(`document.querySelector('.app-menu [aria-label="一键请假"]').click()`)
  const pageShown = await ws.eval(`(async()=>{const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<40;i++){if(document.querySelector('.leave-page button'))break;await sleep(250)}return !!document.querySelector('.leave-page')})()`)
  if (!pageShown) throw new Error('一键请假页面未打开')
  const clicked = await ws.eval(`(()=>{const button=[...document.querySelectorAll('.leave-page button')].find(b=>b.textContent.includes('连接北森'));if(!button)return false;button.click();return true})()`)
  if (!clicked) throw new Error('未找到连接北森按钮')
  sleep(8000)
  let italent = null
  try { italent = (await pages()).find((p) => p.url.startsWith('https://cloud.italent.cn')) } catch { /* 独立窗口的 WebView2 不一定共享主窗口 CDP 端口 */ }
  let probe = null
  for (let i = 0; i < 30; i++) {
    probe = await ws.eval(`window.gitReport.leaveConnect()`)
    if (probe?.ok || !/进行中/.test(probe?.error || '')) break
    sleep(2000)
  }
  const errorShown = await ws.eval(`!!document.querySelector('.leave-page .el-alert--error')`)
  const loginHint = await ws.eval(`!!document.querySelector('.leave-page .leave-login-waiting')`)
  let osWindows = []
  try { osWindows = require('node:child_process').execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '_smoke-leave-windows.ps1')], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean) } catch { /* 无窗口 */ }
  const browserMode = process.env.SMOKE_ADAPTER === 'browser'
  console.log('[SMOKE]', JSON.stringify({ probe, errorShown, loginHint, osWindows: osWindows.length }))
  if (browserMode) {
    if (!probe?.ok || probe?.connected !== true) throw new Error('浏览器逃生门未确认连接: ' + JSON.stringify(probe))
    if (loginHint || osWindows.length) throw new Error('逃生门模式不应弹出登录窗口')
    if (errorShown) throw new Error('界面出现错误告警')
    console.log('一键请假浏览器逃生门冒烟通过')
    ws.close()
    process.exit(0)
  }
  if (!osWindows.length) {
    throw new Error('北森独立窗口未出现（能力或窗口创建失败）')
  }
  if (!probe?.ok || probe?.connected !== true) throw new Error('内嵌 probe 未确认连接: ' + JSON.stringify(probe))
  if (!/^https:\/\/(www|cloud)\.italent\.cn/.test(probe.origin || '')) throw new Error('probe 来源异常: ' + probe.origin)
  if (probe.loggedIn !== false) throw new Error('登录页应报告未登录: ' + JSON.stringify(probe))
  // 登录等待提示可能被后台自动登录成功即时清除（属正常），不作为断言
  if (errorShown) throw new Error('界面出现错误告警')
  console.log('一键请假内嵌登录（自动关闭监听）冒烟通过')
  ws.close()
  process.exit(0)
}
main().catch((error) => { console.error('冒烟失败:', error.message); process.exitCode = 1; process.exit(1) })
