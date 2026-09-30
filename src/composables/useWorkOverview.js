import { ref, onMounted, onUnmounted } from 'vue'

/** 只读取后台事实；终端会话不等同于业务服务健康。 */
export function useWorkOverview() {
  const sessions = ref([])
  const history = ref([])
  const error = ref('')
  const loading = ref(true)
  let disposed = false
  let timer
  let refreshing = false
  async function refresh() {
    if (refreshing) return
    refreshing = true
    const results = await Promise.allSettled([
      Promise.resolve().then(() => window.gitReport.terminalList()),
      Promise.resolve().then(() => window.gitReport.deployHistoryList()),
    ])
    if (!disposed) {
      const messages = []
      results.forEach((result, index) => {
        const target = index === 0 ? sessions : history
        if (result.status === 'fulfilled' && Array.isArray(result.value)) target.value = result.value
        else { target.value = []; messages.push(index === 0 ? '终端状态读取失败' : '发布历史读取失败') }
      })
      error.value = messages.join('；')
      loading.value = false
    }
    refreshing = false
  }
  onMounted(() => { refresh(); timer = setInterval(refresh, 5000) })
  onUnmounted(() => { disposed = true; clearInterval(timer) })
  return { sessions, history, error, loading, refresh }
}
