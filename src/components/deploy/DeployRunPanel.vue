<template>
  <el-card shadow="never" class="card deploy-card-publish">
    <template #header>
      <div class="card-header">
        <span>发布</span>
        <span class="ver-info">
          目标 <b>{{ activeTarget ? (activeTarget.name || '未命名') : '—' }}</b>
          <el-divider direction="vertical" />
          本地版本 <b>{{ publishVersion || '—' }}</b>
          <el-divider direction="vertical" />
          线上版本 <b>{{ onlineVersion || '未知' }}</b>
          <span v-if="onlineVersionSource" class="ver-src">{{ onlineVersionSource }}</span>
          <el-button text size="small" type="primary" :disabled="!form.id || dirty" @click="queryReleases()">查询</el-button>
        </span>
      </div>
    </template>
    <div class="publish-row">
      <el-button
        type="primary"
        size="large"
        class="publish-btn"
        :loading="state.deploy.running"
        :disabled="!canPublish"
        @click="publish"
      >
        🚀 发布 {{ publishVersion || '' }}
      </el-button>
      <el-button
        size="large"
        :disabled="!form.id || state.deploy.running"
        @click="newVersion"
      ><el-icon style="margin-right: 4px"><Plus /></el-icon>新版本</el-button>
      <el-button v-if="state.deploy.running" size="large" type="warning" plain @click="cancelRun">取消发布</el-button>
      <el-select
        v-if="releases.length"
        v-model="rollbackVersion"
        placeholder="历史版本"
        size="large"
        style="width: 150px; margin-left: 8px"
      >
        <el-option v-for="r in releases" :key="r" :value="r" :label="r" />
      </el-select>
      <el-button
        v-if="releases.length && rollbackVersion"
        size="large"
        :loading="rollingBack"
        @click="doRollback(rollbackVersion)"
      >回滚到此版本</el-button>
      <el-button
        v-if="activeTarget && activeTarget.db && activeTarget.db.enabled"
        size="large"
        plain
        @click="openDbBackups"
      ><el-icon style="margin-right: 4px"><DataBase /></el-icon>数据库备份</el-button>
    </div>
        <div v-if="hasRun" class="run-meta">
      <div class="run-track" :class="runTrackClass">
        <div class="run-fill" :style="{ width: runPercent + '%' }" />
      </div>
      <span class="run-stat">
        {{ doneCount }}/{{ stageTotal }} 阶段 · {{ state.deploy.running ? '已用时' : '总耗时' }}
        <b class="mono">{{ fmtElapsed(elapsedMs) }}</b>
      </span>
    </div>
    <div class="stages">
      <div
        v-for="(s, i) in stageList"
        :key="s.id"
        class="stage-chip"
        :class="stageClass(s.id)"
      >
        <span class="stage-idx">{{ i + 1 }}</span>
        <span>{{ s.label }}</span>
        <span v-if="stageDur(s.id)" class="stage-dur">{{ stageDur(s.id) }}</span>
        <span class="stage-mark">{{ stageMark(s.id) }}</span>
      </div>
    </div>
  </el-card>

  <el-card shadow="never" class="card deploy-card-log">
    <template #header>
      <div class="card-header">
        <span>发布日志</span>
        <el-button text size="small" @click="clearLogs">清屏</el-button>
      </div>
    </template>
    <div ref="logBox" class="log-box">
      <div v-if="!state.deploy.logs.length" class="log-empty">暂无日志，点击「发布」后此处实时显示服务器输出</div>
      <div v-for="(l, i) in state.deploy.logs" :key="i" class="log-line" :class="'log-' + l.level">
        <span class="log-ts">{{ l.ts }}</span>{{ l.text }}
      </div>
    </div>
  </el-card>

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
  <el-dialog v-model="dbDialogVisible" title="数据库备份恢复（当前目标）" width="640px">
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
          <el-button text size="small" type="danger" :disabled="restoringDb" @click="doDbRestore(row)">恢复</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, nextTick, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../../store'
import { bumpVersion, highestVersion } from '../../utils/version'
import { fmtDur, fmtElapsed } from './deploy-form'

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
const emit = defineEmits(['history-changed', 'set-version'])

