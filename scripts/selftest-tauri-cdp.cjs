/** 开发期通过 WebView2 CDP 验证正在运行的隔离 Tauri 应用。 */
const port = Number(process.env.PLM_CDP_PORT || 9223)
const expression = process.argv[2] || '({ title: document.title, text: document.body.innerText.slice(0, 1200), bridge: !!window.gitReport })'

async function main() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = pages.find((item) => item.url.startsWith('http://tauri.localhost/'))
  if (!page) throw new Error('未找到 Tauri 主页面')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 响应超时')), 10000)
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression, awaitPromise: true, returnByValue: true,
      } }))
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      clearTimeout(timer)
      if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)))
      else resolve(message.result?.result?.value)
    })
    socket.addEventListener('error', reject)
  }).finally(() => socket.close())
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
