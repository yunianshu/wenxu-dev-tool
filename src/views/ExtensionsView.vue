<template>
  <div class="extensions-page">
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">扩展管理</h1>
        <div class="page-actions"><el-button :loading="loading" @click="loadExtensions"><el-icon><Refresh /></el-icon>刷新</el-button></div>
      </div>
    </Teleport>
    <div class="ext-platforms" role="tablist" aria-label="扩展平台">
      <button v-for="platform in platforms" :key="platform.id" type="button" role="tab" :aria-selected="selected?.platformId === platform.id" :class="{ active: selected?.platformId === platform.id }" @click="selectPlatform(platform.id)">{{ platform.name }}</button>
    </div>
    <div class="ext-type-tabs" role="tablist" aria-label="扩展类型">
      <button v-for="type in [{ id: 'skills', label: '技能' }, { id: 'plugins', label: '插件' }]" :key="type.id" type="button" role="tab" :aria-selected="selected?.type === type.id" :class="{ active: selected?.type === type.id }" @click="selectType(type.id)">{{ type.label }}<span>{{ currentPlatform?.[type.id]?.length || 0 }}</span></button>
    </div>
    <div class="extensions-toolbar">
      <el-input v-model="search" clearable :placeholder="selected?.type === 'plugins' ? '搜索插件' : '搜索技能'" aria-label="搜索扩展" class="ext-search"><template #prefix><el-icon><Search /></el-icon></template></el-input>
      <el-select v-model="statusFilter" aria-label="扩展状态" class="ext-status-filter"><el-option label="全部状态" value="all" /><el-option label="已启用" value="enabled" /><el-option label="已停用" value="disabled" /><el-option label="异常" value="error" /></el-select>
      <el-button text :disabled="!currentPlatform?.dir" @click="openPlatformDir"><el-icon><FolderOpened /></el-icon>打开目录</el-button>
    </div>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <el-alert v-else-if="currentPlatform?.error" :title="currentPlatform.error" type="error" :closable="false" show-icon />
    <el-alert v-else-if="currentPlatform && !currentPlatform.installed" :title="'未检测到 ' + currentPlatform.name + ' 的配置目录：' + currentPlatform.dir" type="warning" :closable="false" show-icon />
    <el-alert v-else-if="selected?.type === 'plugins' && currentPlatform && !currentPlatform.pluginsSupported" :title="currentPlatform.pluginNote || '该平台暂不支持插件'" type="info" :closable="false" show-icon />
    <div class="ext-table-wrap" v-loading="loading">
      <el-table ref="tableRef" :data="pagedRows" height="100%" highlight-current-row :row-key="row => row.id || row.name" @current-change="currentRow = $event" @row-dblclick="inspectRow" @row-contextmenu="openContext" @sort-change="changeSort">
        <template #empty><div class="ext-empty"><el-icon><Grid /></el-icon><strong>{{ search || statusFilter !== 'all' ? '没有匹配的扩展' : '暂无' + (selected?.type === 'plugins' ? '插件' : '技能') }}</strong><span>{{ search || statusFilter !== 'all' ? '调整搜索关键词或筛选条件' : '在对应平台安装后，点击刷新重新读取' }}</span></div></template>
        <el-table-column :label="selected?.type === 'plugins' ? '插件名称' : '技能名称'" prop="name" sortable="custom" min-width="200" show-overflow-tooltip />
        <el-table-column label="用途" min-width="320" show-overflow-tooltip><template #default="{row}">{{ row.description || (row.version ? '版本 ' + row.version : '—') }}</template></el-table-column>
        <el-table-column label="来源" width="140" show-overflow-tooltip><template #default="{row}">{{ row.marketplace || (row.linkTarget ? '符号链接' : '本地' + (selected?.type === 'plugins' ? '插件' : '技能')) }}</template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="{row}"><span :class="{ 'ext-row-error': row.linkBroken || (selected?.type === 'skills' && !row.hasSkillMd) }">{{ rowStatus(row) }}</span></template></el-table-column>
        <el-table-column label="操作" width="112" fixed="right"><template #default="{row}"><el-dropdown trigger="click" @command="command => runCommand(command, row)"><el-button text size="small" :aria-label="'操作 ' + row.name"><el-icon><MoreFilled /></el-icon></el-button><template #dropdown><el-dropdown-menu><el-dropdown-item v-if="selected?.type === 'skills'" command="inspect" :disabled="!row.hasSkillMd">查看 SKILL.md</el-dropdown-item><el-dropdown-item command="open">打开目录</el-dropdown-item><el-dropdown-item command="toggle" :disabled="row.busy || !canToggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown></template></el-table-column>
      </el-table>
    </div>
    <div v-if="currentRow" class="ext-selection-bar">
      <strong>{{ currentRow.name }}</strong><span v-if="currentRow.linkTarget" :title="currentRow.linkTarget">链接到 {{ currentRow.linkTarget }}</span>
      <div class="ext-selection-actions"><el-button v-if="selected?.type === 'skills'" :disabled="!currentRow.hasSkillMd" @click="showSkillDoc(currentRow)"><el-icon><Document /></el-icon>查看 SKILL.md</el-button><el-button :loading="currentRow.busy" :disabled="!canToggle(currentRow)" @click="runCommand('toggle', currentRow)">{{ currentRow.enabled ? '停用' : '启用' }}</el-button></div>
    </div>
    <div class="ext-footer"><span>共 {{ filteredRows.length }} 项 · 已启用 {{ enabledCount }} 项</span><el-pagination v-model:current-page="page" :page-size="pageSize" :total="filteredRows.length" layout="prev, pager, next" :hide-on-single-page="true" small /></div>
    <Teleport to="body"><div v-if="contextMenu" class="ext-context-menu" role="menu" :style="{left: contextMenu.x + 'px', top: contextMenu.y + 'px'}" @click.stop><button v-if="selected?.type === 'skills'" role="menuitem" :disabled="!contextMenu.row.hasSkillMd" @click="contextCommand('inspect')">查看 SKILL.md</button><button role="menuitem" @click="contextCommand('open')">打开目录</button><button role="menuitem" :disabled="contextMenu.row.busy || !canToggle(contextMenu.row)" @click="contextCommand('toggle')">{{ contextMenu.row.enabled ? '停用' : '启用' }}</button></div></Teleport>
    <el-drawer v-model="docVisible" :title="docTitle" size="560px"><pre class="skill-doc">{{ docContent }}</pre></el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useTopbarReady } from '../composables/useTopbarReady'

