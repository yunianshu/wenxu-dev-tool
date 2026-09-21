/**
 * 发布更新内容 —— 从项目 Git 提交记录生成「这次发布改了什么」：
 *   1. 采集：以上一次成功发布记录的提交号为起点（没记录时退回最近一次标签），
 *      收齐到本次 HEAD 之间的提交；都没有则退回最近若干条提交（首次发布）。
 *   2. 整理：优先调用已配置的 AI，把提交记录改写成「只有中文、没有英文和术语、
 *      不写代码的人也看得懂」的说明；AI 不可用或结果里混进英文时退回本地整理
 *      （去掉 feat/fix 之类前缀后逐条列出）。
 *
 * 纯 Node 实现（git 经 execFile 调用，不经 shell），可独立单测；
 * 依赖 Electron 的部分（历史/项目/AI 配置）在函数内部按需 require，避免模块加载即拉入 app。
 */
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

/** 无版本起点时最多采集的提交条数（已知版本范围不截断） */
const MAX_COMMITS = 60
/** 单条提交标题的最大长度 */
const MAX_SUBJECT = 160
/** AI 总结的输出上限 */
const AI_MAX_TOKENS = 2048

// ─────────────────────────── Git 采集 ───────────────────────────

/** 执行 git 命令（不经过 shell，避免注入与路径转义问题） */
function runGit(dir, args, maxBuffer = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, stdout: '', error: String((err && err.message) || err).trim() })
      resolve({ ok: true, stdout: String(stdout || ''), error: '' })
    })
  })
}

/** 项目目录是否在一个 Git 工作区内 */
async function isGitRepo(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  try {
    if (!fs.statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  const r = await runGit(dir, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.stdout.trim() === 'true'
}

/** 当前 HEAD 提交号；空仓库（还没有任何提交）返回空串 */
async function headCommit(dir) {
  const r = await runGit(dir, ['rev-parse', 'HEAD'])
  return r.ok ? r.stdout.trim() : ''
}

/** 恰好落在 HEAD 上的标签（没有则空串） */
async function headTag(dir) {
  const r = await runGit(dir, ['describe', '--tags', '--exact-match', 'HEAD'])
  return r.ok ? r.stdout.trim() : ''
}

/** 离 HEAD 最近的可达标签（没有则空串） */
async function latestTag(dir) {
  const r = await runGit(dir, ['describe', '--tags', '--abbrev=0', 'HEAD'])
  return r.ok ? r.stdout.trim() : ''
}

function clampSubject(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > MAX_SUBJECT ? `${t.slice(0, MAX_SUBJECT)}…` : t
}

/**
 * 采集提交列表（新→旧）。
 * @param {string} dir 项目目录
 * @param {{from?: string, to?: string, limit?: number}} opts from 为起点，to 为固定终点；无起点时取最近 limit 条
 * @returns {Promise<{ok: boolean, commits: Array<{hash,date,subject}>, error: string}>}
 */
async function listCommits(dir, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Math.min(Number(opts.limit), MAX_COMMITS) : MAX_COMMITS
  const from = String(opts.from || '').trim()
  const to = String(opts.to || 'HEAD')
  const range = from ? `${from}..${to}` : to
  const r = await runGit(dir, [
    'log', '--no-merges', '--date=short',
    '--pretty=format:%H%x1f%ad%x1f%s',
    ...(from ? [] : [`--max-count=${limit}`]),
    range,
  ])
  if (!r.ok) return { ok: false, commits: [], error: r.error }
  const commits = r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, date, subject] = line.split('\x1f')
    return { hash: String(hash || '').trim(), date: String(date || '').trim(), subject: clampSubject(subject) }
  }).filter((c) => c.hash)
  return { ok: true, commits, error: '' }
}

/**
 * 从上一次成功发布的记录里取采集起点：优先提交号，其次标签。
 * @param {Array} records 该项目的历史记录（任意顺序，内部取最新成功的有效记录）
 */
function anchorFromRecords(records, projectId, targetId) {
  const rows = (Array.isArray(records) ? records : [])
    .filter((r) => r && r.type === 'deploy' && r.status === 'success')
    .filter((r) => !projectId || r.projectId === projectId)
    .filter((r) => !targetId || r.targetId === targetId)
    .sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0))
  for (const r of rows) {
    const version = String(r.version || '').trim()
    if (r.gitHead) {
      return {
        value: String(r.gitHead),
        kind: 'commit',
        label: `上次发布${version ? ` ${version}` : ''}${r.gitTag ? `（标签 ${r.gitTag}）` : ''}之后`,
      }
    }
    if (r.gitTag) {
      return {
        value: String(r.gitTag),
        kind: 'tag',
        label: `上次发布${version ? ` ${version}` : ''}（标签 ${r.gitTag}）之后`,
      }
    }
  }
  return null
}

