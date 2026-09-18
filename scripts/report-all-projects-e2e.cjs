/**
 * 端到端验证：活动报告固定汇总全部项目（不跟随顶栏当前项目）。
 *
 * 验收标准（源自需求「活动报告需要生成的是全部项目的」）：
 *   A1 报告页「活动源」数量 == 全部扫描到的仓库数（而非当前项目覆盖的仓库数）
 *   A2 当前项目为 A 时生成报告：明细同时包含 A、B 两个项目的提交（分组数 == 2）
 *   A3 历史记录自动保存的标题为「全部项目日报 — <日期>」口径
 *   A4 切到项目 B 后回报告页：明细仍完整显示 A+B，无过期提示
 *   A5 回归兜底：AI 助手页按单项目刷新活动后，报告页旧数据归零并提示重新收集
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/report-all-projects-e2e.cjs
 *       E2E_EXE=<打包产物exe> 时驱动打包版
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-report-all-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const REPO_ROOT = path.join(SANDBOX, 'repos')
const AUTHOR = { name: 'E2E Tester', email: 'e2e@test.local' }

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败: ${r.stderr || r.stdout}`)
  return r.stdout
}

function makeRepo(name, subject) {
  const dir = path.join(REPO_ROOT, name)
  fs.mkdirSync(dir, { recursive: true })
  sh('git', ['init', '-q'], dir)
  sh('git', ['config', 'user.name', AUTHOR.name], dir)
  sh('git', ['config', 'user.email', AUTHOR.email], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`)
  sh('git', ['add', '.'], dir)
  sh('git', ['commit', '-q', '-m', subject], dir)
  return dir
}

// ── 1. 沙箱：两个真实 git 仓库 + 两个项目（各覆盖一个仓库）+ 扫描根 ──
fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(REPO_ROOT, { recursive: true })
const repoA = makeRepo('e2e-repo-a', 'A 项目首个提交')
const repoB = makeRepo('e2e-repo-b', 'B 项目首个提交')

fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
  roots: [REPO_ROOT],
  excludes: ['node_modules'],
  identities: [AUTHOR],           // 「只看本人」默认开启，需与提交作者一致
  ai: { apiKey: 'sk-e2e-dummy-key', model: 'e2e-model' }, // 让 AI 助手页「刷新 Git 活动」可用（A5）
  closeAction: 'minimize',
  harness: { port: 3099, autoStart: false },
}, null, 2))

fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({
  projects: [
    { id: 'e2e-pa', name: 'E2E项目A', localPath: repoA, status: 'active' },
    { id: 'e2e-pb', name: 'E2E项目B', localPath: repoB, status: 'active' },
  ],
}, null, 2))
console.log(`沙箱：${SANDBOX}`)
console.log(`  项目A → ${repoA}`)
console.log(`  项目B → ${repoB}`)

// ── 2. 渲染层探测 ──
const EVAL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const vis = (el) => !!el && el.getBoundingClientRect().height > 0
  const r = {}
  const commitTexts = () => qa('.commit-subject').map((e) => e.textContent.trim())
  const projectNames = () => qa('.project-name').map((e) => e.textContent.trim())
  const goMenu = async (label) => {
    const item = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.includes(label))
    if (item) item.click()
    await sleep(1500)
    return !!item
  }
  let t = Date.now()

  // 等应用壳
  while (Date.now() - t < 30000) { if (q('.metric-strip')) break; await sleep(150) }

  // 进「活动报告」
  const reportItem = qa('.el-menu-item').find((e) => e.textContent.trim() === '活动报告')
  if (!reportItem) { r.error = 'no-report-menu'; return r }
  reportItem.click()
  t = Date.now()
  while (Date.now() - t < 10000) { if (q('.report-toolbar')) break; await sleep(150) }
  r.reportPageReady = !!q('.report-toolbar')

  // 等预热/扫描出的活动源就绪
  t = Date.now()
  while (Date.now() - t < 60000) {
    const m = ((q('.repo-count') || {}).textContent || '').match(/(\\d+)/)
    if (m && Number(m[1]) > 0) break
    await sleep(300)
  }
  r.repoCountText = (q('.repo-count') || {}).textContent || ''

  // 生成报告（此时顶栏当前项目为启动默认的第一个项目 A）
  const genBtn = qa('.report-toolbar button').find((b) => b.textContent.includes('生成报告'))
  if (!genBtn) { r.error = 'no-generate-button'; return r }
  genBtn.click()
  t = Date.now()
  while (Date.now() - t < 90000) {
    const m = ((q('.detail-summary') || {}).textContent || '').match(/(\\d+)\\s*条提交/)
    if (m && Number(m[1]) > 0) break
    await sleep(300)
  }
  r.summaryInit = (q('.detail-summary') || {}).textContent || ''
  r.commitsInit = commitTexts()
  r.projectsInit = projectNames()

  // ── A3：历史记录自动保存的标题 ──
  const histTab = qa('.el-tabs__item').find((e) => e.textContent.includes('历史记录'))
  if (histTab) {
    histTab.click()
    await sleep(1200)
    const row = q('.el-table__row')
    r.historyTitle = row ? (row.querySelectorAll('td')[1] || {}).textContent?.trim() || '' : ''
  }

  // ── A4：切到项目 B 再回报告页 ──
  const openSelect = async () => {
    const okMenu = await goMenu('工作台')
    if (!okMenu) return { opened: false, err: 'no-menu' }
    const root = q('#app-topbar-slot .topbar-project-select')
    if (!root) return { opened: false, err: 'no-select' }
    const wrapper = root.querySelector('.el-select__wrapper') || root
    const fire = (type, el) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
    fire('mousedown', wrapper); fire('mouseup', wrapper); fire('click', wrapper)
    const tw = Date.now()
    while (Date.now() - tw < 5000) {
      if (qa('.el-select-dropdown__item').some(vis)) return { opened: true }
      await sleep(100)
    }
    return { opened: false, err: 'dropdown-not-open' }
  }
  const pick = async (label) => {
    const o = await openSelect()
    const opt = qa('.el-select-dropdown__item').find((e) => vis(e) && e.textContent.trim() === label)
    if (opt) opt.click()
    await sleep(900)
    await goMenu('活动报告')
    return { ...o, clicked: !!opt }
  }
  r.pickB = await pick('E2E项目B')
  t = Date.now()
  while (Date.now() - t < 10000) { if (q('.report-toolbar')) break; await sleep(150) }
  r.summaryAfterB = (q('.detail-summary') || {}).textContent || ''
  r.commitsAfterB = commitTexts()
  r.projectsAfterB = projectNames()
  r.staleAlertAfterB = (q('.stale-alert') || {}).textContent || ''

  // ── A5：AI 助手页按单项目刷新活动 → 报告页旧数据必须归零 ──
  const aiItem = qa('.el-menu-item').find((e) => e.textContent.includes('AI 助手'))
  if (aiItem) {
    aiItem.click()
    await sleep(1500)
    const refreshBtn = qa('#app-topbar-slot button').find((b) => b.textContent.includes('刷新 Git 活动'))
    if (refreshBtn && !refreshBtn.disabled) {
      refreshBtn.click()
      // 等刷新完成（按钮退出 loading）
      t = Date.now()
      while (Date.now() - t < 90000) { if (!refreshBtn.classList.contains('is-loading')) break; await sleep(400) }
      await goMenu('活动报告')
      await sleep(800)
    } else {
      r.aiRefreshSkipped = 'button-missing-or-disabled'
    }
  } else {
    r.aiRefreshSkipped = 'no-ai-menu'
  }
  r.staleAlertAfterAi = (q('.stale-alert') || {}).textContent || ''
  r.summaryAfterAi = (q('.detail-summary') || {}).textContent || ''
  r.commitsAfterAi = commitTexts()

  return r
})()`

const env = {
  ...process.env,
  USERPROFILE: SANDBOX,
  PROJECT_MANAGER_USER_DATA: USER_DATA,
  SMOKE_EXIT_MS: '150000',
  SMOKE_EVAL: EVAL,
  SMOKE_EVAL_MS: '800',
  SMOKE_CLICK_MS: '600000', // 禁用冒烟默认切页
}

const EXE = process.env.E2E_EXE || ''
const LABEL = EXE ? '打包产物' : '开发版'
console.log(`=== 活动报告固定汇总全部项目（${LABEL}） ===`)

const child = spawn(
  EXE || process.execPath,
  EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'],
  { cwd: EXE ? path.dirname(EXE) : ROOT, env },
)

let stdout = ''
let settled = false
const done = (code) => {
  if (settled) return
  settled = true
  try { child.kill() } catch { /* noop */ }
  process.exit(code)
}

