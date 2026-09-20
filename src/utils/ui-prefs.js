import { state } from '../store'

/** 终端字号范围，与主进程 ui-prefs.js 的 normalize 边界保持一致 */
export const FONT_SIZE_MIN = 11
export const FONT_SIZE_MAX = 22
export const FONT_SIZE_DEFAULT = 13

/**
 * 写入界面偏好。
 *
 * 主进程 ui-prefs.js 是以**整份偏好**为单位 normalize + 落盘的，只传自己关心的字段
 * 会把其余字段重置为默认值（比如调终端字号时把侧栏收起状态抹掉）。
 * 所有写入点统一走这里，从 store 取当前完整状态。
 */
export function saveUiPrefs() {
  return window.gitReport?.uiPrefsSave?.({
    sidebarCollapsed: state.ui.sidebarCollapsed,
    terminalFontSize: state.ui.terminalFontSize,
  })
}

/**
 * 调整终端字号：改 state 并落盘，落盘失败不阻断调整（下次启动回落到上次的值）。
 * 终端工作台工具栏与设置页共用，避免两处各写一份边界判断。
 */
export function stepTerminalFontSize(delta) {
  applyTerminalFontSize(state.ui.terminalFontSize + delta)
}

/** 恢复默认字号 */
export function resetTerminalFontSize() {
  applyTerminalFontSize(FONT_SIZE_DEFAULT)
}

function applyTerminalFontSize(next) {
  const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(next)))
  if (clamped === state.ui.terminalFontSize) return
  state.ui.terminalFontSize = clamped
  saveUiPrefs()?.catch((error) => console.error('终端字号保存失败', error))
}
