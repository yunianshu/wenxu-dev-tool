/**
 * 应用自身阻塞浮层（ElDialog / ElMessageBox / ElDrawer）的开关状态。
 *
 * 为什么需要：Tauri 版内嵌 Harness 是**原生子 Webview**，永远盖在主页面之上——
 * 主页面里的浮层连同遮罩被它整块遮住，屏幕上只剩外壳变暗、对话框完全看不见
 * （更新确认框、服务设置、关闭询问都会命中）。Harness 视图据此在浮层打开期间
 * 把原生子视图藏起来，浮层关掉再显示。
 *
 * 判定看 DOM：Element Plus 的浮层都渲染成 .el-overlay，关闭后节点仍留在文档里
 * （display:none），因此不能只看节点是否存在。浮层开关只改属性，所以 childList
 * 与 class/style 属性一起监听；一帧内的多次变更合并成一次查询。
 */
const OVERLAY_SELECTOR = '.el-overlay'

export function watchBlockingOverlay(onChange) {
  let frame = 0
  let last = null
  const isOpen = () => [...document.querySelectorAll(OVERLAY_SELECTOR)]
    .some((el) => getComputedStyle(el).display !== 'none')
  const evaluate = () => {
    frame = 0
    const open = isOpen()
    if (open === last) return
    last = open
    onChange(open)
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(evaluate) }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'],
  })
  evaluate()
  return () => {
    observer.disconnect()
    if (frame) cancelAnimationFrame(frame)
  }
}
