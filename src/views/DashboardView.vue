<template>
  <div class="page dashboard-page">
    <!-- 工作台是整个应用的总览，不针对某个项目：这里不再放项目切换器与项目入口，
         要看单个项目去「项目」页 -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">工作台</h1>
        <span class="dashboard-date">{{ dateLabel }}</span>
        <el-button class="dashboard-refresh" text :loading="refreshing" @click="refreshDashboard()"><el-icon><Refresh /></el-icon>刷新</el-button>
      </div>
    </Teleport>

    <template v-if="state.projects.items.length">
      <div v-if="loadError" class="dashboard-load-error" role="status"><el-icon><Warning /></el-icon>{{ loadError }}<el-button text :loading="refreshing" @click="refreshDashboard()">重试</el-button></div>
      <!-- 今日状态带：回答「今天该做什么、做了没」。
           原先这里放的是项目总数/已关联目录这类配置状态，配置完就不再变化，
           天天看没有信息量；今日报告与今日工时才是每天真正要盯的两件事 -->
      <section class="dashboard-metrics" aria-label="今日状态">
        <button class="dashboard-metric" type="button" aria-label="查看今日提交" @click="$emit('navigate', 'report')">
          <span>今日提交</span>
          <strong>{{ commitsLoading || commitsError ? '—' : todayCommits.length }}</strong>
          <small v-if="state.scan.collecting && state.scan.collectDone < state.scan.collectTotal">正在加载今日活动 {{ state.scan.collectDone }}/{{ state.scan.collectTotal }}</small>
          <small v-else-if="commitsLoading">加载中…</small>
          <small v-else-if="commitsError">活动读取失败，可重试刷新</small>
          <small v-else-if="!state.discoveredRepos.length">尚未扫描到仓库</small>
          <small v-else>{{ todayRepoCount }} 个仓库有活动</small>
        </button>
        <button class="dashboard-metric" type="button" aria-label="查看活动报告" @click="$emit('navigate', 'report')">
          <span>今日报告</span>
          <strong>{{ todayReports.length ? '已生成' : '未生成' }}</strong>
          <small>{{ todayReports.length ? `今天 ${todayReports.length} 份` : '生成今日活动报告' }}</small>
        </button>
        <button class="dashboard-metric" type="button" aria-label="去填报工时" @click="$emit('navigate', 'fillreport')">
          <span>今日工时</span>
          <strong>{{ todayFills.length ? '已填报' : '未填报' }}</strong>
          <small>{{ todayFills.length ? `${todayFills.length} 条记录` : fillReady ? '生成后预览并提交' : '禅道未配置' }}</small>
        </button>
        <button class="dashboard-metric" type="button" aria-label="查看部署" @click="$emit('navigate', 'deploy')">
          <span>最近部署</span>
          <strong>{{ lastDeploy ? (lastDeploy.version || '—') : '—' }}</strong>
          <small>{{ lastDeploy ? `${lastDeploy.projectName || '项目'} · ${lastDeployHint}` : lastDeployHint }}</small>
        </button>
      </section>

      <!-- 待处理：只列真的需要动作的事，没有就不占位置 -->
      <section v-if="todos.length" class="dashboard-section">
        <div class="dashboard-section-heading"><h2>需要处理</h2></div>
        <div class="dashboard-todos">
          <button v-for="todo in todos" :key="todo.key" class="dashboard-todo" :class="{ 'is-alert': todo.level === 'alert' }" type="button" @click="$emit('navigate', todo.view)">
            <el-icon><Warning v-if="todo.level === 'alert'" /><Document v-else-if="todo.key === 'report'" /><Timer v-else /></el-icon>
            <span class="dashboard-todo-copy"><strong>{{ todo.text }}</strong><small>{{ todo.description }}</small></span>
            <span class="dashboard-todo-action"><el-icon><ArrowRight /></el-icon>{{ todo.action }}</span>
          </button>
        </div>
      </section>

      <section class="dashboard-section">
        <div class="dashboard-section-heading"><h2>最近记录</h2><span>报告与部署</span></div>
        <table v-if="recentItems.length" class="dashboard-history">
          <thead><tr><th scope="col" class="history-type">类型</th><th scope="col">记录</th><th scope="col" class="history-status">状态</th><th scope="col" class="history-time">时间</th><th class="history-action"><span class="visually-hidden">操作</span></th></tr></thead>
          <tbody><tr v-for="item in recentItems" :key="item.key">
            <td>{{ item.type }}</td>
            <td><button class="history-title" type="button" :title="item.title" @click="openRecord(item)">{{ item.title }}</button></td>
            <td><span :class="{ 'history-error': item.status === 'failed' }">{{ recordStatus(item) }}</span></td>
            <td :title="String(item.time)">{{ formatRecordTime(item.time) }}</td>
            <td><el-button text :aria-label="`查看${item.title}`" @click="openRecord(item)"><el-icon><ArrowRight /></el-icon></el-button></td>
          </tr></tbody>
        </table>
        <div v-else class="dashboard-history-empty">{{ refreshing ? '正在加载最近记录…' : '暂无记录，生成报告或发布项目后将在这里显示。' }}</div>
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
import { computed, onMounted, ref, watch } from 'vue'
import EmptyState from '../components/EmptyState.vue'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { todayStr, addDays } from '../utils/date'
import { useProjects } from '../composables/useProjects'

