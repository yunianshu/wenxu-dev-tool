/**
 * 禅道客户端 —— 魔改版禅道（t=json 传统路由 + session cookie）
 * 协议与 wenxu/KnowMore worktime-sync/server.py 的 ZenTao 类保持一致：
 * - 登录：GET refreshRandom 取随机数 → md5(md5(pwd)+rand) 加密 → POST 登录（keepLogin）
 * - 我的任务（进行中）：GET /index.php?m=my&f=work&mode=task&t=json
 * - 我的任务（含已完成/已关闭，供绑定任务选择）：GET /index.php?m=my&f=task&t=json
 * - 工时填报：POST /index.php?m=task&f=recordEstimate&taskID=<id>&onlybody=yes（表单数组 dates[i]/work[i]/consumed[i]/left[i]）
 * 凭据：地址/账号在 config.json 的 zentao 节，密码经 safeStorage 加密落盘，明文只存在于主进程内存。
 * fetch 可注入（fetchImpl）以便自测；cookie 手工管理（全局 fetch 无 cookie jar）。
 */
const crypto = require('crypto')
const store = require('./store')

function md5(text) {
  return crypto.createHash('md5').update(String(text), 'utf8').digest('hex')
}

/** 已完成/已关闭的任务状态（完成任务后仍可能补填工时） */
const FINISHED_STATUS = new Set(['done', 'closed'])
/** 已取消：既不是进行中也没完成，不列入选择列表 */
const CANCELED_STATUS = 'cancel'

/**
 * 已完成任务的时间（YYYY-MM-DD）：优先 finishedDate（点完成时写），回落到 closedDate（关闭时写）。
 * 禅道未设置这些字段时是 0000-00-00 00:00:00，返回空串表示「拿不到完成时间」。
 */
function finishedAt(status, finishedDate, closedDate) {
  if (!FINISHED_STATUS.has(String(status || ''))) return ''
  for (const raw of [finishedDate, closedDate]) {
    const s = String(raw || '')
    if (/^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith('0000')) return s.slice(0, 10)
  }
  return ''
}

/** 解析响应文本中的首个合法 JSON（等价 Python raw_decode：禅道响应尾部可能带脏数据） */
function parseJsonPrefix(text) {
  const s = String(text || '').trim()
  try {
    return JSON.parse(s)
  } catch { /* 尾部脏数据，继续截断尝试 */ }
  for (let end = s.length; end > 1; end--) {
    if (s[end - 1] !== '}') continue // eslint-disable-line no-continue
    try {
      return JSON.parse(s.slice(0, end))
    } catch { /* 缩短前缀重试 */ }
  }
  throw new Error(`禅道响应解析失败: ${s.slice(0, 120)}`)
}

