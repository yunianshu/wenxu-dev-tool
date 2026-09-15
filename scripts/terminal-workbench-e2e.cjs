/**
 * E2E（真实 Electron + 沙箱用户数据目录）：终端工作台多窗格与布局恢复
 *
 * 需求：一个界面上按 2x2 平铺多个项目的终端，切页不丢会话，下次打开恢复上次的多窗口布局。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   T1 布局恢复：上次保存的 4 个项目窗格按 2x2 平铺渲染出来，每个窗格都有真实会话（PID>0）
 *   T2 窗格绑定与顺序：窗格标题按布局文件里的项目顺序排列，会话工作目录是各项目目录
 *   T3 会话常驻：切到其他页面后终端视图卸载，但 pty 进程仍在（同一批 PID）
 *   T4 切回复用：切回工作台重新渲染出 4 个窗格，且复用原会话（没有多出新进程）
 *   T5 布局落盘：窗格顺序与绑定项目写进 userData/terminal-layout.json
 *   T6 重启恢复：再次启动应用，按落盘顺序恢复窗格并重新拉起真实会话
 *   T7 退出不留残留：应用退出后 shell 进程全部结束
 *   T8 全程无渲染层错误
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/terminal-workbench-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-terminal-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')
const LAYOUT_FILE = path.join(USER_DATA, 'terminal-layout.json')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

/** 四个「项目」：指向仓库内真实存在的目录，shell 能在里面正常启动 */
const PROJECTS = ['src', 'electron', 'scripts', 'dist'].map((dir, index) => ({
  id: `proj-${index + 1}`,
  name: `自测项目 ${index + 1}`,
  description: '',
  localPath: path.join(ROOT, dir),
  status: 'active',
  tags: [],
}))

function seedProjects() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects: PROJECTS }, null, 2))
}

/** 预置上次的 2x2 布局：模拟「用户上次进了四个项目的分屏」 */
function seedLayout(panes = PROJECTS.map((p) => ({ projectId: p.id, shellId: '', title: '', width: 0.5 }))) {
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify({
    version: 1,
    gridMode: '2x2',
    columnWidths: [0.5, 0.5],
    rowHeights: [0.5, 0.5],
    panes,
    savedAt: Date.now(),
  }, null, 2))
}

function readLayout() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf8')) } catch { return null }
}

function startInstance({ view, evalExpr, exitMs = 120000, clickMs = 2500 }) {
  // 关键：调用方环境里可能带着 ELECTRON_RUN_AS_NODE=1（例如从 Harness 会话里跑测试），
  // 被继承后 Electron 会以 Node 模式启动 —— 此时 require('electron') 是路径字符串、
  // app 为 undefined，应用在 main.js 第一行就崩。
  // 注意：**必须整个删掉这个变量**，传空串 Electron 仍按「已设置」处理。
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: String(exitMs),
    SMOKE_CLICK_MS: String(clickMs),
    SMOKE_VIEW: view,
    SMOKE_EVAL: evalExpr,
    SMOKE_EVAL_MS: '1500',
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, [ELECTRON, '.'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, done, log: () => log }
}

async function waitFor(fn, { timeout = 60000, interval = 600, label = '条件' } = {}) {
  const start = Date.now()
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, interval))
  }
}

/** 从冒烟日志里取出最后一次 [SMOKE][eval] 的 JSON 结果 */
function lastEval(log) {
  const hits = [...String(log).matchAll(/\[SMOKE\]\[eval\] (.*)/g)]
  if (!hits.length) return null
  try { return JSON.parse(hits[hits.length - 1][1]) } catch { return null }
}