const emit = defineEmits(['navigate', 'create-project'])
const { selectProject } = useProjects()
/** 顶栏是否在位（沉浸全屏时整个顶栏被卸载，此时不投递页头） */
const topbarReady = useTopbarReady()

const TODAY = todayStr()
const dateLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const reports = ref([])
const deployments = ref([])
const fillLogs = ref([])
const todayCommits = ref([])
const commitsLoading = ref(true)
const commitsError = ref(false)
const refreshing = ref(false)
const loadError = ref('')
/** 禅道配好才谈得上「去填报」，否则指过去也只是看一个未配置的提示 */
const fillReady = computed(() => !!(state.config.zentao?.baseUrl && state.config.zentao?.account))

const todayReports = computed(() => reports.value.filter((row) => String(row.createdAt || '').startsWith(TODAY)))
/** 预览（dryRun）不落提交日志，这里出现的都是真提交；带 error 的算失败，不计入「已填报」 */
const todayFills = computed(() => fillLogs.value.filter((row) => row.date === TODAY && !row.error))
const todayRepoCount = computed(() => new Set(todayCommits.value.map((row) => row.repo).filter(Boolean)).size)
const lastDeploy = computed(() => deployments.value[0] || null)
const lastDeployHint = computed(() => {
  if (!lastDeploy.value) return '尚无发布记录'
  const at = toTime(lastDeploy.value.startedAt)
  const days = at ? Math.floor((Date.now() - at) / 86400000) : 0
  if (days <= 0) return '今天发布过'
  return days === 1 ? '昨天发布' : `${days} 天前发布`
})

/** 待处理：只列需要动作的，全部完成时这一块整体不出现 */
const todos = computed(() => {
  const list = []
  if (!todayReports.value.length) {
    list.push({ key: 'report', level: 'todo', text: '生成今日活动报告', description: '汇总全部项目的 Git 活动', action: '去生成', view: 'report' })
  }
  if (fillReady.value && !todayFills.value.length) {
    list.push({ key: 'fill', level: 'todo', text: '填报今日工时', description: '生成明细、确认任务绑定后提交', action: '去填报', view: 'fillreport' })
  }
  const failed = fillLogs.value.filter((row) => row.error)
  if (failed.length) {
    list.push({
      key: 'fill-failed',
      level: 'alert',
      tag: '异常',
      text: `有 ${failed.length} 条填报未确认（最近 ${failed[0].date}），需核对平台记录`,
      description: '核对外部平台后，可从提交记录重新提交',
      action: '去核对',
      view: 'fillreport',
    })
  }
  return list
})

