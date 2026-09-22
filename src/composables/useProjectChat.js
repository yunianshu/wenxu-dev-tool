import { reactive } from 'vue'
import { systemPrompt, windowHistory } from '../utils/ai-context'
import { toPlain } from '../utils/ipc'

const TOTAL_BUDGET_CHARS = 20000

export function buildChatMessages(messages, contextText = '') {
  const leading = [{ role: 'system', content: systemPrompt() }]
  if (contextText) leading.push({ role: 'system', content: contextText })
  const history = windowHistory(messages.filter((item) => item.content))
  let used = leading.reduce((sum, item) => sum + item.content.length, 0)
  const kept = []
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index]
    const remaining = TOTAL_BUDGET_CHARS - used
    if (remaining <= 0) break
    if (item.content.length <= remaining) {
      kept.unshift(item)
      used += item.content.length
    } else if (!kept.length) {
      kept.unshift({ ...item, content: `${item.content.slice(0, remaining)}…` })
      break
    }
  }
  return [...leading, ...kept]
}

/** 会话随应用存活；请求始终写入发起项目，切页或切项目不改变归属。 */
export function createProjectChat(api) {
  const sessions = reactive(new Map())
  const requests = new Map()
  let sequence = 0

  function session(projectId) {
    if (!sessions.has(projectId)) {
      sessions.set(projectId, { messages: [], streaming: false, requestId: '', draft: '', attachContext: true })
    }
    return sessions.get(projectId)
  }

  const unsubscribe = api.onAiDelta?.((payload) => {
    const task = requests.get(payload?.requestId)
    if (task && !task.stopping) task.reply.content = payload.text || ''
  })

  function stop(projectId) {
    const task = requests.get(session(projectId).requestId)
    if (!task) return
    task.stopping = true
    return Promise.resolve(api.aiStop(task.requestId)).catch(() => {})
  }

  function clear(projectId) {
    const current = session(projectId)
    stop(projectId)
    // 清空立即作废旧请求，即使它的完成或增量晚到，也不能重建已清空的内容。
    requests.delete(current.requestId)
    current.messages = []
    current.streaming = false
    current.requestId = ''
  }

  async function send(projectId, question, contextText, options) {
    const current = session(projectId)
    if (!projectId || !question.trim() || current.streaming) return
    const requestId = `chat-${Date.now().toString(36)}-${++sequence}`
    current.messages.push({ role: 'user', content: question }, { role: 'assistant', content: '' })
    const task = { requestId, current, reply: current.messages[current.messages.length - 1], stopping: false }
    current.streaming = true
    current.requestId = requestId
    requests.set(requestId, task)
    try {
      const result = await api.aiChat(toPlain(buildChatMessages(current.messages, contextText)), toPlain({ ...options, requestId }))
      if (requests.get(requestId) !== task) return
      if (result?.ok) task.reply.content = result.text
      else if (result?.aborted) task.reply.content ||= '已停止生成'
      else task.reply.content = `请求失败：${result?.error || '请检查模型配置或网络'}`
    } catch (error) {
      if (requests.get(requestId) === task) task.reply.content = `请求失败：${error?.message || '未知错误'}`
    } finally {
      if (requests.get(requestId) === task) {
        requests.delete(requestId)
        current.streaming = false
        current.requestId = ''
      }
    }
  }

  return { session, send, stop, clear, dispose: () => unsubscribe?.() }
}

let projectChat
export function useProjectChat() {
  projectChat ||= createProjectChat(window.gitReport)
  return projectChat
}
