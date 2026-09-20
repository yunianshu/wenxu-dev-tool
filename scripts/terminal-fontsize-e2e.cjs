/**
 * E2E：终端工作台的字号调节（真实 Electron + 沙箱 userData）
 *
 * 需求：终端字号可调并记住（原先是硬编码 13px）。
 *
 * 验收标准（源自需求）：
 *   F1 无窗格时不出现字号控件
 *   F2 添加窗格后出现字号控件，初值 = ui-prefs 里的字号（默认 13）
 *   F3 点「A＋」字号 +1 并立即反映在 xterm 实例上（不只是 store 里的数字）
 *   F4 字号落盘 ui-prefs.json，且**不冲掉已有的 sidebarCollapsed**
 *   F5 到达上限（22）后「A＋」禁用
 *
 * 用法：node scripts/terminal-fontsize-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const REAL = path.join(process.env.APPDATA, 'dev-project-manager')
const SANDBOX = path.join(os.tmpdir(), `pm-fontsize-${Date.now()}`)
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
  for (const d of ['reports', 'deploy-logs']) {
    const src = path.join(REAL, d)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(USER_DATA, d), { recursive: true })
  }
  // 预置一个已知的侧栏收起状态，用于验证调字号不会把它冲掉
  fs.writeFileSync(PREFS, JSON.stringify({ sidebarCollapsed: true, terminalFontSize: 14 }), 'utf8')
  // 终端布局是持久化的：真实数据里的 layout 会让终端页一进来就恢复窗格，
  // 「无窗格时不显示字号控件」的前提就不成立了，这里清掉
  fs.rmSync(path.join(USER_DATA, 'terminal-layout.json'), { force: true })
}

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const out = { steps: [] }
  // 侧栏处于收起态时菜单项没有文案（文案进了 tooltip），按文字定位会落空，
  // 改按索引点第 5 项：0 工作台 / 1 项目 / 2 AI 助手 / 3 Harness / 4 终端工作台
  if (!document.querySelector('.terminal-toolbar')) {
    const items = [...document.querySelectorAll('.el-menu-item')]
    items[4]?.click()
    await sleep(1200)
  }
  out.contentClass = (document.querySelector('.content-area > *') || {}).className || '(无)'
  const fontBox = () => document.querySelector('.terminal-font-size')
  out.initialBox = !!fontBox()
  const add = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('添加窗格'))
  if (!add) {
    out.error = '未找到「添加窗格」按钮'
    out.contentClass = (document.querySelector('.content-area > *') || {}).className || '(无)'
    out.buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim().slice(0, 14)).slice(0, 24)
    out.hint = (document.querySelector('.terminal-hint') || {}).textContent || ''
    return out
  }
  add.click()
  await sleep(600)
  const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find((el) => !el.classList.contains('is-disabled'))
  if (!item) { out.error = '下拉里没有可添加的项目'; return out }
  item.click()
  await sleep(2500)
  out.paneCount = document.querySelectorAll('.terminal-grid > *').length
  const box = fontBox()
  out.boxAfterAdd = !!box
  if (!box) { out.error = '添加窗格后仍无字号控件'; return out }
  const val = () => Number((box.querySelector('.font-size-value') || {}).textContent)
  const plus = [...box.querySelectorAll('button')].find((b) => b.textContent.includes('＋'))
  const minus = [...box.querySelectorAll('button')].find((b) => b.textContent.includes('－'))
  out.before = val()
  out.minusDisabledAtStart = !!minus.disabled
  plus.click()
  await sleep(500)
  out.after = val()
  // xterm 把字号落在哪个节点上各版本不同，这里把候选都取出来，由断言挑生效的那个
  out.xtermProbe = (() => {
    const root = document.querySelector('.xterm')
    if (!root) return null
    const screen = root.querySelector('.xterm-screen')
    const rows = root.querySelector('.xterm-rows')
    const pick = (el) => (el ? { inline: el.style.fontSize || '', computed: getComputedStyle(el).fontSize } : null)
    return { root: pick(root), screen: pick(screen), rows: pick(rows) }
  })()
  for (let i = 0; i < 12; i++) { if (plus.disabled) break; plus.click(); await sleep(120) }
  out.finalValue = val()
  out.plusDisabledAtMax = !!plus.disabled
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
      SMOKE_VIEW: '终端工作台',
      SMOKE_CLICK_MS: '3000',
      SMOKE_EVAL: PROBE,
      SMOKE_EVAL_MS: '6000',
      SMOKE_EXIT_MS: '22000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { out += d })
  await new Promise((resolve) => child.on('exit', resolve))

  const line = out.split('\n').find((l) => l.includes('[SMOKE][eval]'))
  console.log(out.split('\n').filter((l) => l.includes('[SMOKE][menu]') || l.includes('[SMOKE][click-err]')).join('\n'))
  if (!line) {
    console.log('  FAIL  探针未返回结果')
    console.log(out.split('\n').filter((l) => l.includes('[SMOKE]')).join('\n'))
    return
  }
  const r = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
  if (r.error) { console.log(`  FAIL  探针中止：${r.error}`); console.log(JSON.stringify(r, null, 1)); failed += 1; return }

  assert('F1 无窗格时不出现字号控件', r.initialBox === false, `实得 ${r.initialBox}`)
  assert('F2 添加窗格后出现字号控件', r.boxAfterAdd === true)
  assert('F2 初值取自 ui-prefs（预置 14）', r.before === 14, `实得 ${r.before}`)
  assert('F3 点 A＋ 字号 +1', r.after === r.before + 1, `${r.before} → ${r.after}`)
  // xterm 实际生效的字号：取候选节点里第一个等于期望值的位置做锚
  const probe = r.xtermProbe || {}
  const applied = ['rows', 'screen', 'root'].map((k) => probe[k]).find((p) => p && Number(String(p.computed).replace('px', '')) === r.after)
  assert('F3 xterm 实际字号随之变化', !!applied, `after=${r.after} probe=${JSON.stringify(probe)}`)
  assert('F5 到达上限后 A＋ 禁用', r.plusDisabledAtMax === true)

  const saved = JSON.parse(fs.readFileSync(PREFS, 'utf8'))
  assert('F4 字号落盘', saved.terminalFontSize === r.finalValue, `文件=${saved.terminalFontSize} 期望=${r.finalValue}`)
  assert('F4 未冲掉 sidebarCollapsed', saved.sidebarCollapsed === true, `文件=${saved.sidebarCollapsed}`)

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
}

run().catch((e) => { console.error(e); process.exit(1) }).finally(() => {
  console.log(`沙箱可清理：${SANDBOX}`)
  process.exit(failed ? 1 : 0)
})
