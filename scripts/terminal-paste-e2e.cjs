/**
 * E2E（真实 Electron + CDP 注入真实键盘 + OS 剪贴板）：终端工作台的粘贴功能
 *
 * 背景：应用移除菜单栏后（Menu.setApplicationMenu(null)），Electron/Windows 下浏览器
 * 不再派发原生 paste 事件，xterm 会把 Ctrl+V 翻成 0x16 发给 pty —— 粘贴毫无反应
 * （用户报告：终端里跑 kimi --auto 后无法粘贴；实为所有场景粘贴均失效）。
 * 修复：TerminalPane 拦截 Ctrl+V / Shift+Insert，读系统剪贴板喂 term.paste
 * （与原生 paste 同链路，尊重 bracketed paste mode）。
 *
 * 验收标准（源自「终端要能粘贴」，非按实现反推）：
 *   P1 无 2004（普通程序）：Ctrl+V 单行 → pty 收到该文本，且不收 0x16
 *   P2 2004 模式（模拟 kimi/Ink TUI 请求 bracketed paste）：Ctrl+V 多行（含中文）
 *      → pty 收到 \x1b[200~ + 文本（\r\n 归一 \r）+ \x1b[201~
 *   P3 Shift+Insert 同样粘贴（Windows Terminal 习惯键）
 *   P4 空剪贴板时 Ctrl+V 不向 pty 发任何字节（不误发 0x16）
 *
 * 全程真实链路：OS 剪贴板（powershell Set-Clipboard）→ CDP 真实 Ctrl+V 按键 →
 * xterm → IPC → pty → node 记录器（raw stdin 逐字节落盘）。
 *
 * 前置：npm run build:renderer（源码模式加载 dist/ 产物）
 * 用法：node scripts/terminal-paste-e2e.cjs
 *       E2E_EXE="release/<版本>/win-unpacked/开发项目管理.exe" node scripts/terminal-paste-e2e.cjs
 *
 * 副作用说明：会写系统剪贴板，结束时尽力恢复原先文本。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-paste-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9347

const REC = path.join(SANDBOX, 'rec.js')
const LOG = path.join(SANDBOX, 'stdin.log')
const CLIP1 = path.join(SANDBOX, 'clip1.txt')
const CLIP2 = path.join(SANDBOX, 'clip2.txt')

const TEXT1 = 'PASTE-L1-abc123'
const TEXT2 = 'PASTE-M1\r\nPASTE-M2-行2'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({
  projects: [{ id: 'proj-1', name: '粘贴E2E', description: '', localPath: SANDBOX, status: 'active', tags: [] }],
}, null, 2))
fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
  version: 1, gridMode: 'auto', columnWidths: [1], rowHeights: [1],
  panes: [{ projectId: 'proj-1', shellId: '', title: '', width: 1 }], savedAt: Date.now(),
}, null, 2))

// stdin 记录器：raw 模式逐 chunk 落盘（回显只是便于排障，断言以落盘文件为准）
fs.writeFileSync(REC, `
const fs = require('fs')
const log = process.argv[2]
const mode = process.argv[3] || ''
if (mode === '2004') process.stdout.write('\\x1b[?2004h')
process.stdout.write('READY<' + mode + '>\\r\\n')
process.stdin.setRawMode(true)
process.stdin.resume()
let n = 0
process.stdin.on('data', (d) => {
  fs.appendFileSync(log, 'chunk#' + (++n) + ' ' + JSON.stringify(d.toString('utf8')) + '\\n')
  if (d.includes('\\x03')) process.exit(0)
})
`)
fs.writeFileSync(CLIP1, TEXT1, 'utf8')
fs.writeFileSync(CLIP2, TEXT2, 'utf8')

function setClipboard(file) {
  execSync(`powershell -NoProfile -Command "Get-Content -LiteralPath '${file.replace(/'/g, "''")}' -Raw -Encoding UTF8 | Set-Clipboard"`, { stdio: 'ignore' })
}
function setClipboardText(text) {
  const tmp = path.join(SANDBOX, 'clip-tmp.txt')
  fs.writeFileSync(tmp, text, 'utf8')
  setClipboard(tmp)
}
function getClipboard() {
  try {
    return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { return null }
}

function stdinLog() {
  return fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
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

/** 组合键（Ctrl=2 / Shift=8）：按 code 派发原始 keyDown/keyUp，不带 text */
async function pressCombo(cdp, { key, code, vk, modifiers }) {
  const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

const ctrlV = (cdp) => pressCombo(cdp, { key: 'v', code: 'KeyV', vk: 86, modifiers: 2 })
const shiftInsert = (cdp) => pressCombo(cdp, { key: 'Insert', code: 'Insert', vk: 45, modifiers: 8 })

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
  window.__setupProbe = () => {
    window.__keys = []
    window.__pastes = []
    const ta = document.querySelector('.term-pane .xterm-helper-textarea')
    if (ta && !ta.__probed) {
      ta.__probed = true
      ta.addEventListener('keydown', (e) => {
        window.__keys.push({ code: e.code, key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey, defaultPrevented: e.defaultPrevented })
      }, true)
      ta.addEventListener('paste', (e) => {
        const text = e.clipboardData?.getData ? e.clipboardData.getData('text/plain') : null
        window.__pastes.push({ len: text == null ? -1 : text.length, defaultPrevented: e.defaultPrevented })
      }, true)
    }
    return { probed: !!ta }
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

/** 启动记录器（经真实 pty 链路敲命令），等 READY 出现 */
async function startRecorder(cdp, sid, mode) {
  fs.rmSync(LOG, { force: true })
  await windowWrite(cdp, sid, `node "${REC.replace(/\\/g, '/')}" "${LOG.replace(/\\/g, '/')}"${mode ? ` ${mode}` : ''}\r`)
  await waitOutput(cdp, sid, `READY<${mode || ''}>`)
}

async function main() {
  const exe = process.env.E2E_EXE || ''
  const savedClip = getClipboard()
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
    await cdp.eval(`(() => { ${HELPERS}; return __setupProbe() })()`)
    const center = await cdp.eval(`(() => { ${HELPERS}; return __center() })()`)
    await click(cdp, center.x, center.y)
    await new Promise((r) => setTimeout(r, 600))

    console.log(`\n[P1] 无 2004 · Ctrl+V 粘贴单行（期望 pty 只收到文本，无 0x16）`)
    await startRecorder(cdp, sid, '')
    setClipboard(CLIP1)
    await ctrlV(cdp)
    await new Promise((r) => setTimeout(r, 1500))
    const l1 = stdinLog()
    check('pty 收到粘贴文本（恰好一份）', (l1.match(new RegExp(JSON.stringify(TEXT1), 'g')) || []).length === 1, `stdin=${JSON.stringify(l1.trim())}`)
    check('没有把 Ctrl+V 误发为 0x16', !l1.includes('\\u0016'), `stdin=${JSON.stringify(l1.trim())}`)
    check('没有触发浏览器原生 paste（无双发）', (await cdp.eval(`window.__pastes.length`)) === 0, `pastes=${JSON.stringify(await cdp.eval('window.__pastes'))}`)

    console.log(`\n[P2] 2004 模式（模拟 kimi TUI）· Ctrl+V 粘贴多行含中文`)
    await windowWrite(cdp, sid, '\x03')
    await new Promise((r) => setTimeout(r, 800))
    await startRecorder(cdp, sid, '2004')
    setClipboard(CLIP2)
    await cdp.eval(`window.__pastes.length = 0; window.__keys.length = 0`)
    await ctrlV(cdp)
    await new Promise((r) => setTimeout(r, 1500))
    const l2 = stdinLog()
    const expected2 = JSON.stringify('\x1b[200~' + TEXT2.replace(/\r\n/g, '\r') + '\x1b[201~')
    check('pty 收到 bracketed 包裹的完整文本（\\r\\n 归一为 \\r，恰好一份）', (l2.match(new RegExp(expected2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 1, `stdin=${JSON.stringify(l2.trim())}`)
    check('没有触发浏览器原生 paste（无双发）', (await cdp.eval(`window.__pastes.length`)) === 0, `pastes=${JSON.stringify(await cdp.eval('window.__pastes'))}`)

    console.log(`\n[P3] Shift+Insert 粘贴（Windows Terminal 习惯键）`)
    await cdp.eval(`window.__pastes.length = 0; window.__keys.length = 0`)
    setClipboard(CLIP1)
    await shiftInsert(cdp)
    await new Promise((r) => setTimeout(r, 1500))
    const l3 = stdinLog()
    // stdin.log 每行是 JSON.stringify 后的 chunk；裸文本计数（TEXT1 无正则元字符）
    check('pty 收到粘贴文本（恰好一份）', (l3.match(new RegExp(TEXT1, 'g')) || []).length === 1, `stdin tail=${JSON.stringify(l3.trim().split('\n').slice(-3))}`)
    check('没有触发浏览器原生 paste（无双发）', (await cdp.eval(`window.__pastes.length`)) === 0, `pastes=${JSON.stringify(await cdp.eval('window.__pastes'))} keys=${JSON.stringify(await cdp.eval('window.__keys'))}`)

    console.log(`\n[P4] 空剪贴板时 Ctrl+V 不发任何字节`)
    await windowWrite(cdp, sid, '\x03')
    await new Promise((r) => setTimeout(r, 800))
    await startRecorder(cdp, sid, '2004')
    await cdp.eval(`window.__pastes.length = 0`)
    setClipboardText('')
    await ctrlV(cdp)
    await new Promise((r) => setTimeout(r, 1500))
    const l4 = stdinLog().trim()
    check('pty 未收到任何字节（含 0x16、空 bracketed 包裹）', l4 === '', `stdin=${JSON.stringify(l4)}`)

    await windowWrite(cdp, sid, '\x03')
    console.log(`\n终端粘贴 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  } catch (err) {
    console.error('\n终端粘贴 E2E 异常：', (err && err.stack) || err)
    console.error('应用日志尾部：\n' + String(log).split('\n').slice(-20).join('\n'))
    failed += 1
  } finally {
    cdp?.close()
    try { child.kill() } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 1500))
    if (savedClip != null) {
      try {
        const tmp = path.join(SANDBOX, 'restore.txt')
        fs.writeFileSync(tmp, savedClip, 'utf8')
        execSync(`powershell -NoProfile -Command "Get-Content -LiteralPath '${tmp.replace(/'/g, "''")}' -Raw -Encoding UTF8 | Set-Clipboard"`, { stdio: 'ignore' })
      } catch { /* 尽力而为 */ }
    }
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
