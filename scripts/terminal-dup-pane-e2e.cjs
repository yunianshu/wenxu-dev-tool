/**
 * E2E（真实 Electron + CDP 真实鼠标键盘）：同一个项目重复添加窗格
 *
 * 需求：一个项目可以开多个窗格（例如一个跑 dev server、一个敲 git），
 * 每个窗格必须是**独立的 pty 会话**，输入与输出互不串。
 *
 * 这条链路的实现前提是「窗格 ↔ 会话」按窗格标识（paneId）归属：
 * 早先渲染层按「项目 + 目录」认领会话，第二个同项目窗格会 attach 到第一个的 pty，
 * 所以当时干脆禁止了重复添加——本脚本正是验证这道禁令已经拆掉、且拆得安全。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   D1 「添加窗格」下拉里能看到已经在用的项目（旧版会把它从菜单里过滤掉）
 *   D2 再点同一个项目 → 真的多出一个同名窗格（不是复用/静默失败）
 *   D3 两个同项目窗格 = 两个独立 pty（不同 sessionId 与 pid），cwd 同为项目目录
 *   D4 键盘输入只进被点窗格的会话：只有它回显，另一个窗格的画面与缓冲都没有
 *   D5 切页再切回：两个窗格各自认回自己的会话（会话 id/pid 不变，画面各回各的）
 *   D6 布局文件里两个同项目窗格各带一个不同的 paneId
 *   D7 重启应用后仍恢复两个同项目窗格，且是两条全新会话（pty 不跨重启）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/terminal-dup-pane-e2e.cjs
 *       E2E_EXE="release/<版本>/win-unpacked/Personnel PLM.exe" node scripts/terminal-dup-pane-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-dup-pane-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const LAYOUT_FILE = path.join(USER_DATA, 'terminal-layout.json')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9344

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const MARKER = 'dupmarkerok'

const PROJECTS = ['src', 'electron'].map((dir, index) => ({
  id: `proj-${index + 1}`,
  name: `自测项目 ${index + 1}`,
  description: '',
  localPath: path.join(ROOT, dir),
  status: 'active',
  tags: [],
}))
const DUP_PROJECT_ID = PROJECTS[0].id
const DUP_PROJECT_NAME = PROJECTS[0].name

fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))
// 起始布局：只有一个窗格（不带 paneId，模拟升级前的旧布局——恢复时要能补发新 id 并正常开会话）
fs.writeFileSync(LAYOUT_FILE, JSON.stringify({
  version: 1,
  gridMode: 'auto',
  columnWidths: [1],
  rowHeights: [1],
  panes: [{ projectId: DUP_PROJECT_ID, shellId: '', title: '', width: 0.5 }],
  savedAt: Date.now(),
}, null, 2))

const readLayout = () => JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8'))

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

  /** 在页面里求值（自动 await Promise，按值返回） */
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

/** 字符 → CDP 键描述（只用小写字母/数字/空格，避开修饰键） */
function keyInfo(ch) {
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, text: ' ' }
  if (ch >= 'a' && ch <= 'z') return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch }
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

// ─── 启动与连接 ───
const EXE = process.env.E2E_EXE || ''

