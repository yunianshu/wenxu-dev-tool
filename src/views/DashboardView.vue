<template>
  <div class="page dashboard-page">
    <!-- 页头上提到应用顶栏；标题固定为「工作台」（原先选中项目后标题会被项目名顶替），
         项目名放在标题旁的下拉里，既显示当前在看哪个项目，也保留了切换入口 -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <div class="topbar-title-group">
          <h1 class="topbar-page-title">工作台</h1>
          <TopbarProjectSelect />
        </div>
        <el-button v-if="currentProject" @click="$emit('navigate', 'projects')">查看项目资料</el-button>
        <el-button v-else type="primary" @click="$emit('create-project')"><el-icon><Plus /></el-icon>创建项目</el-button>
      </div>
    </Teleport>

    <template v-if="state.projects.items.length">
      <!-- 今日状态带：回答「今天该做什么、做了没」。
           原先这里放的是项目总数/已关联目录这类配置状态，配置完就不再变化，
           天天看没有信息量；今日报告与今日工时才是每天真正要盯的两件事 -->
      <section class="metric-strip" aria-label="今日状态">
        <button class="metric-item metric-item-action" type="button" aria-label="查看今日提交" @click="$emit('navigate', 'report')">
          <span>今日提交</span>
          <strong>{{ commitsLoading ? '—' : todayCommits.length }}</strong>
          <small v-if="state.scan.collecting && state.scan.collectDone < state.scan.collectTotal">正在加载今日活动 {{ state.scan.collectDone }}/{{ state.scan.collectTotal }}</small>
          <small v-else-if="commitsLoading">加载中…</small>
          <small v-else-if="!state.discoveredRepos.length">尚未扫描到仓库</small>
          <small v-else>{{ todayRepoCount }} 个仓库有活动</small>
        </button>
        <button class="metric-item metric-item-action" type="button" aria-label="查看活动报告" @click="$emit('navigate', 'report')">
          <span>今日报告</span>
          <strong>{{ todayReports.length ? '已生成' : '未生成' }}</strong>
          <small>{{ todayReports.length ? `今天 ${todayReports.length} 份` : '点击去生成' }}</small>
        </button>
        <button class="metric-item metric-item-action" type="button" aria-label="去填报工时" @click="$emit('navigate', 'fillreport')">
          <span>今日工时</span>
          <strong>{{ todayFills.length ? '已填报' : '未填报' }}</strong>
          <small>{{ todayFills.length ? `${todayFills.length} 条记录` : fillReady ? '点击去填报' : '禅道未配置' }}</small>
        </button>
        <button class="metric-item metric-item-action" type="button" aria-label="查看部署" @click="$emit('navigate', 'deploy')">
          <span>最近部署</span>
          <strong>{{ lastDeploy ? (lastDeploy.version || '—') : '—' }}</strong>
          <small>{{ lastDeployHint }}</small>
        </button>
      </section>

      <!-- 待处理：只列真的需要动作的事，没有就不占位置 -->
      <section v-if="todos.length" class="workspace-panel todo-panel">
        <div class="section-heading"><div><h2>需要处理</h2></div></div>
        <div class="todo-list">
          <button v-for="todo in todos" :key="todo.key" class="todo-row" type="button" @click="$emit('navigate', todo.view)">
            <span class="todo-tag" :class="`is-${todo.level}`">{{ todo.tag }}</span>
            <span class="todo-text">{{ todo.text }}</span>
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>
      </section>

      <div class="dashboard-grid">
        <section class="workspace-panel focus-panel">
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
        </section>

        <section class="workspace-panel recent-panel">
          <div class="section-heading"><div><h2>最近记录</h2></div></div>
          <div v-if="recentItems.length" class="recent-list">
            <div v-for="item in recentItems" :key="item.key" class="recent-row">
              <span class="recent-type">{{ item.type }}</span><strong>{{ item.title }}</strong><span>{{ formatRecordTime(item.time) }}</span>
            </div>
          </div>
          <p v-else class="quiet-empty">暂无记录</p>
        </section>
      </div>
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
import TopbarProjectSelect from '../components/TopbarProjectSelect.vue'
import EmptyState from '../components/EmptyState.vue'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { useProjects } from '../composables/useProjects'
import { projectStatusLabel } from '../utils/project-context'
import { todayStr, addDays } from '../utils/date'

defineEmits(['navigate', 'create-project'])
const { currentProject, selectProject } = useProjects()
/** 顶栏是否在位（沉浸全屏时整个顶栏被卸载，此时不投递页头） */
const topbarReady = useTopbarReady()

const TODAY = todayStr()
const reports = ref([])
const deployments = ref([])
const fillLogs = ref([])
const todayCommits = ref([])
const commitsLoading = ref(true)
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
    list.push({ key: 'report', level: 'todo', tag: '报告', text: '今天还没有生成活动报告', view: 'report' })
  }
  if (fillReady.value && !todayFills.value.length) {
    list.push({ key: 'fill', level: 'todo', tag: '工时', text: '今天的工时还没有填报', view: 'fillreport' })
  }
  const failed = fillLogs.value.filter((row) => row.error)
  if (failed.length) {
    list.push({
      key: 'fill-failed',
      level: 'alert',
      tag: '异常',
      text: `有 ${failed.length} 条填报未确认（最近 ${failed[0].date}），需核对平台记录`,
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

/**
 * 今日提交数复用报告页同一段收集范围（今天 → 明天）与参数，
 * 命中启动预热的缓存，不会重新跑一遍 git log。
 */
async function loadTodayCommits() {
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
  } catch { /* 取不到就只显示「—」，不影响其余区块 */ } finally {
    commitsLoading.value = false
  }
}

// 仓库列表由启动预热异步填充，扫描到之后才能算今日提交
watch(() => state.discoveredRepos.length, (n) => { if (n) loadTodayCommits() })

onMounted(async () => {
  const [reportRows, deployRows, fillRows] = await Promise.all([
    window.gitReport.listHistory().catch(() => []),
    window.gitReport.deployHistoryList().catch(() => []),
    window.gitReport.fillLog(30).catch(() => null),
  ])
  reports.value = Array.isArray(reportRows) ? reportRows : []
  deployments.value = Array.isArray(deployRows) ? deployRows : []
  fillLogs.value = fillRows && fillRows.ok ? (fillRows.entries || []) : []
  if (state.discoveredRepos.length) loadTodayCommits()
  else commitsLoading.value = false
})
</script>

<style scoped>
/* 待处理：只在真有需要动作的事时才出现 */
.todo-panel { margin-bottom: 16px; }
.todo-list { padding: 0 32px 4px; }
.todo-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 40px;
  padding: 10px 0;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.todo-row:last-child { border-bottom: 0; }
.todo-row:hover .todo-text { color: var(--brand-accent); }
.todo-row .el-icon { margin-left: auto; color: var(--brand-text-sub); flex-shrink: 0; }
.todo-tag {
  flex-shrink: 0;
  min-width: 40px;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  text-align: center;
}
.todo-tag.is-todo { background: var(--accent-soft); color: var(--accent-strong); }
.todo-tag.is-alert { background: #fdecea; color: #b3261e; }
.todo-text { min-width: 0; font-size: 13.5px; color: var(--brand-text); }
</style>
