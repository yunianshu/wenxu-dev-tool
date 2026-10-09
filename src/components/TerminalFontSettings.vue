<template>
  <div class="terminal-font-settings">
    <span id="terminal-font-label" class="terminal-font-label">字体</span>
    <div class="terminal-font-options" role="radiogroup" aria-labelledby="terminal-font-label">
      <button
        v-for="option in FONT_OPTIONS"
        :key="option.value || 'default'"
        type="button"
        role="radio"
        class="terminal-font-option"
        :class="{ 'is-active': option.value === currentFamily }"
        :aria-checked="option.value === currentFamily"
        @click="selectFamily(option.value)"
      >
        <el-icon v-if="option.value === currentFamily" class="terminal-font-check"><Check /></el-icon>{{ option.label }}
      </button>
      <button
        type="button"
        role="radio"
        class="terminal-font-option"
        :class="{ 'is-active': isCustomFamily }"
        :aria-checked="isCustomFamily"
        @click="openCustomInput"
      >
        <el-icon v-if="isCustomFamily" class="terminal-font-check"><Check /></el-icon>{{ isCustomFamily ? currentFamily : '自定义' }}
      </button>
    </div>
    <div v-if="customOpen" class="terminal-font-custom">
      <el-input
        ref="customInput"
        v-model="customDraft"
        class="terminal-font-custom-input"
        size="small"
        maxlength="100"
        placeholder="输入已安装的字体名称"
        aria-label="自定义字体名称"
        @keyup.enter="submitCustom"
      />
      <el-button size="small" type="primary" plain @click="submitCustom">应用</el-button>
      <el-button size="small" link @click="closeCustomInput">取消</el-button>
    </div>
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
import { computed, nextTick, ref } from 'vue'
import { state } from '../store'
import {
  FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT,
  normalizeTerminalFontFamily, terminalFontStack, applyTerminalFontFamily,
  stepTerminalFontSize, resetTerminalFontPreferences, saveUiPrefs,
} from '../utils/ui-prefs'

const FONT_OPTIONS = [
  { value: '', label: '默认等宽字体' },
  ...['Consolas', 'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Sarasa Mono SC', 'Maple Mono', 'Noto Sans Mono CJK SC', 'Menlo', 'Monaco', 'SFMono-Regular']
    .map((name) => ({ value: name, label: name })),
]
const currentFamily = computed(() => normalizeTerminalFontFamily(state.ui.terminalFontFamily))
/** 已保存的字体不在预设列表里时，用「自定义」项承载，避免选中标识丢失。 */
const isCustomFamily = computed(() => !!currentFamily.value && !FONT_OPTIONS.some((option) => option.value === currentFamily.value))
const fontSize = computed(() => state.ui.terminalFontSize)
const isDefault = computed(() => !state.ui.terminalFontFamily && fontSize.value === FONT_SIZE_DEFAULT)
const previewStyle = computed(() => ({ fontFamily: terminalFontStack(state.ui.terminalFontFamily), fontSize: `${fontSize.value}px` }))
const customOpen = ref(false)
const customDraft = ref('')
const customInput = ref(null)
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

function selectFamily(value) {
  closeCustomInput()
  return save(() => applyTerminalFontFamily(value))
}

async function openCustomInput() {
  customOpen.value = true
  customDraft.value = isCustomFamily.value ? currentFamily.value : ''
  inputError.value = ''
  await nextTick()
  customInput.value?.focus()
}

function closeCustomInput() {
  customOpen.value = false
  customDraft.value = ''
  inputError.value = ''
}

function submitCustom() {
  const value = customDraft.value
  if (!value.trim() || normalizeTerminalFontFamily(value) !== value.trim()) {
    inputError.value = '请输入单个字体名称（最多 100 个字符），不能包含引号、逗号或控制字符。'
    return
  }
  customOpen.value = false
  customDraft.value = ''
  return save(() => applyTerminalFontFamily(value))
}
</script>

<style scoped>
.terminal-font-settings { max-width: 760px; }
.terminal-font-label { display: block; margin-bottom: 8px; color: var(--brand-text); font-size: 14px; font-weight: 500; }
.terminal-font-options { display: flex; flex-wrap: wrap; gap: 8px; }
.terminal-font-option {
  display: inline-flex; align-items: center; gap: 6px;
  height: var(--control-h); padding: 0 12px;
  border: 1px solid var(--line); border-radius: var(--radius-md);
  background: var(--surface); color: var(--ink-soft);
  font-family: inherit; font-size: 13px; line-height: 1; cursor: pointer;
}
.terminal-font-option:hover { border-color: var(--line-strong); color: var(--brand-text); }
.terminal-font-option:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.terminal-font-option.is-active { border-color: var(--accent-strong); background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
.terminal-font-check { font-size: 12px; }
.terminal-font-custom { display: flex; align-items: center; gap: 8px; margin-top: 10px; max-width: 360px; }
.terminal-font-hint { margin: 8px 0 16px; color: var(--text-muted); font-size: 13px; line-height: 1.6; }
.terminal-font-size-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.terminal-font-size-row .terminal-font-label { margin: 0; }
.terminal-font-preview { margin: 16px 0 0; padding: 20px; overflow-x: auto; border-radius: 6px; background: #12161d; color: #d7dde8; line-height: 1.8; }
.terminal-font-preview-ok { color: #7dd3a0; }
.terminal-font-error { color: var(--el-color-danger); font-size: 13px; line-height: 1.6; }
</style>
