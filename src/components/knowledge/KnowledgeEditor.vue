<template>
  <section class="knowledge-editor" aria-label="知识记录编辑器" @keydown="onEditorKeydown">
    <header class="editor-toolbar">
      <div class="save-state" role="status" :class="{ 'has-error': saveError }">
        <el-icon v-if="saving" class="is-loading"><Loading /></el-icon>
        <el-icon v-else-if="saveError"><Warning /></el-icon>
        <el-icon v-else><Document /></el-icon>
        <span>{{ deleted ? '回收站 · 只读' : saving ? '正在保存…' : saveError ? '保存失败' : pendingFields.size ? '等待保存' : '更改自动保存' }}</span>
      </div>
      <div class="editor-actions">
        <template v-if="!deleted">
          <el-tooltip content="立即保存 · Ctrl+S" placement="bottom"><el-button text :disabled="saving" @click="requestSave"><el-icon><DocumentChecked /></el-icon><span>保存</span></el-button></el-tooltip>
          <el-button :disabled="saving || !hasContent" @click="emit('analyze')"><el-icon><MagicStick /></el-icon><span>AI 整理 / 分析</span></el-button>
        </template>
        <el-button v-else type="primary" :disabled="saving" @click="emit('restore')"><el-icon><RefreshLeft /></el-icon><span>恢复记录</span></el-button>
        <el-dropdown trigger="click" @command="onMoreAction">
          <el-button text aria-label="记录更多操作"><el-icon><MoreFilled /></el-icon></el-button>
          <template #dropdown><el-dropdown-menu>
            <el-dropdown-item command="export">导出 Markdown</el-dropdown-item>
            <el-dropdown-item v-if="!deleted" command="trash" divided :disabled="saving">移至回收站</el-dropdown-item>
          </el-dropdown-menu></template>
        </el-dropdown>
      </div>
    </header>

    <div v-if="saveError" class="save-error" role="alert"><span>{{ saveError }}</span><el-button v-if="!deleted" text :disabled="saving" @click="requestSave">重试保存</el-button></div>
    <div v-if="deleted" class="trash-notice"><el-icon><Delete /></el-icon><span>这条记录已移至回收站。恢复后可继续编辑。</span></div>

    <div class="record-heading">
      <el-input :model-value="draft.title" :readonly="deleted" maxlength="240" placeholder="记录标题" aria-label="记录标题" class="record-title" @update:model-value="(value) => changeField('title', value)" />
      <div class="record-properties">
        <label class="property-field"><span>类型</span><el-select :model-value="draft.type" :disabled="deleted" aria-label="记录类型" class="type-select" @update:model-value="(value) => changeField('type', value)"><el-option v-for="option in typeOptions" :key="option.value" :value="option.value" :label="option.label" /></el-select></label>
        <label class="property-field"><span>状态</span><el-select :model-value="draft.status" :disabled="deleted" aria-label="整理状态" class="status-select" @update:model-value="(value) => changeField('status', value)"><el-option v-for="option in statusOptions" :key="option.value" :value="option.value" :label="option.label" /></el-select></label>
        <label class="property-field project-field"><span>项目</span><el-select :model-value="draft.projectId || ''" :disabled="deleted" filterable clearable placeholder="不关联项目" aria-label="关联项目" class="project-select" @update:model-value="changeProject">
          <el-option v-if="historicalProject" :value="draft.projectId" :label="`${draft.projectName || '历史项目'}（已不在项目列表）`" />
          <el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" />
        </el-select></label>
      </div>
      <div class="record-tags">
        <el-icon><PriceTag /></el-icon>
        <el-select :model-value="draft.tags" multiple filterable allow-create default-first-option :reserve-keyword="false" :disabled="deleted" placeholder="添加标签，输入后按 Enter 创建" aria-label="记录标签" class="tags-select" @update:model-value="changeTags"><el-option v-for="tag in draft.tags" :key="tag" :value="tag" :label="tag" /></el-select>
      </div>
    </div>

    <div class="body-toolbar">
      <div class="editor-mode" role="tablist" aria-label="正文模式">
        <button v-if="!deleted" type="button" role="tab" :aria-selected="displayMode === 'edit'" :class="{ 'is-active': displayMode === 'edit' }" @click="mode = 'edit'">编辑</button>
        <button type="button" role="tab" :aria-selected="displayMode === 'preview'" :class="{ 'is-active': displayMode === 'preview' }" @click="mode = 'preview'">预览</button>
      </div>
      <div class="body-tools">
        <span class="markdown-hint">{{ displayMode === 'preview' ? '点击链接可复制' : 'Markdown' }}</span>
        <el-tooltip v-if="!deleted" :content="draft.body.trim() ? '仅空白正文可插入模板，不会覆盖已有内容' : `插入${typeLabel}模板`" placement="top"><span><el-button text :disabled="!!draft.body.trim()" @click="insertTemplate"><el-icon><Tickets /></el-icon><span>插入模板</span></el-button></span></el-tooltip>
      </div>
    </div>

    <div class="body-workspace">
      <textarea v-if="displayMode === 'edit'" :value="draft.body" class="markdown-input" aria-label="记录正文" placeholder="写下想法、问题或实践经验…&#10;&#10;支持 Markdown，内容会自动保存。" spellcheck="false" @input="changeField('body', $event.target.value)" />
      <article v-else-if="draft.body.trim()" class="markdown-preview" aria-label="正文预览" @click="copyPreviewLink" @auxclick="copyPreviewLink" v-html="previewHtml" />
      <div v-else class="preview-empty"><el-icon><Document /></el-icon><span>暂无正文</span></div>
    </div>

    <section v-if="sourceEntries.length" class="record-sources" aria-label="来源记录">
      <h3><el-icon><Link /></el-icon>来源记录<span>{{ sourceEntries.length }}</span></h3>
      <button v-for="source in sourceEntries" :key="source.id" type="button" class="source-row" @click="emit('open-source', source.id)"><el-icon><Document /></el-icon><span class="source-name">{{ source.title || '未命名记录' }}</span><span class="source-meta">{{ source.missing ? '来源未载入' : source.deletedAt ? '回收站' : typeName(source.type) }}</span><el-icon><ArrowRight /></el-icon></button>
    </section>

    <footer class="editor-footer"><span>{{ characterCount }} 字<template v-if="draft.updatedAt"> · 更新于 {{ formatTime(draft.updatedAt) }}</template></span><span>{{ deleted ? '恢复后可编辑' : 'Ctrl+S 立即保存' }}</span></footer>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { KNOWLEDGE_TYPES, KNOWLEDGE_STATUSES, knowledgeTime } from '../../utils/knowledge'

