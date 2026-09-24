<template>
  <div class="page projects-page">
    <!-- 页头上提到应用顶栏（本页自带项目列表，不再需要顶栏那份额外的项目切换器） -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">项目</h1>
        <span class="projects-total">{{ state.projects.items.length }} 个项目</span>
        <el-button class="projects-create" type="primary" @click="$emit('create-project')"><el-icon><Plus /></el-icon>新建项目</el-button>
      </div>
    </Teleport>

    <div v-if="state.projects.items.length" class="projects-layout">
      <aside class="project-list-panel">
        <div class="project-list-tools">
          <el-input v-model="query" clearable placeholder="搜索项目" aria-label="搜索项目" :prefix-icon="Search" />
          <div class="project-list-filters">
            <el-select v-model="status" :empty-values="[null, undefined]" aria-label="筛选项目状态" class="project-status-filter">
              <el-option label="全部项目" value="" />
              <el-option label="进行中" value="active" />
              <el-option label="已暂停" value="paused" />
              <el-option label="已归档" value="archived" />
            </el-select>
            <el-dropdown trigger="click" @command="sortBy = $event">
              <el-button text aria-label="项目排序" title="项目排序"><el-icon><Sort /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="default" :disabled="sortBy === 'default'">默认顺序</el-dropdown-item>
                  <el-dropdown-item command="name" :disabled="sortBy === 'name'">按项目名称</el-dropdown-item>
                  <el-dropdown-item command="updated" :disabled="sortBy === 'updated'">最近更新优先</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
        <div ref="projectList" class="project-list" role="listbox" aria-label="项目列表" @keydown="onListKeydown">
          <button
            v-for="project in filteredProjects" :key="project.id" type="button"
            role="option" :aria-selected="project.id === selected?.id"
            :tabindex="project.id === selected?.id || (!filteredProjects.some(item => item.id === selected?.id) && project.id === filteredProjects[0]?.id) ? 0 : -1"
            :class="['project-list-item', { active: project.id === selected?.id }]"
            @click="selectProject(project.id)"
            @dblclick="$emit('edit-project', project)"
            @contextmenu.prevent="openContextMenu($event, project)"
            @keydown.shift.f10.prevent="openContextMenu($event, project)"
          >
            <el-icon class="project-folder"><Folder /></el-icon>
            <span class="project-list-main"><strong>{{ project.name }}</strong><small>{{ project.description || '暂无项目说明' }}</small></span>
            <el-icon v-if="project.id === selected?.id" class="project-selected-arrow"><ArrowRight /></el-icon>
            <span v-else-if="project.status !== 'active'" class="project-list-meta">{{ projectStatusLabel(project.status) }}</span>
          </button>
          <div v-if="!filteredProjects.length" class="project-search-empty">
            <span>没有匹配的项目</span>
            <el-button text @click="query = ''; status = ''">清除筛选</el-button>
          </div>
        </div>
        <div class="project-list-footer">{{ filteredProjects.length }} 个项目<span v-if="status"> · {{ projectStatusLabel(status) }}</span></div>
      </aside>

      <section v-if="selected" class="project-detail-panel">
        <div class="project-detail-head">
          <div>
            <div class="project-title-line"><h2>{{ selected.name }}</h2><span class="project-status" :class="{ 'is-active': selected.status === 'active' }"><i />{{ projectStatusLabel(selected.status) }}</span></div>
            <p>{{ selected.description || '尚未填写项目说明。' }}</p>
          </div>
          <div class="detail-actions">
            <el-button @click="$emit('edit-project', selected)"><el-icon><Edit /></el-icon>编辑</el-button>
            <el-dropdown trigger="click">
              <el-button text aria-label="更多项目操作"><el-icon><More /></el-icon>更多</el-button>
              <template #dropdown>
                <el-dropdown-menu><el-dropdown-item class="danger-item" @click="confirmRemove">删除项目</el-dropdown-item></el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>

        <div v-if="selected.tags?.length" class="project-tags">
          <el-tag v-for="tag in selected.tags" :key="tag" type="info" effect="plain">{{ tag }}</el-tag>
        </div>

        <div class="project-quick-actions">
          <el-button :disabled="!canOpenTerminal" @click="openInWorkbench"><el-icon><Monitor /></el-icon>打开终端</el-button>
          <el-button :disabled="!canOpenTerminal" @click="openProjectPath"><el-icon><FolderOpened /></el-icon>打开目录</el-button>
          <el-button text :disabled="!canOpenTerminal" :title="debugCardHint" @click="onDebugCardClick"><el-icon><VideoPlay /></el-icon>本地调试<span v-if="isDebugOff" class="debug-status">已关闭</span></el-button>
          <el-button text :disabled="!canOpenTerminal" @click="openPowerShell"><el-icon><TopRight /></el-icon>外部 PowerShell</el-button>
        </div>

        <el-tabs v-model="detailTab" class="project-detail-tabs">
          <el-tab-pane label="概览" name="overview">
        <dl class="project-facts">
          <div><dt>本地目录</dt><dd :title="selected.localPath">{{ selected.localPath || '未关联目录' }}</dd><el-icon><FolderOpened /></el-icon></div>
          <div><dt>Git 活动源</dt><dd>{{ matchedRepos.length ? `${matchedRepos.length} 个仓库` : '未发现' }}</dd><el-icon><Connection /></el-icon></div>
          <div><dt>部署</dt><dd>{{ deploymentConfigured(selected) ? '已配置' : '未配置' }}</dd><el-icon><SetUp /></el-icon></div>
          <div><dt>最后更新</dt><dd>{{ formatTime(selected.updatedAt) }}</dd><el-icon><Clock /></el-icon></div>
        </dl>

        <div class="project-section">
          <div class="section-heading"><div><h3>项目备注</h3></div></div>
          <div v-if="selected.notes" class="project-notes">{{ selected.notes }}</div>
          <button v-else class="inline-empty" type="button" @click="$emit('edit-project', selected)"><span>补充目标、约束与下一步</span><span class="add-note"><el-icon><Plus /></el-icon>添加备注</span></button>
        </div>

        <div class="project-section">
          <div class="section-heading"><div><h3>项目能力</h3></div></div>
          <div class="project-capabilities">
            <button type="button" @click="$emit('navigate', 'chat')"><el-icon><ChatDotRound /></el-icon><span><strong>AI 助手</strong><small>基于项目资料开展分析</small></span><el-icon><TopRight /></el-icon></button>
            <button type="button" @click="$emit('navigate', 'report')"><el-icon><DataAnalysis /></el-icon><span><strong>活动报告</strong><small>查看全部项目的 Git 活动</small></span><el-icon><TopRight /></el-icon></button>
            <button type="button" @click="$emit('navigate', 'deploy')"><el-icon><Promotion /></el-icon><span><strong>部署</strong><small>{{ deploymentConfigured(selected) ? `进入 ${selected.name} 发布工作区` : '需要时再配置部署' }}</small></span><el-icon><TopRight /></el-icon></button>
          </div>
        </div>
          </el-tab-pane>
          <el-tab-pane :label="`Git 活动源 (${matchedRepos.length})`" name="sources">
            <div class="project-sources-heading"><span>关联本地目录发现的仓库</span><el-button text @click="$emit('navigate', 'activity-sources')">管理活动源<el-icon><TopRight /></el-icon></el-button></div>
            <el-table :data="matchedRepos" empty-text="未发现关联仓库，可到设置中检查扫描根目录" class="project-source-table">
              <el-table-column label="活动源" min-width="160" show-overflow-tooltip><template #default="{ row }">{{ row.shortName || row.path }}</template></el-table-column>
              <el-table-column prop="path" label="本地路径" min-width="200" show-overflow-tooltip />
              <el-table-column label="分支" width="100"><template #default="{ row }">{{ row.info?.branch || '—' }}</template></el-table-column>
              <el-table-column width="56"><template #default="{ row }"><el-button text title="打开目录" aria-label="打开仓库目录" @click="openProjectPath(row.path)"><el-icon><FolderOpened /></el-icon></el-button></template></el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </section>
    </div>

    <EmptyState v-else icon="FolderAdd" title="还没有项目" description="创建一个项目，把资料、AI、活动与部署放在同一个上下文中。" action="新建项目" @action="$emit('create-project')" />
    <Teleport to="body">
      <div v-if="contextMenu.visible" ref="contextMenuElement" class="project-context-menu" role="menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @keydown.esc.stop="closeContextMenu" @keydown="onContextKeydown">
        <button role="menuitem" @click="runContextAction('edit')"><el-icon><Edit /></el-icon>编辑项目</button>
        <button role="menuitem" :disabled="!canOpenTerminal" @click="runContextAction('terminal')"><el-icon><Monitor /></el-icon>打开终端</button>
        <button role="menuitem" :disabled="!canOpenTerminal" @click="runContextAction('directory')"><el-icon><FolderOpened /></el-icon>打开目录</button>
        <button class="context-danger" role="menuitem" @click="runContextAction('remove')"><el-icon><Delete /></el-icon>删除项目</button>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import EmptyState from '../components/EmptyState.vue'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { useProjects } from '../composables/useProjects'
