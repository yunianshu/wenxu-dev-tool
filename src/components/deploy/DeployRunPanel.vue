<template>
  <section class="deploy-run-workspace">
    <div class="publish-row">
      <div class="version-summary">
        <span class="ver-label">{{ inFlightVersion ? (promoting ? '同步版本' : '本次发布') : '本地' }}</span>
        <strong class="local-version mono">{{ inFlightVersion || publishVersion || '未识别' }}</strong>
        <el-tooltip :content="onlineVersionSource || '查询服务器线上版本'" placement="top">
          <el-button text class="online-version" :disabled="!form.id || dirty || checkingPatchVersion" @click="queryReleases()">线上 {{ onlineVersion || '未知' }}<el-icon><Refresh /></el-icon></el-button>
        </el-tooltip>
        <template v-if="!inFlightVersion">
          <span v-if="onlineVersion && publishVersion === onlineVersion" class="version-match"><span />版本一致</span>
          <span v-else-if="publishVersion && onlineVersion" class="version-pending">待发布版本</span>
        </template>
      </div>
      <div class="publish-actions">
      <el-select
        v-if="releases.length"
        v-model="rollbackVersion"
        placeholder="历史版本"
        class="rollback-select"
      >
        <el-option v-for="r in releases" :key="r" :value="r" :label="r" />
      </el-select>
      <el-button
        v-if="releases.length && rollbackVersion"
        :loading="rollingBack"
        :disabled="runActionBusy"
        @click="doRollback(rollbackVersion)"
      >回滚到此版本</el-button>
      <el-button
        v-if="activeDatabase.enabled"
        plain
        @click="openDbBackups"
      ><el-icon><Coin /></el-icon>数据库备份</el-button>
      <el-button
        v-if="canPromote"
        plain
        :disabled="!form.id || runActionBusy || dirty"
        @click="emit('promote')"
      ><el-icon><Switch /></el-icon>环境同步</el-button>
      <el-button :disabled="!form.id || runActionBusy || dirty" @click="newVersion"><el-icon><Plus /></el-icon>新版本</el-button>
      <el-tooltip
        v-if="!run.running"
        :content="patchPublishBlockedReason || '递增版本号末位并发布到当前环境'"
        :disabled="checkingPatchVersion"
        placement="top"
      >
        <span class="publish-button-wrap">
          <el-button type="primary" plain :loading="checkingPatchVersion" :disabled="!!patchPublishBlockedReason" @click="publishPatch">一键小版本发布</el-button>
        </span>
      </el-tooltip>
      <el-button v-if="run.running" type="warning" plain :disabled="!run.id" @click="cancelRun">{{ cancelAction }}</el-button>
      <el-tooltip v-else :disabled="canPublish" :content="publishBlockedReason" placement="top">
        <span class="publish-button-wrap"><el-button type="primary" class="publish-btn" :disabled="!canPublish" @click="publish"><el-icon><Promotion /></el-icon>发布 {{ publishVersion || '' }}</el-button></span>
      </el-tooltip>
      </div>
    </div>
    <div class="run-output">
      <section class="deploy-stages" aria-label="部署阶段">
        <div class="run-heading">
          <div class="run-heading-title"><span class="run-status-dot" :class="runTrackClass" /><h2>{{ runTitle }}</h2></div>
          <span v-if="hasRun" class="run-elapsed mono">{{ fmtElapsed(elapsedMs) }}</span>
        </div>
        <div v-if="run.running" class="run-live" role="status" aria-live="polite">
          <div class="run-live-main">
            <div class="run-loader" aria-hidden="true">
              <svg viewBox="0 0 80 80"><circle class="run-loader-track" cx="40" cy="40" r="34" /><circle class="run-loader-fill" cx="40" cy="40" r="34" pathLength="100" :style="{ strokeDasharray: `${progress.percent} 100` }" /></svg>
              <span class="run-loader-spin" />
              <span class="run-loader-count mono">{{ progress.doneCount }}<small>/{{ progress.stageTotal }}</small></span>
            </div>
            <div class="run-live-copy"><span>{{ run.targetName || '当前阶段' }}</span><strong>{{ activeStageLabel }}</strong><span>{{ activeStageDetail }}</span></div>
          </div>
          <div class="run-live-footer"><span>{{ progress.counts.success }} 已完成<span v-if="progress.counts.skipped"> · {{ progress.counts.skipped }} 已跳过</span></span><span>发布日志实时更新</span></div>
        </div>
        <template v-else>
          <div class="run-summary">
            <span v-if="hasRun">{{ progress.counts.success }} 已完成<span v-if="progress.counts.skipped"> · {{ progress.counts.skipped }} 已跳过</span><span v-if="progress.counts.failed"> · {{ progress.counts.failed }} 失败</span><span v-if="progress.counts.rollback"> · {{ progress.counts.rollback }} 已回滚</span></span>
            <span v-else>准备就绪 · {{ progress.stageTotal }} 个阶段</span>
            <span class="run-fraction mono">{{ progress.doneCount }}/{{ progress.stageTotal }}</span>
          </div>
          <div class="run-track" :class="runTrackClass" role="progressbar" :aria-valuenow="progress.percent" :aria-valuemin="0" :aria-valuemax="100" :aria-label="`${runTitle}，已结束 ${progress.doneCount} 个阶段`"><div class="run-fill" :style="{ width: progress.percent + '%' }" /></div>
          <div class="stages">
            <div
              v-for="(s, i) in progress.stages"
              :key="s.id"
              class="stage-chip"
              :class="stageClass(s.id)"
            >
              <span class="stage-idx" aria-hidden="true">{{ stageMark(s.id) || i + 1 }}</span>
              <span class="stage-label">{{ s.label }}</span>
              <span class="stage-dur">{{ stageDur(s.id) || stageStatus(s.id) }}</span>
            </div>
          </div>
        </template>
      </section>

      <section class="deploy-card-log">
      <div class="section-heading">
        <h2>发布日志</h2>
        <div class="log-actions"><el-button text size="small" :disabled="!run.logs.length" @click="copyLogs"><el-icon><CopyDocument /></el-icon>复制</el-button><el-button text size="small" :disabled="!run.logs.length" @click="clearLogs">清屏</el-button></div>
      </div>
    <div ref="logBox" class="log-box" :class="{ 'is-empty': !run.logs.length }">
      <div v-if="!run.logs.length" class="log-empty">暂无日志，点击「发布」后此处实时显示服务器输出</div>
      <div v-for="(l, i) in run.logs" :key="i" class="log-line" :class="'log-' + l.level">
        <span class="log-ts">{{ l.ts }}</span>{{ l.text }}
      </div>
    </div>
      </section>
    </div>
  </section>

  <!-- 添加新版本（spec R7）：候选预测 + 自定义 -->
  <el-dialog v-model="versionDialogVisible" title="添加新版本" width="440px">
    <div class="ver-hint">
      基于当前版本 <b>{{ versionBase || '—' }}</b>
      <span v-if="versionBaseFromRemote">（线上/历史最高版本）</span>，选择要发布的新版本：
    </div>
    <el-radio-group v-model="versionChoice" class="ver-options">
      <el-radio v-if="predicted.patch" value="patch">{{ predicted.patch }}（修复补丁）</el-radio>
      <el-radio v-if="predicted.minor" value="minor">{{ predicted.minor }}（新功能）</el-radio>
      <el-radio v-if="predicted.major" value="major">{{ predicted.major }}（大版本）</el-radio>
      <el-radio value="custom">自定义</el-radio>
    </el-radio-group>
    <el-input
      v-if="versionChoice === 'custom'"
      v-model="customVersion"
      placeholder="输入版本号，如 1.2.3"
      @keyup.enter="confirmVersion"
    />
    <template #footer>
      <el-button @click="versionDialogVisible = false">取消</el-button>
      <el-button type="primary" @click="confirmVersion">保存并使用</el-button>
    </template>
  </el-dialog>

  <!-- 数据库备份恢复 -->
  <el-dialog v-model="dbDialogVisible" :title="`数据库备份 · ${form.name} / ${activeTarget?.name || '当前环境'}`" width="640px">
    <el-alert v-if="activeDatabase.type === 'mysql'" title="可查看本项目的 MySQL / MariaDB 备份，当前一键恢复支持 PostgreSQL。" type="info" :closable="false" />
    <el-alert type="warning" :closable="false" show-icon class="db-restore-alert">
      恢复会先自动保底备份当前数据库，再清空并重建数据库、灌入选中备份，最后重启应用容器。属高危操作，请确认备份时间点。
    </el-alert>
    <el-table :data="dbBackups" size="small" max-height="360" v-loading="dbLoading">
      <template #empty>
        <div class="db-empty">暂无数据库备份。开启「发布前备份数据库」后，每次发布会自动生成一份备份。</div>
      </template>
      <el-table-column label="备份时间" prop="time" width="140" />
      <el-table-column label="大小" prop="size" width="80" />
      <el-table-column label="文件" prop="fileName" min-width="200" show-overflow-tooltip />
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button text size="small" type="danger" :disabled="runActionBusy || activeDatabase.type !== 'postgres'" @click="doDbRestore(row)">恢复</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { beginDeployRun, deployRunFor, finishDeployRun, deployOnlineVersion, setDeployOnlineVersion, submitDeployRun } from '../../store'
import { bumpVersion, highestVersion } from '../../utils/version'
import { fmtDur, fmtElapsed, publishBlocker } from './deploy-form'
import { deployProgress } from './deploy-progress'

