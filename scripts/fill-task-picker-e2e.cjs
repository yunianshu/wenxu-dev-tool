/**
 * E2E（真实 Electron + 本地 fake 禅道网关 + 沙箱主目录 + 真实 Git 仓库）：
 * 一键填报「绑定禅道任务」要能选到已完成的任务（完成后仍可能要补填工时）
 *
 * 需求（用户反馈）：任务完成后还需要填工时，但绑定弹窗只列「我的任务」（进行中），
 *   已完成的任务选不到；且列表要分组——进行中在上、已完成在下，已完成的只列一个月内的。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   D1 绑定弹窗出现「进行中」与「已完成（近一个月）」两个分组
 *   D2 进行中分组在上、已完成分组在下（DOM 顺序）
 *   D3 已完成分组只含近一个月完成的；两个月前关闭的不列出（已取消的也不列）
 *   D4 进行中条目显示剩余工时，已完成条目显示完成日期
 *   D5 选中已完成任务保存绑定 → 明细行显示该任务的禅道编号与名称（可继续填工时）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-task-picker-e2e.cjs
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-picker-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const REPO_ALPHA = path.join(SANDBOX, 'repo-alpha')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')

const P_ALPHA = 'fp_e2e_alpha'
const IDENTITY = { name: 'E2E任务选择用户', email: 'fill-picker@example.com' }
const TASK_DOING = 123
const TASK_DONE = 429 // 近一个月完成（要能选到）
const TASK_CLOSED_OLD = 2644 // 两个月前关闭（不该出现）
const TASK_CANCEL = 383 // 已取消（不该出现）

const pad = (n) => String(n).padStart(2, '0')
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const DONE_AT = daysAgo(3)
const OLD_CLOSED_AT = daysAgo(60)

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

/** 本地 fake 禅道网关：按 zentao-service 的真实调用序列实现（登录 + 两个任务列表 + 已有工时） */
function startFakeZentao() {
  const state = { paths: [] }
  const myWorkTasks = [
    { id: String(TASK_DOING), name: '进行中任务', status: 'doing', consumed: '1', left: '6', finishedDate: '0000-00-00 00:00:00', closedDate: '0000-00-00 00:00:00' },
  ]
  // 与真实实例同形（实测）：「指派给我」入口只列进行中 + 我关闭/取消的，**不含已完成**；
  // 已完成任务（含接手他人任务完成的）只能从 type=finishedBy 入口取到。
  const assignedTasks = [
    myWorkTasks[0],
    { id: String(TASK_CANCEL), name: '已取消任务', status: 'cancel', consumed: '1', left: '3', finishedDate: '0000-00-00 00:00:00', closedDate: '0000-00-00 00:00:00' },
    { id: String(TASK_CLOSED_OLD), name: '两个月前关闭任务', status: 'closed', consumed: '4', left: '0', finishedDate: '0000-00-00 00:00:00', closedDate: `${OLD_CLOSED_AT} 09:00:00` },
  ]
  const finishedByMeTasks = [
    { id: String(TASK_DONE), name: '已完成任务', status: 'done', consumed: '8', left: '0', finishedDate: `${DONE_AT} 15:20:00`, closedDate: '0000-00-00 00:00:00' },
    // 与「指派给我」入口重复：合并候选要按 id 去重
    { id: String(TASK_CLOSED_OLD), name: '两个月前关闭任务', status: 'closed', consumed: '4', left: '0', finishedDate: '0000-00-00 00:00:00', closedDate: `${OLD_CLOSED_AT} 09:00:00` },
  ]
  const allTasks = [...assignedTasks, ...finishedByMeTasks]
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    state.paths.push(url.pathname + url.search)
    const send = (body, type = 'text/html;charset=utf-8') => {
      res.writeHead(200, { 'Content-Type': type, 'Set-Cookie': 'zentaosid=e2e-sid; Path=/' })
      res.end(body)
    }
    // 登录序列：初始页 → 登录页 → 随机数 → POST 登录
    if (url.pathname === '/index.php' && url.searchParams.get('m') === 'user' && url.searchParams.get('f') === 'refreshRandom') return send('"e2e-rand"')
    if (url.searchParams.get('m') === 'user' && url.searchParams.get('f') === 'login') {
      if (req.method === 'POST') return send('{"result":"success"}', 'application/json;charset=utf-8')
      return send('<html>login</html>')
    }
    if (url.searchParams.get('m') === 'my' && url.searchParams.get('f') === 'work') {
      return send(JSON.stringify({ status: '200', data: JSON.stringify({ tasks: myWorkTasks }) }), 'application/json;charset=utf-8')
    }
    if (url.searchParams.get('m') === 'my' && url.searchParams.get('f') === 'task') {
      const tasks = url.searchParams.get('type') === 'finishedBy' ? finishedByMeTasks : assignedTasks
      return send(JSON.stringify({ status: '200', data: JSON.stringify({ tasks }) }), 'application/json;charset=utf-8')
    }
    if (url.searchParams.get('f') === 'recordEstimate') {
      return send(JSON.stringify({ status: '200', data: JSON.stringify({ efforts: [] }) }), 'application/json;charset=utf-8')
    }
    if (url.searchParams.get('f') === 'view') {
      const id = url.searchParams.get('taskID')
      const t = allTasks.find((x) => x.id === id)
      return send(JSON.stringify({ status: '200', data: JSON.stringify({ task: t || {} }) }), 'application/json;charset=utf-8')
    }
    return send('<html>ok</html>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }))
  })
}