function startApp(port = PORT) {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '240000',
    SMOKE_VIEW: '终端工作台',
    SMOKE_CLICK_MS: '800',
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

/** 停掉一个实例并等它真正退出：应用带单实例锁，上一个没退干净时下一个会直接退出 */
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
    } catch { break }   // 端口不再响应：实例已彻底退出
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
  window.__panes = () => [...document.querySelectorAll('.terminal-grid .term-pane')]
  window.__title = (p) => p.querySelector('.term-pane-title strong')?.textContent || ''
  /** 窗格画面上的可见文字（xterm DOM 渲染层） */
  window.__screen = (p) => p.querySelector('.xterm-rows')?.textContent || ''
  window.__hitPoint = (p) => {
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.65) }
  }
  window.__sessions = async () => {
    const res = await window.gitReport.terminalList().catch(() => null)
    return (res?.sessions || []).map((s) => ({
      id: s.id, paneId: s.paneId, projectId: s.projectId, pid: s.pid, cwd: s.cwd, exited: s.exited,
    }))
  }
  window.__outputs = async () => {
    const list = await window.__sessions()
    const out = {}
    for (const s of list) {
      const res = await window.gitReport.terminalAttach(s.id).catch(() => null)
      out[s.id] = res?.output || ''
    }
    return out
  }
  window.__goto = (label) => {
    const m = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.trim() === label)
    if (m) m.click()
    return !!m
  }
  /** 真实点击顶栏「添加窗格」，返回菜单项文字 */
  window.__openAddMenuPoint = () => {
    const btn = document.querySelector('#app-topbar-slot .terminal-toolbar .el-button')
    if (!btn) return null
    const r = btn.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: !!btn.disabled }
  }
  window.__menuItems = () => [...document.querySelectorAll('.el-dropdown-menu__item')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
    .map((el) => {
      const r = el.getBoundingClientRect()
      return { text: el.textContent.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })
`

/** 打开「添加窗格」下拉并返回菜单项（真实点击） */
async function openAddMenu(cdp) {
  const btn = await cdp.eval(`(() => { ${HELPERS}; return __openAddMenuPoint() })()`)
  if (!btn) throw new Error('未找到顶栏「添加窗格」按钮')
  await click(cdp, btn.x, btn.y)
  await new Promise((r) => setTimeout(r, 900))
  return cdp.eval(`(() => { ${HELPERS}; return __menuItems() })()`)
}

async function main() {
  const app = startApp()
  let cdp = null
  let idsAfterSwitch = []
  let pidsBefore = []
  try {
    cdp = await Cdp.connect(await waitForPage(PORT, app.child))
    await cdp.send('Runtime.enable')
    await cdp.eval(`(() => {
      window.__e2eErrors = window.__e2eErrors || []
      if (!window.__e2eErrors.__bound) {
        window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message || e)))
        window.__e2eErrors.__bound = true
      }
      return true
    })()`)

    // 起始：布局里的单窗格恢复出来，且已有一条自己的会话
    await waitFor(cdp, `(() => { ${HELPERS}; return __panes().length === 1 && !!document.querySelector('.terminal-grid .xterm') })()`, '单窗格恢复')
    await waitFor(cdp, `(async () => { ${HELPERS}; return (await __sessions()).length === 1 })()`, '首个会话就绪')
    await new Promise((r) => setTimeout(r, 1500))

    console.log('\n[D1] 「添加窗格」下拉能看到已经在用的项目')
    const menu = await openAddMenu(cdp)
    const dupItem = menu.find((m) => m.text.includes(DUP_PROJECT_NAME))
    check('下拉里列出已在用的项目（旧版会把它过滤掉）', !!dupItem,
      `菜单：${menu.map((m) => m.text).join(' / ') || '（空）'}`)
    check('该菜单项标出已开窗格数（看得出能再加一个）', !!dupItem && /已开\s*1/.test(dupItem.text),
      dupItem ? dupItem.text : '')

    console.log('\n[D2] 再点同一个项目 → 真的多出一个同名窗格')
    if (!dupItem) throw new Error('菜单里没有目标项目，后续断言无法继续')
    await click(cdp, dupItem.x, dupItem.y)
    await waitFor(cdp, `(() => { ${HELPERS}; return __panes().length === 2 })()`, '出现第二个窗格')
    const titles = await cdp.eval(`(() => { ${HELPERS}; return __panes().map(__title) })()`)
    check('两个窗格绑定同一个项目', titles.length === 2 && titles[0] === DUP_PROJECT_NAME && titles[1] === DUP_PROJECT_NAME,
      JSON.stringify(titles))

    console.log('\n[D3] 两个同项目窗格 = 两个独立 pty 会话')
    const sessions = await waitFor(cdp, `(async () => {
      ${HELPERS}
      const list = await __sessions()
      return list.length === 2 && list.every((s) => !s.exited) ? list : null
    })()`, '两个会话都活着')
    check('两个窗格各自一条会话', sessions.length === 2, sessions.map((s) => s.id).join(' / '))
    check('会话 id 与 pid 都不同（不是同一个 pty）',
      sessions[0].id !== sessions[1].id && sessions[0].pid !== sessions[1].pid,
      `${sessions[0].id}(pid=${sessions[0].pid}) / ${sessions[1].id}(pid=${sessions[1].pid})`)
    check('两条会话都绑同一项目目录', sessions.every((s) => s.projectId === DUP_PROJECT_ID && s.cwd === PROJECTS[0].localPath),
      sessions.map((s) => `${s.projectId}@${s.cwd}`).join(' / '))
    check('两条会话各带一个不同的窗格标识（会话归属靠它）',
      !!sessions[0].paneId && !!sessions[1].paneId && sessions[0].paneId !== sessions[1].paneId,
      sessions.map((s) => s.paneId).join(' / '))
    pidsBefore = sessions.map((s) => s.pid)

    console.log('\n[D4] 键盘输入只进被点窗格的会话')
    const point = await cdp.eval(`(() => { ${HELPERS}; return __hitPoint(__panes()[1]) })()`)
    await click(cdp, point.x, point.y)
    await new Promise((r) => setTimeout(r, 500))
    await typeText(cdp, `echo ${MARKER}`)
    await pressEnter(cdp)
    // 等回显落到画面上（真执行 → pty 回传 → xterm 渲染）
    const screens = await waitFor(cdp, `(() => {
      ${HELPERS}
      const panes = __panes()
      const s = panes.map(__screen)
      return s[1].includes('${MARKER}') ? s : null
    })()`, '被点窗格出现命令回显')
    check('被点窗格的画面上有回显', screens[1].includes(MARKER))
    check('另一个同项目窗格的画面没有被串入该命令', !screens[0].includes(MARKER),
      screens[0].includes(MARKER) ? '出现串屏' : '')
    await new Promise((r) => setTimeout(r, 1200))
    const outputs = await cdp.eval(`(async () => { ${HELPERS}; return await __outputs() })()`)
    const echoed = Object.entries(outputs).filter(([, out]) => String(out).includes(MARKER))
    check('两个会话缓冲里只有一条收到该输入（未广播）', echoed.length === 1,
      `${echoed.length} 条：${Object.entries(outputs).map(([id, o]) => `${id}:${String(o).includes(MARKER) ? '有' : '无'}`).join(' ')}`)
    check('收到输入的是后加窗格自己的会话（第一条会话缓冲干净）',
      String(outputs[sessions[1].id] || '').includes(MARKER) && !String(outputs[sessions[0].id] || '').includes(MARKER))

    console.log('\n[D5] 切页再切回：各窗格认回自己的会话（不会都挂到同一条）')
    await cdp.eval(`(() => { ${HELPERS}; return __goto('工作台') })()`)
    await waitFor(cdp, `(() => { ${HELPERS}; return __panes().length === 0 })()`, '终端视图已卸载')
    await cdp.eval(`(() => { ${HELPERS}; return __goto('终端工作台') })()`)
    await waitFor(cdp, `(() => { ${HELPERS}; return __panes().length === 2 })()`, '切回后两个窗格都恢复')
    await waitFor(cdp, `(() => { ${HELPERS}; const s = __panes().map(__screen); return s[1].includes('${MARKER}') })()`,
      '后加窗格的画面回放到位')
    const afterSwitch = await cdp.eval(`(async () => { ${HELPERS}; return await __sessions() })()`)
    idsAfterSwitch = afterSwitch.map((s) => s.id)
    check('切页前后是同两条会话（切页不重开会话）',
      idsAfterSwitch.length === 2
      && sessions.every((s) => idsAfterSwitch.includes(s.id))
      && afterSwitch.every((s) => pidsBefore.includes(s.pid)),
      `${idsAfterSwitch.join(' / ')}（pid ${afterSwitch.map((s) => s.pid).join(' / ')}）`)
    const screens2 = await cdp.eval(`(() => { ${HELPERS}; return __panes().map(__screen) })()`)
    check('两个窗格各回放自己的缓冲：只有后加窗格的画面带那句命令',
      screens2[1].includes(MARKER) && !screens2[0].includes(MARKER),
      screens2[0].includes(MARKER) ? '两个窗格画面相同（疑似共用会话）' : '')

    console.log('\n[D6] 布局文件保留两个同项目窗格与各自 paneId')
    await new Promise((r) => setTimeout(r, 800)) // 等 400ms 防抖落盘
    const layout = readLayout()
    check('布局里就是两个窗格', layout.panes.length === 2, `文件 ${layout.panes.length} 个`)
    check('两个窗格都绑定同一项目', layout.panes.every((p) => p.projectId === DUP_PROJECT_ID),
      layout.panes.map((p) => p.projectId).join(','))
    check('两个窗格各带一个不同的 paneId',
      layout.panes.every((p) => !!p.paneId) && layout.panes[0].paneId !== layout.panes[1].paneId,
      layout.panes.map((p) => p.paneId || '（空）').join(' / '))

    const errors = await cdp.eval(`window.__e2eErrors || []`)
    check('全程无渲染层错误', (errors || []).length === 0, JSON.stringify(errors || []))

    // 必须先退干净：应用带单实例锁，旧实例还活着时新实例会直接退出
    await stopApp(app, PORT)

    console.log('\n[D7] 重启后恢复两个同项目窗格（两条全新会话）')
    const second = startApp(PORT + 1)
    let cdp2 = null
    try {
      cdp2 = await Cdp.connect(await waitForPage(PORT + 1, second.child))
      await cdp2.send('Runtime.enable')
      await waitFor(cdp2, `(() => { ${HELPERS}; return __panes().length === 2 })()`, '重启后恢复出 2 个窗格')
      const restarted = await waitFor(cdp2, `(async () => {
        ${HELPERS}
        const list = await __sessions()
        return list.length === 2 && list.every((s) => !s.exited) ? list : null
      })()`, '重启后两条会话就绪')
      const titles2 = await cdp2.eval(`(() => { ${HELPERS}; return __panes().map(__title) })()`)
      check('两个窗格都是同一个项目', titles2.length === 2 && titles2.every((t) => t === DUP_PROJECT_NAME),
        JSON.stringify(titles2))
      check('两条会话是重启后新起的（pty 不跨应用重启）',
        restarted.every((s) => !pidsBefore.includes(s.pid)),
        `新 pid ${restarted.map((s) => s.pid).join(' / ')}，旧 pid ${pidsBefore.join(' / ')}`)
      check('两条会话仍是各自独立的 pty',
        restarted[0].pid !== restarted[1].pid && restarted[0].paneId !== restarted[1].paneId,
        `${restarted.map((s) => `${s.paneId}(pid=${s.pid})`).join(' / ')}`)
      const layout2 = readLayout()
      check('重启后布局仍是两个同项目窗格、各带 paneId',
        layout2.panes.length === 2
        && layout2.panes.every((p) => p.projectId === DUP_PROJECT_ID && !!p.paneId)
        && layout2.panes[0].paneId !== layout2.panes[1].paneId,
        layout2.panes.map((p) => `${p.projectId}/${p.paneId || '（空）'}`).join(' / '))
    } finally {
      cdp2?.close()
      await stopApp(second, PORT + 1)
    }

    console.log(`\n终端工作台同项目多窗格 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
    console.log(`沙箱：${SANDBOX}`)
  } catch (err) {
    console.error('\n终端工作台同项目多窗格 E2E 异常：', (err && err.stack) || err)
    console.error('应用日志尾部：')
    console.error(String(app.log()).split('\n').slice(-25).join('\n'))
    try { app.child.kill() } catch { /* noop */ }
    failed += 1
  } finally {
    cdp?.close()
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main().then(() => {
  // 失败时保留沙箱现场便于排查；成功时清理
  if (process.exitCode === 0) {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  }
})