const props = defineProps({
  /** 部署表单（响应式对象，只读使用） */
  form: { type: Object, required: true },
  /** 当前部署目标 */
  activeTarget: { type: Object, default: null },
  /** 当前部署目标 id */
  activeTargetId: { type: String, default: '' },
  /** 本次发布会使用的版本号 */
  publishVersion: { type: String, default: '' },
  /** 表单是否有未保存修改 */
  dirty: { type: Boolean, default: false },
})
const emit = defineEmits(['history-changed', 'set-version', 'promote'])

const run = computed(() => deployRunFor(props.form.id))
const inFlightVersion = computed(() => run.value.running ? run.value.requestedVersion : '')
const progress = computed(() => deployProgress(run.value, props.form.deployMode))
const rollingBack = computed(() => run.value.running && run.value.type === 'rollback')
const cancelAction = computed(() => run.value.queued ? '取消排队'
  : ({ rollback: '取消回滚', 'db-restore': '取消恢复', promote: '取消同步' }[run.value.type] || '取消发布'))
const releases = ref([])
const rollbackVersion = ref('')
const logBox = ref(null)
let selectionEpoch = 0
let releaseQueryId = 0
let historyQueryId = 0
let disposed = false

function captureSelection() {
  return { projectId: props.form.id, targetId: props.activeTargetId, epoch: selectionEpoch }
}
function isCurrentSelection(selection) {
  return !disposed && selection.epoch === selectionEpoch
    && selection.projectId === props.form.id && selection.targetId === props.activeTargetId
}