/**
 * 采集项目当前的 Git 发布信息。任何一步失败都返回空结果，绝不抛错（发布流程不能因此中断）。
 * @returns {Promise<{ok, head, tag, anchorKind, anchorLabel, commits, error}>}
 */
async function collect(dir, opts = {}) {
  const empty = { ok: false, head: '', tag: '', anchorKind: 'none', anchorLabel: '', commits: [], error: '' }
  try {
    if (!(await isGitRepo(dir))) return { ...empty, error: '项目目录不是 Git 仓库，无法读取提交记录' }
    const head = await headCommit(dir)
    if (!head) return { ...empty, error: '仓库里还没有任何提交' }
    const tag = await headTag(dir)

    let anchor = opts.anchor && opts.anchor.value ? opts.anchor : null
    if (!anchor) {
      const t = await latestTag(dir)
      if (t) anchor = { value: t, kind: 'tag', label: `最近一次标签 ${t} 之后` }
    }

    const from = anchor ? anchor.value : ''
    let res = await listCommits(dir, { from, to: head })
    let anchorKind = anchor ? anchor.kind : 'none'
    let anchorLabel = anchor ? anchor.label : '首次发布（本次收录最近若干条提交）'
    let note = ''
    if (from && !res.ok) {
      // 起点已不存在（改过历史/标签被删）：退回最近若干条，并在标签里说明
      note = '上次发布的起点已找不到，已改为列出最近的提交'
      res = await listCommits(dir, { to: head })
      anchorKind = 'none'
      anchorLabel = '首次发布（本次收录最近若干条提交）'
    }
    if (!res.ok) return { ...empty, error: res.error }
    return {
      ok: true,
      head,
      tag,
      anchorKind,
      anchorLabel,
      note,
      commits: res.commits,
      commitCount: res.commits.length,
      error: '',
    }
  } catch (e) {
    return { ...empty, error: (e && e.message) || String(e) }
  }
}

// ─────────────────────────── 文案整理 ───────────────────────────

/** 提交类型前缀（约定式提交），整理时去掉——这些英文缩写对使用者没有意义 */
const TYPE_PREFIX = /^(revert|feat|feature|fix|bugfix|hotfix|chore|docs|doc|style|refactor|perf|test|tests|build|ci|release|merge)(\([^)]{0,40}\))?\s*[:：]\s*/i

/**
 * 把一条提交标题整理成人话：
 * 去掉「feat(scope):」这类前缀、去掉结尾的编号引用、去掉方括号标签。
 */
function cleanSubject(subject) {
  let t = clampSubject(subject)
  for (let i = 0; i < 2; i += 1) t = t.replace(TYPE_PREFIX, '').trim()
  t = t.replace(/\s*[(（]\s*#\d+\s*[)）]\s*$/, '')
  t = t.replace(/^[[【]([^\]】]{1,20})[\]】]\s*/, '')
  return t.trim()
}

/** 本地整理（无 AI 时）：逐条列出整理后的改动，全中文表述 */
function localSummary(commits) {
  const seen = new Set()
  const lines = []
  for (const c of Array.isArray(commits) ? commits : []) {
    const t = cleanSubject(c && c.subject)
    if (!t || seen.has(t)) continue
    seen.add(t)
    lines.push(`· ${t}`)
  }
  if (!lines.length) return '本次发布没有发现新的改动。'
  return `这次发布共更新了 ${lines.length} 处内容：\n${lines.join('\n')}`
}

/** 版本号样式的片段不算「英文」（如 v1.4.48、1.2.3-beta） */
const VERSION_TOKEN = /v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.\-+]*)?/g

/** 文本里是否残留英文字母 */
function hasLatin(text) {
  return /[A-Za-z]/.test(String(text || '').replace(VERSION_TOKEN, ''))
}

/**
 * 清洗 AI 输出：只保留纯中文（含数字）的条目，出现英文字母的整条丢弃并记录。
 * @returns {{text: string, dropped: string[]}}
 */
function sanitizePlainChinese(text) {
  const kept = []
  const dropped = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const body = line.replace(/^[·•\-*\d]+[.、)）\s]*\s*/, '').trim()
    if (!body) continue
    if (hasLatin(body)) {
      dropped.push(line)
      continue
    }
    if (!kept.includes(body)) kept.push(body)
  }
  return { text: kept.map((l) => `· ${l}`).join('\n'), dropped }
}

