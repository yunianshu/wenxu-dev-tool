// 一次性补丁：App.vue 启动时预建隐藏的北森内嵌窗口（企微捕获登录的注入目标）。
const fs = require('node:fs')
const file = 'src/App.vue'
let text = fs.readFileSync(file, 'utf8')
if (!text.includes('italent-url')) {
  text = text.replace("import { shortPath } from './utils/path'", "import { shortPath } from './utils/path'\nimport { ITALENT_URL, ITALENT_LABEL } from './italent-url'")
}
if (!text.includes('预建隐藏的北森窗口')) {
  const anchor = 'state.ui.shellMounted = true'
  const first = text.indexOf(anchor)
  if (first < 0) throw new Error('shellMounted anchor not found')
  const inject = anchor + `\n  // 预建隐藏的北森窗口：后台企微捕获登录的种子可直接注入，用户无感知。
  if (typeof window.__TAURI_INTERNALS__ !== 'undefined') {
    import('@tauri-apps/api/webviewWindow').then(async ({ WebviewWindow, getAllWebviewWindows }) => {
      try {
        if (!(await getAllWebviewWindows()).some((item) => item.label === ITALENT_LABEL)) {
          const view = new WebviewWindow(ITALENT_LABEL, { url: ITALENT_URL, title: '北森 · 一键请假', width: 1180, height: 800, center: true, visible: false })
          view.once('tauri://error', () => { /* 预建失败由「连接北森」兜底重建 */ })
        }
      } catch { /* 预建失败不影响主流程 */ }
    }).catch(() => {})
  }`
  text = text.slice(0, first) + inject + text.slice(first + anchor.length)
}
fs.writeFileSync(file, text)
console.log('patched imports:', text.includes('italent-url'), 'hidden window:', text.includes('预建隐藏的北森窗口'))
