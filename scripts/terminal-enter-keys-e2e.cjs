/**
 * E2E（真实 Electron + CDP 注入真实键盘 + OS 剪贴板）：终端组合回车键与粘贴键
 *
 * 背景：xterm 6.0 的 Enter 分支只区分 altKey（Keyboard.ts case 13），Ctrl+Enter /
 * Shift+Enter 都被翻成普通 \r 发给 pty —— claude 等 TUI 收到 \r 只会提交消息，
 * 换行永远无效。修复：TerminalPane 拦截这两组修饰回车改发 LF（\n），即 Claude Code
 * 官方 Ctrl+J 的换行序列（"works in any terminal"，源码解析 \n→name=enter→插入换行，
 * \r→name=return→提交）。顺带补齐 Ctrl+Shift+V 粘贴（对齐 Windows Terminal）。
 *
 * 验收标准（源自「终端里 Ctrl+Enter / Shift+Enter 要能换行，其余快捷键不得回归」，
 * 非按实现反推）：
 *   P1 Ctrl+Enter  → pty 收到 \n，且本次按键不发 \r（发了 \r 会被 claude 当成提交）
 *   P2 Shift+Enter → 同上
 *   P3 Ctrl+Shift+V → 粘贴剪贴板文本恰好一份（对齐 WT 的粘贴键），不收 0x16
 *   P4 裸 Enter    → 仍发 \r（claude 提交 / shell 执行依赖，不得改坏）
 *   P5 Ctrl+J      → 仍发 \n（claude 官方换行键，透传回归）
 *   P6 Alt+Enter   → 仍发 ESC+\r（xterm 自带；claude 解析 meta+return 为换行，
 *                     /terminal-setup 给 VSCode 配的就是这个序列）
 *   P7 Shift+Tab   → 仍发 ESC[Z（claude 权限模式切换键）
 *   P8 Ctrl+C 无选区 → 仍发 0x03（中断进程）
 *
 * 全程真实链路：CDP 真实按键 → DOM keydown → handleTermKey → xterm → IPC →
 * pty → node 记录器（raw stdin 逐 chunk 落盘）。
 *
 * 前置：npm run build:renderer（源码模式加载 dist/ 产物）
 * 用法：node scripts/terminal-enter-keys-e2e.cjs
 *       E2E_EXE="release/<版本>/win-unpacked/xxx.exe" node scripts/terminal-enter-keys-e2e.cjs
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-enter-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9349

const REC = path.join(SANDBOX, 'rec.js')
const LOG = path.join(SANDBOX, 'stdin.log')
const CLIP = path.join(SANDBOX, 'clip.txt')
const TEXT = 'ENTERKEYS-PASTE-1'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({
  projects: [{ id: 'proj-1', name: '回车键E2E', description: '', localPath: SANDBOX, status: 'active', tags: [] }],
}, null, 2))
fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
  version: 1, gridMode: 'auto', columnWidths: [1], rowHeights: [1],
  panes: [{ projectId: 'proj-1', shellId: '', title: '', width: 1 }], savedAt: Date.now(),
}, null, 2))

// stdin 记录器：raw 模式逐 chunk 落盘（每行 chunk#N <JSON>，断言按新增行取）
fs.writeFileSync(REC, `
const fs = require('fs')
const log = process.argv[2]
process.stdout.write('READY\\r\\n')
process.stdin.setRawMode(true)
process.stdin.resume()
let n = 0
process.stdin.on('data', (d) => {
  fs.appendFileSync(log, 'chunk#' + (++n) + ' ' + JSON.stringify(d.toString('utf8')) + '\\n')
})
`)
fs.writeFileSync(CLIP, TEXT, 'utf8')

function setClipboard(file) {
  execSync(`powershell -NoProfile -Command "Get-Content -LiteralPath '${file.replace(/'/g, "''")}' -Raw -Encoding UTF8 | Set-Clipboard"`, { stdio: 'ignore' })
}

function stdinLog() {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
}
/** 记录器是前台进程时 shell 不产生输入；字节游标取「自上次读取以来的新增输入」 */
let cursor = 0
function takeNew() {
  const s = stdinLog()
  const add = s.slice(cursor)
  cursor = s.length
  return add
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
      if (msg.error) slot.reject(new Error(`${msg.error.message}`))
      else slot.resolve(msg.result)
    })
    return client
  }
  send(method, params = {}) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) reject(new Error(`CDP 超时：${method}`)) }, 15000).unref?.()
    })
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description || ''}`)
    return res.result.value
  }
  close() { try { this.ws.close() } catch { /* noop */ } }
}

async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** CDP 修饰位（Chromium）：Alt=1 Ctrl=2 Meta=4 Shift=8 */
async function press(cdp, { key, code, vk, modifiers = 0 }) {
  const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}
const keyCtrlEnter = (cdp) => press(cdp, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 2 })
const keyShiftEnter = (cdp) => press(cdp, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 8 })
const keyEnter = (cdp) => press(cdp, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 0 })
const keyAltEnter = (cdp) => press(cdp, { key: 'Enter', code: 'Enter', vk: 13, modifiers: 1 })
const keyCtrlJ = (cdp) => press(cdp, { key: 'j', code: 'KeyJ', vk: 74, modifiers: 2 })
const keyShiftTab = (cdp) => press(cdp, { key: 'Tab', code: 'Tab', vk: 9, modifiers: 8 })
const keyCtrlC = (cdp) => press(cdp, { key: 'c', code: 'KeyC', vk: 67, modifiers: 2 })
const keyCtrlShiftV = (cdp) => press(cdp, { key: 'V', code: 'KeyV', vk: 86, modifiers: 10 })

const HELPERS = `
  window.__pane = () => document.querySelector('.terminal-grid .term-pane')
  window.__center = () => {
    const r = __pane().getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.6) }
  }
  window.__session = async () => {
    const res = await window.gitReport.terminalList().catch(() => null)
    return (res?.sessions || []).find((s) => !s.exited) || null
  }
  window.__attach = async (sid) => (await window.gitReport.terminalAttach(sid).catch(() => null))?.output || ''
  window.__probe = () => {
    const ta = document.querySelector('.term-pane .xterm-helper-textarea')
    if (ta && !ta.__probed) {
      ta.__probed = true
      ta.addEventListener('keydown', (e) => {
        window.__keys = window.__keys || []
        window.__keys.push({ code: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey })
      }, true)
    }
    return { hasTextarea: !!ta, active: document.activeElement?.className || document.activeElement?.tagName }
  }
