/**
 * 一键填报 —— Git 提交 → 工时计划 → 禅道任务工时
 *
 * 工时算法移植自 wenxu/KnowMore worktime-sync（锚点累进法）：
 * - 每条提交的工时 = 本提交时间 − 上一锚点（首条锚点为上班时间），自动扣除午休重叠
 * - 每段按 30 分钟向下取整（0.5h 步进，不足半小时的尾数舍弃）
 * - 取整后为 0 的段自动并入下一条提交的工作说明（尾部并入上一条）
 *
 * 与活动报告的 git-service.collectCommits 不同：这里需要每条提交的 HH:MM
 * （工时按提交时刻切分），故独立查询（--date=format:%Y-%m-%d %H:%M）。
 */
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { app } = require('electron')
const store = require('./store')
const { execGit } = require('./git-service')
const zentao = require('./zentao-service')
const hanprint = require('./hanprint-service')

// ─── 工时计算（纯函数） ───
// 语义：工时与 git 提交时刻完全无关——总工时 = 页面填写的实际上班时间 → 终点
//（填报今天为点击生成报告的时刻，含加班；补填历史日期为下班时间），扣午休后按
// 0.5 小时整体向下取整；各项目按提交条数占总数的比例分配总工时（0.5h 取整、总和守恒）。

function hm(s) {
  const [h, m] = String(s).split(':').map(Number)
  return h * 60 + m
}

/** HH:MM 合法性（IPC 可被直接调用，不能只依赖页面控件产生的值） */
function validHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return false
  const h = Number(m[1])
  const mi = Number(m[2])
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** 两个时间点之间的工作分钟数，扣除与午休的重叠 */
function workMinutes(start, end, lunchS, lunchE) {
  if (end <= start) return 0
  const overlap = Math.max(0, Math.min(end, lunchE) - Math.max(start, lunchS))
  return (end - start) - overlap
}

/**
 * 尾段终点：页面显式填写的下班/加班结束时间优先（支持跨夜，如「00:30」表示次日凌晨）；
 * 未填写时一律取点击生成报告的当前时刻，不区分填报日期——补填历史日期时「现在」
 * 同样是已知的终点，设置页不再有固定下班时间。now 可注入以便自测。
 */
function resolveEndTime(now = new Date(), explicitEnd = '') {
  if (explicitEnd) return explicitEnd
  const p = (n) => String(n).padStart(2, '0')
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return `${p(Math.floor(nowMin / 60))}:${p(nowMin % 60)}`
}

/**
 * 工时区间是否跨夜：终点早于上班时间即视为次日
 * （如 08:30 上班、次日 00:30 加班结束）。
 */
function isCrossDay(startTime, endTime) {
  return hm(endTime) < hm(startTime)
}

// ─── 按项目聚合（一个项目一条工时记录，内容为简洁编号列表） ───

/** Conventional Commits 前缀剥离（与活动报告「复制」按钮的口径一致） */
const PREFIX_RE = /^(feat|fix|refactor|docs|style|test|chore|perf|ci|build|revert|init|types?)(\([^)]*\))?\s*[:：]\s*/i

function stripPrefix(subject) {
  return String(subject || '').replace(PREFIX_RE, '').trim()
}

/**
 * 有提交的项目最低工时：只要一个项目当天有提交，就至少记 0.5h——
 * 原来按提交条数占比算出的份额不足 0.5h 时会被取整抹成 0，导致该项目白干。
 */
const MIN_PROJECT_HOURS = 0.5

/**
 * 工时分配（与提交时刻无关）：
 * - 总工时 = workMinutes(实际上班时间, endTime) 扣午休后按 step 整体取整；
 *   crossDay=true 表示终点在次日（加班跨夜，如 08:30 → 次日 00:30）
 * - 各项目工时 = 总工时 × 该项目提交数 / 总提交数，0.5h 向下取整，
 *   但有提交的项目保底 MIN_PROJECT_HOURS（0.5h）；
 *   余量补给提交最多的项目（可为负，即从该项目扣回），保证 Σ = 总工时；
 *   项目数极多、保底之和已超过总工时时 Σ 会略高于总工时（保底优先）
 * - 说明 = 去类型前缀的编号列表（同活动报告复制格式）
 */
function distributeByProject(commits, { startTime, endTime, lunchStart, lunchEnd, step = 30, crossDay = false } = {}) {
  const sorted = [...(commits || [])].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  if (!sorted.length) return []
  const startMin = hm(startTime || '08:30')
  const endMin = hm(endTime || '17:30') + (crossDay ? 24 * 60 : 0)
  const totalMin = workMinutes(startMin, endMin, hm(lunchStart || '12:00'), hm(lunchEnd || '13:00'))
  const totalHours = round2(Math.floor(totalMin / step) * step / 60)

  const groups = new Map()
  for (const c of sorted) {
    const key = String(c.projectId === undefined ? '' : c.projectId)
    if (!groups.has(key)) groups.set(key, { projectId: c.projectId, projectName: c.projectName || key, commits: [] })
    groups.get(key).commits.push(c)
  }
  const total = sorted.length
  const list = [...groups.values()].map((g) => {
    const raw = totalHours * g.commits.length / total
    const hours = Math.max(MIN_PROJECT_HOURS, Math.floor(raw * 2) / 2) // 0.5h 向下取整，且有提交即保底 0.5h
    return { projectId: g.projectId, projectName: g.projectName, commits: g.commits, hours, rawHours: round2(raw) }
  })
  const assigned = round2(list.reduce((s, g) => s + g.hours, 0))
  const rest = round2(totalHours - assigned)
  if (rest !== 0 && list.length) {
    const target = [...list].sort((a, b) => b.commits.length - a.commits.length)[0]
    target.hours = round2(Math.max(MIN_PROJECT_HOURS, target.hours + rest))
  }
  for (const g of list) {
    g.commitCount = g.commits.length
    g.work = g.commits.map((c, i) => `${i + 1}. ${stripPrefix(c.msg)}`).join('\n')
    delete g.commits
  }
  return list
}