function preseed(zentaoPort) {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(REPO_ALPHA, { recursive: true })
  git(REPO_ALPHA, ['init', '-q'])
  git(REPO_ALPHA, ['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, 'commit', '-q', '--allow-empty', '-m', 'feat: Alpha 提交一'])
  git(REPO_ALPHA, ['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, 'commit', '-q', '--allow-empty', '-m', 'fix: Alpha 提交二'])
  // 禅道指向本地 fake 网关（真实内网不可达、且不能对真实库写入）
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    roots: [SANDBOX],
    identities: [IDENTITY],
    zentao: {
      baseUrl: `http://127.0.0.1:${zentaoPort}`,
      account: 'e2e',
      pwdEnc: { plain: 'e2e-pwd' },
      lunchStart: '12:00',
      lunchEnd: '13:00',
    },
  }, null, 2))
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
  const viewReady = (ms = 25000) => waitFor(() => q('.fill-page') && q('.fill-page .project-select'), ms, 150)
  const rangeTip = () => norm(q('.fill-range-tip')?.textContent)
  const endSelect = () => q('.fill-toolbar .end-time-select')
  const timeOptionEls = () => [...document.querySelectorAll('.el-select-dropdown__item')]
    .filter((x) => /^\\d{2}:\\d{2}$/.test(norm(x.textContent)))
  const anyTimeOptionVisible = () => timeOptionEls().some((x) => x.offsetParent !== null)
  const pickTime = (t) => {
    const el = timeOptionEls().find((x) => norm(x.textContent) === t && x.offsetParent !== null)
    if (!el) return false
    el.click(); return true
  }
  const setEnd = async (t) => {
    await waitFor(() => !anyTimeOptionVisible(), 5000, 100)
    const sel = endSelect(); if (!sel) return false
    ;(sel.querySelector('.el-select__wrapper') || sel).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    if (!await waitFor(anyTimeOptionVisible, 6000)) return false
    const ok = pickTime(t)
    return ok && await waitFor(() => norm(endSelect().textContent).includes(t), 4000)
  }
  const fillSelect = () => q('.fill-page .project-select')
  const fillOptionEls = () => [...document.querySelectorAll('.el-select-dropdown__item')].filter((x) => x.querySelector('.project-option'))
  const dropdownOpen = () => fillOptionEls().some((x) => x.offsetParent !== null)
  const openDropdown = async () => {
    if (dropdownOpen()) return 'ok'
    const sel = fillSelect(); if (!sel) return 'no-select'
    ;(sel.querySelector('.el-select__wrapper') || sel).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return (await waitFor(dropdownOpen, 5000)) ? 'ok' : 'no-dropdown'
  }
  const optionByName = (name) => fillOptionEls().find((x) => norm(x.textContent).includes(name))
  const optionEnabled = (name) => { const o = optionByName(name); return !!(o && !o.classList.contains('is-disabled')) }
  const generateBtn = () => [...document.querySelectorAll('.fill-toolbar button')].find((b) => norm(b.textContent).includes('生成报告'))
  const generateEnabled = () => { const b = generateBtn(); return !!(b && !b.disabled) }
  const rowOf = (name) => [...document.querySelectorAll('.prow')].find((r) => norm(r.textContent).includes(name))
  // 绑定弹窗
  const bindBtn = () => [...document.querySelectorAll('.prow button')].find((b) => norm(b.textContent).includes('绑定禅道任务'))
  const dialogEl = () => [...document.querySelectorAll('.el-dialog')].find((d) => norm(d.textContent).includes('绑定禅道任务'))
  const bindSelect = () => { const d = dialogEl(); return d ? d.querySelector('.el-select') : null }
  const taskOptionEls = () => [...document.querySelectorAll('.el-select-dropdown__item')].filter((x) => x.querySelector('.task-option'))
  const visibleTaskOptions = () => taskOptionEls().filter((x) => x.offsetParent !== null)
  const openBindSelect = async () => {
    const sel = bindSelect(); if (!sel) return 'no-select'
    ;(sel.querySelector('.el-select__wrapper') || sel).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return (await waitFor(() => visibleTaskOptions().length > 0, 8000)) ? 'ok' : 'no-options'
  }
  /** 分组标题（进行中 / 已完成（近一个月））在弹窗内的先后顺序 */
  const groupLabels = () => [...document.querySelectorAll('.el-select-group__title')]
    .filter((x) => x.offsetParent !== null).map((x) => norm(x.textContent))
  /** 选项可见顺序（分组后按 DOM 顺序） */
  const optionTexts = () => visibleTaskOptions().map((x) => norm(x.textContent))
  const pickTaskOption = (text) => {
    const el = visibleTaskOptions().find((x) => norm(x.textContent).includes(text))
    if (!el) return false
    el.click(); return true
  }
  const bindInputValue = () => { const s = bindSelect(); return s ? norm(s.textContent) : '' }
  const saveBindBtn = () => { const d = dialogEl(); return d ? [...d.querySelectorAll('button')].find((b) => norm(b.textContent).includes('保存绑定')) : null }
  const dialogClosed = () => { const d = dialogEl(); return !d || d.offsetParent === null }
  /** 明细行的禅道绑定信息（#id + 任务名） */
  const rowMatch = () => { const r = rowOf('Alpha项目'); return r ? norm(r.querySelector('.pmatch')?.textContent) : '' }
  const sumLines = () => [...document.querySelectorAll('.sumline')].map((x) => norm(x.textContent))
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL = `(async () => {
  ${helpers}
  const r = {}
  const T0 = Date.now()
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }
  r.msViewReady = Date.now() - T0
  r.pickedEnd = await setEnd('18:00')
  r.rangeTip = await waitFor(() => rangeTip().includes('18:00'), 8000) ? rangeTip() : rangeTip()

  // 生成报告（禅道指向本地 fake 网关，任务列表来自它）
  if (await openDropdown() !== 'ok') { done(); return { ...r, fatal: '项目下拉未打开' } }
  r.alphaEnabled = await waitFor(() => optionEnabled('Alpha项目'), 25000)
  r.generateReady = await waitFor(generateEnabled, 6000)
  const gen = generateBtn()
  r.generated = !!gen
  const tGen = Date.now()
  if (gen) gen.click()
  r.rowAppeared = await waitFor(() => !!rowOf('Alpha项目'), 60000, 200)
  r.msGenerate = Date.now() - tGen
  r.phase = norm(q('.fill-phase')?.textContent)
  // 诊断：计划没出来时把页面上的提示与卡片标题带回来（区分「没有提交」/「项目未就绪」/「报错」）
  r.pageHints = [...document.querySelectorAll('.fill-page .el-alert__title, .fill-page .collect-hint, .fill-page .submit-hint, .fill-page .bind-tip, .el-message')]
    .map((x) => norm(x.textContent)).slice(0, 10)
  r.cardHeaders = [...document.querySelectorAll('.fill-page .card-header')].map((x) => norm(x.textContent))

  // D1/D2/D3/D4：打开绑定弹窗，看任务分组与内容
  const btn = bindBtn()
  r.bindBtnFound = !!btn
  if (btn) btn.click()
  r.dialogOpened = await waitFor(() => !!dialogEl(), 8000)
  r.selectOpened = await openBindSelect()
  r.groupLabels = groupLabels()
  r.options = optionTexts()

  // D5：选中已完成任务并保存绑定 → 明细行与禅道汇总都按该任务走（完成后仍可填工时）
  r.pickedDone = pickTaskOption('已完成任务')
  r.pickedValue = await waitFor(() => bindInputValue().includes('已完成任务'), 6000) ? bindInputValue() : bindInputValue()
  const save = saveBindBtn()
  r.saveBtnFound = !!save
  if (save) save.click()
  r.dialogClosed = await waitFor(dialogClosed, 10000)
  r.bound = await waitFor(() => rowMatch().includes('${TASK_DONE}'), 40000, 200)
  r.rowMatch = rowMatch()
  r.sumLines = sumLines()
  done()
  return r
})()`

/** 设置 E2E_EXE 时驱动打包产物（win-unpacked 可执行文件），否则用开发版 Electron。
 *  必须走异步 spawn：spawnSync 会阻塞父进程事件循环，本地 fake 网关就无法应答（请求全部超时）。 */
const EXE = process.env.E2E_EXE ? path.resolve(process.env.E2E_EXE) : ''

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '150000',
    SMOKE_VIEW: '一键填报',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  const bin = EXE || process.execPath
  const args = EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.']
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: EXE ? path.dirname(EXE) : ROOT, env })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const guard = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 180000)
    child.on('close', () => { clearTimeout(guard); resolve(out) })
  })
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

