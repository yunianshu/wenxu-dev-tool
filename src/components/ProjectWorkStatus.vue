<template>
  <section class="work-status" aria-label="项目工作状态">
    <div><span>终端会话</span><strong>{{ loading ? '读取中…' : error ? '状态暂不可用' : live.length ? `${live.length} 个运行中` : '暂无运行会话' }}</strong><small>会话运行状态，不代表服务健康</small></div>
    <div><span>最近发布</span><strong>{{ loading ? '读取中…' : error ? '状态暂不可用' : latest ? `${latest.version || '未标记版本'} · ${labels[latest.status] || '未知状态'}` : '暂无发布记录' }}</strong><small>{{ latest ? `${latest.targetName || '默认环境'} · ${time(latest.startedAt)}` : '发布后自动保留结果与日志' }}</small></div>
    <div><span>知识积累</span><strong>{{ knowledge.data.loading ? '读取中…' : knowledge.data.error ? '记录暂不可用' : `${records.length} 条记录` }}</strong><small>{{ records[0] ? `最近记录：${records[0].title}` : '记录想法、决策与复盘' }}</small></div>
  </section>
</template>
<script setup>
import { computed, onMounted } from 'vue'
import { useKnowledge } from '../composables/useKnowledge'
const props = defineProps({ project: { type: Object, required: true }, sessions: { type: Array, default: () => [] }, history: { type: Array, default: () => [] }, loading: Boolean, error: String })
const knowledge = useKnowledge()
onMounted(() => knowledge.load())
const live = computed(() => props.sessions.filter(row => row.projectId === props.project.id && !row.exited))
const latest = computed(() => props.history.filter(row => row.projectId === props.project.id).sort((a, b) => b.startedAt - a.startedAt)[0])
const records = computed(() => knowledge.data.records.filter(row => row.projectId === props.project.id && !row.deletedAt).sort((a, b) => b.updatedAt - a.updatedAt))
const labels = { success: '成功', failed: '失败', running: '进行中', rolled_back: '已回滚', canceled: '已取消' }
const time = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未知'
</script>
<style scoped>
.work-status { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 20px 0; }
.work-status > div { border: 1px solid var(--line); background: var(--surface-subtle); border-radius: 10px; padding: 18px; min-width: 0; }
.work-status span, .work-status strong, .work-status small { display: block; overflow-wrap: anywhere; }
.work-status span, .work-status small { color: var(--text-muted); font-size: 12px; }
.work-status strong { font-size: 16px; margin: 8px 0; color: var(--brand-text); }
@media (max-width: 1000px) { .work-status { grid-template-columns: 1fr; gap: 8px; } }
</style>