/** 时间归一化：报告历史为 "YYYY-MM-DD HH:mm:ss" 字符串，部署历史为数字时间戳，
 *  混合类型直接字符串比较会因 "1xxx…" 与 "2xxx…" 前缀导致顺序错误，统一转毫秒比较 */
function toTime(value) {
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}
const recentItems = computed(() => [
  ...reports.value.map((item) => ({ key: `r-${item.id}`, type: '报告', title: item.title, time: item.createdAt || '', view: 'report', status: 'generated' })),
  ...deployments.value.map((item) => ({
    key: `d-${item.id}`,
    type: { deploy: '部署', rollback: '回滚', 'db-restore': '数据恢复' }[item.type] || '部署',
    title: `${item.projectName || '项目'} ${item.version || ''}`,
    time: item.startedAt || '',
    view: 'deploy',
    projectId: item.projectId,
    status: item.status,
  })),
].sort((a, b) => toTime(b.time) - toTime(a.time)).slice(0, 6))

function recordStatus(item) {
  return { generated: '已生成', success: '成功', failed: '失败', rolled_back: '已回滚', canceled: '已取消', running: '进行中' }[item.status] || '—'
}

function openRecord(item) {
  if (item.projectId && state.projects.items.some(project => project.id === item.projectId)) selectProject(item.projectId)
  emit('navigate', item.view)
}

function formatRecordTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return date.toDateString() === new Date().toDateString() ? `今天 ${time}` : `${date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${time}`
}

/**
 * 今日提交数复用报告页同一段收集范围（今天 → 明天）与参数，
 * 命中启动预热的缓存，不会重新跑一遍 git log。
 */
async function loadTodayCommits() {
  commitsLoading.value = true
  commitsError.value = false
  const repos = state.discoveredRepos.map((row) => row.path).filter(Boolean)
  if (!repos.length) { commitsLoading.value = false; return }
  try {
    const rows = await window.gitReport.collectCommits(repos, {
      since: TODAY,
      until: addDays(TODAY, 1),
      authors: [],
      includeMerges: false,
    })
    todayCommits.value = Array.isArray(rows) ? rows : []
  } catch { commitsError.value = true } finally {
    commitsLoading.value = false
  }
}

/**
 * 收集必须等仓库列表权威（预热已完成且当前不在扫描）才发起：扫描是流式发现仓库的，
 * 部分列表与预热收集的缓存 key 不同，逐次发起会各自全量跑 git log，
 * 把 N 个仓库放大成 O(N²) 次 git 子进程（实测 78 仓库 → 3000+ 次，分钟级卡顿）。
 * 手动重新扫描会经历 scanning true→false，同样在此收敛为一次完整收集。
 */
const reposAuthoritative = computed(() => state.scan.warmupDone && !state.scan.scanning)

watch(reposAuthoritative, (ready) => {
  if (!ready) return
  if (state.discoveredRepos.length) loadTodayCommits()
  else commitsLoading.value = false
}, { immediate: true })

async function refreshDashboard(includeCommits = true) {
  if (refreshing.value) return
  refreshing.value = true
  loadError.value = ''
  try {
    const [reportResult, deployResult, fillResult] = await Promise.allSettled([
      window.gitReport.listHistory(), window.gitReport.deployHistoryList(), window.gitReport.fillLog(30),
    ])
    if (reportResult.status === 'fulfilled') reports.value = Array.isArray(reportResult.value) ? reportResult.value : []
    if (deployResult.status === 'fulfilled') deployments.value = Array.isArray(deployResult.value) ? deployResult.value : []
    if (fillResult.status === 'fulfilled' && fillResult.value?.ok) fillLogs.value = fillResult.value.entries || []
    if ([reportResult, deployResult, fillResult].some(result => result.status === 'rejected') || (fillResult.status === 'fulfilled' && !fillResult.value?.ok)) loadError.value = '部分记录读取失败，已保留上次数据。'
    if (includeCommits && reposAuthoritative.value) await loadTodayCommits()
  } finally { refreshing.value = false }
}

onMounted(() => refreshDashboard(false))
</script>

