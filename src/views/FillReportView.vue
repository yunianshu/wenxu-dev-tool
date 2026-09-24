<template>
  <div class="fill-page">
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">一键填报</h1>
        <span class="page-scope">{{ fillDate }}</span>
        <el-button :type="plan ? 'default' : 'primary'" class="page-primary" :loading="state.fillReport.running" :disabled="!canGenerate" @click="generate">
          <el-icon><component :is="plan ? 'Refresh' : 'MagicStick'" /></el-icon><span>{{ plan ? '重新生成' : '生成报告' }}</span>
        </el-button>
      </div>
    </Teleport>

    <div class="fill-scroll">
      <section class="fill-toolbar">
        <div class="fill-group">
          <el-date-picker v-model="fillDate" type="date" value-format="YYYY-MM-DD" :clearable="false" :disabled="state.fillReport.submitting" :disabled-date="(d) => d.getTime() > Date.now()" :shortcuts="dateShortcuts" aria-label="填报日期" class="fill-date" />
          <el-time-select v-model="startTime" start="06:00" end="21:00" step="00:15" :clearable="false" :disabled="state.fillReport.submitting" placeholder="上班时间" aria-label="上班时间" class="fill-start" />
          <span class="time-separator">至</span>
          <el-time-select v-model="endTime" start="00:00" end="23:45" step="00:15" clearable :disabled="state.fillReport.submitting" class="fill-end" :placeholder="endPlaceholder" aria-label="下班时间，留空使用当前时间" />
        </div>
        <span class="fill-range-tip">午休 {{ state.config.zentao?.lunchStart || '12:00' }}–{{ state.config.zentao?.lunchEnd || '13:00' }} · {{ rangePreview }}</span>
      </section>

      <div class="fill-notices">
        <el-alert v-if="!zentaoConfigured" type="warning" :closable="false" show-icon title="禅道未配置：绑定项目与提交工时需要禅道地址与账号。">
          <el-button text @click="emit('navigate', 'fill-settings')">去设置</el-button>
        </el-alert>
        <el-alert v-else-if="plan?.ztError" type="error" :closable="false" show-icon :title="`禅道任务获取失败：${plan.ztError}`" />
        <el-alert v-if="!hanprintConfigured" type="info" :closable="false" title="汉印平台未配置，本次只填报禅道工时。" />
        <el-alert v-else-if="plan?.hpError" type="error" :closable="false" :title="`汉印任务获取失败：${plan.hpError}`" />
        <el-alert v-if="identitiesMissing" type="info" :closable="false" title="尚未配置本人身份，请到「设置 → 个人身份」添加 Git 账号。" />
        <el-alert v-if="plan && plan.date !== fillDate" type="info" :closable="false" show-icon :title="`当前明细仍为 ${plan.date} 的计划，请重新生成 ${fillDate} 的报告。`" />
        <el-alert v-if="plan && unmatchedCount" type="warning" :closable="false" show-icon class="binding-warning">
          <template #title><span>{{ unmatchedCount }} 个已选项目未绑定禅道任务，绑定后即可提交。</span></template>
          <el-button text :disabled="!zentaoConfigured || state.fillReport.running || state.fillReport.submitting" @click="locateUnbound">定位未绑定<el-icon><ArrowRight /></el-icon></el-button>
        </el-alert>
      </div>

      <div v-if="state.fillReport.running" class="fill-phase" role="status"><el-icon class="is-loading"><Loading /></el-icon><span>正在获取提交并计算工时…</span></div>
      <div v-if="!plan && !state.fillReport.running" class="fill-empty">
        <el-icon><Document /></el-icon>
        <h2>生成当天的提交明细</h2>
        <p>{{ !canGenerate && !fillableProjects.some((p) => p.repoCount > 0) ? '请先在项目中关联 Git 活动源，再生成填报报告。' : '汇总完成后选择项目、确认工时与任务绑定。' }}</p>
      </div>

      <div v-if="plan" class="fill-workspace">
        <section class="fill-detail">
          <div class="section-head">
            <h2>提交明细 <span class="plan-date">{{ plan.date }}</span></h2>
            <div class="detail-selection">
              <span>已选 {{ plan.planned.length }}/{{ dayProjects.length }} 个项目 · {{ plan.commitCount }} 条提交</span>
              <el-popover placement="bottom-end" :width="360" trigger="click">
                <template #reference><el-button text aria-label="调整填报项目"><el-icon><Filter /></el-icon></el-button></template>
                <div class="project-picker-title">选择填报项目</div>
                <el-select v-model="selectedProjectIds" :disabled="state.fillReport.submitting || state.fillReport.running" multiple filterable collapse-tags collapse-tags-tooltip :max-collapse-tags="2" placeholder="选择要填报的项目" class="project-select">
                  <el-option v-for="p in fillableProjects" :key="p.id" :value="p.id" :label="p.name" :disabled="p.repoCount === 0">
                    <div class="project-option"><span class="project-option-name">{{ p.name }}</span><span class="project-option-meta">{{ bindings[p.id] ? `已绑定 #${bindings[p.id].taskId}` : p.repoCount === 0 ? '无仓库' : '未绑定' }}</span></div>
                  </el-option>
                </el-select>
                <p class="bind-hint">勾选变化会重新计算工时与汉印占比。</p>
              </el-popover>
            </div>
          </div>
          <div v-if="dayProjects.length" class="plan-list">
            <div v-for="p in dayProjects" :key="p.projectId" class="prow" :class="{ unbound: !p.taskId, 'prow-off': !p.selected, 'is-expanded': expandedProjects.has(p.projectId) }">
              <div class="pline">
                <el-checkbox class="pcheck" :model-value="p.selected" :aria-label="`填报 ${p.projectName}`" :disabled="state.fillReport.running || state.fillReport.submitting" @change="(v) => toggleProject(p.projectId, v)" />
                <button class="project-detail-toggle" :aria-expanded="expandedProjects.has(p.projectId)" @click="toggleProjectDetail(p.projectId)">
                  <span class="pname">{{ p.projectName }}</span><span class="pproj">{{ p.commitCount }} 条提交</span>
                </button>
                <span class="phours">{{ p.selected ? `${Number(p.hours || 0).toFixed(2)}h` : '未选' }}</span>
                <el-button class="bind-button" :disabled="!zentaoConfigured || state.fillReport.running || state.fillReport.submitting" :title="p.taskId ? `${p.taskName || '已绑定任务'}，点击管理绑定` : '为该项目绑定禅道任务'" @click="openBind(p.projectId)"><el-icon><Link /></el-icon><span>{{ p.taskId ? `禅道 #${p.taskId}` : '绑定禅道任务' }}</span></el-button>
              </div>
              <div v-if="expandedProjects.has(p.projectId)" class="project-work"><div class="project-work-title">{{ p.projectName }} · {{ p.commitCount }} 条提交</div><pre class="pwork">{{ p.work }}</pre></div>
            </div>
          </div>
          <div v-else class="collect-hint">{{ plan.identitiesMissing ? '请先配置本人身份' : `${plan.date} 没有你的提交记录，可改选日期后重新生成。` }}</div>
          <p v-if="skippedProjects.length" class="selection-hint">{{ skippedProjects.length }} 个项目未选，不计入本次工时与汉印占比。</p>
          <p v-if="dayProjects.length && !plan.planned.length" class="submit-hint">勾选项目后计算工时并生成提交汇总。</p>
        </section>

        <aside class="fill-summary">
          <h2>提交汇总</h2>
          <div class="summary-total"><span>选中项目工时</span><strong>{{ totalHours }} <small>h</small></strong></div>
          <el-tag v-if="plan.submittedAt" type="success" size="small" class="submitted-tag">已于 {{ plan.submittedAt }} 提交</el-tag>
          <section class="summary-section">
            <h3>禅道任务</h3>
            <div v-for="t in plan.tasks" :key="t.taskId" class="sumline">
              <div class="sum-name">#{{ t.taskId }} {{ t.taskName || '任务已不在「我的任务」列表' }}</div>
              <div class="sum-meta"><span>{{ t.consumed }}h</span><span v-if="t.taskLeft !== null">剩余 {{ t.taskLeft }}h → {{ t.left }}h</span></div>
              <span v-if="t.existingToday?.count" class="update-hint">当日已有 {{ t.existingToday.count }} 条（{{ t.existingToday.consumed }}h），将更新</span>
            </div>
            <p v-if="!plan.tasks.length" class="summary-empty">{{ plan.planned.length ? '绑定项目后显示任务汇总' : '尚未选择填报项目' }}</p>
            <p v-if="unmatchedCount" class="submit-hint">{{ unmatchedCount }} 个项目待绑定</p>
          </section>
          <section class="summary-section">
            <h3>汉印工时填报</h3>
            <template v-if="plan.hpItems?.length">
              <div v-for="(item, i) in plan.hpItems" :key="i" class="hpline"><span>{{ item.ProjectName }}</span><span class="sum-meta">{{ item.TaskName }} · {{ item.Percent }}%<span v-if="isHpExisting(item)" class="update-hint"> · 已填，将更新</span></span></div>
              <p class="summary-empty">{{ plan.hpItems.length }} 条 · 占比合计 {{ hpPercentTotal }}%<template v-if="hpExistingCount"> · {{ hpExistingCount }} 条将更新</template></p>
            </template>
            <p v-else class="summary-empty">{{ hanprintConfigured ? '暂无可写入的占比条目' : '未配置，本次只提交禅道' }}</p>
            <p v-if="hanprintConfigured && plan.tasks.length && plan.hpUnmatched?.length" class="submit-hint">未匹配汉印任务，仅写入禅道：#{{ plan.hpUnmatched.join('、#') }}</p>
            <p v-if="plan.hpZeroSkipped" class="summary-empty">{{ plan.hpZeroSkipped }} 个任务占比为 0%，不写入汉印。</p>
          </section>
        </aside>
      </div>

      <section class="fill-history">
        <div class="section-head"><h2>提交记录</h2><span class="history-meta">最近 {{ submitLogs.length }} 条记录</span></div>
        <el-alert v-if="logsError" type="error" :closable="false" :title="logsError"><el-button text @click="loadLogs">重试</el-button></el-alert>
        <el-table v-loading="logsLoading" :data="submitLogs" class="fill-log-table" row-key="at" max-height="280">
          <el-table-column label="提交时间" min-width="180"><template #default="{ row }">{{ (row.at || '').slice(0, 19) }}</template></el-table-column>
          <el-table-column label="禅道" width="120"><template #default="{ row }">{{ row.tasks?.length || 0 }}/{{ row.ztTotal || 0 }}</template></el-table-column>
          <el-table-column label="汉印" width="120"><template #default="{ row }">{{ row.hp?.error ? '失败' : row.hp?.sent ? `${row.hp.sent} 条` : '—' }}</template></el-table-column>
          <el-table-column label="状态" width="120"><template #default="{ row }"><span class="log-status" :class="{ 'is-error': row.failed }">{{ logStatus(row).text }}</span></template></el-table-column>
          <el-table-column label="备注" min-width="120" show-overflow-tooltip><template #default="{ row }">{{ row.error || row.hp?.error || '—' }}</template></el-table-column>
          <el-table-column label="操作" width="64" align="center"><template #default="{ row }">
            <el-dropdown trigger="click" :disabled="state.fillReport.submitting || state.fillReport.running || !!resubmitting || !!deleting" @command="(command) => command === 'retry' ? doResubmit(row) : doDeleteLog(row)">
              <el-button text aria-label="提交记录操作" :loading="resubmitting === row.at || deleting === row.at"><el-icon><MoreFilled /></el-icon></el-button>
              <template #dropdown><el-dropdown-menu><el-dropdown-item v-if="row.resubmittable" command="retry">重新提交</el-dropdown-item><el-dropdown-item command="delete" :divided="row.resubmittable">删除本地记录</el-dropdown-item></el-dropdown-menu></template>
            </el-dropdown>
          </template></el-table-column>
          <template #empty><div class="history-empty">暂无提交记录，完成填报后会保存在这里。</div></template>
        </el-table>
      </section>
    </div>

    <footer v-if="plan" class="fill-actions">
      <span class="action-hint" :class="{ 'is-warning': unmatchedCount }"><el-icon><Warning v-if="unmatchedCount" /><InfoFilled v-else /></el-icon>{{ unmatchedCount ? `还有 ${unmatchedCount} 个项目待绑定，绑定后可提交` : plan.submittedAt ? `已于 ${plan.submittedAt} 提交` : '预览仅检查提交内容，不会写入平台' }}</span>
      <el-button :disabled="!plan.planned.length || state.fillReport.running" @click="copyReport"><el-icon><CopyDocument /></el-icon><span>复制报告</span></el-button>
      <el-button :disabled="!canSubmit" @click="submitFill(true)"><el-icon><View /></el-icon><span>预览提交</span></el-button>
      <el-button type="primary" :disabled="!canSubmit || !!plan.submittedAt" :loading="state.fillReport.submitting" @click="submitFill(false)"><el-icon><Position /></el-icon><span>{{ plan.submittedAt ? '已提交' : '一键提交' }}</span></el-button>
    </footer>

    <el-drawer v-model="bindDialog.visible" :title="bindDialog.boundTaskId ? '管理任务绑定' : '绑定禅道任务'" size="480px" class="fill-bind-drawer">
      <div class="bind-project-name">{{ bindDialog.projectName }}</div>
      <p class="bind-hint">绑定后在后续填报中自动沿用，可随时更换。</p>
      <el-input v-model="bindSearch" clearable placeholder="搜索任务名称或编号" aria-label="搜索禅道任务"><template #prefix><el-icon><Search /></el-icon></template></el-input>
      <el-select v-model="bindStatus" class="bind-status" aria-label="任务状态"><el-option label="全部任务" value="all" /><el-option label="进行中" value="doing" /><el-option label="已完成（近一个月）" value="finished" /></el-select>
      <div v-loading="bindDialog.loading" ref="bindTaskList" class="bind-tasks" role="radiogroup" aria-label="禅道任务" @keydown="moveBindTaskFocus">
        <button v-for="t in filteredBindTasks" :key="t.id" type="button" class="bind-task" :class="{ 'is-selected': bindDialog.taskId === t.id }" role="radio" :aria-checked="bindDialog.taskId === t.id" @click="bindDialog.taskId = t.id">
          <span class="task-radio" /><span class="task-description"><strong>#{{ t.id }} {{ t.name }}</strong><span>{{ taskMeta(t) }}</span></span>
        </button>
        <p v-if="!bindDialog.loading && !filteredBindTasks.length" class="collect-hint">{{ bindSearch ? '没有匹配的任务' : '暂无可绑定任务，请检查禅道任务与账号配置。' }}</p>
      </div>
      <p v-if="bindDialog.taskId" class="bind-selection">已选择 #{{ bindDialog.taskId }} {{ selectedBindTask?.name || '' }}</p>
      <p v-if="bindDialog.boundTaskId" class="bind-hint">解除绑定后，该项目需重新绑定才能填报。</p>
      <template #footer><el-button v-if="bindDialog.boundTaskId" text type="danger" @click="doUnbind">解除绑定</el-button><el-button @click="bindDialog.visible = false">取消</el-button><el-button type="primary" :disabled="!bindDialog.taskId" @click="doBind"><el-icon><Link /></el-icon><span>确认绑定</span></el-button></template>
    </el-drawer>
    <el-dialog v-model="previewDialog.visible" title="提交预览 · 尚未写入平台" width="720" top="6vh"><pre class="preview-content">{{ previewDialog.content }}</pre></el-dialog>
  </div>
