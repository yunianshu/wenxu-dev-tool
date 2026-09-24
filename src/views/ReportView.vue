<template>
  <div class="report-page">
    <!-- 页头上提到应用顶栏（活动报告固定汇总全部项目，不跟随顶栏当前项目） -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">活动报告</h1>
        <span class="page-scope">全部项目</span>
        <el-button type="primary" class="page-primary" :loading="busy" :disabled="busy" @click="generate">
          <el-icon><MagicStick /></el-icon><span>生成报告</span>
        </el-button>
      </div>
    </Teleport>

    <!-- 顶部工具条：选周期 → 点生成，一键完成 -->
    <section class="report-toolbar-card">
      <div class="report-toolbar">
        <div class="toolbar-left">
          <el-select v-model="period" class="period-select" aria-label="报告周期">
            <el-option v-for="(label, value) in periodLabels" :key="value" :label="label" :value="value" />
          </el-select>

          <el-date-picker
            v-if="period === 'daily'"
            v-model="dailyDate"
            type="date"
            value-format="YYYY-MM-DD"
          />
          <template v-else-if="period === 'custom'">
            <el-date-picker v-model="customSince" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" />
            <span class="range-sep">至</span>
            <el-date-picker v-model="customUntil" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" />
          </template>

          <span v-if="!['daily', 'custom'].includes(period)" class="range-label">{{ rangeLabel }}</span>
          <el-select v-model="onlyMine" class="author-select" aria-label="作者范围">
            <el-option label="只看本人" :value="true" />
            <el-option label="全部作者" :value="false" />
          </el-select>
        </div>
        <div class="toolbar-right">
          <span class="repo-count">{{ scopedRepos.length }} 个 Git 活动源</span>
        </div>
      </div>

      <!-- 全部作者时可选作者 -->
      <div v-if="!onlyMine && authors.length" class="author-filter-row">
        <el-checkbox-group v-model="authorFilter">
          <el-checkbox v-for="a in authors" :key="a.name" :value="a.name">{{ a.name }}（{{ a.count }}）</el-checkbox>
        </el-checkbox-group>
      </div>

      <el-alert
        v-if="!state.config.roots.length"
        type="warning"
        :closable="false"
        title="尚未配置扫描根目录，请到「设置」页添加后再生成报告。"
        class="warn"
      />
      <el-alert
        v-else-if="onlyMine && identitiesMissing"
        type="warning"
        :closable="false"
        title="尚未配置本人身份，「只看本人」会匹配不到任何提交。请到「设置 → 个人身份」添加 Git 账号。"
        class="warn"
      />
    </section>

    <!-- 收集范围与当前活动源不一致（如 AI 助手页按单项目刷新过）：旧数据不作展示 -->
    <el-alert
      v-if="scopeMismatch"
      type="info"
      :closable="false"
      show-icon
      class="stale-alert"
      :title="`下方为其它范围收集的数据；点击「生成报告」按全部项目重新收集「${dataRangeLabel}」。`"
    />

    <!-- 生成过程：扫描 / 收集中 -->
    <div v-if="state.report.phase === 'scanning' || state.report.phase === 'collecting'" class="report-results">
      <div class="phase-card">
        <el-icon class="is-loading phase-icon"><Loading /></el-icon>
        <div class="phase-text">
          <div class="phase-title">{{ state.report.phase === 'scanning' ? '正在扫描仓库' : '正在收集提交' }}</div>
          <div class="phase-detail">
      <template v-if="state.report.phase === 'scanning'">已处理 {{ state.report.scanProgress.scanned }} 个目录 · 已发现 {{ state.discoveredRepos.length }} 个仓库</template>
      <template v-else>已完成 {{ state.report.collectProgress.done }} / {{ state.report.collectProgress.total }} 个仓库</template>
          </div>
        </div>
        <el-progress
          v-if="state.report.phase === 'collecting'"
          :percentage="collectPercent"
          :stroke-width="5"
          class="phase-bar"
        />
      </div>
    </div>

    <!-- 结果 tabs：始终显示，明细/统计仅生成后可见 -->
    <el-tabs v-model="resultTab" :class="['result-tabs', 'report-tabs', { 'tabs-lone': state.report.phase !== 'done' }]">
      <el-tab-pane label="提交明细" name="detail" :disabled="state.report.phase !== 'done'">
            <el-alert
              v-if="periodMismatch"
              type="warning"
              :closable="false"
              show-icon
              class="stale-alert"
              :title="`当前展示的是「${dataRangeLabel}」收集的数据，与所选周期（${rangeLabel || '未选择'}）不一致；点击「生成报告」刷新后才能复制或导出。`"
            />
            <div class="detail-toolbar">
              <span class="detail-summary">{{ filteredCommits.length }} 条提交 · {{ filteredGroups.length }} 个项目</span>
              <div class="detail-actions">
                <el-button
                  v-if="filteredGroups.length > 1"
                  size="small"
                  @click="toggleAllGroups"
                >{{ allCollapsed ? '全部展开' : '全部收起' }}</el-button>
                <el-button size="small" :disabled="!filteredCommits.length || stale" @click="copyReport">
                  <el-icon style="margin-right: 4px"><CopyDocument /></el-icon>复制报告
                </el-button>
                <el-button size="small" :disabled="!filteredCommits.length || stale" @click="exportReport">
                  <el-icon style="margin-right: 4px"><Download /></el-icon>导出 Markdown
                </el-button>
              </div>
            </div>
            <div v-if="filteredGroups.length" class="report-detail-list">
              <div v-for="g in filteredGroups" :key="g.repo" class="project-card" :class="{ 'is-collapsed': isCollapsed(g.repo) }">
                <div class="project-header" role="button" tabindex="0" :aria-expanded="!isCollapsed(g.repo)" @click="toggleCollapse(g.repo)" @keydown.enter="toggleCollapse(g.repo)" @keydown.space.prevent="toggleCollapse(g.repo)">
                  <div class="project-head-left">
                    <el-icon class="fold-icon"><CaretRight /></el-icon>
                    <span class="project-name">{{ g.project }}</span>
                  </div>
                  <div class="project-right" @click.stop>
                    <span class="project-count">{{ g.commits.length }} 条提交</span>
                    <el-button size="small" text :disabled="stale" @click="copyProject(g)">
                      <el-icon style="margin-right: 3px"><CopyDocument /></el-icon>复制
                    </el-button>
                  </div>
                </div>
                <el-collapse-transition>
                  <div v-show="!isCollapsed(g.repo)" class="commit-list">
                    <div v-for="(c, i) in g.commits" :key="c.hash" class="commit-row">
                      <span class="commit-no">{{ i + 1 }}</span>
                      <span class="commit-date">{{ c.date.slice(5) }}</span>
                      <span class="commit-subject">{{ c.subject }}</span>
                    </div>
                  </div>
                </el-collapse-transition>
              </div>
            </div>
            <div v-else-if="scopeMismatch" class="collect-hint">数据已过期，请重新生成报告</div>
            <div v-else class="collect-hint">该时间范围内无提交记录</div>
          </el-tab-pane>

          <!-- 统计分析：KPI + 图表 -->
          <el-tab-pane label="统计概览" name="stats" :disabled="state.report.phase !== 'done'">
            <el-row :gutter="12" class="stats">
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><List /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">提交数</div>
                    <div class="kpi-value"><CountUp :target="filteredCommits.length" /></div>
                  </div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><FolderOpened /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">活跃项目</div>
                    <div class="kpi-value"><CountUp :target="filteredGroups.length" /></div>
                  </div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><User /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">作者数</div>
                    <div class="kpi-value"><CountUp :target="authorCount" /></div>
                  </div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="kpi-card">
                  <div class="kpi-icon"><el-icon><Calendar /></el-icon></div>
                  <div class="kpi-body">
                    <div class="kpi-label">时间范围</div>
                    <div class="kpi-value kpi-range">{{ scopeMismatch ? '—' : dataRangeLabel }}</div>
                  </div>
                </div>
              </el-col>
            </el-row>

            <el-row :gutter="12" class="charts">
              <el-col :span="12">
                <el-card shadow="never" header="项目提交分布">
                  <BaseChart :option="projectBarOption" height="300px" />
                </el-card>
              </el-col>
              <el-col :span="12">
                <el-card shadow="never" header="每日提交趋势">
                  <BaseChart :option="trendOption" height="300px" />
                </el-card>
              </el-col>
            </el-row>
          </el-tab-pane>

      <!-- 历史记录 tab（始终显示） -->
      <el-tab-pane label="历史报告" name="history">
        <div class="history-toolbar">
          <el-input v-model="historySearch" clearable placeholder="搜索报告标题" aria-label="搜索报告标题" class="history-search"><template #prefix><el-icon><Search /></el-icon></template></el-input>
          <span class="history-count">{{ filteredHistory.length }} 份报告</span>
          <el-select v-model="historyPeriod" :empty-values="[null, undefined]" class="history-period" aria-label="筛选历史报告周期">
            <el-option label="全部周期" value="" />
            <el-option v-for="(label, value) in periodLabels" :key="value" :label="label" :value="value" />
          </el-select>
        </div>
        <el-alert v-if="historyError" type="error" :closable="false" :title="historyError" class="stale-alert"><el-button text @click="loadHistory">重试</el-button></el-alert>
        <el-table ref="historyTable" v-loading="historyLoading" :data="pagedHistory" class="history-table" highlight-current-row row-key="id" :default-sort="{ prop: 'createdAt', order: 'descending' }" @sort-change="sortHistory" @row-dblclick="viewHistory" @row-contextmenu="openHistoryMenu">
          <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
          <el-table-column label="周期" width="92"><template #default="{ row }">{{ periodLabels[row.period] || '报告' }}</template></el-table-column>
          <el-table-column prop="commitCount" label="提交数" width="92" sortable="custom" />
          <el-table-column prop="projectCount" label="项目数" width="92" sortable="custom" />
          <el-table-column prop="createdAt" label="生成时间" width="168" sortable="custom" />
          <el-table-column label="操作" width="64" align="center">
            <template #default="{ row }">
              <el-dropdown trigger="click" @command="(command) => historyAction(command, row)">
                <el-button text class="row-more" aria-label="报告操作"><el-icon><MoreFilled /></el-icon></el-button>
                <template #dropdown><el-dropdown-menu><el-dropdown-item command="view">查看报告</el-dropdown-item><el-dropdown-item command="copy">复制报告</el-dropdown-item><el-dropdown-item command="delete" divided>删除记录</el-dropdown-item></el-dropdown-menu></template>
              </el-dropdown>
            </template>
          </el-table-column>
          <template #empty>
            <div class="table-empty">
              <el-icon><Document /></el-icon>
              <p>{{ historySearch || historyPeriod ? '没有匹配的报告' : '暂无报告，生成后自动保存在这里' }}</p>
            </div>
          </template>
        </el-table>
        <div class="history-footer">
          <span>{{ filteredHistory.length ? `显示 ${historyStart}–${Math.min(historyPage * historyPageSize, filteredHistory.length)}，` : '' }}共 {{ filteredHistory.length }} 份报告</span>
          <el-pagination v-model:current-page="historyPage" :page-size="historyPageSize" :total="filteredHistory.length" :pager-count="5" layout="prev, pager, next" />
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 历史报告查看 -->
    <el-dialog v-model="historyDialog.visible" :title="historyDialog.title" width="760" top="6vh">
      <pre class="history-content">{{ historyDialog.content }}</pre>
    </el-dialog>
    <Teleport to="body">
      <div v-if="historyMenu.row" ref="historyMenuElement" class="report-context-menu" role="menu" :style="{ left: `${historyMenu.x}px`, top: `${historyMenu.y}px` }" @pointerdown.stop @contextmenu.prevent @keydown="moveMenuFocus">
        <button role="menuitem" @click="historyAction('view', historyMenu.row)">查看报告<span>双击</span></button>
        <button role="menuitem" @click="historyAction('copy', historyMenu.row)">复制报告</button>
        <button role="menuitem" class="is-danger" @click="historyAction('delete', historyMenu.row)">删除记录</button>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { todayStr, addDays, untilToEnd } from '../utils/date'
