<template>
  <div class="empty-state">
    <div class="empty-state-icon"><el-icon><component :is="icon" /></el-icon></div>
    <h2>{{ title }}</h2>
    <el-button v-if="action" type="primary" @click="$emit('action')">{{ action }}</el-button>
  </div>
</template>

<script setup>
defineProps({
  icon: { type: String, default: 'FolderOpened' },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  action: { type: String, default: '' },
})
defineEmits(['action'])
</script>
