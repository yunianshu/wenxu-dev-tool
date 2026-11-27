/** 一键请假「确认后在后台提交」界面级端到端（手工验证脚本）：
 *    node scripts/leave-submit-background-e2e.cjs
 *
 * 运行真实 Vue 页面（Vite 中间件服务），IPC 全部是隔离桩：不连接北森，不会提交任何申请。
 * 流程：生成方案（桩）→ 核对并提交 → 确认 → 弹窗立即收起、页面状态行显示已用时、
 * 侧栏「一键请假」菜单图标转圈 → 切到别的页面不受阻、转圈仍在（收起侧栏后也在）→
 * 桩放行 → 转圈消失、全局提示结果 → 回到页面能看到提交结果；再验一遍中途停止的提示。
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const SHOTS = path.join(ROOT, 'output', 'leave-background-e2e')

function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE)
  try { return require('playwright-core') } catch { /* 可复用本机 CLI 的依赖，无需修改产品依赖 */ }
  const cache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const file = path.join(cache, entry, 'node_modules', 'playwright-core')
    if (fs.existsSync(file)) return require(file)
  }
  throw new Error('请安装 Playwright CLI，或设置 PLAYWRIGHT_MODULE 指向 playwright-core')
}

const entry = { id: 'e2e-entry', date: '2026-11-20', typeId: 'annual', typeName: '年假', start: '2026-11-20 08:30', end: '2026-11-20 09:00', hours: 0.5 }
const plan = {
  id: 'e2e-plan', staffName: '测试员工', totalHours: 0.5, entries: [entry], overrides: {},
  options: { since: '2026-11-01', until: '2026-11-20', monthToDate: true, workStart: '08:30', workEnd: '17:30', reason: '' },
  rows: [{ date: '2026-11-20', firstCard: '2026-11-20 09:00', lateMinutes: 30, status: 'ready', countLate: true, remainingLate: 0, allocations: [entry] }],
  balances: [
    { name: '调休假', id: 'comp', hours: 0, available: true, used: 0, remaining: 0 },
    { name: '年假', id: 'annual', hours: 4, available: true, used: 0.5, remaining: 3.5 },
    { name: '事假', id: 'personal', hours: null, unlimited: true, available: true, used: 0, remaining: null },
  ],
}

/** 桩只覆盖请假链路与外壳启动；其余 IPC 一律回空数据并记录，不触达任何真实服务 */
function installFixture({ plan }) {
  const eventNames = new Set()
  window.__leaveE2E = { calls: [], unknown: [], plan }
  const api = {
    uiPrefsLoad: async () => ({}), uiPrefsSave: async () => ({ ok: true }),
    winIsFullScreen: async () => false, winIsMaximized: async () => false, winSetFullScreen: async () => {}, winClose: async () => {}, winCloseConfirm: async () => {},
    appUiReady: async () => {}, harnessUpdateStatus: async () => ({}), reposSnapshot: async () => [], warmup: async () => [],
    configLoad: async () => ({ identities: [] }), configSave: async () => ({ ok: true }),
    projectsList: async () => [],
    leaveRestore: async () => ({ ok: true }),
    leavePlan: async () => ({ ok: true, plan: structuredClone(plan) }),
    leaveReplan: async () => ({ ok: true, plan: structuredClone(plan) }),
    leaveSubmit: () => new Promise(resolve => { window.__leaveE2E.finishSubmit = resolve }),
  }
  window.gitReport = new Proxy(api, { get(target, name) {
    if (eventNames.has(name) || /^on[A-Z]/.test(name)) return () => () => {}
    if (name in target) return async (...args) => { window.__leaveE2E.calls.push(String(name)); return target[name](...args) }
    return async () => { window.__leaveE2E.unknown.push(String(name)); return [] }
  } })
}