const props = defineProps({
  record: { type: Object, required: true },
  projects: { type: Array, default: () => [] },
  saving: { type: Boolean, default: false },
  saveError: { type: String, default: '' },
  sources: { type: Array, default: () => [] },
})
const emit = defineEmits(['change', 'save', 'trash', 'restore', 'analyze', 'open-source', 'export'])

const typeOptions = Object.entries(KNOWLEDGE_TYPES).map(([value, label]) => ({ value, label: value === 'sop' ? '流程（SOP）' : label }))
const statusOptions = Object.entries(KNOWLEDGE_STATUSES).map(([value, label]) => ({ value, label }))
const templates = {
  idea: '## 想法\n\n\n## 适用场景\n\n\n## 下一步\n\n- [ ] ',
  problem: '## 问题描述\n\n\n## 复现条件\n\n\n## 已尝试的方法\n\n\n## 结论与后续\n\n',
  decision: '## 决策背景\n\n\n## 备选方案\n\n\n## 最终决定\n\n\n## 原因与影响\n\n',
  experience: '## 背景\n\n\n## 实践过程\n\n\n## 结果与经验\n\n\n## 下次如何改进\n\n',
  method: '## 适用场景\n\n\n## 准备条件\n\n\n## 操作方法\n\n1. \n\n## 验证方式\n\n',
  sop: '## 目的与范围\n\n\n## 前置条件\n\n\n## 执行步骤\n\n1. \n\n## 完成标准\n\n- [ ] \n\n## 异常处理\n\n',
  principle: '## 原则\n\n\n## 为什么\n\n\n## 适用边界\n\n\n## 示例\n\n',
  ai: '## 场景\n\n\n## 问题\n\n\n## 策略\n\n\n## Prompt 模式\n\n```text\n\n```\n\n## AI 输出\n\n\n## 人工修正\n\n\n## 最终效果\n\n\n## 适用边界\n\n',
}
const editableFields = ['title', 'body', 'type', 'status', 'tags', 'projectId', 'projectName']
const clone = (value) => JSON.parse(JSON.stringify(value))
const normalizedRecord = (record) => ({ ...clone(record), title: record.title || '', body: record.body || '', type: record.type || 'idea', status: record.status || 'inbox', tags: Array.isArray(record.tags) ? [...record.tags] : [] })
const draft = ref(normalizedRecord(props.record))
const mode = ref('edit')
const pendingFields = ref(new Map())
const recordVersion = (record) => Number.isFinite(Number(record.revision)) && record.revision != null ? Number(record.revision) : (Number.isFinite(Number(record.updatedAt)) && record.updatedAt != null ? Number(record.updatedAt) : Date.parse(record.updatedAt || '') || 0)
let acceptedVersion = recordVersion(props.record)
const equals = (left, right) => JSON.stringify(left) === JSON.stringify(right)

