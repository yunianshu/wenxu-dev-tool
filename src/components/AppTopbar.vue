<template>
  <header class="app-topbar" :class="{ 'app-topbar--terminal': terminal }">
    <div v-if="!hideProjectSwitcher" class="project-switcher">
      <span class="topbar-label">当前项目</span>
      <el-select
        :model-value="currentId"
        placeholder="全部项目"
        class="project-select"
        @update:model-value="$emit('select-project', $event)"
      >
        <el-option label="全部项目" value="" />
        <el-option
          v-for="project in projects"
          :key="project.id"
          :label="project.name"
          :value="project.id"
        />
      </el-select>
      <el-tag v-if="currentProject" effect="plain" size="small" :type="currentProject.status === 'archived' ? 'info' : 'success'">
        {{ projectStatusLabel(currentProject.status) }}
      </el-tag>
    </div>
    <!-- 工具页（终端工作台 / Harness）把自己的标题栏 Teleport 到这里：
         这两页与「当前项目」无关，顶栏原本闲置，正好改成它们的标题栏 -->
    <div id="app-topbar-slot" class="topbar-slot" />
  </header>
</template>

<script setup>
import { computed } from 'vue'
import { projectStatusLabel } from '../utils/project-context'

const props = defineProps({
  projects: { type: Array, default: () => [] },
  currentId: { type: String, default: '' },
  // 一键填报等与「当前项目」无关的页面隐藏全局项目切换器（窗口控制与拖拽区保留）
  hideProjectSwitcher: { type: Boolean, default: false },
  terminal: { type: Boolean, default: false },
})
defineEmits(['select-project'])
const currentProject = computed(() => props.projects.find((project) => project.id === props.currentId) || null)

</script>
