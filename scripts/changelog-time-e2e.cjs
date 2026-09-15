/**
 * E2E：应用内「版本更新日志」的条目标题时间精确到分钟
 *
 * 验收标准（源自需求）：
 *   T1 每个版本标题都是「x.y.z · YYYY-MM-DD HH:MM」（带分钟）
 *   T2 最新一条是当前应用版本，且时间与 CHANGELOG 里的一致
 *   T3 版本号与时间都严格从新到旧（回填时间出错时能立刻发现）
 *
 * 前置：npm run build:renderer（CHANGELOG 是构建时 `?raw` 内联的）
 * 用法：node scripts/changelog-time-e2e.cjs
 *       E2E_EXE=<打包产物 exe> node scripts/changelog-time-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-changelog-${Date.now()}`)
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9363
const EXE = process.env.EXE_PATH || process.env.E2E_EXE || ''
const VERSION = require(path.join(ROOT, 'package.json')).version

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
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
      if (msg.error) slot.reject(new Error(msg.error.message))
      else slot.resolve(msg.result)
    })
    return client
  }

  send(method, params = {}) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) reject(new Error(`CDP 超时：${method}`)) }, 20000).unref?.()
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
    PROJECT_MANAGER_USER_DATA: path.join(SANDBOX, 'appdata'),
    SMOKE_EXIT_MS: '180000',
    SMOKE_CLICK_MS: '600000', // 不让冒烟钩子自己切页
  }
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(env.PROJECT_MANAGER_USER_DATA, { recursive: true })
  const child = EXE
    ? spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  return { child, log: () => log }
}

async function waitForPage(port, child) {
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

async function waitFor(cdp, expression, label, timeout = 20000) {
  const start = Date.now()
  for (;;) {
    if (await cdp.eval(expression)) return true
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

async function main() {
  const app = startApp()
  let cdp = null
  try {
    cdp = await Cdp.connect(await waitForPage(PORT, app.child))
    await cdp.send('Runtime.enable')
    await waitFor(cdp, `!!document.querySelector('.sidebar-version')`, '侧栏更新日志入口渲染')

    // 侧栏底部「vX.Y.Z · 更新日志」按钮打开对话框
    await cdp.eval(`(() => { document.querySelector('.sidebar-version').click(); return true })()`)
    await waitFor(cdp, `!!document.querySelector('.changelog-body h2')`, '更新日志对话框内容渲染')
    await new Promise((r) => setTimeout(r, 400))

    const titles = await cdp.eval(`[...document.querySelectorAll('.changelog-body h2')].map((h) => h.textContent.trim())`)
    check('更新日志至少列出了多个版本', Array.isArray(titles) && titles.length >= 10, `共 ${titles.length} 条`)

    const withMinute = /^(\d+\.\d+\.\d+) · (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/
    const bad = (titles || []).filter((t) => !withMinute.test(t))
    check('每条标题都是「版本 · 日期 时:分」', bad.length === 0, bad.length ? `不合格式：${bad.slice(0, 3).join(' / ')}` : '')

    const parsed = (titles || []).map((t) => {
      const m = t.match(withMinute)
      return m ? { version: m[1], stamp: `${m[2]} ${m[3]}` } : null
    }).filter(Boolean)

    check(`最新一条是当前版本 v${VERSION}`, parsed[0]?.version === VERSION, `实际「${parsed[0]?.version || titles?.[0]}」`)

    // 时间必须严格从新到旧：回填时间取错提交时（比如取到被下一个版本顶掉的那次）这里会立刻暴露
    const orderBad = []
    for (let i = 1; i < parsed.length; i += 1) {
      if (parsed[i].stamp >= parsed[i - 1].stamp) orderBad.push(`${parsed[i - 1].version}(${parsed[i - 1].stamp}) → ${parsed[i].version}(${parsed[i].stamp})`)
    }
    check('时间严格从新到旧', orderBad.length === 0, orderBad.slice(0, 3).join(' / '))

    // 与仓库里的 CHANGELOG.md 逐条对齐（内置文本 == 仓库文本，且没漏掉分钟）
    const repo = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
    const repoEntries = [...repo.matchAll(/^## (\d+\.\d+\.\d+) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/gm)]
      .map((m) => ({ version: m[1], stamp: m[2] }))
    const sameCount = repoEntries.length === parsed.length
    const samePairs = repoEntries.every((e, i) => parsed[i] && e.version === parsed[i].version && e.stamp === parsed[i].stamp)
    check('应用内与仓库 CHANGELOG 完全一致', sameCount && samePairs,
      `仓库 ${repoEntries.length} 条 / 应用内 ${parsed.length} 条`)

    console.log(`\n最新三条：${parsed.slice(0, 3).map((p) => `${p.version} · ${p.stamp}`).join('  |  ')}`)
    console.log(`\n更新日志时间校验：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  } catch (err) {
    console.error('\n校验异常：', (err && err.stack) || err)
    console.error('应用日志尾部：')
    console.error(String(app.log()).split('\n').slice(-15).join('\n'))
    failed += 1
  } finally {
    cdp?.close()
    try { app.child.kill() } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 800))
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main()
