<template>
  <section class="knowledge-analysis" aria-label="AI 知识分析" @keydown="onAnalysisKeydown">
    <header class="analysis-header">
      <div><h2>AI 知识分析</h2><span>{{ configured ? state.config.ai.model : '尚未配置 AI 服务' }}</span></div>
      <el-button text aria-label="关闭知识分析" @click="close"><el-icon><Close /></el-icon></el-button>
    </header>

    <div class="analysis-scroll">
      <el-alert v-if="!configured" type="warning" :closable="false" class="analysis-alert" title="配置 AI 服务后即可开始分析。"><el-button text @click="emit('configure')">前往设置</el-button></el-alert>
      <el-alert v-if="cacheError" :title="cacheError" type="warning" :closable="false" class="analysis-alert" />
      <el-radio-group v-model="analysisMode" :disabled="busy" aria-label="分析模式" class="analysis-modes">
        <el-radio-button value="organize">整理知识</el-radio-button>
        <el-radio-button value="idea">分析想法</el-radio-button>
      </el-radio-group>

      <section class="analysis-sources">
        <div class="field-heading"><label>所选来源</label><span>{{ sources.length }} 条</span></div>
        <ul v-if="sources.length"><li v-for="(source, index) in sources" :key="source.id || index"><el-icon><Document /></el-icon><span :title="source.title">{{ source.title }}</span><small v-if="source.projectName">{{ source.projectName }}</small></li></ul>
        <p v-else class="analysis-note">未选择知识记录，本次将仅分析你输入的内容。</p>
        <p class="analysis-note">本次分析会将所选记录正文和下方输入发送至已配置的 AI 服务。</p>
      </section>

      <div class="analysis-goal">
        <label for="knowledge-analysis-goal">{{ analysisMode === 'idea' ? '新想法与分析目标' : '整理目标' }}</label>
        <el-input id="knowledge-analysis-goal" v-model="instruction" type="textarea" :rows="3" resize="vertical" :disabled="busy" :placeholder="analysisMode === 'idea' ? '描述你的想法，以及希望验证的问题…' : '例如：比较这些实践的适用条件，整理为可复用的操作步骤…'" />
        <p class="analysis-note">开始分析时，原始输入会先独立保存到收件箱，并作为分析来源。</p>
      </div>
      <div class="analysis-run-actions">
        <el-button v-if="streaming" @click="cancel"><el-icon><VideoPause /></el-icon>取消分析</el-button>
        <el-button v-else :type="hasResult ? 'default' : 'primary'" :loading="preparing" :disabled="!canAnalyze" @click="analyze"><el-icon><MagicStick /></el-icon>{{ preparing ? '保存原始输入' : error ? '重试分析' : hasResult ? '重新分析' : '开始分析' }}</el-button>
        <span v-if="streaming" class="analysis-note" role="status">正在分析所选内容…</span>
        <span v-else-if="canceled" class="analysis-note" role="status">分析已取消，已生成内容可继续编辑。</span>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" class="analysis-alert" />

      <section v-if="started" class="analysis-result">
        <div class="field-heading"><h3>分析草稿</h3><span>{{ streaming ? '生成中' : '保存前可编辑' }}</span></div>
        <p v-if="selectionChanged" class="analysis-note analysis-warning">所选来源已变化，当前草稿仍引用上一次分析的 {{ resultSources.length }} 条来源。重新分析后才会使用新选择。</p>
        <p v-if="inputChanged" class="analysis-note analysis-warning">输入已变化，当前草稿仍对应上一次分析。重新分析会替换草稿，请先保存需要保留的修改。</p>
        <div class="result-fields">
          <div class="result-title"><label for="knowledge-analysis-title">标题</label><el-input id="knowledge-analysis-title" v-model="draft.title" :disabled="busy" maxlength="240" placeholder="填写草稿标题" /></div>
          <div class="result-type"><label for="knowledge-analysis-type">保存类型</label><el-select id="knowledge-analysis-type" v-model="draft.type" :disabled="busy" aria-label="草稿类型"><el-option v-for="(label, value) in KNOWLEDGE_TYPES" :key="value" :value="value" :label="label" /></el-select></div>
        </div>
        <label for="knowledge-analysis-body">正文</label>
        <el-input id="knowledge-analysis-body" v-model="draft.body" type="textarea" :rows="14" resize="vertical" :readonly="busy" :placeholder="streaming ? '等待模型返回分析内容…' : '在此编辑分析结果…'" />
        <div v-if="resultSources.length" class="result-source-note">草稿来源：{{ resultSources.map(source => source.title).join('、') }}</div>
        <p class="analysis-note">保存为独立草稿，方法、SOP 与规则建议需验证后再决定是否采用。</p>
      </section>
    </div>

    <footer class="analysis-footer">
      <span class="analysis-note">{{ streaming ? '生成期间暂不可保存' : cacheError ? '请及时保存，草稿备份不可用' : '关闭后可恢复本次草稿' }}</span>
      <el-button @click="close">关闭</el-button>
      <el-button :type="hasResult ? 'primary' : 'default'" :loading="saving" :disabled="!canSave" @click="save"><el-icon><DocumentAdd /></el-icon>保存为草稿</el-button>
    </footer>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { state } from '../../store'