import { groupByProject, buildMarkdown, stripPrefix } from '../utils/report'
import { toPlain } from '../utils/ipc'
import { shortPath } from '../utils/path'
import BaseChart from '../components/BaseChart.vue'
import CountUp from '../components/CountUp.vue'

const period = ref('daily')
const periodLabels = { daily: '日报', weekly: '周报', biweekly: '双周报', monthly: '月报', custom: '自定义' }
/** 顶栏是否在位（沉浸全屏时整个顶栏被卸载，此时不投递页头） */
const topbarReady = useTopbarReady()
// 活动报告固定汇总全部项目（不跟随顶栏当前项目）：报告口径是全量活动，项目维度由分组与图表呈现
const scopedRepos = computed(() => state.discoveredRepos)
// 日报默认今天
const dailyDate = ref(todayStr())
const customSince = ref(addDays(todayStr(), -6))
const customUntil = ref(todayStr())
const onlyMine = ref(true)
const authorFilter = ref([])
const resultTab = ref('detail') // detail | stats | history
// 未生成报告时只显示历史 tab；生成完成后默认报告明细
watch(
  () => state.report.phase,
  (p) => {
    if (p === 'done') resultTab.value = 'detail'
    else resultTab.value = 'history'
  },
  { immediate: true }
)

// 历史记录
const historyList = ref([])
const historySearch = ref('')
const historyPeriod = ref('')
const historyPage = ref(1)
const historyPageSize = 12
const historyLoading = ref(false)
const historyError = ref('')
const historySort = ref({ prop: 'createdAt', order: 'descending' })
const historyMenu = ref({ row: null, x: 0, y: 0 })
const historyTable = ref(null)
const historyMenuElement = ref(null)
const filteredHistory = computed(() => {
  const search = historySearch.value.trim().toLocaleLowerCase()
  const rows = historyList.value.filter((row) => (!search || String(row.title || '').toLocaleLowerCase().includes(search)) && (!historyPeriod.value || row.period === historyPeriod.value))
  const { prop, order } = historySort.value
  return rows.sort((a, b) => {
    const difference = ['commitCount', 'projectCount'].includes(prop) ? Number(a[prop] || 0) - Number(b[prop] || 0) : String(a[prop] || '').localeCompare(String(b[prop] || ''))
    return order === 'ascending' ? difference : -difference
  })
})
const historyStart = computed(() => (historyPage.value - 1) * historyPageSize + 1)
const pagedHistory = computed(() => filteredHistory.value.slice(historyStart.value - 1, historyPage.value * historyPageSize))
watch([historySearch, historyPeriod], () => { historyPage.value = 1 })
watch(() => filteredHistory.value.length, (length) => { historyPage.value = Math.min(historyPage.value, Math.max(1, Math.ceil(length / historyPageSize))) })
function sortHistory(sort) { historySort.value = sort.prop && sort.order ? sort : { prop: 'createdAt', order: 'descending' } }
function closeHistoryMenu() { historyMenu.value.row = null }
function historyMenuKey(event) { if (event.key === 'Escape') closeHistoryMenu() }
function moveMenuFocus(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [...historyMenuElement.value.querySelectorAll('button')]
  const current = buttons.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
async function openHistoryMenu(row, column, event) {
  event.preventDefault()
  historyTable.value?.setCurrentRow(row)
  historyMenu.value = { row, x: Math.min(event.clientX, window.innerWidth - 184), y: Math.min(event.clientY, window.innerHeight - 124) }
  await nextTick()
  historyMenuElement.value?.querySelector('button')?.focus()
}
async function historyAction(command, row) {
  closeHistoryMenu()
  if (command === 'view') await viewHistory(row)
  else if (command === 'delete') await delHistory(row)
  else if (command === 'copy') {
    try {
      const data = await window.gitReport.readHistory(row.id)
      if (data) await copyText(data.content)
      else ElMessage.warning('这份报告已不存在，请刷新历史记录')
    } catch { ElMessage.error('读取报告失败，请重试') }
  }
}
const historyDialog = ref({ visible: false, title: '', content: '' })
onMounted(() => {
  loadHistory()
  document.addEventListener('pointerdown', closeHistoryMenu)
  document.addEventListener('keydown', historyMenuKey)
  document.addEventListener('scroll', closeHistoryMenu, true)
  window.addEventListener('resize', closeHistoryMenu)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeHistoryMenu)
  document.removeEventListener('keydown', historyMenuKey)
  document.removeEventListener('scroll', closeHistoryMenu, true)
  window.removeEventListener('resize', closeHistoryMenu)
})