class ZentaoClient {
  constructor({ baseUrl, account, password, fetchImpl }) {
    this.base = String(baseUrl || '').replace(/\/+$/, '')
    this.account = account
    this.password = password
    this.fetchImpl = fetchImpl || ((url, opts) => fetch(url, opts))
    this.cookies = new Map()
    this.loginPromise = null
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** 吸收响应 Set-Cookie 到手工 cookie jar（同名覆盖，模拟 requests.Session） */
  absorbCookies(resp) {
    const headers = resp && resp.headers
    if (!headers || typeof headers.getSetCookie !== 'function') return
    for (const raw of headers.getSetCookie() || []) {
      const pair = String(raw).split(';')[0]
      const idx = pair.indexOf('=')
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
    }
  }

  /**
   * 单次请求 + 手工重定向跟随（每跳都携带最新 cookie）。
   * 301/302/303 的 POST 重定向按浏览器语义降级为 GET（登录表单只提交一次）。
   * 返回响应对象，并挂 finalUrl 供会话失效判断（等价 requests 的 r.url）。
   */
  async request(path, { method = 'GET', form, headers = {}, maxRedirects = 6 } = {}) {
    let url = this.base + path
    let curMethod = method
    let curForm = form
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const h = { ...headers, 'User-Agent': 'Mozilla/5.0 project-tool' }
      const cookie = this.cookieHeader()
      if (cookie) h.Cookie = cookie
      const opts = { method: curMethod, headers: h, redirect: 'manual', signal: AbortSignal.timeout(15000) }
      if (curForm) {
        opts.body = new URLSearchParams(curForm).toString()
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      }
      const resp = await this.fetchImpl(url, opts) // eslint-disable-line no-await-in-loop
      this.absorbCookies(resp)
      resp.finalUrl = url
      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get('location')
        if (!location) return resp
        url = new URL(location, url).toString()
        if (resp.status === 301 || resp.status === 302 || resp.status === 303) {
          curMethod = 'GET'
          curForm = undefined
        }
        continue // eslint-disable-line no-continue
      }
      return resp
    }
    throw new Error('禅道响应重定向次数过多')
  }

  /** 登录（并发调用共享同一次登录）；成功后 session cookie 保活 */
  async login() {
    if (this.loginPromise) return this.loginPromise
    this.loginPromise = (async () => {
      // 取初始 cookie（zentaosid），与 KnowMore 登录序列一致
      await this.request('/index.php')
      await this.request('/index.php?m=user&f=login')
      const loginReferer = `${this.base}/index.php?m=user&f=login`
      const randResp = await this.request('/index.php?m=user&f=refreshRandom', {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: loginReferer },
      })
      const rand = (await randResp.text()).trim().replace(/^"+|"+$/g, '')
      if (!rand) throw new Error('禅道未返回登录随机数（refreshRandom 为空）')
      const encoded = md5(md5(this.password) + rand)
      const resp = await this.request('/index.php?m=user&f=login', {
        method: 'POST',
        form: {
          account: this.account,
          password: encoded,
          passwordStrength: 1,
          referer: '/',
          verifyRand: rand,
          keepLogin: 1,
          captcha: '',
        },
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: loginReferer },
      })
      const text = await resp.text()
      if (!/result['"]?\s*:\s*['"]success/.test(text)) {
        throw new Error(`禅道登录失败: ${text.slice(0, 120)}`)
      }
      return true
    })()
    try {
      return await this.loginPromise
    } finally {
      this.loginPromise = null
    }
  }

  /** GET t=json 接口；会话失效（登录已超时 / 被重定向到登录页）自动重登一次重试 */
  async getJson(path, retried = false) {
    const resp = await this.request(path, { headers: { 'X-Requested-With': 'XMLHttpRequest' } })
    const text = await resp.text()
    if (text.includes('登录已超时') || /user-login/.test(resp.finalUrl || '')) {
      if (!retried) {
        await this.login()
        return this.getJson(path, true)
      }
      throw new Error('禅道会话失效且重登失败')
    }
    if (resp.status < 200 || resp.status >= 300) throw new Error(`禅道查询失败：HTTP ${resp.status}`)
    return parseJsonPrefix(text)
  }

  /**
   * 我的地盘-任务列表归一化，附完成状态（完成的判定见 finishedAt）。
   * 兼容 data 为 JSON 字符串、tasks 为 dict 的魔改返回。
   */
  async fetchTaskList(path) {
    const d = await this.getJson(path)
    let inner = d && d.data
    if (typeof inner === 'string') inner = parseJsonPrefix(inner)
    let tasks = (inner && inner.tasks) || []
    if (!Array.isArray(tasks)) tasks = Object.values(tasks)
    return tasks
      .filter((t) => t && t.id !== undefined)
      .map((t) => {
        const status = t.status || ''
        return {
          id: Number(t.id),
          name: String(t.name || ''),
          status,
          consumed: Number(t.consumed || 0),
          left: Number(t.left || 0),
          finished: FINISHED_STATUS.has(status),
          finishedAt: finishedAt(status, t.finishedDate, t.closedDate),
        }
      })
  }

  /** 我的地盘-任务（只列未完成任务）。提交链路取「最新剩余工时」用，语义不要改 */
  async myTasks() {
    const list = await this.fetchTaskList('/index.php?m=my&f=work&mode=task&t=json')
    return list.map((t) => ({ id: t.id, name: t.name, status: t.status, consumed: t.consumed, left: t.left }))
  }

  /**
   * 绑定任务用的选择列表：进行中在前，近 days 天内完成/关闭的在后——任务完成后仍可能要
   * 补填工时，只列进行中会让这些任务选不到。
   *
   * 入口差异（已对真实实例实测）：my-task（m=my&f=task）列的是「指派给我」的任务，
   * 只有进行中 + 我关闭/取消的，**不含已完成**；我完成、但指派人是他人的任务（接手他人
   * 任务完成的情形）只出现在 finishedBy（m=my&f=task&type=finishedBy，「我完成的」）。
   * 两个入口都要取，否则刚完成的任务在绑定弹窗里根本选不到（用户报障：已完成任务无法绑定）。
   * 分页与其它 type 参数该实例会返回空列表，一律不传；已完成入口失败不阻断主列表。
   *
   * 已知完成时间超出窗口的才剔除；禅道没记时间的已完成任务无法判定，照列（排在最后）——
   * 宁多勿漏，否则刚完成的任务可能因为没写 finishedDate 而选不到。已取消的任务不列。
   */
  async myTaskOptions({ days = 30 } = {}) {
    const [assigned, finishedByMe] = await Promise.all([
      this.fetchTaskList('/index.php?m=my&f=task&t=json'),
      this.fetchTaskList('/index.php?m=my&f=task&type=finishedBy&t=json').catch(() => []),
    ])
    const seen = new Set()
    const list = []
    for (const t of [...assigned, ...finishedByMe]) {
      const key = String(t.id)
      if (seen.has(key)) continue
      seen.add(key)
      list.push(t)
    }
    const since = new Date(Date.now() - days * 86400000)
    const p = (n) => String(n).padStart(2, '0')
    const sinceStr = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())}`
    const active = []
    const finished = []
    for (const t of list) {
      if (t.status === CANCELED_STATUS) continue // eslint-disable-line no-continue
      if (!t.finished) active.push(t)
      else if (!t.finishedAt || t.finishedAt >= sinceStr) finished.push(t)
    }
    finished.sort((a, b) => {
      if (!a.finishedAt) return 1 // 完成时间未知的排最后
      if (!b.finishedAt) return -1
      return a.finishedAt < b.finishedAt ? 1 : a.finishedAt > b.finishedAt ? -1 : b.id - a.id
    })
    return [...active, ...finished]
  }

  /**
   * 任务详情。myTasks 只列未完成任务，已完成/已关闭/已转交的任务从这里取最新剩余工时
   * （完成时禅道会把 left 置 0）。查询失败或结构无法识别返回 null，由调用方决定是否阻断。
   */
  async getTaskById(taskId) {
    let d
    try {
      d = await this.getJson(`/index.php?m=task&f=view&taskID=${taskId}&t=json`)
    } catch {
      return null // 任务不存在/无权限/网络异常：统一按「拿不到」处理
    }
    let inner = d && d.data
    if (typeof inner === 'string') inner = parseJsonPrefix(inner)
    const t = inner && inner.task
    if (!t || t.id === undefined) return null
    return {
      id: Number(t.id),
      name: String(t.name || ''),
      status: t.status || '',
      consumed: Number(t.consumed || 0),
      left: Number(t.left || 0),
    }
  }

  /**
   * 查询任务已有工时记录（recordEstimate 页面数据，魔改版返回结构不定，容错解析）。
   * 返回 [{ id, date:'YYYY-MM-DD', work, consumed, left }]；查询或解析失败抛错，避免误追加。
   */
  async getTaskEfforts(taskId) {
    const d = await this.getJson(`/index.php?m=task&f=recordEstimate&taskID=${taskId}&t=json`)
    let inner = d && d.data
    if (typeof inner === 'string') {
      inner = parseJsonPrefix(inner)
    }
    const candidates = [inner && inner.efforts, inner && inner.records, inner && inner.list, d && d.efforts]
    let list = null
    for (const c of candidates) {
      if (c && typeof c === 'object') { list = Array.isArray(c) ? c : Object.values(c); break }
    }
    if (!list) throw new Error('禅道已有工时响应结构无法识别，已停止提交')
    if (list.some((x) => !x || !Number.isInteger(Number(x.id)) || Number(x.id) <= 0 || !/^\d{4}-\d{2}-\d{2}/.test(String(x.date || '')) || !Number.isFinite(Number(x.consumed)) || Number(x.consumed) < 0)) {
      throw new Error('禅道已有工时记录不完整，已停止提交')
    }
    return list
      .filter((x) => x && x.id !== undefined)
      .map((x) => ({
        id: Number(x.id),
        date: String(x.date || '').slice(0, 10),
        work: String(x.work || x.workDesc || ''),
        consumed: Number(x.consumed || 0),
        left: Number(x.left || 0),
      }))
  }

  /**
   * 工时填报。rows: [{ date:'YYYY-MM-DD', work, consumed, left, effortId? }]
   * 表单键使用 effortId（任务已有记录的 ID → 更新覆盖）；未提供时退回行号（追加，同 KnowMore）。
   * dryRun=true 只构造表单不发请求（预览用）。
   */
  async recordEfforts(taskId, rows, dryRun = false) {
    const form = {}
    const list = rows || []
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i]
      // eslint-disable-next-line no-nested-ternary
      const key = row.effortId !== undefined && row.effortId !== null ? row.effortId : i + 1
      form[`dates[${key}]`] = row.date
      form[`id[${key}]`] = key
      form[`work[${key}]`] = row.work
      form[`consumed[${key}]`] = row.consumed
      form[`left[${key}]`] = row.left
    }
    const path = `/index.php?m=task&f=recordEstimate&taskID=${taskId}&onlybody=yes`
    if (dryRun) return { dryRun: true, url: this.base + path, form }
    const resp = await this.request(path, {
      method: 'POST',
      form,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${this.base}/index.php?m=task&f=view&taskID=${taskId}`,
      },
    })
    const body = await resp.text()
    if (body.includes('登录已超时') || /user-login/.test(resp.finalUrl || '')) {
      throw new Error('禅道会话已失效，请重新提交')
    }
    if (resp.status < 200 || resp.status >= 300) throw new Error(`禅道提交失败：HTTP ${resp.status}，请核对平台记录后重试`)
    let result
    try { result = parseJsonPrefix(body) } catch {
      // 响应异常 ≠ 写入失败（魔改版 recordEstimate 偶发返回非 JSON）。直接抛错会把
      // 「首个任务已写入」误当中止点，剩余任务全部漏交；先回查当日工时核实，
      // 与本次提交逐行匹配则按已写入继续，查无匹配才视为失败
      let verified = false
      try { verified = await this.verifyEfforts(taskId, rows) } catch { /* 回查也失败则按无法确认处理 */ }
      if (verified) return { status: resp.status, verified: true, body: body.slice(0, 200) }
      const err = new Error('无法确认禅道提交结果，请先核对平台记录，避免重复提交')
      err.rawBody = body.slice(0, 200)
      throw err
    }
    if (!result || result.result !== 'success') {
      throw new Error('禅道未确认提交成功，请核对平台记录及工时内容')
    }
    return { status: resp.status, body: body.slice(0, 200) }
  }

  /**
   * 回查核实：当日已有工时记录与本次提交的每一行（work + consumed）均匹配 → 已写入。
   * work 是当天唯一的编号列表，精确匹配即可；查询失败由调用方按「无法确认」处理。
   */
  async verifyEfforts(taskId, rows) {
    const date = rows && rows[0] && rows[0].date
    if (!date) return false
    const today = (await this.getTaskEfforts(taskId)).filter((e) => e.date === date)
    return rows.every((r) => today.some((e) => e.work === r.work && Number(e.consumed) === Number(r.consumed)))
  }
}

