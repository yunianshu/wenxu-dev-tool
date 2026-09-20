/**
 * 终端工作台「目录切换 → 窗格标题/路径实时更新」端到端验证
 *
 * 真实链路：启动应用 → 恢复布局出窗格 → 真实 pwsh 会话（主进程注入 prompt 钩子）
 * → 用应用同款 IPC（terminalWrite）往 pty 里敲 Set-Location → 主进程从输出流解出
 * OSC 9;9 → 广播 terminal:cwd → 渲染层窗格标题栏显示新目录。
 *
 * 判据（断言最终业务状态，不验证调用痕迹）：
 *   1) terminalList 里会话 cwd 变为切换后的目录（主进程状态）
 *   2) 窗格标题栏 small 文本变为新目录的 shortPath（页面显示）
 *
 * 用法：node scripts/terminal-cwd-e2e.cjs（先 npm run build:renderer）
 *       E2E_EXE=<win-unpacked 的 exe> 时直接跑打包产物
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-e2e-terminal-cwd-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')
const LAYOUT_FILE = path.join(USER_DATA, 'terminal-layout.json')
const EXE = process.env.E2E_EXE || path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const RUN_PACKAGED = Boolean(process.env.E2E_EXE)

// 项目目录 + 一个用于 cd 的子目录（目录名带中文，顺带覆盖非 ASCII 路径展示）
const PROJECT_DIR = path.join(SANDBOX, 'demo-project')
const CHILD_DIR = path.join(PROJECT_DIR, '子目录-child')

fs.mkdirSync(PROJECT_DIR, { recursive: true })
fs.mkdirSync(CHILD_DIR, { recursive: true })
fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
  projects: [{
    id: 'proj-cwd-e2e',
    name: '目录切换验证项目',
    description: '',
    localPath: PROJECT_DIR,
    status: 'active',
    tags: [],
  }],
}, null, 2))
fs.writeFileSync(LAYOUT_FILE, JSON.stringify({
  version: 1,
  gridMode: 'auto',
  columnWidths: [1],
  rowHeights: [1],
  panes: [{ paneId: 'pane-cwd-e2e', projectId: 'proj-cwd-e2e', shellId: '', title: '', width: 0.5 }],
  savedAt: Date.now(),
}, null, 2))

const FLOW = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const headerSmall = () => document.querySelector('.terminal-grid .term-pane .term-pane-title small')?.textContent?.trim() || ''
  const headerTitle = () => document.querySelector('.terminal-grid .term-pane .term-pane-title strong')?.textContent?.trim() || ''
  const sessions = async () => (await window.gitReport.terminalList().catch(() => null))?.sessions || []

  // 1) 等窗格恢复、会话建好（点击切页由 SMOKE_CLICK_MS 完成，这里只等结果）
  let session = null
  for (let i = 0; i < 60 && !session; i += 1) {
    const list = await sessions()
    session = list.find((s) => s.paneId === 'pane-cwd-e2e' && !s.exited)
    if (!session) await wait(500)
  }
  if (!session) return { ok: false, stage: 'no-session', panes: document.querySelectorAll('.term-pane').length }
  // 等 shell 首个提示符（钩子首次上报会把会话 cwd 归一成真实长路径）
  for (let i = 0; i < 30; i += 1) {
    const now = (await sessions()).find((s) => s.id === session.id)
    if (now && now.cwd && now.cwd.toLowerCase() !== ${JSON.stringify(PROJECT_DIR.toLowerCase())}) break
    await wait(500)
  }
  await wait(800)
  const beforeHeader = headerSmall()
  const beforeTitle = headerTitle()
  const beforePtyCwd = (await sessions()).find((s) => s.id === session.id)?.cwd || ''

  // 2) 往真实 pty 里敲 cd（与键盘输入同一条 IPC 链路）
  await window.gitReport.terminalWrite(session.id, 'Set-Location -LiteralPath ' + JSON.stringify(${JSON.stringify(CHILD_DIR)}).replace(/"/g, "'") + '\\r')

  // 3) 等标题栏显示新目录（写可能抢在 shell 就绪前被吃掉，重发几次）
  const shortPath = (p) => p.split(/[\\\\/]/).filter(Boolean).slice(-2).join('/')
  let afterHeader = ''
  let afterPtyCwd = ''
  for (let i = 0; i < 50; i += 1) {
    if (i > 0 && i % 6 === 0) {
      await window.gitReport.terminalWrite(session.id, 'Set-Location -LiteralPath ' + JSON.stringify(${JSON.stringify(CHILD_DIR)}).replace(/"/g, "'") + '\\r')
    }
    afterHeader = headerSmall()
    afterPtyCwd = (await sessions()).find((s) => s.id === session.id)?.cwd || ''
    if (afterHeader === shortPath(${JSON.stringify(CHILD_DIR)})) break
    await wait(500)
  }
  return {
    ok: afterHeader === shortPath(${JSON.stringify(CHILD_DIR)}),
    beforeTitle,
    beforeHeader,
    beforePtyCwd,
    afterHeader,
    afterPtyCwd,
    expected: shortPath(${JSON.stringify(CHILD_DIR)}),
    titleUnchanged: headerTitle() === beforeTitle,
  }
})()`

const env = {
  ...process.env,
  PROJECT_MANAGER_USER_DATA: USER_DATA,
  SMOKE_EXIT_MS: '80000',
  SMOKE_VIEW: '终端工作台',
  SMOKE_CLICK_MS: '1500',
  SMOKE_EVAL: FLOW,
  SMOKE_EVAL_MS: '2500',
  SMOKE_WIDTH: '1400',
  SMOKE_HEIGHT: '900',
  SMOKE_SCREENSHOT_PATH: path.join(SANDBOX, 'shot.png'),
  SMOKE_SHOT_MS: '42000',
}
delete env.ELECTRON_RUN_AS_NODE

console.log('沙箱：', SANDBOX)
const child = RUN_PACKAGED
  ? spawn(EXE, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(process.execPath, [EXE, '.'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })
child.on('exit', () => {
  const hits = [...log.matchAll(/\[SMOKE\]\[eval\] (.*)/g)]
  if (!hits.length) {
    console.log('未取到 eval 结果，日志尾部：')
    console.log(log.slice(-3000))
    process.exitCode = 1
    return
  }
  let parsed = null
  try { parsed = JSON.parse(hits[hits.length - 1][1]) } catch { /* 下面统一报失败 */ }
  console.log('eval 结果：', JSON.stringify(parsed, null, 2))
  const ok = !!parsed?.ok && parsed.titleUnchanged !== false
  console.log(ok ? 'E2E 通过：cd 后窗格标题/路径已实时更新' : 'E2E 失败')
  console.log('截图：', path.join(SANDBOX, 'shot.png'))
  if (!ok) process.exitCode = 1
})
