/**
 * E2E（真实 Electron + CDP 注入真实鼠标/键盘）：终端工作台的复制功能
 *
 * 背景：xterm.js 不内置剪贴板行为，宿主要自己把选区写进系统剪贴板。
 * 修复前选中文字按 Ctrl+C 会被原样当 ^C 发给 PowerShell，剪贴板不变，
 * 还会顺带中断正在跑的命令。这里用真实输入事件走完整链路：
 *   鼠标拖选 → xterm 选区 → Ctrl+C → 自定义键处理 → IPC → 主进程 clipboard
 *
 * 验收标准（源自「终端工作台的 PowerShell 能复制内容」，非按实现反推）：
 *   C1 鼠标拖选终端输出能建立 xterm 选区（选区层出现可见矩形）
 *   C2 有选区时按 Ctrl+C：OS 剪贴板内容 === 选中文本（Get-Clipboard 外部断言），
 *      且不向 pty 发 ^C（sleep 不被打断、prompt 不提前回来）
 *   C3 Ctrl+Insert 同样能把选区写进 OS 剪贴板
 *   C4 无选区时 Ctrl+C 仍发 ^C 中断前台命令（中断语义不回归），剪贴板不被改写
 *
 * 前置：npm run build:renderer（electron . 加载 dist/ 产物）
 * 用法：node scripts/terminal-copy-e2e.cjs
 *       E2E_EXE="release/<版本>/win-unpacked/Personnel PLM.exe" node scripts/terminal-copy-e2e.cjs
 *
 * 副作用说明：会写系统剪贴板，结束时尽力恢复原先文本（非文本格式无法恢复）。
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-copy-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9341
const MARKER = 'E2ECOPY7hQm49zx'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = [{ id: 'proj-1', name: '复制自测', description: '', localPath: path.join(ROOT, 'scripts'), status: 'active', tags: [] }]

fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))
fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
  version: 1,
  gridMode: 'auto',
  columnWidths: [1],
  rowHeights: [1],
  panes: [{ projectId: 'proj-1', shellId: '', title: '', width: 1 }],
  savedAt: Date.now(),
}, null, 2))

// ─── CDP 极简客户端（Node 24 自带 WebSocket） ───
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
      if (msg.error) slot.reject(new Error(`${msg.error.message}（${JSON.stringify(msg.error.data || '')}）`))
      else slot.resolve(msg.result)
    })
    return client
  }

  send(method, params = {}) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) reject(new Error(`CDP 超时：${method}`))
      }, 15000).unref?.()
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description || ''}`)
    return res.result.value
  }

  close() { try { this.ws.close() } catch { /* noop */ } }
}

// ─── 真实输入 ───
async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function drag(cdp, from, to, steps = 8) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i += 1) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await new Promise((r) => setTimeout(r, 25))
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
}

function keyInfo(ch) {
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, text: ' ' }
  if (ch >= 'a' && ch <= 'z') return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch }
  if (ch >= 'A' && ch <= 'Z') return { key: ch, code: `Key${ch}`, vk: ch.charCodeAt(0), text: ch }
  if (ch >= '0' && ch <= '9') return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch }
  throw new Error(`未支持的字符：${ch}`)
}

async function typeText(cdp, text) {
  for (const ch of text) {
    const k = keyInfo(ch)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k.key, code: k.code,
      windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text, unmodifiedText: k.text,
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    })
  }
}

async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    text: '\r', unmodifiedText: '\r',
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
}

