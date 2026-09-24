/** 知识记录：每条记录独立存为 Markdown，版本检查与原子替换保护用户原文。 */
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { randomUUID, createHash } = require('crypto')
const YAML = require('yaml')

const TYPES = new Set(['idea', 'problem', 'decision', 'experience', 'method', 'sop', 'principle', 'ai'])
const STATUSES = new Set(['inbox', 'draft', 'organized', 'archived'])
const MAX_BODY_BYTES = 512 * 1024
const MAX_META_BYTES = 64 * 1024
const MAX_FILE_BYTES = MAX_BODY_BYTES + MAX_META_BYTES + 16
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function failure(error) {
  return { ok: false, error: error?.message || '知识记录操作失败', code: error?.code || 'IO_ERROR' }
}

function directory() { return path.join(app.getPath('userData'), 'knowledge') }

function ensureDirectory() {
  const dir = directory()
  fs.mkdirSync(dir, { recursive: true })
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', '知识目录必须是普通目录，不能使用符号链接')
  return dir
}

function validId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) fail('INVALID_ID', '记录 ID 无效')
  return id
}

function recordPath(id) { return path.join(ensureDirectory(), `${validId(id)}.md`) }

function textField(value, name, max, defaultValue = '') {
  const text = value === undefined ? defaultValue : value
  if (typeof text !== 'string' || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    fail('INVALID_RECORD', `${name}格式无效或超过长度限制`)
  }
  return text
}

function strings(value, name, limit, itemLimit) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) fail('INVALID_RECORD', `${name}必须是最多 ${limit} 项的列表`)
  return [...new Set(value.map((item) => textField(item, name, itemLimit).trim()).filter(Boolean))]
}

function contentFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_RECORD', '记录内容必须是对象')
  const title = textField(input.title, '标题', 240).trim()
  if (!title) fail('INVALID_RECORD', '请填写记录标题')
  const body = input.body === undefined ? '' : input.body
  if (typeof body !== 'string' || body.includes('\u0000') || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    fail('INVALID_RECORD', '正文必须是文本，且不能超过 512 KB')
  }
  const type = input.type === undefined ? 'idea' : input.type
  const status = input.status === undefined ? 'inbox' : input.status
  if (!TYPES.has(type)) fail('INVALID_RECORD', '记录类型无效')
  if (!STATUSES.has(status)) fail('INVALID_RECORD', '记录状态无效')
  return {
    title, body, type, status,
    tags: strings(input.tags, '标签', 100, 100),
    projectId: textField(input.projectId, '关联项目 ID', 256),
    projectName: textField(input.projectName, '关联项目名称', 240),
    sourceIds: strings(input.sourceIds, '来源记录', 100, 256),
  }
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('CORRUPT_RECORD', `${name}无效`)
  return value
}

function parseMarkdown(content, required = false) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    fail('INVALID_RECORD', 'Markdown 文件超过大小限制')
  }
  const text = content.replace(/^\uFEFF/, '')
  if (!/^---\r?\n/.test(text)) {
    if (required) fail('CORRUPT_RECORD', '缺少 YAML 元信息')
    return { metadata: {}, body: text }
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match || Buffer.byteLength(match[1], 'utf8') > MAX_META_BYTES) fail('CORRUPT_RECORD', 'YAML 元信息未闭合或过长')
  let metadata
  try {
    const doc = YAML.parseDocument(match[1], { uniqueKeys: true, strict: true })
    if (doc.errors.length || doc.warnings.length) throw new Error('YAML 解析失败')
    metadata = doc.toJS({ maxAliasCount: 0 })
  } catch { fail('CORRUPT_RECORD', 'YAML 元信息无法解析，请检查原文件') }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('CORRUPT_RECORD', 'YAML 元信息必须是对象')
  return { metadata, body: text.slice(match[0].length) }
}

function serialize(record) {
  // 文件指纹只参与乐观锁，不写入 frontmatter，避免自引用或污染可迁移元信息。
  const { body, contentHash, ...metadata } = record
  const header = YAML.stringify({ schemaVersion: 1, ...metadata })
  if (Buffer.byteLength(header, 'utf8') > MAX_META_BYTES) fail('INVALID_RECORD', '标签和来源等元信息合计不能超过 64 KB')
  return `---\n${header}---\n${body}`
}

function contentHash(content) { return createHash('sha256').update(content, 'utf8').digest('hex') }

