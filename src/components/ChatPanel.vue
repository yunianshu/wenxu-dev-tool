<template>
  <div class="chat-panel">
    <div class="chat-panel-header">
      <div class="model-state">
        <span class="model-dot" :class="{ ready: configured }" />
        <span>{{ configured ? modelLabel : 'AI 模型未配置' }}</span>
      </div>
      <div class="chat-panel-actions">
        <el-switch v-model="chat.attachContext" size="small" active-text="附带项目上下文" :disabled="!contextText" />
        <el-button text type="danger" :disabled="!chat.messages.length" @click="clearChat"><el-icon><Delete /></el-icon>清空</el-button>
      </div>
    </div>

    <div v-if="quickPrompts.length" class="quick-prompts">
      <span>快捷开始</span>
      <el-button v-for="item in quickPrompts" :key="item.label" plain :disabled="!configured || chat.streaming" @click="send(item.prompt)">
        {{ item.label }}
      </el-button>
    </div>

    <div ref="scrollEl" class="chat-messages">
      <div v-if="!chat.messages.length" class="chat-welcome">
        <span class="welcome-index">AI / PROJECT</span>
        <h2>从项目本身开始，而不只是 Git 提交</h2>
        <p>你可以让我梳理项目目标、识别风险、安排下一步，或结合右侧已选择的上下文生成报告。</p>
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

    <div class="composer">
      <el-input
        v-model="chat.draft" type="textarea" :rows="3" resize="none"
        placeholder="输入关于当前项目的问题…（Enter 发送，Shift+Enter 换行）"
        :disabled="chat.streaming" @keydown="onKeydown"
      />
      <div class="composer-footer">
        <span class="context-budget">
          <template v-if="chat.attachContext && contextText">{{ contextLabel }} · 约 {{ contextTokens }} tokens</template>
          <template v-else>未附带项目上下文</template>
        </span>
        <el-button v-if="chat.streaming" type="danger" @click="stopGen"><el-icon><VideoPause /></el-icon>停止</el-button>
        <el-button v-else type="primary" :disabled="!chat.draft.trim() || !configured" @click="send()"><el-icon><Promotion /></el-icon>发送</el-button>
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

defineExpose({ send })
</script>
