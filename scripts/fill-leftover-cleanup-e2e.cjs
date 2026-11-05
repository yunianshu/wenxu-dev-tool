/**
 * E2E（真实 Electron + 本地 fake 禅道网关 + 沙箱数据目录 + 真实 Git 仓库）：
 * 一键填报「取消已提交过的项目后，确认清理旧工时再提交」
 *
 * 场景：当天早些时候已把 #102 的 0.5h 写入禅道；现在的计划只勾选 Alpha项目（#101）。
 * 旧校验会直接拦截，用户无路可走。现在：预览只提示；提交时确认后删除本工具写入的旧记录再提交。
 *
 * 验收标准（源自需求）：
 *   C1 预览提交的弹窗列出「提交时将先删除的旧工时 #102」，且不发送删除请求、不写入
 *   C2 正式提交出现「清理旧工时」确认，列出 #102 · 1 条 · 0.5h
 *   C3 确认后删除 estimateID=9001，再按当前勾选写入 #101
 *   C4 平台最终只剩本次写入的记录；提交记录只新增成功记录（待确认的首次尝试不留失败痕迹）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-leftover-cleanup-e2e.cjs
 *       E2E_EXE=<打包产物 exe> node scripts/fill-leftover-cleanup-e2e.cjs
 */
const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-cleanup-${Date.now()}`)
const APP_DATA = path.join(SANDBOX, 'appdata')
const USER_DATA = path.join(APP_DATA, 'dev-project-manager')
const REPO_ALPHA = path.join(SANDBOX, 'repo-alpha')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')
const BINDINGS_FILE = path.join(USER_DATA, 'fill-bindings.json')
const LOG_FILE = path.join(USER_DATA, 'fill-log.json')

const P_ALPHA = 'fl_e2e_alpha'
const IDENTITY = { name: 'E2E清理用户', email: 'fill-cleanup@example.com' }
const TASK_KEEP = 101
const TASK_OLD = 102
const OLD_WORK = '旧项目提交'
const OLD_EFFORT_ID = 9001

const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const TODAY = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

function git(cwd, args) {
  const { spawnSync } = require('child_process')
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

/** 本地假禅道 + 假汉印：登录、任务、工时读写、删除（禅道 confirm=yes / 汉印 del）与平台状态 */
function startFakeZentao() {
  const state = {
    efforts: new Map([[TASK_KEEP, []], [TASK_OLD, [{ id: OLD_EFFORT_ID, account: 'e2e', date: TODAY, work: OLD_WORK, consumed: 0.5, left: 0 }]]]),
    deleted: [],
    writes: [],
    hpRows: [
      { Id: 676001, TaskId: String(TASK_KEEP), ProjectType: 3, Percent: 50, WorkDate: TODAY, UserId: 1395, UserNo: 'e2e', UserName: '本人', DepartId: 154, DepartName: '系统开发一科' },
      { Id: 676002, TaskId: String(TASK_OLD), ProjectType: 3, Percent: 50, WorkDate: TODAY, UserId: 1395, UserNo: 'e2e', UserName: '本人', DepartId: 154, DepartName: '系统开发一科' },
    ],
    hpDeleted: [],
    hpSent: [],
  }
  let nextId = 9500
  let hpNextId = 676100
  const task = (id, left) => ({ id: String(id), name: id === TASK_KEEP ? 'Alpha任务' : '历史任务', status: 'doing', consumed: '0', left: String(left), finishedDate: '0000-00-00 00:00:00', closedDate: '0000-00-00 00:00:00' })
  const tasks = [task(TASK_KEEP, 8), task(TASK_OLD, 0)]
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const send = (body, type = 'text/html;charset=utf-8') => {
      res.writeHead(200, { 'Content-Type': type, 'Set-Cookie': 'zentaosid=e2e-sid; Path=/' })
      res.end(body)
    }
    const sendJson = (data) => send(JSON.stringify({ status: '200', data: JSON.stringify(data) }), 'application/json;charset=utf-8')
    const sendHp = (data) => send(JSON.stringify({ code: 0, data }), 'application/json;charset=utf-8')
    if (url.pathname === '/login/getToken') return sendHp('hp-tok')
    if (url.pathname === '/com/workhour/GetDict') return sendHp([{ Key: 3, Name: '软件项目' }])
    if (url.pathname === '/com/workhour/GetProjectList') return sendHp([{ Key: 'P1', Name: 'Alpha项目' }])
    if (url.pathname === '/com/workhour/GetProjectTaskList') return sendHp([{ Key: String(TASK_KEEP), Name: 'Alpha任务' }])
    if (url.pathname === '/com/workhour/GetByDate') return sendHp(state.hpRows.map((row) => ({ ...row })))
    if (url.pathname === '/com/workhour/del') {
      const id = Number(url.searchParams.get('id'))
      const index = state.hpRows.findIndex((row) => row.Id === id)
      if (index >= 0) state.hpRows.splice(index, 1)
      state.hpDeleted.push(id)
      return sendHp(null)
    }
    if (url.pathname === '/com/workhour/add' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const items = JSON.parse(body || '[]')
        state.hpSent.push(items)
        for (const item of items) {
          const hit = state.hpRows.find((row) => row.Id === Number(item.Id))
          if (hit) Object.assign(hit, item)
          else state.hpRows.push({ ...item, Id: hpNextId++, UserNo: 'e2e' })
        }
        sendHp(null)
      })
      return
    }
    if (url.pathname === '/index.php' && url.searchParams.get('m') === 'user' && url.searchParams.get('f') === 'refreshRandom') return send('"e2e-rand"')
    if (url.searchParams.get('m') === 'user' && url.searchParams.get('f') === 'login') {
      return req.method === 'POST' ? send('{"result":"success"}', 'application/json;charset=utf-8') : send('<html>login</html>')
    }
    if (url.searchParams.get('m') === 'my' && (url.searchParams.get('f') === 'work' || url.searchParams.get('f') === 'task')) {
      return sendJson({ tasks: url.searchParams.get('type') === 'finishedBy' ? [] : tasks })
    }
    if (url.searchParams.get('f') === 'view') {
      const hit = tasks.find((t) => t.id === url.searchParams.get('taskID'))
      return sendJson({ task: hit || {} })
    }
    if (url.searchParams.get('f') === 'deleteEstimate') {
      const id = Number(url.searchParams.get('estimateID'))
      if (url.searchParams.get('confirm') !== 'yes') return send('<html>confirm</html>')
      for (const rows of state.efforts.values()) {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      }
      state.deleted.push(id)
      return send(`<script>reload('parent')</script>`)
    }
    if (url.searchParams.get('f') === 'editEstimate' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        const id = Number(url.searchParams.get('effortID'))
        for (const rows of state.efforts.values()) {
          const hit = rows.find((row) => row.id === id)
          if (hit) Object.assign(hit, { work: form.get('work'), consumed: Number(form.get('consumed')), left: Number(form.get('left')) })
        }
        send('{"result":"success"}', 'application/json;charset=utf-8')
      })
      return
    }
    if (url.searchParams.get('f') === 'recordEstimate' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        const taskId = Number(url.searchParams.get('taskID'))
        const rows = state.efforts.get(taskId) || []
        for (let i = 1; form.has(`work[${i}]`); i += 1) {
          rows.push({ id: nextId++, account: 'e2e', date: form.get(`dates[${i}]`), work: form.get(`work[${i}]`), consumed: Number(form.get(`consumed[${i}]`)), left: Number(form.get(`left[${i}]`)) })
        }
        state.efforts.set(taskId, rows)
        state.writes.push(taskId)
        send('{"result":"success"}', 'application/json;charset=utf-8')
      })
      return
    }
    if (url.searchParams.get('f') === 'recordEstimate') {
      const taskId = Number(url.searchParams.get('taskID'))
      const hit = tasks.find((t) => t.id === String(taskId))
      return sendJson({ efforts: (state.efforts.get(taskId) || []).map((row) => ({ ...row })), task: hit || {} })
    }
    return send('<html>ok</html>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }))
  })
}

function preseed(port) {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(REPO_ALPHA, { recursive: true })
  git(REPO_ALPHA, ['init', '-q'])
  git(REPO_ALPHA, ['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, 'commit', '-q', '--allow-empty', '-m', 'feat: 今天的提交'])
  const baseUrl = `http://127.0.0.1:${port}`
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    roots: [SANDBOX],
    identities: [IDENTITY],
    zentao: { baseUrl, account: 'e2e', pwdEnc: { plain: 'e2e-pwd' }, lunchStart: '12:00', lunchEnd: '13:00' },
    hanprint: { baseUrl, clientId: '1', account: 'e2e', pwdEnc: { plain: 'e2e-pwd' } },
  }, null, 2))
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    projects: [{ id: P_ALPHA, name: 'Alpha项目', localPath: REPO_ALPHA }],
  }, null, 2))
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify({
    [P_ALPHA]: { taskId: TASK_KEEP, taskName: 'Alpha任务', boundAt: new Date().toISOString() },
  }, null, 2))
  // 当天早些时候的提交留痕：#102 的 0.5h 与汉印 50% 已写进平台
  const scope = (platform) => crypto.createHash('sha256').update(JSON.stringify([String(platform.baseUrl || '').replace(/\/+$/, ''), platform.account || '', platform.clientId || ''])).digest('hex')
  fs.writeFileSync(LOG_FILE, JSON.stringify([{
    at: `${TODAY} 09:00:00.000`,
    platformScope: { zentao: scope({ baseUrl, account: 'e2e' }), hanprint: scope({ baseUrl, account: 'e2e', clientId: '1' }) },
    date: TODAY,
    dryRun: false,
    tasks: [{ taskId: TASK_OLD, taskName: '历史任务', consumed: 0.5, verified: true, updated: 0, appended: 1 }],
    hp: { sent: 1, updated: 0, appended: 1 },
    ztTasks: 1,
    hpSent: 1,
    payload: {
      date: TODAY,
      tasks: [{ taskId: TASK_OLD, taskName: '历史任务', rows: [{ date: TODAY, work: OLD_WORK, consumed: 0.5, left: 0 }] }],
      hp: { items: [{ Id: 0, TaskId: String(TASK_OLD), ProjectType: 3, WorkDate: TODAY, Percent: 50 }] },
    },
  }], null, 2))
}

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const waitFor = async (fn, ms = 8000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
    return false
  }
  const viewReady = (ms = 25000) => waitFor(() => q('.fill-page') && q('.fill-toolbar'), ms, 150)
  const endSelect = () => q('.fill-toolbar .fill-end')
  const timeOptionEls = () => qa('.el-select-dropdown__item').filter((x) => /^\\d{2}:\\d{2}$/.test(norm(x.textContent)))
  const setEnd = async (t) => {
    await waitFor(() => !timeOptionEls().some((x) => x.offsetParent !== null), 5000, 100)
    const sel = endSelect(); if (!sel) return false
    ;(sel.querySelector('.el-select__wrapper') || sel).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    if (!await waitFor(() => timeOptionEls().some((x) => x.offsetParent !== null), 6000)) return false
    const el = timeOptionEls().find((x) => norm(x.textContent) === t && x.offsetParent !== null)
    if (!el) return false
    el.click()
    return waitFor(() => norm(endSelect().textContent).includes(t), 4000)
  }
  const fillSelect = () => q('.fill-page .project-select')
  const projectOptions = () => qa('.el-select-dropdown__item').filter((x) => x.querySelector('.project-option'))
  const openDropdown = async () => {
    if (projectOptions().some((x) => x.offsetParent !== null)) return 'ok'
    const sel = fillSelect(); if (!sel) return 'no-select'
    ;(sel.querySelector('.el-select__wrapper') || sel).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return (await waitFor(() => projectOptions().some((x) => x.offsetParent !== null), 5000)) ? 'ok' : 'no-dropdown'
  }
  const generateBtn = () => qa('button').find((b) => norm(b.textContent).includes('生成报告'))
  const rowOf = (name) => qa('.prow').find((r) => norm(r.textContent).includes(name))
  const actionBtn = (text) => qa('.fill-actions button').find((b) => norm(b.textContent).includes(text))
  const previewText = () => norm(q('.el-dialog .preview-content')?.textContent)
  const msgBox = () => q('.el-message-box')
  const msgBoxTitle = () => norm(q('.el-message-box__title')?.textContent)
  const clickMsgButton = (text) => {
    const btn = qa('.el-message-box__btns button').find((b) => norm(b.textContent).includes(text))
    if (!btn) return false
    btn.click(); return true
  }
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) {
    done()
    return {
      fatal: '一键填报页未就绪',
      href: location.href,
      menu: qa('.app-menu .el-menu-item').map((x) => norm(x.textContent)),
      appLen: (q('#app')?.innerHTML || '').length,
      alerts: qa('.el-alert, .el-message').map((x) => norm(x.textContent)).slice(0, 6),
    }
  }
  r.endSet = await setEnd('18:00')
  r.generateReady = await waitFor(() => { const b = generateBtn(); return !!(b && !b.disabled) }, 25000)
  generateBtn()?.click()
  r.rowAppeared = await waitFor(() => !!rowOf('Alpha项目'), 60000, 200)

  // C1 预览：只提示待清理旧工时，不删除
  r.previewOpened = !!(actionBtn('预览提交'))
  actionBtn('预览提交')?.click()
  r.previewShown = await waitFor(() => previewText().includes('提交时将先删除的旧工时'), 15000)
  r.previewHasOld = previewText().includes('#${TASK_OLD}')
  r.previewOldText = previewText().slice(-120)
  q('.el-dialog__headerbtn')?.click()
  await waitFor(() => !q('.el-dialog .preview-content'), 5000)

  // C2/C3 正式提交：先确认提交，再确认清理旧工时
  actionBtn('一键提交')?.click()
  r.firstConfirm = await waitFor(() => msgBoxTitle() === '确认提交', 8000)
  clickMsgButton('提交')
  r.cleanupConfirm = await waitFor(() => msgBoxTitle() === '清理旧工时', 15000)
  r.cleanupText = norm(msgBox()?.textContent)
  clickMsgButton('删除并提交')
  r.success = await waitFor(() => qa('.el-message').some((m) => norm(m.textContent).includes('已提交')), 30000)
  r.footer = norm(q('.fill-actions')?.textContent)
  done()
  return r
})()`

/** 需异步 spawn：spawnSync 会阻塞事件循环，本地 fake 网关无法应答 */
const EXE = process.env.E2E_EXE ? path.resolve(process.env.E2E_EXE) : ''

function launch(evalScript) {
  const env = {
    ...process.env,
    APPDATA: APP_DATA,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '180000',
    SMOKE_VIEW: '一键填报',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
  }
  const bin = EXE || process.execPath
  const args = EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.']
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: EXE ? path.dirname(EXE) : ROOT, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 240000)
    child.on('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }) })
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
  console.log(`=== 一键填报：确认清理旧工时再提交（C1–C4，${TODAY}）===`)
  const { server, state, port } = await startFakeZentao()
  preseed(port)
  const run = await launch(EVAL)
  const ev = parseEval(run.stdout)
  if (!ev) {
    assert('未取到 eval 结果', false, `status=${run.status} signal=${run.signal} stderr=${run.stderr.slice(-800)}`)
  } else if (ev.fatal) {
    assert('页面就绪', false, `${ev.fatal} href=${ev.href} menu=${JSON.stringify(ev.menu)} appLen=${ev.appLen} alerts=${JSON.stringify(ev.alerts)} stderr=${run.stderr.slice(-500)}`)
  } else {
    assert('前置：生成 Alpha项目明细', ev.endSet === true && ev.rowAppeared === true, `end=${ev.endSet} row=${ev.rowAppeared}`)
    assert('C1 预览弹窗提示将删除的旧工时 #102', ev.previewShown === true && ev.previewHasOld === true, `shown=${ev.previewShown} old=${ev.previewHasOld} 尾部="${ev.previewOldText}"`)
    assert('C2 提交出现「清理旧工时」确认并列出禅道/汉印两条 #102 记录',
      ev.cleanupConfirm === true && ev.cleanupText.includes('#102') && ev.cleanupText.includes('0.5h') && ev.cleanupText.includes('1 条') && ev.cleanupText.includes('汉印') && ev.cleanupText.includes('50%'),
      `text="${ev.cleanupText}"`)
    assert('C3 确认后提交成功', ev.success === true, `footer="${ev.footer}"`)
  }

  // C3/C4：平台最终状态与留痕
  const oldRows = state.efforts.get(TASK_OLD) || []
  const keptRows = state.efforts.get(TASK_KEEP) || []
  assert('C3 旧工时 9001 已删除且未重复删除', JSON.stringify(state.deleted) === JSON.stringify([OLD_EFFORT_ID]), `deleted=${JSON.stringify(state.deleted)}`)
  assert('C3 #102 已无剩余工时', oldRows.length === 0, `rows=${JSON.stringify(oldRows)}`)
  assert('C3 #101 已按本次计划写入一条工时', keptRows.length === 1 && keptRows[0].consumed > 0, `rows=${JSON.stringify(keptRows)}`)
  assert('C3 汉印旧记录 676002 已删除', JSON.stringify(state.hpDeleted) === JSON.stringify([676002]), `hpDeleted=${JSON.stringify(state.hpDeleted)}`)
  assert('C3 汉印只剩 #101 的 100%', state.hpRows.length === 1 && String(state.hpRows[0].TaskId) === String(TASK_KEEP) && state.hpRows[0].Percent === 100, `hpRows=${JSON.stringify(state.hpRows)}`)
  const hpUpdate = state.hpSent.at(-1) || []
  assert('C3 汉印更新条目带回本人归属字段（避免被判成修改他人记录）',
    hpUpdate.length === 1 && hpUpdate[0].Id === 676001 && hpUpdate[0].UserNo === 'e2e' && hpUpdate[0].UserId === 1395,
    `sent=${JSON.stringify(hpUpdate.map((x) => ({ Id: x.Id, UserNo: x.UserNo, UserId: x.UserId, Percent: x.Percent })))}`)
  let logs = []
  try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) } catch { /* 留痕缺失由断言报告 */ }
  assert('C4 提交记录只新增成功记录，待确认尝试不留痕',
    logs.length === 2 && !logs[1].error && logs[1].tasks?.[0]?.taskId === TASK_KEEP,
    `logs=${JSON.stringify(logs.map((e) => ({ at: e.at, error: e.error, tasks: (e.tasks || []).map((t) => t.taskId) })))}`)

  try { server.close() } catch { /* noop */ }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => { console.error('E2E 异常:', error.message); process.exit(1) })
