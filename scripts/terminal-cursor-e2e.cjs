/**
 * E2E（真实 Electron + 真实 ConPTY + 真实 xterm 渲染）：终端工作台光标稳定性
 *
 * 背景：codex 等 ratatui TUI 每帧多次翻转光标可见性（上游 #9081/#21828），ConPTY
 * 把一帧拆成多个 chunk（实测帧内间隔 3~80ms），部分 chunk 以「光标停在跳板位置 +
 * 显示」结尾。渲染层逐 chunk write 时，xterm 把帧中间的过渡态光标真实渲染出来，
 * 表现为「光标漂移闪烁」（用户截图：绿块停在消息框左缘，随 spinner 闪烁）。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   C1 回放真实捕获的 codex 帧模式（撕裂帧：跳板位 (10,1) + 60ms 后落位 (20,3)，
 *      8Hz 连发）时，渲染出来的光标不得在跳板位与落位之间来回闪跳
 *   C2 光标最终稳定停在落位（输入框插入点语义）
 *   C3 普通回显不受合并影响：按键后回显必须在 250ms 内渲染出来（打字手感）
 *   C4 全程无渲染层错误
 *
 * TUI 侧用「捕获模式的真实回放」代替真实 codex：codex 需要登录与配额，无法
 * 稳定接入自动化（Mock 边界内的外部系统）；帧字节模式来自对真实 codex 的
 * 三次字节级抓取。真实 codex 的实测见 scripts/_diag-codex-*.cjs 的捕获结论。
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/terminal-cursor-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-cursor-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9343

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = [{
  id: 'proj-1',
  name: '光标自测项目',
  description: '',
  localPath: ROOT,
  status: 'active',
  tags: [],
}]

fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))
// 预置布局：一个窗格（首次进入没有布局时是空状态，不会自动开窗格）
fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
  version: 1,
  gridMode: 'auto',
  columnWidths: [1],
  rowHeights: [1],
  panes: [{ projectId: 'proj-1', shellId: '', title: '', width: 0.5 }],
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)) }
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

/** 指定则跑打包产物（win-unpacked/Personnel PLM.exe），否则跑开发态 electron . */
const EXE = process.env.E2E_EXE || ''

