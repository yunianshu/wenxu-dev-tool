<template>
  <el-drawer :model-value="visible" :title="form.id ? '编辑项目' : '新建项目'" size="480px" @close="close">
    <el-form label-position="top" class="project-form" @submit.prevent="submit">
      <el-form-item label="项目名称" required>
        <el-input v-model="form.name" maxlength="60" show-word-limit placeholder="例如：个人网站重构" autofocus />
      </el-form-item>
      <el-form-item label="项目说明">
        <el-input v-model="form.description" type="textarea" :rows="3" maxlength="240" show-word-limit placeholder="这个项目要解决什么问题？" />
      </el-form-item>
      <el-form-item label="本地目录（可选）">
        <div class="path-input-row">
          <el-input v-model="form.localPath" placeholder="无需是 Git 仓库" />
          <el-button @click="browse"><el-icon><Folder /></el-icon>选择</el-button>
        </div>
              </el-form-item>
      <el-form-item label="状态">
        <el-segmented v-model="form.status" :options="STATUS_OPTIONS" />
      </el-form-item>
      <el-form-item label="标签">
        <el-select v-model="form.tags" multiple filterable allow-create default-first-option placeholder="输入后回车添加" style="width: 100%" />
      </el-form-item>
      <el-form-item label="项目备注">
        <el-input v-model="form.notes" type="textarea" :rows="7" maxlength="4000" show-word-limit placeholder="记录目标、约束、风险或下一步。AI 可按需读取这些内容。" />
      </el-form-item>
    </el-form>
    <template #footer>
      <div class="drawer-footer">
        <el-button @click="close">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!form.name.trim()" @click="submit">保存项目</el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup>
import { reactive, watch } from 'vue'

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

watch(() => [props.visible, props.project], () => {
  if (!props.visible) return
  Object.keys(form).forEach((key) => delete form[key])
  Object.assign(form, emptyForm(), props.project ? JSON.parse(JSON.stringify(props.project)) : {})
}, { immediate: true })

function close() {
  emit('update:visible', false)
}

async function browse() {
  const path = await window.gitReport.pickDirectory()
  if (path) form.localPath = path
}

function submit() {
  if (!form.name.trim() || props.saving) return
  emit('saved', JSON.parse(JSON.stringify({ ...form, name: form.name.trim() })))
}
</script>
