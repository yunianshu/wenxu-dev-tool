<template>
  <section v-if="tasks.length" class="active-releases" aria-label="发布任务">
    <header class="task-heading">
      <h2>发布任务</h2>
      <span>{{ tasks.length - queuedCount }} 正在发布 · {{ queuedCount }} 排队</span>
    </header>
    <ul class="task-list">
      <li v-for="{ projectId, name, run, progress } in tasks" :key="projectId" class="task-row">
        <div class="task-project">
          <strong>{{ name }}</strong>
          <span v-if="run.targetName">{{ run.targetName }}</span>
        </div>
        <el-tag :type="run.queued ? 'info' : 'primary'" size="small" effect="plain">
          {{ run.queued ? '排队中' : '发布中' }}
        </el-tag>
        <div v-if="run.queued" class="task-progress">等待可用资源</div>
        <div v-else class="task-progress">
          <div class="task-stage">
            <span>{{ progress.activeStage?.label || '准备发布' }}<span v-if="progress.detail"> · {{ progress.detail }}</span></span>
            <span class="task-fraction">{{ progress.doneCount }}/{{ progress.stageTotal }} 阶段</span>
          </div>
          <div
            class="task-track"
            role="progressbar"
            :aria-label="`${name}发布进度`"
            :aria-valuenow="progress.doneCount"
            aria-valuemin="0"
            :aria-valuemax="progress.stageTotal"
            :aria-valuetext="`已结束 ${progress.doneCount} 个阶段，共 ${progress.stageTotal} 个`"
          >
            <div class="task-fill" :style="{ width: progress.percent + '%' }" />
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { state } from '../../store'
import { deployProgress } from './deploy-progress'

const projects = computed(() => new Map(state.deploy.projects.map((project) => [project.id, project])))
const tasks = computed(() => [...state.deploy.runs]
  .filter(([, run]) => run.running && run.type === 'deploy')
  .map(([projectId, run]) => {
    const project = projects.value.get(projectId)
    return { projectId, name: project?.name || projectId, run, progress: deployProgress(run, project?.deployMode) }
  })
  .sort((a, b) => Number(!!a.run.queued) - Number(!!b.run.queued) || a.run.startedAt - b.run.startedAt))
const queuedCount = computed(() => tasks.value.filter(({ run }) => run.queued).length)
</script>

<style scoped>
.active-releases { padding: 16px 0 12px; border-bottom: 1px solid var(--line); }
.task-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; padding-bottom: 10px; }
.task-heading h2 { margin: 0; color: var(--brand-text); font-size: 14px; font-weight: 600; }
.task-heading > span { color: var(--text-muted); font-size: 12px; }
.task-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: 6px; }
.task-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 2fr); align-items: center; gap: 8px 16px; padding: 9px 12px; }
.task-row + .task-row { border-top: 1px solid var(--line); }
.task-project { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; overflow-wrap: anywhere; }
.task-project > strong { font-size: 13px; font-weight: 600; }
.task-project > span, .task-progress { color: var(--text-muted); font-size: 12px; }
.task-stage { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; }
.task-fraction { font-variant-numeric: tabular-nums; }
.task-track { height: 4px; overflow: hidden; margin-top: 5px; border-radius: 4px; background: var(--line-strong); }
.task-fill { height: 100%; border-radius: inherit; background: var(--brand-accent); }
@media (max-width: 600px) {
  .task-row { grid-template-columns: minmax(0, 1fr) auto; }
  .task-progress { grid-column: 1 / -1; }
}
</style>