const loading = ref(false)
const platforms = ref([])
const topbarReady = useTopbarReady()
const selected = ref(null) // { platformId, type: 'skills'|'plugins' }
const docVisible = ref(false)
const docTitle = ref('')
const docContent = ref('')

const currentPlatform = computed(() => platforms.value.find((p) => p.id === selected.value?.platformId) || null)
const rows = computed(() => {
  if (!selected.value || !currentPlatform.value) return []
  return selected.value.type === 'skills' ? currentPlatform.value.skills : currentPlatform.value.plugins
})
const enabledCount = computed(() => rows.value.filter((r) => r.enabled).length)
const search = ref('')
const statusFilter = ref('all')
const sortOrder = ref('ascending')
const page = ref(1)
const pageSize = 25
const currentRow = ref(null)
const tableRef = ref(null)
const loadError = ref('')
const contextMenu = ref(null)
const filteredRows = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return rows.value.filter(row => {
    const matchesQuery = !query || [row.name, row.description, row.marketplace].some(value => String(value || '').toLocaleLowerCase().includes(query))
    const invalid = !!row.linkBroken || (selected.value?.type === 'skills' && !row.hasSkillMd)
    return matchesQuery && (statusFilter.value === 'all' || (statusFilter.value === 'error' ? invalid : statusFilter.value === 'enabled' ? row.enabled : !row.enabled))
  }).sort((a,b) => sortOrder.value ? String(a.name).localeCompare(String(b.name), 'zh-CN') * (sortOrder.value === 'descending' ? -1 : 1) : 0)
})
const pagedRows = computed(() => filteredRows.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([search, statusFilter, () => selected.value?.platformId, () => selected.value?.type], () => { page.value = 1; currentRow.value = null; contextMenu.value = null })
watch(filteredRows, value => { page.value = Math.min(page.value, Math.max(1, Math.ceil(value.length / pageSize))); currentRow.value = value.find(row => (row.id || row.name) === (currentRow.value?.id || currentRow.value?.name)) || null })
function selectPlatform(id) { selected.value = { platformId: id, type: selected.value?.type || 'skills' } }
function selectType(type) { if (selected.value) selected.value = { ...selected.value, type } }
function changeSort({order}) { sortOrder.value = order; page.value = 1 }
function rowStatus(row) { return row.linkBroken ? '链接失效' : selected.value?.type === 'skills' && !row.hasSkillMd ? '缺少 SKILL.md' : row.enabled ? '已启用' : '已停用' }
function canToggle(row) { return selected.value?.type === 'plugins' || row.hasSkillMd || row.linkBroken }
function inspectRow(row) { if (selected.value?.type === 'skills' && row.hasSkillMd) showSkillDoc(row) }
function runCommand(command, row) {
  if (command === 'inspect') inspectRow(row)
  if (command === 'open') openPath(row.dir || row.installPath)
  if (command === 'toggle' && canToggle(row)) selected.value?.type === 'skills' ? toggleSkill(row, !row.enabled) : togglePlugin(row, !row.enabled)
}
function openContext(row, column, event) { event.preventDefault(); tableRef.value?.setCurrentRow(row); contextMenu.value = { row, x: Math.min(event.clientX, window.innerWidth - 180), y: Math.min(event.clientY, window.innerHeight - 120) } }
function contextCommand(command) { const row = contextMenu.value?.row; contextMenu.value = null; if (row) runCommand(command, row) }
function closeContext(event) { if (event.type !== 'keydown' || event.key === 'Escape') contextMenu.value = null }

async function loadExtensions() {
  loading.value = true
  loadError.value = ''
  try {
    const result = await window.gitReport.extensionsList()
    // 整表替换并补齐本地交互字段；selected 仅存 id，刷新后自动对回同一详情页
    platforms.value = (result?.platforms || []).map((p) => ({
      ...p,
      skills: (p.skills || []).map((s) => ({ ...s, busy: false })),
      plugins: (p.plugins || []).map((x) => ({ ...x, busy: false })),
    }))
    if (!platforms.value.some(platform => platform.id === selected.value?.platformId)) selected.value = platforms.value.length ? { platformId: platforms.value[0].id, type: 'skills' } : null
  } catch (error) {
    loadError.value = error?.message || '读取扩展列表失败'
  } finally {
    loading.value = false
  }
}

async function toggleSkill(row, enable) {
  row.busy = true
  try {
    const r = await window.gitReport.extensionsToggleSkill(selected.value.platformId, row.name, enable)
    if (!r?.ok) throw new Error(r?.error || '操作失败')
    await loadExtensions()
    ElMessage.success(`技能「${row.name}」已${enable ? '启用' : '禁用'}`)
  } catch (error) {
    ElMessage.error(error?.message || `技能「${row.name}」${enable ? '启用' : '禁用'}失败`)
  } finally {
    row.busy = false
  }
}

async function togglePlugin(row, enable) {
  row.busy = true
  try {
    const r = await window.gitReport.extensionsTogglePlugin(selected.value.platformId, row.id, enable)
    if (!r?.ok) throw new Error(r?.error || '操作失败')
    await loadExtensions()
    ElMessage.success(`插件「${row.name}」已${enable ? '启用' : '禁用'}`)
  } catch (error) {
    ElMessage.error(error?.message || `插件「${row.name}」${enable ? '启用' : '禁用'}失败`)
  } finally {
    row.busy = false
  }
}

async function showSkillDoc(row) {
  try {
    const r = await window.gitReport.extensionsReadSkill(selected.value.platformId, row.name)
    if (!r?.ok) throw new Error(r?.error || '读取失败')
    docTitle.value = `${row.name} · SKILL.md`
    docContent.value = r.hasSkillMd ? r.content : '（该技能目录缺少 SKILL.md）'
    docVisible.value = true
  } catch (error) {
    ElMessage.error(error?.message || '读取技能文档失败')
  }
}

function openPlatformDir() {
  if (currentPlatform.value) openPath(currentPlatform.value.dir)
}

async function openPath(p) {
  if (!p) return
  try {
    const r = await window.gitReport.openPath(p)
    if (r && r.ok === false) ElMessage.warning(`路径不存在：${p}`)
  } catch {
    ElMessage.warning(`路径不存在：${p}`)
  }
}

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { hour12: false })
}

