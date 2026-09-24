/**
 * 终端字体 E2E：真实 Electron、真实 xterm 与 IPC，全部使用临时项目和用户数据。
 * 不复制真实配置，不调用 AI、服务器或安装流程。
 *
 * 入口：字体设置只在「设置 → 界面」（2026-09-24 起终端工作台工具栏不再有「字体」按钮，
 * 工作台侧只验证「设置页改完、切回终端页所有窗格按新字体渲染且会话未重启」）。
 * 前置：npm run build:renderer；运行：node scripts/terminal-font-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const STARTED_AT = Date.now()
const ROOT = path.resolve(__dirname, '..')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-terminal-font-'))
const USER_DATA = path.join(SANDBOX, 'appdata')
const PREFS = path.join(USER_DATA, 'ui-prefs.json')
const CAPTURE = process.env.TERMINAL_FONT_E2E_SHOT === '1'
const PRESET = 'Cascadia Mono'
const CUSTOM = 'E2E Terminal Mono'
const PROJECTS = [1, 2].map((n) => ({
  id: `font-e2e-${n}`,
  name: `字体隔离项目 ${n}`,
  description: '',
  localPath: path.join(SANDBOX, `project-${n}`),
  status: 'active',
  tags: [],
}))
let failed = 0

function check(name, condition, detail = '') {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `：${detail}` : ''}`)
  if (!condition) failed += 1
}

function prepare() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  for (const project of PROJECTS) fs.mkdirSync(project.localPath)
  fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }))
  // 只预置测试所需配置；关闭窗口时正常退出，保证主进程清理它创建的 pty。
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ closeAction: 'quit' }))
  fs.writeFileSync(PREFS, JSON.stringify({ sidebarCollapsed: false }))
  fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
    version: 1,
    gridMode: 'auto',
    columnWidths: [1],
    rowHeights: [1],
    panes: [{ paneId: 'font-e2e-pane-1', projectId: PROJECTS[0].id, shellId: process.platform === 'win32' ? 'cmd' : '', title: '' }],
    savedAt: Date.now(),
  }))
}

const HELPERS = `
  const errors = []
  window.addEventListener('error', (e) => errors.push(String(e.message || e)))
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)))
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const visible = (el) => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0
  const findText = (selector, text, scope = document) => [...scope.querySelectorAll(selector)]
    .find((el) => visible(el) && el.textContent.trim() === text)
  const waitFor = async (read, label) => {
    const start = Date.now()
    while (Date.now() - start < 12000) {
      const result = await read()
      if (result) return result
      await sleep(120)
    }
    throw new Error('等待超时：' + label)
  }
  const click = (el, label) => {
    if (!el) throw new Error('未找到：' + label)
    el.click()
  }
  const snapshot = async () => {
    const sessions = (await window.gitReport.terminalList()).sessions || []
    const panes = [...document.querySelectorAll('.terminal-grid .term-pane')]
    return {
      panes: panes.map((pane) => {
        const rows = pane.querySelector('.xterm-rows')
        const style = rows ? getComputedStyle(rows) : null
        return { family: style?.fontFamily || '', size: Number.parseFloat(style?.fontSize || '0') }
      }),
      sessions: sessions.filter((s) => !s.exited).map((s) => ({ id: s.id, pid: s.pid, cwd: s.cwd })),
      prefs: await window.gitReport.uiPrefsLoad(),
      errors: [...errors],
    }
  }
  const ready = (count, family, size) => waitFor(async () => {
    const value = await snapshot()
    return value.panes.length === count && value.sessions.length === count
      && value.sessions.every((s) => s.pid > 0)
      && value.panes.every((p) => p.family && (!family || p.family.includes(family)) && (!size || p.size === size))
      ? value : null
  }, '终端窗格 ' + count + ' / ' + (family || '默认字体') + ' / ' + (size || '任意字号'))
  const selectFamily = async (control, name) => {
    const select = control.querySelector('.terminal-font-family')
    click(select?.querySelector('.el-select__wrapper'), '字体选择框')
    const input = select?.querySelector('input')
    if (!input) throw new Error('字体选择框缺少可编辑输入')
    input.focus()
    input.value = name
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const option = await waitFor(() => findText('.el-select-dropdown__item', name), '字体选项 ' + name)
    click(option, '字体选项 ' + name)
    await waitFor(async () => (await window.gitReport.uiPrefsLoad()).terminalFontFamily === name, '字体偏好保存')
  }
  const stepSize = async (control) => {
    const previous = Number(control.querySelector('.font-size-value')?.textContent)
    click(findText('button', 'A＋', control), '增大字号')
    await waitFor(() => Number(control.querySelector('.font-size-value')?.textContent) === previous + 1, '字号增加')
    await waitFor(async () => (await window.gitReport.uiPrefsLoad()).terminalFontSize === previous + 1, '字号偏好保存')
    return previous + 1
  }
  const navigate = async (text) => {
    click(findText('.app-menu .el-menu-item', text), text + '导航')
    await sleep(180)
  }
  /** 打开字体设置：唯一入口是「设置 → 界面」 */
  const openFonts = async () => {
    await navigate('设置')
    click(findText('.settings-sections .el-segmented__item', '界面'), '界面设置分区')
    return waitFor(() => [...document.querySelectorAll('.settings-ui .terminal-font-settings')].find(visible), '设置页字体组件')
  }
  /** 关掉字体设置 = 切回终端工作台（窗格在那里重新挂载） */
  const closeFonts = async () => {
    await navigate('终端工作台')
  }