/** 极简配置：用户只填服务器/项目地址/数据同步开关，其余由发布流程自动生成 */
const quickMode = computed(() => props.form.configMode === 'quick')

/** 环境同步入口：配置了两个及以上「服务器 + 部署目录」的环境时可用 */
const canPromote = computed(() => (props.form.targets || [])
  .filter((target) => target.server && target.server.host && target.remotePath).length >= 2)
const promoting = computed(() => run.value.type === 'promote')

const checkingPatchVersion = ref(false)
const runActionBusy = computed(() => run.value.running || checkingPatchVersion.value)
const publishBlockedReason = computed(() => publishBlocker(props.form, props.activeTarget, props.publishVersion, {
  dirty: props.dirty, busy: runActionBusy.value,
}))
const canPublish = computed(() => !publishBlockedReason.value)
const patchPublishBlockedReason = computed(() => publishBlocker(props.form, props.activeTarget, '', {
  dirty: props.dirty, busy: runActionBusy.value, checkingVersion: true,
}) || (props.activeTargetId ? '' : '请先选择部署环境'))

const activeDatabase = computed(() => {
  const target = props.activeTarget
  if (props.form.deployMode === 'auto') {
    if (target?.db?.strategy === 'off') return {}
    if (target?.db?.strategy !== 'manual') return target?.autoDb || {}
  }
  return target?.db || {}
})

// ─── 发布（当前目标） ───

/** 「新版本」对话框（spec R7）：基于当前版本预测候选，保留自定义输入 */
const versionDialogVisible = ref(false)
const versionChoice = ref('')
const customVersion = ref('')
/** 当前环境的成功发布记录，按时间倒序 */
const historyVersions = ref([])
const historyVersion = computed(() => historyVersions.value[0] || '')
const queriedVersion = computed(() => deployOnlineVersion(props.form.id, props.activeTargetId))

