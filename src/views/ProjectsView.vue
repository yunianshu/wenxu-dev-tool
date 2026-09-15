<template>
  <div class="page projects-page">
    <PageHeader title="项目" description="项目是资料、AI、活动报告与部署的统一入口。">
      <template #actions>
        <el-button type="primary" @click="$emit('create-project')"><el-icon><Plus /></el-icon>新建项目</el-button>
      </template>
    </PageHeader>

    <div v-if="state.projects.items.length" class="projects-layout">
      <aside class="project-list-panel">
        <div class="project-list-tools">
          <el-input v-model="query" clearable placeholder="搜索项目" :prefix-icon="Search" />
          <el-select v-model="status" aria-label="筛选状态" style="width: 132px; flex-shrink: 0">
            <el-option label="全部状态" value="" />
            <el-option label="进行中" value="active" />
            <el-option label="已暂停" value="paused" />
            <el-option label="已归档" value="archived" />
          </el-select>
        </div>
        <div class="project-list" role="list">
          <button
            v-for="project in filteredProjects" :key="project.id" type="button"
            :class="['project-list-item', { active: project.id === selected?.id }]"
            @click="selectProject(project.id)"
          >
            <span class="project-list-main"><strong>{{ project.name }}</strong><small>{{ project.description || '暂无项目说明' }}</small></span>
            <span class="project-list-meta">{{ projectStatusLabel(project.status) }}</span>
          </button>
          
        </div>
      </aside>

      <section v-if="selected" class="project-detail-panel">
        <div class="project-detail-head">
          <div>
            <div class="project-title-line"><h2>{{ selected.name }}</h2><el-tag effect="plain" size="small">{{ projectStatusLabel(selected.status) }}</el-tag></div>
            <p>{{ selected.description || '尚未填写项目说明。' }}</p>
          </div>
          <div class="detail-actions">
            <el-button @click="$emit('edit-project', selected)"><el-icon><Edit /></el-icon>编辑</el-button>
            <el-dropdown trigger="click">
              <el-button aria-label="更多操作"><el-icon><More /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu><el-dropdown-item class="danger-item" @click="confirmRemove">删除项目</el-dropdown-item></el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>

        <div v-if="selected.tags?.length" class="project-tags">
          <el-tag v-for="tag in selected.tags" :key="tag" type="info" effect="plain">{{ tag }}</el-tag>
        </div>

        <dl class="project-facts">
          <div><dt>本地目录</dt><dd :title="selected.localPath">{{ selected.localPath || '未关联目录' }}</dd></div>
          <div><dt>Git 活动源</dt><dd>{{ matchedRepos.length ? `${matchedRepos.length} 个仓库` : '未发现' }}</dd></div>
          <div><dt>部署</dt><dd>{{ deploymentConfigured(selected) ? '已配置' : '未配置' }}</dd></div>
          <div><dt>最后更新</dt><dd>{{ formatTime(selected.updatedAt) }}</dd></div>
        </dl>

        <div class="project-section">
          <div class="section-heading"><div><h3>项目备注</h3></div></div>
          <div v-if="selected.notes" class="project-notes">{{ selected.notes }}</div>
          <button v-else class="inline-empty" type="button" @click="$emit('edit-project', selected)">补充目标、约束与下一步，让 AI 更理解这个项目</button>
        </div>

        <div class="project-section">
          <div class="section-heading"><div><h3>项目能力</h3></div></div>
          <div class="project-capabilities">
            <button type="button" @click="$emit('navigate', 'chat')"><span><strong>AI 助手</strong><small>使用项目资料开展分析与规划</small></span><el-icon><ArrowRight /></el-icon></button>
            <button type="button" @click="$emit('navigate', 'report')"><span><strong>活动报告</strong><small>{{ matchedRepos.length ? '查看关联 Git 活动' : '关联目录后可采集 Git 活动' }}</small></span><el-icon><ArrowRight /></el-icon></button>
            <button type="button" @click="$emit('navigate', 'deploy')"><span><strong>部署</strong><small>{{ deploymentConfigured(selected) ? '进入发布工作区' : '需要时再配置部署' }}</small></span><el-icon><ArrowRight /></el-icon></button>
            <button type="button" :disabled="!canOpenTerminal" @click="openInWorkbench"><span><strong>终端工作台</strong><small>{{ canOpenTerminal ? '在窗格中打开该项目终端' : '关联本地目录后可用' }}</small></span><el-icon><ArrowRight /></el-icon></button>
            <button v-if="canOpenTerminal" type="button" @click="openPowerShell"><span><strong>外部 PowerShell</strong><small>另开一个独立终端窗口</small></span><el-icon><TopRight /></el-icon></button>
            <button
              type="button"
              :class="{ 'debug-off': isDebugOff }"
              :disabled="!canOpenTerminal"
              @click="onDebugCardClick"
            >
              <span>
                <strong>本地调试 <el-tag v-if="isDebugOff" size="small" effect="plain" type="info">已关闭</el-tag></strong>
                <small>{{ debugCardHint }}</small>
              </span>
              <el-icon><ArrowRight /></el-icon>
            </button>
          </div>
        </div>
      </section>
    </div>

    <EmptyState v-else icon="FolderAdd" title="还没有项目" description="创建一个项目，把资料、AI、活动与部署放在同一个上下文中。" action="新建项目" @action="$emit('create-project')" />
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { state } from '../store'
import { useProjects } from '../composables/useProjects'
import { deploymentConfigured, projectStatusLabel, reposForProject } from '../utils/project-context'

defineEmits(['navigate', 'create-project', 'edit-project'])
const query = ref('')
const status = ref('')
const { currentProject, selectProject, removeProject, saveProject } = useProjects()
const filteredProjects = computed(() => state.projects.items.filter((project) => {
  const haystack = `${project.name} ${project.description} ${(project.tags || []).join(' ')}`.toLowerCase()
  return (!query.value || haystack.includes(query.value.toLowerCase())) && (!status.value || project.status === status.value)
}))
const selected = computed(() => currentProject.value || filteredProjects.value[0] || null)
const matchedRepos = computed(() => reposForProject(selected.value, state.discoveredRepos))
const canOpenTerminal = computed(() => !!selected.value?.localPath)

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
  const name = selected.value.name
  try {
    await ElMessageBox.confirm(
      `⚠️ 危险操作检测！\n操作类型：删除项目\n影响范围：项目“${name}”及其本地管理配置\n风险评估：删除后项目不会出现在工作台；本地项目文件不会被删除。`,
      '删除项目',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' }
    )
    await removeProject(selected.value.id)
    ElMessage.success('项目已删除，本地文件未受影响')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(error?.message || '删除项目失败')
  }
}
</script>
