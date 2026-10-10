/**
 * 终端颜色 E2E：真实 Electron、ConPTY、PowerShell、IPC 和 xterm 渲染。
 * 预置 NO_COLOR=1，验证内嵌终端仍有 Write-Host 颜色、输入语法颜色和切页回放颜色。
 * 用户数据及项目全在临时目录；仅在测试 bootstrap 中隐藏窗口，不改业务链路。
 * 前置：npm run build:renderer；运行：node scripts/terminal-color-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const STARTED_AT = Date.now()
const ROOT = path.resolve(__dirname, '..')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-terminal-color-'))
const USER_DATA = path.join(SANDBOX, 'appdata')
const PROJECT = {
  id: 'terminal-color-e2e', name: '终端颜色隔离项目', description: '',
  localPath: path.join(SANDBOX, 'project'), status: 'active', tags: [],
}
const RED = 'COLOR_E2E_RED'
const GREEN = 'COLOR_E2E_GREEN'
const INPUT = 'Write-Host "SYNTAX_COLOR_E2E"'
let failed = 0

function check(name, condition, detail = '') {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `：${detail}` : ''}`)
  if (!condition) failed += 1
}

function prepare() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(PROJECT.localPath)
  fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: [PROJECT] }))
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ closeAction: 'quit' }))
  fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
    version: 1, gridMode: 'auto', columnWidths: [1], rowHeights: [1],
    panes: [{ paneId: 'terminal-color-e2e-pane', projectId: PROJECT.id, shellId: 'pwsh', title: '' }],
    savedAt: Date.now(),
  }))
  const bootstrap = path.join(SANDBOX, 'bootstrap.cjs')
  fs.writeFileSync(bootstrap, `
const electron = require('electron')
const NativeWindow = electron.BrowserWindow
const Module = require('module')
let createdWindows = 0
let visibleWindows = 0
class HiddenWindow extends NativeWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false } })
    createdWindows += 1
    this.on('show', () => { visibleWindows += 1 })
    this.show = () => {}
    this.showInactive = () => {}
    this.focus = () => {}
  }
}
// Electron 的导出是不可重新定义的 getter；用独立 shim 覆盖窗口类，保留其余 API。
const hiddenElectron = Object.create(electron)
Object.defineProperty(hiddenElectron, 'BrowserWindow', { value: HiddenWindow })
const originalLoad = Module._load
Module._load = function (request, ...args) {
  return request === 'electron' ? hiddenElectron : originalLoad.call(this, request, ...args)
}
electron.app.on('before-quit', () => {
  console.log('[COLOR_E2E][hidden]', JSON.stringify({ windows: createdWindows, visible: visibleWindows, parentNoColor: process.env.NO_COLOR }))
})
try { require(${JSON.stringify(path.join(ROOT, 'electron', 'main.js'))}) }
catch (error) { console.error(error.stack || error); electron.app.exit(1) }
`)
  return bootstrap
}

const PROBE = `(async () => {
  const result = {}
  const errors = []
  window.addEventListener('error', (e) => errors.push(String(e.message || e)))
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)))
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (read, label) => {
    const start = Date.now()
    while (Date.now() - start < 15000) {
      const value = await read()
      if (value) return value
      await sleep(100)
    }
    throw new Error('等待超时：' + label)
  }
  const visible = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0
  const navigate = async (text) => {
    const menu = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => visible(el) && el.textContent.trim() === text)
    if (!menu) throw new Error('未找到导航：' + text)
    menu.click()
    await sleep(200)
  }
  // 只记录受控标记的样式，不收集用户 profile 或提示符内容。
  const colorsFor = (needle, exact = false) => {
    const rows = [...document.querySelectorAll('.term-pane .xterm-rows > *')]
    const row = rows.filter((el) => exact ? el.textContent.trim() === needle : el.textContent.includes(needle)).at(-1)
    if (!row) return null
    const start = row.textContent.indexOf(needle)
    const end = start + needle.length
    let offset = 0
    const colors = []
    for (const span of row.querySelectorAll('span')) {
      const length = span.textContent.length
      if (offset < end && offset + length > start) colors.push(getComputedStyle(span).color)
      offset += length
    }
    return [...new Set(colors)]
  }
  const snapshot = () => ({ red: colorsFor(${JSON.stringify(RED)}, true), green: colorsFor(${JSON.stringify(GREEN)}, true) })
  let offData = null
  try {
    result.before = await waitFor(async () => {
      const sessions = (await window.gitReport.terminalList()).sessions || []
      return sessions.find((s) => s.paneId === 'terminal-color-e2e-pane' && !s.exited && s.pid > 0)
    }, 'PowerShell 会话创建')
    const sid = result.before.id
    await waitFor(() => !!document.querySelector('.term-pane .xterm-rows'), 'xterm 渲染')
    await sleep(1500)
    let output = ''
    offData = window.gitReport.onTerminalData((payload) => { if (payload?.sessionId === sid) output += payload.data || '' })
    await window.gitReport.terminalWrite(sid, ${JSON.stringify(`Write-Host '${RED}' -ForegroundColor Red; Write-Host '${GREEN}' -ForegroundColor Green\r`)})
    result.output = await waitFor(() => { const value = snapshot(); return value.red && value.green ? value : null }, '红绿输出')
    result.hasSgr = /\\x1b\\[[0-9;]*m/.test(output)
    offData(); offData = null
    await sleep(300)
    await window.gitReport.terminalWrite(sid, ${JSON.stringify(INPUT)})
    await waitFor(() => colorsFor(${JSON.stringify(INPUT)}), '输入回显')
    await sleep(300)
    result.input = {
      command: colorsFor('Write-Host'),
      string: colorsFor('SYNTAX_COLOR_E2E'),
    }
    await window.gitReport.terminalWrite(sid, '\\x03')
    await sleep(300)
    await navigate('设置')
    await waitFor(() => !document.querySelector('.terminal-grid .term-pane'), '终端视图卸载')
    result.background = (await window.gitReport.terminalList()).sessions.find((s) => s.id === sid)
    await navigate('终端工作台')
    result.replay = await waitFor(() => { const value = snapshot(); return value.red && value.green ? value : null }, '切页颜色回放')
    result.after = (await window.gitReport.terminalList()).sessions.find((s) => s.id === sid)
    result.defaultColor = getComputedStyle(document.querySelector('.term-pane .xterm-rows')).color
  } catch (error) { result.error = error.message }
  finally {
    if (offData) offData()
    result.errors = errors
    // 主进程完整退出流程会清理本测试创建的真实 pty。
    setTimeout(() => window.gitReport.winClose(), 100)
  }
  return result
})()`

async function main() {
  if (process.platform !== 'win32') throw new Error('本测试需要 Windows ConPTY 和 PowerShell 7')
  console.log(`终端颜色隔离 E2E 开始：${new Date(STARTED_AT).toISOString()}`)
  const bootstrap = prepare()
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('SMOKE_') || key === 'ELECTRON_RUN_AS_NODE' || key === 'ELECTRON_RENDERER_URL') delete env[key]
  }
  Object.assign(env, {
    PROJECT_MANAGER_USER_DATA: USER_DATA, NO_COLOR: '1',
    SMOKE_VIEW: '终端工作台', SMOKE_CLICK_MS: '500', SMOKE_EVAL_MS: '1000',
    SMOKE_EXIT_MS: '65000', SMOKE_WIDTH: '1440', SMOKE_HEIGHT: '940', SMOKE_EVAL: PROBE,
    APPDATA: path.join(SANDBOX, 'roaming'), LOCALAPPDATA: path.join(SANDBOX, 'local'),
  })
  fs.mkdirSync(env.APPDATA, { recursive: true })
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true })
  const child = spawn(require('electron'), [bootstrap, '--host-resolver-rules=MAP * ~NOTFOUND'], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75000)
  let code
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }) }
  finally { clearTimeout(timer) }
  const evalLines = [...log.matchAll(/\[SMOKE\]\[eval\] (.*)/g)]
  const hiddenLines = [...log.matchAll(/\[COLOR_E2E\]\[hidden\] (.*)/g)]
  const result = evalLines.length ? JSON.parse(evalLines.at(-1)[1]) : null
  const hidden = hiddenLines.length ? JSON.parse(hiddenLines.at(-1)[1]) : null
  if (code !== 0 || !result || result.error) {
    if (result) console.log(JSON.stringify({ error: result.error, output: result.output, input: result.input }))
    // 仅打印应用自身的冒烟/启动错误，不打印终端原始输出或用户配置。
    const diagnostic = log.split(/\r?\n/).filter((line) => /^\[SMOKE\]|^\[COLOR_E2E\]|^(?:Error|TypeError|ReferenceError):/.test(line))
    console.error(diagnostic.slice(-15).join('\n') || '未收到应用冒烟诊断')
    throw new Error(result?.error || `Electron 未完成探针（退出码 ${code}）`)
  }
  check('测试窗口始终隐藏', hidden?.windows === 1 && hidden?.visible === 0, JSON.stringify(hidden))
  check('父进程 NO_COLOR 保持为 1', hidden?.parentNoColor === '1')
  check('PowerShell 保留输出颜色控制序列', result.hasSgr)
  const red = result.output.red?.[0]
  const green = result.output.green?.[0]
  check('Write-Host 红绿输出显示不同颜色', red && green && red !== green, JSON.stringify(result.output))
  check('彩色输出区别于终端默认文字', red && green && red !== result.defaultColor && green !== result.defaultColor, result.defaultColor)
  check('PSReadLine 命令和字符串使用不同颜色', result.input.command?.length === 1 && result.input.string?.length === 1 && result.input.command[0] !== result.input.string[0], JSON.stringify(result.input))
  check('切页回放保留红绿输出颜色', JSON.stringify(result.output) === JSON.stringify(result.replay), JSON.stringify(result.replay))
  check('切页仍复用原会话和进程', result.background?.id === result.before.id && result.background?.pid === result.before.pid && result.after?.id === result.before.id && result.after?.pid === result.before.pid)
  check('会话只在隔离项目目录运行', path.resolve(result.before.cwd) === path.resolve(PROJECT.localPath))
  check('渲染层无错误', result.errors.length === 0 && !/\[SMOKE\]\[(?:renderer:error|eval-err|render-gone|did-fail-load)\]/.test(log), JSON.stringify(result.errors))
}

main().catch((error) => { failed += 1; console.error(`终端颜色 E2E 失败：${error.stack || error}`) }).finally(() => {
  const elapsed = ((Date.now() - STARTED_AT) / 1000).toFixed(1)
  console.log(`终端颜色隔离 E2E：${failed ? `${failed} 项失败` : '全部通过'}；结束 ${new Date().toISOString()}，耗时 ${elapsed} 秒`)
  if (failed) console.log(`失败现场保留：${SANDBOX}`)
  else {
    const resolved = path.resolve(SANDBOX)
    const relative = path.relative(path.resolve(os.tmpdir()), resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('pm-terminal-color-')) {
      console.error(`拒绝清理越界目录：${resolved}`)
      failed += 1
    } else fs.rmSync(resolved, { recursive: true, force: true })
  }
  process.exitCode = failed ? 1 : 0
})
