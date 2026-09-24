<template>
  <section class="deploy-card-history">
      <div class="history-heading">
        <h2>发布历史</h2>
        <div class="history-controls">
          <el-select v-model="statusFilter" :empty-values="[null, undefined]" aria-label="按发布状态筛选" class="history-filter">
            <el-option value="" label="全部状态" />
            <el-option v-for="item in ['success', 'failed', 'rolled_back', 'canceled', 'running']" :key="item" :value="item" :label="statusText(item)" />
          </el-select>
          <el-dropdown trigger="click" @command="clearHistory">
            <el-button text aria-label="发布历史更多操作"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="clear" :disabled="!history.length"><span class="history-danger">清空发布历史</span></el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </div>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" class="history-error"><el-button text @click="loadHistory">重试</el-button></el-alert>
    <el-table :data="pagedHistory" v-loading="loading" size="small" max-height="320" :empty-text="statusFilter ? '没有符合此状态的发布记录' : '暂无发布记录'" row-key="id" highlight-current-row :default-sort="{ prop: 'startedAt', order: 'descending' }" @row-dblclick="viewLog" @sort-change="onSort">
      <el-table-column prop="version" label="版本" min-width="100">
        <template #default="{ row }">
          <span class="mono">{{ row.version || '—' }}</span>
          <el-tag v-if="row.version && (row.releaseId || row.version) === state.deploy.currentVersion" size="small" type="success" effect="plain" class="cur-tag">运行中</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="环境" min-width="100">
        <template #default="{ row }">
          <span>{{ row.targetName || '默认' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="耗时" prop="durationMs" sortable="custom" width="96">
        <template #default="{ row }">{{ fmtDur(row.durationMs) }}</template>
      </el-table-column>
      <el-table-column label="时间" prop="startedAt" sortable="custom" min-width="156">
        <template #default="{ row }">{{ fmtTime(row.startedAt) }}</template>
      </el-table-column>
      <el-table-column label="类型" width="88">
        <template #default="{ row }">
          <el-tag size="small" :type="{ rollback: 'warning', 'db-restore': 'danger' }[row.type] || 'primary'" effect="plain">
            {{ { deploy: '发布', rollback: '回滚', 'db-restore': '数据恢复' }[row.type] || row.type }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="变更" width="88">
        <template #default="{ row }">
          <el-button v-if="hasChanges(row)" text size="small" type="primary" @click="openChanges(row)">
            <span v-if="changeCount(row)">{{ changeCount(row) }} 条</span><span v-else>查看</span>
          </el-button>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="message" label="说明" min-width="96" show-overflow-tooltip />
      <el-table-column label="操作" width="64" fixed="right">
        <template #default="{ row }">
          <el-dropdown trigger="click" @command="command => onRowCommand(command, row)">
            <el-button text size="small" :aria-label="`版本 ${row.version || '未知'} 的操作`"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="log">查看日志</el-dropdown-item>
                <el-dropdown-item command="changes" :disabled="!hasChanges(row)">查看更新内容</el-dropdown-item>
                <el-dropdown-item v-if="row.projectId === projectId && row.type === 'deploy' && row.status === 'success' && (row.releaseId || row.version) !== state.deploy.currentVersion" command="rollback" divided :disabled="state.deploy.running">回滚到此版本</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>
    <div class="history-footer"><span>{{ history.length }} 条发布记录<template v-if="statusFilter"> · 筛选后 {{ filteredHistory.length }} 条</template></span><el-pagination v-model:current-page="page" :page-size="pageSize" :total="filteredHistory.length" layout="prev, pager, next" small hide-on-single-page /></div>
  </section>

  <!-- 历史日志查看 -->
  <el-dialog v-model="logDialog" title="部署日志" width="860px" top="6vh">
    <pre class="dialog-log">{{ dialogLog || '（无日志内容）' }}</pre>
  </el-dialog>

  <!-- 本次更新内容：提交记录 → 通俗中文说明 -->
  <el-dialog v-model="changeDialog" title="本次更新内容" width="720px" top="8vh">
    <div v-if="changeRow" class="change-body">
      <div class="change-head">
        <span class="mono change-version">{{ changeRow.version || '未标版本' }}</span>
        <span class="change-time">{{ fmtTime(changeRow.startedAt) }}</span>
        <el-tag size="small" type="info" effect="plain">{{ changeRow.targetName || '默认环境' }}</el-tag>
        <el-tag v-if="changeRow.changeSummarySource === 'ai'" size="small" type="success" effect="plain">已用 AI 整理成大白话</el-tag>
        <el-tag v-else-if="changeRow.changeSummary" size="small" effect="plain">本地自动整理</el-tag>
      </div>
      <div v-if="changeRow.gitAnchor" class="change-scope">收录范围：{{ changeRow.gitAnchor }}</div>

      <pre class="change-summary">{{ changeRow.changeSummary || '（还没有生成更新说明）' }}</pre>

      <div class="change-actions">
        <el-button size="small" :loading="summarizing" @click="regenerate">用 AI 重新整理成大白话</el-button>
        <template v-if="changeRow.gitHead">
          <el-input v-model="tagName" size="small" class="tag-input" placeholder="标签名" />
          <el-button size="small" :loading="tagging" @click="doTag">打标签</el-button>
        </template>
      </div>
      <div v-if="changeRow.gitHead" class="change-meta mono">
        本次提交 {{ String(changeRow.gitHead).slice(0, 8) }}{{ changeRow.gitTag ? ` · 已打标签 ${changeRow.gitTag}` : '' }}
      </div>

      <el-collapse v-if="commitsOfChange.length" class="change-commits">
        <el-collapse-item :title="`原始提交记录（${commitsOfChange.length} 条）`">
          <div v-for="c in commitsOfChange" :key="c.hash" class="commit-row">
            <span class="mono commit-hash">{{ String(c.hash || '').slice(0, 8) }}</span>
            <span class="commit-date">{{ c.date }}</span>
            <span class="commit-subject">{{ c.subject }}</span>
          </div>
        </el-collapse-item>
      </el-collapse>
      <div v-else class="change-empty">
        这次发布没有采集到提交记录。项目目录不是 Git 仓库，或发布的是已经打好的成品包时，就没有可用的更新内容。
      </div>
    </div>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../../store'
import { fmtTime, fmtDur } from './deploy-form'

const props = defineProps({
  /** 当前项目 id（空串表示未保存的新项目，查询全部历史） */
  projectId: { type: String, default: '' },
})
const emit = defineEmits(['rollback'])

const history = ref([])
const loading = ref(false)
const loadError = ref('')
const statusFilter = ref('')
const sort = ref({ prop: 'startedAt', order: 'descending' })
const page = ref(1)
const pageSize = 6
const filteredHistory = computed(() => {
  const rows = history.value.filter((row) => !statusFilter.value || row.status === statusFilter.value)
  const { prop, order } = sort.value
  if (!prop || !order) return rows
  const value = (row) => prop === 'startedAt' ? (Number(row[prop]) || Date.parse(row[prop]) || 0) : (Number(row[prop]) || 0)
  return rows.sort((a, b) => (value(a) - value(b)) * (order === 'ascending' ? 1 : -1))
})
const pagedHistory = computed(() => filteredHistory.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch(statusFilter, () => { page.value = 1 })
watch(() => filteredHistory.value.length, (count) => { page.value = Math.max(1, Math.min(page.value, Math.ceil(count / pageSize))) })
function onSort({ prop, order }) { sort.value = { prop, order }; page.value = 1 }
function onRowCommand(command, row) {
  if (command === 'log') viewLog(row)
  else if (command === 'changes') openChanges(row)
  else if (command === 'rollback') rollbackRecord(row)
}
const logDialog = ref(false)
const dialogLog = ref('')
const changeDialog = ref(false)
const changeRecordId = ref('')
const summarizing = ref(false)
const tagging = ref(false)
const tagName = ref('')
let offHistoryUpdated = null
let historyRequest = 0

/** 弹窗当前展示的记录：从表格数据里取，生成总结/打标签后 reload 即自动刷新 */
const changeRow = computed(() => history.value.find((r) => r.id === changeRecordId.value) || null)
const commitsOfChange = computed(() => {
  const rows = (changeRow.value && changeRow.value.gitCommits) || []
  return Array.isArray(rows) ? rows : []
})

function hasChanges(row) {
  return !!(row && (row.changeSummary || (Array.isArray(row.gitCommits) && row.gitCommits.length)))
}
function changeCount(row) {
  const n = Array.isArray(row && row.gitCommits) ? row.gitCommits.length : 0
  return n || 0
}

function openChanges(row) {
  changeRecordId.value = row.id
  const v = String(row.version || '').trim().replace(/^v/i, '')
  tagName.value = v && /^[\w.+-]+$/.test(v) ? `v${v}` : ''
  changeDialog.value = true
}

// ─── 历史 ───
// 过期响应防护：快速连续切换项目时，先发请求可能后回，落表前校验项目未再变化
async function loadHistory() {
  const pid = props.projectId || undefined
  const request = ++historyRequest
  loading.value = true
  loadError.value = ''
  try {
    const rows = await window.gitReport.deployHistoryList(pid) || []
    if (request === historyRequest && (props.projectId || undefined) === pid) history.value = Array.isArray(rows) ? rows : []
  } catch {
    if (request === historyRequest && (props.projectId || undefined) === pid) {
      history.value = []
      loadError.value = '发布历史读取失败，请重试'
    }
  } finally {
    if (request === historyRequest && (props.projectId || undefined) === pid) loading.value = false
  }
}

function rollbackRecord(row) {
  if (!props.projectId || row.projectId !== props.projectId || row.type !== 'deploy' || row.status !== 'success') return
  const release = row.releaseId || row.version
  if (release && release !== state.deploy.currentVersion) emit('rollback', release, row.targetId)
}

// 项目切换时跟随刷新：props 由父组件重渲染异步更新，父层同步调用 reload 会读到旧 id，
// 因此数据加载统一由本 watch 驱动（immediate 覆盖首载，此时 projectId 可能为空=查全部）
watch(() => props.projectId, () => {
  history.value = []
  statusFilter.value = ''
  page.value = 1
  changeRecordId.value = ''
  changeDialog.value = false
  logDialog.value = false
  dialogLog.value = ''
  loadHistory()
}, { immediate: true, flush: 'sync' })

// 发布成功后主进程在后台整理更新内容，完成后推送刷新（弹窗打开时也随之更新）
onMounted(() => {
  offHistoryUpdated = window.gitReport.onDeployHistoryUpdated(() => loadHistory())
})
onUnmounted(() => { if (offHistoryUpdated) offHistoryUpdated() })

async function viewLog(row) {
  const pid = props.projectId
  const content = await window.gitReport.deployHistoryReadLog(row.logFile) || ''
  if (pid !== props.projectId) return
  dialogLog.value = content
  logDialog.value = true
}

async function regenerate() {
  if (!changeRow.value) return
  summarizing.value = true
  try {
    const r = await window.gitReport.deployHistorySummarize(changeRow.value.id, true)
    if (!r || !r.ok) {
      ElMessage.warning((r && r.error) || '整理失败')
      return
    }
    await loadHistory()
    if (r.source === 'ai') ElMessage.success('已重新整理成大白话')
    else ElMessage.warning(r.error || 'AI 暂时用不了，已保留本地整理的说明')
  } finally {
    summarizing.value = false
  }
}

async function doTag() {
  if (!changeRow.value) return
  tagging.value = true
  try {
    const r = await window.gitReport.deployHistoryTag(changeRow.value.id, tagName.value)
    if (!r || !r.ok) {
      ElMessage.error((r && r.error) || '打标签失败')
      return
    }
    await loadHistory()
    ElMessage.success(r.existed ? `标签 ${r.tag} 已经存在，未做改动` : `已打上标签 ${r.tag}`)
  } finally {
    tagging.value = false
  }
}

async function clearHistory() {
  const pid = props.projectId || undefined
  // projectId 为空 = 查询/清空全部项目的历史：确认文案必须如实说明作用域，防止误删
  const scopeAll = !props.projectId
  try {
    await ElMessageBox.confirm(
      scopeAll ? '当前未选择具体项目：确认清空【全部项目】的发布历史？（服务器文件不受影响）' : '确认清空该项目的发布历史？（服务器文件不受影响）',
      scopeAll ? '清空全部发布历史' : '清空历史',
      { type: 'warning' },
    )
  } catch { return }
  if ((props.projectId || undefined) !== pid) return
  await window.gitReport.deployHistoryClear(pid)
  if ((props.projectId || undefined) === pid) loadHistory()
}

// ─── 工具 ───
function statusType(s) {
  return { success: 'success', failed: 'danger', rolled_back: 'warning', canceled: 'info', running: 'primary' }[s] || 'info'
}
function statusText(s) {
  return { success: '成功', failed: '失败', rolled_back: '已回滚', canceled: '已取消', running: '进行中' }[s] || s
}

defineExpose({ reload: loadHistory })
</script>

<style scoped>
.deploy-card-history { min-width: 0; }
.history-heading { min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.history-heading h2 { margin: 0; font-size: 14px; color: var(--brand-text); font-weight: 600; }
.history-controls { display: flex; align-items: center; gap: 8px; }
.history-filter { width: 120px; }
.history-danger { color: var(--danger); }
.history-error { margin-bottom: 12px; }
.history-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; color: var(--text-muted); font-size: 12px; }
.deploy-card-history :deep(.el-table__row) { height: 40px; cursor: default; }
.deploy-card-history :deep(.el-table__cell) { padding: 4px 0; }
.deploy-card-history :deep(.el-table th.el-table__cell) { height: 36px; background: var(--brand-bg); color: var(--text-muted); font-size: 12px; font-weight: 400; }
.deploy-card-history :deep(.el-table .cell) { font-size: 12px; }
.deploy-card-history :deep(.el-table .el-tag) { border: 0; background: transparent; }
.cur-tag { margin-left: 8px; }
.muted { color: var(--el-text-color-placeholder); }
.change-count { margin-left: 2px; }
.dialog-log {
  background: #14181f;
  color: #b8c0ca;
  border-radius: 8px;
  padding: 16px;
  max-height: 62vh;
  overflow: auto;
  font-family: var(--brand-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
.change-body { display: flex; flex-direction: column; gap: 12px; }
.change-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.change-version { font-weight: 600; }
.change-time { color: var(--el-text-color-secondary); font-size: 12px; }
.change-scope { color: var(--el-text-color-secondary); font-size: 12px; }
.change-summary {
  margin: 0;
  padding: 12px 16px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.8;
  font-size: 13px;
  max-height: 34vh;
  overflow: auto;
}
.change-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag-input { width: 150px; }
.change-meta { color: var(--el-text-color-secondary); font-size: 12px; }
.commit-row { display: flex; gap: 8px; padding: 4px 0; font-size: 12px; align-items: baseline; }
.commit-hash { color: var(--el-text-color-secondary); flex: none; }
.commit-date { color: var(--el-text-color-secondary); flex: none; }
.commit-subject { flex: 1; word-break: break-word; }
.change-empty { color: var(--el-text-color-secondary); font-size: 12px; }
</style>