</template>
<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { todayStr } from '../utils/date'
import { toPlain } from '../utils/ipc'
import { reposForProject } from '../utils/project-context'
import { useProjects } from '../composables/useProjects'

const emit = defineEmits(['navigate'])
const { loadProjects } = useProjects()
const topbarReady = useTopbarReady()

/** 跨视图保留：所选项目存共享状态，切换视图再回来不丢 */
const selectedProjectIds = computed({
  get: () => state.fillReport.selectedIds || [],
  set: (v) => { state.fillReport.selectedIds = v || [] },
})
const bindings = ref({})
const bindDialog = ref({ visible: false, projectId: '', projectName: '', taskId: null, boundTaskId: null, options: [], loading: false })
const bindSearch = ref('')
const bindStatus = ref('all')
const bindTaskList = ref(null)
const selectedBindTask = computed(() => bindDialog.value.options.find((task) => task.id === bindDialog.value.taskId))
const filteredBindTasks = computed(() => {
  const search = bindSearch.value.trim().toLocaleLowerCase()
  return (bindDialog.value.options || []).filter((task) =>
    (!search || `${task.id} ${task.name}`.toLocaleLowerCase().includes(search)) &&
    (bindStatus.value === 'all' || (bindStatus.value === 'finished' ? task.finished : !task.finished)),
  )
})
function moveBindTaskFocus(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !filteredBindTasks.value.length) return
  event.preventDefault()
  const tasks = filteredBindTasks.value
  const index = tasks.findIndex((task) => task.id === bindDialog.value.taskId)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tasks.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + tasks.length) % tasks.length
  bindDialog.value.taskId = tasks[next].id
  bindTaskList.value?.querySelectorAll('button')[next]?.focus()
}
const previewDialog = ref({ visible: false, content: '' })
/** 提交记录（fill-log 留痕）与按记录重新提交 / 删除记录 */
const submitLogs = ref([])
const logsLoading = ref(false)
const logsError = ref('')
const resubmitting = ref('')
const deleting = ref('')
/** 生成/重算进行中收到的重算请求：结束后补跑一次 */
let pendingRecompute = false

