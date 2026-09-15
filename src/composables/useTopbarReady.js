import { computed } from 'vue'
import { state } from '../store'

/**
 * 顶栏插槽（#app-topbar-slot）当前是否可用于投递页头。
 *
 * 两个条件缺一不可：
 * - `shellMounted`：应用外壳已挂载进文档。初始视图是在 App 挂载过程中渲染的，
 *   那时根元素还没插入 document，`document.querySelector('#app-topbar-slot')`
 *   找不到目标，Teleport 会失败并把内容丢掉（还会连带 Vue 卸载钩子报错）。
 *   所以初始视图要等外壳挂载完成后再投递（此时仍是同一个事件循环，
 *   浏览器还没绘制，用户看不到中间态）。
 * - `!fullscreen`：沉浸全屏时整个顶栏被卸载，目标不存在。
 *
 * 切页时挂载的视图两项都已满足，直接投递，不会有中间态。
 */
export function useTopbarReady() {
  return computed(() => state.ui.shellMounted && !state.ui.fullscreen)
}
