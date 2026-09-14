<template>
  <div class="page dashboard-page">
    <PageHeader
      :title="currentProject ? currentProject.name : '工作台'"
      :description="currentProject ? (currentProject.description || '集中查看这个项目的资料、活动和交付状态。') : '从项目出发，管理资料、活动、AI 协作与部署。'"
    >
      <template #actions>
        <el-button v-if="currentProject" @click="$emit('navigate', 'projects')">查看项目资料</el-button>
        <el-button v-else type="primary" @click="$emit('create-project')"><el-icon><Plus /></el-icon>创建项目</el-button>
      </template>
    </PageHeader>

    <section class="metric-strip" aria-label="项目概览">
      <div class="metric-item"><span>项目总数</span><strong>{{ state.projects.items.length }}</strong><small>{{ activeCount }} 个进行中</small></div>
      <div class="metric-item"><span>已关联目录</span><strong>{{ linkedCount }}</strong><small>可用于项目上下文</small></div>
      <button class="metric-item metric-item-action" type="button" aria-label="查看 Git 活动源列表" @click="$emit('navigate', 'activity-sources')">
        <span>Git 活动源</span><strong>{{ state.discoveredRepos.length }}</strong>
        <small v-if="state.scan.scanning">正在扫描… 已检查 {{ state.scan.scanned }} 个目录</small>
        <small v-else-if="state.scan.collecting">正在加载今日活动 {{ state.scan.collectDone }}/{{ state.scan.collectTotal }}</small>
        <small v-else>点击查看并转换为项目</small>
        <i
          v-if="state.scan.scanning || state.scan.collecting"
          class="scan-progress"
          :class="{ indeterminate: state.scan.scanning }"
          :style="!state.scan.scanning && state.scan.collectTotal ? { width: Math.min(100, Math.round((state.scan.collectDone / state.scan.collectTotal) * 100)) + '%' } : {}"
        />
      </button>
      <div class="metric-item"><span>已配置部署</span><strong>{{ deployReadyCount }}</strong><small>可直接进入发布流程</small></div>
    </section>

    <template v-if="state.projects.items.length">
      <div class="dashboard-grid">
        <section class="workspace-panel capability-panel">
          <div class="section-heading">
            <div><h2>项目能力</h2></div>
          </div>
          <div class="capability-list">
            <button class="capability-row" type="button" @click="$emit('navigate', 'chat')">
              <span class="capability-index">01</span>
              <span class="capability-copy"><strong>AI 助手</strong></span>
              <span class="capability-status">{{ aiConfigured ? state.config.ai.model : '待配置模型' }}</span>
              <el-icon><ArrowRight /></el-icon>
            </button>
            <button class="capability-row" type="button" @click="$emit('navigate', 'report')">
              <span class="capability-index">02</span>
              <span class="capability-copy"><strong>活动报告</strong></span>
              <span class="capability-status">{{ projectRepoCount }} 个关联仓库</span>
              <el-icon><ArrowRight /></el-icon>
            </button>
            <button class="capability-row" type="button" @click="$emit('navigate', 'deploy')">
              <span class="capability-index">03</span>
              <span class="capability-copy"><strong>部署</strong></span>
              <span class="capability-status">{{ currentProject && deploymentConfigured(currentProject) ? '已就绪' : '按需配置' }}</span>
              <el-icon><ArrowRight /></el-icon>
            </button>
          </div>
        </section>

        <aside class="workspace-panel focus-panel">
          <div class="section-heading"><div><h2>{{ currentProject ? '当前项目' : '项目概览' }}</h2></div></div>
          <template v-if="currentProject">
            <div class="focus-project-title">{{ currentProject.name }}</div>
            
            <dl class="focus-facts">
              <div><dt>状态</dt><dd>{{ projectStatusLabel(currentProject.status) }}</dd></div>
              <div><dt>本地目录</dt><dd :title="currentProject.localPath">{{ currentProject.localPath || '未关联' }}</dd></div>
              <div><dt>项目备注</dt><dd>{{ currentProject.notes ? '已填写' : '待补充' }}</dd></div>
            </dl>
            <el-button class="full-button" @click="$emit('navigate', 'projects')">完善项目资料</el-button>
          </template>
          <template v-else>
            <div class="project-mini-list">
              <button v-for="project in state.projects.items.slice(0, 5)" :key="project.id" type="button" @click="selectProject(project.id)">
                <span>{{ project.name }}</span><small>{{ projectStatusLabel(project.status) }}</small>
              </button>
            </div>
          </template>
        </aside>
      </div>

      <section class="workspace-panel recent-panel">
        <div class="section-heading"><div><h2>最近记录</h2></div></div>
        <div v-if="recentItems.length" class="recent-list">
          <div v-for="item in recentItems" :key="item.key" class="recent-row">
            <span class="recent-type">{{ item.type }}</span><strong>{{ item.title }}</strong><span>{{ formatRecordTime(item.time) }}</span>
          </div>
        </div>
        <p v-else class="quiet-empty">暂无记录</p>
      </section>
    </template>

    <EmptyState
      v-else icon="FolderAdd" title="先创建第一个项目"
      description="项目可以只有一个名称；Git、AI 和部署都可以稍后按需关联。"
      action="创建项目" @action="$emit('create-project')"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import { state } from '../store'
import { useProjects } from '../composables/useProjects'
import { deploymentConfigured, projectStatusLabel, reposForProject } from '../utils/project-context'

defineEmits(['navigate', 'create-project'])
const { currentProject, selectProject } = useProjects()
const reports = ref([])
const deployments = ref([])
const activeCount = computed(() => state.projects.items.filter((project) => project.status === 'active').length)
const linkedCount = computed(() => state.projects.items.filter((project) => project.localPath).length)
const deployReadyCount = computed(() => state.projects.items.filter(deploymentConfigured).length)
const aiConfigured = computed(() => !!(state.config.ai?.keyConfigured && state.config.ai?.model))
const projectRepoCount = computed(() => currentProject.value ? reposForProject(currentProject.value, state.discoveredRepos).length : state.discoveredRepos.length)
/** 时间归一化：报告历史为 "YYYY-MM-DD HH:mm:ss" 字符串，部署历史为数字时间戳，
 *  混合类型直接字符串比较会因 "1xxx…" 与 "2xxx…" 前缀导致顺序错误，统一转毫秒比较 */
function toTime(value) {
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}
const recentItems = computed(() => [
  ...reports.value.map((item) => ({ key: `r-${item.id}`, type: '报告', title: item.title, time: item.createdAt || '' })),
  ...deployments.value.map((item) => ({
    key: `d-${item.id}`,
    type: { deploy: '部署', rollback: '回滚', 'db-restore': '数据恢复' }[item.type] || '部署',
    title: `${item.projectName || '项目'} ${item.version || ''}`,
    time: item.startedAt || '',
  })),
].sort((a, b) => toTime(b.time) - toTime(a.time)).slice(0, 5))

function formatRecordTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}

onMounted(async () => {
  const [reportRows, deployRows] = await Promise.all([
    window.gitReport.listHistory().catch(() => []),
    window.gitReport.deployHistoryList().catch(() => []),
  ])
  reports.value = Array.isArray(reportRows) ? reportRows : []
  deployments.value = Array.isArray(deployRows) ? deployRows : []
})
</script>