`

function probe(body) {
  return `(async () => {
    ${HELPERS}
    const result = {}
    try { ${body} } catch (error) { result.error = error.message; result.current = await snapshot().catch(() => null) }
    result.errors = [...errors]
    // 先返回探针结果，再经真实窗口关闭 IPC 退出；超时由 SMOKE_EXIT_MS 兜底。
    setTimeout(() => window.gitReport.winClose(), 800)
    return result
  })()`
}

const FIRST = probe(`
  result.before = await ready(1, '', 13)
  let control = await openFonts()
  await selectFamily(control, ${JSON.stringify(PRESET)})
  await closeFonts()
  result.preset = await ready(1, ${JSON.stringify(PRESET)}, 13)

  control = await openFonts()
  await selectFamily(control, ${JSON.stringify(CUSTOM)})
  const firstSize = await stepSize(control)
  result.preview = {
    family: getComputedStyle(control.querySelector('.terminal-font-preview')).fontFamily,
    size: Number.parseFloat(getComputedStyle(control.querySelector('.terminal-font-preview')).fontSize),
  }
  ${CAPTURE ? 'await sleep(20000)' : ''}
  await closeFonts()
  result.changed = await ready(1, ${JSON.stringify(CUSTOM)}, firstSize)

  click(findText('.terminal-toolbar button', '新建终端'), '新建终端')
  click(await waitFor(() => findText('.el-dropdown-menu__item', ${JSON.stringify(PROJECTS[1].name)}), '第二个测试项目'), '第二个测试项目')
  result.added = await ready(2, ${JSON.stringify(CUSTOM)}, firstSize)

  await navigate('设置')
  click(await waitFor(() => findText('.settings-sections .el-segmented__item', '界面'), '界面设置分区'), '界面设置分区')
  control = await waitFor(() => [...document.querySelectorAll('.settings-ui .terminal-font-settings')].find(visible), '设置页字体组件')
  result.settings = {
    size: Number(control.querySelector('.font-size-value')?.textContent),
    family: control.querySelector('.terminal-font-family')?.textContent.trim() || '',
  }
  const secondSize = await stepSize(control)
  await closeFonts()
  result.back = await ready(2, ${JSON.stringify(CUSTOM)}, secondSize)
`)

const SECOND = probe(`
  result.restored = await ready(2, ${JSON.stringify(CUSTOM)}, 15)
  const control = await openFonts()
  result.settingsBeforeReset = {
    size: Number(control.querySelector('.font-size-value')?.textContent),
    family: control.querySelector('.terminal-font-family')?.textContent.trim() || '',
  }
  click(findText('button', '恢复默认', control), '恢复默认')
  await waitFor(async () => {
    const prefs = await window.gitReport.uiPrefsLoad()
    return prefs.terminalFontFamily === '' && prefs.terminalFontSize === 13
  }, '默认字体与字号保存')
  result.resetLabel = control.querySelector('.terminal-font-family')?.textContent.trim() || ''
  await closeFonts()
  result.reset = await ready(2, '', 13)
