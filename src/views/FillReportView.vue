<template>
  <div class="fill-page">
    <!-- 页头上提到应用顶栏（按所选项目集合填报，与「当前项目」无关） -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">一键填报</h1>
      </div>
    </Teleport>

    <!-- 顶部工具条：选日期 → 选项目 → 生成报告 -->
    <el-card shadow="never" class="card">
      <div class="fill-toolbar">
        <!-- 日期与上下班时间是一组时间条件，与后面的项目选择在间距上分开 -->
        <div class="fill-group">
          <el-date-picker
            v-model="fillDate"
            type="date"
            value-format="YYYY-MM-DD"
            :clearable="false"
            :disabled-date="(d) => d.getTime() > Date.now()"
            :shortcuts="dateShortcuts"
            style="width: 150px"
          />
          <el-time-select
            v-model="startTime"
            start="06:00" end="21:00" step="00:15"
            :clearable="false"
            placeholder="上班时间"
            style="width: 108px"
          />
          <el-time-select
            v-model="endTime"
            start="00:00" end="23:45" step="00:15"
            clearable
            class="end-time-select"
            :placeholder="endPlaceholder"
            style="width: 138px"
          />
          <span class="fill-range-tip">{{ rangePreview }}</span>
        </div>
        <el-select
          v-model="selectedProjectIds"
          multiple
          filterable
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="3"
          placeholder="选择要填报的项目"
          class="project-select"
        >
          <el-option
            v-for="p in fillableProjects"
            :key="p.id"
            :value="p.id"
            :label="p.name"
            :disabled="p.repoCount === 0"
          >
            <div class="project-option">
              <span class="project-option-name">{{ p.name }}</span>
              <span class="project-option-right">
                <el-tag v-if="bindings[p.id]" size="small" type="success" class="project-option-tag">
                  已绑定 #{{ bindings[p.id].taskId }}
                </el-tag>
                <el-tag v-else-if="p.repoCount === 0" size="small" type="info" class="project-option-tag">无仓库</el-tag>
                <el-tag v-else size="small" type="warning" class="project-option-tag">未绑定</el-tag>
                <el-button
                  v-if="bindings[p.id]"
                  link
                  type="danger"
                  size="small"
                  class="project-option-unbind"
                  @click.stop="unbindProject(p.id)"
                >解绑</el-button>
              </span>
            </div>
          </el-option>
        </el-select>
        <el-button
          type="primary"
          size="large"
          :loading="state.fillReport.running"
          :disabled="!canGenerate"
          @click="generate"
        >
          <el-icon style="margin-right: 4px"><MagicStick /></el-icon>生成报告
        </el-button>
      </div>

      <el-alert
        v-if="!zentaoConfigured"
        type="warning"
        :closable="false"
        class="warn"
        title="禅道未配置：绑定项目与提交工时需要禅道地址与账号。"
      >
        <el-button size="small" type="primary" plain @click="emit('navigate', 'fill-settings')">去设置</el-button>
      </el-alert>
      <el-alert
        v-else-if="!hanprintConfigured"
        type="info"
        :closable="false"
        class="warn"
        title="汉印平台未配置：将只填报禅道工时（可到「设置 → 一键填报」配置汉印账号）。"
      />
      <el-alert
        v-else-if="plan && plan.ztError"
        type="error"
        :closable="false"
        class="warn"
        :title="`禅道任务获取失败：${plan.ztError}`"
      />
      <el-alert
        v-else-if="hanprintConfigured && plan && plan.hpError"
        type="error"
        :closable="false"
        class="warn"
        :title="`汉印任务获取失败：${plan.hpError}`"
      />
      <el-alert
        v-if="identitiesMissing"
        type="info"
        :closable="false"
        class="warn"
        title="尚未配置本人身份，无法过滤你的提交；请到「设置 → 个人身份」添加。"
      />
      <div v-if="selectedProjectIds.some((id) => !bindings[id])" class="bind-tip">
        已勾选的项目中还有未绑定禅道任务的：可在明细中绑定（绑定一次长期生效），未绑定不会写入工时。
      </div>
    </el-card>

    <!-- 生成中 -->
    <div v-if="state.fillReport.running" class="fill-phase">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>正在获取提交并计算工时…</span>
    </div>

    <template v-if="plan">
      <!-- 提交明细（工时计划）：列出当天所有有提交的项目，勾选决定哪些计入填报 -->
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>提交明细 · {{ plan.date }}（{{ plan.rangeStart }}–{{ plan.crossDay ? '次日 ' : '' }}{{ plan.rangeEnd }}，午休 {{ plan.workConfig.lunchStart }}–{{ plan.workConfig.lunchEnd }}）</span>
            <span class="header-meta">已选 {{ plan.planned.length }}/{{ dayProjects.length }} 个项目 · {{ plan.commitCount }} 条提交 · 合计 {{ totalHours }}h</span>
          </div>
        </template>
        <div v-if="dayProjects.length" class="plan-list">
          <div
            v-for="p in dayProjects"
            :key="p.projectId"
            class="prow"
            :class="{ unbound: !p.taskId, 'prow-off': !p.selected }"
          >
            <div class="pline">
              <el-checkbox
                class="pcheck"
                :model-value="p.selected"
                :disabled="state.fillReport.running || state.fillReport.submitting"
                @change="(v) => toggleProject(p.projectId, v)"
              />
              <span class="phours">{{ p.selected ? `${p.hours}h` : '未选' }}</span>
              <span class="pmsg">
                <pre class="pwork">{{ p.work }}</pre>
                <span class="pproj">{{ p.projectName }} · {{ p.commitCount }} 条提交</span>
              </span>
            </div>
            <div class="pmatch">
              <template v-if="p.taskId">
                <el-tag size="small" type="success">禅道 #{{ p.taskId }} {{ p.taskName || '已绑定任务' }}</el-tag>
                <el-button size="small" plain @click="openBind(p.projectId)">更换</el-button>
                <el-button size="small" plain type="danger" @click="unbindProject(p.projectId)">解绑</el-button>
              </template>
              <template v-else>
                <el-tag size="small" type="danger">未绑定</el-tag>
                <el-button size="small" type="primary" plain :disabled="!zentaoConfigured" @click="openBind(p.projectId)">绑定禅道任务</el-button>
              </template>
            </div>
          </div>
        </div>
        <div v-else class="collect-hint">
          {{ plan.identitiesMissing ? '请先配置本人身份' : `${plan.date} 没有你的提交记录（可改选日期）` }}
        </div>
        <div v-if="skippedProjects.length" class="submit-hint">
          另有 {{ skippedProjects.length }} 个当天有提交的项目未勾选，不计入填报（勾选后工时与汉印占比会重新计算）。
        </div>
        <div v-if="dayProjects.length && !plan.planned.length" class="submit-hint">
          尚未勾选任何项目：勾选后才会计算工时并按占比写入汉印。
        </div>
      </el-card>

      <!-- 按任务汇总 + 提交操作 -->
      <el-card v-if="plan.planned.length" shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>按禅道任务汇总</span>
            <el-tag v-if="plan.submittedAt" type="success" size="small">已于 {{ plan.submittedAt }} 提交</el-tag>
          </div>
        </template>
        <div v-if="plan.tasks.length" class="sum-list">
          <div v-for="t in plan.tasks" :key="t.taskId" class="sumline">
            <span class="sum-name">
              #{{ t.taskId }} {{ t.taskName || '（任务已不在「我的任务」列表）' }}
              <el-tag v-if="t.existingToday && t.existingToday.count" size="small" type="warning" class="exist-tag">
                当日已有 {{ t.existingToday.count }} 条（{{ t.existingToday.consumed }}h）· 将更新
              </el-tag>
            </span>
            <span class="sum-right">
              <template v-if="t.taskLeft !== null">剩余 {{ t.taskLeft }}h → {{ t.left }}h · </template>{{ t.consumed }}h
            </span>
          </div>
          <div class="sumline sum-total">
            <span>合计</span>
            <span>{{ totalHours }}h</span>
          </div>
        </div>
        <div v-else class="collect-hint">暂无可填报的任务：请先为有提交的项目绑定禅道任务</div>
        <!-- 汉印条目预览（按工时占比，合计 100%） -->
        <div v-if="plan.hpItems && plan.hpItems.length" class="hp-block">
          <div class="hp-title">
            汉印工时填报（{{ plan.hpItems.length }} 条 · 占比合计 {{ hpPercentTotal }}%<template v-if="hpExistingCount">，其中 {{ hpExistingCount }} 条当日已有将更新</template>）
          </div>
          <div v-for="(item, i) in plan.hpItems" :key="i" class="hpline">
            <span class="sum-name">
              {{ item.ProjectName }} · {{ item.TaskName }}
              <el-tag v-if="isHpExisting(item)" size="small" type="warning" class="exist-tag">已填 · 将更新</el-tag>
            </span>
            <span class="sum-right">{{ item.Percent }}%</span>
          </div>
        </div>
        <div v-else-if="hanprintConfigured && plan.tasks.length && plan.hpUnmatched && plan.hpUnmatched.length" class="submit-hint">
          汉印未匹配到这些禅道任务对应的报工任务，相关工时将只写入禅道：#{{ plan.hpUnmatched.join('、#') }}
        </div>
        <div v-if="plan.hpZeroSkipped" class="submit-hint">
          有 {{ plan.hpZeroSkipped }} 个任务工时不足（占比 0%），不写入汉印。
        </div>
        <div class="fill-actions">
          <el-button :disabled="!plan.planned.length" @click="copyReport">
            <el-icon style="margin-right: 4px"><CopyDocument /></el-icon>复制报告
          </el-button>
          <el-button :disabled="!canSubmit" @click="submitFill(true)">
            <el-icon style="margin-right: 4px"><View /></el-icon>预览提交
          </el-button>
          <el-button
            type="success"
            size="large"
            :disabled="!canSubmit || !!plan.submittedAt"
            :loading="state.fillReport.submitting"
            @click="submitFill(false)"
          >
            <el-icon style="margin-right: 4px"><Position /></el-icon>{{ plan.submittedAt ? '已提交' : '一键提交' }}
          </el-button>
        </div>
        <div v-if="unmatchedCount" class="submit-hint">有 {{ unmatchedCount }} 条提交所属项目未绑定禅道任务，绑定后才能提交。</div>
      </el-card>
    </template>

    <!-- 提交记录（fill-log 留痕）：失败记录可按存档载荷重新提交（已有记录按 ID 更新覆盖），记录可删除（只清本机留痕） -->
    <el-card v-if="submitLogs.length" shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span>提交记录</span>
        </div>
      </template>
      <div v-for="log in submitLogs" :key="log.at" class="logline">
        <span class="log-time">{{ (log.at || '').slice(0, 19) }}</span>
        <el-tag :type="logStatus(log).type" size="small">{{ logStatus(log).text }}</el-tag>
        <span class="log-sum">{{ logSummary(log) }}</span>
        <span class="log-err" :title="log.error">{{ log.error }}</span>
        <el-button
          v-if="log.resubmittable"
          size="small"
          type="primary"
          plain
          :loading="resubmitting === log.at"
          :disabled="!!resubmitting || !!deleting"
          @click="doResubmit(log)"
        >重新提交</el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :loading="deleting === log.at"
          :disabled="!!resubmitting || !!deleting"
          @click="doDeleteLog(log)"
        >删除</el-button>
      </div>
    </el-card>

    <!-- 空状态引导（未生成时） -->
    <div v-if="!plan && !state.fillReport.running" class="fill-hint">
      <el-alert type="info" :closable="false" show-icon title="选好日期与上下班时间后点「生成报告」：自动汇总当天所有项目的提交，再勾选要填报的项目（工时与汉印占比按勾选结果计算）" />
    </div>

    <!-- 绑定禅道任务弹窗 -->
    <el-dialog
      v-model="bindDialog.visible"
      :title="`${bindDialog.boundTaskId ? '管理绑定' : '绑定禅道任务'} · ${bindDialog.projectName}`"
      width="600"
    >
      <el-select
        v-model="bindDialog.taskId"
        filterable
        :loading="bindDialog.loading"
        placeholder="搜索选择禅道任务"
        style="width: 100%"
      >
        <el-option-group v-if="doingTasks.length" label="进行中">
          <el-option v-for="t in doingTasks" :key="t.id" :value="t.id" :label="`#${t.id} ${t.name}`">
            <div class="task-option">
              <span class="task-option-name">#{{ t.id }} {{ t.name }}</span>
              <span class="task-option-meta">{{ taskMeta(t) }}</span>
            </div>
          </el-option>
        </el-option-group>
        <el-option-group v-if="finishedTasks.length" label="已完成（近一个月）">
          <el-option v-for="t in finishedTasks" :key="t.id" :value="t.id" :label="`#${t.id} ${t.name}`">
            <div class="task-option">
              <span class="task-option-name">#{{ t.id }} {{ t.name }}</span>
              <span class="task-option-meta">{{ taskMeta(t) }}</span>
            </div>
          </el-option>
        </el-option-group>
      </el-select>
      <div class="bind-hint">
        {{ bindDialog.boundTaskId
          ? '可改选其他任务后保存绑定，或点「解除绑定」取消关联（取消后该项目提交需重新绑定才能填报）。'
          : '绑定一次后长期生效，之后填报该项目会自动关联此任务。' }}
      </div>
      <template #footer>
        <el-button v-if="bindDialog.boundTaskId" type="danger" plain @click="doUnbind">解除绑定</el-button>
        <el-button @click="bindDialog.visible = false">取消</el-button>
        <el-button type="primary" :disabled="!bindDialog.taskId" @click="doBind">保存绑定</el-button>
      </template>
    </el-dialog>

    <!-- 提交预览弹窗 -->
    <el-dialog v-model="previewDialog.visible" title="提交预览（未写入禅道）" width="720" top="6vh">
      <pre class="preview-content">{{ previewDialog.content }}</pre>
    </el-dialog>
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
const previewDialog = ref({ visible: false, content: '' })
/** 提交记录（fill-log 留痕）与按记录重新提交 / 删除记录 */
const submitLogs = ref([])
const resubmitting = ref('')
const deleting = ref('')
/** 生成/重算进行中收到的重算请求：结束后补跑一次 */
let pendingRecompute = false

