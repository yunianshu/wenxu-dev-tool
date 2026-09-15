/**
 * 端到端验证（临时脚本）：头部「当前项目」切换后，活动报告页的数据区必须随之改变状态。
 *
 * 验收标准（源自需求「头部选择的当前项目，有影响的区域切换时要相应改变状态」）：
 *   A1 生成报告后：明细区显示当前项目（A）的提交
 *   A2 头部切到项目 B：明细区不再显示 A 的提交（旧数据不得当作 B 的报告展示）
 *   A3 切到 B 后给出明确指引（「已切换项目…重新收集」而非误导性的「无提交记录」）
 *   A4 切回项目 A：数据自动恢复（rawCommits 未被丢弃）
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/_diag-report-project-switch-e2e.cjs
 *       E2E_EXE=<打包产物exe> 时驱动打包版
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-report-switch-${Date.now()}`)
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

// ── 1. 沙箱：两个真实 git 仓库 + 两个项目 + 扫描根 ──
fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(REPO_ROOT, { recursive: true })
const repoA = makeRepo('e2e-repo-a', 'A 项目首个提交')
const repoB = makeRepo('e2e-repo-b', 'B 项目首个提交')

fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
  roots: [REPO_ROOT],
  excludes: ['node_modules'],
  identities: [AUTHOR],           // 「只看本人」默认开启，需与提交作者一致
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

  // 生成报告（当前项目 = A）
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

  // 切项目入口：顶栏那个独立的「当前项目」下拉已移除，改由工作台页顶栏标题旁的
  // 项目下拉承担（部署页同款）。切完再回到活动报告页看数据区是否跟随。
  const goMenu = async (label) => {
    const item = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.includes(label))
    if (item) item.click()
    await sleep(1500)
    return !!item
  }
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
    return {
      opened: false,
      html: root.outerHTML.slice(0, 260),
      drops: qa('.el-select-dropdown').length,
      visDrops: qa('.el-select-dropdown').filter(vis).length,
      items: qa('.el-select-dropdown__item').length,
    }
  }
  const pick = async (label) => {
    const o = await openSelect()
    const opt = qa('.el-select-dropdown__item').find((e) => vis(e) && e.textContent.trim() === label)
    if (opt) opt.click()
    await sleep(900)
    await goMenu('活动报告') // 回到报告页核对数据区
    return { ...o, clicked: !!opt }
  }

  // ── A2/A3：切到项目 B ──
  r.pickB = await pick('E2E项目B')
  r.summaryAfterB = (q('.detail-summary') || {}).textContent || ''
  r.commitsAfterB = commitTexts()
  r.alertAfterB = (q('.stale-alert') || {}).textContent || ''
  r.hintAfterB = (q('.collect-hint') || {}).textContent || ''
  r.kpiRangeAfterB = (q('.kpi-range') || {}).textContent || ''

  // ── A4：切回项目 A ──
  r.pickA = await pick('E2E项目A')
  r.summaryBackA = (q('.detail-summary') || {}).textContent || ''
  r.commitsBackA = commitTexts()
  r.alertBackA = (q('.stale-alert') || {}).textContent || ''

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
console.log(`=== 报告页「当前项目」切换一致性（${LABEL}） ===`)

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

  assert('A1 生成后明细显示当前项目 A 的提交',
    hasA(r.commitsInit), `summary="${r.summaryInit}" commits=${JSON.stringify(r.commitsInit)}`)
  assert('A2 切到项目 B 后明细不再显示 A 的提交',
    hasA(r.commitsInit) && !hasA(r.commitsAfterB),
    `summary="${r.summaryAfterB}" commits=${JSON.stringify(r.commitsAfterB)}`)
  assert('A3 切到 B 后给出「已切换项目」指引而非「无提交记录」',
    String(r.alertAfterB).includes('已切换项目') && !String(r.hintAfterB).includes('无提交记录'),
    `alert="${r.alertAfterB}" hint="${r.hintAfterB}"`)
  assert('A4 切回项目 A 后数据自动恢复',
    hasA(r.commitsBackA), `summary="${r.summaryBackA}" commits=${JSON.stringify(r.commitsBackA)}`)

  console.log(`  切换动作：B=${JSON.stringify(r.pickB)} A=${JSON.stringify(r.pickA)}`)
  console.log(`  活动源：${r.repoCountText} · 切B后KPI时间范围="${r.kpiRangeAfterB}"`)
  if (failed) console.log('原始数据:', JSON.stringify(r, null, 1))
  done(failed ? 1 : 0)
})

child.stderr.on('data', () => { /* 主进程日志噪音，忽略 */ })

const timer = setTimeout(() => {
  console.log('超时未取到 [SMOKE][eval] 结果，stdout 尾部：')
  console.log(stdout.slice(-3000))
  done(1)
}, 180000)