async function main() {
  console.log('=== 一键填报：绑定任务可选到已完成的禅道任务（D1–D4）===')
  const fake = await startFakeZentao()
  preseed(fake.port)
  try {
    const stdout = await launch(EVAL, 'fill-task-picker.png')
    const ev = parseEval(stdout)
    if (!ev) {
      console.log('  FAIL  未取到 eval 结果')
      console.log(`  stdout=${JSON.stringify(stdout.slice(-3000))}`)
      failed++
    } else {
      if (ev.fatal) assert('页面就绪', false, ev.fatal)
      assert('前置：选好下班时间并生成报告', ev.pickedEnd === true && ev.generated === true && ev.rowAppeared === true,
        `pickEnd=${ev.pickedEnd} gen=${ev.generated} row=${ev.rowAppeared} tip="${ev.rangeTip}"`)
      assert('绑定按钮存在且弹窗打开', ev.bindBtnFound === true && ev.dialogOpened === true, `btn=${ev.bindBtnFound} dialog=${ev.dialogOpened}`)
      assert('任务下拉可展开', ev.selectOpened === 'ok', `实际=${ev.selectOpened}`)
      // D1/D2：两个分组，进行中在上、已完成在下
      assert('D1/D2 分组为「进行中」在上、「已完成（近一个月）」在下',
        JSON.stringify(ev.groupLabels) === JSON.stringify(['进行中', '已完成（近一个月）']),
        `实际=${JSON.stringify(ev.groupLabels)}`)
      const opts = ev.options || []
      const idxDoing = opts.findIndex((t) => t.includes('进行中任务'))
      const idxDone = opts.findIndex((t) => t.includes('已完成任务'))
      assert('D2 进行中任务排在已完成任务之前', idxDoing >= 0 && idxDone >= 0 && idxDoing < idxDone,
        `进行中@${idxDoing} 已完成@${idxDone} 列表=${JSON.stringify(opts)}`)
      // D3：近一个月完成的列出，两个月前关闭的与已取消的不列
      assert('D3 近一个月完成的任务在列表中', idxDone >= 0 && opts[idxDone].includes(String(TASK_DONE)), `列表=${JSON.stringify(opts)}`)
      assert('D3 两个月前关闭的任务不列出', !opts.some((t) => t.includes(String(TASK_CLOSED_OLD))), `列表=${JSON.stringify(opts)}`)
      assert('D3 已取消的任务不列出', !opts.some((t) => t.includes(String(TASK_CANCEL))), `列表=${JSON.stringify(opts)}`)
      // D4：进行中显示剩余，已完成显示完成日期
      const doingText = idxDoing >= 0 ? opts[idxDoing] : ''
      const doneText = idxDone >= 0 ? opts[idxDone] : ''
      assert('D4 进行中条目显示剩余工时', /剩余 6h/.test(doingText), `实际="${doingText}"`)
      assert('D4 已完成条目显示完成日期', doneText.includes(DONE_AT), `实际="${doneText}"（期望含 ${DONE_AT}）`)
      // D5：选中已完成任务 → 保存绑定 → 明细与该任务的汇总（完成后仍可填工时）
      assert('D5 可选中已完成任务', ev.pickedDone === true && ev.pickedValue.includes('已完成任务'), `实际="${ev.pickedValue}"`)
      assert('D5 保存绑定后弹窗关闭且明细行显示该任务',
        ev.saveBtnFound === true && ev.dialogClosed === true && ev.bound === true,
        `save=${ev.saveBtnFound} closed=${ev.dialogClosed} row="${ev.rowMatch}"`)
      assert('D5 禅道汇总出现该已完成任务的工时',
        (ev.sumLines || []).some((l) => l.includes(String(TASK_DONE)) && l.includes('8.5h')),
        `汇总=${JSON.stringify(ev.sumLines)}`)
      if (failed) console.log('诊断数据:', JSON.stringify(ev, null, 1))
      console.log('fake 禅道收到的请求:', JSON.stringify(fake.state.paths))
    }
  } finally {
    fake.server.close()
  }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exit(1)
})