// 生成过程状态全部存于共享 store.state.report，切换视图不中断
const busy = computed(() => state.report.phase === 'scanning' || state.report.phase === 'collecting')
const collectPercent = computed(() => {
  const t = state.report.collectProgress.total
  return t ? Math.round((state.report.collectProgress.done / t) * 100) : 0
})

/** 计算 git 查询起止（until 为排他语义，= 结束日 + 1 天） */
function range() {
  const T = todayStr()
  if (period.value === 'daily') return { since: dailyDate.value, until: addDays(dailyDate.value, 1) }
  if (period.value === 'weekly') return { since: addDays(T, -6), until: addDays(T, 1) }
  if (period.value === 'biweekly') return { since: addDays(T, -13), until: addDays(T, 1) }
  if (period.value === 'monthly') return { since: addDays(T, -29), until: addDays(T, 1) }
  return {
    since: customSince.value,
    until: customUntil.value ? addDays(customUntil.value, 1) : '',
  }
}

const rangeLabel = computed(() => {
  const r = range()
  if (!r.since) return ''
  const end = untilToEnd(r.until) || r.since
  return r.since === end ? r.since : `${r.since} ~ ${end}`
})

/** 实际收集数据对应的范围标签（统计与导出口径以此为准） */
const dataRangeLabel = computed(() => {
  const c = state.report.collectedRange
  if (c && c.since) {
    const end = untilToEnd(c.until) || c.since
    return c.since === end ? c.since : `${c.since} ~ ${end}`
  }
  return rangeLabel.value
})