/** 绑定弹窗分组：进行中在前、已完成在后（主进程已按此顺序返回，这里只做分组） */
const doingTasks = computed(() => (bindDialog.value.options || []).filter((t) => !t.finished))
const finishedTasks = computed(() => (bindDialog.value.options || []).filter((t) => t.finished))
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

const canGenerate = computed(() => !!(fillDate.value && fillableProjects.value.some((p) => p.repoCount > 0)))
const canSubmit = computed(() => !!(plan.value && plan.value.tasks.length && !plan.value.ztError && !unmatchedCount.value && zentaoConfigured.value))
const unmatchedCount = computed(() => (plan.value ? plan.value.planned.filter((p) => !p.taskId).length : 0))
/** 当天有提交的全部项目（生成报告后由主进程带回），勾选决定哪些计入填报 */
const dayProjects = computed(() => {
  const p = plan.value
  if (!p) return []
  return Array.isArray(p.dayProjects) ? p.dayProjects : p.planned
})
const skippedProjects = computed(() => dayProjects.value.filter((p) => !p.selected))
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
  try {
    const r = await window.gitReport.fillLog(20)
    if (r.ok) submitLogs.value = r.entries || []
  } catch { /* 记录面板失败不影响填报 */ }
}

function logStatus(log) {
  return log.failed ? { type: 'danger', text: '失败' } : { type: 'success', text: '成功' }
}