`)

async function startInstance(expression, capture = false) {
  const env = { ...process.env }
  // 不能继承开发服务器或其他冒烟开关，否则可能跑到真实页面/启用 Harness 网络任务。
  for (const key of Object.keys(env)) {
    if (key.startsWith('SMOKE_') || key === 'ELECTRON_RUN_AS_NODE' || key === 'ELECTRON_RENDERER_URL') delete env[key]
  }
  Object.assign(env, {
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_VIEW: '终端工作台',
    SMOKE_CLICK_MS: '500',
    SMOKE_EVAL_MS: '1000',
    SMOKE_EXIT_MS: '75000',
    SMOKE_WIDTH: '1440',
    SMOKE_HEIGHT: '940',
    SMOKE_EVAL: expression,
  })
  if (capture) {
    env.SMOKE_SHOT_MS = '15000'
    env.SMOKE_SCREENSHOT_PATH = path.join(SANDBOX, 'terminal-font-settings.png')
  }
  if (process.platform === 'win32') {
    // 子进程的漫游目录也独立，避免新窗格读取真实用户的应用配置。
    // 不能改 USERPROFILE：Electron 用它解析 appData，指向沙箱目录后启动即失败
    // （`Failed to get 'userData' path`，实测 2026-09-24）。
    env.APPDATA = path.join(SANDBOX, 'roaming')
    env.LOCALAPPDATA = path.join(SANDBOX, 'local')
    for (const dir of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true })
  }
  // 直接启动 Electron 可执行文件，异常时只结束本测试创建的进程。
  const child = spawn(require('electron'), ['.', '--host-resolver-rules=MAP * ~NOTFOUND'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (chunk) => { log += chunk })
  child.stderr.on('data', (chunk) => { log += chunk })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 85000)
  let code
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  } finally { clearTimeout(timer) }
  const lines = [...log.matchAll(/\[SMOKE\]\[eval\] (.*)/g)]
  const result = lines.length ? JSON.parse(lines.at(-1)[1]) : null
  if (timedOut || code !== 0 || !result || result.error) {
    console.error(log.split('\n').slice(-25).join('\n'))
    throw new Error(timedOut ? 'Electron 超时' : result?.error || `Electron 未完成探针（退出码 ${code}）`)
  }
  check('渲染层无错误', result.errors.length === 0 && !/\[SMOKE\]\[(?:renderer:error|eval-err|render-gone|did-fail-load)\]/.test(log), JSON.stringify(result.errors))
  return result
}

function identities(snapshot) {
  return snapshot.sessions.map((session) => `${session.id}:${session.pid}`).sort().join('|')
}

function readPrefs() { return JSON.parse(fs.readFileSync(PREFS, 'utf8')) }

async function main() {
  console.log(`终端字体隔离 E2E 开始：${new Date(STARTED_AT).toISOString()}`)
  prepare()
  console.log('[1/2] 设置页改字体、终端页生效、新窗格继承')
  const first = await startInstance(FIRST, CAPTURE)
  check('默认字体与字号可渲染', first.before.panes[0].size === 13 && !!first.before.panes[0].family)
  check('预设字体在终端页生效', first.preset.panes[0].family.includes(PRESET))
  check('自定义字体在终端页生效且保留等宽回退', first.changed.panes[0].family.includes(CUSTOM) && first.changed.panes[0].family.includes('monospace'))
  check('改字体期间会话不重启（切页前后同一 pty）', identities(first.before) === identities(first.preset) && identities(first.before) === identities(first.changed))
  check('预览同步字体与字号', first.preview.family.includes(CUSTOM) && first.preview.size === 14)
  check('新窗格继承字体和字号', first.added.panes.length === 2 && first.added.panes.every((pane) => pane.family.includes(CUSTOM) && pane.size === 14))
  check('新增窗格保留原会话', first.added.sessions.some((s) => `${s.id}:${s.pid}` === identities(first.before)))
  check('全部会话工作目录都属于临时测试项目', PROJECTS.every((p) => first.added.sessions.some((s) => path.resolve(s.cwd) === path.resolve(p.localPath))))
  check('设置页展示同一份字体偏好', first.settings.family.includes(CUSTOM) && first.settings.size === 14)
  check('设置页调整后切回终端立即生效', first.back.panes.every((pane) => pane.family.includes(CUSTOM) && pane.size === 15))
  check('切页仍复用所有原会话', identities(first.added) === identities(first.back))
  const saved = readPrefs()
  check('字体与字号写入隔离用户数据', saved.terminalFontFamily === CUSTOM && saved.terminalFontSize === 15)

  console.log('[2/2] 重启恢复与恢复默认')
  const second = await startInstance(SECOND)
  check('重启后所有窗格恢复已保存字体与字号', second.restored.panes.length === 2 && second.restored.panes.every((pane) => pane.family.includes(CUSTOM) && pane.size === 15))
  check('重启后的设置控件显示已保存值', second.settingsBeforeReset.family.includes(CUSTOM) && second.settingsBeforeReset.size === 15)
  check('恢复默认同时重置全部窗格字体与字号', second.reset.panes.every((pane) => pane.family === first.before.panes[0].family && pane.size === 13))
  check('恢复默认不重启会话', identities(second.restored) === identities(second.reset))
  check('默认字体选项可正确显示空字符串值', second.resetLabel.includes('默认等宽字体'))
  const reset = readPrefs()
  check('恢复默认结果持久化', reset.terminalFontFamily === '' && reset.terminalFontSize === 13)
  check('其他界面偏好未被改写', saved.sidebarCollapsed === false && reset.sidebarCollapsed === false)
}

main().catch((error) => {
  failed += 1
  console.error(`终端字体 E2E 失败：${error.stack || error}`)
}).finally(() => {
  const elapsed = ((Date.now() - STARTED_AT) / 1000).toFixed(1)
  console.log(`终端字体隔离 E2E：${failed ? `${failed} 项失败` : '全部通过'}；结束 ${new Date().toISOString()}，耗时 ${elapsed} 秒`)
  if (failed) console.log(`失败现场保留：${SANDBOX}`)
  else if (CAPTURE) console.log(`截图及隔离数据保留：${SANDBOX}`)
  else {
    // 只清理本次 mkdtemp 创建且仍位于系统临时目录内的路径。
    const resolved = path.resolve(SANDBOX)
    const relative = path.relative(path.resolve(os.tmpdir()), resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('pm-terminal-font-')) {
      console.error(`拒绝清理越界目录：${resolved}`)
      failed += 1
    } else fs.rmSync(resolved, { recursive: true, force: true })
  }
  process.exitCode = failed ? 1 : 0
})
