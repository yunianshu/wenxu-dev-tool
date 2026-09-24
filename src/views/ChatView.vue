<template>
  <div class="page ai-page">
    <!-- 页头上提到应用顶栏 -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <div class="topbar-title-group">
          <h1 class="topbar-page-title">AI 助手</h1>
          <TopbarProjectSelect />
        </div>
        <el-button v-if="!configured" @click="$emit('navigate', 'settings')">配置 AI 服务</el-button>
        <el-button class="chat-topbar-actions" text :loading="collecting" :disabled="!currentProject || !matchedRepos.length" @click="refreshActivity">
          <el-icon><Refresh /></el-icon>刷新 Git 活动
        </el-button>
        <el-button text :disabled="!currentChat?.messages.length" @click="chatPanel?.clearChat()"><el-icon><Delete /></el-icon>清空对话</el-button>
      </div>
    </Teleport>

    <div v-if="currentProject" class="ai-workspace">
      <ChatPanel ref="chatPanel" :project-id="currentProject.id" :project-name="currentProject.name" :context-text="contextText" :context-label="contextLabel" :quick-prompts="quickPrompts" />

      <aside class="context-rail">
        <div class="context-inspector-title"><h2>项目上下文</h2><el-icon><Document /></el-icon></div>
        <div class="context-project">
          <h3>{{ currentProject.name }}</h3>
          <p>{{ currentProject.description || '未填写项目说明' }}</p>
        </div>

        <div class="context-section-head"><span>附带上下文</span><el-switch v-model="currentChat.attachContext" size="small" :disabled="!contextText" aria-label="附带项目上下文" /></div>
        <label class="context-source">
          <el-checkbox v-model="sources.project" aria-label="附带项目资料" />
          <span><strong>项目资料</strong><small>{{ currentProject.notes ? '包含说明、标签和备注' : '包含说明和基础信息' }}</small></span>
        </label>
        <label class="context-source">
          <el-checkbox v-model="sources.git" aria-label="附带 Git 活动" />
          <span><strong>Git 活动</strong><small>{{ projectCommits.length }} 条活动 · {{ matchedRepos.length }} 个仓库</small><small v-if="sources.git" class="context-range">{{ gitRangeLabel }}</small></span>
        </label>
        <label class="context-source">
          <el-checkbox v-model="sources.reports" aria-label="附带报告记录" />
          <span><strong>报告记录</strong><small>{{ projectReports.length }} 条历史记录</small></span>
        </label>
        <label class="context-source">
          <el-checkbox v-model="sources.deploy" aria-label="附带部署状态" />
          <span><strong>部署状态</strong><small>{{ deployLabel }}</small></span>
        </label>

      </aside>

    </div>

    <EmptyState
      v-else icon="ChatDotRound" title="先选择一个项目"
      description="AI 需要明确的项目上下文。请到「项目」页选中一个项目，或先创建项目。"
      action="前往项目" @action="$emit('navigate', 'projects')"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import EmptyState from '../components/EmptyState.vue'
import ChatPanel from '../components/ChatPanel.vue'
import TopbarProjectSelect from '../components/TopbarProjectSelect.vue'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { useProjects } from '../composables/useProjects'
import { useProjectChat } from '../composables/useProjectChat'
import { buildProjectContext } from '../utils/ai-context'
import { commitsForProject, deploymentConfigured, reposForProject } from '../utils/project-context'
import { collectReportData } from '../utils/report-data'
import { addDays, todayStr } from '../utils/date'

defineEmits(['navigate'])
const { currentProject } = useProjects()
/** 顶栏是否在位（沉浸全屏时整个顶栏被卸载，此时不投递页头） */
const topbarReady = useTopbarReady()
const sources = reactive({ project: true, git: false, reports: false, deploy: false })
const chatPanel = ref(null)
const conversations = useProjectChat()
const currentChat = computed(() => currentProject.value ? conversations.session(currentProject.value.id) : null)
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

let historyLoad = 0
async function loadHistory() {
  const loadId = ++historyLoad
  const projectId = currentProject.value?.id
  const [reportRows, deploymentRows] = await Promise.all([
    window.gitReport.listHistory().catch(() => []),
    window.gitReport.deployHistoryList(projectId).catch(() => []),
  ])
  if (loadId !== historyLoad || projectId !== currentProject.value?.id) return
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

<style scoped>
.ai-page { display: flex; flex: 1; flex-direction: column; min-height: 0; height: 100%; padding: 0; }
.chat-topbar-actions { margin-left: auto; }
.ai-workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 272px; overflow: hidden; background: var(--surface); border: 0; border-radius: 0; }
.context-rail { padding: 24px 20px; background: var(--brand-bg); border: 0; border-left: 1px solid var(--line); overflow-y: auto; }
.context-inspector-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 20px; color: var(--text-muted); }
.context-inspector-title h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--brand-text); }
.context-project { padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.context-project h3 { margin: 0; color: var(--brand-text); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.context-project p { margin: 12px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.context-section-head { margin: 16px 0 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--brand-text); font-size: 12px; font-weight: 400; }
.context-source { min-height: 72px; padding: 16px 0; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
.context-source:hover { background: var(--surface-subtle); }
.context-source > span { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.context-source strong { color: var(--brand-text); font-size: 13px; font-weight: 500; }
.context-source small { color: var(--text-muted); font-size: 11px; line-height: 1.5; }
.context-source :deep(.el-checkbox) { margin: 0; height: 20px; }
.context-range { font-variant-numeric: tabular-nums; }
@media (max-width: 1280px) {
  .context-rail { padding: 20px 16px; }
}
</style>
