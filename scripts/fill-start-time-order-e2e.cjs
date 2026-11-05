/**
 * E2E（真实 Tauri 产物 + 临时 APPDATA + CDP）：一键填报「上班时间下拉按使用次数排序」
 *
 * 需求（用户反馈）：开始时间下拉要把选得最多的选项排到前面，前三个时间点用不同背景色区分。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   B1 预置使用次数 {09:00:5, 08:30:3, 10:00:2} 后打开上班时间下拉：前三个选项依次为 09:00 / 08:30 / 10:00
 *   B2 其余选项保持时间顺序（第四个为 06:00）
 *   B3 前三个选项各有一种底色，三者互不相同
 *   B4 第四个选项没有底色标记，背景与前三者不同
 *   B5 选择 11:00 后本机使用次数 +1（localStorage 持久化）
 *   B6 选中后输入框与工具条预览按所选时间更新
 *
 * 前置：npm run build:win（驱动 src-tauri/target/release/personnel-plm.exe）
 * 用法：node scripts/fill-start-time-order-e2e.cjs
 *       E2E_EXE=<安装目录 exe> node scripts/fill-start-time-order-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EXE = process.env.E2E_EXE
  ? path.resolve(process.env.E2E_EXE)
  : path.join(ROOT, 'src-tauri', 'target', 'release', 'personnel-plm.exe')
const PORT = Number(process.env.PLM_CDP_PORT || 9231)
const SANDBOX = path.join(os.tmpdir(), `pm-fill-start-order-${Date.now()}`)
const APPDATA = path.join(SANDBOX, 'appdata')
const USAGE = { '09:00': 5, '08:30': 3, '10:00': 2 }

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = pages.find((p) => p.url.startsWith('http://tauri.localhost/'))
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve)
          socket.addEventListener('error', reject)
        })
        let id = 0
        const evaluate = (expression, timeout = 30000) => new Promise((resolve, reject) => {
          const messageId = ++id
          const timer = setTimeout(() => reject(new Error('CDP 求值超时')), timeout)
          const onMessage = (event) => {
            const message = JSON.parse(event.data)
            if (message.id !== messageId) return
            socket.removeEventListener('message', onMessage)
            clearTimeout(timer)
            if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || 'CDP 异常'))
            else resolve(message.result?.result?.value)
          }
          socket.addEventListener('message', onMessage)
          socket.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
        })
        return { socket, evaluate }
      }
    } catch { /* 页面还没就绪 */ }
    sleep(1000)
  }
  throw new Error('等待 Tauri 页面超时')
}