import { deploymentConfigured, projectStatusLabel, reposForProject } from '../utils/project-context'

const emit = defineEmits(['navigate', 'create-project', 'edit-project'])
const query = ref('')
const status = ref('')
const sortBy = ref('default')
const detailTab = ref('overview')
const projectList = ref(null)
const contextMenuElement = ref(null)
const contextMenu = reactive({ visible: false, x: 0, y: 0 })
const { currentProject, selectProject, removeProject, saveProject } = useProjects()
/** 顶栏是否在位（沉浸全屏时整个顶栏被卸载，此时不投递页头） */
const topbarReady = useTopbarReady()
const filteredProjects = computed(() => {
  const rows = state.projects.items.filter((project) => {
  const haystack = `${project.name} ${project.description} ${(project.tags || []).join(' ')}`.toLowerCase()
  return (!query.value || haystack.includes(query.value.toLowerCase())) && (!status.value || project.status === status.value)
  })
  if (sortBy.value === 'name') rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  if (sortBy.value === 'updated') rows.sort((a, b) => (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0))
  return rows
})
const selected = computed(() => currentProject.value || filteredProjects.value[0] || null)
const matchedRepos = computed(() => reposForProject(selected.value, state.discoveredRepos))
const canOpenTerminal = computed(() => !!selected.value?.localPath)