/** 组织给 AI 的提示词（要求：全中文、无术语、通俗、只写使用者能感知的变化） */
function buildSummaryPrompt({ projectName, version, anchorLabel, commits }) {
  const list = (Array.isArray(commits) ? commits : []).map((c) => `- ${c.subject}`).join('\n')
  return [
    {
      role: 'system',
      content: [
        '你是软件更新说明的编辑，读者是不写代码的普通使用者。',
        '请把下面这次发布包含的代码提交，改写成一份通俗的中文更新说明。',
        '必须遵守：',
        '1. 只能用中文和数字，绝对不能出现任何英文字母、英文单词、缩写、文件名、代码名或技术术语（例如 API、UI、Bug、Git、JSON、数据库、接口、参数、配置 等都不要出现）。',
        '2. 遇到说不清楚的技术内容，用普通人能懂的说法表达，例如「界面」「操作更顺手」「修好了点不动的问题」「数据保存更稳」。',
        '3. 不要一条一条照抄，把内容相近的合并，整理成 3 到 8 条；每条一句话，说清楚「改了什么、对使用的人有什么影响」。',
        '4. 不要写使用者感觉不到的内容（例如整理代码、补充注释、升级依赖）。',
        '5. 直接输出说明本身，每条以「· 」开头，不要标题、不要开场白、不要结尾解释。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `项目：${projectName || '未命名'}`,
        `本次版本：${version || '未标版本'}`,
        `改动范围：${anchorLabel || '本次全部改动'}`,
        '代码提交：',
        list || '（没有提交记录）',
      ].join('\n'),
    },
  ]
}

// ─────────────────────── 发布说明文件（打包脚本约定） ───────────────────────
//
// 部分项目的打包脚本要求「发布说明随版本提供」——如 Vantage 的 package.sh：
// docs/release-notes-<版本>.md 缺失即中止打包。工具要完成「版本升级 → 打包」
// 的闭环，就得在打包前把缺失的文件按约定补出来。约定探测：项目根或 docs/ 下
// 已存在 release-notes-*.md 即认定项目遵循该约定；没有该约定的项目不做任何事。

/** release-notes-<版本>.md 文件名解析（v 前缀也认，如 release-notes-v2.0.0.md）；不匹配返回 null */
function parseNotesFileName(name) {
  const m = /^release-notes-(v)?([\w][\w.+-]*)\.md$/.exec(String(name || ''))
  if (!m) return null
  return { vPrefixed: !!m[1], version: m[2] }
}

/**
 * 探测「发布说明随版本提供」约定：先 docs/，其次项目根。
 * 返回 { dir, relDir, vPrefixed }（relDir 为相对项目根的显示路径，根目录为空串）；
 * vPrefixed 取该目录下所有既有文件的写法（全部带 v 才带 v），项目没有该约定时返回 null。
 */
function detectNotesConvention(projectDir) {
  if (!projectDir || !fs.existsSync(projectDir)) return null
  for (const relDir of ['docs', '']) {
    const dir = relDir ? path.join(projectDir, relDir) : projectDir
    let names = []
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      names = fs.readdirSync(dir)
    } catch { continue }
    const parsed = names.map(parseNotesFileName).filter(Boolean)
    if (!parsed.length) continue
    const vPrefixed = parsed.every((p) => p.vPrefixed)
    return { dir, relDir, vPrefixed }
  }
  return null
}

/** 组装发布说明 Markdown 初稿（纯函数）：标题 + 生成说明 + 提交整理清单 */
function buildNotesMarkdown({ appName, version, anchorLabel, commits, generatedAt }) {
  const list = []
  const seen = new Set()
  for (const c of Array.isArray(commits) ? commits : []) {
    const t = cleanSubject(c && c.subject)
    if (!t || seen.has(t)) continue
    seen.add(t)
    list.push(`- ${t}`)
  }
  const when = String(generatedAt || '').trim()
  const scope = `改动范围：${anchorLabel || '最近的代码提交'}，共收录 ${list.length} 条提交。`
  return [
    `# ${String(appName || '项目').trim()} ${version} 发布说明`,
    '',
    `> 本文件由 project-tool 于 ${when} 自动生成初稿，可人工润色后随代码提交。`,
    `> ${scope}${list.length ? '' : '未采集到代码提交记录，请人工补写本次更新内容。'}`,
    '',
    '## 本次更新内容',
    '',
    ...(list.length ? list : ['（待补充）']),
    '',
  ].join('\n')
}