child.stdout.on('data', (d) => {
  stdout += String(d)
  const line = stdout.split('\n').find((l) => l.includes('[SMOKE][eval]'))
  if (!line) return
  let r
  try {
    r = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
  } catch { return } // 行还没收全，等下一次 data
  clearTimeout(timer)
  let failed = 0
  const assert = (name, cond, detail) => {
    if (cond) console.log(`  PASS  ${name}`)
    else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
  }
  const hasA = (arr) => (arr || []).some((s) => s.includes('A 项目首个提交'))
  const hasB = (arr) => (arr || []).some((s) => s.includes('B 项目首个提交'))

  assert('A1 活动源数量 == 全部仓库数（2）',
    String(r.repoCountText || '').trim().startsWith('2'), `repo-count="${r.repoCountText}"`)
  assert('A2 当前项目为 A 时明细同时包含 A、B 两个项目',
    hasA(r.commitsInit) && hasB(r.commitsInit) && (r.projectsInit || []).length === 2,
    `summary="${r.summaryInit}" projects=${JSON.stringify(r.projectsInit)}`)
  assert('A3 历史记录标题为「全部项目日报」口径',
    String(r.historyTitle || '').startsWith('全部项目日报 —'), `title="${r.historyTitle}"`)
  assert('A4 切到项目 B 后明细仍完整（A+B，无过期提示）',
    hasA(r.commitsAfterB) && hasB(r.commitsAfterB) && !r.staleAlertAfterB,
    `summary="${r.summaryAfterB}" projects=${JSON.stringify(r.projectsAfterB)} alert="${r.staleAlertAfterB}"`)
  assert('A5 AI 页按单项目刷新后报告页归零并提示重新收集',
    !hasA(r.commitsAfterAi) && !hasB(r.commitsAfterAi) && String(r.staleAlertAfterAi || '').includes('重新收集'),
    `summary="${r.summaryAfterAi}" alert="${r.staleAlertAfterAi}" skipped=${r.aiRefreshSkipped || 'no'}`)

  console.log(`  活动源：${r.repoCountText} · 切B：${JSON.stringify(r.pickB)}`)
  if (failed) console.log('原始数据:', JSON.stringify(r, null, 1))
  done(failed ? 1 : 0)
})

child.stderr.on('data', () => { /* 主进程日志噪音，忽略 */ })

const timer = setTimeout(() => {
  console.log('超时未取到 [SMOKE][eval] 结果，stdout 尾部：')
  console.log(stdout.slice(-3000))
  done(1)
}, 180000)
