<template>
  <header class="app-topbar">
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
    <!-- 无边框窗口的标题栏按钮（顶栏其余空白区域可拖拽移动窗口） -->
    <div class="win-controls">
      <button class="win-btn" type="button" title="最小化" @click="winMinimize">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6h10" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button class="win-btn" type="button" :title="maximized ? '还原' : '最大化'" @click="winToggleMaximize">
        <svg v-if="maximized" width="12" height="12" viewBox="0 0 12 12"><path d="M3.5 3.5h-2v7h7v-2M3.5 1.5h7v7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button class="win-btn win-btn-close" type="button" title="关闭" @click="winClose">
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { projectStatusLabel } from '../utils/project-context'

const props = defineProps({
  projects: { type: Array, default: () => [] },
  currentId: { type: String, default: '' },
  // 一键填报等与「当前项目」无关的页面隐藏全局项目切换器（窗口控制与拖拽区保留）
  hideProjectSwitcher: { type: Boolean, default: false },
})
defineEmits(['select-project'])
const currentProject = computed(() => props.projects.find((project) => project.id === props.currentId) || null)

const maximized = ref(false)
let offMaximized = null

function winMinimize() { window.gitReport?.winMinimize?.() }
async function winToggleMaximize() {
  try { await window.gitReport?.winToggleMaximize?.() } catch { /* noop */ }
  // 不采用 IPC 返回值：Windows 下 maximize()/unmaximize() 异步生效，主进程立即读
  // isMaximized() 拿到的是旧状态；图标以 maximize/unmaximize 事件为准（onMounted 已接线）
}
function winClose() { window.gitReport?.winClose?.() }

onMounted(async () => {
  maximized.value = !!(await window.gitReport?.winIsMaximized?.())
  offMaximized = window.gitReport?.onWinMaximized?.((v) => { maximized.value = !!v }) || null
})
onBeforeUnmount(() => { if (offMaximized) offMaximized() })
</script>
