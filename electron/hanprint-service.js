/**
 * 汉印工时平台客户端 —— 协议与 wenxu/KnowMore worktime-sync/server.py 的 HP 类一致：
 * - 登录：GET /login/getToken?clientId=&userName=&pwd= → { code:0, data:token }
 * - 业务 GET 均带请求头 token；code=-2 表示 token 过期（自动重登一次）
 * - 任务字典：GET /com/workhour/GetDict?dictType=1（Key=3 为「软件项目」）
 * - 项目列表：GET /com/workhour/GetProjectList?projecttype=
 * - 项目任务：GET /com/workhour/GetProjectTaskList?projectid=&projecttype=
 * - 提交工时：POST /com/workhour/add，body 为 JSON 数组，ΣPercent 必须 = 100
 * 核心约定：汉印「软件项目(type=3)」任务的 Key 即禅道任务 ID（两系统数据同源）。
 * 凭据：地址/clientId/工号在 config.json 的 hanprint 节，密码经 safeStorage 加密落盘，
 * 明文只存在于主进程内存；fetch 可注入（fetchImpl）以便自测。
 */
const store = require('./store')

const DEFAULT_TIMEOUT_MS = 20000

/** 解析响应 JSON；网关错误页/代理拦截页等非 JSON 响应转为可读错误 */
async function parseBody(resp) {
  let body
  try {
    body = await resp.json()
  } catch {
    throw new Error('汉印接口返回非 JSON（可能是网关错误页或地址不正确）')
  }
  if (!body || typeof body !== 'object') throw new Error('汉印接口响应格式异常')
  return body
}

class HanprintClient {
  constructor({ baseUrl, clientId, account, password, fetchImpl }) {
    this.base = String(baseUrl || '').replace(/\/+$/, '')
    this.clientId = String(clientId || '1')
    this.account = account
    this.password = password
    this.fetchImpl = fetchImpl || ((url, opts) => fetch(url, opts))
    this.token = ''
  }

  /** GET（query 参数）；返回 { code, msg, data } */
  async get(path, params = {}, retried = false) {
    const qs = new URLSearchParams(params).toString()
    const url = `${this.base}${path}${qs ? `?${qs}` : ''}`
    const headers = { token: this.token }
    const resp = await this.fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    const body = await parseBody(resp)
    if (body && body.code === -2) {
      if (retried) throw new Error('汉印 token 过期且重登失败')
      await this.login()
      return this.get(path, params, true)
    }
    return body
  }

  /** 业务 GET：code!==0 抛错，成功返回 data */
  async getData(path, params) {
    const body = await this.get(path, params)
    if (!body || body.code !== 0) {
      throw new Error(`汉印接口错误: ${(body && body.msg) || '未知错误'}`)
    }
    return body.data
  }