/**
 * 线上版本（三级回退）：服务器实时查询 → 本地发布记录最近一次成功 → 服务器 releases 最高版本。
 * 后两者是推断值，用 onlineVersionSource 标注来源，避免用户误以为已向服务器核实。
 */
const onlineVersion = computed(() =>
  queriedVersion.value || historyVersion.value || highestVersion(releases.value))
const onlineVersionSource = computed(() => {
  if (queriedVersion.value) return ''
  if (historyVersion.value) return '按发布记录'
  return highestVersion(releases.value) ? '按服务器版本列表' : ''
})

/** 预测基准：本地版本、线上版本、本地与服务器历史发布版本中的最高者（spec R7） */
function highestReleaseVersion(localVersion) {
  return highestVersion([localVersion, queriedVersion.value, ...historyVersions.value, ...releases.value])
}
const versionBase = computed(() => highestReleaseVersion(props.publishVersion)
  || String(props.publishVersion || queriedVersion.value || historyVersion.value || '').trim())
const versionBaseFromRemote = computed(() => !!versionBase.value && versionBase.value !== props.publishVersion)
const predicted = computed(() => ({
  patch: bumpVersion(versionBase.value, 'patch'),
  minor: bumpVersion(versionBase.value, 'minor'),
  major: bumpVersion(versionBase.value, 'major'),
}))
watch([versionDialogVisible, versionBase], ([open, base]) => {
  if (!open) return
  versionChoice.value = predicted.value.patch ? 'patch' : 'custom'
  customVersion.value = base
})

/**
 * 读取本地发布记录里该目标成功发布过的版本。
 * 异步返回时项目/环境可能已切换，丢弃过期结果。
 */
async function loadHistoryVersions() {
  const selection = captureSelection()
  const queryId = ++historyQueryId
  if (!selection.projectId) return
  try {
    const rows = await window.gitReport.deployHistoryList(selection.projectId)
    if (!isCurrentSelection(selection) || queryId !== historyQueryId) return
    historyVersions.value = (Array.isArray(rows) ? rows : []).filter(
      (r) => r && (!r.type || r.type === 'deploy' || r.type === 'rollback')
        && r.status === 'success' && r.version && (!r.targetId || r.targetId === selection.targetId),
    ).map((r) => r.version)
  } catch { /* 历史读取失败不影响展示 */ }
}

function newVersion() {
  versionDialogVisible.value = true
  if (!queriedVersion.value) void queryReleases(true)
}

function confirmVersion() {
  const v = versionChoice.value === 'custom' ? customVersion.value.trim() : predicted.value[versionChoice.value]
  if (!v) return ElMessage.warning('请输入版本号')
  versionDialogVisible.value = false
  emit('set-version', v)
}

// ─── 运行时间进度（本次发布/回滚的已用时与阶段完成度） ───

/** 每秒刷新，仅驱动「已用时」展示；计时基准是 store 里的 startedAt，跨视图返回后按真实时刻重算 */
const now = ref(Date.now())
let ticker = null
watch(() => run.value.running, (running) => {
  if (ticker) { clearInterval(ticker); ticker = null }
  if (running) {
    now.value = Date.now()
    ticker = setInterval(() => { now.value = Date.now() }, 1000)
  }
}, { immediate: true })
onUnmounted(() => { disposed = true; if (ticker) clearInterval(ticker) })

const hasRun = computed(() => !!run.value.startedAt)

const activeStageLabel = computed(() => {
  if (run.value.queued) return '等待可用资源'
  if (restoringDb.value) return '恢复数据库'
  return progress.value.activeStage?.label || (rollingBack.value ? '准备回滚' : promoting.value ? '准备同步' : '准备发布')
})
const activeStageDetail = computed(() => {
  if (run.value.queued) return '前序任务结束后自动执行'
  if (restoringDb.value) return '正在执行恢复流程'
  return progress.value.detail || '正在处理，请稍候'
})

const runFailed = computed(() => ['failed', 'rolled_back'].includes(run.value.status)
  || progress.value.counts.failed > 0 || progress.value.counts.rollback > 0)
