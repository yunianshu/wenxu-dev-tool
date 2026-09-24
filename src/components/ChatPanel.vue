<template>
  <div class="chat-panel">
    <div class="chat-panel-header">
      <div class="model-state">
        <span class="model-dot" :class="{ ready: configured }" />
        <span>{{ configured ? modelLabel : 'AI 模型未配置' }}</span>
      </div>
      <span class="chat-project-label">当前项目 · {{ projectName }}</span>
    </div>

    <div ref="scrollEl" class="chat-messages">
      <div v-if="!chat.messages.length" class="chat-welcome">
        <el-icon class="welcome-icon"><ChatDotRound /></el-icon>
        <h2>从项目开始</h2>
        <p>{{ configured ? '结合已选上下文，梳理项目现状、风险与下一步。' : '请先在设置中配置 AI 服务，随后即可围绕当前项目开始对话。' }}</p>
        <div v-if="quickPrompts.length" class="quick-prompts">
          <el-button v-for="(item, index) in quickPrompts" :key="item.label" text :disabled="!configured || chat.streaming" @click="send(item.prompt)">
            <el-icon><component :is="['Document', 'Finished', 'List', 'TrendCharts'][index % 4]" /></el-icon>
            <span>{{ item.label }}</span><el-icon class="prompt-arrow"><TopRight /></el-icon>
          </el-button>
        </div>
      </div>

      <div v-for="(message, index) in chat.messages" :key="index" :class="['message-row', message.role]">
        <div class="message-role">{{ message.role === 'assistant' ? 'AI' : '你' }}</div>
        <div class="message-content">
          <div v-if="message.role === 'assistant' && message.content" class="markdown-body" v-html="renderMarkdown(message.content)" />
          <div v-else-if="message.role === 'user'" class="message-text">{{ message.content }}</div>
          <div v-else class="typing-indicator"><span /><span /><span /></div>
          <div v-if="message.role === 'assistant' && message.content && !chat.streaming" class="message-tools">
            <el-button text size="small" @click="copyText(message.content)"><el-icon><CopyDocument /></el-icon>复制</el-button>
            <el-button text size="small" @click="saveToFile(message.content)"><el-icon><Download /></el-icon>保存</el-button>
          </div>
        </div>
      </div>
    </div>

    <div class="composer-area">
      <div class="composer">
        <el-input
          v-model="chat.draft" type="textarea" :rows="3" resize="none"
          placeholder="输入关于当前项目的问题…"
          aria-label="发送给 AI 助手的问题"
          :disabled="chat.streaming" @keydown="onKeydown"
        />
        <div class="composer-footer">
          <span class="composer-shortcut">Enter 发送 · Shift + Enter 换行</span>
          <el-button v-if="chat.streaming" type="danger" @click="stopGen"><el-icon><VideoPause /></el-icon>停止</el-button>
          <el-button v-else type="primary" :disabled="!chat.draft.trim() || !configured" @click="send()"><el-icon><Top /></el-icon>发送</el-button>
        </div>
      </div>
      <div class="context-budget">
        <template v-if="chat.attachContext && contextText">{{ contextLabel }} · 约 {{ contextTokens }} tokens</template>
        <template v-else>未附带项目上下文</template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { state } from '../store'
import { estimateTokens } from '../utils/ai-context'
import { useProjectChat } from '../composables/useProjectChat'

marked.setOptions({ gfm: true, breaks: true })
const props = defineProps({
  projectId: { type: String, required: true },
  projectName: { type: String, default: '' },
  contextText: { type: String, default: '' },
  contextLabel: { type: String, default: '项目上下文' },
  quickPrompts: { type: Array, default: () => [] },
})
const scrollEl = ref(null)
const conversations = useProjectChat()
const chat = computed(() => conversations.session(props.projectId))

const configured = computed(() => !!(state.config.ai?.keyConfigured && state.config.ai?.model))
const modelLabel = computed(() => state.config.ai?.model || '')
const contextTokens = computed(() => estimateTokens(props.contextText))

async function scrollToEnd() {
  await nextTick()
  if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
}
watch(() => chat.value.messages.length, scrollToEnd)
watch(() => chat.value.streaming, scrollToEnd)
watch(() => props.projectId, scrollToEnd)
// 流式期间消息数量不变（最后一条内容在增长），必须跟随内容长度滚动才能自动跟随输出
watch(() => chat.value.messages[chat.value.messages.length - 1]?.content?.length, scrollToEnd)

function renderMarkdown(text) {
  const parsed = marked.parse(text || '', { async: false })
  return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : String(parsed))
}

async function send(value) {
  const projectId = props.projectId
  const question = (typeof value === 'string' ? value : chat.value.draft).trim()
  if (!question || chat.value.streaming) return
  if (!configured.value) {
    ElMessage.warning('请先在“设置 → AI 服务”配置模型')
    return
  }
  chat.value.draft = ''
  await conversations.send(projectId, question, chat.value.attachContext ? props.contextText : '', {
    baseUrl: state.config.ai?.baseUrl,
    model: state.config.ai?.model,
    temperature: state.config.ai?.temperature ?? 0.7,
  })
}

