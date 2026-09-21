/**
 * E2E（真实 Electron + 沙箱主目录 + 真实 Git 仓库 + 本地 fake 禅道/汉印网关）：
 * 一键填报「提交留痕与重新提交」+「仅失败记录可重提」+「删除记录」+「禅道响应异常回查核实」
 *
 * 起因（2026-09-18 用户报障）：当天 4 项（禅道 2 任务 + 汉印 2 条）只成功 1 项——
 * 禅道 recordEstimate POST 实际已写入但响应体非 JSON，旧实现直接抛错中止，
 * 剩余任务与汉印全部漏交，且无日志可回溯、无安全的补交入口。
 * 后续需求（2026-09-21）：成功记录不需要重新提交（只留失败记录的重放入口），且记录可删除。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   R1 响应异常不中止：POST 返回空 body（非 JSON）但服务端已写入时，回查当日工时
 *      逐行匹配 → 按已写入继续，后续任务与汉印照常提交（整体成功，不再出现只成功 1 项）
 *   R2 部分失败可回溯：某任务真失败（响应非 JSON 且回查无匹配）时，fill-log 留痕
 *      分项结果（已写入任务/断点环节/响应原文/完整提交载荷），错误信息标明已写入进度
 *   R3 提交记录面板：页面展示最近提交（状态/分项计数/错误），失败条目提供「重新提交」
 *   R4 重新提交补全：按留痕载荷重放，此前已写入的任务更新覆盖（复用已有记录 ID），
 *      失败任务补写入，汉印照常提交；重放自身也留痕
 *   R5 只有失败记录才需要重新提交：成功记录（禅道全部写入并核实 + 汉印已写入）不显示
 *      「重新提交」，服务层同样拒绝重放成功记录且不产生任何平台写入
 *   R6 删除记录：每条记录可删除（只清本机留痕，不动平台已写入的工时），删除后记录面板
 *      与 fill-log.json 同步移除该条，其余记录（含失败条目的载荷）不受影响
 *
 * 场景（fake 禅道按「该任务第 N 次 POST」分流，无需外部模式切换）：
 *   第 1 轮（今天）：两任务 POST 均返回空 body 但照常写入 → 全部 verified → 成功
 *   第 2 轮（昨天补填）：任务 A 正常成功；任务 B 返回 HTML 且不写入 → 真失败（1/2）
 *   第 3 轮（重新提交）：全部正常 → A 复用已有记录 ID 更新、B 补写入、汉印 add
 *   第 4 轮（面板操作）：成功记录无「重新提交」→ 服务层拒绝重放 → 删除今天那条留痕
 *
 * 边界：真实内网平台不可达且不可写，禅道/汉印均以本地 fake 网关替代（协议同形）；
 *       写入路径由真实 fill-service/zentao-service 客户端经真实 HTTP 发起。
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-resubmit-e2e.cjs   （E2E_EXE 指向打包产物可驱动 win-unpacked）
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-resub-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const REPO_A = path.join(SANDBOX, 'repo-a')
const REPO_B = path.join(SANDBOX, 'repo-b')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')
const BINDINGS_FILE = path.join(USER_DATA, 'fill-bindings.json')
const LOG_FILE = path.join(USER_DATA, 'fill-log.json')

const P_A = 'fr_e2e_a'
const P_B = 'fr_e2e_b'
const TASK_A = 66
const TASK_B = 88
const IDENTITY = { name: 'E2E重提用户', email: 'fill-resub@example.com' }

function git(cwd, args, extraEnv) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: extraEnv ? { ...process.env, ...extraEnv } : process.env })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

/** 真实 Git 仓库：今天的提交（默认时间）+ 昨天的提交（GIT_AUTHOR_DATE/COMMITTER_DATE 定制） */
function createRepo(dir, todayMsg, yesterdayMsg) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  const yesterdayIso = new Date(Date.now() - 86400000).toISOString()
  const base = ['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, 'commit', '-q', '--allow-empty']
  git(dir, [...base, '-m', yesterdayMsg], { GIT_AUTHOR_DATE: yesterdayIso, GIT_COMMITTER_DATE: yesterdayIso })
  git(dir, [...base, '-m', todayMsg])
}