// ─── 提交收集（带 HH:MM） ───

const TIMED_LOG_FMT = '%H%x09%ad%x09%an%x09%ae%x09%s'

/** 解析 git log 输出行：hash ⇥ YYYY-MM-DD HH:MM ⇥ 作者名 ⇥ 邮箱 ⇥ 主题 */
function parseTimedLines(project, repo, stdout) {
  const list = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [hash, datetime, authorName, authorEmail, ...rest] = parts
    if (!hash || !datetime) continue
    list.push({
      hash: hash.slice(0, 10),
      datetime,
      time: datetime.length >= 16 ? datetime.slice(11, 16) : '',
      authorName,
      authorEmail,
      msg: rest.join('\t'),
      repo,
      projectId: project.id,
      projectName: project.name,
    })
  }
  return list
}

function isMine(commit, identities) {
  return (identities || []).some(
    (id) => (id.email && commit.authorEmail === id.email) || (id.name && commit.authorName === id.name),
  )
}

/** 本地时区日期加减天数（YYYY-MM-DD） */
function addDaysLocal(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 收集多个项目全部仓库在指定日期的本人提交（并发，按时间升序稳定排序）。
 *
 * git log 的 --since 是「遍历剪枝」而非事后过滤：当分支头提交时间早于 since 时，
 * 整条链被剪掉，链上时间乱序（rebase/amend）的提交会漏。故 since 前推 7 天作
 * 保护窗，拉回后按作者日期（%ad）在内存中精确过滤到目标日；--until 同理交给
 * 内存过滤，避免 committer date 与 author date 口径不一致造成误差。
 */
/** 收集并发上限：仓库多时避免 Promise.all 同时 spawn 大量 git 进程（进程风暴） */
const COLLECT_CONCURRENCY = 8

/** 固定并发池：按序消费任务，保持结果顺序 */
async function runPool(tasks, job) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = Math.max(1, Math.min(COLLECT_CONCURRENCY, tasks.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= tasks.length) return
      results[i] = await job(tasks[i]) // eslint-disable-line no-await-in-loop
    }
  }))
  return results
}

async function collectTimedCommits(projects, { date, identities }) {
  const seen = new Set()
  const repos = []
  for (const project of projects || []) {
    for (const repo of project.repos || []) {
      if (!repo) continue
      const key = process.platform === 'win32' ? String(repo).replace(/\\/g, '/').toLowerCase() : repo
      if (seen.has(key)) continue
      seen.add(key)
      repos.push({ repo, project })
    }
  }
  const lookbackDate = addDaysLocal(date, -7)
  const results = await runPool(repos, async ({ repo, project }) => {
    const res = await execGit(repo, [
      'log', '--all',
      `--since=${lookbackDate} 00:00:00`,
      '--no-merges',
      `--pretty=tformat:${TIMED_LOG_FMT}`,
      '--date=format:%Y-%m-%d %H:%M',
    ])
    return res.ok ? parseTimedLines(project, repo, res.stdout) : []
  })
  const all = results.flat().filter((c) => c.datetime.slice(0, 10) === date && c.time && isMine(c, identities))
  // 升序稳定排序：同时刻提交保持收集顺序（与 KnowMore parse_commits 的稳定排序一致）
  return all.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
}

// ─── 项目 ↔ 禅道任务绑定（userData/fill-bindings.json，绑定一次长期生效） ───

function bindingsFile() {
  return path.join(app.getPath('userData'), 'fill-bindings.json')
}