function stopGen() {
  conversations.stop(props.projectId)
}

function onKeydown(event) {
  // 输入法组合态（选词/确认候选）的 Enter 不是发送：中文输入下不过滤会把半句话发出去
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    send()
  }
}

async function clearChat() {
  const projectId = props.projectId
  if (!chat.value.messages.length) return
  try {
    await ElMessageBox.confirm('确定清空当前项目对话吗？', '清空对话', { type: 'warning' })
    conversations.clear(projectId)
  } catch { /* 用户取消。 */ }
}

async function copyText(text) {
  await window.gitReport.copyText(text)
  ElMessage.success('已复制')
}

function deriveTitle(markdown) {
  const matched = String(markdown || '').match(/^#\s+(.+)$/m)
  // \r 一并剔除：CRLF 行尾会把 \r 带进文件名，Windows 下保存对话框直接报错
  return (matched?.[1] || 'AI项目记录').replace(/[\r\n\\/:*?"<>|]/g, '_').slice(0, 60)
}

async function saveToFile(content) {
  const result = await window.gitReport.saveReport(`${deriveTitle(content)}.md`, content)
  if (result?.saved) {
    ElMessage.success(`已保存：${result.path}`)
    const opened = await window.gitReport.openPath(result.path)
    if (opened && opened.ok === false) ElMessage.warning('文件已保存，但在系统中未找到')
  } else if (result?.error) ElMessage.error(`保存失败：${result.error}`)
}

defineExpose({ send, clearChat })
</script>

<style scoped>
.chat-panel { min-width: 0; min-height: 0; padding: 24px; display: flex; flex-direction: column; background: var(--surface); }
.chat-panel-header { min-height: 32px; flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.model-state { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text-muted); font-size: 12px; }
.model-state:has(.ready) { color: var(--accent-strong); }
.model-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--text-muted); }
.model-dot.ready { background: var(--brand-accent); box-shadow: none; }
.chat-project-label { color: var(--text-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chat-messages { flex: 1; min-height: 0; overflow-y: auto; padding: 24px 0; scrollbar-gutter: stable; }
.chat-welcome { max-width: 960px; margin: clamp(24px, 8vh, 80px) auto 24px; text-align: left; }
.welcome-icon { color: var(--accent-strong); font-size: 24px; }
.chat-welcome h2 { margin: 16px 0 12px; color: var(--brand-text); font-size: 20px; font-weight: 600; }
.chat-welcome p { margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.7; }
.quick-prompts { margin-top: 28px; min-height: 0; display: flex; flex-direction: column; align-items: stretch; gap: 0; overflow: visible; border: 0; }
.quick-prompts .el-button { height: 52px; flex: none; width: 100%; padding: 0; margin: 0; font-size: 13px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; justify-content: flex-start; color: var(--brand-text); }
.quick-prompts .el-button:not(:disabled):hover { background: var(--surface-subtle); }
.quick-prompts .el-button:disabled { color: var(--text-muted); }
.quick-prompts :deep(.el-button > span) { display: flex; align-items: center; width: 100%; gap: 8px; }
.quick-prompts .el-icon { color: var(--text-muted); }
.quick-prompts .prompt-arrow { margin-left: auto; }
.message-row { max-width: 960px; margin: 0 auto 24px; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; }
.message-role { background: var(--surface-subtle); color: var(--text-muted); border-radius: 6px; }
.message-row.user .message-role { background: var(--accent-soft); color: var(--accent-strong); }
.message-content { color: var(--brand-text); font-size: 14px; overflow-wrap: anywhere; }
.message-tools { margin-top: 8px; }
.typing-indicator span { background: var(--text-muted); }
.message-content :deep(.markdown-body pre) { background: var(--surface-subtle); border: 1px solid var(--line); color: var(--brand-text); }
.message-content :deep(.markdown-body a) { color: var(--accent-strong); }
.message-content :deep(.markdown-body table) { border-collapse: collapse; }
.message-content :deep(.markdown-body td), .message-content :deep(.markdown-body th) { padding: 8px 12px; border: 1px solid var(--line); }
.composer-area { flex-shrink: 0; }
.composer { padding: 0; overflow: hidden; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); }
.composer:focus-within { border-color: var(--accent-strong); box-shadow: 0 0 0 1px var(--accent-strong); }
.composer :deep(.el-textarea__inner) { min-height: 76px !important; padding: 16px 16px 8px; border: 0; border-radius: 0; box-shadow: none !important; font-size: 13px; background: transparent; color: var(--brand-text); }
.composer-footer { min-height: 48px; padding: 0 16px 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.composer-footer .el-button { height: 32px; }
.composer-shortcut, .context-budget { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.context-budget { padding-top: 8px; min-height: 24px; }
@media (max-width: 1280px) {
  .chat-panel { padding: 16px; }
  .chat-welcome { margin-top: 24px; }
  .quick-prompts { margin-top: 16px; }
  .quick-prompts .el-button { height: 40px; }
}
</style>
