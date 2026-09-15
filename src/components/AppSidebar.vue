<template>
  <aside class="app-sidebar">
    <div class="brand-block">
      <div class="brand-mark">项</div>
      <div>
        <div class="brand-name">个人项目管理</div>
        <div class="brand-subtitle">项目工作台</div>
      </div>
    </div>

    <el-menu :default-active="modelValue" class="app-menu" @select="$emit('update:modelValue', $event)">
      <el-menu-item-group title="工作区">
        <el-menu-item index="dashboard"><el-icon><HomeFilled /></el-icon><span>工作台</span></el-menu-item>
        <el-menu-item index="projects"><el-icon><FolderOpened /></el-icon><span>项目</span></el-menu-item>
      </el-menu-item-group>
      <el-menu-item-group title="项目能力">
        <el-menu-item index="chat"><el-icon><ChatDotRound /></el-icon><span>AI 助手</span></el-menu-item>
        <el-menu-item index="harness">
          <el-icon class="nav-ico">
            <Cpu />
            <!-- 有新版本：图标右上角的小圆点（通知角标惯例，不占文字区） -->
            <span v-if="harnessUpdateAvailable" class="nav-badge" title="有新版本" />
          </el-icon>
          <span>DeepSeek Harness</span>
        </el-menu-item>
        <el-menu-item index="report"><el-icon><DataAnalysis /></el-icon><span>活动报告</span></el-menu-item>
        <el-menu-item index="fillreport"><el-icon><Timer /></el-icon><span>一键填报</span></el-menu-item>
        <el-menu-item index="deploy"><el-icon><Promotion /></el-icon><span>部署</span></el-menu-item>
      </el-menu-item-group>
      <el-menu-item-group title="系统">
        <el-menu-item index="extensions"><el-icon><MagicStick /></el-icon><span>扩展管理</span></el-menu-item>
        <el-menu-item index="settings"><el-icon><Setting /></el-icon><span>设置</span></el-menu-item>
      </el-menu-item-group>
    </el-menu>

    <div class="sidebar-footer">
      <span class="status-dot" />
      <span>本地数据</span>
      <button class="sidebar-version" type="button" title="查看版本更新日志" @click="$emit('show-changelog')">v{{ appVersion }} · 更新日志</button>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { state } from '../store'

defineProps({ modelValue: { type: String, required: true } })
defineEmits(['update:modelValue', 'show-changelog'])

/** 由 vite define 从 package.json 注入（见 vite.config.js） */
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''
/** 内置 Harness 有新版本时在菜单项上挂角标（提示常驻，不受一次性通知已读影响） */
const harnessUpdateAvailable = computed(() => state.harnessUpdate?.updateAvailable === true)
</script>