// 同一记录的旧保存响应不能覆盖输入。只有更高版本确认了该字段的最新值，才解除本地保护。
watch(() => props.record, (record) => {
  const incoming = normalizedRecord(record)
  const version = recordVersion(record)
  if (incoming.id !== draft.value.id) {
    draft.value = incoming
    pendingFields.value = new Map()
    acceptedVersion = version
    mode.value = 'edit'
    return
  }
  if (version < acceptedVersion) return
  const pending = new Map(pendingFields.value)
  for (const field of editableFields) {
    const change = pending.get(field)
    if (!change) continue
    const confirmed = field === 'title' ? incoming[field] === String(change.value).trim() : equals(incoming[field], change.value)
    if (version > change.version && confirmed) pending.delete(field)
    else incoming[field] = clone(draft.value[field] ?? null)
  }
  acceptedVersion = Math.max(acceptedVersion, version)
  pendingFields.value = pending
  draft.value = incoming
}, { deep: true })

const deleted = computed(() => !!draft.value.deletedAt)
const displayMode = computed(() => deleted.value ? 'preview' : mode.value)
const hasContent = computed(() => !!(draft.value.title.trim() || draft.value.body.trim()))
const historicalProject = computed(() => !!draft.value.projectId && !props.projects.some((project) => project.id === draft.value.projectId))
const typeName = (type) => typeOptions.find((option) => option.value === type)?.label || '记录'
const typeLabel = computed(() => typeName(draft.value.type))
const characterCount = computed(() => [...draft.value.body.replace(/\s/g, '')].length)
const previewHtml = computed(() => {
  const parsed = marked.parse(draft.value.body, { async: false, gfm: true, breaks: true })
  return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : String(parsed))
})
const sourceEntries = computed(() => {
  const byId = new Map(props.sources.map((source) => [source.id, source]))
  return [...new Set(draft.value.sourceIds || [])].map((id) => byId.get(id) || { id, title: `来源记录 ${id}`, missing: true })
})

