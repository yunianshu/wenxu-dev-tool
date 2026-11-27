<template>
  <el-dialog
    :model-value="modelValue"
    :title="`环境同步 · ${form.name || '当前项目'}`"
    width="min(620px, calc(100vw - 40px))"
    append-to-body
    class="env-sync-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="env-row">
      <div class="env-field">
        <span class="env-label">源环境</span>
        <el-select v-model="sourceTargetId" :disabled="running" aria-label="源环境">
          <el-option v-for="t in targets" :key="t.id" :value="t.id" :label="t.name || '未命名环境'" />
        </el-select>
      </div>
      <el-icon class="env-arrow"><Right /></el-icon>
      <div class="env-field">
        <span class="env-label">目标环境</span>
        <el-select v-model="destTargetId" :disabled="running" aria-label="目标环境">
          <el-option v-for="t in targets" :key="t.id" :value="t.id" :label="t.name || '未命名环境'" :disabled="t.id === sourceTargetId" />
        </el-select>
      </div>
    </div>
    <div class="env-address mono">{{ address(sourceTarget) }}<span v-if="sourceTarget && destTarget"> → </span>{{ address(destTarget) }}</div>

    <div v-loading="loading" class="sync-body" aria-live="polite">
      <div v-if="error" class="sync-error" role="alert">{{ error }}</div>
      <template v-else-if="preview">
        <div class="kv">
          <span class="k">源版本</span>
          <span class="v">
            <span class="mono">{{ preview.source.version || '—' }}</span>
            <el-tag v-if="preview.source.package" size="small" effect="plain" :type="preview.source.package === 'kept' ? 'success' : 'warning'">
              {{ preview.source.package === 'kept' ? '原始发布包' : '重新打包版本目录' }}
            </el-tag>
          </span>
        </div>
        <div class="kv">
          <span class="k">目标当前版本</span>
          <span class="v">
            <span class="mono">{{ preview.dest.version || '未部署' }}</span>
            <el-tag size="small" effect="plain" :type="preview.needDeploy ? 'warning' : 'info'">{{ preview.needDeploy ? '待同步' : '已是该版本' }}</el-tag>
          </span>
        </div>
        <div class="kv">
          <span class="k">同步数据库</span>
          <span class="v">
            <el-switch v-model="syncData" :disabled="running || !preview.dataSync.available" aria-label="同步数据库" />
            <span v-if="!preview.dataSync.available" class="muted">{{ preview.dataSync.reason }}</span>
          </span>
        </div>
        <div v-if="preview.dataSync.source" class="kv"><span class="k">源数据库</span><span class="v mono">{{ dbText(preview.dataSync.source) }}</span></div>
        <div v-if="preview.dataSync.dest" class="kv"><span class="k">目标数据库</span><span class="v mono">{{ dbText(preview.dataSync.dest) }}</span></div>
        <div v-if="preview.dataSync.available" class="kv"><span class="k">运行配置</span><span class="v">各环境保持独立（shared/.env 不同步）</span></div>
        <el-alert v-if="preview.dataSync.fresh && !syncData" title="目标环境尚未部署。仅同步版本可能触发空库初始化。迁移现有数据时，请开启同步数据库。" type="warning" :closable="false" class="sync-note" />
        <el-alert v-if="!preview.needDeploy && preview.dataSync.available && !syncData && !preview.problems.length" title="两侧版本已一致。开启同步数据库后，可用源库覆盖目标库。" type="info" :closable="false" class="sync-note" />
        <el-alert v-for="w in preview.warnings" :key="w" :title="w" type="warning" :closable="false" class="sync-note" />
        <el-alert v-if="preview.problems.length" type="error" :closable="false" show-icon class="sync-note">
          <template #title>
            <span v-for="(p, i) in preview.problems" :key="i" class="problem">{{ p }}</span>
          </template>
        </el-alert>
      </template>
    </div>

    <template #footer>
      <el-button :disabled="running" @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :loading="running" :disabled="!canStart" @click="start">开始同步</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { ref, computed, watch, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { beginDeployRun, deployRunFor, finishDeployRun } from '../../store'

const props = defineProps({
  modelValue: Boolean,
  /** 部署表单（只读使用） */
  form: { type: Object, required: true },
  /** 打开时默认选中的源环境 */
  activeTargetId: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'done'])

/** 可参与同步的环境：服务器与部署目录都已配置 */
const targets = computed(() => (props.form.targets || []).filter((t) => t.server && t.server.host && t.remotePath))
const sourceTargetId = ref('')
const destTargetId = ref('')
const sourceTarget = computed(() => targets.value.find((t) => t.id === sourceTargetId.value))
const destTarget = computed(() => targets.value.find((t) => t.id === destTargetId.value))
const preview = ref(null)
const loading = ref(false)
const error = ref('')
const syncData = ref(false)
let request = 0
let disposed = false

const run = computed(() => deployRunFor(props.form.id))
const running = computed(() => run.value.running && run.value.type === 'promote')
const canStart = computed(() => !!preview.value && !preview.value.problems.length && !loading.value && !error.value
  && (preview.value.needDeploy || (syncData.value && preview.value.dataSync.available))
  && !!sourceTargetId.value && !!destTargetId.value && !running.value)

function address(target) {
  if (!target) return ''
  const host = target.server.host.includes(':') ? `[${target.server.host}]` : target.server.host
  return `${host}:${Number(target.server.port) || 22} → ${target.remotePath}`
}
function dbText(db) {
  // 全新目标环境：数据库容器随本次发布才创建，只给得出编排里的服务名与库名
  if (db.fresh && !db.container) return `数据库服务 ${db.service} / ${db.name}（随本次发布创建）`
  return `${db.container} / ${db.name}（PostgreSQL ${db.version} · ${db.size}）`
}

/** 预检只读；切换环境后丢弃过期结果 */
async function load() {
  const current = ++request
  preview.value = null
  error.value = ''
  syncData.value = false
  if (!props.form.id || !sourceTargetId.value || !destTargetId.value) return
  loading.value = true
  try {
    const result = await window.gitReport.deployPromotePreview(props.form.id, sourceTargetId.value, destTargetId.value)
    if (disposed || current !== request) return
    if (!result || result.ok === false) {
      error.value = (result && result.error) || '预检失败'
      return
    }
    preview.value = result
  } catch (e) {
    if (!disposed && current === request) error.value = e.message || String(e)
  } finally {
    if (current === request) loading.value = false
  }
}

/** 默认源环境为当前环境，目标优先取正式环境；返回选择是否有变化（有变化由 watch 触发预检） */
function onOpen() {
  const before = `${sourceTargetId.value}|${destTargetId.value}`
  const list = targets.value
  const source = list.find((t) => t.id === props.activeTargetId) || list[0]
  sourceTargetId.value = (source && source.id) || ''
  const production = list.find((t) => t.id === props.form.productionTargetId && t.id !== sourceTargetId.value)
  destTargetId.value = (production || list.find((t) => t.id !== sourceTargetId.value) || {}).id || ''
  return before === `${sourceTargetId.value}|${destTargetId.value}`
}

watch([sourceTargetId, destTargetId], () => { if (props.modelValue) void load() })
watch(() => props.modelValue, (open) => { if (open && onOpen()) void load() })
onUnmounted(() => { disposed = true })

async function start() {
  if (!canStart.value) return
  const p = preview.value
  const source = sourceTarget.value
  const dest = destTarget.value
  const version = p.source.version
  const data = syncData.value && p.dataSync.available ? p.dataSync : null
  const lines = []
  if (p.needDeploy) lines.push(`将把【${source.name}】的版本 ${version} 发布到【${dest.name}】（${address(dest)}）。`)
  if (p.dataSync.fresh && !data) lines.push('目标环境尚未部署，仅同步版本可能触发空库初始化。')
  if (data && data.fresh) lines.push(`将先把【${source.name}】的数据库 ${data.source.name} 灌入【${dest.name}】的数据库 ${data.dest.name}，再启动应用；目标库如有数据会先自动保底备份。`)
  else if (data) lines.push(`将用【${source.name}】的数据库 ${data.source.name} 完全替换【${dest.name}】的数据库 ${data.dest.name}，目标库现有数据会先自动保底备份。`)
  try {
    await ElMessageBox.confirm(lines.join(''), '确认环境同步', { type: data ? 'warning' : 'info', confirmButtonText: '开始同步', cancelButtonText: '取消' })
  } catch { return }

  const projectId = props.form.id
  const operation = beginDeployRun(projectId, 'promote', dest.name, version)
  let result = null
  try {
    result = await window.gitReport.deployPromote(projectId, source.id, dest.id, { syncData: !!data, expectedVersion: version, expectedDestVersion: p.dest.version }, operation.requestId)
    const record = result && result.record
    if (result && result.ok) {
      ElMessage.success((record && record.message) || '环境同步完成')
    } else if (record && record.status === 'canceled') {
      ElMessage.info(record.message || '同步已取消')
    } else {
      const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
      await ElMessageBox.alert(
        `<b>${esc(dest.name)}</b> ${esc(version)}<br/><br/>${record && record.deployed ? '版本已发布，' : ''}${esc((result && result.error) || (record && record.message) || '同步失败')}<br/><br/>详见发布日志。`,
        record && record.status === 'rolled_back' ? '已自动回滚' : '同步未完成',
        { dangerouslyUseHTMLString: true, type: 'error', confirmButtonText: '知道了' },
      )
    }
  } catch (e) {
    ElMessage.error(e.message || String(e))
  } finally {
    finishDeployRun(operation, result && result.record)
    emit('done')
    // 目标环境可能刚完成首次部署：立即重新预检，数据同步入口随之可用
    if (props.modelValue && !disposed) void load()
  }
}
</script>

<style scoped>
.env-row { display: flex; align-items: flex-end; gap: 12px; }
.env-field { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.env-label { font-size: 12px; color: var(--text-muted); }
.env-field .el-select { width: 100%; }
.env-arrow { flex: none; padding-bottom: 8px; color: var(--text-disabled); }
.env-address { margin: 8px 0 12px; font-size: 12px; color: var(--brand-text-sub); overflow-wrap: anywhere; }
.sync-body { min-height: 132px; display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 6px; }
/* 两栏对齐：左列固定宽的标签，右列的值与标签/开关同行排布，放不下再折行 */
.kv { display: grid; grid-template-columns: 96px minmax(0, 1fr); align-items: center; column-gap: 12px; min-height: 24px; font-size: 13px; }
.k { color: var(--text-muted); font-size: 12px; }
.v { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; color: var(--brand-text); overflow-wrap: anywhere; }
.v.mono { font-family: var(--brand-mono); }
.muted { color: var(--brand-text-sub); font-size: 12px; }
.sync-error { color: var(--danger); font-size: 13px; }
.sync-note { margin: 0; }
.problem { display: block; }
.problem + .problem { margin-top: 4px; }
</style>