import { useKnowledge } from '../../composables/useKnowledge'
import { KNOWLEDGE_TYPES } from '../../utils/knowledge'
import { createKnowledgeAnalysisRequest, normalizeAnalysisMode, normalizeKnowledgeSources } from '../../utils/knowledge-ai'

const props = defineProps({
  records: { type: Array, default: () => [] },
  mode: { type: String, default: 'organize' },
  saveDraft: { type: Function, default: null },
})
const emit = defineEmits(['save', 'close', 'configure'])
const knowledge = useKnowledge()
const analysisMode = ref(normalizeAnalysisMode(props.mode))
const instruction = ref('')
const streaming = ref(false)
const preparing = ref(false)
const saving = ref(false)
const started = ref(false)
const canceled = ref(false)
const error = ref('')
const cacheError = ref('')
const resultSources = ref([])
const inputRecordId = ref('')
const inputRecordBody = ref('')
const analyzedInstruction = ref('')
const draft = reactive({ title: '', body: '', type: analysisMode.value === 'idea' ? 'idea' : 'method' })
const sources = computed(() => normalizeKnowledgeSources(props.records))
const configured = computed(() => !!(state.config.ai?.keyConfigured && state.config.ai?.model))
const hasResult = computed(() => !!draft.body.trim())
const busy = computed(() => streaming.value || preparing.value || saving.value)
const canAnalyze = computed(() => configured.value && !busy.value && !!(sources.value.length || instruction.value.trim()))
const canSave = computed(() => started.value && !busy.value && !!draft.title.trim() && hasResult.value)
const selectionChanged = computed(() => started.value && JSON.stringify(sources.value) !== JSON.stringify(resultSources.value.filter(source => source.id !== inputRecordId.value)))
const inputChanged = computed(() => started.value && instruction.value !== analyzedInstruction.value)
let analysisEpoch = 0
let disposed = false
let cacheCleared = false
let restoring = false
const cacheKeyFor = () => `personnel-plm:knowledge-analysis:v1:${JSON.stringify([analysisMode.value, [...new Set(sources.value.map(source => source.id))].sort()])}`
let activeCacheKey = cacheKeyFor()

