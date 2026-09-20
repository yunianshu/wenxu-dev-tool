/**
 * E2E：设置页新增「界面」分区（真实 Electron + 沙箱 userData）
 *
 * 需求：把终端字号设置放进系统设置里。
 *
 * 验收标准（源自需求）：
 *   S1 设置页出现「界面」分区，可点入
 *   S2 分区内可调终端字号：点 A＋ 后 state 与 ui-prefs.json 同步变化
 *   S3 「恢复默认」把字号复位为 13
 *   S4 「窗口关闭行为」已随迁至「界面」分区，不再留在「应用信息」里
 *   S5 与终端工作台工具栏共用同一份状态（改一处，另一处立即一致）
 *
 * 用法：node scripts/settings-ui-section-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const REAL = path.join(process.env.APPDATA, 'dev-project-manager')
const SANDBOX = path.join(os.tmpdir(), `pm-settingsui-${Date.now()}`)
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
  fs.writeFileSync(PREFS, JSON.stringify({ sidebarCollapsed: false, terminalFontSize: 16 }), 'utf8')
}

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = {}
  const segItem = (label) => [...document.querySelectorAll('.settings-sections .el-segmented__item')]
    .find((e) => e.textContent.trim() === label)
  out.sections = [...document.querySelectorAll('.settings-sections .el-segmented__item')].map((e) => e.textContent.trim())
  const uiTab = segItem('界面')
  if (!uiTab) { out.error = '设置页没有「界面」分区'; return out }
  uiTab.click()
  await sleep(600)
  out.uiSectionVisible = !!document.querySelector('.settings-ui') && document.querySelector('.settings-ui').offsetHeight > 0
  // S4：「应用信息」里不应再有窗口关闭行为
  const aboutTab = segItem('应用信息')
  aboutTab.click()
  await sleep(400)
  out.closeBehaviorInAbout = !!document.querySelector('.settings-about .settings-item')
  uiTab.click()
  await sleep(400)
  const ctrl = document.querySelector('.settings-ui .font-size-control')
  if (!ctrl) { out.error = '界面分区里没有字号控件'; return out }
  const val = () => Number(ctrl.querySelector('.font-size-value').textContent)
  const plus = [...ctrl.querySelectorAll('button')].find((b) => b.textContent.includes('＋'))
  const reset = [...ctrl.querySelectorAll('button')].find((b) => b.textContent.includes('恢复默认'))
  out.initial = val()
  plus.click()
  await sleep(500)
  out.afterPlus = val()
  reset.click()
  await sleep(500)
  out.afterReset = val()
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
      SMOKE_VIEW: '设置',
      SMOKE_CLICK_MS: '3200',
      SMOKE_EVAL: PROBE,
      SMOKE_EVAL_MS: '6500',
      // SHOT=1 时顺带截图（探针结束时停在「界面」分区），供人工核对排版
      ...(process.env.SHOT
        ? { SMOKE_SHOT_MS: '9500', SMOKE_SCREENSHOT_PATH: path.join(SANDBOX, 'settings-ui.png') }
        : {}),
      SMOKE_EXIT_MS: process.env.SHOT ? '12000' : '16000',
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

  assert('S1 「界面」分区存在', r.sections.includes('界面'), JSON.stringify(r.sections))
  assert('S1 可点入且内容可见', r.uiSectionVisible === true)
  assert('S4 关闭行为已移出「应用信息」', r.closeBehaviorInAbout === false)
  assert('S2 初值取自 ui-prefs（预置 16）', r.initial === 16, `实得 ${r.initial}`)
  assert('S2 点 A＋ 字号 +1', r.afterPlus === r.initial + 1, `${r.initial} → ${r.afterPlus}`)
  assert('S3 恢复默认回到 13', r.afterReset === 13, `实得 ${r.afterReset}`)

  const saved = JSON.parse(fs.readFileSync(PREFS, 'utf8'))
  assert('S2 落盘', saved.terminalFontSize === 13, `文件=${saved.terminalFontSize}`)
  assert('S2 未冲掉其他偏好', saved.sidebarCollapsed === false, `文件=${saved.sidebarCollapsed}`)

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
}

run().catch((e) => { console.error(e); process.exit(1) }).finally(() => {
  console.log(`沙箱可清理：${SANDBOX}`)
  process.exit(failed ? 1 : 0)
})