function readRecord(id) {
  const file = recordPath(id)
  let stat
  try { stat = fs.lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') fail('NOT_FOUND', '记录不存在，请刷新列表')
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_PATH', '记录文件不能是目录或符号链接')
  if (stat.size > MAX_FILE_BYTES) fail('CORRUPT_RECORD', '记录文件超过大小限制，请检查原文件')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const { metadata, body } = parseMarkdown(raw, true)
    if (metadata.schemaVersion !== undefined && metadata.schemaVersion !== 1) fail('CORRUPT_RECORD', '记录格式版本暂不支持')
    if (metadata.id !== id) fail('CORRUPT_RECORD', '记录 ID 与文件名不一致')
    if (!Number.isSafeInteger(metadata.revision) || metadata.revision < 1) fail('CORRUPT_RECORD', '记录版本无效')
    return {
      id, ...contentFields({ ...metadata, body }),
      createdAt: timestamp(metadata.createdAt, '创建时间'),
      updatedAt: timestamp(metadata.updatedAt, '更新时间'),
      revision: metadata.revision,
      deletedAt: metadata.deletedAt == null ? null : timestamp(metadata.deletedAt, '删除时间'),
      contentHash: contentHash(raw),
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw error
    fail('CORRUPT_RECORD', `记录文件损坏：${error.message}`)
  }
}

/** 记录锁防止两个进程同时通过旧版本校验；进程异常退出后可回收失效锁。 */
function withLock(id, operation) {
  const lock = path.join(ensureDirectory(), `.${validId(id)}.lock`)
  const token = randomUUID()
  let fd
  let identity
  try {
    try { fd = fs.openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      let previous = ''
      try {
        const stat = fs.lstatSync(lock)
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024) {
          previous = fs.readFileSync(lock, 'utf8')
          const owner = JSON.parse(previous)
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0) } catch (check) { stale = check.code === 'ESRCH' }
          }
        }
      } catch { /* 无法确认归属的锁不自动删除。 */ }
      if (!stale || fs.readFileSync(lock, 'utf8') !== previous) fail('RECORD_BUSY', '记录正在保存，请稍后重试')
      fs.unlinkSync(lock)
      try { fd = fs.openSync(lock, 'wx', 0o600) } catch (retry) {
        if (retry.code === 'EEXIST') fail('RECORD_BUSY', '记录正在保存，请稍后重试')
        throw retry
      }
    }
    identity = fs.fstatSync(fd)
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), 'utf8')
    return operation()
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* 保留原始操作错误。 */ }
      try {
        const current = fs.lstatSync(lock)
        // 写锁内容失败时仍可按文件身份清理自己的锁，保证磁盘恢复后可以重试。
        if (identity && current.ino === identity.ino && current.dev === identity.dev && !current.isSymbolicLink()) fs.unlinkSync(lock)
      } catch { /* 锁异常保留，避免误删其他进程的锁。 */ }
    }
  }
}

function writeRecord(record) {
  const file = recordPath(record.id)
  const temporary = path.join(directory(), `.${record.id}.${randomUUID()}.tmp`)
  let fd
  try {
    const content = serialize(record)
    fd = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(fd, content, 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temporary, file)
    record.contentHash = contentHash(content)
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 保留写入错误。 */ } }
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') { /* 失败临时文件可人工恢复。 */ } }
  }
}

function checkRevision(revision, record, optional = false) {
  if (record.revision >= Number.MAX_SAFE_INTEGER) fail('REVISION_CONFLICT', '记录版本超出支持范围')
  if (optional && revision === undefined) return
  if (!Number.isSafeInteger(revision) || revision !== record.revision) fail('REVISION_CONFLICT', '记录已被更新，请刷新后再保存')
}

function list() {
  const dir = directory()
  try {
    ensureDirectory()
    const records = []
    const warnings = []
    for (const file of fs.readdirSync(dir).filter((name) => /\.md$/i.test(name))) {
      try {
        const id = file.slice(0, -3)
        validId(id)
        if (!file.endsWith('.md')) fail('INVALID_ID', '文件扩展名必须为 .md')
        records.push(readRecord(id))
      } catch (error) {
        warnings.push({ fileName: file, code: error.code || 'READ_FAILED', error: error.message || '读取失败' })
      }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    return { ok: true, records, directory: dir, warnings }
  } catch (error) { return { ...failure(error), records: [], directory: dir, warnings: [] } }
}

function save(input) {
  try {
    const fields = contentFields(input)
    const isNew = input.id === undefined || input.id === '' || input.id === null
    const id = isNew ? randomUUID() : validId(input.id)
    return withLock(id, () => {
      const previous = isNew ? null : readRecord(id)
      if (previous) {
        checkRevision(input.revision, previous)
        if (input.contentHash !== undefined && input.contentHash !== previous.contentHash) fail('REVISION_CONFLICT', '记录文件已在外部修改，请保留草稿并刷新核对')
        if (previous.deletedAt !== null) fail('RECORD_DELETED', '记录已移入回收站，请先恢复')
      } else if (fs.existsSync(recordPath(id))) fail('REVISION_CONFLICT', '记录 ID 已存在，请重试')
      const now = Date.now()
      const record = { id, ...fields, createdAt: previous?.createdAt || now, updatedAt: now, revision: (previous?.revision || 0) + 1, deletedAt: null }
      writeRecord(record)
      return { ok: true, record }
    })
  } catch (error) { return failure(error) }
}

function setDeleted(id, revision, deleted) {
  try {
    validId(id)
    return withLock(id, () => {
      const previous = readRecord(id)
      checkRevision(revision, previous, true)
      const now = Date.now()
      const record = { ...previous, updatedAt: now, revision: previous.revision + 1, deletedAt: deleted ? now : null }
      writeRecord(record)
      return { ok: true, record }
    })
  } catch (error) { return failure(error) }
}

function importMarkdown({ fileName = '', content } = {}) {
  try {
    const { metadata, body } = parseMarkdown(content)
    const firstLine = body.split(/\r?\n/).find((line) => line.trim()) || ''
    const baseName = path.win32.basename(path.posix.basename(typeof fileName === 'string' ? fileName : '')).replace(/\.md$/i, '')
    const title = metadata.title || firstLine.replace(/^#{1,6}\s+/, '').trim().slice(0, 240) || baseName.slice(0, 240) || '导入的记录'
    // 只接受内容字段，外部 id、路径、版本、时间和删除状态不能影响本地记录。
    return save({
      title, body, type: metadata.type, status: metadata.status, tags: metadata.tags,
      projectId: metadata.projectId, projectName: metadata.projectName, sourceIds: metadata.sourceIds,
    })
  } catch (error) { return failure(error) }
}

function exportMarkdown(id) {
  try {
    const record = readRecord(id)
    let name = record.title.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '').slice(0, 100)
    if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `记录-${record.id}`
    return { ok: true, content: serialize(record), fileName: `${name}.md` }
  } catch (error) { return failure(error) }
}

module.exports = { list, save, trash: (id, revision) => setDeleted(id, revision, true), restore: (id, revision) => setDeleted(id, revision, false), importMarkdown, exportMarkdown }
