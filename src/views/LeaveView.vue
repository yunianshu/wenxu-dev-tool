<template>
  <div class="leave-page">
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">一键请假</h1>
        <span class="page-scope">北森 · {{ plan?.staffName?.split('(')[0] || '本人出勤' }}</span>
        <el-button type="primary" class="page-primary" :loading="leave.running" :disabled="busy" @click="generate">
          <el-icon><MagicStick /></el-icon><span>{{ plan ? '重新生成方案' : '生成请假方案' }}</span>
        </el-button>
      </div>
    </Teleport>

    <section class="leave-toolbar">
      <div class="leave-field">
        <span class="leave-field-label">考勤日期</span>
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" :clearable="false" :disabled="busy" :disabled-date="futureDate" :shortcuts="shortcuts" range-separator="至" start-placeholder="开始日期" end-placeholder="截止日期" aria-label="考勤日期范围" class="leave-range" />
      </div>
      <div class="leave-field">
        <span class="leave-field-label">工作时间</span>
        <el-time-select v-model="options.workStart" start="00:00" end="23:30" step="00:30" :clearable="false" :disabled="busy" aria-label="上班时间" class="leave-time" />
        <span class="leave-time-sep">至</span>
        <el-time-select v-model="options.workEnd" start="00:00" end="23:30" step="00:30" :clearable="false" :disabled="busy" aria-label="下班时间" class="leave-time" />
      </div>
      <div class="leave-field leave-field-reason">
        <span class="leave-field-label">默认事由</span>
        <el-input v-model="options.reason" :disabled="busy" maxlength="1000" placeholder="选填" class="leave-reason" aria-label="默认请假事由" />
      </div>
      <el-button class="leave-connect" :disabled="busy" @click="connect">连接北森</el-button>
    </section>

    <div v-if="loginWaiting" class="leave-login" role="status">
      <el-icon class="is-loading"><Loading /></el-icon>
      <span>北森登录窗口已打开，完成登录后自动关闭</span>
      <template v-if="bookmarkletHref">
        <span class="leave-login-sep">·</span>
        <a class="leave-bookmarklet" :href="bookmarkletHref" draggable="true" title="拖到浏览器书签栏，在已登录北森的标签页上点击" @click.prevent>免登录书签</a>
      </template>
    </div>

    <el-alert v-if="leave.error" :title="leave.error" type="error" show-icon :closable="false" />
    <div v-if="busy" class="leave-phase" role="status"><el-icon class="is-loading"><Loading /></el-icon>{{ leave.submitting ? '正在重新核对，并按日期倒序提交；请等待平台回查…' : '正在读取出勤、核对余额和校验请假时长…' }}</div>

    <div v-if="!plan && !busy" class="leave-empty">
      <el-icon><Calendar /></el-icon>
      <h2>暂无请假方案</h2>
    </div>

    <template v-if="plan">
      <section class="leave-stats">
        <div v-for="balance in shownBalances" :key="balance.name" class="leave-stat">
          <span class="leave-stat-label">{{ balance.name }}可用</span>
          <strong v-if="balance.unlimited">不限</strong>
          <strong v-else>{{ balance.hours }}<small> 小时</small></strong>
          <span class="leave-stat-sub">本次 {{ balance.used }} · 剩余 {{ balance.unlimited ? '不限' : balance.remaining }}</span>
        </div>
        <div class="leave-stat">
          <span class="leave-stat-label">本次待申请</span>
          <strong>{{ plan.totalHours }}<small> 小时 / {{ plan.entries.length }} 笔</small></strong>
          <span class="leave-stat-sub">{{ readyDays }} 天待请假 · {{ coveredDays }} 天已有申请</span>
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
            <h2>出勤与请假明细</h2>
            <span class="leave-muted">{{ plan.options.since }} 至 {{ plan.options.until }} · 方案有效 10 分钟</span>
          </div>
          <el-button type="primary" :disabled="busy || leave.consumed || !plan.entries.length" @click="openReview">核对并提交 {{ plan.entries.length }} 笔</el-button>
        </div>
        <el-table :data="plan.rows" row-key="date" class="leave-table">
          <el-table-column prop="date" label="日期" width="118" />
          <el-table-column label="首打卡" min-width="155"><template #default="{ row }">{{ row.firstCard || '—' }}</template></el-table-column>
          <el-table-column label="迟到" width="94"><template #default="{ row }">{{ row.lateMinutes ? `${row.lateMinutes} 分钟` : '—' }}</template></el-table-column>
          <el-table-column label="请假方案" min-width="210"><template #default="{ row }">
            <div v-for="entry in row.allocations" :key="entry.id" class="leave-allocation"><b>{{ entry.typeName }}</b> {{ entry.start.slice(11) }}–{{ entry.end.slice(11) }} · {{ entry.hours }} 小时</div>
            <span v-if="!row.allocations.length" class="leave-muted">—</span>
          </template></el-table-column>
          <el-table-column label="状态" min-width="220"><template #default="{ row }"><span :class="['leave-row-status', `is-${statusOf(row).kind}`]">{{ statusOf(row).text }}</span></template></el-table-column>
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

    <el-dialog v-model="reviewVisible" title="确认请假方案" width="860px" :close-on-click-modal="false" :close-on-press-escape="!leave.submitting" :show-close="!leave.submitting">
      <template v-if="plan">
        <p>{{ plan.staffName?.split('(')[0] }} · 已选 {{ selectedEntries.length }} 笔、{{ selectedHours }} 小时</p>
        <el-table :data="plan.entries" row-key="id" max-height="380" class="leave-review-table">
          <el-table-column width="56"><template #default="{ row }">
            <el-checkbox :model-value="selectedDates.includes(row.date)" :disabled="leave.submitting" :aria-label="`选择 ${row.date}`" @change="toggleDate(row.date)" />
          </template></el-table-column>
          <el-table-column prop="date" label="日期" width="110" />
          <el-table-column prop="typeName" label="假种" width="90" />
          <el-table-column label="起止时刻" width="150"><template #default="{ row }">{{ row.start.slice(11) }}–{{ row.end.slice(11) }}</template></el-table-column>
          <el-table-column label="扣减" width="90"><template #default="{ row }">{{ row.hours }} 小时</template></el-table-column>
          <el-table-column label="请假事由" min-width="240"><template #default="{ row }">
            <el-input v-model="entryReasons[row.id]" :disabled="leave.submitting" maxlength="1000" :placeholder="reasonPlaceholder" :aria-label="`${row.date} 请假事由`" />
          </template></el-table-column>
        </el-table>
        <p class="leave-muted">{{ shownBalances.map(b => b.unlimited ? `${b.name} 本次 ${b.used} 小时（不限）` : `${b.name} ${b.hours} → ${b.remaining} 小时`).join('；') }}</p>
      </template>
      <template #footer><el-button :disabled="leave.submitting" @click="reviewVisible = false">返回核对</el-button><el-button type="primary" :loading="leave.submitting" :disabled="busy || leave.consumed || !selectedEntries.length" @click="submit">确认提交 {{ selectedEntries.length }} 笔</el-button></template>
    </el-dialog>

    <el-dialog :model-value="!!resolveTarget" title="核对上次提交结果" width="560px" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @close="resolveTarget = null">
      <template v-if="resolveTarget">
        <p>{{ resolveTarget.date }} · {{ resolveTarget.typeName }} · {{ resolveTarget.start.slice(11) }}–{{ resolveTarget.end.slice(11) }} · {{ resolveTarget.hours }} 小时</p>
        <p class="leave-muted">{{ resolveTarget.message }}</p>
        <el-alert v-if="leave.error" :title="leave.error" type="error" :closable="false" show-icon />
        <el-checkbox v-model="resolveChecked" :disabled="busy" class="leave-confirm-missing">我已在北森确认，此时段没有审批中或已通过的请假申请</el-checkbox>
      </template>
      <template #footer><el-button :disabled="busy" @click="resolveTarget = null">返回核对</el-button><el-button type="primary" :disabled="busy || !resolveChecked" :loading="leave.running" @click="resolvePending">解除标记并重新生成</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { invoke } from '@tauri-apps/api/core'
