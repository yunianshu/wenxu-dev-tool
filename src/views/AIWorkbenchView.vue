<template>
  <div class="knowledge-workbench" @keydown.ctrl.s.prevent="saveCurrent" @keydown.meta.s.prevent="saveCurrent">
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page knowledge-topbar">
        <h1 class="topbar-page-title">AI 工作台</h1><span class="topbar-context">先把想法记下来</span>
        <div class="knowledge-topbar-actions">
          <el-dropdown trigger="click" @command="handleCommand"><el-button text aria-label="知识库更多操作"><el-icon><MoreFilled /></el-icon></el-button><template #dropdown><el-dropdown-menu>
            <el-dropdown-item command="import">导入 Markdown</el-dropdown-item>
            <el-dropdown-item command="folder" :disabled="!data.directory">打开知识库目录</el-dropdown-item>
            <el-dropdown-item command="refresh">刷新记录</el-dropdown-item>
          </el-dropdown-menu></template></el-dropdown>
        </div>
      </div>
    </Teleport>
    <input ref="fileInput" class="knowledge-file-input" type="file" accept=".md,.markdown,text/markdown,text/plain" multiple @change="importFiles($event.target.files)" />
    <nav class="knowledge-tabs" aria-label="知识视图">
      <button v-for="item in views" :key="item.id" :class="{ active: workspace.view === item.id }" @click="setView(item.id)"><el-icon><component :is="item.icon" /></el-icon>{{ item.label }}</button>
    </nav>
    <div v-if="data.error" class="knowledge-error" role="alert">{{ data.error }}<el-button text @click="refresh">重试</el-button></div>
    <div v-if="data.backupError" class="knowledge-error" role="alert">{{ data.backupError }}</div>
    <div v-if="data.warnings.length" class="knowledge-error" role="alert">{{ data.warnings.length }} 个文件未能读取，原文件已保留。<el-button text @click="showWarnings = !showWarnings">{{ showWarnings ? '收起' : '查看详情' }}</el-button><pre v-if="showWarnings">{{ data.warnings.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') }}</pre></div>
    <div class="knowledge-layout" :class="{ 'has-panel': !!current }" @dragover.prevent @drop.prevent="onDrop">
      <section v-if="workspace.view === 'globe'" class="knowledge-idea-surface" aria-label="想法地球工作区">
        <form class="knowledge-capture idea-capture" @submit.prevent="quickCapture">
          <el-icon><EditPen /></el-icon><input v-model="capture" maxlength="2000" aria-label="快速记录" placeholder="写下一个想法，按 Enter 放进地球…" /><button type="submit" :disabled="!capture.trim() || creating" title="Enter 保存想法" aria-label="保存快速记录"><el-icon><TopRight /></el-icon></button>
        </form>
        <IdeaGlobe :records="ideaRecords" :selected-id="current?.type === 'idea' ? current.id : ''" :highlight-id="highlightIdeaId" :loading="data.loading" @select="selectRow" />
      </section>
      <section v-else class="knowledge-records" aria-label="知识记录">
        <div class="knowledge-filters">
          <el-input ref="searchInput" v-model="workspace.query" clearable :prefix-icon="Search" placeholder="搜索标题、正文或标签" aria-label="搜索知识记录" />
          <el-select v-model="workspace.projectId" aria-label="筛选关联项目" :empty-values="[null, undefined]" class="knowledge-project-filter" filterable><el-option value="" label="全部项目"/><el-option value="__none__" label="未关联项目"/><el-option v-for="project in projectOptions" :key="project.id" :value="project.id" :label="project.name" /></el-select>
        </div>
        <div class="knowledge-list-toolbar">
          <span>{{ filtered.length }} 条记录</span>
          <el-select v-model="sort" aria-label="记录排序" class="knowledge-sort"><el-option value="updated" label="最近更新"/><el-option value="created" label="最近创建"/><el-option value="title" label="标题排序"/></el-select>
        </div>
        <el-table v-loading="data.loading" :data="paged" row-key="id" height="100%" class="knowledge-table" :row-class-name="({ row }) => row.id === workspace.selectedId ? 'is-current-record' : ''" @row-click="selectRow">
          <el-table-column label="记录" min-width="200"><template #default="{ row }"><button class="knowledge-record-title" :title="row.title" @click.stop="selectRow(row)"><el-icon><Document /></el-icon><span>{{ row.title }}</span></button></template></el-table-column>
          <el-table-column v-if="!current" label="项目" min-width="132" show-overflow-tooltip><template #default="{ row }">{{ projectLabel(row) }}</template></el-table-column>
          <el-table-column v-if="!current" label="标签" min-width="128" show-overflow-tooltip><template #default="{ row }"><span class="knowledge-muted">{{ row.tags?.join(' · ') || '—' }}</span></template></el-table-column>
          <el-table-column label="更新" :width="current ? 108 : 132"><template #default="{ row }"><span class="knowledge-date">{{ knowledgeTime(row.updatedAt) }}</span></template></el-table-column>
          <template #empty><div class="knowledge-empty"><el-icon><Collection /></el-icon><strong>{{ workspace.query || workspace.type || workspace.projectId ? '没有符合条件的记录' : workspace.view === 'trash' ? '回收站是空的' : '从一个想法开始积累' }}</strong><p>在「想法地球」输入想法，点击光点补充内容。</p><el-button v-if="workspace.query || workspace.type || workspace.projectId" text @click="clearFilters">清除筛选</el-button></div></template>
        </el-table>
        <footer class="knowledge-list-footer"><span>本地 Markdown</span><el-pagination v-model:current-page="page" small layout="prev, pager, next" :pager-count="5" :page-size="30" :total="filtered.length" hide-on-single-page /></footer>
      </section>
      <section v-if="current" class="knowledge-detail" aria-label="记录详情">
        <div class="knowledge-detail-status"><span :class="{ 'has-error': data.errors[current.id] }">{{ data.errors[current.id] ? '保存失败，草稿保留在当前应用中' : data.saving[current.id] ? '正在保存…' : knowledge.dirty(current.id) ? '等待保存…' : '已保存到本机' }}</span><el-button v-if="data.errors[current.id]" text @click="saveCopy">另存为新记录</el-button><el-button text aria-label="关闭记录详情" @click="workspace.selectedId = ''"><el-icon><Close /></el-icon></el-button></div>
        <KnowledgeEditor :inert="!!data.mutating[current.id]" :record="current" :projects="state.projects.items" :saving="!!data.saving[current.id] || !!data.mutating[current.id]" :save-error="data.errors[current.id] || ''" :sources="sourceRecords" @change="knowledge.change" @save="saveCurrent" @trash="lifecycle('trash')" @restore="lifecycle('restore')" @delete="permanentlyDelete" @open-source="openSource" @export="exportRecord" />
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Connection, Collection, Delete } from '@element-plus/icons-vue'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { useKnowledge } from '../composables/useKnowledge'
import { knowledgeMatches, knowledgeTime } from '../utils/knowledge'
import KnowledgeEditor from '../components/knowledge/KnowledgeEditor.vue'
import IdeaGlobe from '../components/knowledge/IdeaGlobe.vue'

defineEmits(['navigate'])
const topbarReady = useTopbarReady()
const knowledge = useKnowledge()
const { data, workspace } = knowledge
const capture = ref(''), creating = ref(false), page = ref(1), sort = ref('updated')
const fileInput = ref(null), searchInput = ref(null), showWarnings = ref(false)
const highlightIdeaId = ref('')
const views = [{ id: 'globe', label: '想法地球', icon: Connection }, { id: 'all', label: '全部记录', icon: Collection }, { id: 'trash', label: '回收站', icon: Delete }]
const current = computed(() => knowledge.record(workspace.selectedId))
const ideaRecords = computed(() => data.records.filter(row => !row.deletedAt && row.type === 'idea'))
const sourceRecords = computed(() => (current.value?.sourceIds || []).map(id => data.records.find(row => row.id === id)).filter(Boolean))
const projectOptions = computed(() => {
  const options = state.projects.items.map(row => ({ id: row.id, name: row.name }))
  for (const row of data.records) if (row.projectId && !options.some(item => item.id === row.projectId)) options.push({ id: row.projectId, name: `${row.projectName || '历史项目'}（已移除）` })
  return options
})
const filtered = computed(() => data.records.filter(row => knowledgeMatches({ ...row, projectName: projectLabel(row) }, workspace)).sort((a, b) => sort.value === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : Number(b[sort.value === 'created' ? 'createdAt' : 'updatedAt']) - Number(a[sort.value === 'created' ? 'createdAt' : 'updatedAt'])))
const paged = computed(() => filtered.value.slice((page.value - 1) * 30, page.value * 30))
watch(() => [workspace.view, workspace.query, workspace.type, workspace.projectId, sort.value], () => {
  page.value = 1
  if (workspace.view === 'globe' ? !ideaRecords.value.some(row => row.id === workspace.selectedId) : !filtered.value.some(row => row.id === workspace.selectedId)) workspace.selectedId = ''
})
watch(() => filtered.value.length, length => { page.value = Math.min(page.value, Math.max(1, Math.ceil(length / 30))) })
function projectLabel(row) { return state.projects.items.find(project => project.id === row.projectId)?.name || (row.projectId ? `${row.projectName || '历史项目'}（已移除）` : '未关联') }
function clearFilters() { workspace.query = ''; workspace.type = ''; workspace.projectId = '' }
function selectRow(row) { workspace.selectedId = row.id }
function setView(view) { workspace.view = view; if (view === 'globe' && current.value?.type !== 'idea') workspace.selectedId = '' }
function projectFields() { const project = state.projects.items.find(row => row.id === workspace.projectId); return project ? { projectId: project.id, projectName: project.name } : {} }
async function createRecord(fields = {}) {
  if (creating.value) return
  creating.value = true
  try {
    const row = await knowledge.create({ type: 'idea', status: 'inbox', ...projectFields(), ...fields })
    knowledge.openRecord(row, row.projectId)
    return row
  } catch (error) { ElMessage.error(error.message) } finally { creating.value = false }
}
async function quickCapture() {
  const text = capture.value.trim()
  if (!text || creating.value) return
  creating.value = true
  try {
    const row = await knowledge.create({ title: text.split(/\r?\n/)[0].slice(0, 120), body: text, type: 'idea', status: 'inbox', ...projectFields() })
    if (capture.value.trim() === text) capture.value = ''
    workspace.selectedId = ''
    highlightIdeaId.value = row.id
    ElMessage.success('想法已保存并加入地球')
  } catch (error) { ElMessage.error(error.message) } finally { creating.value = false }
}
async function saveCurrent() { if (current.value) await knowledge.flush(current.value.id) }
async function saveCopy() { const row = current.value; if (row) { const copy = await createRecord({ ...row, title: `${row.title.slice(0, 230)}（草稿副本）` }); if (copy) { if (knowledge.record(row.id) === row) knowledge.discard(row.id); await knowledge.load(true) } } }
async function lifecycle(action, id = current.value?.id) {
  if (!id) return
  try { await knowledge.lifecycle(id, action); if (workspace.selectedId === id) workspace.selectedId = ''; ElMessage.success(action === 'trash' ? '已移到回收站，可随时恢复' : '记录已恢复') } catch (error) { ElMessage.error(error.message) }
}
async function refresh() {
  const results = await Promise.all(Object.keys(data.drafts).map(id => knowledge.flush(id)))
  if (results.some(result => !result)) { ElMessage.error('请先处理未保存的记录，避免刷新覆盖草稿'); return }
  await knowledge.load(true)
}

async function permanentlyDelete() {
  const row = current.value
  if (!row?.deletedAt || data.mutating[row.id]) return
  const expected = { revision: row.revision, contentHash: row.contentHash }
  try {
    await ElMessageBox.confirm(`将永久删除「${row.title}」及其本地记录文件，删除后无法恢复。是否继续？`, '永久删除记录', {
      type: 'warning', confirmButtonText: '永久删除', cancelButtonText: '取消',
    })
  } catch { return }
  try { await knowledge.lifecycle(row.id, 'delete', expected); ElMessage.success('记录已永久删除') }
  catch (error) { ElMessage.error(error.message) }
}
function openSource(id) { const row = data.records.find(item => item.id === id); if (row) knowledge.openRecord(row); else ElMessage.warning('来源记录暂时不可用') }
async function exportRecord(id = current.value?.id) {
  if (typeof id !== 'string') id = current.value?.id
  if (!id || !(await knowledge.flush(id))) return
  try { const result = await window.gitReport.knowledgeExport(id); if (!result?.ok) throw new Error(result?.error || '导出失败'); const saved = await window.gitReport.saveReport(result.fileName, result.content); if (saved?.error) throw new Error(saved.error); if (saved?.saved) ElMessage.success('Markdown 已导出') } catch (error) { ElMessage.error(error.message) }
}
async function importFiles(files) {
  let count = 0
  for (const file of Array.from(files || [])) {
    try { if (!/\.(md|markdown)$/i.test(file.name)) throw new Error('仅支持 Markdown 文件'); if (file.size > 600 * 1024) throw new Error('文件超过 600 KB'); const row = await knowledge.importMarkdown({ fileName: file.name, content: await file.text() }); knowledge.openRecord(row); count++ } catch (error) { ElMessage.error(`${file.name}：${error.message}`) }
  }
  if (count) ElMessage.success(`已导入 ${count} 条记录`)
  if (fileInput.value) fileInput.value.value = ''
}
function onDrop(event) { if (event.dataTransfer?.files?.length) importFiles(event.dataTransfer.files) }
async function handleCommand(command) { if (command === 'import') fileInput.value?.click(); else if (command === 'refresh') await refresh(); else try { const result = await window.gitReport.openPath(data.directory); if (result?.error) throw new Error(result.error) } catch (error) { ElMessage.error(error.message) } }
async function shortcut(event) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (workspace.view === 'globe') { setView('all'); await nextTick() } searchInput.value?.focus() } }
onMounted(() => { knowledge.load(); document.addEventListener('keydown', shortcut) })
onBeforeUnmount(() => { document.removeEventListener('keydown', shortcut); for (const id of Object.keys(data.drafts)) void knowledge.flush(id) })
</script>

