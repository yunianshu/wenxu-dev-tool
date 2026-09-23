/** 将 Electron preload 的公开 API 契约复用于 Tauri 页面，避免手工维护两份方法清单。 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8')
const binding = "const { contextBridge, ipcRenderer } = require('electron')"
const exposure = "contextBridge.exposeInMainWorld('gitReport', {"
if (!source.includes(binding) || !source.includes(exposure) || !source.trimEnd().endsWith('})')) {
  throw new Error('preload 结构已变化，请同步更新 Tauri API 生成器')
}

const adapter = `import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener'

const subscriptions = new Map()
const ipcRenderer = {
  invoke: async (channel, args) => {
    if (channel === 'clipboard:write') { await writeText(String(args || '')); return true }
    if (channel === 'clipboard:read') return readText()
    return invoke('backend_call', { channel, args: args === undefined ? null : args })
  },
  on(channel, listener) {
    const record = { active: true, dispose: null }
    subscriptions.set(listener, record)
    listen('backend-event', (event) => {
      if (record.active && event.payload?.channel === channel) listener(null, event.payload.payload)
    }).then((dispose) => {
      if (record.active) record.dispose = dispose
      else dispose()
    })
  },
  removeListener(_channel, listener) {
    const record = subscriptions.get(listener)
    if (!record) return
    record.active = false
    record.dispose?.()
    subscriptions.delete(listener)
  },
}
const contextBridge = { exposeInMainWorld: (name, value) => { window[name] = value } }

listen('backend-host-call', async ({ payload }) => {
  const { id, action, payload: options } = payload
  let result = null
  let error = null
  try {
    if (action === 'open-dialog') {
      const file = await open({ directory: options?.properties?.includes('openDirectory') || false, multiple: false })
      result = { canceled: !file, filePaths: file ? [file] : [] }
    } else if (action === 'save-dialog') {
      const filePath = await save({ title: options?.title, defaultPath: options?.defaultPath, filters: options?.filters })
      result = { canceled: !filePath, filePath: filePath || '' }
    } else if (action === 'open-external') {
      await openUrl(options)
    } else {
      throw new Error('未知桌面操作：' + action)
    }
  } catch (cause) {
    error = cause?.message || String(cause)
  }
  await invoke('backend_host_response', { id, result, error })
})
listen('backend-host-event', ({ payload }) => {
  if (payload.action === 'show-item-in-folder') revealItemInDir(payload.payload).catch(console.error)
})
`

const generated = '// 由 scripts/generate-tauri-bridge.cjs 从 electron/preload.js 生成，请勿手改。\n'
  + source.replace(binding, adapter)
fs.writeFileSync(path.join(root, 'src', 'tauri-bridge.generated.js'), generated, 'utf8')