function onListKeydown(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !filteredProjects.value.length) return
  event.preventDefault()
  const rows = filteredProjects.value
  const current = rows.findIndex(project => project.id === selected.value?.id)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
  selectProject(rows[index].id)
  nextTick(() => projectList.value?.querySelectorAll('[role="option"]')[index]?.focus())
}

async function openProjectPath(path) {
  const target = typeof path === 'string' ? path : selected.value?.localPath
  if (!target) return
  try {
    const result = await window.gitReport.openPath(target)
    if (!result?.ok) ElMessage.error('目录不存在或无法打开')
  } catch (error) { ElMessage.error(error?.message || '打开目录失败') }
}

function openContextMenu(event, project) {
  selectProject(project.id)
  const bounds = event.currentTarget.getBoundingClientRect()
  contextMenu.x = Math.max(8, Math.min(event.clientX || bounds.left + 24, window.innerWidth - 192))
  contextMenu.y = Math.max(8, Math.min(event.clientY || bounds.bottom, window.innerHeight - 160))
  contextMenu.visible = true
  nextTick(() => contextMenuElement.value?.querySelector('button')?.focus())
}
function closeContextMenu(event) {
  contextMenu.visible = false
  if (event?.key === 'Escape') nextTick(() => projectList.value?.querySelector('[aria-selected="true"]')?.focus())
}
function dismissContextMenu(event) {
  if (!contextMenuElement.value?.contains(event.target)) closeContextMenu()
}
function onContextKeydown(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...contextMenuElement.value.querySelectorAll('button:not(:disabled)')]
  const index = buttons.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
function runContextAction(action) {
  closeContextMenu()
  if (action === 'edit') emit('edit-project', selected.value)
  if (action === 'terminal') openInWorkbench()
  if (action === 'directory') openProjectPath()
  if (action === 'remove') confirmRemove()
}
onMounted(() => { if (typeof document !== 'undefined') document.addEventListener('pointerdown', dismissContextMenu) })
onBeforeUnmount(() => { if (typeof document !== 'undefined') document.removeEventListener('pointerdown', dismissContextMenu) })

/** 在终端工作台的分屏窗格中打开该项目（切到工作台视图并聚焦对应窗格） */
function openInWorkbench() {
  const project = selected.value
  if (!project?.localPath) {
    ElMessage.warning('请先在编辑中关联本地目录')
    return
  }
  state.terminal.pendingFocusProjectId = project.id
  emit('navigate', 'terminal')
}

async function openPowerShell() {
  const dir = selected.value?.localPath
  if (!dir) {
    ElMessage.warning('请先在编辑中关联本地目录')
    return
  }
  const r = await window.gitReport.openTerminal(dir)
  if (!r?.ok) ElMessage.error(r?.error || '打开终端失败')
}

// ─── 本地调试（项目根目录 start.bat） ───
const hasStartBat = ref(false)
const isDebugOff = computed(() => selected.value?.debugMode === 'off')
const debugCardHint = computed(() => {
  if (!selected.value?.localPath) return '关联本地目录后可用'
  if (isDebugOff.value) return '点击重新开启'
  return hasStartBat.value ? '运行项目根目录的 start.bat' : '未找到 start.bat，点击生成模板'
})