`

async function windowWrite(cdp, sid, data) {
  await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(sid)}, ${JSON.stringify(data)})`)
}

async function waitOutput(cdp, sid, marker, timeout = 15000) {
  const start = Date.now()
  for (;;) {
    const out = await cdp.eval(`(async () => { ${HELPERS}; return await __attach('${sid}') })()`)
    if (out.includes(marker)) return
    if (Date.now() - start > timeout) throw new Error(`等待输出超时：${marker}`)
    await new Promise((r) => setTimeout(r, 400))
  }
}

async function startRecorder(cdp, sid) {
  fs.rmSync(LOG, { force: true })
  await windowWrite(cdp, sid, `node "${REC.replace(/\\/g, '/')}" "${LOG.replace(/\\/g, '/')}"\r`)
  await waitOutput(cdp, sid, 'READY')
}

/** 单键按下后收集新增 chunk */
async function pressAndCollect(cdp, keyFn, settle = 1200) {
  const before = takeNew()
  if (before) console.log(`  （按键前遗留输入：${JSON.stringify(before)}）`)
  await keyFn(cdp)
  await new Promise((r) => setTimeout(r, settle))
  return takeNew()
}

async function main() {
  const exe = process.env.E2E_EXE || ''
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '150000',
    SMOKE_CLICK_MS: '800',
    SMOKE_VIEW: '终端工作台',
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = exe
    ? spawn(exe, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })

  let cdp = null
  try {
    let wsUrl = null
    for (let i = 0; i < 60; i += 1) {
      if (child.exitCode !== null) throw new Error(`应用进程已退出（exit=${child.exitCode}）`)
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
        const page = (await res.json()).find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
        if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!wsUrl) throw new Error('等待调试端点超时')
    cdp = await Cdp.connect(wsUrl)
    await cdp.send('Runtime.enable')

    let ready = false
    for (let i = 0; i < 60; i += 1) {
      ready = await cdp.eval(`(() => { ${HELPERS}; return !!__pane() })()`)
      if (ready) break
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!ready) throw new Error('终端窗格未就绪')
    await new Promise((r) => setTimeout(r, 2500))
    const session = await cdp.eval(`(async () => { ${HELPERS}; return await __session() })()`)
    if (!session) throw new Error('没有活着的终端会话')
    const sid = session.id
    const center = await cdp.eval(`(() => { ${HELPERS}; return __center() })()`)
    await click(cdp, center.x, center.y)
    await new Promise((r) => setTimeout(r, 600))
    await startRecorder(cdp, sid)

    console.log(`\n[P1] Ctrl+Enter → LF 换行（claude 场景）`)
    const c1 = await pressAndCollect(cdp, keyCtrlEnter)
    check('pty 收到 \\n', /\\n/.test(c1), `chunks=${JSON.stringify(c1.trim())}`)
    check('本次按键未发 \\r（不会误提交）', !/\\r/.test(c1), `chunks=${JSON.stringify(c1.trim())}`)

    console.log(`\n[P2] Shift+Enter → LF 换行（对齐 Windows Terminal 习惯）`)
    const c2 = await pressAndCollect(cdp, keyShiftEnter)
    check('pty 收到 \\n', /\\n/.test(c2), `chunks=${JSON.stringify(c2.trim())}`)
    check('本次按键未发 \\r（不会误提交）', !/\\r/.test(c2), `chunks=${JSON.stringify(c2.trim())}`)

    console.log(`\n[P4] 裸 Enter → 仍发 CR（提交/执行不得改坏）`)
    const c4 = await pressAndCollect(cdp, keyEnter)
    check('pty 收到 \\r', /\\r/.test(c4), `chunks=${JSON.stringify(c4.trim())}`)
    check('未夹带 \\n', !/\\n/.test(c4), `chunks=${JSON.stringify(c4.trim())}`)

    console.log(`\n[P5] Ctrl+J（claude 官方换行键）→ 仍透传 LF`)
    const c5 = await pressAndCollect(cdp, keyCtrlJ)
    check('pty 收到 \\n', /\\n/.test(c5), `chunks=${JSON.stringify(c5.trim())}`)

    console.log(`\n[P6] Alt+Enter → 仍透传 ESC+CR（claude meta 换行，/terminal-setup 同款序列）`)
    const c6 = await pressAndCollect(cdp, keyAltEnter)
    check('pty 收到 \\u001b\\r', /\\u001b\\r/.test(c6), `chunks=${JSON.stringify(c6.trim())}`)

    console.log(`\n[P7] Shift+Tab → 仍透传 ESC[Z（claude 权限模式切换）`)
    const c7 = await pressAndCollect(cdp, keyShiftTab)
    check('pty 收到 \\u001b[Z', /\\u001b\[Z/.test(c7), `chunks=${JSON.stringify(c7.trim())}`)

    console.log(`\n[P3] Ctrl+Shift+V → 粘贴（对齐 Windows Terminal）`)
    setClipboard(CLIP)
    const c3 = await pressAndCollect(cdp, keyCtrlShiftV)
    check(`pty 收到文本 ${TEXT}（恰好一份）`, (c3.match(new RegExp(TEXT, 'g')) || []).length === 1, `chunks=${JSON.stringify(c3.trim())}`)
    check('没有把按键误发为 0x16', !c3.includes('\\u0016'), `chunks=${JSON.stringify(c3.trim())}`)

    console.log(`\n[P8] Ctrl+C 无选区 → 仍发 ^C（中断进程，并结束记录器）`)
    const c8 = await pressAndCollect(cdp, keyCtrlC)
    check('pty 收到 \\u0003', /\\u0003/.test(c8), `chunks=${JSON.stringify(c8.trim())}`)

    console.log(`\n终端组合回车键 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  } catch (err) {
    console.error('\n终端组合回车键 E2E 异常：', (err && err.stack) || err)
    console.error('应用日志尾部：\n' + String(log).split('\n').slice(-20).join('\n'))
    failed += 1
  } finally {
    cdp?.close()
    try { child.kill() } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 1500))
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main().then(() => {
  if (process.exitCode === 0) {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  } else {
    console.log(`沙箱：${SANDBOX}`)
  }
})