/**
 * fake 禅道网关：efforts 按任务持久在内存（POST 写入、GET 回读），POST 行为按
 * 「该任务第 N 次提交」分流，模拟「已写入但响应非 JSON」与「真失败」两类现场。
 */
function startFakeZentao() {
  const state = { posts: [], efforts: {}, nextId: 900 }
  const postCount = {}
  const myWorkTasks = [
    { id: String(TASK_A), name: '重提任务A', status: 'doing', consumed: '1', left: '10' },
    { id: String(TASK_B), name: '重提任务B', status: 'doing', consumed: '1', left: '10' },
  ]
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (body, type = 'application/json;charset=utf-8') => {
      res.writeHead(200, { 'Content-Type': type, 'Set-Cookie': 'zentaosid=e2e-sid; Path=/' })
      res.end(body)
    }
    if (url.searchParams.get('m') === 'user' && url.searchParams.get('f') === 'refreshRandom') return send('"e2e-rand"')
    if (url.searchParams.get('m') === 'user' && url.searchParams.get('f') === 'login') {
      if (req.method === 'POST') return send('{"result":"success"}')
      return send('<html>login</html>')
    }
    if (url.searchParams.get('m') === 'my' && url.searchParams.get('f') === 'work') {
      return send(JSON.stringify({ status: '200', data: JSON.stringify({ tasks: myWorkTasks }) }))
    }
    if (url.searchParams.get('f') === 'view') {
      const id = url.searchParams.get('taskID')
      const t = myWorkTasks.find((x) => x.id === id) || {}
      return send(JSON.stringify({ status: '200', data: JSON.stringify({ task: t }) }))
    }
    if (url.searchParams.get('f') === 'recordEstimate') {
      const taskId = url.searchParams.get('taskID')
      if (req.method !== 'POST') {
        return send(JSON.stringify({ status: '200', data: JSON.stringify({ efforts: state.efforts[taskId] || [] }) }))
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const form = {}
        for (const pair of body.split('&')) {
          const idx = pair.indexOf('=')
          form[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '))
        }
        postCount[taskId] = (postCount[taskId] || 0) + 1
        const n = postCount[taskId]
        const apply = () => {
          const rows = Object.keys(form).filter((k) => k.startsWith('dates[')).map((k) => {
            const key = k.slice(6, -1)
            return {
              id: Number(key) >= 900 ? Number(key) : (state.nextId += 1),
              date: form[`dates[${key}]`],
              work: form[`work[${key}]`],
              consumed: Number(form[`consumed[${key}]`]),
              left: Number(form[`left[${key}]`]),
            }
          })
          const list = state.efforts[taskId] || []
          for (const row of rows) {
            const hit = list.find((x) => x.id === row.id)
            if (hit) Object.assign(hit, row)
            else list.push(row)
          }
          state.efforts[taskId] = list
        }
        state.posts.push({ taskId, n, keys: Object.keys(form).filter((k) => k.startsWith('dates[')) })
        if (n === 1) {
          apply() // 第 1 轮：已写入但响应为空 body（非 JSON）→ 客户端须回查核实
          return send('')
        }
        if (taskId === String(TASK_B) && n === 2) {
          // 第 2 轮任务 B：真失败——响应 HTML 且不写入
          return send('<html>gateway error</html>', 'text/html;charset=utf-8')
        }
        apply()
        return send('{"result":"success"}')
      })
      return undefined
    }
    return send('<html>ok</html>', 'text/html;charset=utf-8')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }))
  })
}

/** fake 汉印网关：全成功，记录 add 提交体（GetByDate 恒空 → 条目全新增） */
function startFakeHanprint() {
  const state = { addBodies: [] }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const json = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf8' })
      res.end(JSON.stringify(obj))
    }
    if (url.pathname === '/login/getToken') return json({ code: 0, data: 'e2e-token' })
    if (url.pathname === '/com/workhour/GetDict') return json({ code: 0, data: [{ Key: 3, Name: '软件项目' }] })
    if (url.pathname === '/com/workhour/GetProjectList') return json({ code: 0, data: [{ Key: 799, Name: 'E2E汉印项目' }] })
    if (url.pathname === '/com/workhour/GetProjectTaskList') {
      return json({ code: 0, data: [{ Key: String(TASK_A), Name: '重提任务A' }, { Key: String(TASK_B), Name: '重提任务B' }] })
    }
    if (url.pathname === '/com/workhour/GetByDate') return json({ code: 0, data: [] })
    if (url.pathname === '/com/workhour/add') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { state.addBodies.push(body); json({ code: 0, msg: 'ok' }) })
      return undefined
    }
    return json({ code: 0, data: null })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }))
  })
}