/** 与主进程 deploy-service.STAGES 保持一致；脚本部署形态下 build 阶段无对应动作 */
const STAGE_LIST = [
  { id: 'check', label: '检查项目' },
  { id: 'package', label: '项目打包' },
  { id: 'upload', label: '上传文件' },
  { id: 'backup', label: '备份服务器' },
  { id: 'extract', label: '解压新版本' },
  { id: 'build', label: 'Docker构建' },
  { id: 'start', label: '启动服务' },
  { id: 'health', label: '健康检查' },
  { id: 'datasync', label: '数据同步' },
]

/** 渲染用阶段列表：脚本部署时「Docker构建」显示为「项目脚本」（由升级脚本完成，无需构建） */
const stageList = computed(() => STAGE_LIST.map((s) => (
  s.id === 'build' && props.form.deployMode === 'script' ? { ...s, label: '项目脚本' } : s
)))

const rollingBack = ref(false)
const releases = ref([])
const rollbackVersion = ref('')
const logBox = ref(null)

const canPublish = computed(() => {
  if (state.deploy.running || !props.form.id || props.dirty || !props.activeTarget) return false
  const t = props.activeTarget
  return !!(props.form.name && props.form.localPath && props.publishVersion && t.server.host && t.remotePath)
})

// ─── 发布（当前目标） ───

/** 「新版本」对话框（spec R7）：基于当前版本预测候选，保留自定义输入 */
const versionDialogVisible = ref(false)
const versionChoice = ref('')
const customVersion = ref('')
const predicted = ref({ patch: '', minor: '', major: '' })
const versionBase = ref('')
/** 本地发布记录中该目标最近一次成功发布的版本（切项目/环境即加载，供线上版本回退与预测基准共用） */
const historyVersion = ref('')

/**
 * 线上版本（三级回退）：服务器实时查询 → 本地发布记录最近一次成功 → 服务器 releases 最高版本。
 * 后两者是推断值，用 onlineVersionSource 标注来源，避免用户误以为已向服务器核实。
 */
const onlineVersion = computed(() =>
  state.deploy.currentVersion || historyVersion.value || highestVersion(releases.value))
const onlineVersionSource = computed(() => {
  if (state.deploy.currentVersion) return ''
  if (historyVersion.value) return '按发布记录'
  return highestVersion(releases.value) ? '按服务器版本列表' : ''
})

/** 基准取自线上/历史发布版本（而非本地识别版本）时给出说明 */
const versionBaseFromRemote = computed(() => !!versionBase.value && versionBase.value !== props.publishVersion)

/** 预测基准：本地版本、线上版本、本地与服务器历史发布版本中的最高者（spec R7） */
function rebuildPrediction(force = false) {
  const candidates = [props.publishVersion, state.deploy.currentVersion, historyVersion.value, ...releases.value]
  // 全部无法解析为 x.y.z 时回退原始版本串：不产生候选，但让用户看到当前版本并据此自定义（spec R7）
  const base = highestVersion(candidates)
    || String(props.publishVersion || state.deploy.currentVersion || historyVersion.value || '').trim()
  const changed = force || base !== versionBase.value
  versionBase.value = base
  predicted.value = {
    patch: bumpVersion(base, 'patch'),
    minor: bumpVersion(base, 'minor'),
    major: bumpVersion(base, 'major'),
  }
  if (changed) {
    versionChoice.value = predicted.value.patch ? 'patch' : 'custom'
    customVersion.value = base
  }
}

/**
 * 读取本地发布记录里该目标最近一次成功发布的版本（快、无需网络，失败静默）。
 * 异步返回时项目/环境可能已切换，丢弃过期结果。
 */
async function loadHistoryVersion() {
  const pid = props.form.id
  const tid = props.activeTargetId
  if (!pid) { historyVersion.value = ''; return }
  try {
    const rows = await window.gitReport.deployHistoryList(pid)
    if (pid !== props.form.id || tid !== props.activeTargetId) return
    const hit = (Array.isArray(rows) ? rows : []).find(
      (r) => r && r.status === 'success' && r.version && (!r.targetId || r.targetId === tid),
    )
    historyVersion.value = hit ? hit.version : ''
  } catch { /* 历史读取失败不影响展示 */ }
}

