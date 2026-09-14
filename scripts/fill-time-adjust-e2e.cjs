/**
 * E2E（真实 Electron + 沙箱主目录 + 真实 Git 仓库）：一键填报「生成报告后修改上班时间，工时跟着调整」
 *
 * 需求（用户反馈）：点「生成报告」之后才发现上班时间填错了，改完上班时间明细里的工时一动不动，
 *   还是按旧时间算的——必须再点一次「生成报告」才生效，而且改完时间再勾项目又会退回旧工时。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   A1 选好上下班时间（08:30–18:00）生成报告 → 明细行 8.5h、合计 8.50h、标题区间 08:30–18:00
 *   A2 只改上班时间为 09:30（不点「生成报告」）→ 工具条预览、明细行、合计、标题区间全部随之变为 7.5h
 *   A3 再改回 08:30 → 工时回到 8.5h（双向可逆）；提交内容（说明文本）不随工时改动而丢失
 *   A4 显式填写的跨夜终点语义不变：下班时间改 02:00 → 预览「次日 02:00」、合计 15.5h
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-time-adjust-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-time-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const REPO_ALPHA = path.join(SANDBOX, 'repo-alpha')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')

const P_ALPHA = 'ft_e2e_alpha'
const IDENTITY = { name: 'E2E改时用户', email: 'fill-time@example.com' }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

const pad = (n) => String(n).padStart(2, '0')
const yesterday = new Date(Date.now() - 86400000)
const YESTERDAY = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`

/** 用 author/committer 日期把提交固定到「昨天」，让历史日期填报有提交可收集 */
function realCommit(time, msg) {
  const r = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', msg], {
    cwd: REPO_ALPHA,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
      GIT_AUTHOR_DATE: `${YESTERDAY} ${time}:00 +0800`,
      GIT_COMMITTER_DATE: `${YESTERDAY} ${time}:00 +0800`,
    },
  })
  if (r.status !== 0) throw new Error(`git commit 失败：${r.stderr || r.stdout}`)
}

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(REPO_ALPHA, { recursive: true })
  git(REPO_ALPHA, ['init', '-q'])
  realCommit('09:12', 'feat: 完成改时需求')
  realCommit('14:05', 'fix: 修复工时未重算')
  // 禅道不配置：只验证计划生成与工时计算，不触网
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ roots: [SANDBOX], identities: [IDENTITY] }, null, 2))
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    projects: [{ id: P_ALPHA, name: 'Alpha项目', localPath: REPO_ALPHA }],
  }, null, 2))
}

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const q = (s) => document.querySelector(s)
  const waitFor = async (fn, ms = 8000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
    return false
  }
  const viewReady = (ms = 20000) => waitFor(() => q('.fill-page') && q('.fill-page .project-select'), ms, 150)
  const rangeTip = () => norm(q('.fill-range-tip')?.textContent)
  const startSelect = () => [...document.querySelectorAll('.fill-toolbar .el-select')].find((s) => !s.classList.contains('end-time-select'))
  const endSelect = () => q('.fill-toolbar .end-time-select')
  const timeOptionEls = () => [...document.querySelectorAll('.el-select-dropdown__item')]
    .filter((x) => /^\\d{2}:\\d{2}$/.test(norm(x.textContent)))
  // 下拉是 body 上的 popper：上一次选择后仍会短暂可见，必须先等它收起，
  // 否则「按文本找可见选项」会命中上一个下拉，把值填进错的输入框
  const anyTimeOptionVisible = () => timeOptionEls().some((x) => x.offsetParent !== null)
  const closeDropdown = () => waitFor(() => !anyTimeOptionVisible(), 5000, 100)
  const openSelect = async (sel) => {
    if (!sel) return false
    await closeDropdown()
    const trigger = sel.querySelector('.el-select__wrapper') || sel
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return waitFor(() => anyTimeOptionVisible(), 6000)
  }
  const pickTime = (t) => {
    const el = timeOptionEls().find((x) => norm(x.textContent) === t && x.offsetParent !== null)
    if (!el) return false
    el.click(); return true
  }
  const shownTime = (sel) => norm(sel ? sel.textContent : '')
  const setStart = async (t) => {
    if (!await openSelect(startSelect())) return false
    const ok = pickTime(t)
    return ok && await waitFor(() => shownTime(startSelect()).includes(t), 4000)
  }
  const setEnd = async (t) => {
    if (!await openSelect(endSelect())) return false
    const ok = pickTime(t)
    return ok && await waitFor(() => shownTime(endSelect()).includes(t), 4000)
  }
  const openDatePanel = async () => {
    const editor = q('.fill-toolbar .el-date-editor')
    if (!editor) return 'no-editor'
    const input = editor.querySelector('input')
    if (!input) return 'no-input'
    input.focus()
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const ok = await waitFor(() => [...document.querySelectorAll('.el-picker-panel__shortcut')].some((x) => x.offsetParent !== null), 6000)
    return ok ? 'ok' : 'no-panel'
  }
  const pickDateShortcut = (text) => {
    const el = [...document.querySelectorAll('.el-picker-panel__shortcut')]
      .find((x) => norm(x.textContent) === text && x.offsetParent !== null)
    if (!el) return false
    el.click(); return true
  }
  const fillSelect = () => q('.fill-page .project-select')
  const fillOptionEls = () => [...document.querySelectorAll('.el-select-dropdown__item')].filter((x) => x.querySelector('.project-option'))
  const dropdownOpen = () => fillOptionEls().some((x) => x.offsetParent !== null)
  const openDropdown = async () => {
    if (dropdownOpen()) return 'ok'
    const sel = fillSelect(); if (!sel) return 'no-select'
    const trigger = sel.querySelector('.el-select__wrapper') || sel
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return (await waitFor(dropdownOpen, 5000)) ? 'ok' : 'no-dropdown'
  }
  const optionByName = (name) => fillOptionEls().find((x) => norm(x.textContent).includes(name))
  const optionEnabled = (name) => { const o = optionByName(name); return !!(o && !o.classList.contains('is-disabled')) }
  const pickOption = (name) => { const o = optionByName(name); if (!o) return false; o.click(); return true }
  const generateBtn = () => [...document.querySelectorAll('.fill-toolbar button')].find((b) => norm(b.textContent).includes('生成报告'))
  const generateEnabled = () => { const b = generateBtn(); return !!(b && !b.disabled) }
  const rowOf = (name) => [...document.querySelectorAll('.prow')].find((r) => norm(r.textContent).includes(name))
  const rowHours = () => { const r = rowOf('Alpha项目'); return r ? norm(r.querySelector('.phours')?.textContent) : '' }
  const rowWork = () => { const r = rowOf('Alpha项目'); return r ? norm(r.querySelector('.pwork')?.textContent) : '' }
  const cardHeaders = () => [...document.querySelectorAll('.fill-page .card-header')].map((x) => norm(x.textContent)).join(' | ')
  const dateInputValue = () => (q('.fill-toolbar .el-date-editor input') || {}).value || ''
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }

  // 前置：昨天 + 上班 08:30 + 下班 18:00（显式终点，工时与当前时刻无关）
  r.datePanelOpened = await openDatePanel()
  r.pickedYesterday = pickDateShortcut('昨天')
  r.dateApplied = await waitFor(() => dateInputValue() === '${YESTERDAY}', 8000)
  r.pickedStart = await setStart('08:30')
  r.pickedEnd = await setEnd('18:00')
  r.shownStart = shownTime(startSelect())
  r.shownEnd = shownTime(endSelect())
  r.tipReady = await waitFor(() => rangeTip().includes('18:00'), 6000)
  r.rangeTipBefore = rangeTip()

  // A1：生成报告 → 08:30→18:00 扣午休 = 8.5h
  if (await openDropdown() !== 'ok') { done(); return { ...r, fatal: '项目下拉未打开' } }
  await waitFor(() => optionEnabled('Alpha项目'), 25000)
  r.picked = pickOption('Alpha项目')
  r.generateReady = await waitFor(generateEnabled, 6000)
  const gen = generateBtn()
  r.generated = !!gen
  if (gen) gen.click()
  r.rowAppeared = await waitFor(() => !!rowOf('Alpha项目'), 30000, 200)
  r.headersAfterGen = cardHeaders()
  r.rowHoursAfterGen = rowHours()
  r.rowWorkAfterGen = rowWork()

  // A2：只改上班时间（不点「生成报告」）→ 工时自动变 7.5h
  r.movedStart = await setStart('09:30')
  r.tipMoved = await waitFor(() => rangeTip().includes('09:30') && rangeTip().includes('7.5'), 10000)
  r.rangeTipAfterMove = rangeTip()
  r.moved = await waitFor(() => rowHours() === '7.5h', 10000)
  r.headersAfterMove = cardHeaders()
  r.rowHoursAfterMove = rowHours()
  r.rowWorkAfterMove = rowWork()

  // A3：再改回 08:30 → 回到 8.5h
  r.restoredStart = await setStart('08:30')
  r.restored = await waitFor(() => rowHours() === '8.5h', 10000)
  r.headersAfterRestore = cardHeaders()
  r.rowHoursAfterRestore = rowHours()

  // A4：下班时间改成 02:00（早于上班时间）→ 次日跨夜：08:30→次日 02:00 = 16.5h
  r.pickedOvernight = await setEnd('02:00')
  r.overnightTip = await waitFor(() => rangeTip().includes('次日 02:00'), 10000)
  r.rangeTipOvernight = rangeTip()
  r.overnight = await waitFor(() => rowHours() === '16.5h', 10000)
  r.headersAfterOvernight = cardHeaders()
  r.rowHoursAfterOvernight = rowHours()
  done()
  return r
})()`

/** 设置 E2E_EXE 时驱动打包产物（win-unpacked 可执行文件），否则用开发版 Electron。
 *  必须转绝对路径：spawnSync 的 cwd 会改变相对路径的解析基准。 */
const EXE = process.env.E2E_EXE ? path.resolve(process.env.E2E_EXE) : ''

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '180000',
    SMOKE_VIEW: '一键填报',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  const bin = EXE || process.execPath
  const args = EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.']
  return spawnSync(bin, args, { cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: 240000, env })
}

function parseEval(stdout) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes('[SMOKE][eval]')) {
      try { return JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim()) } catch { return null }
    }
  }
  return null
}

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

console.log(`=== 一键填报：生成后改上班时间同步工时（A1–A4，昨天=${YESTERDAY}）===`)
preseed()

const p = launch(EVAL, 'fill-time-adjust.png')
const ev = parseEval(p.stdout || '')
if (!ev) {
  console.log('  FAIL  未取到 eval 结果')
  console.log(`  status=${p.status} signal=${p.signal} error=${p.error && p.error.message}`)
  console.log(`  stdout=${JSON.stringify((p.stdout || '').slice(-3000))}`)
  console.log(`  stderr=${JSON.stringify((p.stderr || '').slice(-1500))}`)
  failed++
} else {
  if (ev.fatal) assert('页面就绪', false, ev.fatal)
  assert('前置：切到昨天 + 选好上下班时间',
    ev.dateApplied === true && ev.pickedStart === true && ev.pickedEnd === true && ev.tipReady === true,
    `date=${ev.dateApplied} start=${ev.pickedStart} end=${ev.pickedEnd} 上班框="${ev.shownStart}" 下班框="${ev.shownEnd}" tip="${ev.rangeTipBefore}"`)
  assert('前置：预览 08:30–18:00 · 预计 8.5h', ev.rangeTipBefore === '08:30–18:00 · 预计 8.5h', `实际="${ev.rangeTipBefore}"`)
  assert('A1 生成报告后出现明细行', ev.picked === true && ev.generated === true && ev.rowAppeared === true,
    `picked=${ev.picked} gen=${ev.generated} row=${ev.rowAppeared}`)
  assert('A1 标题区间 08:30–18:00', String(ev.headersAfterGen).includes('08:30–18:00'), `实际="${ev.headersAfterGen}"`)
  assert('A1 合计 8.50h', String(ev.headersAfterGen).includes('8.50h'), `实际="${ev.headersAfterGen}"`)
  assert('A1 项目行工时 8.5h', ev.rowHoursAfterGen === '8.5h', `实际="${ev.rowHoursAfterGen}"`)
  assert('A2 改上班时间为 09:30 后预览与之同步', ev.rangeTipAfterMove === '09:30–18:00 · 预计 7.5h', `实际="${ev.rangeTipAfterMove}"`)
  assert('A2 未点「生成报告」，明细行自动变 7.5h', ev.moved === true && ev.rowHoursAfterMove === '7.5h', `实际="${ev.rowHoursAfterMove}"`)
  assert('A2 合计随之变 7.50h', String(ev.headersAfterMove).includes('7.50h'), `实际="${ev.headersAfterMove}"`)
  assert('A2 标题区间变 09:30–18:00', String(ev.headersAfterMove).includes('09:30–18:00'), `实际="${ev.headersAfterMove}"`)
  assert('A3 改回 08:30 → 工时回到 8.5h', ev.restored === true && ev.rowHoursAfterRestore === '8.5h', `实际="${ev.rowHoursAfterRestore}"`)
  assert('A3 提交内容（说明文本）未丢失',
    ev.rowWorkAfterMove !== '' && ev.rowWorkAfterMove === ev.rowWorkAfterGen,
    `生成后="${ev.rowWorkAfterGen}" 改时后="${ev.rowWorkAfterMove}"`)
  assert('A4 下班改 02:00 → 预览次日跨夜',
    ev.overnightTip === true && ev.rangeTipOvernight === '08:30–次日 02:00 · 预计 16.5h', `实际="${ev.rangeTipOvernight}"`)
  assert('A4 明细行按跨夜重算 16.5h', ev.overnight === true && ev.rowHoursAfterOvernight === '16.5h', `实际="${ev.rowHoursAfterOvernight}"`)
  assert('A4 合计 16.50h', String(ev.headersAfterOvernight).includes('16.50h'), `实际="${ev.headersAfterOvernight}"`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev, null, 1))
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