const ZT_STATUS_TEXT = { wait: '未开始', doing: '进行中', done: '已完成', pause: '已暂停', cancel: '已取消', closed: '已关闭' }
function statusText(s) { return ZT_STATUS_TEXT[s] || s || '-' }
/** 选项右侧说明：进行中给剩余工时，已完成给完成时间（禅道没记时间时只留状态） */
function taskMeta(t) {
  if (t.finished) return t.finishedAt ? `${statusText(t.status)} · ${t.finishedAt}` : statusText(t.status)
  return `${statusText(t.status)} · 剩余 ${t.left}h`
}

const dateShortcuts = [
  { text: '今天', value: new Date() },
  { text: '昨天', value: new Date(Date.now() - 86400000) },
]

/** 跨视图保留：日期与计划存共享状态，切换视图再回来不丢 */
const fillDate = computed({
  get: () => state.fillReport.date || todayStr(),
  set: (v) => { state.fillReport.date = v },
})
/** 实际上班时间（默认取设置页配置，可按天临时调整） */
const startTime = computed({
  get: () => state.fillReport.startTime || (state.config.zentao?.workStart || '08:30'),
  set: (v) => { state.fillReport.startTime = v },
})
/**
 * 下班/加班结束时间（留空则取点击「生成报告」的当前时刻，与填报日期无关）。
 * 早于上班时间时按次日跨夜计算——例如昨天 08:30 上班、今天凌晨 00:30 收工，
 * 选昨天日期 + 填 00:30 即 15h。
 */