// 切项目/环境即补全，不必等用户点「查询」或打开「新版本」
watch(() => [props.form.id, props.activeTargetId], () => { loadHistoryVersion() }, { immediate: true })

function newVersion() {
  rebuildPrediction(true)
  versionDialogVisible.value = true
  // 基准补全：线上版本需 SSH（失败静默）返回后刷新候选；本地发布记录已随切换预载
  const refresh = () => { if (versionDialogVisible.value) rebuildPrediction() }
  if (!state.deploy.currentVersion) queryReleases(true).then(refresh)
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
watch(() => state.deploy.running, (running) => {
  if (ticker) { clearInterval(ticker); ticker = null }
  if (running) {
    now.value = Date.now()
    ticker = setInterval(() => { now.value = Date.now() }, 1000)
  }
}, { immediate: true })
onUnmounted(() => { if (ticker) clearInterval(ticker) })

const hasRun = computed(() => !!state.deploy.startedAt)

const stageTotal = computed(() => STAGE_LIST.length)

/** 已完成阶段数（含失败/跳过/回滚——它们同样不再推进） */
const doneCount = computed(() => STAGE_LIST.filter((s) => {
  const st = state.deploy.stages[s.id]
  return !!st && ['success', 'failed', 'skipped', 'rollback'].includes(st.status)
}).length)

const runPercent = computed(() => (stageTotal.value ? Math.round((doneCount.value / stageTotal.value) * 100) : 0))

const runFailed = computed(() => STAGE_LIST.some((s) => {
  const st = state.deploy.stages[s.id]
  return !!st && (st.status === 'failed' || st.status === 'rollback')
}))

const runTrackClass = computed(() => {
  if (state.deploy.running) return ''
  return runFailed.value ? 'is-failed' : 'is-done'
})

/** 已用时：进行中用本地 tick；结束后用 done 事件写入的 finishedAt（缺失时回落到开始时刻） */
const elapsedMs = computed(() => {
  const started = state.deploy.startedAt
  if (!started) return 0
  const end = state.deploy.running ? now.value : (state.deploy.finishedAt || started)
  return Math.max(0, end - started)
})

/** 阶段耗时（主进程在阶段结束时下发，running 阶段为空） */
function stageDur(id) {
  const st = state.deploy.stages[id]
  return st && st.durationMs ? fmtDur(st.durationMs) : ''
}

function resetStages() {
  const st = {}
  for (const s of STAGE_LIST) st[s.id] = { status: 'waiting', durationMs: 0 }
  state.deploy.stages = st
  state.deploy.logs = []
  state.deploy.packageCount = 0
  state.deploy.uploadPercent = 0
}

async function publish() {
  const v = props.publishVersion
  const t = props.activeTarget
  const oldV = onlineVersion.value || '（未知）'
  try {
    await ElMessageBox.confirm(
      `即将发布 ${props.form.name} ${v} 到【${t.name}】${t.server.host}:${t.remotePath}（当前线上版本 ${oldV}）。发布过程中会备份并自动构建重启，是否继续？`,
      '确认发布',
      { type: 'warning', confirmButtonText: '🚀 发布', cancelButtonText: '取消' },
    )
  } catch { return }
  resetStages()
  state.deploy.startedAt = Date.now()
  state.deploy.finishedAt = 0
  state.deploy.running = true
  try {
    const r = await window.gitReport.deployRun(props.form.id, props.activeTargetId)
    if (r && r.error) {
      ElMessage.error(r.error)
      // 主进程前置校验失败（如「已有发布任务进行中」）不会发出 done 事件，
      // 必须自行复位运行态，否则发布按钮永久 loading、取消按钮失灵
      state.deploy.running = false
      state.deploy.startedAt = 0
    }
  } catch (e) {
    state.deploy.running = false
    ElMessage.error(e.message || String(e))
  }
  if (!state.deploy.running) emit('history-changed') // done 事件已关闭 running
}

async function cancelRun() {
  try {
    await ElMessageBox.confirm('确认取消本次发布？服务器脚本将按自动回滚策略处理。', '取消发布', { type: 'warning' })
  } catch { return }
  await window.gitReport.deployCancel()
}

// ─── 阶段样式 ───
function stageClass(id) {
  const st = state.deploy.stages[id]
  return st ? `is-${st.status}` : 'is-waiting'
}
function stageMark(id) {
  const st = state.deploy.stages[id]
  if (!st) return ''
  return {
    waiting: '·', running: '…', success: '✓', failed: '✗', skipped: '—', rollback: '↩',
  }[st.status] || ''
}

// ─── 日志 ───
function clearLogs() { state.deploy.logs = [] }
watch(() => state.deploy.logs.length, async () => {
  await nextTick()
  if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight
})

// ─── 版本列表 / 回滚（当前目标） ───
/** 查询服务器历史版本；silent 用于「新版本」预测基准的后台补查（不打扰用户） */
async function queryReleases(silent = false) {
  try {
    const r = await window.gitReport.deployReleases(props.form.id, props.activeTargetId)
    if (r && r.ok) {
      releases.value = r.releases || []
      state.deploy.currentVersion = r.current || state.deploy.currentVersion
      if (!silent && !releases.value.length) ElMessage.info('服务器暂无历史版本')
    } else if (!silent) {
      ElMessage.error((r && r.error) || '查询失败')
    }
  } catch (e) {
    if (!silent) ElMessage.error(e.message || String(e))
  }
}

// ─── 数据库备份（当前目标） ───
const dbDialogVisible = ref(false)
const dbLoading = ref(false)
const dbBackups = ref([])
const restoringDb = ref(false)

async function openDbBackups() {
  dbDialogVisible.value = true
  dbLoading.value = true
  try {
    const r = await window.gitReport.deployDbBackups(props.form.id, props.activeTargetId)
    if (r && r.ok) {
      dbBackups.value = r.backups || []
    } else {
      dbBackups.value = []
      ElMessage.error((r && r.error) || '查询备份失败')
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    dbLoading.value = false
  }
}

async function doDbRestore(row) {
  try {
    await ElMessageBox.confirm(
      `确认把数据库恢复到备份「${row.fileName}」（${row.time}）？\n\n当前数据会先自动保底备份，然后被该备份内容完全替换，应用容器将重启。`,
      '确认恢复数据库',
      { type: 'warning', confirmButtonText: '恢复', cancelButtonText: '取消' },
    )
  } catch { return }
  restoringDb.value = true
  // 数据恢复占用主进程发布互斥：同步 running 态（禁用发布按钮）并复位上一轮的阶段/计时展示
  state.deploy.running = true
  state.deploy.stages = {}
  state.deploy.startedAt = Date.now()
  state.deploy.finishedAt = 0
  state.deploy.logs = []
  state.deploy.logs.push({ level: 'info', text: `开始恢复数据库备份 ${row.fileName}`, ts: new Date().toLocaleTimeString('zh-CN', { hour12: false }) })
  try {
    const r = await window.gitReport.deployDbRestore(props.form.id, props.activeTargetId, row.fileName)
    if (r && r.ok) {
      ElMessage.success(`数据库已恢复到 ${row.fileName}`)
      await openDbBackups() // 刷新列表（保底备份会出现在最前）
    } else {
      ElMessage.error((r && r.error) || (r && r.record && r.record.message) || '恢复失败')
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    restoringDb.value = false
    state.deploy.running = false
  }
}

async function doRollback(version, targetId) {
  const tid = targetId || props.activeTargetId
  const tName = (props.form.targets.find((x) => x.id === tid) || {}).name || ''
  try {
    await ElMessageBox.confirm(
      `确认回滚到 ${version}${tName ? `（目标：${tName}）` : ''}？服务器将停止当前版本、切换 current 并重启目标版本，随后执行健康检查。`,
      '确认回滚',
      { type: 'warning', confirmButtonText: '回滚' },
    )
  } catch { return }
  rollingBack.value = true
  resetStages()
  state.deploy.startedAt = Date.now()
  state.deploy.finishedAt = 0
  state.deploy.running = true
  try {
    const r = await window.gitReport.deployRollback(props.form.id, tid, version)
    if (r && r.ok) {
      ElMessage.success(`已回滚到 ${version}`)
      if (tid === props.activeTargetId) state.deploy.currentVersion = version
    } else if (r && r.error) {
      ElMessage.error(r.error)
    }
  } finally {
    rollingBack.value = false
    state.deploy.running = false
    emit('history-changed')
  }
}

/** 切换项目时清空版本列表与回滚选择（由组合层调用） */
function resetSelection() {
  releases.value = []
  rollbackVersion.value = ''
  historyVersion.value = ''
}

// 切换部署环境后，历史版本列表必须重新获取，否则会沿用上一个环境的数据
// （线上版本回退值 historyVersion 由上方 watch([form.id, activeTargetId]) 重新加载）
watch(() => props.activeTargetId, () => {
  releases.value = []
  rollbackVersion.value = ''
})

defineExpose({ doRollback, resetSelection })
</script>

<style scoped>
.ver-info { font-size: 13px; color: var(--brand-text-sub); font-weight: 400; }
.ver-info b { color: var(--brand-text); font-family: var(--brand-mono); }
.ver-src { margin-left: 4px; font-size: 11.5px; color: var(--brand-text-sub); }
.ver-hint { font-size: 13px; color: var(--brand-text-sub); margin-bottom: 12px; }
.ver-hint b { color: var(--brand-text); font-family: var(--brand-mono); }
.ver-options { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.ver-options .el-radio { margin-right: 0; height: auto; }

.publish-row { display: flex; align-items: center; margin-bottom: 14px; flex-wrap: wrap; row-gap: 10px; }
.publish-btn { min-width: 220px; font-size: 15px; font-weight: 600; }

.run-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.run-track { flex: 1; max-width: 240px; height: 4px; border-radius: 2px; background: #e8ebf0; overflow: hidden; }
.run-fill { height: 100%; border-radius: 2px; background: var(--brand-accent); transition: width .3s ease; }
.run-track.is-done .run-fill { background: #67c23a; }
.run-track.is-failed .run-fill { background: #f56c6c; }
.run-stat { font-size: 12.5px; color: var(--brand-text-sub); }
.run-stat b { color: var(--brand-text); }

.stages { display: flex; flex-wrap: wrap; gap: 8px; }
.stage-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid #e2e6ed;
  font-size: 12.5px;
  color: #8a909c;
  background: #fafbfc;
  transition: all .2s ease;
}
.stage-idx {
  width: 16px; height: 16px; line-height: 16px; text-align: center;
  border-radius: 50%;
  background: #e2e6ed; color: #fff;
  font-size: 11px;
  font-family: var(--brand-mono);
}
.stage-mark { font-family: var(--brand-mono); font-weight: 600; }
.stage-dur { font-size: 11.5px; opacity: .75; font-family: var(--brand-mono); }
.stage-chip.is-running { border-color: var(--brand-accent); color: var(--brand-accent); background: var(--el-color-primary-light-9); }
.stage-chip.is-running .stage-idx { background: var(--brand-accent); }
.stage-chip.is-success { border-color: #b7e1b7; color: #3f9d3f; background: #f2faf2; }
.stage-chip.is-success .stage-idx { background: #67c23a; }
.stage-chip.is-failed { border-color: #efb8b8; color: #d54949; background: #fdf3f3; }
.stage-chip.is-failed .stage-idx { background: #f56c6c; }
.stage-chip.is-rollback { border-color: #f0d3a8; color: #c8842c; background: #fdf8ef; }
.stage-chip.is-rollback .stage-idx { background: #e6a23c; }
.stage-chip.is-skipped { opacity: .65; }

.log-box {
  height: 300px;
  overflow: auto;
  background: #14181f;
  border-radius: 8px;
  padding: 12px 14px;
  font-family: var(--brand-mono);
  font-size: 12.5px;
  line-height: 1.65;
}
.log-empty { color: #5b6470; text-align: center; padding-top: 120px; }
.log-line { white-space: pre-wrap; word-break: break-all; color: #b8c0ca; }
.log-ts { color: #5b6470; margin-right: 10px; }
.log-success { color: #7fd07f; }
.log-warn { color: #e8b45e; }
.log-error { color: #f08a8a; }

.db-restore-alert { margin-bottom: 12px; }
.db-empty { color: var(--brand-text-sub); font-size: 13px; padding: 20px 0; }
</style>
