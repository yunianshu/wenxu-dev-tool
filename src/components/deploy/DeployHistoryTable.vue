<template>
  <el-card shadow="never" class="card deploy-card-history">
    <template #header>
      <div class="card-header">
        <span>发布历史</span>
        <el-button text size="small" type="danger" :disabled="!history.length" @click="clearHistory">清空</el-button>
      </div>
    </template>
    <el-table :data="history" size="small" max-height="320" empty-text="暂无发布记录">
      <el-table-column prop="version" label="版本" width="100">
        <template #default="{ row }">
          <span class="mono">{{ row.version || '—' }}</span>
          <el-tag v-if="row.version && (row.releaseId || row.version) === state.deploy.currentVersion" size="small" type="success" effect="plain" class="cur-tag">运行中</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="目标" width="90">
        <template #default="{ row }">
          <span>{{ row.targetName || '默认' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="80">
        <template #default="{ row }">{{ fmtDur(row.durationMs) }}</template>
      </el-table-column>
      <el-table-column label="时间" width="150">
        <template #default="{ row }">{{ fmtTime(row.startedAt) }}</template>
      </el-table-column>
      <el-table-column label="类型" width="70">
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
      <el-table-column label="更新内容" width="110">
        <template #default="{ row }">
          <el-button v-if="hasChanges(row)" text size="small" type="primary" @click="openChanges(row)">
            查看<span v-if="changeCount(row)" class="change-count">（{{ changeCount(row) }}）</span>
          </el-button>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="message" label="说明" show-overflow-tooltip />
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }">
          <el-button text size="small" type="primary" @click="viewLog(row)">日志</el-button>
          <el-button
            v-if="row.projectId === projectId && row.type === 'deploy' && row.status === 'success' && (row.releaseId || row.version) !== state.deploy.currentVersion"
            text size="small" type="warning" @click="rollbackRecord(row)"
          >回滚</el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

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
  try {
    const rows = await window.gitReport.deployHistoryList(pid) || []
    if (request === historyRequest && (props.projectId || undefined) === pid) history.value = rows
  } catch {
    if (request === historyRequest && (props.projectId || undefined) === pid) history.value = []
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
.cur-tag { margin-left: 6px; }
.muted { color: var(--el-text-color-placeholder); }
.change-count { margin-left: 2px; }
.dialog-log {
  background: #14181f;
  color: #b8c0ca;
  border-radius: 8px;
  padding: 14px;
  max-height: 62vh;
  overflow: auto;
  font-family: var(--brand-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
}
.change-body { display: flex; flex-direction: column; gap: 10px; }
.change-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.change-version { font-weight: 600; }
.change-time { color: var(--el-text-color-secondary); font-size: 12.5px; }
.change-scope { color: var(--el-text-color-secondary); font-size: 12.5px; }
.change-summary {
  margin: 0;
  padding: 12px 14px;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.8;
  font-size: 13.5px;
  max-height: 34vh;
  overflow: auto;
}
.change-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag-input { width: 150px; }
.change-meta { color: var(--el-text-color-secondary); font-size: 12px; }
.commit-row { display: flex; gap: 8px; padding: 3px 0; font-size: 12.5px; align-items: baseline; }
.commit-hash { color: var(--el-text-color-secondary); flex: none; }
.commit-date { color: var(--el-text-color-secondary); flex: none; }
.commit-subject { flex: 1; word-break: break-word; }
.change-empty { color: var(--el-text-color-secondary); font-size: 12.5px; }
</style>
