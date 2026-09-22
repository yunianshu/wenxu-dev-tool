/**
 * Git 服务 —— 仓库扫描 / 提交收集 / 仓库信息（跨平台，纯 Node 实现，不依赖系统 find）
 */
const { execFile } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')

/** 默认按目录名包含匹配排除的目录（第三方克隆 / SDK / 缓存 / 系统目录） */
const DEFAULT_CONTAINS_EXCLUDES = [
  'node_modules', 'FlutterSDK', 'fvm_cache', '__MACOSX', '.cache',
  'android-sdk', 'androidsdk', 'jdk', 'Program Files', 'Pods',
  'System Volume Information', '$RECYCLE.BIN', '.gradle', '.idea', 'go/pkg'
]

/** 单次 git 命令执行（不经过 shell，避免注入与路径转义问题） */
function execGit(repo, args, maxBuffer = 64 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() })
      resolve({ ok: true, stdout })
    })
  })
}

/** 全局 git 命令（如 git config --global） */
function execGitGlobal(args, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', args, { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() })
      resolve({ ok: true, stdout })
    })
  })
}

/** 路径归一化（Windows 转小写+统一斜杠），用于防环集合 */
function normalizePath(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p
}

/** 按跨平台规范化路径稳定去重，保留首次出现的原始路径与顺序 */
function uniquePaths(paths) {
  const seen = new Set()
  const result = []
  for (const value of paths || []) {
    if (!value) continue
    const key = normalizePath(value)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

/** 仓库内部常见的重型目录：下钻找嵌套仓库时跳过（几乎不可能含独立仓库） */
const REPO_HEAVY_DIRS = ['build', 'out', 'target', 'dist', 'bin', '.cxx', 'CMakeFiles', '.dart_tool', '.hvigor']

/**
 * 递归扫描根目录，发现 Git 仓库（含浅层嵌套仓库），自动排除系统/缓存目录。
 *
 * 性能策略（实测：9 大项目目录 45s → ~3s，15 倍提速，召回率不变）：
 * - 同步 readdirSync 顺序遍历：Windows 上比异步(经 libuv 线程池)更快
 * - 发现仓库后不再深度下钻：只在其内部继续找最多 REPO_SUB_DEPTH 层嵌套仓库
 *   （覆盖子模块/嵌套工程，跳过 build/out/target 等重型目录）
 * - 不逐目录 realpath：路径归一化 + 深度上限防环
 * - 主进程阻塞不影响渲染进程（独立进程），流式事件照常推送
 *
 * @param onProgress 目录遍历进度回调（节流）
 * @param onRepo 每发现一个仓库立即回调（流式增量展示）
 */
async function scanRepos(roots, excludes, onProgress, onRepo) {
  const REPO_SUB_DEPTH = 4
  const contains = [...DEFAULT_CONTAINS_EXCLUDES, ...(excludes || [])]
  const visited = new Set()
  const repos = []
  let scanned = 0
  let lastProgressAt = 0

  const stack = []
  for (const root of roots || []) {
    if (root && fs.existsSync(root)) stack.push({ dir: root, depth: 0, repoBase: -1 })
  }

  let processed = 0
  while (stack.length > 0) {
    // 每处理一批目录就让出事件循环，避免长时间阻塞主进程
    // （否则渲染进程的 IPC 请求如 configLoad 会排队，导致界面卡住无法切换）
    if (++processed % 200 === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const { dir, depth, repoBase } = stack.pop()
    if (depth > 16) continue
    // 已处于某个仓库内部且下钻超过上限 → 停止（避免遍历仓库完整内部树）
    if (repoBase >= 0 && depth - repoBase > REPO_SUB_DEPTH) continue
    const norm = normalizePath(dir)
    if (visited.has(norm)) continue
    visited.add(norm)

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    scanned += 1
    // 进度按时间节流（≥50ms 一次）：扫描快时大幅减少 IPC/回调次数，UI 观感不变
    if (onProgress) {
      const now = Date.now()
      if (now - lastProgressAt >= 50) {
        lastProgressAt = now
        try { onProgress({ scanned, current: dir }) } catch { /* noop */ }
      }
    }

    // 单次遍历同时完成 .git 检测与子目录收集（原先 some + for 两遍遍历）
    let isRepo = false
    const childNames = []
    for (const entry of entries) {
      if (entry.name === '.git') {
        isRepo = true
        continue
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (contains.some((p) => p && entry.name.includes(p))) continue
      childNames.push(entry.name)
    }
    if (isRepo) {
      repos.push(dir)
      if (onRepo) {
        try { onRepo(dir) } catch { /* noop */ }
      }
    }
    const childBase = isRepo ? depth : repoBase
    for (const name of childNames) {
      // 仓库内部跳过重型目录，减少无效遍历
      if (isRepo && REPO_HEAVY_DIRS.some((p) => name.includes(p))) continue
      stack.push({ dir: path.join(dir, name), depth: depth + 1, repoBase: childBase })
    }
  }

  return repos
}

/**
 * 扫描结果缓存 + 进行中去重 —— 预热/生成/设置页共用同一次扫盘：
 * - 相同 roots+excludes 的并发调用共享同一 Promise（不重复扫盘）
 * - 已完成的结果进程内缓存，重复调用瞬时返回（force=true 仅绕过已完成缓存，用于手动重新扫描）
 * - 进度/发现事件由调用方广播（main 层统一 send 到渲染端），多调用方共享进度流
 */
const scanCache = new Map()
const scanInflight = new Map()

function scanKey(roots, excludes) {
  return `${(roots || []).join('\u0000')}\u0001${(excludes || []).slice().sort().join('\u0000')}`
}

async function scanReposCached(roots, excludes, opts = {}) {
  const { force = false, onProgress, onRepo } = opts
  const key = scanKey(roots, excludes)
  // 正在扫描的任务已经读取当前磁盘状态；强制扫描也应复用它，避免同一路径广播两套发现事件。
  const inflight = scanInflight.get(key)
  if (inflight) return inflight
  if (!force) {
    const cached = scanCache.get(key)
    if (cached) return cached
  }
  const task = scanRepos(roots, excludes, onProgress, onRepo).then((repos) => {
    scanCache.set(key, repos)
    scanInflight.delete(key)
    return repos
  }, (err) => {
    scanInflight.delete(key)
    throw err
  })
  scanInflight.set(key, task)
  return task
}

/** 扫描根目录/排除规则变化后使缓存失效（下次扫描/预热重新扫盘） */
function invalidateScanCache() {
  scanCache.clear()
}

/** 获取仓库展示信息：远程地址、当前分支、最近一次提交 */
async function getRepoInfo(repo) {
  const [remote, branch, last] = await Promise.all([
    execGit(repo, ['remote', 'get-url', 'origin']),
    execGit(repo, ['branch', '--show-current']),
    execGit(repo, ['log', '-1', '--pretty=%ad|%s', '--date=short']),
  ])
  return {
    remote: remote.ok ? remote.stdout.trim() : '',
    branch: branch.ok ? branch.stdout.trim() : '',
    lastCommit: last.ok ? last.stdout.trim() : '',
  }
}

/** 提交行解析格式：hash ⇥ 日期 ⇥ 作者名 ⇥ 邮箱 ⇥ 主题 */
const COMMIT_FMT = '%H%x09%ad%x09%an%x09%ae%x09%s'

// 关键：git 对裸日期(YYYY-MM-DD)的 --since/--until 解析在部分版本异常
// （实测 2.53.0 将 --since=2026-08-04 误判），统一转为带精确时间格式
const normDate = (d) => (d && !d.includes(' ') ? `${d} 00:00:00` : d)

/** 裸日期（YYYY-MM-DD）：仅此类输入支持按天对齐的无缝增量补查 */
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 本地时区当天（YYYY-MM-DD） */
function todayLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 本地时区明天（YYYY-MM-DD）：预热「日报=今天」范围的排他上界 */
function tomorrowLocal() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function tryCall(fn, payload) { try { fn(payload) } catch { /* noop */ } }

/**
 * 收集结果缓存 —— 进程内存 LRU（上限 8 条）：
 * - 相同参数重复收集直接复用（反复生成/切换视图不再重扫历史）
 * - 新范围为某缓存条目的超集时仅补查缺口区间（如日报→周报只补差额天数）
 * - 仓库列表（含顺序）/作者/合并参数任一变化自动视为不同 key
 *
 * 每次先检查轻量 refs/HEAD 指纹：fetch/pull/checkout/rebase 后立即失效；
 * 所有范围最多缓存 FRESH_TTL，避免历史报告长期漏掉后补或改写的提交。
 */
const COLLECT_CACHE_LIMIT = 8
/** 各日期范围允许复用的最长时间（毫秒） */
const COLLECT_FRESH_TTL = 120 * 1000
const collectCache = new Map()
/** 进行中任务的并发去重：相同参数的并发调用共享同一 Promise（后续加入者收不到中间进度） */
const collectInflight = new Map()

/** 归一化收集参数并预计算签名（authors 参与 key：排序后拼接，OR 语义与顺序无关） */
function normCollectOpts(opts) {
  const o = opts || {}
  const authors = Array.isArray(o.authors) ? o.authors.filter(Boolean) : []
  return {
    since: o.since || '',
    until: o.until || '',
    includeMerges: !!o.includeMerges,
    authors,
    authorsSig: [...authors].sort().join('\u0000'),
  }
}

/** 构造单仓库 git log 参数（多 --author 为 git 原生 OR 语义，单次遍历覆盖全部作者） */
function buildLogArgs({ since, until, includeMerges, authors }) {
  const args = ['log', '--all', `--since=${normDate(since)}`]
  if (until) args.push(`--until=${normDate(until)}`)
  if (!includeMerges) args.push('--no-merges')
  args.push(`--pretty=tformat:${COMMIT_FMT}`, '--date=short')
  for (const a of authors) args.push(`--author=${a}`)
  return args
}

/** 解析单仓库 git log 输出为提交对象数组 */
function parseCommitLines(repo, stdout) {
  const list = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [hash, date, authorName, authorEmail, ...rest] = parts
    if (!hash || !date) continue
    list.push({ repo, hash: hash.slice(0, 10), date, authorName, authorEmail, subject: rest.join('\t') })
  }
  return list
}

/** 单仓库查询（失败返回空，不影响其它仓库） */
async function queryRepo(repo, args) {
  const res = await execGit(repo, args)
  return res.ok ? parseCommitLines(repo, res.stdout) : []
}

/** 收集并发度：按 CPU 核数自适应（git 子进程为短时 IO/CPU 混合，适度超订更快），上限 16 */
const COLLECT_CONCURRENCY = Math.max(8, Math.min((os.cpus() || []).length * 2, 16))

/** 固定并发池：按序消费任务队列，返回与任务等长的结果数组 */
async function runPool(tasks, job, concurrency = COLLECT_CONCURRENCY) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = Math.max(1, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= tasks.length) return
      // eslint-disable-next-line no-await-in-loop
      results[i] = await job(tasks[i], i)
    }
  }))
  return results
}

