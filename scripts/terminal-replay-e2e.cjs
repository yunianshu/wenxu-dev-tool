/**
 * E2E（真实 Electron + 真实 ConPTY + 真实渲染层）：会话缓冲被截断后，切页回来的回放不能丢终端模式
 *
 * 为什么需要：TUI（Claude Code 等）启动时隐藏硬件光标（ESC[?25l）、自绘光标，并把硬件光标
 * 停在行末。长会话的输出超过会话缓冲上限后，开头那条隐藏序列被挤掉；切页回来时渲染层
 * reset 终端再回放缓冲，光标默认可见、回放里又没人隐藏它 —— 用户看到「光标跑到右下角」。
 *
 * 做法：在窗格里跑 terminal-replay-fixture.cjs --stay（隐藏光标 + 海量输出 + 光标停在右下角，
 * 保持前台），确认缓冲已截断，再切到别的页切回（触发 attach 回放），检查硬件光标元素。
 *
 * 验收标准（期望来自终端语义，不从被测实现反推）：
 *   E1 夹具输出超过缓冲上限，缓冲头部被丢弃（否则本用例测不到截断回放）
 *   E2 切页前：终端已获得焦点，硬件光标元素不存在（隐藏状态生效），夹具标记行在屏上
 *   E3 切回后：窗格重建，回放把标记行恢复出来（回放本身有效）
 *   E4 切回后：终端已获得焦点（xterm 只有拿到过焦点才渲染硬件光标，否则下一条断言无效）
 *   E5 切回后：硬件光标元素仍不存在（模式被补回 —— 修复前它出现在最后一行最右）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/terminal-replay-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-terminal-replay-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9373

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = [{
  id: 'proj-1', name: '终端回放自测', description: '', localPath: ROOT, status: 'active', tags: [],
}]
fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))
fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
  version: 1, gridMode: 'auto', columnWidths: [1], rowHeights: [1],
  panes: [{ projectId: 'proj-1', shellId: '', title: '', width: 0.5 }], savedAt: Date.now(),
}, null, 2))

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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }
      }, 30000).unref?.()
    })
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description || ''}`)
    return res.result.value
  }
  close() { try { this.ws.close() } catch { /* noop */ } }
}

async function waitForPage(child) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error(`应用进程已退出（exit=${child.exitCode}）：多半是上一个实例还占着单实例锁`)
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 端口还没起来 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等待渲染页调试端点超时')
}

