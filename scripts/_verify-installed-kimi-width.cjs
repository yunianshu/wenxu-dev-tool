/**
 * 安装产物抽查：正式安装的 Tauri 应用（WebView2）里跑 terminal-unicode-fixture，
 * 从 DOM 量光标块列位 —— 确认 kimi 场景的宽度修复在用户实际使用的安装版里生效。
 * 期望值与 scripts/terminal-unicode-e2e.cjs 相同（conhost 实测宽度，不从被测代码反推）。
 * 会短暂驱动真实应用（真实用户数据）：打开终端工作台 → 在窗格跑夹具 → 量测 → 退出并重启。
 * 用法：node scripts/_verify-installed-kimi-width.cjs
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const EXE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Personnel PLM', 'personnel-plm.exe')
const PORT = Number(process.env.PLM_CDP_PORT || 9231)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 光标块期望列（0 起算；行首「[序号] │ > 」共 9 格），与 terminal-unicode-e2e.cjs 一致 */
const EXPECT = { '01': 12, '02': 17, '03': 17, '04': 17, '05': 11, '06': 12, '07': 12, '08': 17, '09': 19 }

function runningPids() {
  // 用 WMI 枚举：Get-Process 看不见强杀后残留的僵尸宿主，而它仍持有单实例锁
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    "&{ (Get-CimInstance Win32_Process -Filter \"Name='personnel-plm.exe'\" | ForEach-Object { $_.ProcessId }) -join ',' }"],
  { encoding: 'utf8' })
  return String(out.stdout || '').trim().split(',').map(Number).filter(Boolean)
}

/** 强杀宿主后，属于本应用的 WebView2 子进程会变孤儿并继续占用数据目录
 * （user-data-dir 在 %LOCALAPPDATA%\com.prt.devprojectmanager\EBWebView）；
 * 新实例启动时会直接加入已有浏览器进程，--remote-debugging-port 只对首个进程生效，
 * 端口永远起不来。必须按命令行把它们一并清掉。 */
function orphanWebView2Pids() {
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    '&{ Get-CimInstance Win32_Process -Filter "Name=\'msedgewebview2.exe\'" | Where-Object { $_.CommandLine -like "*com.prt.devprojectmanager*" } | ForEach-Object { $_.ProcessId } }'], { encoding: 'utf8' })
  return String(out.stdout || '').trim().split(/\s+/).map(Number).filter(Boolean)
}

/** 随包后台进程（node backend/entry.cjs、harness 等）：强杀宿主不会带走它们，
 * 而新实例的单实例判定经过后台层，孤儿在就秒退（退出码 0、无任何输出）。
 * 必须把命令行引用安装目录的 node.exe 一并清掉。 */
function orphanBackendPids() {
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    '&{ Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like "*Personnel PLM*" } | ForEach-Object { $_.ProcessId } }'], { encoding: 'utf8' })
  return String(out.stdout || '').trim().split(/\s+/).map(Number).filter(Boolean)
}

async function stopApp() {
  for (let i = 0; i < 30; i += 1) {
    const pids = runningPids()
    if (!pids.length) break
    for (const pid of pids) { try { spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]) } catch { /* noop */ } }
    sleep(500)
  }
  for (let round = 0; round < 6; round += 1) {
    const backends = orphanBackendPids()
    const orphans = orphanWebView2Pids()
    if (!backends.length && !orphans.length) break
    for (const pid of [...backends, ...orphans]) { try { spawnSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]) } catch { /* noop */ } }
    sleep(800)
  }
  if (runningPids().length) throw new Error('无法停掉正在运行的应用实例')
}

