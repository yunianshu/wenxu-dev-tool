<template>
  <!-- 顶栏里的「页头项目选择」：页面标题旁边直接挂着项目名，点开即项目列表。
       取代原先独立占位的「当前项目」块——需要的页面（工作台 / 部署）不用为此
       多出一整块控件，不需要的页面也不再显示它。 -->
  <el-select
    :model-value="currentId"
    placeholder="选择项目"
    class="topbar-project-select"
    size="small"
    @update:model-value="onPick"
  >
    <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id">
      <span>{{ project.name }}</span>
      <span v-if="showDeployStatus && deployRunFor(project.id).running" class="project-deploy-status">
        {{ deployRunFor(project.id).queued ? '排队中' : '执行中' }}
      </span>
    </el-option>
    <el-option v-if="!projects.length" value="" label="还没有项目" disabled />
  </el-select>
</template>

<script setup>
import { computed } from 'vue'
import { state, deployRunFor } from '../store'
import { useProjects } from '../composables/useProjects'

const emit = defineEmits(['change'])
defineProps({ showDeployStatus: Boolean })
const { selectProject } = useProjects()

const projects = computed(() => state.projects.items)
const currentId = computed(() => state.projects.currentId)

/** 选择后写回共享状态（项目页、活动报告等页面都跟随同一份 currentId） */
function onPick(projectId) {
  selectProject(String(projectId || ''))
  emit('change', projectId)
}
</script>

<style scoped>
.project-deploy-status { margin-left: 12px; font-size: 12px; color: var(--text-muted); }
</style>