// ─── 模块级共享客户端：凭据变化时重建（等价 KnowMore 的 zt_client） ───
let shared = null
let sharedKey = ''

/**
 * 取已登录的共享客户端。overrides 用于「测试连接」（临时输入的地址/账号/密码，
 * 密码为空则使用已保存密文解密值）。
 */
async function ensureClient(overrides = {}) {
  const cfg = store.load()
  const baseUrl = overrides.baseUrl || (cfg.zentao && cfg.zentao.baseUrl) || ''
  const account = overrides.account || (cfg.zentao && cfg.zentao.account) || ''
  const password = overrides.password !== undefined && overrides.password !== ''
    ? overrides.password
    : store.getZentaoPwd()
  if (!baseUrl || !account || !password) {
    throw new Error('禅道未配置：请到「设置 → 一键填报」填写禅道地址、账号与密码')
  }
  const key = JSON.stringify([baseUrl, account, password])
  if (!shared || sharedKey !== key) {
    shared = new ZentaoClient({ baseUrl, account, password })
    sharedKey = key
    await shared.login()
  }
  return shared
}

/** 渲染层传参规范化：空字符串密码表示「使用已保存密码」 */
function normalizeOverrides(o = {}) {
  return {
    baseUrl: String(o.baseUrl || '').trim(),
    account: String(o.account || '').trim(),
    password: o.password === undefined ? '' : String(o.password),
  }
}

module.exports = { ZentaoClient, parseJsonPrefix, ensureClient, normalizeOverrides, md5 }