/** 渲染层错误收集 + 读取主进程真实会话表（经 preload IPC，不是读 DOM 猜测） */
const HELPERS = `
  window.__e2eErrors = window.__e2eErrors || []
  window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message || e)))
  window.__state = async () => {
    const sessions = await window.gitReport.terminalList().catch(() => null)
    const all = sessions?.sessions || []
    const panes = [...document.querySelectorAll('.terminal-grid .term-pane')]
    return {
      panes: panes.length,
      titles: panes.map((p) => p.querySelector('.term-pane-title strong')?.textContent || ''),
      // 每个窗格的状态灯与覆盖层文案：用于定位「某个窗格没起会话」的具体原因
      dotClasses: panes.map((p) => p.querySelector('.term-dot')?.className || ''),
      overlays: panes.map((p) => p.querySelector('.term-overlay p')?.textContent || ''),
      rendered: !!document.querySelector('.terminal-grid .xterm'),
      page: document.querySelector('.page')?.className || '',
      live: all.filter((s) => !s.exited && s.pid > 0).length,
      exited: all.filter((s) => s.exited).length,
      pids: all.map((s) => s.pid),
      cwds: all.map((s) => s.cwd),
      errors: window.__e2eErrors,
    }
  }
`

/**
 * 一个实例内完成「渲染 → 切走 → 切回」三步，避免多次启动互相干扰会话计数。
 * 返回 { restored, left, back } 三个快照。
 */
const FLOW = `(async () => {
  ${HELPERS}
  const menu = (text) => [...document.querySelectorAll('.app-menu .el-menu-item')]
    .find((el) => el.textContent.includes(text))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // 1) 恢复出窗格（每次探测重建状态，直到 4 个窗格都挂上）
  let restored = null
  for (let i = 0; i < 40; i += 1) {
    const snapshot = await window.__state()
    if (snapshot.panes === 4 && snapshot.rendered && snapshot.live === 4) { restored = snapshot; break }
    await wait(500)
  }
  if (!restored) return { restored: await window.__state(), left: null, back: null }

  // 2) 切到「工作台」页：终端视图应卸载，但会话必须还在
  menu('工作台')?.click()
  await wait(3000)
  const left = await window.__state()

  // 3) 切回「终端工作台」：应复用原会话重新渲染
  menu('终端工作台')?.click()
  await wait(4000)
  const back = await window.__state()
  return { restored, left, back }
})()`