function applyChanges(changes) {
  if (deleted.value) return
  const pending = new Map(pendingFields.value)
  let changed = false
  for (const [field, value] of Object.entries(changes)) {
    if (equals(draft.value[field], value)) continue
    changed = true
    draft.value[field] = clone(value)
    pending.set(field, { value: clone(value), version: acceptedVersion })
  }
  if (!changed) return
  pendingFields.value = pending
  emit('change', clone(draft.value))
}
function changeField(field, value) { applyChanges({ [field]: value }) }
function changeTags(tags) { applyChanges({ tags: [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))] }) }
function changeProject(id) {
  const projectId = id || ''
  const project = props.projects.find((item) => item.id === projectId)
  const projectName = project?.name || (projectId === draft.value.projectId ? draft.value.projectName || '' : '')
  applyChanges({ projectId, projectName })
}
function insertTemplate() {
  if (deleted.value || draft.value.body.trim()) return
  changeField('body', templates[draft.value.type] || templates.idea)
  mode.value = 'edit'
}
function requestSave() { if (!deleted.value && !props.saving) emit('save') }
function onEditorKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    event.stopPropagation()
    requestSave()
  }
}
function onMoreAction(command) {
  if (command === 'export') emit('export')
  else if (command === 'trash' && !deleted.value && !props.saving) emit('trash')
}
function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return knowledgeTime(value)
}
async function copyPreviewLink(event) {
  const link = event.target?.closest?.('a')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href')
  if (!href) return
  try {
    await navigator.clipboard.writeText(href)
    ElMessage.success('链接已复制，可在浏览器中打开')
  } catch { ElMessage.warning('无法访问剪贴板，请选中链接文字手动复制') }
}
</script>