function persistCache(key = activeCacheKey) {
  if (cacheCleared || restoring) return
  try {
    if (!instruction.value && !draft.body && !started.value) {
      localStorage.removeItem(key)
      cacheError.value = ''
      return
    }
    localStorage.setItem(key, JSON.stringify({
      instruction: instruction.value,
      draft: { title: draft.title, body: draft.body, type: draft.type },
      resultSources: resultSources.value,
      started: started.value, canceled: canceled.value || streaming.value,
      inputRecordId: inputRecordId.value, inputRecordBody: inputRecordBody.value,
      analyzedInstruction: analyzedInstruction.value,
    }))
    cacheError.value = ''
  } catch { cacheError.value = '本地草稿备份失败，当前内容尚在页面中，请及时保存为记录。' }
}
function restoreCache() {
  restoring = true
  cacheCleared = false
  instruction.value = ''
  Object.assign(draft, { title: '', body: '', type: analysisMode.value === 'idea' ? 'idea' : 'method' })
  resultSources.value = []
  started.value = false
  canceled.value = false
  inputRecordId.value = ''
  inputRecordBody.value = ''
  analyzedInstruction.value = ''
  error.value = ''
  try {
    const raw = localStorage.getItem(activeCacheKey)
    if (raw) {
      const saved = JSON.parse(raw)
      instruction.value = typeof saved.instruction === 'string' ? saved.instruction : ''
      Object.assign(draft, { title: typeof saved.draft?.title === 'string' ? saved.draft.title : '', body: typeof saved.draft?.body === 'string' ? saved.draft.body : '', type: KNOWLEDGE_TYPES[saved.draft?.type] ? saved.draft.type : draft.type })
      resultSources.value = normalizeKnowledgeSources(saved.resultSources || [])
      started.value = !!saved.started
      canceled.value = !!saved.canceled
      inputRecordId.value = typeof saved.inputRecordId === 'string' ? saved.inputRecordId : ''
      inputRecordBody.value = typeof saved.inputRecordBody === 'string' ? saved.inputRecordBody : ''
      analyzedInstruction.value = typeof saved.analyzedInstruction === 'string' ? saved.analyzedInstruction : instruction.value
    }
    cacheError.value = ''
  } catch { cacheError.value = '本地草稿备份读取失败。原备份未清除，当前输入请及时保存为记录。' }
  finally { restoring = false }
}
restoreCache()
watch([instruction, draft, resultSources, started, canceled, streaming, inputRecordId, inputRecordBody, analyzedInstruction], () => { if (!restoring) cacheCleared = false; persistCache() }, { deep: true, flush: 'sync' })
watch(() => props.mode, value => { if (!busy.value) analysisMode.value = normalizeAnalysisMode(value) })
watch(() => cacheKeyFor(), next => {
  if (next === activeCacheKey) return
  persistCache(activeCacheKey)
  activeCacheKey = next
  restoreCache()
})

const request = createKnowledgeAnalysisRequest(window.gitReport, {
  onText: text => { draft.body = text },
  onRunning: value => { streaming.value = value },
})

async function preserveInput(text, mode) {
  if (!text.trim()) return null
  if (!(await knowledge.load())) throw new Error(knowledge.data.error || '无法读取知识库，尚未发送 AI 请求。')
  const previous = inputRecordId.value && knowledge.record(inputRecordId.value)
  if (previous && !previous.deletedAt && inputRecordBody.value === text && previous.body === text) return previous
  const projectIds = [...new Set(props.records.map(record => record.projectId || ''))]
  const project = projectIds.length === 1 && projectIds[0] ? props.records[0] : null
  const record = await knowledge.create({
    title: `${mode === 'idea' ? '原始想法' : '整理目标'} · ${text.trim().split(/\r?\n/)[0].slice(0, 100)}`,
    body: text, type: 'idea', status: 'inbox',
    projectId: project?.projectId || '', projectName: project?.projectName || '',
  })
  inputRecordId.value = record.id
  inputRecordBody.value = text
  persistCache()
  return record
}