const viteRunner = `
  import http from 'node:http'
  import { createServer } from 'vite'
  const server = http.createServer()
  const vite = await createServer({ root: process.cwd(), server: { middlewareMode: true, watch: null, hmr: { server } } })
  server.on('request', vite.middlewares)
  server.listen(0, '127.0.0.1', () => console.log('验收服务端口=' + server.address().port))
`

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true })
  const server = spawn(process.execPath, ['--input-type=module', '-e', viteRunner], { cwd: ROOT, windowsHide: true, stdio: 'pipe' })
  let serverLog = ''
  server.stdout.on('data', chunk => { serverLog += chunk })
  server.stderr.on('data', chunk => { serverLog += chunk })
  let browser
  const errors = []
  let passed = 0
  let total = 0
  const check = (title, ok, detail = '') => {
    total += 1
    if (ok) passed += 1
    else process.exitCode = 1
    console.log(`  ${ok ? '✓' : '✗'} ${title}${detail ? `：${detail}` : ''}`)
  }
  try {
    let origin = ''
    for (let i = 0; i < 80; i += 1) {
      if (server.exitCode !== null) throw new Error(serverLog)
      const port = serverLog.match(/验收服务端口=(\d+)/)?.[1]
      if (port) { origin = 'http://127.0.0.1:' + port; break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!origin) throw new Error('隔离 Vite 服务未就绪：' + serverLog)
    browser = await playwright().chromium.launch({ channel: 'msedge', headless: true })
    const page = await browser.newPage({ viewport: { width: 1320, height: 860 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    page.setDefaultTimeout(15000)
    // 只允许访问隔离服务：任何外部请求都记为失败
    const external = []
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
      external.push(route.request().url())
      await route.abort('blockedbyclient')
    })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(message.text()) })
    await page.addInitScript(installFixture, { plan })
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60000 })

    const item = label => page.locator('.app-menu .el-menu-item').filter({ has: page.locator('span', { hasText: new RegExp('^' + label + '$') }) })
    const leaveItem = item('一键请假')
    const spinner = leaveItem.locator('.nav-ico.is-loading')
    const spinners = page.locator('.app-menu .nav-ico.is-loading')
    const phase = page.locator('.leave-phase')
    const reviewDialog = page.locator('.el-dialog').filter({ has: page.locator('.el-dialog__title', { hasText: '确认请假方案' }) })
    const dialogGone = () => page.waitForFunction(() => ![...document.querySelectorAll('.el-dialog')].some(el => el.querySelector('.el-dialog__title')?.textContent.trim() === '确认请假方案' && el.getBoundingClientRect().width > 0), null, { timeout: 5000 })

    await leaveItem.waitFor()
    await leaveItem.click()
    await page.locator('.page-actions button', { hasText: '生成请假方案' }).click()
    const reviewButton = page.locator('.leave-detail-head button', { hasText: '核对并提交 1 笔' })
    await reviewButton.waitFor()
    assert.equal(await spinners.count(), 0, '没有任务时侧栏不得转圈')

    await reviewButton.click()
    await reviewDialog.waitFor({ state: 'visible' })
    await reviewDialog.locator('.el-dialog__footer button', { hasText: '确认提交 1 笔' }).click()
    // 确认后弹窗立即收起，不再遮住页面与侧栏
    await dialogGone()
    check('确认后弹窗立即收起，页面不再被遮罩挡住', await page.locator('.el-overlay:visible').count() === 0)
    await page.waitForFunction(() => /正在后台提交，完成后会通知（已用时 \d+ 秒）/.test(document.querySelector('.leave-phase')?.textContent || ''), null, { timeout: 5000 })
    check('页面状态行显示后台提交与已用时', /正在后台提交，完成后会通知（已用时 \d+ 秒）/.test(await phase.innerText()))
    check('确认后侧栏「一键请假」图标转圈', await spinner.count() === 1 && await spinners.count() === 1)
    check('菜单项的无障碍名称标出任务进行中', await leaveItem.getAttribute('aria-label') === '一键请假（任务进行中）', await leaveItem.getAttribute('aria-label'))
    await page.screenshot({ path: path.join(SHOTS, '1-submitting-on-leave.png') })

    // 切到别的页面：不受阻，转圈仍在
    await item('项目').click()
    await page.locator('.projects-page').waitFor()
    assert.equal(await page.locator('.leave-page').count(), 0, '切走后请假页面应已卸载')
    check('提交期间可以切到别的页面', true)
    check('切到别的页面后侧栏转圈仍在', await spinner.count() === 1 && await spinner.isVisible())
    await page.screenshot({ path: path.join(SHOTS, '2-submitting-on-projects.png') })

    // 收起侧栏：只剩图标，转圈仍看得见
    await page.locator('.sidebar-toggle').click()
    await page.waitForFunction(() => document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed'), null, { timeout: 5000 })
    await page.waitForTimeout(400)
    const box = await spinner.boundingBox()
    check('收起侧栏后转圈仍可见', await spinner.count() === 1 && !!box && box.width > 0 && box.height > 0, box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '')
    await page.screenshot({ path: path.join(SHOTS, '3-submitting-collapsed.png') })
    await page.locator('.sidebar-toggle').click()
    await page.waitForFunction(() => !document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed'), null, { timeout: 5000 })

    // 桩放行：全部成功
    await page.evaluate(() => window.__leaveE2E.finishSubmit({ ok: true, results: [{ id: 'r1', date: '2026-11-20', typeName: '年假', start: '2026-11-20 08:30', end: '2026-11-20 09:00', hours: 0.5, status: 'success', message: '已提交，平台已确认' }],
      plan: { ...structuredClone(window.__leaveE2E.plan), id: 'e2e-plan-refreshed', totalHours: 0, entries: [], rows: [{ date: '2026-11-20', firstCard: '2026-11-20 09:00', lateMinutes: 30, status: 'covered', countLate: true, remainingLate: 0, reason: '已有审批中或已通过的请假覆盖', allocations: [] }] } }))
    await page.locator('.el-message', { hasText: '已提交 1 笔，均已在北森回查确认。' }).waitFor({ timeout: 5000 })
    check('在别的页面也能收到完成提示', true)
    await page.waitForFunction(() => !document.querySelector('.app-menu .nav-ico.is-loading'), null, { timeout: 5000 })
    check('完成后侧栏转圈消失', await spinners.count() === 0)
    assert.equal(await leaveItem.getAttribute('aria-label'), '一键请假')
    await page.waitForFunction(() => !document.querySelector('.el-message'), null, { timeout: 10000 })

    // 回到请假页：能看到提交结果，没有进行中的状态行
    await leaveItem.click()
    await page.locator('.leave-page').waitFor()
    await page.locator('.leave-page .el-alert', { hasText: '已提交 1 笔，均已在北森回查确认。' }).waitFor({ timeout: 5000 })
    check('回到页面能看到提交结果', true)
    assert.equal(await phase.count(), 0, '提交结束后不应再显示进行中状态行')

    // 第二轮：中途停止 → 警告提示，转圈同样消失
    await page.locator('.page-actions button', { hasText: '重新生成方案' }).click()
    await page.locator('.leave-detail-head button', { hasText: '核对并提交 1 笔' }).click()
    await reviewDialog.locator('.el-dialog__footer button', { hasText: '确认提交 1 笔' }).click()
    await spinner.waitFor({ timeout: 5000 })
    await item('工作台').click()
    await page.evaluate(() => window.__leaveE2E.finishSubmit({ ok: true, results: [{ id: 'r2', date: '2026-11-20', typeName: '年假', start: '2026-11-20 08:30', end: '2026-11-20 09:00', hours: 0.5, status: 'failed', message: '平台已拒绝所选假种' }], plan: structuredClone(window.__leaveE2E.plan) }))
    await page.locator('.el-message', { hasText: '请假提交已停止，请打开「一键请假」查看结果' }).waitFor({ timeout: 5000 })
    await page.waitForFunction(() => !document.querySelector('.app-menu .nav-ico.is-loading'), null, { timeout: 5000 })
    check('中途停止时警告提示并撤下转圈', await spinners.count() === 0)

    const fixture = await page.evaluate(() => ({ calls: window.__leaveE2E.calls, unknown: [...new Set(window.__leaveE2E.unknown)] }))
    const leaveCalls = fixture.calls.filter(name => name.startsWith('leave'))
    check('请假链路只调用了桩（留存、生成、提交）', leaveCalls.every(name => ['leaveRestore', 'leavePlan', 'leaveReplan', 'leaveSubmit'].includes(name)) && leaveCalls.filter(name => name === 'leaveSubmit').length === 2, leaveCalls.join(' '))
    check('没有外部请求', external.length === 0, external.slice(0, 3).join(' '))
    check('页面无脚本报错', errors.length === 0, errors.slice(0, 3).join(' | ').slice(0, 400))
    if (fixture.unknown.length) console.log(`  （未单独配置、回空数据的 IPC：${fixture.unknown.join(' ')}）`)
  } catch (error) {
    check('流程走完', false, [error.message, ...errors.slice(0, 3)].join(' | ').slice(0, 700))
  } finally {
    await browser?.close().catch(() => {})
    server.kill()
  }
  console.log(`\n结果：${passed}/${total} 项通过，截图 ${SHOTS}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