/** 执行收集任务并回报进度（进度折算到 done/total=仓库数，保持既有事件语义） */
async function runCollectTasks(repos, tasks, onProgress) {
  const total = tasks.length
  let done = 0
  return runPool(tasks, async (t) => {
    const list = await queryRepo(t.repo, t.args) // eslint-disable-line no-await-in-loop
    done += 1
    if (onProgress) {
      const scaled = total ? Math.round((done / total) * repos.length) : repos.length
      tryCall(onProgress, { done: Math.min(scaled, repos.length), total: repos.length, current: t.repo })
    }
    return list
  })
}

function groupCommitsByRepo(commits) {
  const m = new Map()
  for (const c of commits) {
    if (!m.has(c.repo)) m.set(c.repo, [])
    m.get(c.repo).push(c)
  }
  return m
}

/** refs 查询不遍历提交历史，热路径只需检查仓库引用是否变化。 */
async function repositoryFingerprint(repos) {
  const refs = await runPool(repos, async (repo) => {
    const result = await execGit(repo, ['show-ref', '--head', '--dereference'])
    // 查询失败不能信任旧缓存；空仓库同样走实际查询，避免错误结果长期保留。
    return result.ok ? result.stdout : `unavailable:${Date.now()}:${Math.random()}`
  })
  return createHash('sha256').update(JSON.stringify(refs)).digest('hex')
}