async function analyze() {
  if (!configured.value) { emit('configure'); return }
  if (!canAnalyze.value) return
  const epoch = ++analysisEpoch
  const mode = analysisMode.value
  const input = instruction.value
  preparing.value = true
  error.value = ''
  try {
    const original = await preserveInput(input, mode)
    if (disposed || epoch !== analysisEpoch) return
    resultSources.value = normalizeKnowledgeSources([...sources.value, ...(original ? [original] : [])])
    analyzedInstruction.value = input
    started.value = true
    canceled.value = false
    draft.body = ''
    draft.type = mode === 'idea' ? 'idea' : 'method'
    draft.title = mode === 'idea' ? '想法分析草稿' : '知识整理草稿'
    preparing.value = false
    const result = await request.run({ records: resultSources.value, instruction: input, mode }, state.config.ai)
    if (disposed || epoch !== analysisEpoch || result.stale) return
    if (result.ok) {
      const heading = result.text.match(/^#\s+(.+)$/m)?.[1]?.trim()
      if (heading) draft.title = heading.slice(0, 240)
    } else if (result.aborted) canceled.value = true
    else error.value = result.error
  } catch (failure) {
    if (!disposed && epoch === analysisEpoch) error.value = `原始输入保存失败，未发送 AI 请求：${failure?.message || failure}`
  } finally { preparing.value = false }
}

function cancel() {
  analysisEpoch += 1
  canceled.value = true
  request.cancel()
  persistCache()
}
async function save() {
  if (!canSave.value) return
  const payload = {
    title: draft.title.trim(), body: draft.body.trim(),
    type: KNOWLEDGE_TYPES[draft.type] ? draft.type : 'method', status: 'draft',
    sourceIds: [...new Set(resultSources.value.map(source => source.id).filter(Boolean))],
  }
  if (!props.saveDraft) { emit('save', payload); return }
  saving.value = true
  error.value = ''
  try {
    const record = await props.saveDraft(payload)
    if (!record?.id) throw new Error('未收到保存完成确认，请重试。')
    cacheCleared = true
    try { localStorage.removeItem(activeCacheKey) } catch { cacheError.value = '记录已保存，但本地草稿备份清理失败。' }
  } catch (failure) {
    error.value = `保存草稿失败：${failure?.message || failure}`
    persistCache()
  } finally { saving.value = false }
}
function onAnalysisKeydown(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
  event.preventDefault()
  event.stopPropagation()
  if (canSave.value) void save()
}
function close() { cancel(); persistCache(); emit('close') }
onBeforeUnmount(() => { disposed = true; analysisEpoch += 1; persistCache(); request.dispose() })
</script>

<style scoped>
.knowledge-analysis { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--surface); color: var(--brand-text); font-size: 13px; }
.analysis-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 64px; padding: 12px 20px; border-bottom: 1px solid var(--line); }
.analysis-header > div { display: flex; align-items: baseline; gap: 12px; }
.analysis-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.analysis-header span { color: var(--text-muted); font-size: 12px; }
.analysis-scroll { flex: 1; min-height: 0; overflow: auto; padding: 20px; }
.analysis-modes { margin-bottom: 20px; }
.analysis-sources { margin-bottom: 20px; }
.field-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.field-heading span { color: var(--text-muted); font-size: 12px; }
.field-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
.analysis-sources ul { margin: 0; padding: 0; list-style: none; max-height: 160px; overflow: auto; }
.analysis-sources li { display: flex; align-items: center; gap: 8px; min-height: 32px; border-bottom: 1px solid var(--line-soft); }
.analysis-sources li > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.analysis-sources .el-icon, .analysis-sources small { flex: none; color: var(--text-muted); }
.analysis-sources small { margin-left: auto; font-size: 11px; }
.analysis-note { margin: 8px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.analysis-warning { color: var(--el-color-warning); }
.analysis-goal > label, .result-fields label, .analysis-result > label { display: block; margin-bottom: 8px; }
.analysis-run-actions { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
.analysis-run-actions .analysis-note { margin: 0; }
.analysis-alert { margin-bottom: 16px; }
.analysis-result { padding-top: 20px; border-top: 1px solid var(--line); }
.result-fields { display: flex; gap: 12px; margin: 16px 0; }
.result-title { flex: 1; min-width: 0; }
.result-type { width: 120px; flex: none; }
.result-source-note { margin-top: 12px; color: var(--text-muted); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.analysis-footer { min-height: 64px; padding: 12px 20px; border-top: 1px solid var(--line); display: flex; align-items: center; gap: 8px; background: var(--surface); }
.analysis-footer .analysis-note { flex: 1; margin: 0; }
.analysis-footer .el-button + .el-button { margin: 0; }
.knowledge-analysis :deep(.el-button) { min-height: 32px; height: 32px; font-size: 13px; border-radius: 6px; }
.knowledge-analysis :deep(.el-textarea__inner) { padding: 12px; font-size: 13px; line-height: 1.8; background: var(--surface); color: var(--brand-text); }
.knowledge-analysis :deep(.el-radio-button__inner) { min-height: 32px; padding: 8px 12px; font-size: 13px; }
</style>
