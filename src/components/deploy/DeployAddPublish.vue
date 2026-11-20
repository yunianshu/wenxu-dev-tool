<template>
  <el-dialog
    :model-value="modelValue"
    title="增加发布"
    width="min(480px, calc(100vw - 40px))"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-position="top" class="publish-form" @submit.prevent>
      <el-form-item label="发布项目">
        <el-select v-model="projectId" placeholder="选择项目" filterable>
          <el-option
            v-for="option in projectOptions"
            :key="option.id"
            :value="option.id"
            :label="option.label"
            :disabled="option.disabled"
          />
        </el-select>
      </el-form-item>
      <template v-if="project">
        <el-form-item label="部署环境">
          <el-select v-model="targetId" placeholder="选择环境" :disabled="!project.targets?.length">
            <el-option v-for="env in project.targets" :key="env.id" :value="env.id" :label="env.name || '未命名环境'" />
          </el-select>
          <div v-if="target?.server?.host" class="publish-detail mono">{{ targetAddress }}</div>
        </el-form-item>
        <el-form-item label="发布版本">
          <el-input v-model="versionOverride" :placeholder="versionPlaceholder" maxlength="64" />
          <div v-if="versionOverride.trim()" class="publish-detail">新版本号会在任务开始时保存到该项目。</div>
        </el-form-item>
        <p v-if="issue" class="publish-error" role="status">{{ issue }}</p>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!canSubmit" @click="submit">发布</el-button>
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
const projectId = ref('')
const targetId = ref('')
const versionOverride = ref('')
const detectedVersion = ref('')
const resolvingVersion = ref(false)

function projectIssue(id) {
  if (deployRunFor(id).running) return '已有部署任务进行中'
  const dirty = id === props.currentProjectId ? props.currentDirty : !!state.deploy.configDrafts[id]
  return dirty ? '部署设置有未保存的修改' : ''
}

const projectOptions = computed(() => state.deploy.projects.map(({ id, name }) => {
  const reason = projectIssue(id)
  return { id, label: reason ? `${name}（${reason}）` : name, disabled: !!reason }
}))
const project = computed(() => state.deploy.projects.find((item) => item.id === projectId.value))
const target = computed(() => project.value?.targets?.find((item) => item.id === targetId.value))
const targetAddress = computed(() => {
  const { host, port, username } = target.value.server
  const address = host.includes(':') ? `[${host}]` : host
  return `${username ? `${username}@` : ''}${address}:${Number(port) || 22} → ${target.value.remotePath || '自动分配目录'}`
})
const manualVersion = computed(() => project.value?.version?.strategy === 'manual' ? project.value.version.manual || '' : '')
const version = computed(() => manualVersion.value || detectedVersion.value)
const editedVersion = computed(() => versionOverride.value.trim())
const versionPlaceholder = computed(() => {
  if (resolvingVersion.value) return '正在识别版本'
  if (version.value) return `${version.value}（留空沿用）`
  return project.value?.deployMode === 'auto' && project.value.configMode !== 'quick' ? '发布时生成版本' : '填写发布版本'
})
const issue = computed(() => {
  if (!project.value) return ''
  if (editedVersion.value && !/^[\w][\w.+~-]{0,63}$/.test(editedVersion.value)) return '请输入有效的发布版本号'
  return projectIssue(projectId.value) || publishBlocker(project.value, target.value, editedVersion.value || version.value, {
    checkingVersion: resolvingVersion.value,
  })
})
const canSubmit = computed(() => props.modelValue && !!project.value && !issue.value && (!resolvingVersion.value || !!editedVersion.value))

watch(() => props.modelValue, (open) => {
  if (!open) projectId.value = ''
})

watch(projectId, (id) => {
  const preferredId = id === props.currentProjectId ? props.currentTargetId : ''
  targetId.value = preferredDeployTarget(project.value, preferredId)?.id || ''
  versionOverride.value = ''
}, { flush: 'sync' })

watch([projectId, () => project.value?.localPath, () => project.value?.version?.strategy, manualVersion], async ([, localPath], _, onCleanup) => {
  detectedVersion.value = ''
  resolvingVersion.value = false
  if (!localPath || manualVersion.value) return
  let current = true
  onCleanup(() => { current = false })
  resolvingVersion.value = true
  try {
    const result = await window.gitReport.deployDetectVersion({ localPath, version: project.value.version })
    if (current) detectedVersion.value = result?.version || ''
  } catch { /* 未识别到版本时仍可手动填写 */ }
  finally {
    if (current) resolvingVersion.value = false
  }
})

function submit() {
  if (!canSubmit.value) return
  const { id, name, localPath } = project.value
  const { server, remotePath } = target.value
  const plan = {
    localPath,
    host: server.host, port: Number(server.port) || 22, username: server.username || '',
    remotePath,
    versionOverride: editedVersion.value,
    expectedVersion: editedVersion.value || version.value,
  }
  void submitDeployRun(id, target.value.id, target.value.name, plan).then((result) => {
    if (result?.error) ElMessage.error(`${name}：${result.error}`)
  })
  emit('update:modelValue', false)
}
</script>

<style scoped>
.publish-form :deep(.el-select) { width: 100%; }
.publish-detail { width: 100%; margin-top: 4px; color: var(--text-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.publish-error { margin: 0; color: var(--el-color-danger); }
</style>