/** 即使引用不变，过期的历史缓存也重新读取（例如浅克隆加深）。 */
function cacheUsable(entry) {
  return Date.now() - entry.createdAt <= COLLECT_FRESH_TTL
}

/**
 * 收集提交（并发池 + 结果缓存 + 增量补查）。输出语义与串行版本一致：
 * - 结果严格按传入仓库顺序排列，单仓库内按 git log 逆时间序
 * - 进度 { done, total, current } 中 done 为已完成仓库数（缓存命中时直接满格）
 */
async function collectCommits(repos, opts, onProgress) {
  const o = normCollectOpts(opts)
  // 调用方可能因并发扫描事件得到重复路径；底层集中去重，确保每个仓库只执行一次查询。
  const repoList = uniquePaths(repos)
  const reposSig = repoList.join('\u0000')
  const refsSig = await repositoryFingerprint(repoList)
  const key = [reposSig, refsSig, o.since, o.until, o.includeMerges ? 1 : 0, o.authorsSig].join('\u0001')

  // 1) 精确命中：引用未变化且仍在有效期内时复用，LRU 触碰保活跃度。
  const hit = collectCache.get(key)
  if (hit && cacheUsable(hit)) {
    collectCache.delete(key)
    collectCache.set(key, hit)
    if (onProgress) tryCall(onProgress, { done: repoList.length, total: repoList.length, current: '' })
    return hit.commits
  }

  // 2) 并发去重：相同参数的进行中收集直接共享结果
  if (collectInflight.has(key)) return collectInflight.get(key)

  const task = (async () => {
    // 3) 增量：仅复用引用未变化且未过期的历史范围
    let base = null
    if (BARE_DATE_RE.test(o.since) && BARE_DATE_RE.test(o.until)) {
      for (const [k, v] of collectCache) {
        if (v.reposSig !== reposSig) continue
        if (v.refsSig !== refsSig || !cacheUsable(v)) continue
        if (v.includeMerges !== o.includeMerges || v.authorsSig !== o.authorsSig) continue
        if (!BARE_DATE_RE.test(v.since) || !BARE_DATE_RE.test(v.until)) continue
        const vUntil = v.until
        if (o.since <= v.since && o.until >= vUntil) {
          const span = Date.parse(vUntil) - Date.parse(v.since)
          const baseSpan = base ? Date.parse(base.until) - Date.parse(base.since) : Infinity
          if (span < baseSpan) {
            base = {
              since: v.since,
              until: vUntil,
              commits: vUntil < v.until ? v.commits.filter((c) => c.date < vUntil) : v.commits,
            }
          }
        }
      }
    }

    let commits
    if (base) {
      // 缺口均为半开按天对齐区间：右 [base.until, until)、左 [since, base.since)，与缓存体无缝不重叠
      const tasks = []
      if (o.until > base.until) for (const r of repoList) tasks.push({ repo: r, side: 'right' })
      if (o.since < base.since) for (const r of repoList) tasks.push({ repo: r, side: 'left' })
      const results = await runCollectTasks(repoList, tasks.map((t) => ({
        repo: t.repo,
        args: buildLogArgs({
          since: t.side === 'left' ? o.since : base.until,
          until: t.side === 'left' ? base.since : o.until,
          includeMerges: o.includeMerges,
          authors: o.authors,
        }),
      })), onProgress)

      const rightBy = new Map()
      const leftBy = new Map()
      tasks.forEach((t, i) => {
        const bucket = t.side === 'left' ? leftBy : rightBy
        if (!bucket.has(t.repo)) bucket.set(t.repo, [])
        bucket.get(t.repo).push(...(results[i] || []))
      })
      const baseBy = groupCommitsByRepo(base.commits)
      commits = []
      for (const r of repoList) {
        if (rightBy.has(r)) commits.push(...rightBy.get(r))
        if (baseBy.has(r)) commits.push(...baseBy.get(r))
        if (leftBy.has(r)) commits.push(...leftBy.get(r))
      }
    } else {
      // 4) 全量收集
      const results = await runCollectTasks(
        repoList,
        repoList.map((r) => ({ repo: r, args: buildLogArgs(o) })),
        onProgress,
      )
      commits = []
      for (const list of results) {
        if (list && list.length) commits.push(...list)
      }
    }

    // 5) 写缓存（LRU 淘汰最旧）
    collectCache.set(key, {
      reposSig,
      refsSig,
      authorsSig: o.authorsSig,
      since: o.since,
      until: o.until,
      includeMerges: o.includeMerges,
      commits,
      createdAt: Date.now(),
    })
    while (collectCache.size > COLLECT_CACHE_LIMIT) {
      collectCache.delete(collectCache.keys().next().value)
    }
    return commits
  })()

  collectInflight.set(key, task)
  try {
    return await task
  } finally {
    collectInflight.delete(key)
  }
}

/** 读取本机全局 git 身份 */
async function getIdentity() {
  const name = await execGitGlobal(['config', '--global', 'user.name'])
  const email = await execGitGlobal(['config', '--global', 'user.email'])
  return {
    name: name.ok ? name.stdout.trim() : '',
    email: email.ok ? email.stdout.trim() : '',
  }
}

module.exports = { scanRepos, scanReposCached, invalidateScanCache, getRepoInfo, collectCommits, getIdentity, todayLocal, tomorrowLocal, execGit }
