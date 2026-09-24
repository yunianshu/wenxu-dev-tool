export const KNOWLEDGE_TYPES = { idea: '想法', problem: '问题', decision: '决策', experience: '经验', method: '方法', sop: 'SOP', principle: '原则', ai: 'AI 技巧' }
export const KNOWLEDGE_STATUSES = { inbox: '待整理', draft: '草稿', organized: '已整理', archived: '已归档' }

export function knowledgeMatches(record, { view = 'all', query = '', type = '', projectId = '' } = {}) {
  if ((view === 'trash') !== !!record.deletedAt) return false
  if (view === 'inbox' && record.status !== 'inbox') return false
  if (view === 'methods' && !['method', 'sop', 'ai'].includes(record.type)) return false
  if (view === 'reviews' && !['problem', 'decision', 'experience'].includes(record.type)) return false
  if (view === 'principles' && record.type !== 'principle') return false
  if (type && record.type !== type) return false
  if (projectId === '__none__' ? !!record.projectId : projectId && record.projectId !== projectId) return false
  const haystack = [record.title, record.body, record.projectName, ...(record.tags || [])].join(' ').toLocaleLowerCase()
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word => haystack.includes(word))
}

export function knowledgeTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
}