const endTime = computed({
  get: () => state.fillReport.endTime || '',
  set: (v) => { state.fillReport.endTime = v || '' },
})
const endPlaceholder = '下班（现在）'

function hmOf(s) {
  const [h, m] = String(s || '').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
function nowHM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** 与主进程 distributeByProject 同口径：区间分钟数扣午休、0.5h 向下取整 */
function previewMinutes(start, end, crossDay) {
  const s = hmOf(start)
  let e = hmOf(end)
  if (crossDay) e += 24 * 60
  if (e <= s) return 0
  const lunchS = hmOf(state.config.zentao?.lunchStart || '12:00')
  const lunchE = hmOf(state.config.zentao?.lunchEnd || '13:00')
  return (e - s) - Math.max(0, Math.min(e, lunchE) - Math.max(s, lunchS))
}
/** 工具条实时预览：区间与预计工时，让跨夜/误填立刻可见 */
const rangePreview = computed(() => {
  const start = startTime.value || '08:30'
  const end = effectiveEnd()
  const crossDay = effectiveCrossDay()
  const min = previewMinutes(start, end, crossDay)
  const hours = (Math.floor(min / 30) * 30 / 60).toFixed(1)
  return `${start}–${crossDay ? '次日 ' : ''}${end} · 预计 ${hours}h`
})
const plan = computed(() => state.fillReport.plan)

/**
 * 重算用的终点：显式填写优先，留空时沿用计划里已解析的终点。
 * 留空语义是「生成那一刻」，只解析一次——否则每次重算都取当前时刻，工时随挂机时间悄悄变多。
 */
function effectiveEnd() {
  return endTime.value || (plan.value && plan.value.rangeEnd) || nowHM()
}
/** 跨夜判定：显式填写的终点早于上班时间才是用户表达的「次日」；终点留空时沿用上次判定 */
function effectiveCrossDay() {
  const start = startTime.value || '08:30'
  if (endTime.value) return hmOf(endTime.value) < hmOf(start)
  return plan.value ? !!plan.value.crossDay : hmOf(effectiveEnd()) < hmOf(start)
}

const zentaoConfigured = computed(() => {
  const zt = state.config.zentao || {}
  return !!(zt.baseUrl && zt.account && zt.pwdConfigured)
})
const hanprintConfigured = computed(() => {
  const hp = state.config.hanprint || {}
  return !!(hp.baseUrl && hp.account && hp.pwdConfigured)
})
const identitiesMissing = computed(() => !(state.config.identities || []).length)

/** 可填报项目：附带其覆盖的仓库数（0 时禁止选择） */
const fillableProjects = computed(() =>
  state.projects.items
    .filter((p) => p.localPath)
    .map((p) => ({ ...p, repoCount: reposForProject(p, state.discoveredRepos).length })),
)

const canGenerate = computed(() => !!(fillDate.value && !state.fillReport.submitting && fillableProjects.value.some((p) => p.repoCount > 0)))
const canSubmit = computed(() => !!(plan.value && plan.value.tasks.length && !state.fillReport.submitting && !state.fillReport.running && !plan.value.ztError && !unmatchedCount.value && zentaoConfigured.value))
const unmatchedCount = computed(() => (plan.value ? plan.value.planned.filter((p) => !p.taskId).length : 0))
/** 当天有提交的全部项目（生成报告后由主进程带回），勾选决定哪些计入填报 */
const dayProjects = computed(() => {
  const p = plan.value
  if (!p) return []
  return Array.isArray(p.dayProjects) ? p.dayProjects : p.planned
})
const skippedProjects = computed(() => dayProjects.value.filter((p) => !p.selected))
const expandedProjects = ref(new Set())
watch(() => dayProjects.value.map((p) => p.projectId).join(','), () => {
  const ids = new Set(dayProjects.value.map((p) => p.projectId))
  const next = new Set([...expandedProjects.value].filter((id) => ids.has(id)))
  if (!next.size && dayProjects.value.length) next.add(dayProjects.value[0].projectId)
  expandedProjects.value = next
}, { immediate: true })
function toggleProjectDetail(projectId) {
  const next = new Set(expandedProjects.value)
  next.has(projectId) ? next.delete(projectId) : next.add(projectId)
  expandedProjects.value = next
}
function locateUnbound() {
  const project = dayProjects.value.find((p) => p.selected && !p.taskId)
  if (project) openBind(project.projectId)
}
const totalHours = computed(() =>
  plan.value ? (Math.round(plan.value.planned.reduce((s, p) => s + p.hours, 0) * 100) / 100).toFixed(2) : '0.00',
)
const hpPercentTotal = computed(() =>
  plan.value && Array.isArray(plan.value.hpItems)
    ? plan.value.hpItems.reduce((s, item) => s + (item.Percent || 0), 0)
    : 0,
)
const hpExistingCount = computed(() => {
  const p = plan.value
  if (!p || !Array.isArray(p.hpExisting) || !Array.isArray(p.hpItems)) return 0
  return p.hpItems.filter((item) => p.hpExisting.some((e) => e.taskId === String(item.TaskId))).length
})
const ztExistingCount = computed(() =>
  plan.value ? (plan.value.tasks || []).filter((t) => t.existingToday && t.existingToday.count).length : 0,
)

function isHpExisting(item) {
  const p = plan.value
  if (!p || !Array.isArray(p.hpExisting)) return false
  return p.hpExisting.some((e) => e.taskId === String(item.TaskId))
}

/**
 * 勾选变化 → 按新的项目子集重算工时与汉印占比（复用上次采集，不重复跑 git 与平台接口）。
 * 与当前计划一致的选择（含计划写回）直接跳过，避免自我触发。
 */
const stopSelectionWatch = watch(
  () => state.fillReport.selectedIds,
  (v) => {
    if (!plan.value || !Array.isArray(v)) return
    if (JSON.stringify(v) === JSON.stringify(plan.value.selectedIds || [])) return
    recomputePlan()
  },
)

/** 上班/下班时间改动 → 按同一份采集数据重算工时（生成的合计、禅道备注、汉印占比一并跟着变） */
let timeWatchTimer = null
watch([startTime, endTime], () => {
  if (!plan.value) return
  clearTimeout(timeWatchTimer)
  timeWatchTimer = setTimeout(recomputePlan, 300)
})
onBeforeUnmount(() => clearTimeout(timeWatchTimer))

onMounted(async () => {
  loadProjects()
  loadLogs()
  try {
    bindings.value = await window.gitReport.fillBindings()
  } catch { /* noop */ }
})

/** 提交记录面板：时间 + 状态 + 分项计数 + 错误原文；失败记录可按存档载荷重放，记录可删除 */
async function loadLogs() {
  logsLoading.value = true
  logsError.value = ''
  try {
    const r = await window.gitReport.fillLog(20)
    if (r.ok) submitLogs.value = r.entries || []
    else logsError.value = r.error || '提交记录加载失败，请重试。'
  } catch { logsError.value = '提交记录加载失败，请重试。' }
  finally { logsLoading.value = false }
}

function logStatus(log) {
  return log.failed ? { type: 'danger', text: '失败' } : { type: 'success', text: '成功' }
}

/** 按留痕记录重新提交：重放当时存档的载荷；禅道/汉印已有记录按 ID 复用更新覆盖，不重复写入 */
async function doResubmit(log) {
  if (state.fillReport.submitting || state.fillReport.running) return
  try {
    await ElMessageBox.confirm(
      `重新提交 ${log.date} 的填报（禅道 ${log.ztTotal} 个任务${log.hp && log.hp.sent ? `、汉印 ${log.hp.sent} 条` : ''}）？已写入的部分会更新覆盖，不会重复。`,
      '重新提交',
      { type: 'warning', confirmButtonText: '提交', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  if (state.fillReport.submitting || state.fillReport.running) return
  resubmitting.value = log.at
  state.fillReport.submitting = true
  try {
    const r = await window.gitReport.fillResubmit(log.at)
    if (!r.ok) {
      ElMessage.error(r.error || '重新提交失败')
      return
    }
    const updated = r.results.reduce((s, x) => s + (x.updated || 0), 0)
    const appended = r.results.reduce((s, x) => s + (x.appended || 0), 0)
    const ztText = `禅道 ${r.results.length} 个任务（更新 ${updated} 行 / 新增 ${appended} 行）`
    if (r.hp && r.hp.error) {
      ElMessage.warning({ message: `禅道已提交（${ztText}）；汉印提交失败：${r.hp.error}。可再次重新提交，已写入部分只会更新覆盖`, duration: 8000 })
    } else {
      ElMessage.success(`已重新提交：${ztText}${r.hp ? `，汉印 ${r.hp.updated + r.hp.appended} 条（更新 ${r.hp.updated} / 新增 ${r.hp.appended}）` : ''}`)
    }
    if (plan.value && plan.value.date === log.date) {
      state.fillReport.plan = { ...plan.value, submittedAt: new Date().toTimeString().slice(0, 5) }
    }
  } catch (e) {
    ElMessage.error(`重新提交失败：${e?.message || e}`)
  } finally {
    resubmitting.value = ''
    state.fillReport.submitting = false
    loadLogs()
  }
}

/** 删除一条提交记录：只清本机留痕，平台上已写入的工时不受影响 */
async function doDeleteLog(log) {
  try {
    await ElMessageBox.confirm(`删除 ${(log.at || '').slice(0, 19)} 这条提交记录？`, '删除记录', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  deleting.value = log.at
  try {
    const r = await window.gitReport.fillLogDelete(log.at)
    if (!r.ok) {
      ElMessage.error(r.error || '删除记录失败')
      return
    }
    ElMessage.success('已删除这条提交记录')
  } catch (e) {
    ElMessage.error(`删除记录失败：${e?.message || e}`)
  } finally {
    deleting.value = ''
    loadLogs()
  }
}

/** 传给主进程的项目清单：全部可填报项目（生成阶段不再要求先勾选） */
function allProjectsPayload() {
  return fillableProjects.value
    .filter((p) => p.repoCount > 0)
    .map((p) => ({ id: p.id, name: p.name, repos: reposForProject(p, state.discoveredRepos).map((r) => r.path) }))
}

/** 写入计划结果；selectedIds 落定为显式数组（此后不再套用默认选中） */
function applyPlan(r) {
  state.fillReport.plan = r
  if (Array.isArray(r.selectedIds)) state.fillReport.selectedIds = r.selectedIds
  bindings.value = { ...bindings.value, ...r.bindings }
}

/** 勾选/取消勾选某个项目（明细行复选框与顶部下拉共用同一份选择） */
function toggleProject(projectId, checked) {
  const cur = Array.isArray(state.fillReport.selectedIds) ? [...state.fillReport.selectedIds] : []
  state.fillReport.selectedIds = checked
    ? [...new Set([...cur, projectId])]
    : cur.filter((id) => id !== projectId)
}

/**
 * 用「当前工具条时间 + 上次采集的数据」重算工时与汉印占比（不重跑 git 与平台接口）。
 * 勾选项目与上下班时间的改动都走这里：两处口径必须一致，否则改完时间再勾项目会退回旧工时。
 */
async function recomputePlan() {
  const p = plan.value
  if (!p) return
  // 生成/重算进行中：记下待跑标记，结束后补跑，避免调整被静默吞掉
  if (state.fillReport.running) { pendingRecompute = true; return }
  state.fillReport.running = true
  try {
    const payload = {
      date: p.date,
      startTime: startTime.value,
      endTime: effectiveEnd(), // 终点留空时沿用计划里的终点，不随重算时刻漂移
      projects: allProjectsPayload(),
      selectedIds: state.fillReport.selectedIds,
      reuse: true, // 复用上次采集：改时间 / 改勾选都不重跑 git / 禅道 / 汉印
    }
    if (!endTime.value) payload.crossDay = effectiveCrossDay()
    const r = await window.gitReport.fillPlan(toPlain(payload))
    if (r.ok) applyPlan(r)
    else failRecompute(r.error)
  } catch (err) {
    failRecompute(err && err.message)
  } finally {
    state.fillReport.running = false
    if (pendingRecompute) { pendingRecompute = false; recomputePlan() }
  }
}

/**
 * 重算失败：勾选回退到计划里的口径并提示。
 * 不回退会留下「界面工时/占比是旧值、勾选是新值」的状态，提交时按 plan 取数，
 * 用户以为改掉了实际没有——填报数据直接落到平台，不能静默。
 */
function failRecompute(reason) {
  const current = plan.value
  if (current && Array.isArray(current.selectedIds)) state.fillReport.selectedIds = [...current.selectedIds]
  ElMessage.error(`重算失败，已保留上次计划${reason ? `：${reason}` : ''}`)
}

async function generate() {
  if (state.fillReport.running) return
  pendingRecompute = false
  state.fillReport.running = true
  try {
    const payload = {
      date: fillDate.value,
      startTime: startTime.value,
      endTime: endTime.value,
      projects: allProjectsPayload(),
      selectedIds: state.fillReport.selectedIds, // null=从未选择过 → 由主进程默认选中已绑定项目
    }
    const r = await window.gitReport.fillPlan(toPlain(payload))
    if (!r.ok) {
      ElMessage.error(r.error || '生成失败')
      return
    }
    applyPlan(r)
    if (!r.dayProjects.length && !r.identitiesMissing) {
      ElMessage.warning(`${r.date} 没有你的提交记录`)
    }
    if (r.ztError && zentaoConfigured.value) {
      ElMessage.warning(`禅道任务获取失败：${r.ztError}`)
    }
  } catch (e) {
    ElMessage.error(`生成失败：${e?.message || e}`)
  } finally {
    state.fillReport.running = false
    // 生成期间改过时间/勾选：按当前的工具条取值补算一次
    if (pendingRecompute) { pendingRecompute = false; recomputePlan() }
  }
}

/** 打开绑定弹窗；任务列表优先用计划带回的，缺失时现拉 */
async function openBind(projectId) {
  if (state.fillReport.running || state.fillReport.submitting) return
  bindSearch.value = ''
  bindStatus.value = 'all'
  const project = state.projects.items.find((p) => p.id === projectId)
  const bound = bindings.value[projectId]
  bindDialog.value = {
    visible: true,
    projectId,
    projectName: project?.name || projectId,
    taskId: bound ? bound.taskId : (plan.value?.suggested?.[projectId] || null),
    boundTaskId: bound ? bound.taskId : null,
    // 任务选择列表：进行中 + 近一个月完成的（完成后仍可能要补填工时）
    options: plan.value?.ztTaskOptions || plan.value?.ztTasks || [],
    loading: false,
  }
  if (!bindDialog.value.options.length) {
    const requestDialog = bindDialog.value
    requestDialog.loading = true
    try {
      const r = await window.gitReport.fillZtTasks()
      if (bindDialog.value !== requestDialog) return
      if (r.ok) requestDialog.options = r.tasks
      else ElMessage.error(r.error || '禅道任务获取失败')
    } catch (e) {
      if (bindDialog.value === requestDialog) ElMessage.error(`禅道任务获取失败：${e?.message || e}`)
    } finally {
      requestDialog.loading = false
    }
  }
}

async function doBind() {
  const { projectId, taskId } = bindDialog.value
  if (!projectId || !taskId) return
  const task = bindDialog.value.options.find((t) => t.id === taskId)
  const r = await window.gitReport.fillBind(projectId, taskId, task ? task.name : '')
  if (!r.ok) {
    ElMessage.error(r.error || '绑定失败')
    return
  }
  bindings.value = { ...bindings.value, [projectId]: r.binding }
  bindDialog.value.visible = false
  ElMessage.success(`已绑定 #${taskId} ${task ? task.name : ''}，后续填报自动关联`)
  // 绑定影响任务匹配与汇总，重新生成报告以刷新
  if (plan.value) generate()
}

/** 解除项目与禅道任务的绑定；下拉、明细行、绑定弹窗三处共用 */
async function unbindProject(projectId) {
  if (!projectId) return
  const name = state.projects.items.find((p) => p.id === projectId)?.name || projectId
  try {
    const r = await window.gitReport.fillUnbind(projectId)
    if (r && r.ok === false) {
      ElMessage.error('解除绑定失败')
      return
    }
  } catch (e) {
    ElMessage.error(`解除绑定失败：${e?.message || e}`)
    return
  }
  const next = { ...bindings.value }
  delete next[projectId]
  bindings.value = next
  if (bindDialog.value.projectId === projectId) {
    bindDialog.value.visible = false
    bindDialog.value.taskId = null
    bindDialog.value.boundTaskId = null
  }
  ElMessage.success(`已解除「${name}」的禅道任务绑定`)
  // 绑定影响任务匹配与汇总，重新生成报告以刷新
  if (plan.value) generate()
}

async function doUnbind() {
  await unbindProject(bindDialog.value.projectId)
}

async function submitFill(preview) {
  if (state.fillReport.submitting || state.fillReport.running) return
  const p = plan.value
  if (!p) return
  if (unmatchedCount.value) {
    ElMessage.warning(`有 ${unmatchedCount.value} 条提交未绑定禅道任务，请先绑定`)
    return
  }
  const tasks = p.tasks.map((t) => ({ taskId: t.taskId, taskName: t.taskName, rows: t.rows }))
  const hpItems = Array.isArray(p.hpItems) ? p.hpItems : []
  if (!preview) {
    const hpText = hpItems.length
      ? `，同时向汉印提交 ${hpItems.length} 条占比记录`
      : (hanprintConfigured.value
        ? `；注意：本次没有可写入汉印的占比条目${p.hpError ? `（${p.hpError}）` : '（任务未匹配或占比为 0%）'}，将只写禅道`
        : '')
    const existText = ztExistingCount.value || hpExistingCount.value
      ? `；当日已有记录将更新覆盖（禅道 ${ztExistingCount.value} 个任务、汉印 ${hpExistingCount.value} 条）`
      : ''
    try {
      await ElMessageBox.confirm(
        `将向 ${tasks.length} 个禅道任务写入 ${p.date} 共 ${totalHours.value} 小时工时${hpText}${existText}，是否继续？`,
        '确认提交',
        { type: 'warning', confirmButtonText: '提交', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
  }
  if (state.fillReport.submitting || state.fillReport.running) return
  state.fillReport.submitting = true
  try {
    const payload = { date: p.date, tasks, dryRun: preview }
    if (hpItems.length) payload.hp = { items: hpItems }
    const r = await window.gitReport.fillSubmit(toPlain(payload))
    if (!r.ok) {
      ElMessage.error(r.error || '提交失败')
      return
    }
    if (preview) {
      const hpPreview = r.hp && r.hp.json ? r.hp.json : hpItems
      previewDialog.value = {
        visible: true,
        content: `【禅道 recordEstimate】\n${JSON.stringify(r.results, null, 2)}\n\n【汉印 workhour/add】\n${JSON.stringify(hpPreview, null, 2)}`,
      }
    } else {
      state.fillReport.plan = { ...p, submittedAt: new Date().toTimeString().slice(0, 5) }
      const updated = r.results.reduce((s, x) => s + (x.updated || 0), 0)
      const appended = r.results.reduce((s, x) => s + (x.appended || 0), 0)
      const ztText = `禅道 ${r.results.length} 个任务（更新 ${updated} 行 / 新增 ${appended} 行）`
      if (r.hp && r.hp.error) {
        // 禅道已写入成功，汉印在写入阶段失败：如实分平台报告，重试只会更新覆盖不会重复
        ElMessage.warning({ message: `禅道已提交（${ztText}）；汉印提交失败：${r.hp.error}。可重新提交，已写入部分只会更新覆盖`, duration: 8000 })
      } else {
        const hpOkText = r.hp ? `，汉印 ${hpItems.length} 条（更新 ${r.hp.updated || 0} / 新增 ${r.hp.appended || 0}，工时由考勤系统次日凌晨回填）` : ''
        const hpSkipText = !r.hp && hanprintConfigured.value
          ? `；注意：汉印本次未写入${p.hpError ? `（${p.hpError}）` : '（没有可匹配的占比条目）'}`
          : ''
        ElMessage.success(`已提交：${ztText}${hpOkText}${hpSkipText}`)
      }
    }
  } catch (e) {
    ElMessage.error(`提交失败：${e?.message || e}`)
  } finally {
    state.fillReport.submitting = false
    loadLogs()
  }
}

function buildReportText() {
  const p = plan.value
  const lines = [`一键填报 · ${p.date}`, `${p.rangeStart}–${p.crossDay ? '次日 ' : ''}${p.rangeEnd} · 共 ${p.commitCount} 条提交 · ${p.planned.length} 个项目 · 合计 ${totalHours.value}h`, '']
  for (const item of p.planned) {
    lines.push(`${item.hours}h  [${item.projectName}]（${item.commitCount} 条提交）`)
    lines.push(item.work)
    lines.push('')
  }
  lines.push('按禅道任务汇总：')
  for (const t of p.tasks) {
    lines.push(`#${t.taskId} ${t.taskName}  ${t.consumed}h${t.taskLeft !== null ? `（剩余 ${t.taskLeft}h → ${t.left}h）` : ''}`)
  }
  return lines.join('\n')
}

async function copyReport() {
  try {
    await window.gitReport.copyText(buildReportText())
    ElMessage.success('已复制到剪贴板')
  } catch (e) {
    ElMessage.error('复制失败')
  }
}
</script>

<style scoped>
.fill-page { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 0 24px; color: var(--brand-text); }
.fill-page .topbar-page, .topbar-page { display: flex; align-items: center; gap: 16px; width: 100%; }
.page-scope { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.page-primary { margin-left: auto; }
.page-primary .el-icon, .fill-actions .el-button .el-icon, .bind-button .el-icon { margin-right: 8px; }
.fill-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.fill-toolbar { display: flex; align-items: center; gap: 16px; min-height: 64px; flex-wrap: wrap; padding: 12px 0; }
.fill-group { display: flex; align-items: center; gap: 12px; }
.fill-group .fill-date { width: 156px; }
.fill-group .fill-start { width: 112px; }
.fill-group .fill-end { width: 144px; }
.time-separator, .fill-range-tip { color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.fill-range-tip { margin-left: auto; }
.fill-notices { display: flex; flex-direction: column; gap: 8px; }
.fill-notices:empty { display: none; }
.fill-notices :deep(.el-alert) { min-height: 40px; padding: 8px 12px; }
.binding-warning :deep(.el-alert__content) { display: flex; align-items: center; justify-content: space-between; flex: 1; gap: 12px; }
.binding-warning :deep(.el-alert__description) { margin: 0; }
.binding-warning .el-button { height: 24px; padding: 0; }
.fill-phase { display: flex; align-items: center; gap: 12px; padding: 24px 0; font-size: 13px; color: var(--text-muted); }
.fill-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 192px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.fill-empty > .el-icon { color: var(--text-muted); font-size: 24px; margin-bottom: 12px; }
.fill-empty h2 { margin: 0; font-size: 15px; font-weight: 600; }
.fill-empty p { margin: 12px 0 0; color: var(--text-muted); font-size: 12px; }
.fill-workspace { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; margin: 20px 0 24px; min-height: 300px; }
.fill-detail { min-width: 0; }
.section-head { display: flex; align-items: center; justify-content: space-between; min-height: 32px; gap: 12px; margin-bottom: 8px; }
.section-head h2, .fill-summary h2 { margin: 0; font-size: 14px; font-weight: 600; }
.plan-date { color: var(--text-muted); font-size: 11px; font-weight: 400; margin-left: 8px; }
.detail-selection { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--text-muted); font-size: 12px; }
.detail-selection > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-selection .el-button { padding: 4px; width: 28px; }
.project-picker-title { font-weight: 600; font-size: 13px; margin-bottom: 12px; color: var(--brand-text); }
.project-select { width: 100%; }
.project-option { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.project-option-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-option-meta { color: var(--text-muted); font-size: 11px; }
.prow { border-bottom: 1px solid var(--line-soft); }
.pline { display: flex; align-items: center; gap: 12px; min-height: 68px; }
.prow-off .pname, .prow-off .phours { color: var(--text-muted); }
.pcheck { margin: 0; flex-shrink: 0; }
.project-detail-toggle { border: 0; background: none; padding: 8px 0; color: inherit; flex: 1; min-width: 0; text-align: left; cursor: pointer; font: inherit; border-radius: 4px; }
.project-detail-toggle:hover .pname { color: var(--accent-strong); }
.project-detail-toggle:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 4px; }
.pname { display: block; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pproj { display: block; margin-top: 4px; font-size: 11px; color: var(--text-muted); }
.phours { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bind-button { flex-shrink: 0; min-width: 112px; }
.project-work { padding: 16px 0 20px 28px; }
.project-work-title { font-size: 12px; margin-bottom: 8px; font-weight: 500; }
.pwork { margin: 0; font: inherit; font-size: 12px; line-height: 1.8; color: var(--text-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.selection-hint, .summary-empty, .bind-hint, .history-meta { color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.selection-hint { margin: 12px 0 0; }
.fill-summary { border-left: 1px solid var(--line); padding-left: 24px; min-width: 0; }
.fill-summary > h2 { min-height: 32px; display: flex; align-items: center; }
.summary-total { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 0 20px; }
.summary-total > span { font-size: 12px; color: var(--text-muted); }
.summary-total strong { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.summary-total small { font: inherit; }
.submitted-tag { margin-bottom: 12px; }
.summary-section { padding: 16px 0; border-top: 1px solid var(--line); }
.summary-section h3 { margin: 0 0 12px; font-size: 12px; font-weight: 600; }
.sumline { margin-bottom: 12px; }
.sumline:last-child { margin-bottom: 0; }
.sum-name, .hpline { font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.sum-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; color: var(--text-muted); font-size: 11px; margin-top: 4px; }
.update-hint { color: var(--el-color-warning); font-size: 11px; line-height: 1.5; }
.hpline { display: flex; flex-direction: column; margin-bottom: 12px; }
.summary-empty { margin: 4px 0 0; }
.submit-hint { margin: 12px 0 0; font-size: 12px; color: var(--el-color-warning); line-height: 1.6; }
.fill-history { margin: 24px 0 16px; }
.fill-log-table { font-size: 12px; }
.fill-log-table :deep(.el-table__cell) { height: 40px; padding: 4px 0; }
.fill-log-table :deep(.el-table__header .el-table__cell) { height: 36px; }
.fill-log-table :deep(.cell) { padding: 0 16px; }
.fill-log-table :deep(.el-table__body .el-button) { padding: 4px 8px; height: 28px; }
.log-status { color: var(--text-muted); }
.log-status.is-error { color: var(--danger); }
.history-empty { padding: 20px 0; color: var(--text-muted); font-size: 12px; }
.fill-actions { flex-shrink: 0; display: flex; align-items: center; gap: 8px; min-height: 64px; border-top: 1px solid var(--line); background: var(--surface); }
.fill-actions .el-button + .el-button { margin-left: 0; }
.action-hint { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; font-size: 12px; color: var(--text-muted); }
.action-hint.is-warning { color: var(--el-color-warning); }
.action-hint .el-icon { flex-shrink: 0; }
.bind-project-name { font-size: 14px; font-weight: 600; color: var(--brand-text); }
.bind-hint { margin: 12px 0 16px; }
.bind-selection { margin: 16px 0 0; color: var(--accent-strong); font-size: 12px; }
.bind-status { width: 100%; margin-top: 12px; }
.bind-tasks { margin-top: 16px; min-height: 120px; }
.bind-task { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; margin-bottom: 4px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--brand-text); text-align: left; cursor: pointer; }
.bind-task:hover { background: var(--surface-subtle); }
.bind-task.is-selected { background: var(--accent-soft); }
.bind-task:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; }
.task-radio { width: 14px; height: 14px; border: 1px solid var(--line-strong); border-radius: 50%; flex-shrink: 0; }
.bind-task.is-selected .task-radio { border-color: var(--accent-strong); background: var(--accent-strong); box-shadow: inset 0 0 0 4px var(--accent-soft); }
.task-description { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.task-description strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.task-description > span { font-size: 11px; color: var(--text-muted); }
.collect-hint { padding: 24px 0; color: var(--text-muted); text-align: center; font-size: 12px; line-height: 1.6; }
.preview-content { margin: 0; padding: 16px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--brand-mono, monospace); font-size: 12px; line-height: 1.7; color: var(--brand-text); max-height: 62vh; overflow: auto; background: var(--surface-subtle); border: 1px solid var(--line); border-radius: 6px; }
@media (max-width: 1280px) {
  .fill-page { padding: 0 16px; }
  .fill-workspace { grid-template-columns: minmax(0, 1fr) 248px; gap: 16px; }
  .fill-summary { padding-left: 16px; }
  .fill-toolbar { gap: 8px; }
  .fill-range-tip { max-width: 320px; white-space: normal; text-align: right; }
  .fill-group { gap: 8px; }
  .fill-log-table :deep(.cell) { padding: 0 12px; }
}
@media (max-width: 1080px) {
  .fill-workspace { grid-template-columns: minmax(0, 1fr); }
  .fill-summary { border-left: 0; border-top: 1px solid var(--line); padding: 16px 0 0; }
  .fill-range-tip { margin-left: 0; text-align: left; }
  .action-hint { font-size: 11px; }
}
</style>
