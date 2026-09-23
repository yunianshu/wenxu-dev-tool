/**
 * Node 后台对现有主进程服务的过渡适配层。
 * 桌面窗口、对话框与系统剪贴板由宿主提供；这里仅保留原有服务的 IPC 契约。
 */
const { EventEmitter } = require('node:events')
const { fork } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const handlers = new Map()
let send = () => {}
let clipboardText = ''
let nextHostId = 0
const hostPending = new Map()

function emitHost(action, payload) {
  send({ type: 'host', action, payload })
}

function callHost(action, payload) {
  const id = ++nextHostId
  return new Promise((resolve, reject) => {
    hostPending.set(id, { resolve, reject })
    send({ type: 'host-call', id, action, payload })
  })
}

const app = new EventEmitter()
const paths = {}
let quitting = false
const appData = process.platform === 'win32'
  ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'))
app.isPackaged = process.env.PLM_PACKAGED === '1'
app.commandLine = { appendSwitch() {} }
app.getPath = (name) => paths[name] || ({
  appData,
  documents: path.join(os.homedir(), 'Documents'),
  home: os.homedir(),
})[name] || os.homedir()
app.setPath = (name, value) => {
  paths[name] = value
  if (name === 'userData') fs.mkdirSync(value, { recursive: true })
}
app.getVersion = () => require('../package.json').version
app.requestSingleInstanceLock = () => true // 单实例锁由 Tauri 宿主管理
app.whenReady = () => Promise.resolve()
app.quit = () => {
  if (quitting) return
  quitting = true
  app.emit('before-quit')
  app.emit('will-quit')
  emitHost('quit')
}

class WebContents extends EventEmitter {
  constructor() { super(); this.id = 1 }
  send(channel, payload) { send({ type: 'event', channel, payload }) }
  setBackgroundThrottling() {}
}

const windows = []
class BrowserWindow extends EventEmitter {
  constructor() {
    super()
    this.webContents = new WebContents()
    this.maximized = false
    this.minimized = false
    this.fullscreen = false
    this.destroyed = false
    windows.push(this)
  }
  static getAllWindows() { return windows.filter((window) => !window.destroyed) }
  isDestroyed() { return this.destroyed }
  isMinimized() { return this.minimized }
  isMaximized() { return this.maximized }
  isFullScreen() { return this.fullscreen }
  minimize() { this.minimized = true; emitHost('minimize') }
  restore() { this.minimized = false; emitHost('restore') }
  maximize() { this.maximized = true; this.emit('maximize'); emitHost('maximize') }
  unmaximize() { this.maximized = false; this.emit('unmaximize'); emitHost('unmaximize') }
  setFullScreen(value) {
    this.fullscreen = !!value
    this.emit(value ? 'enter-full-screen' : 'leave-full-screen')
    emitHost('fullscreen', this.fullscreen)
  }
  show() { emitHost('show') }
  hide() { emitHost('hide') }
  focus() { emitHost('focus') }
  close() {
    let prevented = false
    this.emit('close', { preventDefault() { prevented = true } })
    if (!prevented) { this.destroyed = true; emitHost('close'); app.quit() }
  }
  loadURL() { setImmediate(() => this.webContents.emit('did-finish-load')) }
  loadFile() { setImmediate(() => this.webContents.emit('did-finish-load')) }
}

class Tray extends EventEmitter {
  setToolTip(value) { emitHost('tray-tooltip', value) }
  setContextMenu() {}
}

const utilityProcess = {
  fork(entry) {
    const child = fork(entry, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    child.postMessage = (value) => child.send(value)
    return child
  },
}

const electron = {
  app,
  BrowserWindow,
  Tray,
  nativeImage: { createFromPath: () => ({ resize() { return this }, isEmpty() { return false } }) },
  Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
  ipcMain: {
    handle(channel, handler) { handlers.set(channel, handler) },
    async invoke(channel, args) {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`未注册后台命令：${channel}`)
      return handler({ sender: windows[0]?.webContents }, args)
    },
  },
  webContents: {
    fromId: (id) => id === 1 ? windows[0]?.webContents : null,
    getAllWebContents: () => windows.map((window) => window.webContents),
  },
  utilityProcess,
  dialog: {
    showOpenDialog: (_window, options) => callHost('open-dialog', options),
    showSaveDialog: (_window, options) => callHost('save-dialog', options),
  },
  shell: {
    openExternal: (url) => callHost('open-external', url),
    showItemInFolder: (file) => emitHost('show-item-in-folder', file),
  },
  clipboard: {
    writeText(value) { clipboardText = value; emitHost('clipboard-write', value) },
    readText() { return clipboardText },
  },
  net: { fetch: (...args) => fetch(...args) },
  session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
  // 旧 Electron 密文无法在普通 Node 中解密；新凭据由 store 写入系统凭据库。
  safeStorage: { isEncryptionAvailable: () => false },
}

function connect(writer) { send = writer }
function resolveHost(message) {
  const pending = hostPending.get(message.id)
  if (!pending) return
  hostPending.delete(message.id)
  if (message.error) pending.reject(new Error(message.error))
  else pending.resolve(message.result)
}

module.exports = { electron, connect, resolveHost, handlers }