const repoKey = (paths) => (paths || []).slice().sort().join('\n')

/** 收集范围与当前活动源不一致（如 AI 助手页按单项目刷新过活动）。
 *  此时旧数据不是「全部项目」口径，明细/统计必须归零：显示不完整的数据比显示空更糟。 */
const scopeMismatch = computed(() => {
  if (state.report.phase !== 'done' || !state.report.collectedRange) return false
  return repoKey(state.report.collectedRange.repoPaths) !== repoKey(scopedRepos.value.map((row) => row.path))
})

/** 收集范围与当前所选周期不一致（只改了日期，数据仍属于本项目）：保留展示但禁止复制/导出 */
const periodMismatch = computed(() => {
  if (state.report.phase !== 'done' || !state.report.collectedRange) return false
  const r = range()
  const c = state.report.collectedRange
  return c.since !== r.since || c.until !== r.until
})

/** 展示数据是否与当前所选周期/项目不一致（rawCommits 可能来自 AI 页刷新或其它周期/项目） */
const stale = computed(() => scopeMismatch.value || periodMismatch.value)

/** 一键生成：扫描（若有需要）→ 收集提交 → 展示，分阶段显示进度 */
async function generate() {
  if (busy.value) return
  // 日期被清空（null）时 until 计算为空串，git 查询会静默失败并误报「无提交记录」
  if (period.value === 'daily' && !dailyDate.value) {
    ElMessage.warning('请先选择日报日期')
    return
  }
  if (period.value === 'custom' && !customSince.value) {
    ElMessage.warning('自定义周期请先选择开始日期')
    return
  }
  // 阶段 1：确保有仓库（自动扫描）
  if (!state.discoveredRepos.length) {
    if (!state.config.roots || !state.config.roots.length) {
      ElMessage.warning('请先到「设置」添加扫描根目录')
      return
    }
    state.report.phase = 'scanning'
    state.report.scanProgress = { scanned: 0 }
    try {
      const paths = await window.gitReport.scanRepos(toPlain(state.config.roots), toPlain(state.config.excludes))
      state.discoveredRepos = paths.map((p) => ({ path: p, shortName: shortPath(p), info: null }))
    } catch (e) {
      console.error('自动扫描失败', e)
      ElMessage.error('扫描仓库失败')
      state.report.phase = 'idle'
      return
    }
    if (!state.discoveredRepos.length) {
      ElMessage.warning('未扫描到任何 Git 仓库')
      state.report.phase = 'idle'
      return
    }
  }
  // 阶段 2：收集提交
  if (!scopedRepos.value.length) {
    ElMessage.info('没有可用的 Git 活动源')
    state.report.rawCommits = []
    state.report.collectedRange = null
    state.report.phase = 'done'
    return
  }
  await doCollect()
}

