/**
 * 真实环境验证：真实 codex 在真实应用（真实 ConPTY + 修复后的渲染层）里的光标稳定性
 *
 * 与 terminal-cursor-e2e.cjs 的区别：那边用「捕获帧模式回放」做确定性回归，
 * 这边拉起真实 codex CLI（需要本机已登录 codex），提交一个最小流式任务，
 * 在 Working/流式阶段采样渲染层光标位置，验证真实产物下光标不闪跳。
 * 会消耗一次极小的 codex 请求配额（输出约百字）。
 *
 * 用法：node scripts/terminal-cursor-real-codex-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-codex-real-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9353

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = [{
  id: 'proj-1', name: 'codex 实测项目', description: '', localPath: ROOT, status: 'active', tags: [],
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

async function waitForPage(port = PORT, child = null) {
  for (let i = 0; i < 60; i += 1) {
    if (child && child.exitCode !== null) throw new Error(`应用进程已退出（exit=${child.exitCode}）`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等待渲染页调试端点超时')
}

async function waitFor(cdp, expression, label, timeout = 60000) {
  const start = Date.now()
  for (;;) {
    const value = await cdp.eval(expression)
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

const SAMPLER = `
window.__samples = []
window.__startSampler = () => {
  window.__samplerStart = Date.now()
  window.__sampler = setInterval(() => {
    const el = document.querySelector('.term-pane .xterm-rows .xterm-cursor')
      || document.querySelector('.term-pane [class*="xterm-cursor"]')
    if (!el) { window.__samples.push({ t: Date.now(), miss: true }); return }
    const r = el.getBoundingClientRect()
    window.__samples.push({ t: Date.now(), y: Math.round(r.y), x: Math.round(r.x) })
  }, 8)
}
window.__stopSampler = () => { clearInterval(window.__sampler); return window.__samples }
true
`

async function main() {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '240000',
    SMOKE_CLICK_MS: '800',
    SMOKE_VIEW: '终端工作台',
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const app = spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  app.stdout.on('data', (d) => { log += d })
  app.stderr.on('data', (d) => { log += d })
  let cdp = null
  try {
    cdp = await Cdp.connect(await waitForPage())
    await cdp.send('Runtime.enable')
    await cdp.eval(SAMPLER)
    await waitFor(cdp, `!!document.querySelector('.terminal-grid .term-pane .xterm-screen')`, '终端窗格渲染')
    const session = await waitFor(cdp, `(async () => {
      const res = await window.gitReport.terminalList().catch(() => null)
      const hit = (res?.sessions || []).find((s) => !s.exited)
      return hit ? hit.id : ''
    })()`, '终端会话就绪')
    await new Promise((r) => setTimeout(r, 1200))

    console.log('\n[R1] 拉起真实 codex（消耗一次极小配额）')
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, 'codex\\r')`)
    const composer = await waitFor(cdp, `(async () => {
      const res = await window.gitReport.terminalAttach(${JSON.stringify(session)}).catch(() => null)
      return (res?.output || '').includes('Ask Codex')
    })()`, 'codex composer 就绪', 90000)
    check('codex TUI 启动到 composer', !!composer)
    await new Promise((r) => setTimeout(r, 1500))

    // 提交一个小流式任务（约百字输出，Working/流式阶段持续数秒到数十秒）
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, '用100字左右的散文描写秋天，直接开始，不要任何解释\\r')`)
    await cdp.eval(`window.__startSampler()`)
    // 采样 25 秒，覆盖提交→Working→流式→完成
    await new Promise((r) => setTimeout(r, 25000))
    const samples = await cdp.eval(`window.__stopSampler()`)
    const output = await cdp.eval(`(async () => (await window.gitReport.terminalAttach(${JSON.stringify(session)})).output)()`)

    console.log('\n[R2] Working/流式阶段光标稳定性')
    const valid = (samples || []).filter((s) => !s.miss)
    check('采样到光标元素', valid.length > 400, `有效样本 ${valid.length}/${(samples || []).length}`)
    // 闪跳与布局推进的区分：流式回答会让 composer 合法下移（y 单调块状推进），
    // 闪跳则是「离开过的 y 又回来」（往复）或毫秒级来回切。按时间块序列判定：
    const blocks = []
    for (const s of valid) {
      const last = blocks[blocks.length - 1]
      if (last && last.y === s.y) { last.end = s.t; last.n += 1 }
      else blocks.push({ y: s.y, start: s.t, end: s.t, n: 1 })
    }
    const seen = new Set()
    let revisits = 0
    let shortBlocks = 0
    for (const b of blocks) {
      if (seen.has(b.y) && blocks.length > 1) revisits += 1
      seen.add(b.y)
      if (b.end - b.start < 120 && blocks.length > 1) shortBlocks += 1
    }
    console.log(`  y 块序列：${blocks.slice(0, 12).map((b) => `y=${b.y}(${b.n})`).join(' → ')}${blocks.length > 12 ? ' …' : ''}`)
    console.log(`  共 ${blocks.length} 块，往复 ${revisits} 次，<120ms 短块 ${shortBlocks} 个`)
    check('光标无往复闪跳（撕裂帧被整体渲染）', revisits === 0,
      `往复 ${revisits} 次（修复前应为数百次）`)
    check('无毫秒级来回切（8Hz 采样下短块 ≤ 3）', shortBlocks <= 3, `短块 ${shortBlocks} 个`)
    const responded = /秋/.test(output || '')
    check('codex 真实响应已渲染', responded, `输出长度 ${(output || '').length}`)
    fs.writeFileSync(path.join(SANDBOX, 'samples.json'), JSON.stringify(samples || []))

    const errors = await cdp.eval(`window.__e2eErrors || []`)
    check('全程无渲染层错误', (errors || []).length === 0, JSON.stringify(errors || []).slice(0, 200))

    // 退出 codex，停应用
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, '\\x03')`)
    await new Promise((r) => setTimeout(r, 700))
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, '\\x03')`)
    await new Promise((r) => setTimeout(r, 700))
    await cdp.eval(`window.gitReport.terminalWrite(${JSON.stringify(session)}, 'exit\\r')`)
    await new Promise((r) => setTimeout(r, 900))
    try { app.child.kill() } catch { /* noop */ }
    console.log(`\n真实 codex 光标验证：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  } catch (err) {
    console.error('\n真实 codex 光标验证异常：', (err && err.stack) || err)
    console.error(String(log).split('\n').slice(-20).join('\n'))
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