const runTitle = computed(() => {
  if (run.value.queued) return '排队中'
  if (run.value.running) return restoringDb.value ? '正在恢复' : rollingBack.value ? '正在回滚' : promoting.value ? '正在同步环境' : '正在发布'
  if (!hasRun.value) return promoting.value ? '环境同步阶段' : '发布阶段'
  if (run.value.status === 'canceled') return '任务已取消'
  if (run.value.status === 'rolled_back') return '已自动回滚'
  if (run.value.type === 'db-restore') return run.value.status === 'success' ? '恢复完成' : '恢复失败'
  if (runFailed.value) return promoting.value ? '同步异常' : '发布异常'
  if (promoting.value) return run.value.status === 'success' ? '同步完成' : '同步已结束'
  if (run.value.type === 'rollback' && run.value.status === 'success') return '回滚完成'
  return progress.value.doneCount === progress.value.stageTotal ? '发布完成' : '发布已结束'
})

const runTrackClass = computed(() => {
  if (run.value.running) return 'is-running'
  if (!hasRun.value) return 'is-idle'
  return runFailed.value ? 'is-failed' : 'is-done'
})

/** 已用时：进行中用本地 tick；结束后用 done 事件写入的 finishedAt（缺失时回落到开始时刻） */
const elapsedMs = computed(() => {
  const started = run.value.startedAt
  if (!started) return 0
  const end = run.value.running ? now.value : (run.value.finishedAt || started)
  return Math.max(0, end - started)
})

/** 阶段耗时（主进程在阶段结束时下发，running 阶段为空） */
function stageDur(id) {
  const st = run.value.stages[id]
  return st && st.durationMs ? fmtDur(st.durationMs) : ''
}

async function publish() {
  if (!canPublish.value) return
  const selection = captureSelection()
  const v = props.publishVersion
  const t = props.activeTarget
  const oldV = onlineVersion.value || '（未知）'
  try {
    // 极简配置首次发布时部署形态还没定型（deployMode 仍为 auto），但发布会自动生成
    // 派生配置，与纯自动发布不同：同样弹确认框，并说明将按项目生成配置
    if (quickMode.value) await ElMessageBox.confirm(
      `即将发布 ${props.form.name} ${v} 到【${t.name}】${t.server.host}:${t.remotePath}（当前线上版本 ${oldV}）。发布时将按本项目自动生成部署配置，是否继续？`,
      '确认发布',
      { type: 'warning', confirmButtonText: '🚀 发布', cancelButtonText: '取消' },
    )
    else if (props.form.deployMode !== 'auto') await ElMessageBox.confirm(
      `即将发布 ${props.form.name} ${v} 到【${t.name}】${t.server.host}:${t.remotePath}（当前线上版本 ${oldV}）。发布过程中会备份并自动构建重启，是否继续？`,
      '确认发布',
      { type: 'warning', confirmButtonText: '🚀 发布', cancelButtonText: '取消' },
    )
  } catch { return }
  if (!isCurrentSelection(selection) || !canPublish.value) return
  await startPublish(selection, t.name)
}

async function publishPatch() {
  if (patchPublishBlockedReason.value) return
  const selection = captureSelection()
  const previousRun = run.value
  const { name, server, remotePath } = props.activeTarget
  const plan = {
    localPath: props.form.localPath,
    host: server.host, port: Number(server.port) || 22, username: server.username || '',
    remotePath,
  }
  checkingPatchVersion.value = true
  try {
    const localVersionRequest = props.form.version.strategy === 'auto'
      ? window.gitReport.deployDetectVersion({ localPath: plan.localPath, version: { strategy: 'auto' } }).catch(() => null)
      : null
    const [detected] = await Promise.all([
      localVersionRequest, loadHistoryVersions(), remotePath ? queryReleases(true) : null,
    ])
    if (!isCurrentSelection(selection) || run.value !== previousRun) return
    const version = bumpVersion(highestReleaseVersion(detected?.version ?? props.publishVersion), 'patch')
    if (!version) return ElMessage.warning('请先通过「新版本」设置三段版本号，如 1.2.3')
    const blockedReason = publishBlocker(props.form, props.activeTarget, version, { dirty: props.dirty, busy: run.value.running })
    if (blockedReason) return ElMessage.warning(blockedReason)
    await startPublish(selection, name, { ...plan, versionOverride: version, expectedVersion: version })
  } finally {
    if (isCurrentSelection(selection)) checkingPatchVersion.value = false
  }
}

async function startPublish(selection, targetName, releasePlan) {
  const result = await submitDeployRun(selection.projectId, selection.targetId, targetName, releasePlan)
  if (result?.error) ElMessage.error(result.error)
  if (isCurrentSelection(selection)) emit('history-changed')
}