async function main() {
  seedProjects()
  seedLayout()

  console.log('\n[1] 启动应用：恢复上次保存的 4 窗格，并验证切页不丢会话')
  const run = startInstance({ view: '终端工作台', evalExpr: FLOW })
  let flow = null
  try {
    flow = await waitFor(() => {
      const r = lastEval(run.log())
      return r && r.restored && r.left && r.back ? r : null
    }, { timeout: 90000, label: '恢复/切走/切回流程结果' })
  } catch (err) {
    // 启动失败时必须把子进程日志打出来，否则只剩一句「等待超时」无法定位
    console.log(String(run.log()).split('\n').slice(-30).join('\n'))
    run.child.kill()
    check('恢复/切走/切回流程', false, err.message)
    return 1
  }

  const firstPids = [...flow.restored.pids].sort().join(',')
  check('恢复出 4 个窗格（2x2 平铺）且 xterm 就绪', flow.restored.panes === 4 && flow.restored.rendered,
    `窗格 ${flow.restored.panes}`)
  check('每个窗格都起了真实会话（PID>0）', flow.restored.live === 4,
    `存活 ${flow.restored.live}，PID ${flow.restored.pids.join(',')}`)
  check('窗格按布局文件的项目顺序恢复',
    flow.restored.titles.join('|') === PROJECTS.map((p) => p.name).join('|'),
    flow.restored.titles.join(' | '))
  check('会话工作目录是各项目目录',
    PROJECTS.every((p) => flow.restored.cwds.some((c) => path.resolve(c) === path.resolve(p.localPath))),
    flow.restored.cwds.join(' | '))
  check('无会话异常退出', flow.restored.exited === 0)

  check('切走后终端视图已卸载', flow.left.panes === 0, `残留 ${flow.left.panes} 个窗格`)
  check('切走后 pty 会话仍全部存活', flow.left.live === 4, `存活 ${flow.left.live}`)
  check('切页前后是同一批进程（未重启 shell）',
    [...flow.left.pids].sort().join(',') === firstPids, `${flow.left.pids.join(',')} vs ${firstPids}`)

  check('切回后重新渲染出 4 个窗格', flow.back.panes === 4 && flow.back.rendered,
    `窗格 ${flow.back.panes}`)
  check('切回复用原会话（没有多出新进程）', flow.back.live === 4 && [...flow.back.pids].sort().join(',') === firstPids,
    `存活 ${flow.back.live}，PID ${flow.back.pids.join(',')}`)
  check('渲染层无错误', (flow.back.errors || []).length === 0, JSON.stringify(flow.back.errors || []))

  run.child.kill()
  await run.done.catch(() => {})

  console.log('\n[2] 布局落盘')
  const saved = readLayout()
  check('布局写进 userData/terminal-layout.json',
    !!saved && Array.isArray(saved.panes) && saved.panes.length === 4,
    saved ? JSON.stringify(saved.panes.map((p) => p.projectId)) : '文件缺失')
  check('布局记住分屏方式', saved?.gridMode === '2x2', String(saved?.gridMode))
  check('布局记住窗格绑定的项目', JSON.stringify(saved?.panes.map((p) => p.projectId)) === JSON.stringify(PROJECTS.map((p) => p.id)),
    JSON.stringify(saved?.panes.map((p) => p.projectId)))

  console.log('\n[3] 重启恢复（故意把落盘顺序倒过来，验证读的是文件而不是项目列表顺序）')
  const reversed = [...saved.panes].reverse()
  seedLayout(reversed)
  const second = startInstance({ view: '终端工作台', evalExpr: `(async () => { ${HELPERS}; for (let i = 0; i < 40; i += 1) { const s = await window.__state(); if (s.panes === 4 && s.rendered && s.live === 4) return s; await new Promise((r) => setTimeout(r, 500)) } return window.__state() })()` })
  const restart = await waitFor(() => {
    const r = lastEval(second.log())
    return r && r.panes > 0 ? r : null
  }, { timeout: 90000, label: '重启后恢复窗格' })
  const expectedOrder = reversed.map((p) => PROJECTS.find((x) => x.id === p.projectId).name).join('|')
  check('重启后恢复 4 个窗格', restart.panes === 4, `实际 ${restart.panes}`)
  check('重启后按落盘顺序恢复', restart.titles.join('|') === expectedOrder,
    `实际 ${restart.titles.join(' | ')}，期望 ${expectedOrder}`)
  check('重启后重新拉起真实会话', restart.live === 4, `存活 ${restart.live}，PID ${restart.pids.join(',')}`)
  const restartPids = [...restart.pids]
  second.child.kill()
  await second.done.catch(() => {})

  console.log('\n[4] 退出后不留残留 shell 进程')
  const strays = await waitFor(() => {
    const alive = restartPids.filter((pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    return alive.length === 0 ? [] : null
  }, { timeout: 15000, interval: 700, label: 'shell 进程全部退出' }).catch(() => restartPids.filter((pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  }))
  check('应用退出后 shell 进程全部结束', strays.length === 0, strays.length ? `残留 PID ${strays.join(',')}` : '')

  console.log(`\n终端工作台 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  console.log(`沙箱数据目录：${SANDBOX}`)
  return failed === 0 ? 0 : 1
}

main()
  .then((code) => {
    // 失败时保留沙箱现场便于排查；成功时清理
    try { if (code === 0) fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
    process.exitCode = code
  })
  .catch((err) => {
    console.error('终端工作台 E2E 异常：', (err && err.stack) || err)
    console.error(`沙箱数据目录：${SANDBOX}`)
    process.exitCode = 1
  })