function preseed(ztPort, hpPort) {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  createRepo(REPO_A, 'feat: Alpha 今日提交', 'fix: Alpha 昨日提交')
  createRepo(REPO_B, 'feat: Beta 今日提交', 'refactor: Beta 昨日提交')
  const cfg = {
    roots: [SANDBOX],
    identities: [IDENTITY],
    zentao: { baseUrl: `http://127.0.0.1:${ztPort}`, account: 'e2e', pwdEnc: { plain: 'e2e-pwd' } },
    hanprint: { baseUrl: `http://127.0.0.1:${hpPort}`, clientId: '1', account: 'E2E工号', pwdEnc: { plain: 'e2e-pwd' } },
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    projects: [
      { id: P_A, name: 'Alpha项目', localPath: REPO_A },
      { id: P_B, name: 'Beta项目', localPath: REPO_B },
    ],
  }, null, 2))
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify({
    [P_A]: { taskId: TASK_A, taskName: '重提任务A', boundAt: new Date().toISOString() },
    [P_B]: { taskId: TASK_B, taskName: '重提任务B', boundAt: new Date().toISOString() },
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
  const generateBtn = () => [...document.querySelectorAll('.fill-toolbar button')].find((b) => norm(b.textContent).includes('生成报告'))
  const submitBtn = () => [...document.querySelectorAll('.fill-actions button')].find((b) => norm(b.textContent).includes('一键提交') || norm(b.textContent).includes('已提交'))
  const submitEnabled = () => { const b = submitBtn(); return !!(b && !b.disabled) }
  const rowOf = (name) => [...document.querySelectorAll('.prow')].find((r) => norm(r.textContent).includes(name))
  const boxBtn = (text) => { const box = q('.el-message-box'); return box ? [...box.querySelectorAll('button')].find((b) => norm(b.textContent) === text) : null }
  const confirmBtn = () => boxBtn('提交')
  const toasts = () => [...document.querySelectorAll('.el-message')].map((x) => norm(x.textContent))
  const waitToasts = async (ms) => { const seen = new Set(); const t0 = Date.now(); while (Date.now() - t0 < ms) { toasts().forEach((t) => seen.add(t)); await sleep(150) } return [...seen] }
  const logLines = () => [...document.querySelectorAll('.logline')].map((x) => norm(x.textContent))
  const logLineEls = () => [...document.querySelectorAll('.logline')]
  const lineBtn = (el, text) => [...el.querySelectorAll('button')].find((b) => norm(b.textContent).includes(text))
  const logTime = (el) => norm(el.querySelector('.log-time')?.textContent || '')
  const dateShortcuts = () => [...document.querySelectorAll('.el-picker-panel__shortcut')]
  const pickYesterday = async () => {
    const inp = q('.fill-toolbar .el-date-editor input'); if (!inp) return false
    inp.focus()
    inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    if (!await waitFor(() => dateShortcuts().some((x) => x.offsetParent !== null), 6000)) return false
    const el = dateShortcuts().find((x) => norm(x.textContent).includes('昨天'))
    if (!el) return false
    el.click()
    return waitFor(() => dateShortcuts().every((x) => x.offsetParent === null), 5000)
  }
  const doSubmit = async () => {
    const btn = submitBtn()
    if (!btn || btn.disabled) return 'no-btn'
    btn.click()
    if (!await waitFor(() => !!confirmBtn(), 8000)) return 'no-confirm'
    confirmBtn().click()
    return 'sent'
  }
  const done = () => setTimeout(() => window.close(), 400)
`

/** 四轮：今天成功（回查核实）→ 昨天部分失败（留痕）→ 重新提交补全 → 仅失败可重提 + 删除记录 */
const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }
  await waitFor(submitEnabled, 30000) // 仓库扫描就绪后生成按钮可用

  // ── 第 1 轮（今天）：两任务 POST 响应均为空 body 但已写入 → 整体成功
  const gen1 = generateBtn()
  r.gen1 = !!gen1
  if (gen1) gen1.click()
  r.round1Rows = await waitFor(() => !!rowOf('Alpha项目') && !!rowOf('Beta项目'), 60000, 200)
  r.round1Ready = await waitFor(submitEnabled, 15000)
  r.round1 = await doSubmit()
  r.round1Toasts = await waitToasts(15000)
  r.round1Done = await waitFor(() => norm(submitBtn()?.textContent).includes('已提交'), 20000)

  // ── 第 2 轮（昨天）：任务 B 真失败 → 错误带进度 + 提交记录面板出现失败条目
  r.pickedYesterday = await pickYesterday()
  const gen2 = generateBtn()
  r.gen2 = !!gen2
  if (gen2) gen2.click()
  r.round2Rows = await waitFor(() => !!rowOf('Alpha项目'), 60000, 200)
  r.round2Ready = await waitFor(submitEnabled, 15000)
  r.round2 = await doSubmit()
  r.round2Toasts = await waitToasts(15000)
  r.round2Logs = await waitFor(() => logLines().length >= 2, 20000, 200) ? logLines() : logLines()

  // ── 第 3 轮：失败条目「重新提交」→ 补全并整体成功
  const failLine = [...document.querySelectorAll('.logline')].reverse()
    .find((l) => l.querySelector('.el-tag--danger'))
  r.failLineText = failLine ? norm(failLine.textContent) : ''
  const rebtn = failLine && lineBtn(failLine, '重新提交')
  r.rebtnFound = !!rebtn
  if (rebtn) {
    rebtn.click()
    if (await waitFor(() => !!confirmBtn(), 8000)) confirmBtn().click()
  }
  r.round3Toasts = await waitToasts(20000)
  r.round3Done = await waitFor(() => norm(submitBtn()?.textContent).includes('已提交'), 25000)
  r.logsAfter = logLines()

  // ── R5：只有失败记录显示「重新提交」（成功记录不再提供）
  const lines = logLineEls()
  r.lineTags = lines.map((l) => (l.querySelector('.el-tag--danger') ? 'fail' : 'ok'))
  r.successWithResub = lines.filter((l) => l.querySelector('.el-tag--success') && lineBtn(l, '重新提交')).length
  r.failWithResub = lines.filter((l) => l.querySelector('.el-tag--danger') && lineBtn(l, '重新提交')).length
  r.successCount = lines.filter((l) => l.querySelector('.el-tag--success')).length
  r.failCount = lines.filter((l) => l.querySelector('.el-tag--danger')).length
  const svc = await window.gitReport.fillLog(20)
  r.svcFlags = (svc.entries || []).map((e) => ({
    at: e.at,
    date: e.date,
    failed: !!e.failed,
    resubmittable: !!e.resubmittable,
    ztTasks: (e.tasks || []).length,
    verifiedAll: (e.tasks || []).length > 0 && (e.tasks || []).every((t) => t.verified === true),
    ztTotal: e.ztTotal,
    hpSent: e.hp && e.hp.sent ? e.hp.sent : 0,
    hpError: (e.hp && e.hp.error) || '',
    error: e.error || '',
  }))
  const okEntry = (svc.entries || []).find((e) => !e.failed)
  // 服务层同样拒绝重放成功记录（若守卫失效会真重放，平台写入次数与留痕条数断言会一并暴露）
  const refuse = okEntry ? await window.gitReport.fillResubmit(okEntry.at) : null
  r.resubmitRefused = refuse ? refuse.ok === false : null
  r.refuseError = refuse ? (refuse.error || '') : ''
  r.logsAfterRefuse = logLines()

  // ── R6：删除记录（删今天那条成功留痕，昨日两条保留）
  const delTarget = lines.filter((l) => l.querySelector('.el-tag--success')).pop()
  r.delTargetTime = delTarget ? logTime(delTarget) : ''
  const dbtn = delTarget && lineBtn(delTarget, '删除')
  r.delBtnFound = !!dbtn
  if (dbtn) {
    dbtn.click()
    if (await waitFor(() => !!boxBtn('删除'), 8000)) boxBtn('删除').click()
  }
  r.delToastSeen = await waitFor(() => toasts().some((t) => t.includes('已删除')), 10000)
  r.delSettled = await waitFor(() => logLineEls().length === lines.length - 1, 12000, 150)
  r.logsAfterDelete = logLines()
  r.timesAfterDelete = logLineEls().map(logTime)
  r.failKept = logLineEls().filter((l) => l.querySelector('.el-tag--danger')).length
  done()
  return r
})()`

const EXE = process.env.E2E_EXE ? path.resolve(process.env.E2E_EXE) : ''

/** 必须异步 spawn：spawnSync 会阻塞父进程事件循环，本地 fake 网关就无法应答 */
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
    const guard = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 210000)
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
  console.log('=== 一键填报：提交留痕、重新提交与删除记录（R1–R6）===')
  const zt = await startFakeZentao()
  const hp = await startFakeHanprint()
  preseed(zt.port, hp.port)
  let stdout = ''
  try {
    stdout = await launch(EVAL, 'fill-resubmit.png')
    const ev = parseEval(stdout)
    console.log('页面结果:', JSON.stringify(ev, null, 1))

    if (!ev || ev.fatal) {
      assert('一键填报页就绪并完成四轮交互', false, (ev && ev.fatal) || 'EVAL 未返回结果')
    } else {
      // R1 响应异常不中止：整体成功（按钮变「已提交」），无失败提示
      assert('R1 第 1 轮提交整体成功（回查核实后继续）', ev.round1 === 'sent' && ev.round1Done === true,
        JSON.stringify({ round1: ev.round1, round1Done: ev.round1Done, toasts: ev.round1Toasts }))
      assert('R1 成功提示含 2 个禅道任务与汉印', ev.round1Toasts.some((t) => t.includes('已提交') && t.includes('2 个任务') && t.includes('汉印')),
        JSON.stringify(ev.round1Toasts))

      // R2 部分失败：错误标明进度、面板出现失败条目
      assert('R2 第 2 轮失败提示标明已写入进度 1/2', ev.round2Toasts.some((t) => t.includes('无法确认') && t.includes('1/2')),
        JSON.stringify(ev.round2Toasts))
      assert('R2 提交记录面板出现失败条目（禅道 1/2）', ev.round2Logs.some((l) => l.includes('失败') && l.includes('禅道 1/2')),
        JSON.stringify(ev.round2Logs))

      // R3/R4 重新提交：按钮存在且重放后整体成功
      assert('R3 失败条目提供「重新提交」按钮', ev.rebtnFound === true, ev.failLineText)
      assert('R4 重新提交补全（按钮变「已提交」）', ev.round3Done === true,
        JSON.stringify({ toasts: ev.round3Toasts, logs: ev.logsAfter }))

      // R5 只有失败记录才需要重新提交（删前快照：成功/失败/成功 三条）
      const flags = ev.svcFlags || []
      assert('R5 删前留痕三条且仅一条失败', flags.length === 3 && flags.filter((f) => f.failed).length === 1,
        JSON.stringify(flags))
      assert('R1 成功条目：2 任务均标记 verified（回查核实）+ 汉印 2 条',
        flags[2] && flags[2].failed === false && flags[2].ztTasks === 2 && flags[2].verifiedAll === true && flags[2].hpSent === 2,
        JSON.stringify(flags[2]))
      assert('R2 失败条目：分项 1/2 + 错误原文 + 可重提',
        flags[1] && flags[1].failed === true && flags[1].resubmittable === true && flags[1].ztTasks === 1 && flags[1].ztTotal === 2 && /1\/2/.test(flags[1].error),
        JSON.stringify(flags[1]))
      assert('R4 重放条目：整体成功（2 任务、无错误、汉印 2 条）',
        flags[0] && flags[0].failed === false && flags[0].ztTasks === 2 && !flags[0].error && flags[0].hpSent === 2,
        JSON.stringify(flags[0]))
      assert('R5 成功记录不标记可重提（界面上 2 条成功均无「重新提交」）',
        flags.filter((f) => !f.failed).every((f) => f.resubmittable === false) && ev.successCount === 2 && ev.successWithResub === 0,
        JSON.stringify({ flags, successCount: ev.successCount, successWithResub: ev.successWithResub }))
      assert('R5 失败记录仍带「重新提交」', ev.failCount === 1 && ev.failWithResub === 1,
        JSON.stringify({ failCount: ev.failCount, failWithResub: ev.failWithResub }))
      assert('R5 服务层拒绝重放成功记录', ev.resubmitRefused === true && /已提交成功/.test(String(ev.refuseError || '')),
        JSON.stringify({ refused: ev.resubmitRefused, error: ev.refuseError }))

      // R6 删除记录：删除今天那条成功留痕，其余记录与失败条目不受影响
      assert('R6 每条记录都有「删除」按钮', ev.delBtnFound === true, String(ev.delTargetTime))
      assert('R6 删除后记录面板只剩 2 条', ev.delSettled === true && (ev.logsAfterDelete || []).length === 2,
        JSON.stringify({ settled: ev.delSettled, logs: ev.logsAfterDelete }))
      assert('R6 被删记录不再显示（时间戳消失）',
        ev.delTargetTime && !(ev.timesAfterDelete || []).includes(ev.delTargetTime),
        JSON.stringify({ deleted: ev.delTargetTime, times: ev.timesAfterDelete }))
      assert('R6 失败记录保留（仍可重新提交）', ev.failKept === 1, String(ev.failKept))
    }
  } finally {
    zt.server.close()
    hp.server.close()
  }

  // ── 服务端与留痕断言（应用退出后读 fake 网关状态与 fill-log.json）──
  const ztA = (zt.state.efforts[String(TASK_A)] || [])
  const ztB = (zt.state.efforts[String(TASK_B)] || [])
  const today = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const yd = new Date(Date.now() - 86400000)
  const yesterdayStr = `${yd.getFullYear()}-${pad(yd.getMonth() + 1)}-${pad(yd.getDate())}`

  assert('R1 两任务当天均有工具写入的工时记录', ztA.some((e) => e.date === todayStr) && ztB.some((e) => e.date === todayStr),
    JSON.stringify({ ztA: ztA.map((e) => e.date), ztB: ztB.map((e) => e.date) }))
  assert('R4 任务 B 补写入昨日工时', ztB.some((e) => e.date === yesterdayStr), JSON.stringify(ztB.map((e) => e.date)))
  assert('R4 任务 A 昨日记录为更新覆盖（复用已有记录 ID）', (() => {
    const rec = ztA.find((e) => e.date === yesterdayStr)
    return !!rec && zt.state.posts.some((p) => p.taskId === String(TASK_A) && p.keys.includes(`dates[${rec.id}]`))
  })(), JSON.stringify({ ztA, posts: zt.state.posts }))
  assert('R5 拒绝重放成功记录未产生额外平台写入（汉印 add 恰好 2 次：成功轮 + 重放轮）',
    hp.state.addBodies.length === 2, String(hp.state.addBodies.length))

  // 删除落盘：今天的成功留痕已移除，昨日两条（失败 + 重放成功）保留
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) } catch { /* 无日志则按空断言 */ }
  assert('R6 删除已落盘：剩昨日两条（今天那条已移除）',
    entries.length === 2 && entries.every((e) => e.date === yesterdayStr && e.date !== todayStr),
    JSON.stringify(entries.map((e) => ({ at: e.at, date: e.date, error: e.error || '' }))))
  const keptFail = entries.find((e) => e.error) || {}
  assert('R6 删除只动留痕：失败条目及其存档载荷保留',
    !!keptFail.at && keptFail.payload && keptFail.payload.tasks.length === 2 && String(keptFail.tasks[0].taskId) === String(TASK_A),
    JSON.stringify({ error: keptFail.error, tasks: keptFail.tasks, payload: keptFail.payload && keptFail.payload.tasks.length }))
  assert('R2 失败条目：断点环节 + 响应原文保留', keptFail.stage === `zentao#${TASK_B}` && !!keptFail.raw,
    JSON.stringify({ stage: keptFail.stage, raw: keptFail.raw }))

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常：', e)
  process.exit(1)
})