  async login() {
    // 直接底层请求（不走 get）：规避 getToken 自身返回 -2 时「重登递归」
    const qs = new URLSearchParams({
      clientId: this.clientId, userName: this.account, pwd: this.password,
    }).toString()
    const resp = await this.fetchImpl(`${this.base}/login/getToken?${qs}`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    const body = await parseBody(resp)
    if (!body || body.code !== 0) {
      throw new Error(`汉印登录失败: ${(body && body.msg) || '未知错误'}`)
    }
    this.token = body.data
    return true
  }

  /** 确保已登录（token 为空时登录） */
  async ensureLogin() {
    if (!this.token) await this.login()
    return this
  }

  /** 全部报工类型的项目与任务（类型与项目两级并行，单个子列表失败不影响整体；结果保持类型顺序） */
  async allTypeTasks() {
    await this.ensureLogin()
    // 字典失败必须抛错：吞掉会以「空分组」伪装成成功，下游条目构造全部落空而 hpReady 仍为 true
    const dict = (await this.getData('/com/workhour/GetDict', { dictType: 1 })) || []
    // 各类型独立收集：原先三层串行，整链耗时 = 所有请求之和，计划页生成明显偏慢
    const perType = await Promise.all(dict.map(async (ty) => {
      let projects = []
      try {
        projects = (await this.getData('/com/workhour/GetProjectList', { projecttype: ty.Key })) || []
      } catch { /* 该类型项目列表失败则跳过 */ }
      const rows = await Promise.all(projects.map(async (p) => {
        let tasks = []
        try {
          tasks = (await this.getData('/com/workhour/GetProjectTaskList', {
            projectid: p.Key,
            projecttype: ty.Key,
          })) || []
        } catch { /* 单项目任务失败则跳过 */ }
        return { type: ty.Key, typeName: ty.Name, projectId: p.Key, projectName: p.Name, tasks }
      }))
      return rows
    }))
    return perType.flat()
  }

  /** 当日已填记录（协议同 workhour-h5：ProjectType=-2 为删除标记行，需调用方跳过） */
  async getByDate(workDate) {
    await this.ensureLogin()
    return (await this.getData('/com/workhour/GetByDate', { workDate })) || []
  }

  /** 提交工时条目数组；dryRun=true 只回显不发；条目带非零 Id 时为更新（同 workhour-h5 语义）。
   * code=-2（token 过期，服务端未受理）与 GET 一致重登后重试一次；其余失败不重试——
   * 超时等「可能已写入」的失败重试会造出重复记录（Id=0 追加无幂等键）。 */
  async add(items, dryRun = false, retried = false) {
    await this.ensureLogin()
    if (dryRun) return { dryRun: true, url: `${this.base}/com/workhour/add`, json: items }
    const resp = await this.fetchImpl(`${this.base}/com/workhour/add`, {
      method: 'POST',
      headers: {
        token: this.token,
        'Content-Type': 'application/json;charset=utf8',
      },
      body: JSON.stringify(items || []),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    const body = await parseBody(resp)
    if (body && body.code === -2) {
      if (retried) throw new Error('汉印 token 过期且重登失败')
      await this.login()
      return this.add(items, dryRun, true)
    }
    if (!body || body.code !== 0) {
      throw new Error(`汉印提交失败: ${(body && body.msg) || '未知错误'}`)
    }
    return { status: 'ok' }
  }
}

// ─── 模块级共享客户端 + 任务组短缓存（凭据变化时双双失效） ───
let shared = null
let sharedKey = ''
let groupsCache = null
let groupsCacheAt = 0
const GROUPS_TTL_MS = 60 * 1000

/**
 * 取共享客户端。overrides 用于「测试连接」（临时输入，密码为空则用已保存密文）。
 */
async function ensureClient(overrides = {}) {
  const cfg = store.load()
  const baseUrl = overrides.baseUrl || (cfg.hanprint && cfg.hanprint.baseUrl) || ''
  const clientId = overrides.clientId || (cfg.hanprint && cfg.hanprint.clientId) || '1'
  const account = overrides.account || (cfg.hanprint && cfg.hanprint.account) || ''
  const password = overrides.password !== undefined && overrides.password !== ''
    ? overrides.password
    : store.getHanprintPwd()
  if (!baseUrl || !account || !password) {
    throw new Error('汉印未配置：请到「设置 → 一键填报」填写汉印地址、工号与密码')
  }
  const key = JSON.stringify([baseUrl, clientId, account, password])
  if (!shared || sharedKey !== key) {
    shared = new HanprintClient({ baseUrl, clientId, account, password })
    sharedKey = key
    groupsCache = null
    await shared.login()
  }
  return shared
}

/** 任务组列表（60s 进程内缓存；force=true 绕过）。空结果不缓存：
 * 瞬时失败得到的不完整分组若按成功缓存 60s，重试也会拿到同样的残缺数据。 */
async function getGroups(force = false) {
  if (!force && groupsCache && groupsCache.length && Date.now() - groupsCacheAt < GROUPS_TTL_MS) {
    return groupsCache
  }
  const client = await ensureClient()
  const groups = await client.allTypeTasks()
  if (Array.isArray(groups) && groups.length) {
    groupsCache = groups
    groupsCacheAt = Date.now()
  }
  return groups
}

/** 渲染层传参规范化：空字段表示「使用已保存配置」 */
function normalizeOverrides(o = {}) {
  return {
    baseUrl: String(o.baseUrl || '').trim(),
    clientId: String(o.clientId || '').trim(),
    account: String(o.account || '').trim(),
    password: o.password === undefined ? '' : String(o.password),
  }
}

module.exports = { HanprintClient, ensureClient, getGroups, normalizeOverrides }
