<template>
  <el-dialog
    :model-value="visible" :title="form.id ? '编辑项目' : '新建项目'" width="496px"
    class="project-editor-dialog" align-center :close-on-click-modal="false"
    :close-on-press-escape="!saving" :show-close="!saving" @close="close" @opened="nameInput?.focus()"
  >
    <el-form label-position="top" class="project-form" :disabled="saving" @submit.prevent="submit" @keydown.ctrl.s.prevent="submit">
      <el-form-item label="项目名称" required>
        <el-input ref="nameInput" v-model="form.name" maxlength="60" placeholder="输入项目名称" autocomplete="off" />
      </el-form-item>
      <el-form-item label="项目说明">
        <el-input v-model="form.description" type="textarea" :rows="2" maxlength="240" placeholder="这个项目用于什么" resize="vertical" />
      </el-form-item>
      <el-form-item label="本地目录（可选）">
        <div class="path-input-row">
          <el-input v-model="form.localPath" placeholder="选择目录，无需是 Git 仓库" />
          <el-button :loading="browsing" aria-label="选择本地目录" @click="browse"><el-icon><FolderOpened /></el-icon>选择</el-button>
        </div>
      </el-form-item>
      <el-form-item label="状态" class="project-state-field">
        <el-select v-model="form.status" aria-label="项目状态">
          <el-option v-for="option in STATUS_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <button class="project-more-fields" type="button" :aria-expanded="advanced" aria-controls="project-advanced-fields" :disabled="saving" @click="advanced = !advanced">
        <el-icon :class="{ expanded: advanced }"><ArrowRight /></el-icon><span>标签与项目备注</span><small>可选</small>
      </button>
      <div v-show="advanced" id="project-advanced-fields" class="project-advanced-fields">
        <el-form-item label="标签">
          <el-select v-model="form.tags" multiple filterable allow-create default-first-option placeholder="输入后回车添加" style="width: 100%" />
        </el-form-item>
        <el-form-item label="项目备注">
          <el-input v-model="form.notes" type="textarea" :rows="4" maxlength="4000" show-word-limit placeholder="记录目标、约束、风险或下一步，AI 可按需读取。" />
        </el-form-item>
      </div>
    </el-form>
    <template #footer>
      <div class="project-editor-footer">
        <el-button :disabled="saving" @click="close">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!form.name.trim() || saving" @click="submit">{{ form.id ? '保存项目' : '创建项目' }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

const props = defineProps({
  visible: { type: Boolean, default: false },
  project: { type: Object, default: null },
  /** 父组件的保存进行中状态：emit 不等待异步保存完成，本地 saving 无法覆盖保存期 */
  saving: { type: Boolean, default: false },
})
const emit = defineEmits(['update:visible', 'saved'])
const STATUS_OPTIONS = [
  { label: '进行中', value: 'active' },
  { label: '已暂停', value: 'paused' },
  { label: '已归档', value: 'archived' },
]
const emptyForm = () => ({ name: '', description: '', localPath: '', status: 'active', tags: [], notes: '' })
const form = reactive(emptyForm())
const advanced = ref(false)
const browsing = ref(false)
const nameInput = ref(null)

watch(() => [props.visible, props.project], () => {
  if (!props.visible) return
  Object.keys(form).forEach((key) => delete form[key])
  Object.assign(form, emptyForm(), props.project ? JSON.parse(JSON.stringify(props.project)) : {})
  advanced.value = !!(form.notes || form.tags?.length)
}, { immediate: true })

function close() {
  if (props.saving) return
  emit('update:visible', false)
}

async function browse() {
  browsing.value = true
  try {
    const path = await window.gitReport.pickDirectory()
    if (path) form.localPath = path
  } catch (error) { ElMessage.error(error?.message || '选择目录失败') }
  finally { browsing.value = false }
}

function submit() {
  if (!form.name.trim() || props.saving) return
  emit('saved', JSON.parse(JSON.stringify({ ...form, name: form.name.trim() })))
}
</script>

<style>
.project-editor-dialog { max-width: calc(100vw - 32px); padding: 24px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--brand-text); }
.project-editor-dialog .el-dialog__header { margin: 0; padding: 0 32px 20px 0; }
.project-editor-dialog .el-dialog__title { color: var(--brand-text); font-size: 18px; font-weight: 600; }
.project-editor-dialog .el-dialog__headerbtn { top: 16px; right: 16px; width: 32px; height: 32px; }
.project-editor-dialog .el-dialog__body { max-height: calc(100vh - 220px); padding: 0; overflow-y: auto; color: var(--brand-text); }
.project-editor-dialog .el-form-item { margin-bottom: 20px; }
.project-editor-dialog .el-form-item__label { margin-bottom: 8px; color: var(--brand-text); font-size: 12px; line-height: 20px; }
.project-editor-dialog .el-input__wrapper, .project-editor-dialog .el-select__wrapper { min-height: 32px; }
.project-editor-dialog .path-input-row { display: flex; gap: 8px; width: 100%; }
.project-editor-dialog .path-input-row > .el-input { min-width: 0; }
.project-editor-dialog .project-form .project-state-field { display: flex; align-items: center; }
.project-editor-dialog .project-state-field .el-form-item__label { margin: 0; flex: 1; }
.project-editor-dialog .project-state-field .el-form-item__content { flex: 0 0 180px; }
.project-editor-dialog .project-more-fields { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 4px 0; border: 0; background: transparent; color: var(--brand-text); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.project-editor-dialog .project-more-fields .el-icon { color: var(--text-muted); transition: transform .15s ease; }
.project-editor-dialog .project-more-fields .expanded { transform: rotate(90deg); }
.project-editor-dialog .project-more-fields small { margin-left: auto; color: var(--text-muted); font-size: 11px; }
.project-editor-dialog .project-more-fields:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -2px; border-radius: 4px; }
.project-editor-dialog .project-advanced-fields { padding-top: 12px; }
.project-editor-dialog .project-advanced-fields .el-form-item:last-child { margin-bottom: 8px; }
.project-editor-dialog .el-dialog__footer { padding: 0; }
.project-editor-dialog .project-editor-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; padding-top: 20px; border-top: 1px solid var(--line); }
.project-editor-dialog .project-editor-footer .el-button + .el-button { margin-left: 0; }
@media (max-height: 720px) { .project-editor-dialog .el-form-item { margin-bottom: 16px; } }
</style>
