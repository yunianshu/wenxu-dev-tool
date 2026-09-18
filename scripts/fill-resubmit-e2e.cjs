/**
 * E2E（真实 Electron + 沙箱主目录 + 真实 Git 仓库 + 本地 fake 禅道/汉印网关）：
 * 一键填报「提交留痕与重新提交」+「禅道响应异常回查核实」
 *
 * 起因（2026-09-18 用户报障）：当天 4 项（禅道 2 任务 + 汉印 2 条）只成功 1 项——
 * 禅道 recordEstimate POST 实际已写入但响应体非 JSON，旧实现直接抛错中止，
 * 剩余任务与汉印全部漏交，且无日志可回溯、无安全的补交入口。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   R1 响应异常不中止：POST 返回空 body（非 JSON）但服务端已写入时，回查当日工时
 *      逐行匹配 → 按已写入继续，后续任务与汉印照常提交（整体成功，不再出现只成功 1 项）
 *   R2 部分失败可回溯：某任务真失败（响应非 JSON 且回查无匹配）时，fill-log 留痕
 *      分项结果（已写入任务/断点环节/响应原文/完整提交载荷），错误信息标明已写入进度
 *   R3 提交记录面板：页面展示最近提交（状态/分项计数/错误），失败条目提供「重新提交」
 *   R4 重新提交补全：按留痕载荷重放，此前已写入的任务更新覆盖（复用已有记录 ID），
 *      失败任务补写入，汉印照常提交；重放自身也留痕
 *
 * 场景（fake 禅道按「该任务第 N 次 POST」分流，无需外部模式切换）：
 *   第 1 轮（今天）：两任务 POST 均返回空 body 但照常写入 → 全部 verified → 成功
 *   第 2 轮（昨天补填）：任务 A 正常成功；任务 B 返回 HTML 且不写入 → 真失败（1/2）
 *   第 3 轮（重新提交）：全部正常 → A 复用已有记录 ID 更新、B 补写入、汉印 add
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
  const confirmBtn = () => { const box = q('.el-message-box'); return box ? [...box.querySelectorAll('button')].find((b) => norm(b.textContent) === '提交') : null }
  const toasts = () => [...document.querySelectorAll('.el-message')].map((x) => norm(x.textContent))
  const waitToasts = async (ms) => { const seen = new Set(); const t0 = Date.now(); while (Date.now() - t0 < ms) { toasts().forEach((t) => seen.add(t)); await sleep(150) } return [...seen] }
  const logLines = () => [...document.querySelectorAll('.logline')].map((x) => norm(x.textContent))
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

/** 三轮：今天成功（回查核实）→ 昨天部分失败（留痕）→ 重新提交补全 */
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
  const rebtn = failLine && [...failLine.querySelectorAll('button')].find((b) => norm(b.textContent).includes('重新提交'))
  r.rebtnFound = !!rebtn
  if (rebtn) {
    rebtn.click()
    if (await waitFor(() => !!confirmBtn(), 8000)) confirmBtn().click()
  }
  r.round3Toasts = await waitToasts(20000)
  r.round3Done = await waitFor(() => norm(submitBtn()?.textContent).includes('已提交'), 25000)
  r.logsAfter = logLines()
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
  console.log('=== 一键填报：提交留痕与重新提交（R1–R4）===')
  const zt = await startFakeZentao()
  const hp = await startFakeHanprint()
  preseed(zt.port, hp.port)
  let stdout = ''
  try {
    stdout = await launch(EVAL, 'fill-resubmit.png')
    const ev = parseEval(stdout)
    console.log('页面结果:', JSON.stringify(ev, null, 1))

    if (!ev || ev.fatal) {
      assert('一键填报页就绪并完成三轮交互', false, (ev && ev.fatal) || 'EVAL 未返回结果')
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
  assert('汉印 add 恰好 2 次（失败轮不写汉印，重放轮补写）', hp.state.addBodies.length === 2,
    String(hp.state.addBodies.length))

  let entries = []
  try { entries = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) } catch { /* 无日志则按空断言 */ }
  assert('fill-log 留痕 3 条（成功 / 部分失败 / 重放成功）', entries.length === 3, JSON.stringify(entries.map((e) => e.error || 'ok')))
  const e1 = entries[0] || {}
  const e2 = entries[1] || {}
  const e3 = entries[2] || {}
  assert('R1 成功条目：2 任务均标记 verified（回查核实）', e1.tasks && e1.tasks.length === 2 && e1.tasks.every((t) => t.verified === true),
    JSON.stringify(e1.tasks))
  assert('R1 成功条目：汉印 2 条', e1.hp && e1.hp.sent === 2, JSON.stringify(e1.hp))
  assert('R2 失败条目：分项（仅任务 A）+ 断点环节 + 响应原文 + 完整载荷',
    e2.tasks && e2.tasks.length === 1 && String(e2.tasks[0].taskId) === String(TASK_A)
      && e2.stage === `zentao#${TASK_B}` && !!e2.raw && e2.payload && e2.payload.tasks.length === 2,
    JSON.stringify({ tasks: e2.tasks, stage: e2.stage, raw: e2.raw }))
  assert('R2 失败条目：错误含进度 1/2', /1\/2/.test(String(e2.error || '')), e2.error)
  assert('R4 重放条目：整体成功（2 任务、无错误、汉印 2 条）',
    e3.tasks && e3.tasks.length === 2 && !e3.error && e3.hp && e3.hp.sent === 2,
    JSON.stringify({ tasks: e3.tasks && e3.tasks.length, error: e3.error, hp: e3.hp }))

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('E2E 异常：', e)
  process.exit(1)
})
