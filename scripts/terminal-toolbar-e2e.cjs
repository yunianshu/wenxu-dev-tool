/**
 * E2E：终端工作台工具栏（真实 Electron + 真实终端会话）
 *
 * 需求（2026-09-20）：
 *   1. 字号设置已移入「设置 → 界面」，终端工作台工具栏里的那组要删掉
 *   2. 「添加窗格」到「全部关闭」之间的按钮大小不一，需要统一
 *
 * 验收标准（源自需求）：
 *   T1 终端工作台工具栏不再出现字号控件
 *   T2 工具栏内三个控件（添加窗格 / 分屏方式 / 全部关闭）高度一致
 *   T3 字号在设置页调整后，终端窗格按新字号渲染（跨页面链路仍通）
 *
 * 注：侧栏可能是收起态（菜单项无文案），按索引定位菜单项。
 *
 * 用法：node scripts/terminal-toolbar-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const REAL = path.join(process.env.APPDATA, 'dev-project-manager')
const SANDBOX = path.join(os.tmpdir(), `pm-toolbar-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const PREFS = path.join(USER_DATA, 'ui-prefs.json')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed += 1 }
}

function prepare() {
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  fs.mkdirSync(USER_DATA, { recursive: true })
  for (const f of fs.readdirSync(REAL)) {
    const src = path.join(REAL, f)
    if (fs.statSync(src).isFile() && f.endsWith('.json')) fs.copyFileSync(src, path.join(USER_DATA, f))
  }
  // 已知初值；同时清掉终端布局，保证从「无窗格」起步
  fs.writeFileSync(PREFS, JSON.stringify({ sidebarCollapsed: false, terminalFontSize: 14 }), 'utf8')
  fs.rmSync(path.join(USER_DATA, 'terminal-layout.json'), { force: true })
}

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const menuItem = (i) => [...document.querySelectorAll('.el-menu-item')][i]
  const readXterm = () => {
    const rows = document.querySelector('.xterm-rows')
    if (!rows) return null
    return Math.round(Number(getComputedStyle(rows).fontSize.replace('px', ''))) || null
  }
  out.contentBefore = (document.querySelector('.content-area > *') || {}).className || ''

  // 索引：0 工作台 / 1 项目 / 2 AI 助手 / 3 Harness / 4 终端工作台 / … / 9 设置
  menuItem(4)?.click()
  await sleep(1400)
  out.toolbarPresent = !!document.querySelector('.terminal-toolbar')
  out.fontSizeControlInToolbar = !!document.querySelector('.terminal-font-size')

  const add = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('添加窗格'))
  if (!add) { out.error = '未找到「添加窗格」按钮'; return out }
  add.click()
  await sleep(700)
  const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find((el) => !el.classList.contains('is-disabled'))
  if (!item) { out.error = '下拉里没有可添加的项目'; return out }
  item.click()
  await sleep(2600)

  // T2：工具栏里各控件等高
  const toolbar = document.querySelector('.terminal-toolbar')
  out.heights = [...toolbar.querySelectorAll('.el-button, .el-radio-button__inner')]
    .map((el) => Math.round(el.getBoundingClientRect().height))
  out.xtermBefore = readXterm()

  // T3：切到设置页调字号，再切回来
  menuItem(9)?.click()
  await sleep(1400)
  const uiTab = [...document.querySelectorAll('.settings-sections .el-segmented__item')].find((e) => e.textContent.trim() === '界面')
  if (!uiTab) { out.error = '设置页没有「界面」分区'; return out }
  uiTab.click()
  await sleep(500)
  const ctrl = document.querySelector('.settings-ui .font-size-control')
  if (!ctrl) { out.error = '界面分区里没有字号控件'; return out }
  const val = () => Number(ctrl.querySelector('.font-size-value').textContent)
  out.settingsBefore = val()
  ;[...ctrl.querySelectorAll('button')].find((b) => b.textContent.includes('＋')).click()
  await sleep(500)
  out.settingsAfter = val()

  menuItem(4)?.click()
  await sleep(3200)
  out.xtermAfter = readXterm()
  return out
})()`

async function run() {
  prepare()
  const child = spawn(process.execPath, [ELECTRON, '.'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_MANAGER_USER_DATA: USER_DATA,
      SMOKE_WIDTH: '1400',
      SMOKE_HEIGHT: '900',
      SMOKE_EXIT_MS: '26000',
      SMOKE_EVAL: PROBE,
      SMOKE_EVAL_MS: '3500',
      // SHOT=1 时顺带截图（探针结束时停在终端工作台）供人工核对工具栏排版
      ...(process.env.SHOT
        ? { SMOKE_SHOT_MS: '17000', SMOKE_SCREENSHOT_PATH: path.join(SANDBOX, 'toolbar.png') }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  await new Promise((resolve) => child.on('exit', resolve))

  const line = out.split('\n').find((l) => l.includes('[SMOKE][eval]'))
  if (!line) { console.log('  FAIL  探针未返回'); return }
  const r = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
  if (r.error) { console.log(`  FAIL  ${r.error}`); console.log(JSON.stringify(r)); failed += 1; return }

  assert('T1 工具栏存在', r.toolbarPresent === true)
  assert('T1 工具栏里已无字号控件', r.fontSizeControlInToolbar === false, `实得 ${r.fontSizeControlInToolbar}`)
  const hs = r.heights || []
  assert('T2 三个控件都量到高度', hs.length >= 3, `实得 ${JSON.stringify(hs)}`)
  assert('T2 各控件等高', new Set(hs).size === 1, `高度 ${JSON.stringify(hs)}`)
  assert('T3 改动前窗格用偏好里的 14', r.xtermBefore === 14, `实得 ${r.xtermBefore}`)
  assert('T3 设置页 +1 后为 15', r.settingsAfter === r.settingsBefore + 1, `${r.settingsBefore} → ${r.settingsAfter}`)
  assert('T3 回到终端页窗格按新字号渲染', r.xtermAfter === r.settingsAfter, `xterm=${r.xtermAfter} 期望=${r.settingsAfter}`)

  const saved = JSON.parse(fs.readFileSync(PREFS, 'utf8'))
  assert('T3 字号已落盘', saved.terminalFontSize === r.settingsAfter, `文件=${saved.terminalFontSize}`)

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
}

run().catch((e) => { console.error(e); process.exit(1) }).finally(() => {
  console.log(`沙箱可清理：${SANDBOX}`)
  process.exit(failed ? 1 : 0)
})