/** 组合键（Ctrl=2）：按 code 派发原始 keyDown/keyUp，不带 text */
async function pressCombo(cdp, { key, code, vk, modifiers }) {
  const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

// ─── OS 剪贴板（外部断言，不信任页面内 API） ───
function getClipboard() {
  try {
    return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

function restoreClipboard(text) {
  if (text == null) return
  try {
    const tmp = path.join(SANDBOX, 'clip-restore.txt')
    fs.writeFileSync(tmp, text, 'utf8')
    execSync(`powershell -NoProfile -Command "Get-Content -LiteralPath '${tmp.replace(/'/g, "''")}' -Raw | Set-Clipboard"`, { stdio: 'ignore' })
  } catch { /* 恢复尽力而为 */ }
}

// ─── 启动与连接 ───
const EXE = process.env.E2E_EXE || ''

function startApp(port = PORT) {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '90000',
    SMOKE_CLICK_MS: '800',
    SMOKE_VIEW: '终端工作台',
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = EXE
    ? spawn(EXE, [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${port}`], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  return { child, log: () => log }
}

async function stopApp(app, port) {
  try { app.child.kill() } catch { /* 已退出 */ }
  await new Promise((resolve) => {
    if (app.child.exitCode !== null || app.child.signalCode) return resolve()
    app.child.on('exit', resolve)
    setTimeout(resolve, 10000).unref?.()
  })
  for (let i = 0; i < 40; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`)
      await new Promise((r) => setTimeout(r, 250))
    } catch { break }
  }
}

async function waitForPage(port = PORT, child = null) {
  for (let i = 0; i < 60; i += 1) {
    if (child && child.exitCode !== null) {
      throw new Error(`应用进程已退出（exit=${child.exitCode}）：多半是上一个实例还占着单实例锁`)
    }
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

async function waitFor(cdp, expression, label, timeout = 40000) {
  const start = Date.now()
  for (;;) {
    const value = await cdp.eval(expression)
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

const HELPERS = `
  window.__pane = () => document.querySelector('.terminal-grid .term-pane')
  window.__paneCenter = () => {
    const r = __pane().getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.65) }
  }
  /** 输出行里 marker 的像素范围：输入回显行的同文本 span 在上方，取最后一个匹配 */
  window.__markerRect = (m) => {
    const spans = [...document.querySelectorAll('.term-pane .xterm-rows span')]
      .filter((s) => s.textContent && s.textContent.trim() === m)
    const r = spans[spans.length - 1]?.getBoundingClientRect()
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
  }
  window.__selectionRects = () => [...document.querySelectorAll('.term-pane .xterm-selection div')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length
  window.__session = async () => {
    const res = await window.gitReport.terminalList().catch(() => null)
    return (res?.sessions || []).find((s) => !s.exited) || null
  }
  window.__attach = async (sid) => (await window.gitReport.terminalAttach(sid).catch(() => null))?.output || ''
`

const countPrompts = (out) => (String(out).match(/PS [^\r\n>]*>/g) || []).length

async function main() {
  const savedClip = getClipboard()
  const app = startApp()
  let cdp = null
  try {
    const wsUrl = await waitForPage()
    cdp = await Cdp.connect(wsUrl)
    await cdp.send('Runtime.enable')
    await cdp.eval(`(() => {
      window.__e2eErrors = window.__e2eErrors || []
      if (!window.__e2eErrors.__bound) {
        window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message || e)))
        window.__e2eErrors.__bound = true
      }
      return true
    })()`)
    await waitFor(cdp, `(() => { ${HELPERS}; return !!__pane() })()`, '终端窗格就绪')
    await new Promise((r) => setTimeout(r, 2500)) // 等会话与首屏 prompt 稳定

    // 点击聚焦，输入 marker 并回车执行
    const center = await cdp.eval(`(() => { ${HELPERS}; return __paneCenter() })()`)
    await click(cdp, center.x, center.y)
    await new Promise((r) => setTimeout(r, 600))
    await typeText(cdp, `echo ${MARKER}`)
    await pressEnter(cdp)
    await waitFor(cdp, `(() => { ${HELPERS}; return !!__markerRect('${MARKER}') })()`, '回显行渲染出 marker')

    // 起 sleep 20：后面用它同时验证「复制不误发 ^C」与「无选区时 ^C 照常中断」
    await typeText(cdp, 'sleep 20')
    await pressEnter(cdp)
    await new Promise((r) => setTimeout(r, 1500))

    const session = await cdp.eval(`(async () => { ${HELPERS}; return await __session() })()`)
    if (!session) throw new Error('没有活着的终端会话')
    const beforeOut = await cdp.eval(`(async () => { ${HELPERS}; return await __attach('${session.id}') })()`)
    const promptsBefore = countPrompts(beforeOut)

    console.log('\n[C1] 鼠标拖选终端输出建立选区')
    const rect = await cdp.eval(`(() => { ${HELPERS}; return __markerRect('${MARKER}') })()`)
    await drag(cdp, { x: Math.round(rect.x + 2), y: Math.round(rect.y + rect.h / 2) },
      { x: Math.round(rect.x + rect.w - 2), y: Math.round(rect.y + rect.h / 2) })
    await new Promise((r) => setTimeout(r, 400))
    const selCount = await cdp.eval(`(() => { ${HELPERS}; return __selectionRects() })()`)
    check('拖选后选区层出现可见矩形', selCount > 0, `选区矩形 ${selCount} 个`)
    // 跨行选区会画多个矩形，其文本带换行——在这里就把拖选抖动暴露出来
    check('选区恰好覆盖单行（未拖串到相邻行）', selCount === 1, `选区矩形 ${selCount} 个`)

    console.log('\n[C2] 有选区时 Ctrl+C：写 OS 剪贴板，且不向 pty 发 ^C')
    getClipboard() // 预热：丢弃这次读取
    execSync('powershell -NoProfile -Command "Set-Clipboard \'__e2e_clean__\'"', { stdio: 'ignore' })
    await pressCombo(cdp, { key: 'c', code: 'KeyC', vk: 67, modifiers: 2 })
    await new Promise((r) => setTimeout(r, 800))
    const clipAfterCopy = getClipboard()
    const copied = (clipAfterCopy || '').replace(/\s+/g, '')
    check('OS 剪贴板（Get-Clipboard）内容 === 选中文本', copied === MARKER,
      `实际「${(clipAfterCopy || '').trim()}」`)
    // ^C 不该发出：sleep 没被打断，prompt 不会提前回来（sleep 20 远未结束）
    const duringSleep = await cdp.eval(`(async () => { ${HELPERS}; return await __attach('${session.id}') })()`)
    check('复制没有中断前台命令（未误发 ^C）', countPrompts(duringSleep) === promptsBefore,
      `prompt 数 ${promptsBefore} → ${countPrompts(duringSleep)}`)

    console.log('\n[C3] Ctrl+Insert 同样复制')
    await click(cdp, center.x, center.y) // 清掉选区
    await new Promise((r) => setTimeout(r, 600)) // 等渲染稳定后再取行位置，避免拿到重绘中的过期 rect
    const rect2 = await cdp.eval(`(() => { ${HELPERS}; return __markerRect('${MARKER}') })()`)
    await drag(cdp, { x: Math.round(rect2.x + 2), y: Math.round(rect2.y + rect2.h / 2) },
      { x: Math.round(rect2.x + rect2.w - 2), y: Math.round(rect2.y + rect2.h / 2) })
    await new Promise((r) => setTimeout(r, 400))
    const selRects2 = await cdp.eval(`(() => { ${HELPERS}; return __selectionRects() })()`)
    check('第二次拖选仍恰好覆盖单行', selRects2 === 1, `选区矩形 ${selRects2} 个`)
    execSync('powershell -NoProfile -Command "Set-Clipboard \'__e2e_clean2__\'"', { stdio: 'ignore' })
    await pressCombo(cdp, { key: 'Insert', code: 'Insert', vk: 45, modifiers: 2 })
    await new Promise((r) => setTimeout(r, 800))
    const clipInsert = getClipboard()
    check('Ctrl+Insert 后 OS 剪贴板 === 选中文本', (clipInsert || '').replace(/\s+/g, '') === MARKER,
      `实际「${(clipInsert || '').trim()}」`)

    console.log('\n[C4] 无选区时 Ctrl+C 仍发 ^C 中断前台命令，剪贴板不被改写')
    await click(cdp, center.x, center.y) // 单击清除选区
    await new Promise((r) => setTimeout(r, 400))
    const noSel = await cdp.eval(`(() => { ${HELPERS}; return __selectionRects() })()`)
    check('单击后选区已清除', noSel === 0, `选区矩形 ${noSel} 个`)
    await pressCombo(cdp, { key: 'c', code: 'KeyC', vk: 67, modifiers: 2 })
    await new Promise((r) => setTimeout(r, 2500))
    const afterInt = await cdp.eval(`(async () => { ${HELPERS}; return await __attach('${session.id}') })()`)
    check('^C 中断了 sleep（prompt 回来了）', countPrompts(afterInt) > promptsBefore,
      `prompt 数 ${promptsBefore} → ${countPrompts(afterInt)}`)
    const clipFinal = getClipboard()
    check('无选区的 Ctrl+C 没有改写剪贴板', (clipFinal || '').replace(/\s+/g, '') === MARKER,
      `实际「${(clipFinal || '').trim()}」`)

    const errors = await cdp.eval(`window.__e2eErrors || []`)
    check('全程无渲染层错误', (errors || []).length === 0, JSON.stringify(errors || []))

    console.log(`\n终端复制 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  } catch (err) {
    console.error('\n终端复制 E2E 异常：', (err && err.stack) || err)
    console.error('应用日志尾部：')
    console.error(String(app.log()).split('\n').slice(-25).join('\n'))
    failed += 1
  } finally {
    cdp?.close()
    await stopApp(app, PORT)
    restoreClipboard(savedClip)
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