function listBindings() {
  try {
    return JSON.parse(fs.readFileSync(bindingsFile(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function saveBindings(map) {
  const file = bindingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 })
}

function bindProject(projectId, taskId, taskName) {
  if (!projectId) throw new Error('缺少项目 ID')
  if (!taskId) throw new Error('缺少禅道任务 ID')
  const map = listBindings()
  map[String(projectId)] = { taskId: Number(taskId), taskName: String(taskName || ''), boundAt: new Date().toISOString() }
  saveBindings(map)
  return map[String(projectId)]
}

function unbindProject(projectId) {
  const map = listBindings()
  delete map[String(projectId)]
  saveBindings(map)
  return true
}

/** 按名称互相包含给出绑定建议（KnowMore 匹配规则的项目名部分；不自动绑定） */
function suggestTask(projectName, tasks) {
  const name = String(projectName || '')
  if (!name) return null
  for (const t of tasks || []) {
    if (name.includes(t.name) || t.name.includes(name)) return t.id
  }
  return null
}

// ─── 提交汇总（剩余 + 被覆盖记录的旧消耗 − 本次消耗，最低为 0） ───

function buildSubmitTasks(planned, ztTasks, date, efforts = {}) {
  const byId = new Map((ztTasks || []).map((t) => [String(t.id), t]))
  const byTask = new Map()
  for (const p of planned || []) {
    if (!p.taskId) continue
    const key = String(p.taskId)
    if (!byTask.has(key)) byTask.set(key, { taskName: '', rows: [] })
    const entry = byTask.get(key)
    if (!entry.taskName && p.taskName) entry.taskName = p.taskName
    entry.rows.push({ date, work: p.work, consumed: p.hours })
  }
  const tasks = []
  for (const [key, { taskName, rows }] of byTask) {
    const t = byId.get(key)
    const consumed = round2(rows.reduce((s, r) => s + r.consumed, 0))
    const existing = (efforts[key] && efforts[key].records) || []
    const replaced = existing.slice(0, rows.length).reduce((s, r) => s + r.consumed, 0)
    const left = Math.max(0, round2((t ? t.left : 0) + replaced - consumed))
    for (const r of rows) r.left = left
    tasks.push({
      taskId: Number(key),
      taskName: t ? t.name : taskName,
      taskLeft: t ? t.left : null, // 禅道当前剩余（null=任务已不在我的任务列表）
      consumed,
      left,
      rows,
    })
  }
  return tasks
}

// ─── 汉印条目构造（移植 KnowMore buildHp/buildPayload：工时 → 百分比，Σ=100） ───

/**
 * 按禅道任务聚合工时换算为汉印百分比条目。只在「软件项目(type=3)」分组中按
 * 「任务 Key === 禅道任务 ID」查找（两系统数据同源）；未匹配任务的工时占比
 * 份额并入余数，补给占比最大的一条，保证 ΣPercent = 100（汉印硬约束）。
 * 占比为 0 的条目一律不产出（工时为 0，或占比四舍五入后为 0）——0% 记录没有意义，
 * 其中被丢弃的条数由 zeroSkipped 回报。
 * 返回 { items, unmatched: [taskId...], zeroSkipped }。
 */
function buildHpItems(tasks, groups, date) {
  const total = round2((tasks || []).reduce((s, t) => s + (t.consumed || 0), 0))
  if (!total) return { items: [], unmatched: [], zeroSkipped: 0 }
  const list = []
  const unmatched = []
  for (const t of tasks || []) {
    const group = (groups || []).find(
      (g) => g.type === 3 && (g.tasks || []).some((x) => String(x.Key) === String(t.taskId)),
    )
    if (!group) {
      unmatched.push(t.taskId)
      continue // eslint-disable-line no-continue
    }
    const task = group.tasks.find((x) => String(x.Key) === String(t.taskId))
    const consumed = Number(t.consumed) || 0
    const pct = Math.round((consumed / total) * 100)
    list.push({ group, task, pct, consumed })
  }
  if (!list.length) return { items: [], unmatched, zeroSkipped: 0 }
  // 余数补给占比最大的一条：不能补到 0% 条目上，否则会凭空写出一条没有工时的记录
  const rest = 100 - list.reduce((s, x) => s + x.pct, 0)
  if (rest) {
    const target = list.reduce((a, b) => (b.consumed > a.consumed ? b : a), list[0])
    target.pct += rest
  }
  // 0% 条目不写入：丢弃项本身占比为 0，不影响其余条目的 Σ=100
  const kept = list.filter((x) => x.pct > 0)
  const items = kept.map(({ group, task, pct }) => ({
    Id: 0,
    ProjectType: group.type,
    ProjectTypeName: group.typeName,
    TaskTypeName: '',
    ProjectId: String(group.projectId),
    ProjectName: group.projectName,
    TaskId: String(task.Key),
    TaskName: task.Name,
    GlProjectId: task.GlProjectGuid || '',
    GlProjectName: task.GlprojectName || '',
    BigProjectId: task.BigKey || '',
    BigProjectName: task.BigName || '',
    ProductId: task.ProductKey || '',
    ProductName: task.ProductName || '',
    Percent: pct,
    PlanStartTime: task.StartTime || null,
    PlanEndTime: task.EndTime || null,
    ActualStartTime: task.StartTime2 || null,
    ActualEndTime: task.EndTime2 || null,
    UserNo: '',
    IsOp: !!task.IsOp,
    PlmTotalHour: task.PlmTotalHour || 0,
    ProductTime: task.ProductTime || null,
    Syqz: '',
    Status: 0,
    Remark: '',
    TaskRemark: '',
    DivisionName: task.DivisionName || '',
    WorkDate: date,
    AddType: 0,
  }))
  return { items, unmatched, zeroSkipped: list.length - kept.length }
}

// ─── 编排：生成工时计划 / 提交禅道 ───

/**
 * 当天采集结果缓存：切换所选项目时复用（不重复跑 git / 禅道 / 汉印接口）。
 * 只缓存「原始数据」，工时与占比每次按所选子集重新计算。
 */
let rawCache = null

/** 仓库路径规范化（Windows 大小写不敏感），用于缓存签名 */
function repoKey(p) {
  const s = String(p || '').replace(/\\/g, '/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

function projectsSignature(projects) {
  const keys = []
  for (const p of projects || []) for (const r of p.repos || []) keys.push(repoKey(r))
  return keys.sort().join('|')
}

/**
 * 采集当天原始数据：本人提交 + 禅道我的任务 + 各绑定任务的当日已有工时 + 汉印任务字典/当日记录。
 * 容错口径与旧实现一致：禅道/汉印任一失败都不阻断计划，只回报错误文本。
 */
async function collectRaw({ date, projects, cfg, identities, win, signature }) {
  const identitiesMissing = !identities.length
  const commits = identitiesMissing ? [] : await collectTimedCommits(projects, { date, identities })
  const bindings = listBindings()

  const zentaoConfigured = !!(cfg.zentao && cfg.zentao.baseUrl && cfg.zentao.account && store.getZentaoPwd())
  let ztTasks = []
  let ztTaskOptions = []
  let ztError = ''
  const ztEfforts = {}
  if (zentaoConfigured) {
    try {
      ztTasks = await zentao.ensureClient().then((c) => c.myTasks())
    } catch (e) {
      ztError = (e && e.message) || String(e)
    }
    // 绑定任务的选择列表：进行中 + 近一个月完成的（完成后仍可能要补填工时）；单独取，
    // 失败只影响选择列表，不阻断计划——提交链路用的仍是上面的未完成列表
    try {
      ztTaskOptions = await zentao.ensureClient().then((c) => c.myTaskOptions())
    } catch {
      ztTaskOptions = []
    }
    // 当日已有工时挂在任务上，缓存后切换所选项目不必重查；并发查询（内网接口串行延迟线性叠加）
    const taskIds = [...new Set(commits.map((c) => (bindings[String(c.projectId)] || {}).taskId).filter(Boolean))]
    await Promise.all(taskIds.map(async (taskId) => {
      try {
        const efforts = await zentao.ensureClient().then((c) => c.getTaskEfforts(taskId))
        const today = efforts.filter((e) => e.date === date)
        ztEfforts[String(taskId)] = { count: today.length, consumed: round2(today.reduce((s, e) => s + e.consumed, 0)), records: today }
      } catch (e) { ztError = `已有工时查询失败：${e.message || e}` }
    }))
  } else {
    ztError = '禅道未配置：请到「设置 → 一键填报」填写地址、账号与密码'
  }

  let hpGroups = []
  let hpExisting = []
  let hpReady = false
  let hpError = ''
  const hanprintConfigured = !!(cfg.hanprint && cfg.hanprint.baseUrl && cfg.hanprint.account && store.getHanprintPwd())
  if (hanprintConfigured) {
    try {
      hpGroups = await hanprint.getGroups()
      hpReady = true
      hpExisting = (await hanprint.ensureClient().then((c) => c.getByDate(date)))
        .filter((r) => r && r.ProjectType !== -2)
        .map((r) => ({ id: r.Id, taskId: String(r.TaskId), taskName: String(r.TaskName || ''), percent: Number(r.Percent || 0) }))
    } catch (e) {
      hpError = (e && e.message) || String(e)
    }
  } else {
    hpError = '汉印未配置：将只填报禅道工时（可到「设置 → 一键填报」配置汉印账号）'
  }

  return {
    signature,
    date,
    win,
    commits,
    identitiesMissing,
    ztTasks,
    ztTaskOptions,
    ztError,
    ztEfforts,
    hpGroups,
    hpReady,
    hpExisting,
    hpError,
  }
}

/**
 * 按「所选项目子集」计算工时与汉印占比（纯计算，可反复调用）：
 * - 总工时 = 上班时间 → 终点（扣午休、0.5h 取整），按子集内各项目的提交条数占比分配
 * - dayProjects 列出当天所有有提交的项目（含未选择的，供页面勾选与绑定）
 * - 禅道汇总 / 汉印条目只覆盖所选子集
 */
function buildPlanResult({ raw, projects, selectedInput }) {
  const bindings = listBindings()
  const commits = raw.commits || []
  const allIds = [...new Set(commits.map((c) => String(c.projectId)))]
  // selectedIds 为 null = 用户从未手动选择过 → 默认勾选「当天有提交的全部项目」
  // （未绑定的也勾上并提示绑定，避免工时被静默漏报；提交仍会被未绑定拦截）
  const requested = selectedInput === null ? allIds : selectedInput
  const selected = []
  for (const id of requested) {
    if (allIds.includes(id) && !selected.includes(id)) selected.push(id)
  }
  const selSet = new Set(selected)

  const planned = distributeByProject(commits.filter((c) => selSet.has(String(c.projectId))), raw.win)
  const dayPlanned = distributeByProject(commits, raw.win)
  const hoursOf = new Map(planned.map((p) => [String(p.projectId), p.hours]))
  for (const p of [...planned, ...dayPlanned]) {
    const binding = bindings[String(p.projectId)]
    p.taskId = binding ? binding.taskId : null
    p.taskName = binding ? binding.taskName : ''
  }
  const dayProjects = dayPlanned.map((p) => {
    const id = String(p.projectId)
    return {
      projectId: p.projectId,
      projectName: p.projectName,
      commitCount: p.commitCount,
      work: p.work,
      taskId: p.taskId,
      taskName: p.taskName,
      selected: selSet.has(id),
      // 未选择的项目不显示工时：勾选后会按新的子集重新分配
      hours: selSet.has(id) ? (hoursOf.has(id) ? hoursOf.get(id) : 0) : null,
    }
  })

  const tasks = buildSubmitTasks(planned, raw.ztTasks, raw.date, raw.ztEfforts)
  for (const t of tasks) {
    const existing = raw.ztEfforts[String(t.taskId)]
    if (existing) t.existingToday = existing
  }

  const projectById = new Map(projects.map((p) => [String(p.id), p]))
  const boundProjects = {}
  for (const [id] of Object.entries(bindings)) {
    if (projectById.has(id)) boundProjects[id] = bindings[id]
  }
  const suggested = {}
  for (const p of projects) {
    if (boundProjects[String(p.id)]) continue
    const s = suggestTask(p.name, raw.ztTasks)
    if (s) suggested[String(p.id)] = s
  }
  const unmatchedProjects = projects
    .filter((p) => allIds.includes(String(p.id)) && !boundProjects[String(p.id)])
    .map((p) => ({ id: p.id, name: p.name }))

  const built = raw.hpReady
    ? buildHpItems(tasks, raw.hpGroups, raw.date)
    : { items: [], unmatched: [], zeroSkipped: 0 }

  return {
    date: raw.date,
    workConfig: { lunchStart: raw.win.lunchStart, lunchEnd: raw.win.lunchEnd },
    rangeStart: raw.win.startTime,
    rangeEnd: raw.win.endTime,
    crossDay: raw.win.crossDay,
    endTimeManual: raw.win.endTimeManual,
    planned,
    dayProjects,
    selectedIds: selected,
    tasks,
    unmatchedProjects,
    bindings: boundProjects,
    suggested,
    ztTasks: raw.ztTasks,
    // 绑定弹窗的任务选择列表：进行中 + 近一个月完成的；取不到时退回未完成列表
    ztTaskOptions: raw.ztTaskOptions && raw.ztTaskOptions.length ? raw.ztTaskOptions : raw.ztTasks,
    ztError: raw.ztError,
    hpItems: built.items,
    hpUnmatched: built.unmatched,
    hpZeroSkipped: built.zeroSkipped,
    hpExisting: raw.hpExisting,
    hpError: raw.hpError,
    identitiesMissing: raw.identitiesMissing,
    commitCount: commits.length,
  }
}

/**
 * 生成填报计划：先采集「当天全部项目」的提交（不要求先选项目），再按所选项目子集
 * 计算工时与占比。payload:
 *   { date, startTime, endTime,
 *     projects: [{ id, name, repos }],  // 全部可填报项目（渲染层已剔除无仓库的）
 *     selectedIds: string[] | null,     // null=未手动选择过 → 默认勾选当天有提交的全部项目
 *     reuse: boolean,                   // true=复用上次采集（勾选项目子集时用，不重复跑 git/网络）
 *     crossDay: boolean }               // 可选：跨夜判定（复用采集且终点留空时沿用上次判定）
 */
async function plan(payload) {
  const { date, projects } = payload || {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('请选择填报日期')
  if (!Array.isArray(projects) || !projects.length) throw new Error('没有可填报的项目（项目需配置本地目录并识别到 Git 仓库）')
  for (const p of projects) {
    if (!p.id) throw new Error('项目缺少 ID')
    if (!Array.isArray(p.repos) || !p.repos.length) throw new Error(`项目「${p.name || p.id}」没有可识别的 Git 仓库`)
  }

  const cfg = store.load()
  const identities = cfg.identities || []
  const selectedInput = Array.isArray(payload.selectedIds) ? payload.selectedIds.map(String) : null
  const signature = `${date}||${projectsSignature(projects)}||${identities.map((i) => `${i.name || ''}<${i.email || ''}>`).join(',')}`
  const reused = !!payload.reuse && !!rawCache && rawCache.signature === signature

  // 总工时区间 = 页面填写的实际上班时间 → 终点（显式填写优先，否则取点击生成报告的
  // 当前时刻）；git 提交时刻只用于收集内容与计数，故区间不影响采集，复用采集时也按本次
  // 入参重算——页面改上班时间只重算工时，不必重跑 git。
  const workStart = String(payload.startTime || (cfg.zentao && cfg.zentao.workStart) || '08:30')
  if (!validHM(workStart)) throw new Error('实际上班时间格式不正确（应为 HH:MM）')
  const explicitEnd = String(payload.endTime || '').trim()
  if (explicitEnd && !validHM(explicitEnd)) throw new Error('下班时间格式不正确（应为 HH:MM）')
  const endTime = resolveEndTime(undefined, explicitEnd)
  // 终点早于上班时间即按次日跨夜——这是「显式填写的终点」表达的加班语义。终点留空（终点取
  // 生成那一刻）时跨夜与否由调用方传入：否则把上班时间改到晚于上次终点，同一时刻的终点会
  // 凭空变成「次日」而算出 20 多小时。
  const crossDay = typeof payload.crossDay === 'boolean' ? payload.crossDay : isCrossDay(workStart, endTime)
  const win = {
    startTime: workStart,
    endTime,
    crossDay,
    endTimeManual: !!explicitEnd,
    lunchStart: (cfg.zentao && cfg.zentao.lunchStart) || '12:00',
    lunchEnd: (cfg.zentao && cfg.zentao.lunchEnd) || '13:00',
  }

  let raw
  if (reused) {
    // 复用采集结果，但区间按本次入参覆盖（缓存里的 win 只记录首次生成时的区间）
    raw = { ...rawCache, win }
  } else {
    raw = await collectRaw({ date, projects, cfg, identities, win, signature })
    rawCache = raw
  }

  return { ...buildPlanResult({ raw, projects, selectedInput }), reused }
}

/**
 * 提交工时（双平台，已提交过则更新覆盖）。payload: { date, tasks: [{ taskId, rows }], dryRun, hp?: { items } }
 * - 禅道：逐任务查询当日已有工时记录，本次行依次复用已有记录 ID（表单键=effortID →
 *   更新覆盖）；行数超过已有记录时，多出的行按行号键追加（同 KnowMore 行为）
 * - 汉印：GetByDate 取当日已填记录，TaskId 匹配的条目带原 Id 提交（更新占比）；
 *   不删除其他记录；遗漏已有记录或减少禅道行数时先阻止提交，避免总量残留
 * - dryRun=true 只回显将提交的表单/条目，不写入
 * - 日期必须与所有工时行一致；写入前刷新剩余工时与已有记录，任一查询失败即停止
 */
async function submitCore(payload, platformScope) {
  const { date, tasks, dryRun, hp } = payload || {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('请选择有效的填报日期')
  }
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('没有可提交的工时数据')
  const taskIds = new Set()
  for (const t of tasks) {
    if (!t.taskId || !Array.isArray(t.rows) || !t.rows.length) throw new Error('任务数据不完整（缺少 taskId 或工时行）')
    if (taskIds.has(String(t.taskId))) throw new Error('同一任务请合并后提交')
    taskIds.add(String(t.taskId))
    for (const row of t.rows) {
      if (row.date !== date) throw new Error('工时行日期与填报日期不一致')
      if (!Number.isFinite(row.consumed) || row.consumed <= 0) throw new Error('工时必须为大于零的数值')
    }
  }
  const hpItems = hp && Array.isArray(hp.items) ? hp.items.filter((it) => Number(it.Percent) > 0).map((it) => ({ ...it, Id: 0 })) : []
  if (hpItems.some((it) => it.WorkDate !== date)) throw new Error('汉印工时日期与填报日期不一致')
  if (hpItems.length && (hpItems.some((it) => !Number.isFinite(Number(it.Percent)) || Number(it.Percent) > 100) || round2(hpItems.reduce((sum, it) => sum + Number(it.Percent), 0)) !== 100)) {
    throw new Error('汉印本次占比合计必须为 100%，请重新生成填报计划；本次未写入')
  }
  if (new Set(hpItems.map((it) => String(it.TaskId))).size !== hpItems.length) throw new Error('汉印同一任务存在重复条目，请重新生成填报计划；本次未写入')
  const history = readFillLog().filter((entry) => entry && !entry.dryRun && entry.date === date && entry.payload)
  // 分项进度：逐任务/汉印记录已写入的结果，失败时随错误带出（fill-log 分项留痕的数据源）
  const progress = { tasks: [], hp: null, stage: 'prepare' }
  try {
    const client = await zentao.ensureClient()
    progress.stage = 'zentao-query'
    const latestTasks = await client.myTasks()
    const prepared = []
    // 所有查询在写入前完成；不能把查询失败当成「没有记录」。
    for (const t of tasks) {
      // myTasks 只列未完成任务：已完成/已转交的任务回退任务详情取最新剩余（完成时禅道已把 left 置 0）
      let latest = latestTasks.find((item) => String(item.id) === String(t.taskId))
      if (!latest) latest = await client.getTaskById(t.taskId) // eslint-disable-line no-await-in-loop
      if (!latest || !Number.isFinite(latest.left)) throw new Error(`无法获取任务 #${t.taskId} 最新剩余工时，已停止提交`)
      // eslint-disable-next-line no-await-in-loop
      const today = (await client.getTaskEfforts(t.taskId)).filter((e) => e.date === date)
      if (today.slice(t.rows.length).some((row) => Number(row.consumed) > 0)) {
        throw new Error(`禅道任务 #${t.taskId} 在 ${date} 已有 ${today.length} 条工时，本次只有 ${t.rows.length} 条，会遗留旧工时。请保留原项目，或先在禅道核对处理多余记录后再提交；本次未写入`)
      }
      const consumed = round2(t.rows.reduce((s, row) => s + row.consumed, 0))
      const replaced = today.slice(0, t.rows.length).reduce((s, row) => s + row.consumed, 0)
      const left = Math.max(0, round2(latest.left + replaced - consumed))
      const rows = t.rows.map((row, i) => {
        const copy = { ...row, left }
        delete copy.effortId
        if (today[i]) copy.effortId = today[i].id
        return copy
      })
      prepared.push({ ...t, rows, consumed, updated: Math.min(today.length, rows.length), appended: Math.max(0, rows.length - today.length) })
    }
    // 现有客户端没有删除接口；先查本工具历史涉及但本次遗漏的任务，禁止静默残留。
    // 老日志没有账号范围，只凭工作内容与工时的精确匹配识别，不猜测记录归属。
    const previous = new Map()
    for (const entry of history) {
      if (entry.platformScope && entry.platformScope.zentao !== platformScope.zentao) continue
      const written = new Set((entry.tasks || []).map((t) => String(t.taskId)))
      for (const task of entry.payload.tasks || []) {
        const id = String(task.taskId)
        if (taskIds.has(id) || (!written.has(id) && entry.stage !== `zentao#${id}`)) continue
        if (!previous.has(id)) previous.set(id, [])
        previous.get(id).push(...(task.rows || []))
      }
    }
    for (const [id, oldRows] of previous) {
      const existing = (await client.getTaskEfforts(Number(id))).filter((row) => row.date === date && Number(row.consumed) > 0) // eslint-disable-line no-await-in-loop
      const owned = existing.filter((row) => oldRows.some((old) => row.work === old.work && Number(row.consumed) === Number(old.consumed)))
      if (owned.length) {
        throw new Error(`禅道任务 #${id} 在 ${date} 仍有本工具提交的 ${owned.length} 条工时（${round2(owned.reduce((sum, row) => sum + Number(row.consumed), 0))}h），本次未包含该任务。请重新选中相应项目，或先在禅道核对处理这些记录后再提交；本次未写入`)
      }
    }
    let hpClient = null
    let hpUpdated = 0
    const hadHp = history.some((entry) => entry.hp && entry.hp.sent && (!entry.platformScope || entry.platformScope.hanprint === platformScope.hanprint))
    if (hpItems.length || hadHp) {
      hpClient = await hanprint.ensureClient()
      const saved = (await hpClient.getByDate(date)).filter((r) => r && r.ProjectType !== -2)
      const matched = new Set()
      for (const item of hpItems) {
        const hit = saved.find((s) => String(s.TaskId) === String(item.TaskId) && !matched.has(s))
        if (hit) { item.Id = hit.Id; hpUpdated += 1; matched.add(hit) }
      }
      const leftover = saved.filter((item) => !matched.has(item) && Number(item.Percent) > 0)
      if (leftover.length) {
        const details = leftover.map((item) => `#${item.TaskId}（${item.Percent}%）`).join('、')
        throw new Error(`汉印 ${date} 仍有本次未包含的记录：${details}。直接提交会遗留占比；请重新选中相应项目，或先在汉印核对处理这些记录后再提交。程序不会删除平台记录；本次两个平台均未写入`)
      }
    }
    const results = []
    for (const t of prepared) {
      progress.stage = `zentao#${t.taskId}`
      // eslint-disable-next-line no-await-in-loop
      const r = await client.recordEfforts(t.taskId, t.rows, !!dryRun)
      progress.tasks.push({
        taskId: t.taskId,
        taskName: t.taskName || '',
        consumed: t.consumed,
        verified: !!r.verified,
        updated: t.updated,
        appended: t.appended,
      })
      results.push({
        taskId: t.taskId,
        taskName: t.taskName || '',
        consumed: t.consumed,
        updated: t.updated,
        appended: t.appended,
        ...r,
      })
    }
    let hpResult = null
    if (hpItems.length) {
      progress.stage = 'hanprint'
      // 禅道已写入后才走汉印：汉印失败不能抛整体异常掩盖禅道成功，以 hpError 回报
      try {
        hpResult = await hpClient.add(hpItems, !!dryRun)
        hpResult.updated = hpUpdated
        hpResult.appended = hpItems.length - hpUpdated
      } catch (e) {
        hpResult = { error: (e && e.message) || String(e), updated: hpUpdated, appended: hpItems.length - hpUpdated }
      }
      progress.hp = hpResult.error
        ? { sent: hpItems.length, error: hpResult.error }
        : { sent: hpItems.length, updated: hpResult.updated || 0, appended: hpResult.appended || 0 }
    }
    return { dryRun: !!dryRun, results, hp: hpResult }
  } catch (e) {
    // 失败现场：已完成哪些任务、断在哪个环节、响应原文——随错误带出供日志留痕
    e.fillProgress = { tasks: progress.tasks, hp: progress.hp, stage: progress.stage, raw: e.rawBody }
    throw e
  }
}

/** 提交留痕：无论成败追加一条到 userData/fill-log.json（上限 200 条，超出丢最旧；
 * 条目含分项结果与提交载荷，载荷用于失败后从「提交记录」重新提交）。
 * 汉印/禅道失败现场此前无法回溯（应用无日志、平台无失败记录），这里落明文 JSON 便于排查。 */
function appendFillLog(entry) {
  try {
    const file = path.join(app.getPath('userData'), 'fill-log.json')
    let list = []
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* 首次或文件损坏则重建 */ }
    if (!Array.isArray(list)) list = []
    list.push(entry)
    if (list.length > 200) list = list.slice(-200)
    fs.writeFileSync(file, JSON.stringify(list))
  } catch { /* 留痕失败不影响提交本身 */ }
}

function readFillLog() {
  try {
    const file = path.join(app.getPath('userData'), 'fill-log.json')
    const list = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/** 写回留痕（删除记录用）；文件写失败必须让调用方知道，不能静默当成功 */
function writeFillLog(list) {
  const file = path.join(app.getPath('userData'), 'fill-log.json')
  fs.writeFileSync(file, JSON.stringify(list))
}

/** 失败记录：禅道中断（error）或汉印未写入（hp.error）。成功记录整体写入且已核实，
 * 重放只会原样覆盖，没有补交意义——「重新提交」只对失败记录开放。 */
function isFailedLog(e) {
  return !!(e && (e.error || (e.hp && e.hp.error)))
}

/**
 * 提交记录（渲染层「提交记录」面板数据）：倒序最近 limit 条，不含提交载荷全文
 * （载荷只在主进程按 at 索引取，重新提交用）；resubmittable=失败且有存档载荷。
 */
function listLog(limit = 30) {
  return readFillLog()
    .slice(-Math.max(1, Number(limit) || 30))
    .reverse()
    .map((e) => ({
      at: e.at,
      date: e.date,
      dryRun: !!e.dryRun,
      tasks: Array.isArray(e.tasks) ? e.tasks : [],
      // 计划提交的任务总数（失败条目的 tasks 只含已写入项，总数以存档载荷为准）
      ztTotal: e.payload && Array.isArray(e.payload.tasks) ? e.payload.tasks.length : (Array.isArray(e.tasks) ? e.tasks.length : 0),
      hp: e.hp || null,
      ztTasks: e.ztTasks,
      hpSent: e.hpSent,
      error: e.error,
      stage: e.stage,
      failed: isFailedLog(e),
      resubmittable: isFailedLog(e) && !e.dryRun && !!(e.payload && Array.isArray(e.payload.tasks) && e.payload.tasks.length),
    }))
}

/** 删除一条提交记录（仅移除留痕，不动已写入平台的工时）：按 at 唯一定位 */
function removeLog(at) {
  if (!at) throw new Error('缺少提交记录标识')
  const list = readFillLog()
  const next = list.filter((e) => !e || e.at !== at)
  if (next.length === list.length) throw new Error('没有这条提交记录')
  writeFillLog(next)
  return { removed: list.length - next.length, remaining: next.length }
}

/** 按留痕时间重新提交：取该条日志存档的提交载荷原样重放（复用 submit，重新留痕）。
 * 载荷里的 left 是旧值，submit 会按平台最新剩余重算；禅道/汉印已有记录按 ID 复用
 * 更新覆盖，不会重复写入。仅失败记录可重放（成功的已写入并核实，重放无意义）。 */
async function resubmit(at) {
  const entry = readFillLog().find((e) => e && e.at === at)
  if (!entry) throw new Error('没有这条提交记录')
  if (entry.dryRun) throw new Error('预览记录不能重新提交')
  if (!isFailedLog(entry)) throw new Error('该记录已提交成功，无需重新提交')
  if (!entry.payload || !Array.isArray(entry.payload.tasks) || !entry.payload.tasks.length) {
    throw new Error('该记录没有存档提交载荷，请在填报页重新提交')
  }
  return submit({ ...entry.payload, dryRun: false })
}

function localStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  // 带毫秒：同一秒内可能连发多条留痕（失败后立刻重放），秒级时间戳会撞键导致
  // resubmit 匹配到错误的条目；显示层自行截断到秒
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
}

/** 留痕只保存平台和账号的摘要，不包含密码、令牌，避免切换平台后误用旧记录。 */
function submissionScope() {
  const cfg = store.load()
  const scope = (key) => {
    const platform = cfg[key] || {}
    return createHash('sha256').update(JSON.stringify([String(platform.baseUrl || '').replace(/\/+$/, ''), platform.account || '', platform.clientId || ''])).digest('hex')
  }
  return { zentao: scope('zentao'), hanprint: scope('hanprint') }
}

let submissionRunning = false
/** 主进程统一互斥，普通提交、预览与失败重放都必须经过同一入口。 */
async function submit(payload) {
  if (submissionRunning) throw new Error('已有填报正在处理，请等待完成后再提交')
  submissionRunning = true
  try { return await submitLogged(payload) } finally { submissionRunning = false }
}

/** 包住 submitCore 做成败留痕（分项结果 + 提交载荷），失败原样抛出。 */
async function submitLogged(payload) {
  const { date, dryRun, hp } = payload || {}
  const tasksIn = Array.isArray(payload && payload.tasks) ? payload.tasks : []
  const platformScope = submissionScope()
  try {
    const r = await submitCore(payload, platformScope)
    if (!dryRun) {
      const sent = hp && Array.isArray(hp.items) ? hp.items.filter((it) => Number(it.Percent) > 0).length : 0
      appendFillLog({
        at: localStamp(),
        platformScope,
        date,
        dryRun: false,
        tasks: r.results.map((x) => ({ taskId: x.taskId, taskName: x.taskName, consumed: x.consumed, verified: !!x.verified, updated: x.updated, appended: x.appended })),
        hp: r.hp && r.hp.error
          ? { sent, error: r.hp.error }
          : (r.hp ? { sent, updated: r.hp.updated || 0, appended: r.hp.appended || 0 } : (sent ? { sent, updated: 0, appended: sent } : null)),
        ztTasks: r.results.length,
        hpSent: sent,
        payload: { date, tasks: tasksIn, hp: hp && Array.isArray(hp.items) ? { items: hp.items } : null },
      })
    }
    return r
  } catch (e) {
    const prog = e.fillProgress || { tasks: [], hp: null, stage: '' }
    if (!dryRun) {
      const total = tasksIn.length
      const done = prog.tasks.length
      if (done > 0) e.message = `${e.message}（已写入 ${done}/${total} 个禅道任务，可在提交记录中重新提交）`
      appendFillLog({
        at: localStamp(),
        platformScope,
        date,
        dryRun: false,
        tasks: prog.tasks,
        hp: prog.hp,
        ztTasks: done,
        hpSent: prog.hp ? prog.hp.sent : 0,
        error: (e && e.message) || String(e),
        stage: prog.stage,
        raw: prog.raw,
        payload: { date, tasks: tasksIn, hp: hp && Array.isArray(hp.items) ? { items: hp.items } : null },
      })
    }
    delete e.fillProgress
    throw e
  }
}

module.exports = {
  hm,
  workMinutes,
  resolveEndTime,
  isCrossDay,
  stripPrefix,
  distributeByProject,
  parseTimedLines,
  isMine,
  collectTimedCommits,
  listBindings,
  bindProject,
  unbindProject,
  suggestTask,
  buildSubmitTasks,
  buildHpItems,
  plan,
  submit,
  listLog,
  resubmit,
  removeLog,
}
