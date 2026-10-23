<template>
  <div class="leave-page">
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">一键请假</h1>
        <span class="page-scope">北森 · {{ plan?.staffName?.split('(')[0] || '本人出勤' }}</span>
        <el-button type="primary" class="page-primary" :loading="leave.running" :disabled="locked" @click="generate">
          <el-icon><MagicStick /></el-icon><span>{{ plan ? '重新生成方案' : '生成请假方案' }}</span>
        </el-button>
      </div>
    </Teleport>

    <section class="leave-toolbar">
      <div class="leave-field">
        <span class="leave-field-label">考勤日期</span>
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" :clearable="false" :disabled="locked" :disabled-date="futureDate" :shortcuts="shortcuts" range-separator="至" start-placeholder="开始日期" end-placeholder="截止日期" aria-label="考勤日期范围" class="leave-range" />
      </div>
      <div class="leave-field">
        <span class="leave-field-label">工作时间</span>
        <el-time-select v-model="options.workStart" start="00:00" end="23:30" step="00:30" :clearable="false" :disabled="locked" aria-label="上班时间" class="leave-time" />
        <span class="leave-time-sep">至</span>
        <el-time-select v-model="options.workEnd" start="00:00" end="23:30" step="00:30" :clearable="false" :disabled="locked" aria-label="下班时间" class="leave-time" />
      </div>
      <div class="leave-field leave-field-reason">
        <span class="leave-field-label">默认事由</span>
        <el-input v-model="options.reason" :disabled="locked" maxlength="1000" placeholder="选填" class="leave-reason" aria-label="默认请假事由" />
      </div>
      <div class="leave-connect-group">
        <el-button :disabled="locked" @click="showBookmarklet">浏览器书签</el-button>
        <el-button :disabled="locked" @click="connect">连接北森</el-button>
      </div>
    </section>

    <div v-if="loginWaiting" class="leave-login" role="status">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>{{ loginMode === 'bookmarklet' ? '在已登录北森的浏览器标签页点击书签即可连接' : '北森登录窗口已打开，完成登录后自动关闭' }}</span>
      <template v-if="bookmarkletHref">
        <span class="leave-login-sep">·</span>
        <a class="leave-bookmarklet" :href="bookmarkletHref" draggable="true" title="拖到浏览器书签栏，在已登录北森的标签页上点击" @click.prevent>免登录书签</a>
        <el-button link class="leave-bookmarklet-copy" @click="copyBookmarklet">复制</el-button>
      </template>
    </div>

    <el-button v-if="loginWaiting" link @click="loginMode === 'window' ? closeItalentWindow() : stopLoginWatcher()">{{ loginMode === 'window' ? '收起登录窗口' : '停止等待' }}</el-button>

    <el-alert v-if="leave.error" :title="leave.error" type="error" show-icon :closable="false" />
    <div v-if="leave.running || leave.submitting" class="leave-phase" role="status"><el-icon class="is-loading"><Loading /></el-icon>{{ leave.submitting ? '正在重新核对，并按日期倒序提交；请等待平台回查…' : '正在读取出勤、核对余额和校验请假时长…' }}</div>

    <div v-if="!plan && !busy" class="leave-empty">
      <el-icon><Calendar /></el-icon>
      <h2>暂无请假方案</h2>
    </div>

    <template v-if="plan">
      <section class="leave-stats">
        <template v-for="balance in shownBalances" :key="balance.name">
          <el-popover v-if="balance.name === '调休假' && plan.compEntries?.length" placement="bottom" trigger="click" width="380" popper-class="leave-comp-popover">
            <template #reference>
              <div class="leave-stat leave-stat-click">
                <span class="leave-stat-label">{{ balance.name }}可用</span>
                <strong v-if="balance.unlimited">不限</strong>
                <strong v-else>{{ balance.hours }}<small> 小时</small></strong>
                <span class="leave-stat-sub">本次 {{ balance.used }} · 剩余 {{ balance.unlimited ? '不限' : balance.remaining }}<template v-if="plan.compValidUntil"> · 有效至 {{ plan.compValidUntil }}</template></span>
              </div>
            </template>
            <div class="leave-comp-records">
              <div v-for="entry in plan.compEntries" :key="entry.id" class="leave-comp-row">
                <b>{{ entry.earnedDate }} 加班</b>
                <span>剩余 {{ entry.remaining }} 小时</span>
                <span class="leave-muted">可用 {{ entry.earnedDate }} ~ {{ entry.expires }}</span>
              </div>
            </div>
          </el-popover>
          <div v-else class="leave-stat">
            <span class="leave-stat-label">{{ balance.name }}可用</span>
            <strong v-if="balance.unlimited">不限</strong>
            <strong v-else>{{ balance.hours }}<small> 小时</small></strong>
            <span class="leave-stat-sub">本次 {{ balance.used }} · 剩余 {{ balance.unlimited ? '不限' : balance.remaining }}</span>
          </div>
        </template>
        <div v-if="quotaNow" class="leave-stat">
          <span class="leave-stat-label">本月迟到额度 · {{ quotaNow.month }}</span>
          <strong>还可用 {{ quotaNow.daysLeft }}<small> 次 · {{ quotaNow.minutesLeft }} 分钟</small></strong>
          <span class="leave-stat-sub">已用 {{ quotaNow.days }} / {{ plan.quotaLimits.days }} 次 · {{ quotaNow.minutes }} / {{ plan.quotaLimits.minutes }} 分钟 · 单次 ≤15 分钟</span>
        </div>
        <div class="leave-stat">
          <span class="leave-stat-label">本次待申请</span>
          <strong>{{ plan.totalHours }}<small> 小时 / {{ plan.entries.length }} 笔</small></strong>
          <span class="leave-stat-sub">{{ readyDays }} 天待请假 · {{ coveredDays }} 天已有申请<template v-if="toleratedDays"> · {{ toleratedDays }} 天额度内迟到</template></span>
        </div>
      </section>

      <section v-if="plan.unresolved?.length" class="leave-card leave-unresolved">
        <h2>待核对的上次申请</h2>
        <div v-for="entry in plan.unresolved" :key="entry.id" class="leave-unresolved-row">
          <div>
            <b>{{ entry.date }} · {{ entry.typeName }} {{ entry.start.slice(11) }}–{{ entry.end.slice(11) }} · {{ entry.hours }} 小时</b>
            <p class="leave-unresolved-msg">{{ entry.message }}</p>
            <p v-if="!entry.canRetry" class="leave-unresolved-msg">提交不足一分钟，请稍后重新核对</p>
          </div>
          <el-button :disabled="busy || !entry.canRetry" @click="openResolve(entry)">核对后重新生成</el-button>
        </div>
      </section>

      <section class="leave-card leave-detail">
        <div class="leave-detail-head">
          <div class="leave-detail-title">
            <h2>出勤与请假明细<el-icon v-if="replanning" class="is-loading leave-replan-spin"><Loading /></el-icon></h2>
            <span class="leave-muted">{{ plan.options.since }} 至 {{ plan.options.until }} · 方案有效 10 分钟</span>
          </div>
          <el-button type="primary" :disabled="locked || leave.consumed || !reviewRows.length" @click="openReview">核对并提交 {{ plan.entries.length }} 笔</el-button>
        </div>
        <!-- 列宽全部固定：重算方案时不因内容变化重排列，避免点击“计算迟到”时抖动。 -->
        <el-table :data="plan.rows" row-key="date" class="leave-table leave-table-fixed">
          <el-table-column prop="date" label="日期" width="106" />
          <el-table-column label="首打卡" width="170"><template #default="{ row }">{{ row.firstCard || '—' }}</template></el-table-column>
          <el-table-column label="迟到" width="88"><template #default="{ row }">{{ row.lateMinutes ? `${row.lateMinutes} 分钟` : '—' }}</template></el-table-column>
          <el-table-column label="请假方案" width="250"><template #default="{ row }">
            <div v-for="entry in row.allocations" :key="entry.id" class="leave-allocation"><b>{{ entry.typeName }}</b> {{ entry.start.slice(11) }}–{{ entry.end.slice(11) }} · {{ entry.hours }} 小时</div>
            <span v-if="!row.allocations.length" class="leave-muted">—</span>
          </template></el-table-column>
          <el-table-column label="计算迟到" width="88" align="center"><template #default="{ row }">
            <el-checkbox v-if="row.residualLate > 0 && (row.status === 'ready' || row.status === 'tolerated' || (row.status === 'blocked' && /^所选假种|^平台已拒绝所选假种/.test(row.reason)))" :model-value="row.countLate !== false" :disabled="locked || leave.consumed" @change="value => setCountLate(row, value)" />
            <span v-else class="leave-muted">—</span>
          </template></el-table-column>
          <el-table-column label="剩余迟到" width="88" align="center"><template #default="{ row }">{{ row.remainingLate ? `${row.remainingLate} 分钟` : '—' }}</template></el-table-column>
          <el-table-column label="状态" width="240"><template #default="{ row }"><span :class="['leave-row-status', `is-${statusOf(row).kind}`]">{{ statusOf(row).text }}</span></template></el-table-column>
        </el-table>
      </section>
      <el-alert v-if="leave.results.length" :type="allSucceeded ? 'success' : 'warning'" :closable="false" show-icon :title="allSucceeded ? `已提交 ${leave.results.length} 笔，均已在北森回查确认。` : '本次提交已停止，请查看下方结果；结果待核对的申请不会自动重发。'" />
      <section v-if="leave.results.length" class="leave-card">
        <el-table :data="leave.results" row-key="id" class="leave-table">
          <el-table-column prop="date" label="日期" width="118" />
          <el-table-column prop="typeName" label="假种" width="100" />
          <el-table-column label="时间" min-width="150"><template #default="{ row }">{{ row.start.slice(11) }}–{{ row.end.slice(11) }} · {{ row.hours }} 小时</template></el-table-column>
          <el-table-column label="提交结果" min-width="280"><template #default="{ row }"><span :class="['leave-row-status', `is-${row.status}`]">{{ row.message }}</span></template></el-table-column>
        </el-table>
      </section>
    </template>

    <el-dialog v-model="reviewVisible" title="确认请假方案" width="1000px" :close-on-click-modal="false" :close-on-press-escape="!leave.submitting" :show-close="!leave.submitting">
      <div v-loading="leave.submitting" element-loading-text="正在提交，逐笔写入北森并回查…" class="leave-review-body">
      <template v-if="plan">
        <p>{{ plan.staffName?.split('(')[0] }} · 已选 {{ selectedDates.length }} 天 · {{ selectedEntries.length }} 笔、{{ selectedHours }} 小时</p>
        <el-table :data="reviewRows" row-key="date" max-height="420" class="leave-review-table">
          <el-table-column width="52"><template #default="{ row }">
            <el-checkbox :model-value="selectedDates.includes(row.date)" :disabled="leave.submitting || replanning || row.status === 'blocked' || !row.allocations.length" :aria-label="`选择 ${row.date}`" @change="toggleDate(row.date)" />
          </template></el-table-column>
          <el-table-column prop="date" label="日期" width="104" />
          <el-table-column label="假种" width="148"><template #default="{ row }">
            <template v-if="row.allocations.length || row.status === 'blocked'">
              <el-select :model-value="selectedTypeId(row)" :disabled="leave.submitting || replanning" size="small" aria-label="假种" @change="value => setType(row, value)">
                <el-option label="自动" :value="AUTO_TYPE" />
                <el-option v-for="balance in shownBalances" :key="balance.id" :label="balance.name" :value="balance.id" />
              </el-select>
              <div v-if="row.status === 'blocked'" class="leave-review-error">{{ row.reason }}</div>
            </template>
            <span v-else class="leave-muted">—</span>
          </template></el-table-column>
          <el-table-column label="起止时刻" width="160"><template #default="{ row }">
            <div v-for="entry in row.allocations" :key="entry.id" class="leave-allocation">{{ entry.start.slice(11) }}–{{ entry.end.slice(11) }}</div>
            <span v-if="!row.allocations.length" class="leave-muted">—</span>
          </template></el-table-column>
          <el-table-column label="扣减" width="100"><template #default="{ row }">
            <div v-for="entry in row.allocations" :key="entry.id" class="leave-allocation">{{ entry.typeName }} {{ entry.hours }} 小时</div>
            <span v-if="!row.allocations.length" class="leave-muted">—</span>
          </template></el-table-column>
          <el-table-column label="计算迟到" width="88"><template #default="{ row }">
            <el-checkbox v-if="row.residualLate > 0" :model-value="row.countLate !== false" :disabled="leave.submitting || replanning" @change="value => setCountLate(row, value)" />
            <span v-else class="leave-muted">—</span>
          </template></el-table-column>
          <el-table-column label="剩余迟到" width="90"><template #default="{ row }">{{ row.remainingLate ? `${row.remainingLate} 分钟` : '—' }}</template></el-table-column>
          <el-table-column label="请假事由" min-width="180"><template #default="{ row }">
            <el-input v-model="dateReasons[row.date]" :disabled="leave.submitting || replanning" maxlength="1000" :placeholder="reasonPlaceholder" :aria-label="`${row.date} 请假事由`" />
          </template></el-table-column>
        </el-table>
        <p class="leave-muted">{{ shownBalances.map(b => b.unlimited ? `${b.name} 本次 ${b.used} 小时（不限）` : `${b.name} ${b.hours} → ${b.remaining} 小时`).join('；') }}</p>
      </template>
      </div>
      <template #footer><el-button :disabled="leave.submitting" @click="reviewVisible = false">返回核对</el-button><el-button type="primary" :loading="leave.submitting" :disabled="busy || replanning || leave.consumed || !selectedEntries.length" @click="submit">{{ leave.submitting ? '提交中' : `确认提交 ${selectedEntries.length} 笔` }}</el-button></template>
    </el-dialog>

    <el-dialog :model-value="!!resolveTarget" title="核对上次提交结果" width="560px" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @close="resolveTarget = null">
      <template v-if="resolveTarget">
        <p>{{ resolveTarget.date }} · {{ resolveTarget.typeName }} · {{ resolveTarget.start.slice(11) }}–{{ resolveTarget.end.slice(11) }} · {{ resolveTarget.hours }} 小时</p>
        <p class="leave-muted">{{ resolveTarget.message }}</p>
        <el-alert v-if="leave.error" :title="leave.error" type="error" :closable="false" show-icon />
        <el-checkbox v-model="resolveChecked" :disabled="locked" class="leave-confirm-missing">我已在北森确认，此时段没有审批中或已通过的请假申请</el-checkbox>
      </template>
      <template #footer><el-button :disabled="locked" @click="resolveTarget = null">返回核对</el-button><el-button type="primary" :disabled="busy || !resolveChecked" :loading="leave.running" @click="resolvePending">解除标记并重新生成</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@tauri-apps/api/core'
import { WebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow'
import { listen } from '@tauri-apps/api/event'
import { state } from '../store'
import { toPlain } from '../utils/ipc'
import { useTopbarReady } from '../composables/useTopbarReady'
import { ITALENT_URL, ITALENT_LABEL } from '../italent-url'

const topbarReady = useTopbarReady()
const leave = state.leave
const isTauri = !!window.__TAURI_INTERNALS__
const options = leave.options
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
if (!options.since) options.since = `${today().slice(0, 7)}-01`
if (!options.until) options.until = today()
const range = computed({ get: () => [options.since, options.until], set: (value) => { if (value?.length === 2) [options.since, options.until] = value } })
const plan = computed(() => leave.plan)
const shownBalances = computed(() => (plan.value?.balances || []).filter(balance => balance.available !== false))
const reviewVisible = ref(false)
const replanning = computed(() => leave.replanning)
const busy = computed(() => leave.running || leave.submitting)
// 重算期间只禁用控件，不显示整页加载条，避免布局抖动。
const locked = computed(() => busy.value || replanning.value)
// 确认弹窗里勾选要提交的日期；同一天的分段（调休+年假+事假）整体提交。
const selectedDates = ref([])
const selectedEntries = computed(() => (plan.value?.entries || []).filter(entry => selectedDates.value.includes(entry.date)))
const selectedHours = computed(() => selectedEntries.value.reduce((sum, entry) => sum + entry.hours, 0))
// 可调整的日期：有请假的日期，以及因指定假种余额不足被阻断的日期。
const reviewRows = computed(() => (plan.value?.rows || []).filter(row => row.lateMinutes > 0 && (row.status === 'ready' || row.status === 'tolerated' || (row.status === 'blocked' && /^所选假种|^平台已拒绝所选假种/.test(row.reason)))))
function toggleDate(date) {
  selectedDates.value = selectedDates.value.includes(date) ? selectedDates.value.filter(item => item !== date) : [...selectedDates.value, date]
}
// 确认弹窗里按天覆盖的请假事由；空值回落「默认事由」。
const dateReasons = ref({})
const typeOverrides = computed(() => plan.value?.overrides || {})
const reasonPlaceholder = computed(() => (plan.value?.options.reason ? `默认：${plan.value.options.reason}` : '默认事由选填'))
const resolveTarget = ref(null)
const resolveChecked = ref(false)
const readyDays = computed(() => plan.value?.rows.filter(row => row.status === 'ready').length || 0)
const coveredDays = computed(() => plan.value?.rows.filter(row => row.status === 'covered').length || 0)
const toleratedDays = computed(() => plan.value?.rows.filter(row => row.status === 'tolerated').length || 0)
const quotaNow = computed(() => {
  const quota = plan.value?.quota || {}
  const limits = plan.value?.quotaLimits || { days: 5, minutes: 50 }
  const months = Object.keys(quota).sort()
  const month = months[months.length - 1]
  if (!month) return null
  const used = quota[month]
  return {
    month,
    days: used.days,
    minutes: used.minutes,
    daysLeft: Math.max(0, limits.days - used.days),
    minutesLeft: Math.max(0, limits.minutes - used.minutes),
  }
})
const allSucceeded = computed(() => leave.results.length > 0 && leave.results.every(row => row.status === 'success'))
const futureDate = (date) => { const pad = n => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` > today() }
const shortcuts = [
  { text: '本月至今天', value: () => [new Date(`${today().slice(0, 7)}-01T00:00:00`), new Date(`${today()}T00:00:00`)] },
  { text: '今天', value: () => [new Date(`${today()}T00:00:00`), new Date(`${today()}T00:00:00`)] },
]
watch(options, () => { leave.invalidated = true; leave.plan = null; leave.results = []; leave.error = ''; leave.consumed = false; reviewVisible.value = false; resolveTarget.value = null; dateReasons.value = {}; selectedDates.value = [] }, { flush: 'sync' })

function statusOf(row) {
  const results = leave.results.filter(result => result.date === row.date)
  if (results.length) {
    if (results.every(result => result.status === 'success')) return { kind: 'success', text: '已提交，平台已确认' }
    const stopped = results.find(result => ['unknown', 'failed', 'blocked'].includes(result.status))
    return { kind: stopped?.status || 'skipped', text: stopped?.message || '尚未提交' }
  }
  return { kind: row.status, text: row.reason }
}
let italentWindow = null
let loginWatcher = null
let loginPolling = false
let loginGeneration = 0
const loginWaiting = ref(false)
const loginMode = ref('window')
const bookmarkletHref = ref('')
let disposed = false
let unlistenItalentClose = null

function stopLoginWatcher() {
  loginGeneration++
  loginWaiting.value = false
  if (loginWatcher) { clearInterval(loginWatcher); loginWatcher = null }
}

async function openItalentWindow() {
  const existing = (await getAllWebviewWindows()).find((view) => view.label === ITALENT_LABEL)
  if (existing) {
    italentWindow = existing
    await existing.show()
    await existing.setFocus()
    // 隐藏窗口里的旧会话可能已过期：重新加载让北森自行跳回登录页。
    try { await invoke('eval_in_webview', { label: ITALENT_LABEL, code: 'location.reload()' }) } catch { /* 重载失败由登录探测兜底 */ }
    return
  }
  const view = new WebviewWindow(ITALENT_LABEL, { url: ITALENT_URL, title: '北森 · 一键请假', width: 1180, height: 800, center: true })
  await new Promise((resolve, reject) => {
    view.once('tauri://created', resolve)
    view.once('tauri://error', (event) => reject(new Error(`北森窗口创建失败：${event?.payload || '未知错误'}`)))
  })
  italentWindow = view
}

async function closeItalentWindow() {
  try {
    const view = italentWindow || (await getAllWebviewWindows()).find(item => item.label === ITALENT_LABEL)
    await view?.hide()
    stopLoginWatcher()
    return true
  } catch {
    leave.error = '北森窗口未能自动收起，请点击窗口右上角 × 关闭；主程序会继续运行'
    return false
  }
}

// 等待任一通道就绪：内嵌窗口登录成功（隐藏窗口）、书签桥连接或浏览器会话恢复。
function startLoginWatcher() {
  stopLoginWatcher()
  const generation = loginGeneration
  loginWaiting.value = true
  loginWatcher = setInterval(async () => {
    if (generation !== loginGeneration || loginPolling || locked.value) return
    let result = null
    loginPolling = true
    try { result = await window.gitReport.leaveConnect() }
    catch { return }
    finally { loginPolling = false }
    if (generation !== loginGeneration) return
    if (result?.ok && result.loggedIn) {
      stopLoginWatcher()
      if (result.mode === 'embedded') {
        const hidden = await closeItalentWindow()
        ElMessage.success(hidden ? '北森登录成功，窗口已收起' : '北森登录成功')
      } else if (result.mode === 'bookmarklet') ElMessage.success('已通过书签连接北森')
      else ElMessage.success('已连接北森（浏览器会话）')
      return
    }
    if (!result?.ok && /北森窗口/.test(result?.error || '')) {
      stopLoginWatcher()
      leave.error = '北森登录窗口已关闭，未完成登录'
    }
  }, 2500)
}
onMounted(async () => {
  if (!isTauri) return
  try {
    const unlisten = await listen('leave-italent-closed', () => {
      if (loginMode.value === 'window') stopLoginWatcher()
    })
    if (disposed) unlisten()
    else unlistenItalentClose = unlisten
  } catch { /* 宿主事件不可用时仍可在界面主动收起窗口或停止等待 */ }
})
onUnmounted(() => {
  disposed = true
  stopLoginWatcher()
  unlistenItalentClose?.()
})
// 恢复上次未提交的方案（后台留存），重新进入页面不必重新生成。
onMounted(async () => {
  if (state.leave.plan || locked.value || leave.invalidated) return
  const snapshot = JSON.stringify(options)
  try {
    const result = await window.gitReport.leaveRestore?.()
    if (JSON.stringify(options) !== snapshot || locked.value || leave.plan) return
    if (result?.ok && result.plan) {
      if (result.plan.options) Object.assign(options, result.plan.options)
      state.leave.plan = result.plan
      leave.invalidated = false
    } else if (result?.notice) leave.error = result.notice
  } catch { /* 无留存或读取失败时保持空方案 */ }
})

async function connect() {
  if (locked.value || loginWaiting.value) return
  leave.running = true; leave.error = ''; leave.plan = null; leave.results = []
  try {
    const first = await window.gitReport.leaveConnect()
    if (first?.ok && first.loggedIn) {
      ElMessage.success(first.mode === 'bookmarklet' ? '已通过书签连接北森' : '北森已连接')
      return
    }
    if (!isTauri) {
      if (!first?.ok) throw new Error(first?.error || '连接失败')
      ElMessage.success('已打开北森，请在浏览器确认登录后生成方案')
      return
    }
    bookmarkletHref.value = first?.bookmarklet || ''
    loginMode.value = 'window'
    await openItalentWindow()
    startLoginWatcher()
    ElMessage.success('已打开北森登录窗口，完成登录后自动收起，也可点击 × 收起')
  } catch (error) { leave.error = error.message }
  finally { leave.running = false }
}
async function showBookmarklet() {
  if (locked.value || loginWaiting.value) return
  leave.running = true; leave.error = ''
  try {
    const result = await window.gitReport.leaveConnect()
    if (!result?.ok) throw new Error(result?.error || '连接失败')
    if (result.loggedIn) { ElMessage.success(result.mode === 'bookmarklet' ? '已通过书签连接北森' : '北森已连接'); return }
    bookmarkletHref.value = result.bookmarklet || ''
    if (!bookmarkletHref.value) throw new Error('浏览器连接不可用')
    loginMode.value = 'bookmarklet'
    startLoginWatcher()
    ElMessage.success('把书签拖到浏览器书签栏，在已登录北森的标签页点击')
  } catch (error) { leave.error = error.message }
  finally { leave.running = false }
}
async function copyBookmarklet() {
  if (!bookmarkletHref.value) return
  try { await window.gitReport.copyText(bookmarkletHref.value); ElMessage.success('连接脚本已复制，可在浏览器新建书签并粘贴') }
  catch { ElMessage.error('复制失败，请用鼠标拖动书签') }
}
async function generate() {
  if (locked.value) return
  stopLoginWatcher()
  leave.running = true; leave.error = ''; leave.plan = null; leave.results = []; leave.consumed = false
  dateReasons.value = {}; selectedDates.value = []
  try {
    const result = await window.gitReport.leavePlan(toPlain(options))
    if (!result?.ok) throw new Error(result?.error || '生成请假方案失败')
    leave.plan = result.plan
    leave.invalidated = false
  } catch (error) {
    leave.error = error.message
    // 会话过期：自动弹出登录窗口并开始等待，登录成功后重试生成即可。
    if (isTauri && !loginWaiting.value && /登录/.test(error.message)) {
      try { loginMode.value = 'window'; await openItalentWindow(); startLoginWatcher() } catch { /* 弹窗失败时保留原错误 */ }
    }
  }
  finally { leave.running = false }
}
function buildOverrides() {
  const overrides = {}
  for (const row of plan.value?.rows || []) {
    if (!(row.lateMinutes > 0)) continue
    if (row.status === 'blocked' && !/^所选假种|^平台已拒绝所选假种/.test(row.reason)) continue
    if (!['ready', 'tolerated', 'blocked'].includes(row.status)) continue
    // 余量为 0（08:46–09:00 到岗）没有可计迟到，不参与“计算迟到”调整。
    const item = row.residualLate > 0 ? { countLate: row.countLate !== false } : {}
    if (typeOverrides.value[row.date]) item.typeId = typeOverrides.value[row.date].typeId
    if (Object.keys(item).length) overrides[row.date] = item
  }
  return overrides
}
function applyPlan(next) {
  leave.plan = next
  const ready = new Set(next.rows.filter(row => row.status === 'ready' && row.allocations.length).map(row => row.date))
  selectedDates.value = selectedDates.value.filter(date => ready.has(date))
}
async function replanPlan(overrides = buildOverrides()) {
  if (locked.value || leave.consumed || !plan.value) return
  const id = plan.value.id
  const snapshot = JSON.stringify(options)
  leave.replanning = true; leave.error = ''
  try {
    const result = await window.gitReport.leaveReplan({ planId: id, overrides })
    if (plan.value?.id !== id || JSON.stringify(options) !== snapshot) return
    if (!result?.ok) throw new Error(result?.error || '调整方案失败')
    applyPlan(result.plan)
  } catch (error) { if (plan.value?.id === id && JSON.stringify(options) === snapshot) leave.error = error.message }
  finally { leave.replanning = false }
}
function setCountLate(row, value) {
  const overrides = buildOverrides()
  overrides[row.date] = { ...(overrides[row.date] || {}), countLate: value }
  void replanPlan(overrides)
}
// 假种下拉的“自动”哨兵值：空字符串会被 el-select 当占位符显示成“请选择”。
const AUTO_TYPE = '__auto__'
// 下拉显示当前实际生效的假种：手动指定优先；单一假种显示该假种；分段混合显示“自动”。
function selectedTypeId(row) {
  if (typeOverrides.value[row.date]?.typeId) return typeOverrides.value[row.date].typeId
  if (row.allocations.length === 1) return row.allocations[0].typeId
  return AUTO_TYPE
}
function setType(row, value) {
  if (locked.value) return
  const next = buildOverrides()
  next[row.date] = { ...(next[row.date] || {}) }
  if (!value || value === AUTO_TYPE) { delete next[row.date].typeId; delete next[row.date].typeName }
  else {
    const balance = shownBalances.value.find(item => item.id === value)
    if (!balance) return
    next[row.date] = { ...next[row.date], typeId: balance.id }
  }
  void replanPlan(next)
}
function openReview() {
  if (locked.value || leave.consumed || !reviewRows.value.length) return
  dateReasons.value = Object.fromEntries(reviewRows.value.map(row => [row.date, dateReasons.value[row.date] ?? '']))
  selectedDates.value = reviewRows.value.filter(row => row.status === 'ready' && row.allocations.length).map(row => row.date)
  reviewVisible.value = true
}
async function submit() {
  if (!reviewVisible.value || busy.value || replanning.value || leave.consumed || !selectedEntries.value.length) return
  leave.submitting = true; leave.error = ''; leave.consumed = true
  try {
    const reasons = {}
    for (const entry of selectedEntries.value) reasons[entry.date] = String(dateReasons.value[entry.date] ?? '').trim()
    const result = await window.gitReport.leaveSubmit({ planId: plan.value.id, confirmed: true, dates: [...selectedDates.value], reasons })
    if (!result?.ok) throw new Error(result?.error || '提交失败，请核对北森记录')
    leave.results = result.results
  } catch (error) { leave.error = error.message }
  finally { leave.submitting = false; reviewVisible.value = false }
}
function openResolve(entry) {
  if (busy.value || !entry.canRetry) return
  resolveChecked.value = false
  resolveTarget.value = entry
}
async function resolvePending() {
  if (!resolveTarget.value || !resolveChecked.value || busy.value || !plan.value) return
  const markerId = resolveTarget.value.id
  leave.running = true; leave.error = ''
  let resolved = false
  try {
    const result = await window.gitReport.leaveResolve({ planId: plan.value.id, markerId, confirmedMissing: true })
    if (!result?.ok) throw new Error(result?.error || '核对失败，请先查看北森记录')
    resolved = true; resolveTarget.value = null
    ElMessage.success(result.found ? '已找到平台申请，正在重新生成方案' : '已解除待核对标记，正在重新生成方案')
  } catch (error) { leave.error = error.message }
  finally { leave.running = false }
  if (resolved) await generate()
}
</script>

<style scoped>
.leave-page { display: flex; flex-direction: column; gap: 16px; min-width: 0; padding: 16px 24px 20px; }
.leave-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 16px 20px; }
/* 工具栏不套卡片，但要与卡片内文字同一条对齐线（左右各 20px，接在页面 24px 内边距之上） */
.leave-toolbar { display: flex; align-items: center; gap: 12px 20px; flex-wrap: wrap; padding: 4px 20px; }
.leave-field { display: flex; align-items: center; gap: 8px; }
.leave-field-label { color: var(--text-muted); font-size: 13px; white-space: nowrap; }
.leave-field-reason { flex: 1; min-width: 240px; }
.leave-field-reason .leave-reason { flex: 1; max-width: 480px; }
.leave-range { width: 280px; }
.leave-time { width: 110px; }
.leave-time-sep { color: var(--text-muted); }
.leave-connect-group { margin-left: auto; display: flex; gap: 8px; }
.leave-login { display: flex; align-items: center; gap: 8px; padding: 9px 16px; border: 1px solid var(--accent-soft); border-radius: var(--radius-md); background: var(--accent-soft); color: var(--ink-soft); font-size: 13px; }
.leave-login > .el-icon { color: var(--brand-accent); }
.leave-login-sep { color: var(--text-muted); }
.leave-bookmarklet { color: var(--brand-accent); }
.leave-bookmarklet:hover { color: var(--accent-strong); }
.leave-muted { color: var(--text-muted); font-size: 13px; }
.leave-phase { display: flex; align-items: center; gap: 8px; color: var(--brand-accent); }
.leave-empty { text-align: center; color: var(--text-muted); padding: 72px 20px; }
.leave-empty > .el-icon { font-size: 40px; color: var(--brand-accent); }
.leave-empty h2 { font-size: 16px; font-weight: 500; color: var(--text-muted); margin: 12px 0 0; }
.leave-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius-lg); overflow: hidden; }
/* 固定高度并截断副文本：数值变化不会撑高卡片导致页面抖动。 */
.leave-stat { display: flex; flex-direction: column; gap: 6px; padding: 16px 20px; height: 124px; overflow: hidden; background: var(--surface); }
.leave-stat-click { cursor: pointer; }
.leave-stat-label { color: var(--text-muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.leave-stat strong { font-size: 26px; color: var(--brand-accent); font-variant-numeric: tabular-nums; line-height: 1.1; white-space: nowrap; }
.leave-stat small { font-size: 13px; font-weight: 400; color: var(--text-muted); }
.leave-stat-sub { color: var(--text-muted); font-size: 13px; font-variant-numeric: tabular-nums; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.leave-comp-records { display: flex; flex-direction: column; max-height: 320px; overflow: auto; }
.leave-comp-row { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; font-variant-numeric: tabular-nums; }
.leave-comp-row:last-child { border-bottom: 0; }
.leave-comp-row b { font-weight: 500; }
.leave-unresolved h2, .leave-detail-head h2 { font-size: 16px; margin: 0; }
.leave-unresolved-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-top: 14px; }
.leave-unresolved-row b { font-size: 13px; font-weight: 500; }
.leave-unresolved-msg { margin: 6px 0 0; color: var(--text-muted); font-size: 13px; }
.leave-unresolved-row .el-button { flex-shrink: 0; }
.leave-confirm-missing { height: auto; align-items: flex-start; margin-top: 12px; }
.leave-confirm-missing :deep(.el-checkbox__label) { white-space: normal; line-height: 1.6; }
.leave-detail-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.leave-detail-title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.leave-table { width: 100%; }
.leave-allocation { line-height: 1.9; font-variant-numeric: tabular-nums; }
.leave-table :deep(td .cell), .leave-review-table :deep(td .cell) { vertical-align: top; }
.leave-table :deep(td .cell) { min-height: 42px; }
.leave-replan-spin { margin-left: 6px; vertical-align: -2px; }
.leave-allocation b { font-weight: 500; }
.leave-row-status.is-ready, .leave-row-status.is-covered, .leave-row-status.is-success { color: var(--brand-accent); }
.leave-row-status.is-tolerated, .leave-row-status.is-skipped { color: var(--text-muted); }
.leave-row-status.is-unknown, .leave-row-status.is-blocked { color: var(--el-color-warning); }
.leave-row-status.is-failed { color: var(--el-color-danger); }
.leave-row-status.is-skipped { color: var(--text-muted); }
.leave-review-table :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px var(--line) inset; }
.leave-review-body { position: relative; min-height: 220px; }
.leave-review-error { color: var(--el-color-danger); font-size: 12px; line-height: 1.5; margin-top: 4px; }
@media (max-width: 900px) {
  .leave-stats { grid-template-columns: 1fr; }
  .leave-connect-group { margin-left: 0; }
}
</style>