import { WebviewWindow, getAllWebviewWindows } from '@tauri-apps/api/webviewWindow'
import { state } from '../store'
import { toPlain } from '../utils/ipc'
import { useTopbarReady } from '../composables/useTopbarReady'

const topbarReady = useTopbarReady()
const leave = state.leave
const isTauri = !!window.__TAURI_INTERNALS__
// 与旧 Kimi 桥接一致：直接落在「我的考勤」列表页，未登录时北森自行跳登录并回跳。
const ITALENT_URL = 'https://cloud.italent.cn/attendance?metaObjName=Attendance.AttendanceStatistics&app=Attendance&viewName=Attendance.AttendanceDataRecordNavView&_qpt=indexpage#/indexPage'
const options = leave.options
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
if (!options.since) options.since = `${today().slice(0, 7)}-01`
if (!options.until) options.until = today()
const range = computed({ get: () => [options.since, options.until], set: (value) => { if (value?.length === 2) [options.since, options.until] = value } })
const plan = computed(() => leave.plan)
const shownBalances = computed(() => (plan.value?.balances || []).filter(balance => balance.available !== false))
const busy = computed(() => leave.running || leave.submitting)
const reviewVisible = ref(false)
// 确认弹窗里勾选要提交的日期；同一天的分段（调休+年假）整体提交。
const selectedDates = ref([])
const selectedEntries = computed(() => (plan.value?.entries || []).filter(entry => selectedDates.value.includes(entry.date)))
const selectedHours = computed(() => selectedEntries.value.reduce((sum, entry) => sum + entry.hours, 0))
function toggleDate(date) {
  selectedDates.value = selectedDates.value.includes(date) ? selectedDates.value.filter(item => item !== date) : [...selectedDates.value, date]
}
// 确认弹窗里按条覆盖的请假事由；空值回落「默认事由」。
const entryReasons = ref({})
const reasonPlaceholder = computed(() => (plan.value?.options.reason ? `默认：${plan.value.options.reason}` : '默认事由选填'))
const resolveTarget = ref(null)
const resolveChecked = ref(false)
const readyDays = computed(() => plan.value?.rows.filter(row => row.status === 'ready').length || 0)
const coveredDays = computed(() => plan.value?.rows.filter(row => row.status === 'covered').length || 0)
const allSucceeded = computed(() => leave.results.length > 0 && leave.results.every(row => row.status === 'success'))
const futureDate = (date) => { const pad = n => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` > today() }
const shortcuts = [
  { text: '本月至今天', value: () => [new Date(`${today().slice(0, 7)}-01T00:00:00`), new Date(`${today()}T00:00:00`)] },
  { text: '今天', value: () => [new Date(`${today()}T00:00:00`), new Date(`${today()}T00:00:00`)] },
]
watch(options, () => { leave.plan = null; leave.results = []; leave.error = ''; leave.consumed = false; reviewVisible.value = false; resolveTarget.value = null; entryReasons.value = {} })

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
const loginWaiting = ref(false)
const bookmarkletHref = ref('')

function stopLoginWatcher() {
  loginWaiting.value = false
  if (loginWatcher) { clearInterval(loginWatcher); loginWatcher = null }
}

async function openItalentWindow() {
  const existing = (await getAllWebviewWindows()).find((view) => view.label === 'leave-italent')
  if (existing) {
    italentWindow = existing
    await existing.show()
    await existing.setFocus()
    // 隐藏窗口里的旧会话可能已过期：重新加载让北森自行跳回登录页。
    try { await invoke('eval_in_webview', { label: 'leave-italent', code: 'location.reload()' }) } catch { /* 重载失败由登录探测兜底 */ }
    return
  }
  const view = new WebviewWindow('leave-italent', { url: ITALENT_URL, title: '北森 · 一键请假', width: 1180, height: 800, center: true })
  await new Promise((resolve, reject) => {
    view.once('tauri://created', resolve)
    view.once('tauri://error', (event) => reject(new Error(`北森窗口创建失败：${event?.payload || '未知错误'}`)))
  })
  italentWindow = view
}

// 等待任一通道就绪：内嵌窗口登录成功（隐藏窗口）、书签桥连接或浏览器会话恢复。
function startLoginWatcher() {
  stopLoginWatcher()
  loginWaiting.value = true
  loginWatcher = setInterval(async () => {
    let result = null
    try { result = await window.gitReport.leaveConnect() } catch { return }
    if (result?.ok && result.loggedIn) {
      stopLoginWatcher()
      if (result.mode === 'embedded') {
        try { await italentWindow?.hide() } catch { /* 窗口可能已被关闭 */ }
        ElMessage.success('北森登录成功，窗口已自动关闭')
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
onUnmounted(stopLoginWatcher)

async function connect() {
  if (busy.value || loginWaiting.value) return
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
    await openItalentWindow()
    startLoginWatcher()
    ElMessage.success('已打开北森登录窗口，完成登录后自动关闭')
  } catch (error) { leave.error = error.message }
  finally { leave.running = false }
}
async function generate() {
  if (busy.value) return
  leave.running = true; leave.error = ''; leave.plan = null; leave.results = []; leave.consumed = false
  try {
    const result = await window.gitReport.leavePlan(toPlain(options))
    if (!result?.ok) throw new Error(result?.error || '生成请假方案失败')
    leave.plan = result.plan
    entryReasons.value = {}
  } catch (error) {
    leave.error = error.message
    // 会话过期：自动弹出登录窗口并开始等待，登录成功后重试生成即可。
    if (isTauri && !loginWaiting.value && /登录/.test(error.message)) {
      try { await openItalentWindow(); startLoginWatcher() } catch { /* 弹窗失败时保留原错误 */ }
    }
  }
  finally { leave.running = false }
}
function openReview() {
  if (busy.value || leave.consumed || !plan.value?.entries.length) return
  entryReasons.value = Object.fromEntries(plan.value.entries.map(entry => [entry.id, entryReasons.value[entry.id] ?? '']))
  selectedDates.value = [...new Set(plan.value.entries.map(entry => entry.date))]
  reviewVisible.value = true
}
async function submit() {
  if (!reviewVisible.value || busy.value || leave.consumed || !selectedEntries.value.length) return
  leave.submitting = true; leave.error = ''; leave.consumed = true
  try {
    const reasons = {}
    for (const entry of selectedEntries.value) reasons[entry.id] = String(entryReasons.value[entry.id] ?? '').trim()
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
.leave-connect { margin-left: auto; }
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
.leave-stat { display: flex; flex-direction: column; gap: 6px; padding: 16px 20px; background: var(--surface); }
.leave-stat-label { color: var(--text-muted); font-size: 13px; }
.leave-stat strong { font-size: 26px; color: var(--brand-accent); font-variant-numeric: tabular-nums; line-height: 1.1; }
.leave-stat small { font-size: 13px; font-weight: 400; color: var(--text-muted); }
.leave-stat-sub { color: var(--text-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
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
.leave-allocation b { font-weight: 500; }
.leave-row-status.is-ready, .leave-row-status.is-covered, .leave-row-status.is-success { color: var(--brand-accent); }
.leave-row-status.is-tolerated, .leave-row-status.is-skipped { color: var(--text-muted); }
.leave-row-status.is-unknown, .leave-row-status.is-blocked { color: var(--el-color-warning); }
.leave-row-status.is-failed { color: var(--el-color-danger); }
.leave-row-status.is-skipped { color: var(--text-muted); }
.leave-review-table :deep(.el-input__wrapper) { box-shadow: 0 0 0 1px var(--line) inset; }
@media (max-width: 900px) {
  .leave-stats { grid-template-columns: 1fr; }
  .leave-connect { margin-left: 0; }
}
</style>
