<template>
  <header class="app-titlebar" data-tauri-drag-region>
    <div class="titlebar-brand" data-tauri-drag-region>
      <strong>Personnel PLM</strong><span class="titlebar-divider">/</span><span>项目工作台</span>
    </div>
    <div class="win-controls">
      <button class="win-btn" type="button" title="最小化" aria-label="最小化" @click="winMinimize">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" stroke-width="1.2" /></svg>
      </button>
      <button class="win-btn" type="button" :title="maximized ? '还原' : '最大化'" :aria-label="maximized ? '还原' : '最大化'" @click="winToggleMaximize">
        <svg v-if="maximized" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5h-2v7h7v-2M3.5 1.5h7v7" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
      </button>
      <button class="win-btn win-btn-close" type="button" title="关闭" aria-label="关闭" @click="winClose">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.2" /></svg>
      </button>
    </div>
  </header>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const maximized = ref(false)
let offMaximized = null
function winMinimize() { window.gitReport?.winMinimize?.() }
async function winToggleMaximize() {
  try { await window.gitReport?.winToggleMaximize?.() } catch { /* 状态以窗口事件为准 */ }
}
function winClose() { window.gitReport?.winClose?.() }
onMounted(async () => {
  maximized.value = !!(await window.gitReport?.winIsMaximized?.())
  offMaximized = window.gitReport?.onWinMaximized?.((value) => { maximized.value = !!value }) || null
})
onBeforeUnmount(() => { offMaximized?.() })
</script>