async function waitFor(cdp, expression, label, timeout = 40000) {
  const start = Date.now()
  let loggedAt = 0
  for (;;) {
    const value = await cdp.eval(expression)
    if (value) return value
    if (process.env.E2E_DEBUG && Date.now() - loggedAt > 5000) {
      loggedAt = Date.now()
      console.log(`  等待「${label}」中：${JSON.stringify(value)}  已 ${Math.round((Date.now() - start) / 1000)}s`)
    }
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** 页内探针：硬件光标元素是否存在、落在第几行第几列，以及夹具标记行是否在屏上。
 *  focused：xterm 只有在拿到过焦点之后才渲染硬件光标（内部 isCursorInitialized），
 *  没焦点时「光标元素不存在」不代表隐藏，所以每条光标断言都以它为前提 */
const PROBE = `(() => {
  const pane = document.querySelector('.terminal-grid .term-pane')
  if (!pane) return { noPane: true }
  const rows = [...pane.querySelectorAll('.xterm-rows > div')]
  const texts = rows.map((r) => r.textContent.split(String.fromCharCode(0xa0)).join(' '))
  const parked = texts.some((t) => t.includes('REPLAY-PARKED'))
  const focused = !!pane.querySelector('.xterm.focus')
  const cursor = pane.querySelector('.xterm-rows .xterm-cursor')
  if (!cursor) return { cursor: null, parked, focused, rows: rows.length }
  const rowIndex = rows.indexOf(cursor.parentElement)
  const rowRect = cursor.parentElement.getBoundingClientRect()
  const col = Math.round((cursor.getBoundingClientRect().left - rowRect.left) / (cursor.getBoundingClientRect().width || 1))
  return { cursor: { row: rowIndex, col, rows: rows.length }, parked, focused, rows: rows.length }
})()`

/** 让窗格里的终端拿到焦点（xterm 监听的是 textarea 的 focus 事件） */
const FOCUS_PANE = `(() => {
  const el = document.querySelector('.terminal-grid .term-pane .xterm-helper-textarea')
  if (!el) return false
  el.focus()
  return true
})()`

const SID_EXPR = `(async () => {
  const res = await window.gitReport.terminalList().catch(() => null)
  const hit = (res?.sessions || []).find((s) => !s.exited)
  return hit ? hit.id : ''
})()`

async function gotoView(cdp, label) {
  const ok = await cdp.eval(`(() => { const t = [...document.querySelectorAll('.el-menu-item')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (t) t.click(); return !!t })()`)
  if (!ok) throw new Error(`侧栏找不到「${label}」`)
}

/** 失败时辅助定位：屏幕最上几行 / 最下几行的文本与硬件光标元素 */
async function dumpScreen(cdp) {
  try {
    const dump = await cdp.eval(`(() => {
      const pane = document.querySelector('.terminal-grid .term-pane')
      if (!pane) return { noPane: true }
      const rows = [...pane.querySelectorAll('.xterm-rows > div')].map((r, i) => ({ i, t: r.textContent.split(String.fromCharCode(0xa0)).join(' ').trim() }))
      const shown = rows.filter((r) => r.t)
      return { total: rows.length, shown: shown.slice(0, 6).concat(shown.length > 10 ? [{ i: '…', t: '' }] : [], shown.slice(-4)), cursor: !!pane.querySelector('.xterm-rows .xterm-cursor') }
    })()`)
    console.log(`  屏幕快照：${JSON.stringify(dump)}`)
  } catch { /* noop */ }
}

async function main() {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '240000',
    SMOKE_CLICK_MS: '800', // 尽早切到终端工作台
    SMOKE_VIEW: '终端工作台',
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  let cdp = null
  let session = ''
  try {
    cdp = await Cdp.connect(await waitForPage(child))
    await cdp.send('Runtime.enable')
    // 让渲染页始终视为已聚焦：自动化窗口不一定是系统前台窗口，拿不到焦点时 xterm 不渲染硬件光标
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await waitFor(cdp, `!!document.querySelector('.terminal-grid .term-pane .xterm-screen')`, '终端窗格渲染')
    session = await waitFor(cdp, SID_EXPR, '终端会话就绪')
    await new Promise((r) => setTimeout(r, 4500)) // 等 pwsh 起好（抢跑会丢输入）

    console.log('\n[1] 跑夹具：隐藏硬件光标 + 海量输出 + 光标停在右下角（保持前台）')
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, 'Clear-Host; node scripts/terminal-replay-fixture.cjs --stay\\r')`)
    const before = await waitFor(cdp, `(() => { const p = ${PROBE}; return p.parked ? p : null })()`, '夹具跑完（标记行上屏）', 90000)
    await new Promise((r) => setTimeout(r, 1500)) // 等夹具把光标停到右下角的收尾也渲染完
    await cdp.eval(FOCUS_PANE)
    await new Promise((r) => setTimeout(r, 400))
    const focusedBefore = await cdp.eval(PROBE)
    const attach = await cdp.eval(`(async () => { const r = await window.gitReport.terminalAttach(${JSON.stringify(session)}); return { truncated: r.truncated, len: r.output.length } })()`)
    check('E1 夹具输出超过缓冲上限，缓冲头部被丢弃', attach.truncated === true, `缓冲 ${attach.len} 字符`)
    check('E2 切页前：终端已获得焦点（否则光标断言无效）', focusedBefore.focused === true, JSON.stringify(focusedBefore))
    check('E2 切页前：硬件光标元素不存在（隐藏生效）', focusedBefore.cursor === null, JSON.stringify(focusedBefore))
    check('E2 切页前：夹具标记行在屏上', before.parked === true, JSON.stringify(before))

    console.log('\n[2] 切到「工作台」再切回（触发 attach 回放）')
    await gotoView(cdp, '工作台')
    await waitFor(cdp, `!document.querySelector('.terminal-grid .term-pane .xterm-screen')`, '终端页卸载')
    await new Promise((r) => setTimeout(r, 800))
    await gotoView(cdp, '终端工作台')
    const after = await waitFor(cdp, `(() => { const p = ${PROBE}; return p.parked ? p : null })()`, '回放把标记行恢复出来', 60000)
    await cdp.eval(FOCUS_PANE)
    await new Promise((r) => setTimeout(r, 600))
    const probed = await cdp.eval(PROBE)
    check('E3 切回后：窗格重建，回放恢复出标记行', probed.parked === true && probed.rows > 0, JSON.stringify(probed))
    check('E4 切回后：终端已获得焦点（否则光标断言无效）', probed.focused === true, JSON.stringify(probed))
    check('E5 切回后：硬件光标元素仍不存在（隐藏光标的模式被补回）', probed.cursor === null,
      probed.cursor ? `硬件光标出现在第 ${probed.cursor.row} 行第 ${probed.cursor.col} 列（共 ${probed.cursor.rows} 行）` : '')
    if (process.env.E2E_DEBUG) await dumpScreen(cdp)
  } catch (err) {
    console.error('\n终端截断回放 E2E 异常：', (err && err.stack) || err)
    if (cdp) await dumpScreen(cdp)
    console.error(String(log).split('\n').slice(-20).join('\n'))
    failed += 1
  } finally {
    if (cdp && session) { try { await cdp.eval(`window.gitReport.terminalClose(${JSON.stringify(session)}).catch(() => null)`) } catch { /* noop */ } }
    try { child.kill() } catch { /* 已退出 */ }
    cdp?.close()
  }
  console.log(`\n终端截断回放 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().then(() => {
  if (process.exitCode === 0) {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  }
})