function logSummary(log) {
  const parts = []
  if (log.tasks.length || log.ztTotal) parts.push(`禅道 ${log.tasks.length}/${log.ztTotal}`)
  if (log.hp && log.hp.error) parts.push('汉印失败')
  else if (log.hp && log.hp.sent) parts.push(`汉印 ${log.hp.sent} 条`)
  return parts.join(' · ')
}

/** 按留痕记录重新提交：重放当时存档的载荷；禅道/汉印已有记录按 ID 复用更新覆盖，不重复写入 */
async function doResubmit(log) {
  try {
    await ElMessageBox.confirm(
      `重新提交 ${log.date} 的填报（禅道 ${log.ztTotal} 个任务${log.hp && log.hp.sent ? `、汉印 ${log.hp.sent} 条` : ''}）？已写入的部分会更新覆盖，不会重复。`,
      '重新提交',
      { type: 'warning', confirmButtonText: '提交', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  resubmitting.value = log.at
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
  } catch { /* 重算失败保留原计划 */ } finally {
    state.fillReport.running = false
    if (pendingRecompute) { pendingRecompute = false; recomputePlan() }
  }
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
    bindDialog.value.loading = true
    try {
      const r = await window.gitReport.fillZtTasks()
      if (r.ok) bindDialog.value.options = r.tasks
      else ElMessage.error(r.error || '禅道任务获取失败')
    } catch (e) {
      ElMessage.error(`禅道任务获取失败：${e?.message || e}`)
    } finally {
      bindDialog.value.loading = false
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
.fill-toolbar {
  display: flex;
  /* 组间 16px、组内 8px：原先一律 10px，一排六个控件看不出哪几个是一伙的 */
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.fill-group {
  display: flex;
  gap: 8px;
  align-items: center;
}
.fill-range-tip {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.project-select { width: 420px; }
.project-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.project-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-option-tag { flex-shrink: 0; }
.project-option-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.project-option-unbind { padding: 0; height: auto; }
.bind-tip {
  margin-top: 10px;
  font-size: 12px;
  color: #909399;
}
.warn { margin-top: 12px; }
.fill-phase {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 22px 4px;
  color: #6b7280;
  font-size: 13px;
}
.fill-hint { margin-top: 4px; }
.collect-hint {
  padding: 22px 0;
  text-align: center;
  color: #909399;
  font-size: 13px;
}
.plan-list .prow {
  border-top: 1px solid var(--brand-card-border, #eef0f4);
  padding: 10px 2px;
}
.plan-list .prow:first-child { border-top: none; }
/* 未勾选的项目：整体淡出，表示不计入本次填报 */
.plan-list .prow-off { opacity: 0.55; }
.plan-list .prow-off .pwork { color: var(--el-text-color-secondary); }
.pcheck { margin-right: 2px; flex-shrink: 0; }
.pline {
  display: flex;
  gap: 12px;
  align-items: baseline;
}
.phours {
  font-family: var(--brand-mono, monospace);
  font-size: 13px;
  font-weight: 700;
  color: #0e7a6d;
  width: 52px;
  flex-shrink: 0;
}
.pmsg { flex: 1; min-width: 0; }
.pwork {
  margin: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  color: #2a303c;
}
.pproj {
  display: block;
  font-size: 11.5px;
  color: #9ca1af;
  margin-top: 4px;
}
.pmatch {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.prow.unbound .pmatch { padding-left: 64px; }
.sum-list .sumline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 2px;
  font-size: 13px;
  border-top: 1px dashed var(--brand-card-border, #eef0f4);
}
.sum-list .sumline:first-child { border-top: none; }
.sum-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sum-right {
  font-family: var(--brand-mono, monospace);
  color: #4a5160;
  flex-shrink: 0;
}
.sum-total {
  border-top: 1px solid var(--brand-card-border, #eef0f4) !important;
  font-weight: 700;
}
.fill-actions {
  display: flex;
  gap: 10px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--brand-card-border, #eef0f4);
}
.hp-block {
  margin-top: 12px;
  padding: 10px 12px;
  background: #fafbfc;
  border: 1px solid var(--brand-card-border, #eef0f4);
  border-radius: 8px;
}
.hp-title {
  font-size: 12.5px;
  font-weight: 600;
  color: #4a5160;
  margin-bottom: 6px;
}
.exist-tag { margin-left: 6px; }
.hpline {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
  font-size: 12.5px;
}
.submit-hint {
  margin-top: 10px;
  font-size: 12px;
  color: #d64545;
}
.logline {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  font-size: 12.5px;
  border-top: 1px dashed var(--brand-card-border, #eef0f4);
}
.logline:first-of-type { border-top: none; }
.log-time {
  font-family: var(--brand-mono, monospace);
  color: #4a5160;
  flex-shrink: 0;
}
.log-sum {
  color: #4a5160;
  flex-shrink: 0;
}
.log-err {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #d64545;
}
.logline .el-button { flex-shrink: 0; }
.bind-hint {
  margin-top: 10px;
  font-size: 12px;
  color: #909399;
}
.task-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.task-option-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-option-meta {
  font-size: 11.5px;
  color: #9ca1af;
  flex-shrink: 0;
}
.preview-content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--brand-mono, monospace);
  font-size: 12px;
  line-height: 1.7;
  color: #3a4150;
  max-height: 62vh;
  overflow: auto;
  background: #fafbfc;
  border: 1px solid var(--brand-card-border, #eef0f4);
  border-radius: 8px;
  padding: 14px;
}
</style>
