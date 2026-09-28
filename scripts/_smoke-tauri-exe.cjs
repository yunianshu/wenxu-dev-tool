// 临时冒烟：直接启动 Tauri 打包 exe（临时 APPDATA，不碰真实数据），CDP 读 DOM 确认页面就绪。
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const EXE = process.env.E2E_EXE || path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'personnel-plm.exe')
const PORT = Number(process.env.PLM_CDP_PORT || 9227)
const APPDATA = path.join(os.tmpdir(), `pm-tsmoke-${Date.now()}`)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
fs.mkdirSync(APPDATA, { recursive: true })
if (!fs.existsSync(EXE)) { console.error('exe 不存在: ' + EXE); process.exit(2) }
const child = spawn(EXE, [], { cwd: path.dirname(EXE), env: { ...process.env, APPDATA, PLM_CDP_PORT: String(PORT), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` }, stdio: 'ignore', detached: true })
child.unref()
async function main() {
  for (let i = 0; i < 45; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = pages.find((p) => p.url.startsWith('http://tauri.localhost/'))
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
        const ev = (expr) => new Promise((res, rej) => {
          const id = 1
          const t = setTimeout(() => rej(new Error('超时')), 15000)
          const onm = (e) => { const m = JSON.parse(e.data); if (m.id !== id) return; ws.removeEventListener('message', onm); clearTimeout(t); m.result?.exceptionDetails ? rej(new Error(m.result.exceptionDetails.exception?.description)) : res(m.result?.result?.value) }
          ws.addEventListener('message', onm)
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }))
        })
        const r = await ev(`(async () => { const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); for(let i=0;i<40;i++){ if(document.querySelector('.app-menu')) break; await sleep(250) } return { menu: !!document.querySelector('.app-menu'), api: typeof window.gitReport === 'object', appLen: (document.getElementById('app')?.innerHTML||'').length } })()`)
        ws.close()
        console.log('[SMOKE]', JSON.stringify(r))
        if (!r.menu || !r.api || r.appLen < 1000) { console.log('SMOKE FAIL'); process.exit(1) }
        console.log('Tauri 产物冒烟通过')
        process.exit(0)
      }
    } catch { /* 重试 */ }
    sleep(2000)
  }
  console.error('冒烟超时：页面未就绪'); process.exit(1)
}
main().catch((e) => { console.error('冒烟异常:', e.message); process.exit(1) })
