<template>
  <div class="page work-overview">
    <Teleport v-if="topbarReady" to="#app-topbar-slot"><div class="topbar-page"><h1 class="topbar-page-title">工作台</h1><span class="topbar-context">从上次停下的地方继续</span></div></Teleport>
    <section class="work-intro"><div><span class="work-eyebrow">个人项目工作空间</span><h2>{{ currentProject ? `继续推进 ${currentProject.name}` : '从你的第一个项目开始' }}</h2><p>把开发、发布与工作记录放在同一个项目里。</p></div><el-button @click="$emit('create-project')"><el-icon><Plus /></el-icon>新建项目</el-button></section>
    <el-alert v-if="error" :title="error" type="warning" :closable="false"><el-button text @click="refresh">重试</el-button></el-alert>
    <section v-if="state.projects.loading" class="work-card" aria-live="polite">正在加载项目…</section>
    <section v-else-if="currentProject" class="work-card">
      <div class="work-heading"><div><span class="work-eyebrow">当前项目</span><h3>{{ currentProject.name }}</h3><p>{{ currentProject.description || '让每次工作都有清晰的上下文。' }}</p></div><el-tag effect="plain">{{ projectStatusLabel(currentProject.status) }}</el-tag></div>
      <ProjectWorkStatus :project="currentProject" :sessions="sessions" :history="history" :loading="loading" :error="error" />
      <div class="work-actions"><el-button type="primary" :disabled="!currentProject.localPath" @click="go('terminal')">继续终端工作</el-button><el-button @click="go('projects')">查看项目</el-button><el-button @click="go('deploy')">查看发布</el-button><el-button @click="go('knowledge')">记录与复盘</el-button></div>
      <p v-if="!currentProject.localPath" class="work-hint">关联本地目录后即可打开终端。<el-button text @click="$emit('edit-project', currentProject)">关联目录</el-button></p>
    </section>
    <section v-else class="work-card"><h3>先建立项目，再按需接入能力</h3><p>只填写名称即可开始；本地目录、Git 和部署可以以后配置。</p><el-button type="primary" @click="$emit('create-project')">创建第一个项目</el-button></section>
    <div class="work-columns">
      <section class="work-card"><div class="work-heading"><h3>项目速览</h3><el-button text @click="$emit('navigate', 'projects')">全部项目</el-button></div><p v-if="!projects.length">项目创建后会出现在这里。</p><button v-for="project in projects" :key="project.id" class="work-row" @click="selectProject(project.id)"><span><strong>{{ project.name }}</strong><small>{{ project.description || projectStatusLabel(project.status) }}</small></span><span>{{ project.id === state.projects.currentId ? '当前项目' : '切换项目 →' }}</span></button></section>
      <section class="work-card"><h3>最近发布</h3><p v-if="loading">正在读取发布记录…</p><p v-else-if="error">发布状态暂不可用，请重试。</p><p v-else-if="!releases.length">完成第一次发布后，这里会保留版本与结果。</p><button v-for="row in releases" :key="row.id" class="work-row" :disabled="!state.projects.items.some(p => p.id === row.projectId)" @click="openRelease(row)"><span><strong>{{ row.projectName || '历史项目' }} · {{ row.version || '未标记版本' }}</strong><small>{{ row.targetName || '默认环境' }} · {{ time(row.startedAt) }}</small></span><span :class="{ 'work-failure': row.status === 'failed' }">{{ labels[row.status] || '未知状态' }} →</span></button></section>
    </div>
  </div>
</template>
<script setup>
import { computed } from 'vue'
import { state } from '../store'
import { useProjects } from '../composables/useProjects'
import { useWorkOverview } from '../composables/useWorkOverview'
import { useTopbarReady } from '../composables/useTopbarReady'
import { projectStatusLabel } from '../utils/project-context'
import ProjectWorkStatus from '../components/ProjectWorkStatus.vue'
const emit = defineEmits(['navigate', 'create-project', 'edit-project'])
const { currentProject, selectProject } = useProjects()
const { sessions, history, loading, error, refresh } = useWorkOverview()
const topbarReady = useTopbarReady()
const projects = computed(() => [...state.projects.items].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 6))
const releases = computed(() => [...history.value].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5))
const labels = { success: '成功', failed: '失败', running: '进行中', rolled_back: '已回滚', canceled: '已取消' }
const time = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '时间未知'
function go(target) { emit('navigate', { target, projectId: currentProject.value.id }) }
function openRelease(row) { emit('navigate', { target: 'deploy', projectId: row.projectId }) }
</script>
<style scoped>
.work-overview { max-width: 1440px; margin: auto; padding: 24px; }
.work-intro, .work-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.work-intro { padding: 12px 0 24px; }.work-intro h2 { font-size: 28px; margin: 8px 0; letter-spacing: -.5px; overflow-wrap: anywhere; }
.work-eyebrow { color: var(--accent-strong); font-size: 12px; font-weight: 600; }
.work-overview p { color: var(--text-muted); margin: 8px 0; }.work-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 24px; margin-bottom: 20px; min-width: 0; }
.work-card h3 { margin: 0; font-size: 18px; }.work-actions { display: flex; flex-wrap: wrap; gap: 10px; }.work-actions .el-button { margin: 0; }.work-hint { font-size: 13px; }
.work-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.work-row { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 0; border: 0; border-bottom: 1px solid var(--line-soft); background: transparent; color: var(--brand-text); text-align: left; cursor: pointer; font: inherit; }.work-row:hover { color: var(--accent-strong); }.work-row:disabled { opacity: .6; cursor: default; }.work-row > span:first-child { min-width: 0; }.work-row > span:last-child { flex-shrink: 0; font-size: 12px; }.work-row strong, .work-row small { display: block; overflow-wrap: anywhere; }.work-row small { color: var(--text-muted); margin-top: 4px; font-size: 12px; }.work-failure { color: var(--danger); }
@media (max-width: 1000px) { .work-columns { grid-template-columns: 1fr; }.work-intro h2 { font-size: 22px; }.work-card { padding: 18px; } }
</style>
