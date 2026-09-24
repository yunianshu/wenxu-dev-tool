<template>
  <aside class="app-sidebar">
    <div class="brand-block">
      <div class="brand-text" :aria-hidden="collapsed">
        <div class="brand-subtitle">工作空间</div>
      </div>
      <!-- 图标与文字保持同一组节点，动画期间不切换菜单的 DOM 分支。 -->
      <button
        class="sidebar-toggle"
        type="button"
        :title="collapsed ? '展开侧栏' : '收起侧栏'"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        :aria-expanded="!collapsed"
        @click="$emit('toggle-collapse')"
      >
        <el-icon><Expand v-if="collapsed" /><Fold v-else /></el-icon>
      </button>
    </div>

    <!-- 宽度和文字过渡统一由外壳控制；关闭组件自带折叠，避免标题被卸载。 -->
    <el-menu
      :default-active="modelValue"
      :collapse-transition="false"
      class="app-menu"
      @select="$emit('update:modelValue', $event)"
    >
      <el-menu-item-group v-for="group in groups" :key="group.id" :class="{ 'workspace-nav-group': group.id === 'workspace' }">
        <template #title><span class="sidebar-group-label" :aria-hidden="collapsed">{{ group.label }}</span></template>
        <el-tooltip v-for="item in group.items" :key="item.id" :content="item.label" :disabled="!collapsed" :trigger="['hover', 'focus']" :trigger-keys="[]" placement="right" :show-after="240" :hide-after="0">
          <el-menu-item :index="item.id" :aria-label="item.label" :tabindex="modelValue === item.id ? 0 : -1" @keydown="onItemKeydown">
            <el-icon class="nav-ico">
              <component :is="item.icon" />
              <span v-if="item.id === 'harness' && harnessUpdateAvailable" class="nav-badge" title="有新版本" />
            </el-icon>
            <span class="sidebar-item-label" :aria-hidden="collapsed">{{ item.label }}</span>
          </el-menu-item>
        </el-tooltip>
      </el-menu-item-group>
    </el-menu>

    <!-- 收起后「本地数据」与「· 更新日志」都放不下：只留状态点与版本号，文案由 title 补 -->
    <div class="sidebar-footer">
      <span class="status-dot" />
      <span class="footer-label" :aria-hidden="collapsed">本地数据</span>
      <button class="sidebar-version" type="button" title="查看版本更新日志" @click="$emit('show-changelog')">
        <span class="version-num">v{{ appVersion }}</span><span class="version-label"> · 更新日志</span>
      </button>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { state } from '../store'

defineProps({
  modelValue: { type: String, required: true },
  /** 收起：侧栏只留图标（宽度由外层 .app-shell 的 is-sidebar-collapsed 决定） */
  collapsed: { type: Boolean, default: false },
})
defineEmits(['update:modelValue', 'show-changelog', 'toggle-collapse'])

/** 由 vite define 从 package.json 注入（见 vite.config.js） */
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
/** 内置 Harness 有新版本时在菜单项上挂角标（提示常驻，不受一次性通知已读影响） */
const harnessUpdateAvailable = computed(() => state.harnessUpdate?.updateAvailable === true)
const groups = [
  { id: 'workspace', label: '', items: [
    { id: 'dashboard', label: 'AI 工作台', icon: 'House' },
    { id: 'projects', label: '项目', icon: 'FolderOpened' },
  ] },
  { id: 'capabilities', label: '项目能力', items: [
    { id: 'harness', label: 'DeepSeek Harness', icon: 'Cpu' },
    { id: 'terminal', label: '终端工作台', icon: 'Monitor' },
    { id: 'fillreport', label: '一键填报', icon: 'Timer' },
    { id: 'deploy', label: '部署', icon: 'Promotion' },
  ] },
  { id: 'system', label: '系统', items: [
    { id: 'extensions', label: '扩展管理', icon: 'MagicStick' },
    { id: 'settings', label: '设置', icon: 'Setting' },
  ] },
]

function onItemKeydown(event) {
  if (!['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const item = event.currentTarget
  if (event.key === 'Enter' || event.key === ' ') { item.click(); return }
  const items = [...item.closest('.app-menu').querySelectorAll('[role="menuitem"]')]
  const index = items.indexOf(item)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
  items[next]?.focus()
}
</script>