<style scoped>
.dashboard-page { padding: 0 24px 24px; color: var(--brand-text); background: var(--surface); }
.dashboard-date { color: var(--text-muted); font-size: 12px; }
.dashboard-refresh { margin-left: auto; }
.dashboard-load-error { display: flex; align-items: center; gap: 8px; min-height: 40px; color: var(--danger); font-size: 13px; border-bottom: 1px solid var(--line); }
.dashboard-load-error .el-button { margin-left: auto; }
.dashboard-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--line); }
.dashboard-metric { min-width: 0; min-height: 128px; padding: 24px 16px 16px 0; display: flex; align-items: flex-start; flex-direction: column; gap: 12px; border: 0; background: transparent; color: var(--brand-text); font: inherit; text-align: left; cursor: pointer; }
.dashboard-metric > span { font-size: 12px; color: var(--text-muted); }
.dashboard-metric strong { font-size: 22px; font-weight: 600; line-height: 28px; font-variant-numeric: tabular-nums; }
.dashboard-metric small { max-width: 100%; color: var(--text-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dashboard-metric:hover { background: var(--surface-subtle); }
.dashboard-metric:focus-visible, .dashboard-todo:focus-visible, .history-title:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; border-radius: 4px; }
.dashboard-section { margin-top: 24px; }
.dashboard-section-heading { display: flex; justify-content: space-between; align-items: center; min-height: 32px; margin-bottom: 12px; }
.dashboard-section-heading h2 { margin: 0; color: var(--brand-text); font-size: 14px; font-weight: 600; }
.dashboard-section-heading > span { color: var(--text-muted); font-size: 12px; }
.dashboard-todo { display: flex; align-items: center; gap: 16px; width: 100%; min-height: 68px; padding: 12px 8px 12px 0; border: 0; border-bottom: 1px solid var(--line); color: var(--brand-text); background: transparent; font: inherit; text-align: left; cursor: pointer; }
.dashboard-todo > .el-icon { flex-shrink: 0; color: var(--text-muted); font-size: 16px; }
.dashboard-todo-copy { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 4px; }
.dashboard-todo-copy strong { font-size: 13px; font-weight: 500; line-height: 20px; }
.dashboard-todo-copy small { font-size: 12px; color: var(--text-muted); line-height: 16px; }
.dashboard-todo-action { display: flex; align-items: center; gap: 8px; flex-shrink: 0; font-size: 12px; }
.dashboard-todo-action .el-icon { color: var(--text-muted); }
.dashboard-todo:hover { background: var(--surface-subtle); }
.dashboard-todo.is-alert > .el-icon, .dashboard-todo.is-alert strong { color: var(--danger); }
.dashboard-history { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 12px; }
.dashboard-history th { height: 36px; padding: 0 16px; color: var(--text-muted); background: var(--brand-bg); font-size: 11px; font-weight: 400; text-align: left; border-block: 1px solid var(--line); }
.dashboard-history td { height: 40px; padding: 0 16px; border-bottom: 1px solid var(--line-soft); color: var(--text-muted); font-variant-numeric: tabular-nums; }
.dashboard-history tr:hover td { background: var(--surface-subtle); }
.dashboard-history td:first-child { color: var(--brand-text); }
.history-type { width: 92px; }
.history-status { width: 112px; }
.history-time { width: 164px; }
.history-action { width: 56px; }
.history-title { display: block; width: 100%; padding: 0; border: 0; overflow: hidden; background: transparent; color: var(--text-muted); font: inherit; text-align: left; white-space: nowrap; text-overflow: ellipsis; cursor: pointer; }
.history-title:hover { color: var(--accent-strong); }
.history-error { color: var(--danger); }
.dashboard-history-empty { min-height: 120px; display: grid; place-items: center; color: var(--text-muted); font-size: 13px; border-block: 1px solid var(--line); }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
@media (max-width: 1280px) { .dashboard-page { padding-inline: 16px; } .dashboard-section { margin-top: 16px; } .dashboard-metric { min-height: 112px; padding-top: 20px; } }
</style>