watch(
  () => [selected.value?.id, selected.value?.localPath],
  async () => {
    hasStartBat.value = false
    const current = selected.value
    const dir = current?.localPath
    if (!dir) return
    try {
      const r = await window.gitReport.debugStatus(dir)
      // 异步竞态防护：晚到的旧项目结果不得覆盖当前项目的探测状态
      if (selected.value?.id !== current.id) return
      hasStartBat.value = !!(r && r.hasStartBat)
    } catch { /* 探测失败按未找到处理 */ }
  },
  { immediate: true }
)

/** 持久化本地调试开关 */
async function saveDebugMode(mode) {
  const project = selected.value
  if (!project) return
  try {
    await saveProject({ ...project, debugMode: mode })
  } catch (error) {
    ElMessage.error(error?.message || '保存项目失败')
  }
}

async function onDebugCardClick() {
  const project = selected.value
  const dir = project?.localPath
  if (!dir) {
    ElMessage.warning('请先在编辑中关联本地目录')
    return
  }
  if (isDebugOff.value) {
    await saveDebugMode('bat')
    ElMessage.success('已重新开启本地调试')
    return
  }
  let st = { hasStartBat: false }
  try {
    st = await window.gitReport.debugStatus(dir) || st
  } catch { /* 按未找到处理 */ }
  if (st.hasStartBat) {
    const r = await window.gitReport.debugRun(dir)
    if (r?.ok) ElMessage.success('已在项目目录启动 start.bat')
    else ElMessage.error(r?.error || '运行 start.bat 失败')
    return
  }
  try {
    await ElMessageBox.confirm(
      '项目目录未找到 start.bat。是否生成模板文件？生成后可编辑为项目实际的启动命令。',
      '本地调试',
      { distinguishCancelAndClose: true, confirmButtonText: '生成 start.bat', cancelButtonText: '本项目不需要', type: 'info' }
    )
    const g = await window.gitReport.debugGenerate(dir)
    if (g?.ok) {
      hasStartBat.value = true
      ElMessage.success('已生成 start.bat，编辑为实际启动命令后即可一键运行')
    } else {
      ElMessage.error(g?.error || '生成 start.bat 失败')
    }
  } catch (action) {
    if (action === 'cancel') {
      await saveDebugMode('off')
      ElMessage.success('已关闭本项目的本地调试，点击卡片可重新开启')
    }
    // close（右上角 ×）不做任何事
  }
}