function startApp(port = PORT) {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '300000',
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
    if (child && child.exitCode !== null) throw new Error(`应用进程已退出（exit=${child.exitCode}）`)
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

// ─── 回放子进程：按真实捕获的 codex 帧模式输出 ───
// 帧结构（字节模式取自 _diag-codex-chunks.cjs 对真实 codex 的抓取）：
//   chunkA（撕裂帧头）：2026h 25l CUP(10;1) 25h 0 q 2026l —— 同步块闭合后光标
//                      停在跳板位 (10,1) 且可见（真实 codex 里是 15;1 等行首位置）
//   chunkB（+60ms）  ：25l " " CUP(20;3) 25h —— 落回输入框插入位 (20,3)
// 60ms 取自实测帧内间隔的中长档（p50=14 / p90=34 / 最长 78ms）
const CHILD = `
const W = (s) => process.stdout.write(s)
W('\\x1b[2J\\x1b[3J\\x1b[H')
W('\\x1b[?25l')
W('\\x1b[18;2H\\u250c──────────────────────────\\u2510')
W('\\x1b[19;2H\\u2502 Ask Codex to do anything \\u2502')
W('\\x1b[20;2H\\u2514──────────────────────────\\u2518')
W('\\x1b[?25h\\x1b[20;3H')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function main() {
  // 预热 2 秒：两次良性落位（让首帧的孤立窗口、ConPTY 稳定都在测量窗外）
  for (let i = 0; i < 6; i++) {
    W('\\x1b[?25l\\x1b[20;3H\\x1b[?25h')
    await sleep(300)
  }
  // 测量段：64 帧 × 125ms（8Hz，接近真实 spinner 节奏）
  for (let i = 0; i < 64; i++) {
    W('\\x1b[?2026h\\x1b[?25l\\x1b[10;1H\\x1b[?25h\\x1b[0 q\\x1b[?2026l')
    await sleep(60)
    W('\\x1b[?25l \\x1b[20;3H\\x1b[?25h')
    await sleep(65)
  }
  W('\\x1b[?25l\\x1b[20;3H\\x1b[?25h')
  await sleep(1500)
  process.exit(0)
}
main()
`

/** 页内采样器：5ms 周期记录光标元素 y/x/行号（行号 = .xterm-rows 内的子行索引，跨运行可比） */
const SAMPLER = `
window.__samples = []
window.__samplerStart = 0
window.__startSampler = () => {
  window.__samplerStart = Date.now()
  window.__sampler = setInterval(() => {
    const el = document.querySelector('.term-pane .xterm-rows .xterm-cursor')
      || document.querySelector('.term-pane [class*="xterm-cursor"]')
    if (!el) { window.__samples.push({ t: Date.now(), miss: true }); return }
    const r = el.getBoundingClientRect()
    const rows = el.closest('.xterm-rows')
    const rowEl = el.closest('.xterm-rows > *')
    const rowIndex = rows && rowEl ? Array.prototype.indexOf.call(rows.children, rowEl) : -1
    window.__samples.push({ t: Date.now(), y: Math.round(r.y), x: Math.round(r.x), rowIndex })
  }, 5)
}
window.__stopSampler = () => { clearInterval(window.__sampler); return window.__samples }
true
`

async function main() {
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
    await cdp.eval(SAMPLER)

    // 等窗格与会话就绪
    await waitFor(cdp, `!!document.querySelector('.terminal-grid .term-pane .xterm-screen')`, '终端窗格渲染')
    const session = await waitFor(cdp, `(async () => {
      const res = await window.gitReport.terminalList().catch(() => null)
      const hit = (res?.sessions || []).find((s) => !s.exited)
      return hit ? hit.id : ''
    })()`, '终端会话就绪')
    await new Promise((r) => setTimeout(r, 1500)) // 等 pwsh 提示符稳定

    console.log('\n[C1/C2] 回放 codex 撕裂帧模式，光标不得闪跳')
    // 落地回放子进程
    const childPath = path.join(SANDBOX, 'replay-child.js')
    fs.writeFileSync(childPath, CHILD)
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, 'Clear-Host\\r')`)
    await new Promise((r) => setTimeout(r, 900))
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, '& ${JSON.stringify(process.execPath)} ${JSON.stringify(childPath)}\\r')`)
    // 等回放子进程跑完（预热 2s + 64×125ms + 收尾 1.5s ≈ 11.5s，留余量）
    await new Promise((r) => setTimeout(r, 2200))
    await cdp.eval(`window.__startSampler()`)
    await new Promise((r) => setTimeout(r, 7600))
    const samples = await cdp.eval(`window.__stopSampler()`)

    const valid = (samples || []).filter((s) => !s.miss)
    const missCount = (samples || []).length - valid.length
    check('采样到光标元素（DOM 渲染存在）', valid.length > 500,
      `有效样本 ${valid.length}/${(samples || []).length}（miss ${missCount}）`)

    // 语义锚定：回放子进程画的输入框中行含「Ask Codex」，光标落位 = 它的下一行
    //（框底行第 3 列）。DOM 渲染器的光标 span 挂在固定行节点里（rowIndex 恒定），
    // 真实位置体现在 y/x 上，因此用锚定行几何推算落位，而不是行索引。
    const anchor = await cdp.eval(`(() => {
      const rows = document.querySelector('.term-pane .xterm-rows')
      if (!rows) return null
      const row = [...rows.children].find((el) => String(el.textContent || '').includes('Ask Codex'))
      if (!row) return null
      const r = row.getBoundingClientRect()
      const first = rows.children[0].getBoundingClientRect()
      return { y: Math.round(r.y), h: Math.round(r.height), left: Math.round(r.left), firstY: Math.round(first.y) }
    })()`)
    if (!anchor) throw new Error('找不到锚定行（回放输入框未渲染）')
    // 深挖：dump 所有光标类元素的位置与类名 + 框底行(锚定行下一行)的 innerHTML 头部
    const probe = await cdp.eval(`(() => {
      const rows = document.querySelector('.term-pane .xterm-rows')
      const all = [...document.querySelectorAll('.term-pane [class*="xterm-cursor"]')]
        .filter((el) => !/pointer/.test(el.className))
      const list = all.map((el) => {
        const r = el.getBoundingClientRect()
        const rowEl = el.closest('.xterm-rows > *')
        return {
          cls: String(el.className), y: Math.round(r.y), x: Math.round(r.x),
          rowIndex: rows && rowEl ? Array.prototype.indexOf.call(rows.children, rowEl) : -1,
          text: (el.textContent || '').slice(0, 4),
        }
      })
      const bottomRow = rows ? rows.children[[...rows.children].findIndex((el) => String(el.textContent || '').includes('Ask Codex')) + 1] : null
      return { list, bottomRowHead: bottomRow ? bottomRow.innerHTML.slice(0, 220) : '', rowsCount: rows ? rows.children.length : 0 }
    })()`)
    console.log('  探针：', JSON.stringify(probe).slice(0, 600))
    // 关键证据：合并批写的实际行为（临时探针）+ 应用实际收到的字节流尾部
    const flushLog = await cdp.eval(`(window.__termFlushLog || []).slice(-14)`)
    console.log('  Flush 日志（尾 14 条）：')
    for (const f of flushLog || []) console.log(`   t=${f.t} len=${f.len} cx=${f.cx} cy=${f.cy} tail=${JSON.stringify(f.tail)}`)
    const parkY = anchor.y + anchor.h // 框底行（第 3 列落位）
    const parkSamples = valid.filter((s) => Math.abs(s.y - parkY) <= 3)
    const others = valid.filter((s) => Math.abs(s.y - parkY) > 3)
    const xs = [...new Set(parkSamples.map((s) => s.x))]
    console.log(`  锚定行 y=${anchor.y}，落位行 y≈${parkY}，光标 x 取值 ${xs.join(',')}`)
    if (others.length) {
      const t0 = valid[0].t
      console.log(`  落位外样本时刻（相对窗口起点 ms）：${others.map((s) => s.t - t0).join(', ')}`)
    }
    // 允许 ≤1% 的边界过渡样本（窗口起止处批切换/会话收尾），周期性闪跳是两位数百分比
    const junkShare = others.length / valid.length
    check('光标不在跳板位闪跳（撕裂帧被整体渲染）', junkShare <= 0.01,
      `落位外样本 ${others.length}/${valid.length}（${(junkShare * 100).toFixed(1)}%）`)
    check('光标稳定停在落位（输入框插入点）', parkSamples.length >= valid.length * 0.98,
      `落位样本 ${parkSamples.length}/${valid.length}`)
    // x 必须是第 3 列（锚定行左缘 + 2 格），而不是行首左边缘（跳板位在第 1 列）
    const cellW = 9 // 13px Consolas 的格宽约 7.8~9px，用 12~40px 的宽松窗判断「缩进两格」
    check('落位在框内缩进列（不是行首跳板列）',
      xs.length === 1 && xs[0] >= anchor.left + 12 && xs[0] <= anchor.left + 40,
      `x=${xs.join(',')}，锚定行左缘 ${anchor.left}`)

    console.log('\n[C3] 普通回显延迟不受合并影响')
    // 回放子进程结束后回到 pwsh 提示符；清屏去掉残留文本后逐个敲标记字符，
    // 从 keyDown 起测回显渲染耗时（取 5 次的中位数，避开杀软扫描等单次环境抖动）
    await new Promise((r) => setTimeout(r, 800))
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, 'Clear-Host\\r')`)
    await new Promise((r) => setTimeout(r, 900))
    const latencies = []
    for (const ch of ['7', '8', '9', '5', '6']) {
      const code = `Digit${ch}`
      const t0 = Date.now()
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: ch, code, windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
        text: ch, unmodifiedText: ch,
      })
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch.charCodeAt(0), nativeVirtualKeyCode: ch.charCodeAt(0),
      })
      await waitFor(cdp, `(() => {
        const rows = document.querySelector('.term-pane .xterm-rows')
        return rows && rows.textContent.includes('${ch}')
      })()`, `回显 ${ch}`, 5000)
      latencies.push(Date.now() - t0)
      await new Promise((r) => setTimeout(r, 250))
    }
    latencies.sort((a, b) => a - b)
    const median = latencies[Math.floor(latencies.length / 2)]
    check('按键回显中位数在 250ms 内渲染', median < 250,
      `回显耗时 ${latencies.join('/')}ms（含轮询粒度），中位 ${median}ms`)

    console.log('\n[C4] 渲染层错误')
    const errors = await cdp.eval(`window.__e2eErrors || []`)
    check('全程无渲染层错误', (errors || []).length === 0, JSON.stringify(errors || []))

    await stopApp(app, PORT)
    console.log(`\n终端光标稳定性 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  } catch (err) {
    console.error('\n终端光标稳定性 E2E 异常：', (err && err.stack) || err)
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
  if (process.exitCode === 0) {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  }
})