async function doCollect() {
  state.report.phase = 'collecting'
  state.report.collectProgress = { done: 0, total: 0 }
  const r = range()
  try {
    const repos = scopedRepos.value.map((row) => row.path)
    const data = await window.gitReport.collectCommits(toPlain(repos), {
      since: r.since,
      until: r.until,
      authors: [],
      includeMerges: false,
    })
    state.report.rawCommits = data
    state.report.collectedRange = { since: r.since, until: r.until, repoPaths: repos.slice() }
    // 新一轮数据里可能没有旧勾选的作者：残留筛选会静默隐藏提交，必须重置
    authorFilter.value = []
    // 折叠状态同理：新数据的分组未必与旧数据一致，全部展开
    collapsedRepos.value = new Set()
    state.report.phase = 'done'
    if (data.length) autoSave()
    if (!data.length) {
      ElMessage.warning(
        period.value === 'daily'
          ? `${dailyDate.value} 无提交记录（可改选其它日期）`
          : '所选时间范围内无提交记录'
      )
    }
  } catch (e) {
    console.error('收集失败', e)
    ElMessage.error('收集提交失败')
    state.report.phase = 'idle'
  }
}

const authors = computed(() => {
  // 收集范围不一致时作者分布同样属于旧数据，不能继续作为筛选依据
  if (scopeMismatch.value) return []
  const m = new Map()
  state.report.rawCommits.forEach((c) => {
    if (!m.has(c.authorName)) m.set(c.authorName, { name: c.authorName, email: c.authorEmail, count: 0 })
    m.get(c.authorName).count += 1
  })
  return [...m.values()].sort((a, b) => b.count - a.count)
})

function isMine(c) {
  const ids = state.config?.identities || []
  if (!ids.length) return false
  return ids.some(
    (id) => (id.email && c.authorEmail === id.email) || (id.name && c.authorName === id.name)
  )
}

/** 「只看本人」但没有可匹配的身份：过滤必然为空，必须显式提示而不是误报「无提交」 */
const identitiesMissing = computed(() => !(state.config?.identities || []).length)

const filteredCommits = computed(() => {
  // 收集范围与全部活动源不一致：rawCommits 可能来自 AI 助手页的单项目刷新，
  // 明细/KPI/图表必须一起归零；范围恢复后 scopeMismatch 变回 false，数据自动恢复
  if (scopeMismatch.value) return []
  return state.report.rawCommits.filter((c) => {
    if (onlyMine.value) return isMine(c)
    if (authorFilter.value.length) return authorFilter.value.includes(c.authorName)
    return true
  })
})