function formatTime(timestamp) {
  if (!timestamp) return '—'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

async function confirmRemove() {
  if (!selected.value) return
  const { id, name } = selected.value
  try {
    await ElMessageBox.confirm(
      `删除项目“${name}”及其本地管理配置？本地项目文件会保留。`,
      '删除项目',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' }
    )
    await removeProject(id)
    ElMessage.success('项目已删除，本地文件未受影响')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除项目失败')
  }
}
</script>

<style scoped>
.projects-page { height: 100%; min-height: 0; overflow: hidden; color: var(--brand-text); }
.projects-total { font-size: 12px; color: var(--text-muted); }
.projects-create { margin-left: auto; }
.projects-layout { height: 100%; min-height: 0; display: grid; grid-template-columns: 280px minmax(0, 1fr); border: 0; border-radius: 0; background: var(--surface); }
.project-list-panel { display: flex; flex-direction: column; min-height: 0; background: var(--surface); border-right: 1px solid var(--line); }
.project-list-tools { display: flex; flex-direction: column; gap: 8px; padding: 12px 16px 8px; border: 0; }
.project-list-filters { display: flex; justify-content: space-between; align-items: center; height: 36px; }
.project-status-filter { width: 132px; }
.project-status-filter :deep(.el-select__wrapper) { padding-left: 0; background: transparent; box-shadow: none; }
.project-list { flex: 1; min-height: 0; max-height: none; overflow: auto; padding: 0; }
.project-list-item { width: 100%; height: 56px; min-height: 56px; padding: 8px 16px; display: flex; align-items: center; gap: 12px; border: 0; border-radius: 0; background: transparent; color: var(--brand-text); font: inherit; text-align: left; cursor: pointer; }
.project-list-item:hover { background: var(--surface-subtle); }
.project-list-item.active { background: var(--accent-soft); }
.project-list-item:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.project-folder { color: var(--text-muted); font-size: 16px; flex-shrink: 0; }
.project-list-main { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 4px; }
.project-list-main strong { overflow: hidden; color: var(--brand-text); font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.project-list-main small { color: var(--text-muted); font-size: 11px; line-height: 16px; }
.active .project-folder, .active .project-list-main strong, .project-selected-arrow { color: var(--accent-strong); }
.project-selected-arrow { font-size: 12px; }
.project-list-meta { max-width: 48px; color: var(--text-muted); font-size: 11px; }
.project-list-footer { flex-shrink: 0; min-height: 32px; padding: 8px 16px; color: var(--text-muted); font-size: 11px; }
.project-search-empty { padding: 24px 16px; display: grid; gap: 8px; text-align: center; color: var(--text-muted); }
.project-detail-panel { min-width: 0; min-height: 0; padding: 24px; overflow: auto; }
.project-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.project-title-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.project-title-line h2 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 600; color: var(--brand-text); overflow-wrap: anywhere; }
.project-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.project-status i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.project-status.is-active { color: var(--accent-strong); }
.project-detail-head p { margin: 8px 0 0; color: var(--text-muted); font-size: 13px; line-height: 20px; }
.detail-actions { display: flex; gap: 8px; flex-shrink: 0; }
.project-tags { margin-top: 12px; gap: 8px; }
.project-quick-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 24px 0 12px; }
.project-quick-actions .el-button + .el-button { margin-left: 0; }
.debug-status { margin-left: 4px; font-size: 11px; color: var(--text-muted); }
.project-detail-tabs :deep(.el-tabs__header) { margin-bottom: 0; }
.project-detail-tabs :deep(.el-tabs__item) { height: 44px; font-size: 13px; }
.project-detail-tabs :deep(.el-tabs__nav-wrap::after) { height: 1px; background: var(--line); }
.project-facts { display: block; margin: 0; border: 0; }
.project-facts > div { min-width: 0; min-height: 40px; padding: 0; display: grid; grid-template-columns: 120px minmax(0, 1fr) 20px; align-items: center; gap: 0; border: 0; border-bottom: 1px solid var(--line); }
.project-facts dt { margin: 0; color: var(--text-muted); font-size: 12px; }
.project-facts dd { margin: 0; color: var(--brand-text); font-size: 13px; }
.project-facts .el-icon { font-size: 16px; color: var(--text-muted); }
.project-section { margin-top: 24px; }
.project-section .section-heading { margin: 0 0 12px; padding: 0; border: 0; }
.project-section .section-heading h3 { font-size: 14px; line-height: 20px; color: var(--brand-text); }
.project-notes { min-height: 56px; padding: 12px 16px; color: var(--brand-text); font-size: 13px; background: var(--surface-subtle); border-radius: 6px; line-height: 1.7; overflow-wrap: anywhere; }
.inline-empty { min-height: 56px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border: 0; border-radius: 6px; background: var(--brand-bg); color: var(--text-muted); font: inherit; font-size: 12px; text-align: left; }
.inline-empty:hover { background: var(--surface-subtle); }
.add-note { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; color: var(--brand-text); }
.project-capabilities { display: flex; flex-direction: column; gap: 0; }
.project-capabilities button { min-height: 40px; padding: 8px 0; display: flex; align-items: center; gap: 8px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; color: var(--brand-text); background: transparent; font: inherit; }
.project-capabilities button:hover { background: var(--surface-subtle); border-color: var(--line); }
.project-capabilities button > .el-icon { font-size: 16px; color: var(--text-muted); }
.project-capabilities button > .el-icon:last-child { margin-left: auto; }
.project-capabilities span { flex: 1; display: flex; flex-direction: row; align-items: center; gap: 8px; }
.project-capabilities strong { font-size: 13px; font-weight: 500; white-space: nowrap; }
.project-capabilities small { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-sources-heading { min-height: 56px; display: flex; align-items: center; justify-content: space-between; color: var(--text-muted); font-size: 12px; }
.project-source-table :deep(.el-table__row) { height: 40px; }
.project-context-menu { position: fixed; z-index: 2100; width: 184px; padding: 4px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); }
.project-context-menu button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 4px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--brand-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.project-context-menu button:hover, .project-context-menu button:focus-visible { outline: 0; background: var(--surface-subtle); }
.project-context-menu button:disabled { opacity: .45; cursor: not-allowed; }
.project-context-menu .context-danger { margin-top: 4px; border-top: 1px solid var(--line); border-radius: 0; color: var(--danger); }
@media (max-width: 1280px) {
  .projects-layout { grid-template-columns: 256px minmax(0, 1fr); }
  .project-list-item { height: 44px; min-height: 44px; padding-block: 4px; }
  .project-list-main { gap: 0; }
  .project-detail-panel { padding: 16px; }
  .project-quick-actions { margin-top: 16px; }
  .project-section { margin-top: 16px; }
}
</style>