onMounted(() => { loadExtensions(); window.addEventListener('click', closeContext); window.addEventListener('keydown', closeContext) })
onBeforeUnmount(() => { window.removeEventListener('click', closeContext); window.removeEventListener('keydown', closeContext) })
</script>

<style scoped>
.extensions-page { height: 100%; min-height: 0; display: flex; flex-direction: column; padding: 0 var(--page-gutter); }
.ext-platforms { display: flex; gap: 12px; min-height: 64px; align-items: center; }
.ext-platforms button { height: 32px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink-soft); padding: 0 12px; cursor: pointer; font-size: 12px; }
.ext-platforms button:hover { background: var(--surface-subtle); }
.ext-platforms button.active { background: var(--accent-soft); border-color: var(--accent-soft); color: var(--accent-strong); }
.ext-type-tabs { display: flex; gap: 24px; height: 44px; flex-shrink: 0; border-bottom: 1px solid var(--line); }
.ext-type-tabs button { background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 0; color: var(--text-muted); font-size: 13px; cursor: pointer; }
.ext-type-tabs button.active { color: var(--accent-strong); border-bottom-color: var(--accent-strong); }
.ext-type-tabs span { margin-left: 8px; font-size: 11px; color: var(--text-muted); }
.extensions-toolbar { display: flex; align-items: center; gap: 8px; min-height: 56px; }
.ext-search { width: 280px; }
.ext-status-filter { width: 140px; }
.extensions-toolbar > .el-button { margin-left: auto; }
.ext-table-wrap { min-height: 200px; flex: 1; }
.ext-row-error { color: var(--danger); }
.ext-selection-bar { min-height: 56px; display: flex; align-items: center; gap: 16px; border-top: 1px solid var(--line); font-size: 13px; }
.ext-selection-bar > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; color: var(--text-muted); font-size: 12px; }
.ext-selection-actions { margin-left: auto; display: flex; gap: 8px; flex-shrink: 0; }
.ext-selection-actions .el-button + .el-button { margin: 0; }
.ext-footer { min-height: 40px; display: flex; justify-content: space-between; align-items: center; color: var(--text-muted); font-size: 11px; }
.ext-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 64px 16px; line-height: 1.5; }
.ext-empty .el-icon { font-size: 24px; }
.ext-empty strong { font-size: 14px; font-weight: 500; }
.ext-empty span { font-size: 12px; }
.skill-doc { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 var(--el-font-family); color: var(--ink-soft); }
.ext-context-menu { position: fixed; z-index: 3000; padding: 4px; width: 172px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; box-shadow: var(--shadow-float); }
.ext-context-menu button { display: block; width: 100%; height: 32px; padding: 0 12px; text-align: left; background: transparent; border: 0; border-radius: 4px; color: var(--ink-soft); font-size: 13px; cursor: pointer; }
.ext-context-menu button:hover:not(:disabled) { background: var(--surface-subtle); }
.ext-context-menu button:disabled { color: var(--text-disabled); cursor: default; }
</style>