async function cancelRun() {
  const projectId = props.form.id
  const { id, type } = run.value
  if (!id) return
  const action = cancelAction.value
  try {
    await ElMessageBox.confirm(
      `确认对「${props.form.name}」执行${action}？${type === 'deploy' ? '若服务器已开始执行，将按配置的自动回滚策略处理。' : ''}${type === 'promote' ? '目标环境已开始发布时按自动回滚策略处理；数据库灌入一旦开始不会撤回，可用同步前的保底备份恢复。' : ''}`,
      action, { type: 'warning' },
    )
  } catch { return }
  try {
    const result = await window.gitReport.deployCancel(projectId, id)
    if (!result?.ok) ElMessage.warning(result?.error || '取消任务失败')
  } catch (error) {
    ElMessage.error(error.message || String(error))
  }
}

// ─── 阶段样式 ───
function stageClass(id) {
  const st = run.value.stages[id]
  return st ? `is-${st.status}` : 'is-waiting'
}
function stageMark(id) {
  const st = run.value.stages[id]
  if (!st) return ''
  return {
    waiting: '', running: '•', success: '✓', failed: '×', skipped: '–', rollback: '↩',
  }[st.status] || ''
}
function stageStatus(id) {
  const status = run.value.stages[id]?.status
  return { waiting: '等待', running: '进行中', success: '完成', failed: '失败', skipped: '跳过', rollback: '回滚' }[status] || '等待'
}

// ─── 日志 ───
function clearLogs() { run.value.logs = [] }
async function copyLogs() {
  try {
    await window.gitReport.copyText(run.value.logs.map((line) => `${line.ts} ${line.text}`).join('\n'))
    ElMessage.success('已复制发布日志')
  } catch { ElMessage.error('复制发布日志失败，请重试') }
}
watch([() => props.form.id, () => run.value.logs.at(-1)], async () => {
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
})

// ─── 版本列表 / 回滚（当前目标） ───
/** 查询服务器历史版本；预测版本时静默补查。 */
async function queryReleases(silent = false) {
  const selection = captureSelection()
  const queryId = ++releaseQueryId
  if (!selection.projectId || !selection.targetId) return
  const operation = run.value
  const finishedAt = operation.finishedAt
  try {
    const r = await window.gitReport.deployReleases(selection.projectId, selection.targetId)
    if (!isCurrentSelection(selection) || queryId !== releaseQueryId || run.value !== operation || operation.finishedAt !== finishedAt) return
    if (r && r.ok) {
      releases.value = r.releases || []
      setDeployOnlineVersion(selection.projectId, selection.targetId, r.current || '')
      if (!silent && !releases.value.length) ElMessage.info('服务器暂无历史版本')
    } else if (!silent) {
      ElMessage.error((r && r.error) || '查询失败')
    }
  } catch (e) {
    if (!silent && isCurrentSelection(selection) && queryId === releaseQueryId) ElMessage.error(e.message || String(e))
  }
}

// ─── 数据库备份（当前目标） ───
const dbDialogVisible = ref(false)
const dbLoading = ref(false)
const dbBackups = ref([])
const restoringDb = computed(() => run.value.running && run.value.type === 'db-restore')

async function openDbBackups() {
  const selection = captureSelection()
  dbDialogVisible.value = true
  dbLoading.value = true
  try {
    const r = await window.gitReport.deployDbBackups(selection.projectId, selection.targetId)
    if (!isCurrentSelection(selection)) return
    if (r && r.ok) {
      dbBackups.value = r.backups || []
    } else {
      dbBackups.value = []
      ElMessage.error((r && r.error) || '查询备份失败')
    }
  } catch (e) {
    if (isCurrentSelection(selection)) ElMessage.error(e.message || String(e))
  } finally {
    if (isCurrentSelection(selection)) dbLoading.value = false
  }
}

