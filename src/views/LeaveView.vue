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

    <section class="leave-controls">
      <div class="leave-controls-row">
        <label>考勤日期</label>
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" :clearable="false" :disabled="busy" :disabled-date="futureDate" :shortcuts="shortcuts" range-separator="至" start-placeholder="开始日期" end-placeholder="截止日期" aria-label="考勤日期范围" class="leave-range" />
        <el-button :disabled="busy" @click="connect">连接北森</el-button>
      </div>
      <div class="leave-controls-row">
        <label>工作时间</label>
        <el-time-select v-model="options.workStart" start="00:00" end="23:30" step="00:30" :clearable="false" :disabled="busy" aria-label="上班时间" class="leave-time" />
        <span class="leave-muted">至</span>
        <el-time-select v-model="options.workEnd" start="00:00" end="23:30" step="00:30" :clearable="false" :disabled="busy" aria-label="下班时间" class="leave-time" />
        <span class="leave-muted">舍弃秒数，按 0.5 小时进位 · 优先调休，不足再用年假 · 日期倒序</span>
      </div>
      <div class="leave-controls-row">
        <label for="leave-reason">请假事由</label>
        <el-input id="leave-reason" v-model="options.reason" :disabled="busy" maxlength="1000" placeholder="选填，确认后随申请提交" class="leave-reason" />
      </div>
      <p class="leave-help">{{ isTauri ? '点击「连接北森」打开独立登录窗口，完成登录后自动关闭；登录态保存在本机。' : '通过已登录北森的浏览器读取本人记录。首次使用请开启 Kimi Browser Extension 的本地连接，点击「连接北森」完成登录后再生成。' }}</p>
      <p v-if="loginWaiting" class="leave-help leave-login-waiting">北森登录窗口已打开，完成登录后自动关闭。</p>
      <div v-if="loginWaiting && bookmarkletHref" class="leave-controls-row leave-bookmarklet-row">
        <label>免登录连接</label>
        <a class="leave-bookmarklet" :href="bookmarkletHref" draggable="true" title="拖到浏览器书签栏" @click.prevent>拖到书签栏</a>
        <span class="leave-muted">在已登录北森的浏览器标签页上点击该书签，即可免密码连接</span>
      </div>
    </section>

    <el-alert v-if="leave.error" :title="leave.error" type="error" show-icon :closable="false" />
    <div v-if="busy" class="leave-phase" role="status"><el-icon class="is-loading"><Loading /></el-icon>{{ leave.submitting ? '正在重新核对，并按日期倒序提交；请等待平台回查…' : '正在读取出勤、核对余额和校验请假时长…' }}</div>

    <div v-if="!plan && !busy" class="leave-empty">
      <el-icon><Calendar /></el-icon>
      <h2>把迟到记录整理成请假方案</h2>
      <p>先读取本月出勤与可用余额，核对明细后由你确认提交。</p>
    </div>

    <template v-if="plan">
      <section class="leave-summary">
        <div v-for="balance in plan.balances" :key="balance.name" class="leave-balance">
          <span>{{ balance.name }}可用</span><strong>{{ balance.hours }}<small> 小时</small></strong>
          <span class="leave-muted">本次 {{ balance.used }} · 预计剩余 {{ balance.remaining }} 小时</span>
        </div>
        <div class="leave-balance"><span>本次待申请</span><strong>{{ plan.totalHours }}<small> 小时 / {{ plan.entries.length }} 笔</small></strong><span class="leave-muted">{{ readyDays }} 天待请假 · {{ coveredDays }} 天已有申请</span></div>
      </section>

      <section v-if="plan.unresolved?.length" class="leave-controls leave-unresolved">
        <h2>待核对的上次申请</h2>
        <p class="leave-help">先在北森「我的休假」核查对应时段。确认没有审批中或已通过的申请后，可以解除标记并重新生成方案。</p>
        <div v-for="entry in plan.unresolved" :key="entry.id" class="leave-unresolved-row">
          <div><b>{{ entry.date }} · {{ entry.typeName }} {{ entry.start.slice(11) }}–{{ entry.end.slice(11) }} · {{ entry.hours }} 小时</b><p class="leave-help">{{ entry.message }}</p><p v-if="!entry.canRetry" class="leave-help">提交不足一分钟，请稍后重新生成并核对。</p></div>
          <el-button :disabled="busy || !entry.canRetry" @click="openResolve(entry)">核对后重新生成</el-button>
        </div>
      </section>

      <section class="leave-detail">
        <div class="leave-detail-head">
          <div><h2>出勤与请假明细</h2><p class="leave-muted">{{ plan.options.since }} 至 {{ plan.options.until }} · 首打卡与已有申请已核对 · 方案有效 10 分钟</p></div>
          <el-button type="primary" :disabled="busy || leave.consumed || !plan.entries.length" @click="reviewVisible = true">核对并提交 {{ plan.entries.length }} 笔</el-button>
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
        <p v-if="!plan.entries.length" class="leave-help">当前没有可提交的记录，请查看各日期的状态说明。</p>
      </section>
      <el-alert v-if="leave.results.length" :type="allSucceeded ? 'success' : 'warning'" :closable="false" show-icon :title="allSucceeded ? `已提交 ${leave.results.length} 笔，均已在北森回查确认。` : '本次提交已停止，请查看下方结果；结果待核对的申请不会自动重发。'" />
      <el-table v-if="leave.results.length" :data="leave.results" row-key="id" class="leave-table">
        <el-table-column prop="date" label="日期" width="118" />
        <el-table-column prop="typeName" label="假种" width="100" />
        <el-table-column label="时间" min-width="150"><template #default="{ row }">{{ row.start.slice(11) }}–{{ row.end.slice(11) }} · {{ row.hours }} 小时</template></el-table-column>
        <el-table-column label="提交结果" min-width="280"><template #default="{ row }"><span :class="['leave-row-status', `is-${row.status}`]">{{ row.message }}</span></template></el-table-column>
      </el-table>
    </template>

    <el-dialog v-model="reviewVisible" title="确认请假方案" width="720px" :close-on-click-modal="false" :close-on-press-escape="!leave.submitting" :show-close="!leave.submitting">
      <template v-if="plan">
        <p>将为 {{ plan.staffName?.split('(')[0] }} 提交以下 {{ plan.entries.length }} 笔申请，共 {{ plan.totalHours }} 小时。点击确认后会写入北森审批流程。</p>
        <el-table :data="plan.entries" row-key="id" max-height="360">
          <el-table-column prop="date" label="日期" width="115" />
          <el-table-column prop="typeName" label="假种" width="95" />
          <el-table-column label="起止时刻" min-width="160"><template #default="{ row }">{{ row.start.slice(11) }}–{{ row.end.slice(11) }}</template></el-table-column>
          <el-table-column label="扣减" width="100"><template #default="{ row }">{{ row.hours }} 小时</template></el-table-column>
        </el-table>
        <p class="leave-help">{{ plan.balances.map(b => `${b.name} ${b.hours} → ${b.remaining} 小时`).join('；') }}</p>
        <p>事由：{{ plan.options.reason || '未填写' }}</p>
        <p class="leave-muted">提交前再次核对出勤、已有申请与余额；数据变化时会停止并要求重新生成。任一笔结果不确定时停止后续提交。</p>
      </template>
      <template #footer><el-button :disabled="leave.submitting" @click="reviewVisible = false">返回核对</el-button><el-button type="primary" :loading="leave.submitting" :disabled="busy || leave.consumed" @click="submit">确认提交</el-button></template>
    </el-dialog>

    <el-dialog :model-value="!!resolveTarget" title="核对上次提交结果" width="560px" :close-on-click-modal="false" :close-on-press-escape="!busy" :show-close="!busy" @close="resolveTarget = null">
      <template v-if="resolveTarget">
        <p>{{ resolveTarget.date }} · {{ resolveTarget.typeName }} · {{ resolveTarget.start.slice(11) }}–{{ resolveTarget.end.slice(11) }} · {{ resolveTarget.hours }} 小时</p>
        <p class="leave-help">{{ resolveTarget.message }}</p>
        <p>平台可能延迟显示申请。请先核查北森对应时段，避免重复申请。</p>
        <el-alert v-if="leave.error" :title="leave.error" type="error" :closable="false" show-icon />
        <el-checkbox v-model="resolveChecked" :disabled="busy" class="leave-confirm-missing">我已在北森确认，此时段没有审批中或已通过的请假申请</el-checkbox>
        <p class="leave-help">工具会再次查询北森。解除标记后重新生成方案，提交时仍需核对确认。</p>
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
const busy = computed(() => leave.running || leave.submitting)
const reviewVisible = ref(false)
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
watch(options, () => { leave.plan = null; leave.results = []; leave.error = ''; leave.consumed = false; reviewVisible.value = false; resolveTarget.value = null })

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
  } catch (error) {
    leave.error = error.message
    // 会话过期：自动弹出登录窗口并开始等待，登录成功后重试生成即可。
    if (isTauri && !loginWaiting.value && /登录/.test(error.message)) {
      try { await openItalentWindow(); startLoginWatcher() } catch { /* 弹窗失败时保留原错误 */ }
    }
  }
  finally { leave.running = false }
}
async function submit() {
  if (!reviewVisible.value || busy.value || leave.consumed || !plan.value?.entries.length) return
  leave.submitting = true; leave.error = ''; leave.consumed = true
  try {
    const result = await window.gitReport.leaveSubmit({ planId: plan.value.id, confirmed: true })
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
.leave-page { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.leave-controls, .leave-detail { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 20px; }
.leave-controls-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 14px; }
.leave-controls-row label { width: 60px; flex-shrink: 0; color: var(--text-muted); }
.leave-controls-row .leave-range { flex: 0 1 320px; }
.leave-time { width: 118px; }
.leave-reason { max-width: 620px; flex: 1; }
.leave-muted, .leave-help { color: var(--text-muted); font-size: 13px; }
.leave-help { margin: 10px 0 0; line-height: 1.8; }
.leave-phase { display: flex; align-items: center; gap: 8px; color: var(--brand-accent); }
.leave-empty { text-align: center; color: var(--text-muted); padding: 60px 20px; }
.leave-empty > .el-icon { font-size: 40px; color: var(--brand-accent); }
.leave-empty h2 { font-size: 18px; font-weight: 600; color: var(--brand-text); }
.leave-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.leave-balance { display: flex; flex-direction: column; gap: 8px; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
.leave-balance strong { font-size: 28px; color: var(--brand-accent); font-variant-numeric: tabular-nums; }
.leave-balance small { font-size: 13px; font-weight: 400; color: var(--text-muted); }
.leave-detail-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.leave-detail-head h2 { font-size: 16px; margin: 0; }
.leave-unresolved h2 { font-size: 16px; margin: 0; }
.leave-unresolved-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding-top: 14px; }
.leave-unresolved-row b { font-size: 13px; font-weight: 500; }
.leave-unresolved-row .el-button { flex-shrink: 0; }
.leave-confirm-missing { height: auto; align-items: flex-start; margin-top: 12px; }
.leave-confirm-missing :deep(.el-checkbox__label) { white-space: normal; line-height: 1.6; }
.leave-detail-head p { margin: 6px 0 0; }
.leave-table { width: 100%; }
.leave-allocation { line-height: 1.9; font-variant-numeric: tabular-nums; }
.leave-allocation b { font-weight: 500; }
.leave-row-status.is-ready, .leave-row-status.is-covered, .leave-row-status.is-success { color: var(--brand-accent); }
.leave-row-status.is-unknown, .leave-row-status.is-blocked { color: var(--el-color-warning); }
.leave-row-status.is-failed { color: var(--el-color-danger); }
.leave-row-status.is-skipped { color: var(--text-muted); }
@media (max-width: 900px) { .leave-summary { grid-template-columns: 1fr; gap: 10px; } .leave-balance { padding: 16px; } }
</style>