const filteredGroups = computed(() => groupByProject(filteredCommits.value))
const authorCount = computed(() => new Set(filteredCommits.value.map((c) => c.authorName)).size)

/** 项目卡片折叠状态（按 repo 记录；新一轮收集后重置，避免旧状态套在新数据上） */
const collapsedRepos = ref(new Set())
const isCollapsed = (repo) => collapsedRepos.value.has(repo)
function toggleCollapse(repo) {
  const next = new Set(collapsedRepos.value)
  next.has(repo) ? next.delete(repo) : next.add(repo)
  collapsedRepos.value = next
}
const allCollapsed = computed(() =>
  filteredGroups.value.length > 0 && filteredGroups.value.every((g) => collapsedRepos.value.has(g.repo))
)
function toggleAllGroups() {
  collapsedRepos.value = allCollapsed.value
    ? new Set()
    : new Set(filteredGroups.value.map((g) => g.repo))
}

const chartPalette = computed(() => state.ui.theme === 'dark'
  ? { text: '#A1A7B2', border: '#30343B', surface: '#181A1E', accent: '#72CBB9', area: '#19372F' }
  : { text: '#71717A', border: '#E5E7EB', surface: '#FFFFFF', accent: '#0E7A6D', area: '#E7F2F0' })
const chartTooltip = computed(() => ({ backgroundColor: chartPalette.value.surface, borderColor: chartPalette.value.border, textStyle: { color: chartPalette.value.text, fontSize: 12 } }))
const projectBarOption = computed(() => {
  const top = filteredGroups.value.slice(0, 12).reverse()
  return {
    tooltip: { ...chartTooltip.value, trigger: 'axis', axisPointer: { type: 'shadow' } },
    // containLabel：grid 自动为 y 轴项目名让出空间，长名不再被裁剪
    grid: { left: 16, right: 40, top: 10, bottom: 10, containLabel: true },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: chartPalette.value.text },
      splitLine: { lineStyle: { color: chartPalette.value.border } },
      // 留 25% 余量：柱子不顶满格，数值 label 不贴边（日报单项目时尤其明显）
      max: ({ max }) => Math.max(Math.ceil((max || 5) * 1.25), 5),
    },
    yAxis: {
      type: 'category',
      data: top.map((g) => g.project),
      axisLabel: {
        color: chartPalette.value.text,
        fontSize: 11,
        formatter: (v) => (v.length > 22 ? `${v.slice(0, 21)}…` : v),
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [{
      type: 'bar',
      data: top.map((g) => g.commits.length),
      barMaxWidth: 20,
      itemStyle: {
        borderRadius: [0, 4, 4, 0],
        color: chartPalette.value.accent,
      },
      label: {
        show: true,
        position: 'right',
        color: chartPalette.value.text,
        fontSize: 11,
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 600,
      },
    }],
  }
})

