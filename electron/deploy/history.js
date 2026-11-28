/**
 * 发布历史 —— 对应方案 §19 / §27 DeployHistoryService：
 *   - 每次发布记录一条（版本、结果、各阶段耗时、失败原因）
 *   - 完整部署日志落盘 userData/deploy-logs/{id}.log，历史可回看
 *   - 保存于 userData/deploy-history.json（数组，最多 200 条）
 */
const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const MAX_RECORDS = 200

function historyFile() {
  return path.join(app.getPath('userData'), 'deploy-history.json')
}

function logDir() {
  return path.join(app.getPath('userData'), 'deploy-logs')
}

function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyFile(), 'utf8'))
    return Array.isArray(raw.records) ? raw.records : []
  } catch {
    return []
  }
}

function list(projectId) {
  const all = loadAll()
  const rows = projectId ? all.filter((r) => r.projectId === projectId) : all
  return rows.slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECORDS)
}

/** 写入完整部署日志文件，返回相对文件名（历史记录只存文件名） */
function writeLog(recordId, text) {
  const dir = logDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = `${recordId}.log`
  fs.writeFileSync(path.join(dir, name), text || '', 'utf8')
  return name
}

/** 读取某条历史的完整日志 */
function readLog(logFile) {
  // 只允许读取 deploy-logs 目录内的 .log 文件，避免路径穿越
  const safe = path.basename(String(logFile || ''))
  if (!safe.endsWith('.log')) return ''
  try {
    return fs.readFileSync(path.join(logDir(), safe), 'utf8')
  } catch {
    return ''
  }
}

function add(record) {
  const records = loadAll()
  records.push(record)
  const kept = records.slice(-MAX_RECORDS)
  persist(kept)
  // 注意不能用 slice(0, len - MAX)：len < MAX 时 end 为负，slice 负索引表示从末尾倒数，
  // 会误删仍在保留范围内记录的日志文件
  removeLogFiles(records.slice(0, Math.max(0, records.length - MAX_RECORDS)))
  return record
}

/** 按 id 取单条记录（不存在返回 null） */
function get(recordId) {
  const id = String(recordId || '')
  if (!id) return null
  return loadAll().find((r) => r && r.id === id) || null
}

function update(recordId, patch) {
  const records = loadAll()
  const idx = records.findIndex((r) => r.id === recordId)
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...patch }
    persist(records)
    return records[idx]
  }
  return null
}

function persist(records) {
  fs.mkdirSync(path.dirname(historyFile()), { recursive: true })
  fs.writeFileSync(historyFile(), JSON.stringify({ records }, null, 2), 'utf8')
}

/** 删除记录对应的日志文件（basename 防穿越；失败静默，不阻塞历史操作） */
function removeLogFiles(records) {
  for (const r of records || []) {
    const name = r && r.logFile
    if (typeof name !== 'string' || !name.endsWith('.log')) continue
    try { fs.rmSync(path.join(logDir(), path.basename(name)), { force: true }) } catch { /* noop */ }
  }
}

/** 清空历史。给了 targetId 时只清该环境的记录（发布历史按环境显示，清空的范围与显示的一致）；
 *  没有环境 id 的旧记录无法归属、在各环境下都显示，随所清的环境一并清理。 */
function clear(projectId, targetId) {
  const all = loadAll()
  const hit = (r) => (!projectId || r.projectId === projectId) && (!targetId || !r.targetId || r.targetId === targetId)
  const removed = all.filter(hit)
  persist(all.filter((r) => !hit(r)))
  removeLogFiles(removed) // 清空历史必须连日志文件一起清理，否则 deploy-logs 无限累积
  return { ok: true }
}

module.exports = { list, add, get, update, writeLog, readLog, clear }
