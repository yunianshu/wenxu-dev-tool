/**
 * E2E（真实 Electron + 真实 ConPTY）：终端窗格里的字符宽度必须与 conhost 逐格一致
 *
 * 为什么需要：Windows 上程序的输出先经 conhost 排版再发给 xterm，TUI（kimi 等）画的光标块、
 * 右边框都靠 conhost 的定位 / 擦除 / 右移序列落位。xterm 的宽度表与 conhost 不一致时，
 * emoji 之后的内容整体错位 —— kimi 的「光标偏移」就是 xterm 把 emoji 当成 1 格造成的。
 * 本脚本在真实窗格里跑 terminal-unicode-fixture.cjs（按 kimi 的画法画输入框），
 * 从 DOM 量出光标块与右边框实际落在第几列。
 *
 * 验收标准（期望值按 conhost 实测宽度直接写死，不从被测模块反推；行首「[序号] │ > 」共 9 格）：
 *   E1 纯 ASCII 基线：光标块第 12 列（9 + 3 个字母），用于确认测量方法本身可靠
 *   E2 中文 / 增补平面 emoji / BMP emoji：每个 2 格
 *   E3 文本型 emoji + 变体选择符（❤️）：基字 1 格 + 选择符 1 格
 *   E4 组合音标（e + U+0301 + x）：音标占 1 格
 *   E5 宽 emoji + 变体选择符（☕️）：2 格 + 1 格
 *   E6 混排一行：各类宽度叠加后仍对齐
 *   E7 emoji 之后的字符一个不少（没有被挤掉）
 *   E8 只重绘一行的第二帧后：光标块跟到新位置
 *   E9 所有行：恰好一对框线，右框固定在倒数第 2 列，光标块与右框之间、右框之后都没有残字
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/terminal-unicode-e2e.cjs
 *       E2E_SCREENSHOT_DIR=<目录> node scripts/terminal-unicode-e2e.cjs   （另存整窗截图）
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ROWS, RETYPE_CPS, text } = require('./terminal-unicode-fixture.cjs')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-terminal-unicode-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9367

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = [{
  id: 'proj-1', name: '终端宽度自测', description: '', localPath: ROOT, status: 'active', tags: [],
}]
fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))
fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
  version: 1, gridMode: 'auto', columnWidths: [1], rowHeights: [1],
  panes: [{ projectId: 'proj-1', shellId: '', title: '', width: 0.5 }], savedAt: Date.now(),
}, null, 2))

/** 期望：各行最终文本，以及光标块所在的列（0 起算，按 conhost 宽度累加） */
const EXPECT = [
  { tag: '01', text: 'abc', cursor: 12, note: '纯 ASCII 基线' },
  { tag: '02', text: text(ROWS[1].cps), cursor: 17, note: '中文各 2 格' },
  { tag: '03', text: text(ROWS[2].cps), cursor: 17, note: '增补平面 emoji 2 格' },
  { tag: '04', text: text(ROWS[3].cps), cursor: 17, note: 'BMP emoji 各 2 格' },
  { tag: '05', text: text(ROWS[4].cps), cursor: 11, note: '❤ + VS16 共 2 格' },
  { tag: '06', text: text(ROWS[5].cps), cursor: 12, note: '组合音标占 1 格' },
  { tag: '07', text: text(ROWS[6].cps), cursor: 12, note: '☕ 2 格 + VS16 1 格' },
  { tag: '08', text: text(ROWS[7].cps), cursor: 17, note: '混排' },
  { tag: '09', text: text(RETYPE_CPS), cursor: 19, note: '第二帧差分重绘' },
]

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
      }, 20000).unref?.()
    })
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description || ''}`)
    return res.result.value
  }
  close() { try { this.ws.close() } catch { /* noop */ } }
}

function startApp() {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '120000',
    SMOKE_CLICK_MS: '800',        // 尽早切到终端工作台
    SMOKE_VIEW: '终端工作台',
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
    SMOKE_SCREENSHOT_PATH: path.join(SANDBOX, 'smoke.png'), // 顺带让窗口显示出来
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { child }
}

async function stopApp(app) {
  try { app.child.kill() } catch { /* 已退出 */ }
  await new Promise((resolve) => {
    if (app.child.exitCode !== null || app.child.signalCode) return resolve()
    app.child.on('exit', resolve)
    setTimeout(resolve, 10000).unref?.()
  })
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
  for (;;) {
    const value = await cdp.eval(expression)
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r',
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
}

/** 页内测量：每行给出文本、光标块所在列（反色空格）、所有「│」所在的列 */
const MEASURE = `((cols) => {
  const pane = document.querySelector('.terminal-grid .term-pane')
  const rows = [...pane.querySelectorAll('.xterm-rows > div')]
  const transparent = 'rgba(0, 0, 0, 0)'
  return rows.map((row) => {
    const rect = row.getBoundingClientRect()
    const cellW = rect.width / cols
    const spans = [...row.querySelectorAll('span')]
    // 光标块 = 自带背景色的空格；排除 xterm 自己的硬件光标
    const cursorCols = spans
      .filter((el) => getComputedStyle(el).backgroundColor !== transparent && !el.classList.contains('xterm-cursor'))
      .map((el) => Math.round((el.getBoundingClientRect().left - rect.left) / cellW))
    const borders = []
    for (const el of spans) {
      const left = (el.getBoundingClientRect().left - rect.left) / cellW
      let offset = 0
      for (const ch of el.textContent) {
        if (ch === '│') borders.push(Math.round(left + offset))
        offset += ch.codePointAt(0) >= 0x1100 ? 2 : 1
      }
    }
    return {
      text: row.textContent.split(String.fromCharCode(0xa0)).join(' '),
      cursorCols,
      borders,
    }
  })
})(COLS)`

async function main() {
  const app = startApp()
  let cdp = null
  try {
    cdp = await Cdp.connect(await waitForPage(app.child))
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await waitFor(cdp, `(() => document.querySelectorAll('.terminal-grid .term-pane').length === 1)()`, '窗格就绪')
    await new Promise((r) => setTimeout(r, 2500)) // 等会话与首屏输出稳定
    const point = await cdp.eval(`(() => {
      const r = document.querySelector('.terminal-grid .term-pane').getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.6) }
    })()`)
    await click(cdp, point.x, point.y)
    await new Promise((r) => setTimeout(r, 500))

    // 在窗格的 PowerShell 里跑夹具：命令走输入法提交同款的 insertText，不逐键模拟
    await cdp.send('Input.insertText', { text: `node "${path.join(__dirname, 'terminal-unicode-fixture.cjs')}"` })
    await new Promise((r) => setTimeout(r, 400))
    await pressEnter(cdp)
    // 夹具：第一帧 → 600ms → 第二帧 → 1500ms 退出；再留出 conhost 重绘与提示符回来的时间
    await new Promise((r) => setTimeout(r, 4500))

    const cols = await cdp.eval(`(async () => (await window.gitReport.terminalList()).sessions[0].cols)()`)
    const rows = await cdp.eval(MEASURE.replace('COLS', String(cols)))
    console.log(`窗格 ${cols} 列；期望右框线在第 ${cols - 2} 列（0 起算）`)

    if (process.env.E2E_SCREENSHOT_DIR) {
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.mkdirSync(process.env.E2E_SCREENSHOT_DIR, { recursive: true })
      fs.writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR, 'terminal-unicode.png'), Buffer.from(png.data, 'base64'))
    }

    console.log('\n[E1~E8] 每行光标块落在 conhost 排版的位置，emoji 之后的字符一个不少')
    EXPECT.forEach((exp, i) => {
      const row = rows[i] || { text: '', cursorCols: [], borders: [] }
      const head = `[${exp.tag}] │ > ${exp.text}`
      check(`第 ${exp.tag} 行 ${exp.note}：光标块在第 ${exp.cursor} 列`,
        row.cursorCols.length === 1 && row.cursorCols[0] === exp.cursor, `实测 ${JSON.stringify(row.cursorCols)}`)
      check(`第 ${exp.tag} 行文本完整`, row.text.startsWith(`${head} `), `行首 |${row.text.slice(0, head.length + 1)}| 期望 |${head} |`)
    })

    console.log('\n[E9] 所有行的框线与残留')
    EXPECT.forEach((exp, i) => {
      const row = rows[i] || { text: '', borders: [] }
      const rest = row.text.slice(`[${exp.tag}] │ > ${exp.text}`.length + 1) // 光标块之后到行尾
      // 行首「[序号] 」占 5 格，左框线在第 5 列；夹具每行画满 cols 格，右框线在倒数第 2 列
      check(`第 ${exp.tag} 行：恰好一对框线，右框在第 ${cols - 2} 列`,
        row.borders.length === 2 && row.borders[0] === 5 && row.borders[1] === cols - 2, `实测框线列 ${JSON.stringify(row.borders)}`)
      check(`第 ${exp.tag} 行：光标块与右框之间、右框之后都没有残字`, /^\s*│\s*$/.test(rest), `光标块之后 |${rest}|`)
    })
  } finally {
    cdp?.close()
    await stopApp(app)
  }
  console.log(failed ? `\nterminal-unicode-e2e 失败 ${failed} 项` : '\nterminal-unicode-e2e 通过')
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
