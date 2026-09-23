/** Tauri 管理的 Node 后台：逐行 JSON 请求与事件通道。 */
const Module = require('node:module')
const readline = require('node:readline')
const compat = require('./electron-compat.cjs')
process.env.PLM_NODE_BACKEND = '1'
if (process.env.PLM_RESOURCES_DIR) process.resourcesPath = process.env.PLM_RESOURCES_DIR

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
compat.connect(write)

// 后台 stdout 专用于机器协议，业务诊断写入 stderr。
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...values) => process.stderr.write(`${values.map(String).join(' ')}\n`)
}

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return compat.electron
  return originalLoad.call(this, request, parent, isMain)
}

require('../electron/main.js')

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', async (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'host-response') { compat.resolveHost(message); return }
  if (message.type === 'shutdown') { compat.electron.app.quit(); process.exit(0) }
  if (message.type !== 'request') return
  try {
    const result = await compat.electron.ipcMain.invoke(message.channel, message.args)
    write({ type: 'response', id: message.id, result })
  } catch (error) {
    write({ type: 'response', id: message.id, error: error?.message || String(error) })
  }
})
input.on('close', () => { compat.electron.app.quit(); process.exit(0) })
setImmediate(() => write({ type: 'ready', channels: [...compat.handlers.keys()] }))
