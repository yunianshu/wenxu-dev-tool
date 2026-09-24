import { state } from '../store'

/** 终端字号范围，与主进程 ui-prefs.js 的 normalize 边界保持一致 */
export const FONT_SIZE_MIN = 11
export const FONT_SIZE_MAX = 22
export const FONT_SIZE_DEFAULT = 13
export const FONT_FAMILY_DEFAULT = ''
const DEFAULT_FONT_STACK = 'Consolas, "Cascadia Mono", "Sarasa Mono SC", Menlo, monospace'
let terminalFontRevision = 0
let themeRevision = 0
const THEME_CACHE_KEY = 'personnel-plm-theme'

export function normalizeTheme(value) { return value === 'dark' ? 'dark' : 'light' }
export function getThemeRevision() { return themeRevision }

function renderTheme(value) {
  const theme = normalizeTheme(value)
  state.ui.theme = theme
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }
  try { window.localStorage?.setItem(THEME_CACHE_KEY, theme) } catch { /* 缓存不可用时仍由后台持久化 */ }
}

/** 首帧使用上次主题快照；后台读取完成后以正式偏好为准。 */
export function initializeTheme() {
  let cached = 'light'
  try { cached = window.localStorage?.getItem(THEME_CACHE_KEY) } catch { /* 使用默认浅色 */ }
  renderTheme(cached)
}

export function restoreThemePrefs(saved, revision) {
  if (revision === themeRevision) renderTheme(saved?.theme)
}

export async function applyTheme(value) {
  themeRevision += 1
  renderTheme(value)
  const result = await saveUiPrefs()
  if (result?.ok === false) throw new Error(result.error || '无法保存主题偏好')
  return result
}

/** 保存单个本机字体名称，校验规则与主进程一致。 */
export function normalizeTerminalFontFamily(raw) {
  if (typeof raw !== 'string' || /["',;{}\\\x00-\x1f\x7f-\x9f]/.test(raw)) return FONT_FAMILY_DEFAULT
  const name = raw.trim()
  return name.length <= 100 ? name : FONT_FAMILY_DEFAULT
}

/** 自定义字体不可用时，继续使用原有的系统等宽字体回退。 */
export function terminalFontStack(raw) {
  const name = normalizeTerminalFontFamily(raw)
  if (!name) return DEFAULT_FONT_STACK
  return `${name === 'monospace' || name === 'ui-monospace' ? name : `"${name}"`}, ${DEFAULT_FONT_STACK}`
}

export function getTerminalFontRevision() { return terminalFontRevision }

/** 初始化读取晚于用户编辑时，不再恢复旧字体。 */
export function restoreTerminalFontPrefs(saved, revision) {
  if (revision !== terminalFontRevision) return
  state.ui.terminalFontFamily = normalizeTerminalFontFamily(saved?.terminalFontFamily)
  const size = Number(saved?.terminalFontSize)
  state.ui.terminalFontSize = Number.isFinite(size)
    ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size))) : FONT_SIZE_DEFAULT
}

/**
 * 写入界面偏好。
 *
 * 主进程 ui-prefs.js 是以**整份偏好**为单位 normalize + 落盘的，只传自己关心的字段
 * 会把其余字段重置为默认值（比如调终端字号时把侧栏收起状态抹掉）。
 * 所有写入点统一走这里，从 store 取当前完整状态。
 */
export function saveUiPrefs() {
  return window.gitReport?.uiPrefsSave?.({
    theme: normalizeTheme(state.ui.theme),
    sidebarCollapsed: state.ui.sidebarCollapsed,
    terminalFontSize: state.ui.terminalFontSize,
    terminalFontFamily: state.ui.terminalFontFamily,
  })
}

/**
 * 调整终端字号：立即更新外观并落盘，设置组件负责显示保存失败。
 * 工作台和设置页共用，避免两处各写一份边界判断。
 */
export function stepTerminalFontSize(delta) {
  return applyTerminalFontSize(state.ui.terminalFontSize + delta)
}

/** 恢复默认字号 */
export function resetTerminalFontSize() {
  return applyTerminalFontSize(FONT_SIZE_DEFAULT)
}

function applyTerminalFontSize(next) {
  const size = Number(next)
  const clamped = Number.isFinite(size) ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size))) : FONT_SIZE_DEFAULT
  terminalFontRevision += 1
  state.ui.terminalFontSize = clamped
  return persistTerminalFonts()
}

export function applyTerminalFontFamily(value) {
  terminalFontRevision += 1
  state.ui.terminalFontFamily = normalizeTerminalFontFamily(value)
  return persistTerminalFonts()
}

export function resetTerminalFontPreferences() {
  terminalFontRevision += 1
  state.ui.terminalFontFamily = FONT_FAMILY_DEFAULT
  state.ui.terminalFontSize = FONT_SIZE_DEFAULT
  return persistTerminalFonts()
}

async function persistTerminalFonts() {
  const result = await saveUiPrefs()
  if (result?.ok === false) throw new Error(result.error || '无法保存界面偏好')
  return result
}
