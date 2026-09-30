// 发版校验（本机安装产物）：AI 工作台想法入口只保留想法地球——只读 DOM 断言，不写任何记录
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const EXE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Personnel PLM', 'personnel-plm.exe')
const PORT = Number(process.env.PLM_CDP_PORT || 9223)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function runningPids() {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', "&{ $p = Get-Process personnel-plm -ErrorAction SilentlyContinue; if ($p) { ($p | ForEach-Object { $_.Id }) -join ',' } }"], { encoding: 'utf8' })
  return String(out.stdout || '').trim().split(',').map(Number).filter(Boolean)
}
function closeApp() {
  const pids = runningPids()
  if (!pids.length) return
  spawnSync('taskkill', ['/IM', 'personnel-plm.exe'], { stdio: 'pipe' })
  for (let i = 0; i < 20 && runningPids().length; i++) sleep(500)
  if (runningPids().length) {
    spawnSync('taskkill', ['/F', '/IM', 'personnel-plm.exe'], { stdio: 'pipe' })
    for (let i = 0; i < 20 && runningPids().length; i++) sleep(500)
  }
}

async function withPage(fn) {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = pages.find((item) => item.url.startsWith('http://tauri.localhost/'))
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject) })
        let id = 0
        const evaluate = (expression, timeout = 20000) => new Promise((resolve, reject) => {
          const messageId = ++id
          const timer = setTimeout(() => reject(new Error('CDP 求值超时')), timeout)
          const onMessage = (event) => {
            const message = JSON.parse(event.data)
            if (message.id !== messageId) return
            socket.removeEventListener('message', onMessage)
            clearTimeout(timer)
            if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || 'CDP 异常'))
            else resolve(message.result?.result?.value)
          }
          socket.addEventListener('message', onMessage)
          socket.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
        })
        // fn 的业务异常不吞：吞了会被下面的 catch 当成“页面未就绪”重试，最后误报超时
        try { return await fn(evaluate) } finally { socket.close() }
      }
    } catch (error) {
      if (/CDP 求值超时|CDP 异常/.test(String(error.message))) throw error
      console.log(`  [retry ${i}] ${error.message}`)
    }
    sleep(2000)
  }
  throw new Error('等待 Tauri 主页面超时')
}

const clickTab = (label) => `([...document.querySelectorAll('.knowledge-tabs button')].find(el => el.textContent.includes('${label}')))?.click(); true`

async function main() {
  const checks = []
  console.log(`安装 exe：${EXE}`)
  // WebView2 浏览器进程按 user-data-dir 复用且只在新建时读取调试端口参数：
  // 若已有一个带端口的浏览器进程（此前校验脚本留下的），当前实例就挂在它上面，直接复用，不再重启。
  let reused = false
  try {
    const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    reused = pages.some((item) => item.url.startsWith('http://tauri.localhost/'))
  } catch { /* 端口没人听 */ }
  console.log(reused ? '复用已带调试端口的运行实例' : '重启应用并注入调试端口')
  let child = null
  if (!reused) {
    closeApp()
    sleep(2000)
    child = spawn(EXE, [], {
      cwd: path.dirname(EXE),
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    child.unref()
  }

  await withPage(async (evaluate) => {
    await evaluate("([...document.querySelectorAll('.app-menu .el-menu-item')].find(el => el.textContent.trim() === 'AI 工作台'))?.click(); true")
    sleep(1200)

    const globe = await evaluate(`(() => {
      const input = document.querySelector('.knowledge-idea-surface .knowledge-capture input')
      const topbar = [...document.querySelectorAll('.knowledge-topbar-actions .el-button')].map(el => el.textContent.trim())
      const primary = document.querySelector('.knowledge-topbar-actions .el-button.el-button--primary')
      return { inputPlaceholder: input?.placeholder || '', topbar, primary: primary?.textContent.trim() || '' }
    })()`)
    checks.push(['想法地球视图保留唯一输入条（放进地球）', globe.inputPlaceholder.includes('放进地球'), globe.inputPlaceholder])
    checks.push(['顶栏不再有「记录想法」按钮', !globe.topbar.some(t => t.includes('记录想法')), JSON.stringify(globe.topbar)])
    checks.push(['顶栏仍有「分析想法」与「新建记录」', globe.topbar.some(t => t.includes('分析想法')) && globe.topbar.some(t => t.includes('新建记录')), JSON.stringify(globe.topbar)])
    checks.push(['顶栏主操作为「新建记录」', globe.primary.includes('新建记录'), globe.primary])

    for (const view of ['收件箱', '全部记录', '方法与流程']) {
      await evaluate(clickTab(view))
      sleep(600)
      const state = await evaluate(`(() => ({
        captureCount: document.querySelectorAll('.knowledge-records .knowledge-capture').length,
        anyCapture: document.querySelectorAll('.knowledge-capture').length,
        filters: !!document.querySelector('.knowledge-records .knowledge-filters')
      }))()`)
      checks.push([`「${view}」视图无快速记录输入条`, state.anyCapture === 0 && state.filters, JSON.stringify(state)])
    }

    await evaluate(clickTab('想法地球'))
    sleep(600)
    const back = await evaluate("document.querySelector('.knowledge-idea-surface .knowledge-capture input')?.placeholder || ''")
    checks.push(['切回想法地球输入条仍在', back.includes('放进地球'), back])
  })

  if (!reused) {
    closeApp()
    sleep(1500)
    const relaunch = spawn(EXE, [], { cwd: path.dirname(EXE), env: process.env, stdio: 'ignore', detached: true })
    relaunch.unref()
    sleep(4000)
    console.log(`恢复正常启动：实例数 ${runningPids().length}`)
  } else {
    console.log('保留原实例运行')
  }

  let failed = 0
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
  }
  console.log(`结果：${checks.length - failed}/${checks.length} 项通过`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error(error.stack || error); process.exit(1) })
