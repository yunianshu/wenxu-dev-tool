<template>
  <aside class="app-sidebar">
    <div class="brand-block">
      <div class="brand-text">
        <div class="brand-subtitle">工作空间</div>
      </div>
      <!-- 收起/展开侧栏：收起后只留图标，菜单项文案由 el-menu 自带的 tooltip 补上 -->
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

    <!-- label 放在 #title 插槽里：el-menu 收起时该插槽转为 tooltip 内容，
         图标旁不再渲染文字（在 default 插槽里写死 span 则收不起文字） -->
    <el-menu
      :default-active="modelValue"
      :collapse="collapsed"
      class="app-menu"
      @select="$emit('update:modelValue', $event)"
    >
      <el-menu-item-group class="workspace-nav-group">
        <el-menu-item index="dashboard">
          <el-icon><House /></el-icon>
          <template #title><span>AI 工作台</span></template>
        </el-menu-item>
        <el-menu-item index="projects">
          <el-icon><FolderOpened /></el-icon>
          <template #title><span>项目</span></template>
        </el-menu-item>
      </el-menu-item-group>
      <el-menu-item-group title="项目能力">
        <el-menu-item index="harness">
          <el-icon class="nav-ico">
            <Cpu />
            <!-- 有新版本：图标右上角的小圆点（通知角标惯例，不占文字区） -->
            <span v-if="harnessUpdateAvailable" class="nav-badge" title="有新版本" />
          </el-icon>
          <template #title><span>DeepSeek Harness</span></template>
        </el-menu-item>
        <el-menu-item index="terminal">
          <el-icon><Monitor /></el-icon>
          <template #title><span>终端工作台</span></template>
        </el-menu-item>
        <el-menu-item index="fillreport">
          <el-icon><Timer /></el-icon>
          <template #title><span>一键填报</span></template>
        </el-menu-item>
        <el-menu-item index="deploy">
          <el-icon><Promotion /></el-icon>
          <template #title><span>部署</span></template>
        </el-menu-item>
      </el-menu-item-group>
      <el-menu-item-group title="系统">
        <el-menu-item index="extensions">
          <el-icon><MagicStick /></el-icon>
          <template #title><span>扩展管理</span></template>
        </el-menu-item>
        <el-menu-item index="settings">
          <el-icon><Setting /></el-icon>
          <template #title><span>设置</span></template>
        </el-menu-item>
      </el-menu-item-group>
    </el-menu>

    <!-- 收起后「本地数据」与「· 更新日志」都放不下：只留状态点与版本号，文案由 title 补 -->
    <div class="sidebar-footer">
      <span class="status-dot" />
      <span class="footer-label">本地数据</span>
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
</script>