/**
 * 确保目标版本的发布说明文件存在：项目遵循该约定且文件缺失时写一份初稿。
 * 任何失败都不抛错（不能拖垮发布流程；约定存在但没写成功时，打包脚本会自己报缺文件）。
 * @returns {{ convention: boolean, wrote: boolean, file: string, error: string }}
 *          file 为相对项目根的显示路径（如 docs/release-notes-0.1.12.md）
 */
function ensureNotesFile(projectDir, version, opts = {}) {
  const none = { convention: false, wrote: false, file: '', error: '' }
  try {
    const conv = detectNotesConvention(projectDir)
    if (!conv) return none
    const v = String(version || '').trim()
    if (!v || !/^[\w][\w.+-]*$/.test(v)) return { ...none, convention: true, error: `版本号不合法：${v}` }
    const name = `release-notes-${conv.vPrefixed ? 'v' : ''}${v}.md`
    const relFile = conv.relDir ? `${conv.relDir}/${name}` : name
    if (fs.existsSync(path.join(conv.dir, name))) {
      return { convention: true, wrote: false, file: relFile, error: '' }
    }
    fs.writeFileSync(path.join(conv.dir, name), buildNotesMarkdown({
      appName: opts.appName,
      version: v,
      anchorLabel: opts.anchorLabel || '',
      commits: opts.commits,
      generatedAt: opts.generatedAt || (() => {
        const d = new Date()
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      })(),
    }), 'utf8')
    return { convention: true, wrote: true, file: relFile, error: '' }
  } catch (e) {
    return { convention: true, wrote: false, file: '', error: (e && e.message) || String(e) }
  }
}

// ─────────────────────── 结合历史记录的编排 ───────────────────────

/** 生成默认标签名：v + 版本号（去掉已有的 v 前缀与非法字符） */
function defaultTagName(version) {
  const v = String(version || '').trim().replace(/^v/i, '')
  if (!v || !/^[\w.+-]+$/.test(v)) return ''
  return `v${v}`
}

/** 为指定发布提交打标签；同名只有指向相同提交才可复用，禁止覆盖。 */
async function createTag(projectDir, tagName, commit) {
  const name = String(tagName || '').trim()
  if (!name || !/^[\w.+-]+$/.test(name)) return { ok: false, error: '标签名不合法' }
  if (!(await isGitRepo(projectDir))) return { ok: false, error: '项目目录不是 Git 仓库，无法打标签' }
  const sha = String(commit || '').trim() || (await headCommit(projectDir))
  if (!sha) return { ok: false, error: '找不到可打标签的提交' }
  const resolved = await runGit(projectDir, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`])
  if (!resolved.ok) return { ok: false, error: '找不到可打标签的提交' }
  const exists = await runGit(projectDir, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}^{commit}`])
  if (exists.ok) {
    if (exists.stdout.trim() !== resolved.stdout.trim()) return { ok: false, error: `标签 ${name} 已指向其他提交，请使用新版本号；原标签未改动` }
    return { ok: true, tag: name, existed: true }
  }
  const r = await runGit(projectDir, ['tag', name, resolved.stdout.trim()])
  if (!r.ok) return { ok: false, error: `打标签失败：${r.error}` }
  return { ok: true, tag: name, existed: false }
}

/** 记录里保存的采集结果（写历史用），字段名保持短小 */
function toRecordFields(info) {
  return {
    gitHead: info && info.head || '',
    gitTag: info && info.tag || '',
    gitAnchor: info && info.anchorLabel || '',
    gitCommits: (info && Array.isArray(info.commits) ? info.commits : []).map((c) => ({
      hash: c.hash, date: c.date, subject: c.subject,
    })),
    changeSummary: localSummary(info && info.commits),
    changeSummarySource: 'local',
    changeSummaryAt: Date.now(),
  }
}

/** 采集 + 组装为历史记录字段（供发布流程调用，失败不抛错） */
async function captureFor(project, opts = {}) {
  const dir = project && project.localPath
  const info = await collect(dir, opts)
  if (!info.ok) return { ok: false, error: info.error, fields: {} }
  const fields = toRecordFields(info)
  if (opts.version) {
    fields.gitVersion = String(opts.version)
  }
  return { ok: true, error: '', fields, info }
}