const trendOption = computed(() => {
  const m = new Map()
  filteredCommits.value.forEach((c) => m.set(c.date, (m.get(c.date) || 0) + 1))
  const sorted = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const dates = sorted.map((e) => e[0].slice(5))
  const counts = sorted.map((e) => e[1])
  // 单日/两天数据下折线退化为孤点（无线段、面积不可见、点被边缘裁剪）→ 改用柱状呈现
  if (sorted.length < 3) {
    return {
      tooltip: { ...chartTooltip.value, trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { left: 34, right: 20, top: 24, bottom: 10, containLabel: true },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { color: chartPalette.value.text, fontSize: 11 },
        axisLine: { lineStyle: { color: chartPalette.value.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        max: ({ max }) => Math.max(Math.ceil((max || 5) * 1.3), 4),
        axisLabel: { color: chartPalette.value.text, fontSize: 11 },
        splitLine: { lineStyle: { color: chartPalette.value.border } },
      },
      series: [{
        type: 'bar',
        data: counts,
        barMaxWidth: 36,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: chartPalette.value.accent,
        },
        label: {
          show: true,
          position: 'top',
          color: chartPalette.value.text,
          fontSize: 11,
          fontFamily: "'IBM Plex Mono', monospace",
          fontWeight: 600,
        },
      }],
    }
  }
  return {
    tooltip: { ...chartTooltip.value, trigger: 'axis' },
    grid: { left: 34, right: 20, top: 24, bottom: 10, containLabel: true },
    xAxis: {
      type: 'category',
      data: dates,
      // 默认 boundaryGap（true）：首尾点不贴边，symbol/面积不被裁剪
      axisLabel: { color: chartPalette.value.text, fontSize: 11 },
      axisLine: { lineStyle: { color: chartPalette.value.border } },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      axisLabel: { color: chartPalette.value.text, fontSize: 11 },
      splitLine: { lineStyle: { color: chartPalette.value.border } },
    },
    series: [{
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      data: counts,
      lineStyle: { width: 2, color: chartPalette.value.accent },
      itemStyle: { color: chartPalette.value.accent, borderColor: chartPalette.value.surface, borderWidth: 2 },
      areaStyle: { color: chartPalette.value.area },
    }],
  }
})

function getTitle() {
  const map = {
    daily: `全部项目日报 — ${dailyDate.value}`,
    weekly: `全部项目周报 — ${rangeLabel.value}`,
    biweekly: `全部项目双周报 — ${rangeLabel.value}`,
    monthly: `全部项目月报 — ${rangeLabel.value}`,
    custom: `全部项目报告 — ${rangeLabel.value}`,
  }
  return map[period.value]
}

function getMarkdown() {
  return buildMarkdown({
    title: getTitle(),
    subtitle: `项目范围：全部项目 · Git 活动源：${scopedRepos.value.length} 个 · 作者：${onlyMine.value ? `本人(${(state.config.identities || []).length}个账号)` : '全部作者'}`,
    commits: filteredCommits.value,
    stats: {
      commitCount: filteredCommits.value.length,
      projectCount: filteredGroups.value.length,
      authorCount: authorCount.value,
    },
  })
}

/** 生成完成后自动保存到历史记录 */
async function autoSave() {
  try {
    await window.gitReport.saveReportAuto({
      title: getTitle(),
      content: getMarkdown(),
      period: period.value,
      dateRange: rangeLabel.value,
      commitCount: filteredCommits.value.length,
      projectCount: filteredGroups.value.length,
      projectId: '',
    })
    loadHistory()
  } catch (e) {
    console.error('自动保存历史失败', e)
  }
}

async function loadHistory() {
  historyLoading.value = true
  historyError.value = ''
  try {
    historyList.value = await window.gitReport.listHistory()
  } catch { historyError.value = '历史报告加载失败，请重试。' }
  finally { historyLoading.value = false }
}

async function viewHistory(row) {
  try {
    const data = await window.gitReport.readHistory(row.id)
    if (data) historyDialog.value = { visible: true, title: data.title, content: data.content }
    else ElMessage.warning('这份报告已不存在，请刷新历史记录')
  } catch { ElMessage.error('读取报告失败，请重试') }
}

async function copyText(text) {
  try {
    await window.gitReport.copyText(text)
    ElMessage.success('已复制到剪贴板')
  } catch (e) {
    console.error('复制失败', e)
    ElMessage.error('复制失败，请重试')
  }
}

/** 复制单个项目的提交内容（去掉日期、项目名称与 feat:/fix: 等类型前缀） */
function copyProject(g) {
  const lines = g.commits.map((c, i) => `${i + 1}. ${stripPrefix(c.subject)}`)
  copyText(lines.join('\n'))
}

/** 复制整个报告（Markdown 全文） */
function copyReport() {
  copyText(getMarkdown())
}

async function delHistory(row) {
  try {
    await ElMessageBox.confirm('确定删除这条历史记录吗？', '删除确认', { type: 'warning' })
  } catch {
    return
  }
  try {
    await window.gitReport.deleteHistory(row.id)
    await loadHistory()
  } catch { ElMessage.error('删除失败，请重试') }
}

async function exportReport() {
  const md = getMarkdown()
  // \r 一并剔除：CRLF 行尾会把 \r 带进文件名，Windows 下保存对话框直接报错
  const safeName = getTitle().replace(/[\r\n\\/:*?"<>|]/g, '_')
  const res = await window.gitReport.saveReport(`${safeName}.md`, md)
  if (res?.saved) {
    ElMessage.success(`已保存：${res.path}`)
    const opened = await window.gitReport.openPath(res.path)
    if (opened && opened.ok === false) ElMessage.warning('文件已在对话框位置保存，但在系统中未找到')
  }
}
</script>

<style scoped>
.report-page { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 0; padding: 0 24px; color: var(--brand-text); }
.topbar-page { display: flex; align-items: center; gap: 16px; width: 100%; }
.page-scope { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.page-primary { margin-left: auto; }
.page-primary .el-icon { margin-right: 8px; }
.report-toolbar-card { flex-shrink: 0; padding: 12px 0; min-height: 64px; }
.report-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 32px; }
.toolbar-left { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.period-select { width: 104px; }
.author-select { width: 140px; }
.toolbar-left :deep(.el-date-editor) { width: 164px; }
.repo-count, .range-label, .range-sep { color: var(--text-muted); font-size: 12px; font-family: inherit; white-space: nowrap; }
.author-filter-row { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--line-soft); }
.warn { margin-top: 12px; }
.stale-alert { margin-bottom: 12px; }
.report-results { flex: 0 0 auto; padding: 0; overflow: visible; }
.phase-card { background: var(--surface-subtle); padding: 16px; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 12px; }
.report-tabs { flex: 1; min-height: 0; }
.report-tabs :deep(.el-tabs__header) { display: block !important; height: 44px; margin: 0; }
.report-tabs :deep(.el-tabs__item) { height: 44px; padding: 0 12px; font-size: 13px; font-weight: 400; }
.report-tabs :deep(.el-tabs__item.is-active) { font-weight: 600; }
.report-tabs :deep(.el-tabs__content) { display: flex; flex-direction: column; min-height: 0; flex: 1; padding: 0; overflow: auto; }
.report-tabs :deep(.el-tab-pane) { min-height: 0; }
.report-tabs :deep(#pane-history) { display: flex; flex-direction: column; flex: 1; }
.history-toolbar { display: flex; align-items: center; gap: 12px; padding: 12px 0; flex-shrink: 0; }
.history-search { width: 260px; }
.history-count { margin-left: auto; color: var(--text-muted); font-size: 12px; }
.history-period { width: 112px; }
.history-table { flex: 1; min-height: 120px; font-size: 12px; }
.history-table :deep(.el-table__cell) { height: 40px; padding: 4px 0; }
.history-table :deep(.el-table__header .el-table__cell) { height: 36px; }
.history-table :deep(.cell) { padding: 0 16px; }
.history-table :deep(.el-table__row) { cursor: default; }
.row-more { padding: 4px; width: 28px; height: 28px; }
.history-footer { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-height: 56px; flex-shrink: 0; border-top: 1px solid var(--line-soft); font-size: 12px; color: var(--text-muted); }
.history-footer :deep(.el-pager li), .history-footer :deep(.btn-prev), .history-footer :deep(.btn-next) { min-width: 32px; height: 32px; border-radius: 6px; font-weight: 400; }
.history-footer :deep(.el-pager li.is-active) { border: 1px solid var(--line); color: var(--brand-text); background: var(--surface); }
.detail-toolbar { min-height: 56px; margin: 0; }
.detail-summary { font-size: 12px; font-family: inherit; color: var(--text-muted); }
.detail-actions .el-button + .el-button { margin-left: 0; }
.report-detail-list { gap: 0; }
.project-card { padding: 0; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: var(--surface); }
.project-header { margin: 0; min-height: 44px; padding: 0 12px; border-radius: 4px; }
.project-header:hover { background: var(--surface-subtle); }
.project-header:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.project-name { font-size: 13px; }
.project-count, .fold-icon { color: var(--text-muted); font-size: 12px; }
.commit-list { padding: 0 12px 8px; }
.commit-row { padding: 8px 0; border-bottom: 1px solid var(--line-soft); min-height: 36px; }
.commit-subject { font-size: 13px; color: var(--brand-text); }
.commit-date, .commit-no { color: var(--text-muted); }
.collect-hint { padding: 32px 0; text-align: center; color: var(--text-muted); font-size: 13px; }
.stats { margin: 16px 0 24px !important; }
.stats :deep(.el-col) { padding: 0 !important; }
.kpi-card { padding: 12px 20px; border: 0; border-right: 1px solid var(--line); background: var(--surface); border-radius: 0; box-shadow: none; }
.stats :deep(.el-col:last-child) .kpi-card { border-right: 0; }
.kpi-card:hover { box-shadow: none; transform: none; }
.kpi-icon { display: none; }
.kpi-value { font-size: 24px; color: var(--brand-text); }
.kpi-range { font-size: 14px; }
.kpi-label { color: var(--text-muted); }
.charts :deep(.el-card) { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
.charts :deep(.el-card__header) { font-size: 14px; padding: 16px; border-color: var(--line); }
.charts :deep(.el-card__body) { padding: 16px; }
.history-content { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--brand-mono, monospace); font-size: 12px; line-height: 1.7; color: var(--brand-text); max-height: 62vh; overflow: auto; background: var(--surface-subtle); border: 1px solid var(--line); border-radius: 6px; padding: 16px; }
.report-context-menu { position: fixed; z-index: 2500; width: 176px; padding: 4px; background: var(--surface); color: var(--brand-text); border: 1px solid var(--line-strong); border-radius: 6px; box-shadow: 0 4px 16px #00000018; }
.report-context-menu button { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; border: 0; border-radius: 4px; background: transparent; color: inherit; min-height: 32px; padding: 0 8px; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.report-context-menu button:hover { background: var(--surface-subtle); }
.report-context-menu button:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.report-context-menu button span { font-size: 11px; color: var(--text-muted); }
.report-context-menu button.is-danger { color: var(--danger); border-top: 1px solid var(--line); margin-top: 4px; }
@media (max-width: 1280px) {
  .report-page { padding: 0 16px; }
  .toolbar-left { gap: 8px; }
  .history-table :deep(.cell) { padding: 0 12px; }
}
</style>