/** 带调试端口拉起应用（cwd/detached 与 _verify-installed-ui.cjs 保持一致；撞锁会静默退出，由调用方确认实例存活） */
function launchWithCdp() {
  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  child.unref?.()
  return child
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`未找到安装产物：${EXE}`)
  await stopApp()
  // 强杀后单实例锁的残留要一小会儿才散：立刻重启会走「第二实例」路径静默退出
  sleep(3000)
  const child = launchWithCdp()
  // 实例没活下来说明撞了锁残留（静默退出码 0），再等再试
  for (let attempt = 1; attempt <= 3 && !runningPids().length; attempt += 1) {
    console.log(`拉起后未见实例（第 ${attempt} 次），再等 3 秒重试`)
    sleep(3000)
    if (!runningPids().length) launchWithCdp()
  }
  if (!runningPids().length) throw new Error('应用实例未能启动（疑似单实例锁残留）')

  // WebView2 的渲染页 URL 是 http://tauri.localhost/（Tauri 产物不带 index.html）
  let wsUrl = null
  for (let i = 0; i < 120 && !wsUrl; i += 1) {
    try {
      const all = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      wsUrl = all.find((t) => t.type === 'page' && /tauri\.localhost/.test(t.url || ''))?.webSocketDebuggerUrl || null
    } catch { /* 首启还要解包运行时，留足时间 */ }
    if (!wsUrl) sleep(1000)
  }
  if (!wsUrl) throw new Error('等待 WebView2 调试端点超时')
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
  })
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    const slot = pending.get(msg.id)
    if (!slot) return
    pending.delete(msg.id)
    if (msg.error) slot.reject(new Error(msg.error.message))
    else slot.resolve(msg.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = (seq += 1)
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时：${method}`)) } }, 30000).unref?.()
  })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || '求值异常')
    return res.result.value
  }

  try {
    // 切到终端工作台（真实用户数据里已保存过窗格布局）
    let paneReady = false
    for (let i = 0; i < 90 && !paneReady; i += 1) {
      paneReady = await evaluate(`(() => {
        const item = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.trim() === '终端工作台')
        if (item) item.click()
        return !!document.querySelector('.terminal-grid .term-pane .xterm-rows')
      })()`).catch(() => false)
      if (!paneReady) sleep(1000)
    }
    if (!paneReady) throw new Error('终端工作台窗格未就绪')
    sleep(2500) // 等会话与提示符稳定

    const point = await evaluate(`(() => {
      const r = document.querySelector('.terminal-grid .term-pane').getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.6) }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', clickCount: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    sleep(600)
    await send('Input.insertText', { text: `node "${path.join(__dirname, 'terminal-unicode-fixture.cjs')}"` })
    sleep(400)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    sleep(5000) // 夹具：两帧 + 提示符回来

    // 第 01 行是纯 ASCII 且占满整行：字符数即列数，格宽 = 行宽 ÷ 列数
    const measured = await evaluate(`(() => {
      const pane = document.querySelector('.terminal-grid .term-pane')
      const rows = [...pane.querySelectorAll('.xterm-rows > div')]
      const row1 = rows.find((d) => d.textContent.includes('[01]'))
      if (!row1) return null
      const cols = [...row1.textContent].length
      const cellW = row1.getBoundingClientRect().width / cols
      const out = []
      for (const row of rows) {
        const tag = (row.textContent.match(/\\[(\\d\\d)\\]/) || [])[1]
        if (!tag) continue
        const rect = row.getBoundingClientRect()
        const cursorCols = [...row.querySelectorAll('span')]
          .filter((el) => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)' && (el.textContent || '').trim() === '' && !el.classList.contains('xterm-cursor'))
          .map((el) => Math.round((el.getBoundingClientRect().left - rect.left) / cellW))
        out.push({ tag, cursorCols })
      }
      return out
    })()`)
    if (!measured) throw new Error('未找到夹具输出行')
    let failed = 0
    for (const m of measured) {
      const exp = EXPECT[m.tag]
      if (exp === undefined) continue
      const ok = m.cursorCols.length === 1 && m.cursorCols[0] === exp
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  行 ${m.tag} 光标块期望第 ${exp} 列，实测 ${JSON.stringify(m.cursorCols)}`)
      if (!ok) failed += 1
    }
    console.log(failed ? `安装产物抽查失败 ${failed} 项` : '安装产物抽查通过：kimi 场景宽度修复在正式安装版生效')
    process.exitCode = failed ? 1 : 0
  } finally {
    try { ws.close() } catch { /* noop */ }
    await stopApp()
    const relaunch = spawn(EXE, [], { stdio: 'ignore', detached: true }) // 跑完恢复用户日常使用状态
    relaunch.unref?.()
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