/**
 * 用 AI 重新整理某条历史记录的更新内容并写回。
 * @param {string} recordId
 * @param {{refresh?: boolean}} opts refresh=true 时忽略已有 AI 结果强制重算
 * @returns {Promise<{ok, summary, source, error}>}
 */
async function summarizeRecord(recordId, opts = {}) {
  const history = require('./history')
  const record = history.get(recordId)
  if (!record) return { ok: false, summary: '', source: '', error: '发布记录不存在' }
  const commits = Array.isArray(record.gitCommits) ? record.gitCommits : []
  if (!commits.length) return { ok: false, summary: '', source: '', error: '这次发布没有采集到提交记录，无法生成更新内容' }
  if (!opts.refresh && record.changeSummary && record.changeSummarySource === 'ai') {
    return { ok: true, summary: record.changeSummary, source: 'ai', error: '' }
  }

  // 兜底文案由提交记录现算，避免沿用可能已过期的历史说明
  const fallback = localSummary(commits)

  let aiError = ''
  try {
    const store = require('../store')
    const aiService = require('../ai-service')
    const cfg = store.load()
    const apiKey = store.getApiKey()
    const model = String((cfg.ai && cfg.ai.model) || '').trim()
    if (!apiKey || !model) throw new Error(!apiKey ? '未配置 AI 密钥' : '未配置模型名称')

    const messages = buildSummaryPrompt({
      projectName: record.projectName,
      version: record.version,
      anchorLabel: record.gitAnchor,
      commits,
    })
    const ask = async (msgs, effort) => aiService.complete({
      baseUrl: cfg.ai.baseUrl,
      apiKey,
      model,
      temperature: 0.3,
      maxTokens: AI_MAX_TOKENS,
      reasoningEffort: effort,
      messages: msgs,
    })
    const askWithFallback = async (msgs) => {
      try {
        return await ask(msgs, 'none')
      } catch (e) {
        if (e && (e.status === 400 || e.status === 422)) return ask(msgs, undefined)
        throw e
      }
    }

    let res = await askWithFallback(messages)
    let cleaned = sanitizePlainChinese(res && res.text)
    if (!cleaned.text) {
      // 输出里混进了英文：带着反馈再要一次，仍不合格就用本地整理，绝不把英文写进更新内容
      const retryMessages = [
        ...messages,
        { role: 'assistant', content: String((res && res.text) || '').slice(0, 2000) },
        { role: 'user', content: '上一条回复里出现了英文字母，不符合要求。请只用中文和数字重写一遍，每条以「· 」开头。' },
      ]
      res = await askWithFallback(retryMessages)
      cleaned = sanitizePlainChinese(res && res.text)
    }
    if (!cleaned.text) {
      aiError = 'AI 回复里混进了英文，已改用本地整理'
      const saved = history.update(recordId, { changeSummary: fallback, changeSummarySource: 'local', changeSummaryAt: Date.now() })
      return { ok: true, summary: saved.changeSummary, source: 'local', error: aiError }
    }
    const saved = history.update(recordId, {
      changeSummary: cleaned.text,
      changeSummarySource: 'ai',
      changeSummaryAt: Date.now(),
    })
    return { ok: true, summary: saved.changeSummary, source: 'ai', error: '' }
  } catch (e) {
    aiError = (e && e.message) || String(e)
  }

  const saved = history.update(recordId, { changeSummary: fallback, changeSummarySource: 'local', changeSummaryAt: Date.now() })
  return { ok: true, summary: saved.changeSummary, source: 'local', error: aiError }
}

/**
 * 发布成功后自动补一份通俗中文总结（后台执行，失败静默）。
 * 先写入本地整理结果保证历史立刻有内容，再用 AI 覆盖。
 */
async function enrichRecord(recordId, onUpdated) {
  try {
    const r = await summarizeRecord(recordId, { refresh: true })
    if (r && r.ok && r.source === 'ai' && typeof onUpdated === 'function') onUpdated()
    return r
  } catch {
    return { ok: false }
  }
}

module.exports = {
  MAX_COMMITS,
  // 纯函数 / 采集（可独立单测）
  isGitRepo, headCommit, headTag, latestTag, listCommits, collect,
  anchorFromRecords, cleanSubject, localSummary, sanitizePlainChinese,
  buildSummaryPrompt, hasLatin, defaultTagName,
  parseNotesFileName, detectNotesConvention, buildNotesMarkdown, ensureNotesFile,
  // 需要历史/项目/AI 配置的编排
  captureFor, summarizeRecord, enrichRecord, createTag, toRecordFields,
}
