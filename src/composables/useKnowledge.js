import { reactive } from 'vue'

const clone = value => JSON.parse(JSON.stringify(value))

/** 缓存随应用存活；保存按记录串行，切页或切换项目不会改变写入目标。 */
export function createKnowledgeStore(api, delay = 600, storage = null) {
  const data = reactive({ records: [], drafts: {}, saving: {}, mutating: {}, errors: {}, loading: false, error: '', backupError: '', warnings: [], directory: '', loaded: false })
  const workspace = reactive({ view: 'globe', query: '', type: '', projectId: '', selectedId: '' })
  const timers = new Map()
  const flights = new Map()
  const edits = new Map()
  const saved = new Map()
  const epochs = new Map()
  const draftKey = 'plm-knowledge-pending-v1'
  let restored = false
  if (storage) {
    try {
      const pending = JSON.parse(storage.getItem(draftKey) || '{}')
      if (!pending || typeof pending !== 'object' || Array.isArray(pending)) throw new Error('草稿格式无效')
      for (const [id, row] of Object.entries(pending)) {
        if (row && row.id === id && typeof row.title === 'string' && typeof row.body === 'string') {
          data.drafts[id] = row
          edits.set(id, 1)
          restored = true
        }
      }
    } catch { data.backupError = '本地草稿备份暂时无法读取，请保留当前应用数据。' }
  }
  function backupDrafts() {
    if (!storage) return
    try { storage.setItem(draftKey, JSON.stringify(data.drafts)); data.backupError = '' }
    catch { data.backupError = '草稿备份失败，请立即保存并确认成功后再退出。' }
  }
  let loading
  function upsert(record) {
    epochs.set(record.id, (epochs.get(record.id) || 0) + 1)
    const index = data.records.findIndex(row => row.id === record.id)
    if (index < 0) data.records.unshift(record)
    else data.records[index] = record
  }
  async function load(force = false) {
    if (loading) return loading
    if (data.loaded && !force) return true
    data.loading = true
    const before = new Map(epochs)
    loading = (async () => {
      try {
        const result = await api.knowledgeList()
        if (!result?.ok) throw new Error(result?.error || '知识库读取失败')
        const changed = data.records.filter(row => (epochs.get(row.id) || 0) !== (before.get(row.id) || 0))
        const changedIds = new Set(changed.map(row => row.id))
        data.records = [...changed, ...result.records.filter(row => !changedIds.has(row.id))]
        // 原文件被外部移走或损坏时，恢复草稿仍须在列表中可达，便于另存。
        for (const draft of Object.values(data.drafts)) {
          if (!data.records.some(row => row.id === draft.id)) {
            data.records.push(clone(draft))
            data.errors[draft.id] = '原文件暂时不可读取，已恢复本地草稿；可另存为新记录。'
          }
        }
        data.directory = result.directory
        data.warnings = result.warnings || []
        data.error = ''
        data.loaded = true
        if (restored) {
          restored = false
          for (const id of Object.keys(data.drafts)) timers.set(id, setTimeout(() => flush(id), delay))
        }
        return true
      } catch (error) { data.error = error.message; return false }
      finally { data.loading = false; loading = null }
    })()
    return loading
  }
  function record(id) { return data.drafts[id] || data.records.find(row => row.id === id) }
  function change(value) {
    const id = value.id
    if (data.mutating[id]) return false
    data.drafts[id] = clone(value)
    edits.set(id, (edits.get(id) || 0) + 1)
    backupDrafts()
    clearTimeout(timers.get(id))
    timers.set(id, setTimeout(() => flush(id), delay))
    return true
  }
  function dirty(id) { return (edits.get(id) || 0) > (saved.get(id) || 0) }
  async function flush(id) {
    clearTimeout(timers.get(id))
    timers.delete(id)
    if (flights.has(id)) return flights.get(id)
    if (!dirty(id)) return true
    data.saving[id] = true
    const task = (async () => {
      while (dirty(id)) {
        const sequence = edits.get(id)
        const draft = clone(data.drafts[id])
        try {
          const result = await api.knowledgeSave(draft)
          if (!result?.ok) throw new Error(result?.error || '记录保存失败')
          upsert(result.record)
          saved.set(id, sequence)
          data.errors[id] = ''
          if (edits.get(id) === sequence) delete data.drafts[id]
          else Object.assign(data.drafts[id], { revision: result.record.revision, contentHash: result.record.contentHash, updatedAt: result.record.updatedAt })
          backupDrafts()
        } catch (error) { data.errors[id] = error.message; return false }
      }
      return true
    })()
    flights.set(id, task)
    try { return await task } finally { data.saving[id] = false; flights.delete(id) }
  }
  async function create(fields = {}) {
    const result = await api.knowledgeSave(clone({ title: '未命名记录', body: '', type: 'idea', status: 'inbox', tags: [], projectId: '', projectName: '', sourceIds: [], ...fields, id: undefined }))
    if (!result?.ok) throw new Error(result?.error || '新建记录失败')
    upsert(result.record)
    return result.record
  }
  async function lifecycle(id, action) {
    if (data.mutating[id]) throw new Error('记录正在更新，请稍候')
    data.mutating[id] = true
    try {
      if (!(await flush(id))) throw new Error(data.errors[id])
      const current = data.records.find(row => row.id === id)
      const result = await api[action === 'restore' ? 'knowledgeRestore' : 'knowledgeTrash'](id, current?.revision)
      if (!result?.ok) throw new Error(result?.error || '操作失败')
      upsert(result.record)
      return result.record
    } finally { data.mutating[id] = false }
  }
  function discard(id) {
    if (data.saving[id] || data.mutating[id]) return false
    clearTimeout(timers.get(id)); timers.delete(id)
    delete data.drafts[id]; delete data.errors[id]
    saved.set(id, edits.get(id) || 0)
    backupDrafts()
    return true
  }
  async function importMarkdown(payload) {
    const result = await api.knowledgeImport(payload)
    if (!result?.ok) throw new Error(result?.error || '导入失败')
    upsert(result.record)
    return result.record
  }
  function openRecord(row, projectId = '') {
    workspace.selectedId = row?.id || ''
    workspace.projectId = projectId
    workspace.view = row?.deletedAt ? 'trash' : 'all'
    workspace.query = ''
    workspace.type = ''
  }
  return { data, workspace, load, record, change, dirty, flush, create, lifecycle, importMarkdown, openRecord, discard }
}

let knowledge
export function useKnowledge() {
  if (!knowledge) {
    let storage = null
    try { storage = window.localStorage } catch { /* 自动保存仍然可用，备用草稿存储不可用时在界面提示。 */ }
    knowledge = createKnowledgeStore(window.gitReport, 600, storage)
    if (!storage) knowledge.data.backupError = '草稿备份不可用，请确认保存成功后再退出。'
    window.addEventListener('beforeunload', event => {
      const ids = Object.keys(knowledge.data.drafts).filter(id => knowledge.dirty(id))
      if (!ids.length) return
      for (const id of ids) void knowledge.flush(id)
      event.preventDefault()
      event.returnValue = ''
    })
  }
  return knowledge
}