<style scoped>
.knowledge-workbench { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--surface); }
.knowledge-topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.knowledge-topbar-actions .el-button + .el-button { margin-left: 0; }
.knowledge-file-input { display: none; }
.knowledge-tabs { display: flex; gap: 24px; height: 48px; flex-shrink: 0; padding: 0 24px; border-bottom: 1px solid var(--line); overflow-x: auto; }
.knowledge-tabs button { display: flex; align-items: center; gap: 8px; background: transparent; border: 0; border-bottom: 2px solid transparent; white-space: nowrap; padding: 0; color: var(--text-muted); cursor: pointer; font-size: 13px; }
.knowledge-tabs button.active { color: var(--accent-strong); border-bottom-color: var(--accent-strong); font-weight: 600; }
.knowledge-tabs button:hover { color: var(--brand-text); }
.knowledge-tabs button span { padding: 0 6px; background: var(--surface-subtle); border-radius: 4px; font-size: 11px; }
.knowledge-tabs .el-icon { font-size: 16px; }
.knowledge-layout { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.knowledge-idea-surface { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.knowledge-records { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.has-panel .knowledge-records, .has-panel .knowledge-idea-surface { flex: 0 0 44%; }
.knowledge-detail { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--surface); overflow: hidden; }
.knowledge-detail-status { display: flex; align-items: center; gap: 8px; padding: 0 16px; height: 40px; flex-shrink: 0; background: var(--surface-subtle); border-bottom: 1px solid var(--line); color: var(--text-muted); font-size: 12px; }
.knowledge-detail-status > span { flex: 1; }
.knowledge-detail-status .has-error { color: var(--danger); }
.knowledge-capture { display: flex; gap: 12px; margin: 20px 24px 0; align-items: center; border: 1px solid var(--line-strong); border-radius: 6px; padding: 4px 12px; min-height: 40px; color: var(--text-muted); }
.knowledge-capture:focus-within { border-color: var(--accent-strong); box-shadow: 0 0 0 2px var(--accent-soft); }
.knowledge-capture input { width: 100%; border: 0; outline: none; background: transparent; color: var(--brand-text); font-size: 13px; line-height: 24px; }
.knowledge-capture button { border: 0; background: var(--surface-subtle); color: var(--accent-strong); display: grid; place-items: center; width: 28px; height: 28px; border-radius: 4px; cursor: pointer; }
.knowledge-capture button:disabled { color: var(--text-disabled); cursor: default; }
.idea-capture { flex-shrink: 0; margin-bottom: 8px; }
.knowledge-filters { display: flex; gap: 8px; padding: 16px 24px 8px; }
.knowledge-filters > .el-input { min-width: 120px; flex: 1; }
.knowledge-project-filter { width: 160px; flex-shrink: 0; }
.has-panel .knowledge-filters { flex-wrap: wrap; gap: 8px; padding-left: 16px; padding-right: 16px; }
.has-panel .knowledge-filters > .el-input { flex-basis: 100%; }
.has-panel .knowledge-project-filter { flex: 1; }
.has-panel .knowledge-capture { margin-left: 16px; margin-right: 16px; }
.knowledge-list-toolbar { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 24px 8px; font-size: 12px; color: var(--text-muted); }
.has-panel .knowledge-list-toolbar { padding-left: 16px; padding-right: 16px; }
.knowledge-sort { margin-left: auto; width: 112px; }.knowledge-list-toolbar .el-button { margin: 0; padding: 4px 8px; }
.knowledge-table { flex: 1; min-height: 0; }
.knowledge-table :deep(.el-table__cell) { height: 40px; padding: 4px 0; }
.knowledge-table :deep(.is-current-record > td.el-table__cell) { background: var(--accent-soft); }
.knowledge-record-title { display: flex; align-items: center; gap: 8px; background: transparent; border: 0; padding: 0; max-width: 100%; color: var(--brand-text); cursor: pointer; font-size: 13px; text-align: left; }
.knowledge-record-title .el-icon { flex-shrink: 0; color: var(--text-muted); font-size: 16px; }.knowledge-record-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.knowledge-record-title:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 4px; }
.knowledge-date,.knowledge-muted { color: var(--text-muted); font-size: 12px; }
.knowledge-list-footer { display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; height: 40px; padding: 0 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--text-muted); }
.knowledge-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 40px 24px; line-height: 1.6; }.knowledge-empty > .el-icon { font-size: 24px; color: var(--text-muted); }.knowledge-empty strong { font-size: 14px; color: var(--brand-text); }.knowledge-empty p { font-size: 13px; margin: 0; max-width: 320px; }
.knowledge-error { padding: 8px 16px; color: var(--danger); font-size: 13px; background: var(--danger-soft); }.knowledge-error pre { white-space: pre-wrap; max-height: 100px; overflow: auto; }
@media (max-width: 1366px) { .knowledge-tabs { gap: 20px; padding: 0 16px; }.has-panel .knowledge-records, .has-panel .knowledge-idea-surface { flex-basis: 42%; }.knowledge-capture { margin-top: 16px; } }
</style>
