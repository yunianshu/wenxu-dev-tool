<template>
  <div class="terminal-font-settings">
    <label class="terminal-font-label">字体</label>
    <el-select
      class="terminal-font-family"
      :model-value="state.ui.terminalFontFamily"
      :empty-values="[null, undefined]"
      filterable
      allow-create
      default-first-option
      placeholder="选择或输入本机字体名称"
      aria-label="终端字体"
      @change="changeFamily"
    >
      <el-option label="默认等宽字体" value="" />
      <el-option v-for="font in FONT_OPTIONS" :key="font" :label="font" :value="font" />
    </el-select>
    <p class="terminal-font-hint">支持输入已安装的字体名称并回车，建议使用等宽字体。未安装的字体会自动回退。</p>

    <div class="terminal-font-size-row">
      <span class="terminal-font-label">字号</span>
      <div class="font-size-control">
        <el-button :disabled="fontSize <= FONT_SIZE_MIN" title="缩小终端字号" @click="save(() => stepTerminalFontSize(-1))">A－</el-button>
        <span class="font-size-value">{{ fontSize }}</span>
        <el-button :disabled="fontSize >= FONT_SIZE_MAX" title="放大终端字号" @click="save(() => stepTerminalFontSize(1))">A＋</el-button>
        <el-button link type="primary" :disabled="isDefault && !saveError" @click="save(resetTerminalFontPreferences)">恢复默认</el-button>
      </div>
    </div>

    <pre class="terminal-font-preview" :style="previewStyle"><span>~/projects/app $ npm run build</span>
<span class="terminal-font-preview-ok">✓ 构建完成 · Ready 0123456789</span></pre>
    <p class="terminal-font-hint">对全部终端窗格立即生效，自动保存。</p>
    <p v-if="inputError" class="terminal-font-error" role="alert">{{ inputError }}</p>
    <p v-if="saveError" class="terminal-font-error" role="alert">{{ saveError }} <el-button link type="primary" @click="save(saveUiPrefs)">重试保存</el-button></p>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { state } from '../store'
import {
  FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT,
  normalizeTerminalFontFamily, terminalFontStack, applyTerminalFontFamily,
  stepTerminalFontSize, resetTerminalFontPreferences, saveUiPrefs,
} from '../utils/ui-prefs'

const FONT_OPTIONS = ['Consolas', 'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Sarasa Mono SC', 'Maple Mono', 'Noto Sans Mono CJK SC', 'Menlo', 'Monaco', 'SFMono-Regular']
const fontSize = computed(() => state.ui.terminalFontSize)
const isDefault = computed(() => !state.ui.terminalFontFamily && fontSize.value === FONT_SIZE_DEFAULT)
const previewStyle = computed(() => ({ fontFamily: terminalFontStack(state.ui.terminalFontFamily), fontSize: `${fontSize.value}px` }))
const saveError = ref('')
const inputError = ref('')
let saveRequest = 0

async function save(action) {
  const request = ++saveRequest
  saveError.value = ''
  inputError.value = ''
  try {
    const result = await action()
    if (result?.ok === false) throw new Error(result.error || '无法保存界面偏好')
  } catch (error) {
    if (request === saveRequest) saveError.value = `字体已应用，但保存失败：${error.message || error}`
  }
}

function changeFamily(value) {
  if (typeof value !== 'string' || normalizeTerminalFontFamily(value) !== value.trim()) {
    inputError.value = '请输入单个字体名称（最多 100 个字符），不能包含引号、逗号或控制字符。'
    return
  }
  save(() => applyTerminalFontFamily(value))
}
</script>

<style scoped>
.terminal-font-settings { max-width: 600px; }
.terminal-font-label { display: block; margin-bottom: 8px; color: var(--brand-text); font-size: 14px; font-weight: 500; }
.terminal-font-family { width: 100%; }
.terminal-font-hint { margin: 8px 0 16px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }
.terminal-font-size-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.terminal-font-size-row .terminal-font-label { margin: 0; }
.terminal-font-preview { margin: 16px 0 0; padding: 14px 16px; overflow-x: auto; border-radius: 8px; background: #12161d; color: #d7dde8; line-height: 1.6; }
.terminal-font-preview-ok { color: #7dd3a0; }
.terminal-font-error { color: var(--el-color-danger); font-size: 13px; line-height: 1.6; }
</style>
