<template>
  <el-dialog
    :model-value="modelValue"
    title="增加发布"
    width="min(820px, calc(100vw - 40px))"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="batch-note">填写新版本后，将在对应任务开始时更新该项目的发布版本。留空沿用当前版本策略。</p>
    <el-checkbox-group v-model="selectedProjectIds" class="batch-review" aria-label="发布项目">
      <div class="batch-row batch-head"><span>项目</span><span>部署环境</span><span>发布版本</span></div>
      <div v-for="row in rows" :key="row.project.id" class="batch-row">
        <el-checkbox class="batch-project" :value="row.project.id" :disabled="!isSelected(row) && !!selectionIssue(row)">
          <span class="batch-option-name">{{ row.project.name }}</span>
        </el-checkbox>
        <div class="batch-target">
          <el-select v-if="row.project.targets?.length > 1" v-model="row.targetId" :disabled="!isSelected(row)" :aria-label="`${row.project.name}的部署环境`" size="small">
            <el-option v-for="target in row.project.targets" :key="target.id" :label="target.name || '未命名环境'" :value="target.id" />
          </el-select>
          <span v-else>{{ targetFor(row)?.name || '未配置环境' }}</span>
          <span v-if="targetFor(row)?.server?.host" class="batch-address mono">{{ targetAddress(targetFor(row)) }}</span>
        </div>
        <div class="batch-version">
          <el-input
            v-model="row.versionOverride"
            :disabled="!isSelected(row)"
            :aria-label="`${row.project.name}的发布版本`"
            :placeholder="row.resolving ? '正在识别版本' : row.version || versionPlaceholder(row)"
            maxlength="64"
            size="small"
          />
        </div>
        <p v-if="isSelected(row) ? rowIssue(row) : selectionIssue(row)" class="batch-error">
          {{ isSelected(row) ? rowIssue(row) : selectionIssue(row) }}
        </p>
      </div>
    </el-checkbox-group>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">{{ selectedRows.length ? `发布 ${selectedRows.length} 个项目` : '发布' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { deployRunFor, state, submitDeployRun } from '../../store'
import { preferredDeployTarget, publishBlocker } from './deploy-form'

const props = defineProps({
  modelValue: Boolean,
  currentProjectId: { type: String, default: '' },
  currentTargetId: { type: String, default: '' },
  currentDirty: Boolean,
})
const emit = defineEmits(['update:modelValue'])
const rows = ref([])
const selectedProjectIds = ref([])
const selectedRows = computed(() => selectedProjectIds.value.map((id) => rows.value.find((row) => row.project.id === id)).filter(Boolean))
const canSubmit = computed(() => selectedRows.value.length > 0 && selectedRows.value.every((row) =>
  (!row.resolving || row.versionOverride.trim()) && !rowIssue(row)))

function isSelected(row) {
  return selectedProjectIds.value.includes(row.project.id)
}

function targetFor(row) {
  return row.project.targets?.find((target) => target.id === row.targetId)
}

function targetAddress(target) {
  const { host, port, username } = target.server
  const endpoint = `${username ? `${username}@` : ''}${host.includes(':') ? `[${host}]` : host}:${Number(port) || 22}`
  return `${endpoint} → ${target.remotePath || '自动分配目录'}`
}

function selectionIssue(row) {
  const id = row.project.id
  const busy = deployRunFor(id).running
  const dirty = id === props.currentProjectId ? props.currentDirty : !!state.deploy.configDrafts[id]
  if (busy) return '该项目已有部署任务进行中'
  if (dirty) return '请先保存部署设置中的修改'
  return ''
}

function rowIssue(row) {
  const edited = row.versionOverride.trim()
  if (edited && !/^[\w][\w.+~-]{0,63}$/.test(edited)) return '请输入有效的发布版本号'
  return selectionIssue(row) || publishBlocker(row.project, targetFor(row), edited || row.version, { checkingVersion: row.resolving })
}

function versionPlaceholder(row) {
  if (!row.checkedVersion) return '勾选后识别'
  return row.autoVersion ? '发布时生成版本' : '填写发布版本'
}

watch(() => props.modelValue, (open) => {
  selectedProjectIds.value = []
  rows.value = open ? state.deploy.projects.map((project) => {
    const target = preferredDeployTarget(project, project.id === props.currentProjectId ? props.currentTargetId : '')
    const version = project.version?.strategy === 'manual' ? project.version.manual : ''
    return {
      project, targetId: target?.id || '', version, versionOverride: '',
      resolving: false, checkedVersion: !!version || !project.localPath,
      autoVersion: project.deployMode === 'auto' && project.configMode !== 'quick',
    }
  }) : []
}, { immediate: true })

watch(selectedRows, (selected) => {
  for (const row of selected) {
    if (row.checkedVersion) continue
    row.checkedVersion = true
    row.resolving = true
    const { localPath, version } = row.project
    window.gitReport.deployDetectVersion({ localPath, version }).then((result) => {
      row.version = result?.version || ''
    }).catch(() => {}).finally(() => { row.resolving = false })
  }
}, { flush: 'sync' })

function submit() {
  if (!canSubmit.value) return
  for (const row of selectedRows.value) {
    const project = row.project
    const target = targetFor(row)
    const versionOverride = row.versionOverride.trim()
    const plan = {
      localPath: project.localPath,
      host: target.server.host, port: Number(target.server.port) || 22, username: target.server.username || '',
      remotePath: target.remotePath,
      versionOverride,
      expectedVersion: versionOverride || row.version || '',
    }
    void submitDeployRun(project.id, target.id, target.name, plan).then((result) => {
      if (result?.error) ElMessage.error(`${project.name}：${result.error}`)
    })
  }
  emit('update:modelValue', false)
}
</script>

<style scoped>
.batch-note { margin: 0 0 14px; color: var(--text-muted); }
.batch-review { max-height: min(430px, 55vh); overflow: auto; border-top: 1px solid var(--line); }
.batch-row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(170px, 2fr) minmax(130px, 1fr); gap: 6px 16px; align-items: start; padding: 12px 4px; border-bottom: 1px solid var(--line); }
.batch-head { font-size: 12px; color: var(--text-muted); }
.batch-project { margin-right: 0; min-width: 0; height: auto; min-height: 24px; color: var(--brand-text); }
.batch-project :deep(.el-checkbox__label) { min-width: 0; white-space: normal; }
.batch-option-name { overflow-wrap: anywhere; }
.batch-target { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.batch-address { font-size: 12px; color: var(--text-muted); overflow-wrap: anywhere; }
.batch-version { min-width: 0; }
.batch-error { grid-column: 1 / -1; margin: 0; color: var(--el-color-danger); }
@media (max-width: 560px) {
  .batch-head { display: none; }
  .batch-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .batch-project, .batch-target { grid-column: 1 / -1; }
}
</style>
