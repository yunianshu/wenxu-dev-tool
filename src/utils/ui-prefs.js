import { state } from '../store'

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
