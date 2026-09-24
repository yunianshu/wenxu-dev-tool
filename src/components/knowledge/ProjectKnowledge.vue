<template>
  <section class="project-knowledge" aria-label="项目知识记录">
    <header><span>{{ records.length }} 条关联记录</span><el-button text @click="openAll">在 AI 工作台查看<el-icon><TopRight /></el-icon></el-button><el-button :loading="creating" @click="create"><el-icon><Plus /></el-icon>记录项目经验</el-button></header>
    <div v-if="data.error" class="project-knowledge-error">{{ data.error }}<el-button text @click="knowledge.load(true)">重试</el-button></div>
    <el-table v-loading="data.loading" :data="records" empty-text="还没有项目记录。想法、问题、决策与复盘都可以从这里开始。" @row-click="open">
      <el-table-column label="记录" min-width="180" show-overflow-tooltip><template #default="{ row }"><button class="record-link" @click.stop="open(row)">{{ row.title }}</button></template></el-table-column>
      <el-table-column label="类型" width="88"><template #default="{ row }">{{ KNOWLEDGE_TYPES[row.type] }}</template></el-table-column>
      <el-table-column label="状态" width="88"><template #default="{ row }">{{ KNOWLEDGE_STATUSES[row.status] }}</template></el-table-column>
      <el-table-column label="更新" width="136"><template #default="{ row }">{{ knowledgeTime(row.updatedAt) }}</template></el-table-column>
    </el-table>
  </section>
</template>
<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useKnowledge } from '../../composables/useKnowledge'
import { KNOWLEDGE_TYPES, KNOWLEDGE_STATUSES, knowledgeTime } from '../../utils/knowledge'
const props = defineProps({ project: { type: Object, required: true } })
const emit = defineEmits(['navigate'])
const knowledge = useKnowledge()
const { data } = knowledge
const creating = ref(false)
const records = computed(() => data.records.filter(row => row.projectId === props.project.id && !row.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt))
function open(row) { knowledge.openRecord(row, props.project.id); emit('navigate', 'dashboard') }
function openAll() { knowledge.openRecord(null, props.project.id); emit('navigate', 'dashboard') }
async function create() {
  if (creating.value) return
  const project = { id: props.project.id, name: props.project.name }
  creating.value = true
  try { const row = await knowledge.create({ title: '未命名项目记录', projectId: project.id, projectName: project.name }); knowledge.openRecord(row, project.id); emit('navigate', 'dashboard') } catch (error) { ElMessage.error(error.message) } finally { creating.value = false }
}
onMounted(() => knowledge.load())
</script>
<style scoped>
.project-knowledge header { display: flex; align-items: center; gap: 8px; padding: 8px 0 16px; font-size: 13px; color: var(--text-muted); }
.project-knowledge header > span { margin-right: auto; }
.project-knowledge header .el-button { margin: 0; }
.project-knowledge :deep(.el-table__cell) { height: 40px; padding: 4px 0; }
.record-link { color: var(--brand-text); font-size: 13px; background: transparent; border: 0; padding: 0; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.record-link:hover { color: var(--accent-strong); }
.project-knowledge-error { color: var(--danger); font-size: 13px; }
</style>