const EVAL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const waitFor = async (fn, ms = 8000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
    return false
  }
  const r = {}
  // 等应用外壳就绪后再碰 localStorage：启动初期文档还没进入正式 origin，访问会被拒绝
  if (!await waitFor(() => q('.app-menu') && typeof window.gitReport === 'object', 30000)) return { fatal: '应用未就绪' }
  // 先写入使用次数，再进入一键填报（视图挂载时读取）
  localStorage.setItem('fill-report:start-time-usage', ${JSON.stringify(JSON.stringify(USAGE))})
  const nav = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => norm(el.textContent) === '一键填报')
  if (!nav) return { fatal: '侧栏没有一键填报入口' }
  nav.click()
  if (!await waitFor(() => q('.fill-page .fill-start'), 20000)) return { fatal: '一键填报页未就绪' }

  const start = q('.fill-page .fill-start')
  const tipBefore = norm(q('.fill-range-tip')?.textContent)
  const open = async () => {
    (start.querySelector('.el-select__wrapper') || start).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return waitFor(() => {
      const popper = q('.fill-time-popper')
      return !!popper && [...popper.querySelectorAll('.el-select-dropdown__item')].some((x) => x.offsetParent !== null)
    }, 8000)
  }
  if (!await open()) return { fatal: '上班时间下拉未打开' }

  const items = [...document.querySelectorAll('.fill-time-popper .el-select-dropdown__item')].filter((x) => x.offsetParent !== null)
  const describe = (el) => ({
    text: norm(el.textContent),
    cls: String(el.className),
    bg: getComputedStyle(el).backgroundColor,
  })
  r.total = items.length
  r.firstFour = items.slice(0, 4).map(describe)
  r.firstFourText = r.firstFour.map((x) => x.text)
  r.misc = ['06:00', '07:00', '08:00', '11:00'].map((t) => r.firstFour.find((x) => x.text === t) || null)

  const pick = items.find((el) => norm(el.textContent) === '11:00')
  r.picked = !!pick
  if (pick) pick.click()
  r.shownAfterPick = await waitFor(() => norm(start.textContent).includes('11:00'), 5000)
  r.tipAfterPick = norm(q('.fill-range-tip')?.textContent)
  r.tipBefore = tipBefore
  r.usageAfterPick = JSON.parse(localStorage.getItem('fill-report:start-time-usage') || '{}')
  return r
})()`

async function main() {
  if (!fs.existsSync(EXE)) { console.error(`exe 不存在: ${EXE}`); process.exit(2) }
  fs.mkdirSync(APPDATA, { recursive: true })
  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env: { ...process.env, APPDATA, PLM_CDP_PORT: String(PORT), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: 'ignore',
    detached: true,
  })
  child.unref()

  let failed = 0
  const assert = (name, cond, detail) => {
    if (cond) console.log(`  PASS  ${name}`)
    else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
  }
  console.log('=== 一键填报：上班时间下拉排序与底色（B1–B6）===')

  let socket
  try {
    const conn = await connect()
    socket = conn.socket
    // 页面对象出现不等于外壳就绪：启动初期还可能在导航，求值会拿到空上下文
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = await conn.evaluate('!!document.querySelector(".app-menu") && typeof window.gitReport === "object"')
      } catch { /* 上下文重建中，重试 */ }
      if (!ready) sleep(1000)
    }
    if (!ready) throw new Error('应用外壳未就绪')
    const r = await conn.evaluate(EVAL)
    if (r?.fatal) {
      assert('页面就绪', false, r.fatal)
    } else {
      assert('B1 前三个选项 = 使用最多的 09:00 / 08:30 / 10:00',
        JSON.stringify(r.firstFourText.slice(0, 3)) === JSON.stringify(['09:00', '08:30', '10:00']),
        `实际=${JSON.stringify(r.firstFourText)}`)
      assert('B2 第四个选项回到时间顺序 06:00', r.firstFourText[3] === '06:00', `实际=${r.firstFourText[3]}`)
      const tones = r.firstFour.slice(0, 3)
      const toneBg = tones.map((x) => x.bg)
      assert('B3 前三个选项各有底色标记（is-time-1/2/3）',
        tones.every((x, i) => x.cls.includes(`is-time-${i + 1}`)),
        `实际=${JSON.stringify(tones.map((x) => x.cls))}`)
      assert('B3 前三个底色互不相同且非透明',
        new Set(toneBg).size === 3 && toneBg.every((bg) => !/rgba?\\(0, 0, 0, 0\\)|transparent/.test(bg)),
        `实际=${JSON.stringify(toneBg)}`)
      const plain = r.firstFour[3]
      assert('B4 第四个选项无底色且与前三不同',
        !/is-time-\\d/.test(plain.cls) && !toneBg.includes(plain.bg),
        `cls=${plain.cls} bg=${plain.bg}`)
      assert('B5 选择 11:00 后使用次数记录为 1', r.usageAfterPick['11:00'] === 1, `实际=${JSON.stringify(r.usageAfterPick)}`)
      assert('B6 输入框与工具条预览切到 11:00',
        r.shownAfterPick === true && String(r.tipAfterPick).includes('11:00–'),
        `shown=${r.shownAfterPick} tip="${r.tipAfterPick}"（选择前 "${r.tipBefore}"）`)
      if (failed) console.log('诊断数据:', JSON.stringify(r, null, 1))
    }
  } catch (error) {
    assert('E2E 执行', false, error.message)
  } finally {
    try { socket?.close() } catch { /* noop */ }
    try { child.kill() } catch { /* noop */ }
  }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error('E2E 异常:', error.message); process.exit(1) })