<style scoped>
.knowledge-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; overflow: auto; background: var(--surface); color: var(--brand-text); }
.editor-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 56px; padding: 12px 24px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
.save-state { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text-muted); font-size: 12px; }
.save-state.has-error { color: var(--danger); }
.editor-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.editor-actions .el-button + .el-button { margin-left: 0; }
.el-button .el-icon + span { margin-left: 8px; }
.save-error, .trash-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 24px; font-size: 12px; line-height: 1.6; flex-shrink: 0; }
.save-error { color: var(--danger); background: var(--danger-soft); }
.save-error > span { overflow-wrap: anywhere; }
.trash-notice { justify-content: flex-start; color: var(--text-muted); background: var(--surface-subtle); }
.record-heading { padding: 16px 24px 12px; flex-shrink: 0; }
.record-title { margin-bottom: 16px; }
.record-title :deep(.el-input__wrapper) { padding: 0; box-shadow: none; background: transparent; }
.record-title :deep(.el-input__inner) { font-size: 20px; font-weight: 600; line-height: 32px; height: 32px; color: var(--brand-text); }
.record-title :deep(.el-input__wrapper.is-focus) { box-shadow: 0 2px 0 var(--accent-strong); border-radius: 0; }
.record-properties { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; }
.property-field { display: flex; align-items: center; gap: 8px; font-size: 12px; min-width: 0; }
.property-field > span { color: var(--text-muted); flex-shrink: 0; }
.type-select { width: 112px; }
.status-select { width: 112px; }
.project-field { flex: 1; }
.project-select { width: 100%; min-width: 160px; max-width: 280px; }
.record-tags { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; }
.record-tags > .el-icon { color: var(--text-muted); margin-top: 8px; width: 24px; }
.tags-select { width: 100%; }
.tags-select :deep(.el-select__wrapper) { background: transparent; box-shadow: none; padding-left: 0; }
.tags-select :deep(.el-select__wrapper.is-focused) { box-shadow: 0 0 0 1px var(--accent-strong) inset; }
.body-toolbar { display: flex; align-items: center; justify-content: space-between; min-height: 44px; padding: 0 24px; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line); flex-shrink: 0; }
.editor-mode { display: flex; align-items: stretch; gap: 20px; height: 44px; }
.editor-mode button { position: relative; background: transparent; border: 0; padding: 0; color: var(--text-muted); font: inherit; font-size: 13px; cursor: pointer; }
.editor-mode button.is-active { color: var(--accent-strong); font-weight: 600; }
.editor-mode button.is-active::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--accent-strong); }
.editor-mode button:focus-visible, .source-row:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.body-tools { display: flex; align-items: center; gap: 12px; }
.markdown-hint { font-size: 11px; color: var(--text-muted); }
.body-workspace { flex: 1; min-height: 200px; display: flex; overflow: auto; }
.markdown-input { resize: none; width: 100%; min-height: 200px; border: 0; padding: 20px 24px; background: var(--surface); color: var(--brand-text); outline: none; font: inherit; font-size: 14px; line-height: 1.8; tab-size: 2; }
.markdown-input::placeholder { color: var(--text-disabled); }
.markdown-input:focus-visible { box-shadow: inset 2px 0 0 var(--accent-strong); }
.markdown-preview { padding: 20px 24px; width: 100%; min-width: 0; color: var(--brand-text); font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.markdown-preview :deep(> :first-child) { margin-top: 0; }
.markdown-preview :deep(h1) { font-size: 22px; }
.markdown-preview :deep(h2) { font-size: 18px; }
.markdown-preview :deep(h3) { font-size: 16px; }
.markdown-preview :deep(h4), .markdown-preview :deep(h5), .markdown-preview :deep(h6) { font-size: 14px; }
.markdown-preview :deep(p), .markdown-preview :deep(ul), .markdown-preview :deep(ol) { margin: 8px 0 16px; }
.markdown-preview :deep(pre) { padding: 12px 16px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-subtle); }
.markdown-preview :deep(code) { font-family: var(--brand-mono, monospace); font-size: 12px; background: var(--surface-subtle); border-radius: 4px; padding: 2px 4px; }
.markdown-preview :deep(pre code) { padding: 0; }
.markdown-preview :deep(blockquote) { margin: 16px 0; padding: 0 16px; color: var(--text-muted); border-left: 3px solid var(--line-strong); }
.markdown-preview :deep(a) { color: var(--accent-strong); text-decoration: underline; text-underline-offset: 3px; }
.markdown-preview :deep(img) { max-width: 100%; }
.markdown-preview :deep(table) { width: 100%; border-collapse: collapse; font-size: 12px; }
.markdown-preview :deep(th), .markdown-preview :deep(td) { padding: 8px 12px; border: 1px solid var(--line); text-align: left; }
.markdown-preview :deep(th) { background: var(--surface-subtle); }
.markdown-preview :deep(hr) { margin: 20px 0; border: 0; border-top: 1px solid var(--line); }
.preview-empty { display: flex; align-items: center; justify-content: center; gap: 8px; flex: 1; color: var(--text-muted); font-size: 13px; }
.record-sources { padding: 12px 24px; border-top: 1px solid var(--line); flex-shrink: 0; max-height: 200px; overflow: auto; }
.record-sources h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 12px; font-weight: 600; }
.record-sources h3 > span { color: var(--text-muted); font-weight: 400; }
.source-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 4px 8px; margin: 0; border: 0; border-radius: 4px; color: var(--text-muted); background: transparent; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.source-row:hover { background: var(--surface-subtle); }
.source-name { flex: 1; color: var(--brand-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-meta { font-size: 11px; flex-shrink: 0; }
.editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 32px; padding: 4px 24px; border-top: 1px solid var(--line-soft); color: var(--text-muted); font-size: 11px; flex-shrink: 0; }
@media (max-width: 1280px) {
  .editor-toolbar, .save-error, .trash-notice, .record-heading, .body-toolbar, .markdown-input, .markdown-preview, .record-sources, .editor-footer { padding-left: 16px; padding-right: 16px; }
  .record-properties { gap: 12px; }
  .type-select, .status-select { width: 104px; }
}
@media (max-width: 960px) {
  .editor-toolbar { align-items: flex-start; flex-wrap: wrap; }
  .editor-actions { margin-left: auto; }
  .project-field { flex-basis: 100%; }
  .body-workspace, .markdown-input { min-height: 160px; }
  .editor-footer { flex-wrap: wrap; gap: 4px 12px; }
}
</style>
