<template>
  <div class="page ai-page">
    <PageHeader title="AI 助手" description="让 AI 理解整个项目，再协助分析、规划和输出。">
      <template #actions>
        <el-button v-if="!configured" @click="$emit('navigate', 'settings')">配置 AI 服务</el-button>
        <el-button v-else :loading="collecting" :disabled="!currentProject || !matchedRepos.length" @click="refreshActivity">
          <el-icon><Refresh /></el-icon>刷新 Git 活动
        </el-button>
      </template>
    </PageHeader>

    <div v-if="currentProject" class="ai-workspace">
      <aside class="context-rail">
        <div class="context-project">
          
          <h2>{{ currentProject.name }}</h2>
          <p>{{ currentProject.description || '未填写项目说明' }}</p>
        </div>

        <div class="context-section-head"><span>本次上下文</span><small>按需选择</small></div>
        <label class="context-source">
          <el-checkbox v-model="sources.project" />
          <span><strong>项目资料</strong><small>{{ currentProject.notes ? '包含说明、标签和备注' : '包含说明和基础信息' }}</small></span>
        </label>
        <label class="context-source">
          <el-checkbox v-model="sources.git" />
          <span><strong>Git 活动</strong><small>{{ projectCommits.length }} 条活动 · {{ matchedRepos.length }} 个仓库</small></span>
        </label>
        <label class="context-source">
          <el-checkbox v-model="sources.reports" />
          <span><strong>报告记录</strong><small>{{ projectReports.length }} 条历史记录</small></span>
        </label>
        <label class="context-source">
          <el-checkbox v-model="sources.deploy" />
          <span><strong>部署状态</strong><small>{{ deployLabel }}</small></span>
        </label>

      </aside>

      <ChatPanel :context-text="contextText" :context-label="contextLabel" :quick-prompts="quickPrompts" />
    </div>

    <EmptyState
      v-else icon="ChatDotRound" title="先选择一个项目"
      description="AI 需要明确的项目上下文。请从顶部选择项目，或先创建项目。"
      action="前往项目" @action="$emit('navigate', 'projects')"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import PageHeader from '../components/PageHeader.vue'
import EmptyState from '../components/EmptyState.vue'
import ChatPanel from '../components/ChatPanel.vue'
import { state } from '../store'
import { useProjects } from '../composables/useProjects'
import { buildProjectContext } from '../utils/ai-context'
import { commitsForProject, deploymentConfigured, reposForProject } from '../utils/project-context'
import { collectReportData } from '../utils/report-data'
import { addDays, todayStr } from '../utils/date'

defineEmits(['navigate'])
const { currentProject } = useProjects()
const sources = reactive({ project: true, git: false, reports: false, deploy: false })
const reports = ref([])
const deployments = ref([])
const collecting = computed(() => ['scanning', 'collecting'].includes(state.report.phase))
const configured = computed(() => !!(state.config.ai?.keyConfigured && state.config.ai?.model))
const matchedRepos = computed(() => reposForProject(currentProject.value, state.discoveredRepos))
const projectCommits = computed(() => commitsForProject(currentProject.value, state.report.rawCommits))
const projectReports = computed(() => reports.value.filter((item) => !item.projectId || item.projectId === currentProject.value?.id))
const projectDeployments = computed(() => deployments.value.filter((item) => item.projectId === currentProject.value?.id))
const deployLabel = computed(() => deploymentConfigured(currentProject.value)
  ? `${currentProject.value.targets.filter((target) => target?.server?.host && target?.remotePath).length} 个环境 · ${projectDeployments.value.length} 条记录`
  : '尚未配置部署')
const selectedCount = computed(() => Object.values(sources).filter(Boolean).length)
const contextLabel = computed(() => `${currentProject.value?.name || '项目'} · ${selectedCount.value} 类上下文`)
/** Git 活动实际收集范围（rawCommits 可能来自报告页其它周期，不能硬编码） */
const gitRangeLabel = computed(() => {
  const c = state.report.collectedRange
  if (!c || !c.since) return '未收集'
  const end = c.until ? addDays(c.until, -1) : ''
  const endStr = end || c.since
  return c.since === endStr ? c.since : `${c.since} ~ ${endStr}`
})
const contextText = computed(() => currentProject.value ? buildProjectContext({
  project: currentProject.value,
  sources,
  commits: projectCommits.value,
  reports: projectReports.value,
  deployments: projectDeployments.value,
  rangeLabel: gitRangeLabel.value,
}) : '')
const quickPrompts = [
  { label: '总结项目', prompt: '请根据当前项目资料，简要总结项目目标、现状和需要关注的重点。' },
  { label: '梳理风险', prompt: '请识别当前项目的主要风险。区分已知事实与推断，并给出优先处理建议。' },
  { label: '规划下一步', prompt: '请结合当前项目上下文，整理下一步行动清单，按优先级排序。' },
  { label: '生成项目报告', prompt: '请综合当前已附带的项目上下文，生成一份简洁的项目进展报告；缺失的信息请明确标注。' },
]

async function loadHistory() {
  const [reportRows, deploymentRows] = await Promise.all([
    window.gitReport.listHistory().catch(() => []),
    window.gitReport.deployHistoryList(currentProject.value?.id).catch(() => []),
  ])
  reports.value = Array.isArray(reportRows) ? reportRows : []
  deployments.value = Array.isArray(deploymentRows) ? deploymentRows : []
}

async function refreshActivity() {
  if (!currentProject.value || !matchedRepos.value.length) return
  const until = addDays(todayStr(), 1)
  const commits = await collectReportData({ since: addDays(todayStr(), -29), until, repoPaths: matchedRepos.value.map((repo) => repo.path) })
  if (commits.length) {
    sources.git = true
    ElMessage.success(`已更新 ${commits.length} 条 Git 活动`)
  } else ElMessage.info('最近 30 天没有发现 Git 活动')
}

watch(() => currentProject.value?.id, loadHistory)
onMounted(loadHistory)
</script>