async function doDbRestore(row) {
  if (runActionBusy.value) return
  const selection = captureSelection()
  try {
    await ElMessageBox.confirm(
      `确认把数据库恢复到备份「${row.fileName}」（${row.time}）？\n\n当前数据会先自动保底备份，然后被该备份内容完全替换，应用容器将重启。`,
      '确认恢复数据库',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
    )
  } catch { return }
  if (!isCurrentSelection(selection) || runActionBusy.value) return
  const operation = beginDeployRun(selection.projectId, 'db-restore', props.activeTarget?.name)
  let result
  try {
    result = await window.gitReport.deployDbRestore(selection.projectId, selection.targetId, row.fileName, operation.requestId)
    if (result?.ok) {
      ElMessage.success(`数据库已恢复到 ${row.fileName}`)
      if (isCurrentSelection(selection)) void openDbBackups()
    } else if (result?.record?.status === 'canceled') {
      ElMessage.info(result.record.message || '数据库恢复已取消')
    } else {
      ElMessage.error(result?.error || result?.record?.message || '恢复失败')
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    finishDeployRun(operation, result?.record)
    if (isCurrentSelection(selection)) emit('history-changed')
  }
}

async function doRollback(version, targetId) {
  if (runActionBusy.value) return
  const selection = captureSelection()
  const tid = targetId || props.activeTargetId
  const tName = (props.form.targets.find((x) => x.id === tid) || {}).name || ''
  try {
    await ElMessageBox.confirm(
      `确认回滚到 ${version}${tName ? `（目标：${tName}）` : ''}？服务器将停止当前版本、切换 current 并重启目标版本，随后执行健康检查。`,
      '确认回滚',
      { type: 'warning', confirmButtonText: '回滚' },
    )
  } catch { return }
  if (!isCurrentSelection(selection) || runActionBusy.value) return
  const operation = beginDeployRun(selection.projectId, 'rollback', tName)
  let result
  try {
    result = await window.gitReport.deployRollback(selection.projectId, tid, version, operation.requestId)
    if (result?.ok) {
      ElMessage.success(`已回滚到 ${version}`)
    } else if (result?.record?.status === 'canceled') {
      ElMessage.info(result.record.message || '回滚已取消')
    } else {
      ElMessage.error(result?.error || result?.record?.message || '回滚失败，请查看发布日志')
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    finishDeployRun(operation, result?.record)
    // 失败、断连或取消也可能已切换过指针；结束后以服务器查询为准。
    if (isCurrentSelection(selection) && tid === props.activeTargetId) void queryReleases(true)
    if (isCurrentSelection(selection)) emit('history-changed')
  }
}

/** 切换项目时清空版本列表与回滚选择（由组合层调用） */
function resetSelection() {
  selectionEpoch += 1
  checkingPatchVersion.value = false
  releases.value = []
  rollbackVersion.value = ''
  historyVersions.value = []
  versionDialogVisible.value = false
  dbDialogVisible.value = false
  dbBackups.value = []
  dbLoading.value = false
}

// 项目和目标共同决定上下文；同步失效可覆盖 A→B→A 及尚未重渲染的迟到请求。
watch(() => [props.form.id, props.activeTargetId], () => {
  resetSelection()
  loadHistoryVersions()
}, { immediate: true, flush: 'sync' })

defineExpose({ doRollback, resetSelection })
</script>

<style scoped>
.deploy-run-workspace { min-width: 0; }
.publish-row { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.version-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; min-width: 0; }
.ver-label, .online-version, .version-pending { color: var(--text-muted); font-size: 12px; }
.local-version { font-size: 18px; font-weight: 600; color: var(--brand-text); }
.online-version { padding: 0; height: 28px; }
.online-version :deep(span) { gap: 8px; }
.version-match { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--accent-strong); }
.version-match > span { width: 6px; height: 6px; border-radius: 50%; background: var(--brand-accent); }
.publish-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.publish-actions .el-button { margin: 0; height: 32px; }
.publish-btn { min-width: 112px; font-size: 13px; font-weight: 500; }
.publish-button-wrap { display: inline-flex; }
.rollback-select { width: 132px; }
.run-output { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 28px; padding-top: 24px; }
.section-heading { height: 32px; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.section-heading h2 { margin: 0; font-size: 14px; font-weight: 600; color: var(--brand-text); }
.log-actions { display: flex; align-items: center; gap: 4px; }
.log-actions .el-button { margin: 0; }
.run-heading { min-height: 28px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.run-heading-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.run-heading h2 { margin: 0; color: var(--brand-text); font-size: 14px; font-weight: 600; }
.run-status-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--line-strong); }
.run-status-dot.is-running { background: var(--accent-strong); }
.run-status-dot.is-done { background: var(--accent-strong); }
.run-status-dot.is-failed { background: var(--danger); }
.run-elapsed { color: var(--brand-text); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.run-live { min-height: 208px; display: flex; flex-direction: column; justify-content: center; gap: 24px; padding: 20px 0; }
.run-live-main { display: flex; align-items: center; gap: 20px; }
.run-loader { position: relative; width: 80px; height: 80px; flex: none; }
.run-loader svg { width: 100%; height: 100%; transform: rotate(-90deg); fill: none; stroke-width: 2; }
.run-loader-track { stroke: var(--line-strong); }
.run-loader-fill { stroke: var(--accent-strong); stroke-linecap: round; transition: stroke-dasharray .35s ease; }
.run-loader-spin { position: absolute; inset: -4px; border: 2px solid transparent; border-top-color: var(--accent-strong); border-radius: 50%; animation: run-loader-spin 1.4s linear infinite; }
.run-loader-count { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--brand-text); font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.run-loader-count small { padding-top: 4px; color: var(--text-muted); font-size: 11px; font-weight: 400; }
.run-live-copy { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.run-live-copy span { color: var(--text-muted); font-size: 11px; }
.run-live-copy strong { overflow: hidden; color: var(--brand-text); font-size: 15px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.run-live-footer { display: flex; justify-content: space-between; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--text-muted); font-size: 11px; }
@keyframes run-loader-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .run-loader-spin { animation: none; } }
.run-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0 10px; color: var(--text-muted); font-size: 11px; }
.run-fraction { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
.run-track { height: 3px; margin-bottom: 12px; background: var(--surface-subtle); overflow: hidden; }
.run-fill { height: 100%; background: var(--accent-strong); transition: width .35s ease; }
.run-track.is-failed .run-fill { background: var(--danger); }
.stages { display: flex; flex-direction: column; gap: 2px; }
.stage-chip { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 32px; padding: 0 8px; margin: 0 -8px; border-radius: 4px; color: var(--text-muted); font-size: 12px; }
.stage-idx { width: 20px; display: grid; place-items: center; flex: none; color: var(--text-disabled); font-size: 11px; font-variant-numeric: tabular-nums; }
.stage-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stage-dur { color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stage-chip.is-running { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
.stage-chip.is-running .stage-idx, .stage-chip.is-running .stage-dur { color: var(--accent-strong); }
.stage-chip.is-success { color: var(--brand-text); }
.stage-chip.is-success .stage-idx { color: var(--accent-strong); font-size: 14px; }
.stage-chip.is-failed { background: var(--danger-soft); color: var(--danger); font-weight: 600; }
.stage-chip.is-failed .stage-idx, .stage-chip.is-failed .stage-dur { color: var(--danger); }
.stage-chip.is-rollback { background: var(--warning-soft); color: var(--warning); }
.stage-chip.is-rollback .stage-idx, .stage-chip.is-rollback .stage-dur { color: var(--warning); }
.stage-chip.is-skipped .stage-idx, .stage-chip.is-skipped .stage-dur { color: var(--text-disabled); }
.deploy-card-log { min-width: 0; }
.log-box { height: 326px; overflow: auto; background: #14181f; border-radius: 6px; padding: 16px; font-family: var(--brand-mono); font-size: 12px; line-height: 2; }
.log-empty { color: #9ba7b5; display: grid; place-items: center; height: 100%; padding: 24px; text-align: center; line-height: 1.7; }
.log-line { white-space: pre-wrap; word-break: break-word; color: #c0c8d2; }
.log-ts { color: #9ba7b5; margin-right: 12px; }
.log-success { color: #87d7c4; }
.log-warn { color: #e8b45e; }
.log-error { color: #f08a8a; }
.ver-hint { font-size: 13px; color: var(--brand-text-sub); margin-bottom: 12px; }
.ver-hint b { color: var(--brand-text); font-family: var(--brand-mono); }
.ver-options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.ver-options .el-radio { margin-right: 0; height: auto; }

.db-restore-alert { margin-bottom: 12px; }
.db-empty { color: var(--brand-text-sub); font-size: 13px; padding: 20px 0; }
@media (max-width: 1280px) {
  .run-output { grid-template-columns: 280px minmax(0, 1fr); gap: 20px; }
  .version-summary { gap: 8px; }
  .publish-row { flex-wrap: wrap; }
  .publish-actions { margin-left: auto; }
}
</style>
