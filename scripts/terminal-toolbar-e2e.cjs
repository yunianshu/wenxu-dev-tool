/**
 * E2E：终端工作台工具栏（真实 Electron + 真实终端会话）
 *
 * 需求（2026-09-20）：
 *   1. 字号设置已移入「设置 → 界面」，终端工作台工具栏里的那组要删掉
 *   2. 「添加窗格」到「全部关闭」之间的按钮大小不一，需要统一
 * 需求（2026-09-24）：
 *   3. 终端工作台工具栏不再显示「字体」与「关闭全部」——字体入口只在设置页，
 *      关窗格用窗格自带的 ×（关闭全部会一次杀掉所有会话，误点代价大）
 *
 * 验收标准（源自需求）：
 *   T1 终端工作台工具栏只剩「新建终端」与分屏方式两组控件
 *   T2 工具栏内不再出现「字体」「关闭全部」按钮，也不再弹出终端字体对话框
 *   T3 工具栏内各控件高度一致
 *   T4 分屏方式各段等宽、纯图标且保留可访问名
 *   T5 字体仍在「设置 → 界面」可调，改完切回终端页即时生效（字体链路未被删除按钮破坏）
 *   T6 窗格自带的关闭按钮仍能关掉窗格并结束该会话（关闭能力仍在）
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
  // 探针里任何一步抛错都要把现场带回去（否则只剩一句 eval-err，查不出是哪一步）
  try {
  const menuItem = (i) => [...document.querySelectorAll('.el-menu-item')][i]
  /** 页面/窗格是异步挂载的：命中不到就轮询，别用固定 sleep 赌时序 */
  const waitFor = async (read, label, limit = 15000) => {
    const start = Date.now()
    for (;;) {
      const value = await read()
      if (value) return value
      if (Date.now() - start > limit) throw new Error('等待超时：' + label)
      await sleep(150)
    }
  }
  const readXterm = () => {
    const rows = document.querySelector('.xterm-rows')
    if (!rows) return null
    return Math.round(Number(getComputedStyle(rows).fontSize.replace('px', ''))) || null
  }
  const activeSessions = async () => ((await window.gitReport.terminalList()).sessions || []).filter((s) => !s.exited)
  out.contentBefore = (document.querySelector('.content-area > *') || {}).className || ''

  // 索引：0 工作台 / 1 项目 / 2 AI 助手 / 3 Harness / 4 终端工作台 / … / 9 设置
  menuItem(4)?.click()
  const toolbar = await waitFor(() => document.querySelector('.terminal-toolbar'), '终端工作台工具栏')
  out.toolbarPresent = true
  out.fontSizeControlInToolbar = !!document.querySelector('.terminal-font-size')

  // T1/T2：工具栏只剩「新建终端」+ 分屏方式；「字体」「关闭全部」连同对话框一起不再存在
  out.toolbarButtons = [...toolbar.querySelectorAll('button')].map((el) => el.textContent.trim())
  out.toolbarGroups = toolbar.querySelectorAll('.el-radio-group').length
  out.fontDialogPresent = [...document.querySelectorAll('.el-dialog')]
    .some((el) => el.querySelector('.el-dialog__title')?.textContent.trim() === '终端字体')
  out.fontComponentInWorkbench = !!document.querySelector('.terminal-toolbar .terminal-font-settings')

  const add = [...toolbar.querySelectorAll('button')].find((b) => b.textContent.includes('新建终端'))
  if (!add) { out.error = '未找到「新建终端」按钮'; return out }
  add.click()
  const item = await waitFor(() => [...document.querySelectorAll('.el-dropdown-menu__item')]
    .find((el) => !el.classList.contains('is-disabled')), '新建终端下拉里的项目')
  item.click()
  await waitFor(() => document.querySelectorAll('.terminal-grid .term-pane').length === 1
    && document.querySelector('.xterm-rows'), '窗格与会话渲染')

  // T3：工具栏里各控件等高（分屏分段控件的边框在 .el-radio-group 外壳上，量外壳）
  const liveToolbar = document.querySelector('.terminal-toolbar')
  out.heights = [...liveToolbar.querySelectorAll('.el-button, .el-radio-group')]
    .map((el) => Math.round(el.getBoundingClientRect().height))
  // T4a：分屏方式各段等宽（原先按文字长短排成参差）
  out.radioWidths = [...liveToolbar.querySelectorAll('.el-radio-button__inner')]
    .map((el) => Math.round(el.getBoundingClientRect().width))
  // T4b：改为纯图标 + hover 提示后，按钮内不应再有可见文字
  out.radioTexts = [...liveToolbar.querySelectorAll('.el-radio-button__inner')].map((el) => el.textContent.trim())
  // T4c：分段控件边框可见性。EP 2.9 给每段单独画 outline（上下单条 1px 浅灰看不见，
  //      竖线两条叠加显得深），已改为整组 border 外框 + 段间 inset 分隔线。
  //      外框必须画在 group 自身 border box 内：顶栏插槽 overflow:auto hidden 会裁掉
  //      组外扩的上下边（box-shadow/outline 方案实测翻车）。
  //      配色随工作区深色改版（2026-09-24 复核）：按「线段与底色有对比」断言，
  //      不写死某套配色，改版换色时不用再改测试。
  out.radioBorder = (() => {
    const group = liveToolbar.querySelector('.el-radio-group')
    const inners = [...liveToolbar.querySelectorAll('.el-radio-button__inner')]
    if (!group || !inners.length) return null
    const cs = getComputedStyle(group)
    // 未选中段的底色是常态底色（首段默认选中，底色是高亮色，不能拿来比对比度）
    const base = inners[inners.length - 1]
    // 外框落在顶栏底色上：往上找第一个不透明祖先，量它到底有多深
    let host = group.parentElement
    let hostBg = 'rgba(0, 0, 0, 0)'
    while (host && hostBg === 'rgba(0, 0, 0, 0)') {
      hostBg = getComputedStyle(host).backgroundColor
      host = host.parentElement
    }
    return {
      border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
      borderColor: cs.borderTopColor,
      innerBg: getComputedStyle(base).backgroundColor,
      hostBg,
      outlineStyle: getComputedStyle(inners[0]).outlineStyle,
      secondInnerShadow: inners[1] ? getComputedStyle(inners[1]).boxShadow : null,
    }
  })()
  out.radioIconCount = liveToolbar.querySelectorAll('.el-radio-button__inner .grid-icon').length
  out.radioAriaLabels = [...liveToolbar.querySelectorAll('.el-radio-button__inner')]
    .map((el) => el.closest('label')?.getAttribute('aria-label') || '')
  // T4d：选中段不是实心主色（否则与左侧主按钮撞成两个绿块）
  out.checkedBg = (() => {
    const el = liveToolbar.querySelector('.el-radio-button__original-radio:checked + .el-radio-button__inner')
    return el ? getComputedStyle(el).backgroundColor : null
  })()
  out.xtermBefore = readXterm()

  // T5：切到设置页调字号，再切回来
  menuItem(9)?.click()
  const ctrl = await waitFor(async () => {
    if (!document.querySelector('.settings-sections')) return null
    const tab = [...document.querySelectorAll('.settings-sections .el-segmented__item')]
      .find((e) => e.textContent.trim() === '界面')
    tab?.click()
    await sleep(300)
    return document.querySelector('.settings-ui .font-size-control')
  }, '设置页界面分区的字号控件')
  const val = () => Number(ctrl.querySelector('.font-size-value').textContent)
  out.settingsBefore = val()
  ;[...ctrl.querySelectorAll('button')].find((b) => b.textContent.includes('＋')).click()
  await sleep(500)
  out.settingsAfter = val()

  menuItem(4)?.click()
  out.xtermAfter = await waitFor(() => {
    const size = readXterm()
    return size === out.settingsAfter ? size : null
  }, '窗格按新字号 ' + out.settingsAfter + ' 渲染')

  // T6 诊断（不做断言）：切页回来的窗格立刻关闭——记下关闭事件与存活会话，
  //   用于区分「关闭路径坏了」与「切页后窗格没认回自己的会话（关掉了空 id）」
  await waitFor(async () => (await activeSessions()).length === 1, '切页回来后窗格会话就绪')
  const sessionBefore = ((await window.gitReport.terminalList()).sessions || [])[0] || {}
  out.sessionBeforePageSwitchClose = { id: sessionBefore.id, paneId: sessionBefore.paneId, pid: sessionBefore.pid }
  const closedEvents = []
  window.gitReport.onTerminalClosed((payload) => closedEvents.push(payload?.sessionId || ''))
  const firstClose = await waitFor(() => [...document.querySelectorAll('.terminal-grid .term-pane')][0]
    ?.querySelector('button[title="关闭这个窗格"]'), '切页回来的窗格标题栏关闭按钮')
  firstClose.click()
  await waitFor(() => document.querySelectorAll('.terminal-grid .term-pane').length === 0, '切页回来的窗格关闭')
  await sleep(2500)
  out.closedEventsOnPageSwitchClose = closedEvents.slice()
  out.leftoverAfterPageSwitchClose = ((await window.gitReport.terminalList()).sessions || [])
    .map((s) => ({ id: s.id, paneId: s.paneId, pid: s.pid, exited: s.exited }))

  // T6 断言：刚新建、未切页的窗格，点自带的 × 后它名下的会话必须结束
  //   （按 paneId 判定，而不是数会话总数：上一步的残留不该影响这一步的结论）
  const paneIdsBefore = new Set(((await window.gitReport.terminalList()).sessions || []).map((s) => s.paneId))
  const addAgain = [...document.querySelectorAll('.terminal-toolbar button')]
    .find((b) => b.textContent.includes('新建终端'))
  addAgain.click()
  const itemAgain = await waitFor(() => [...document.querySelectorAll('.el-dropdown-menu__item')]
    .find((el) => !el.classList.contains('is-disabled')), '再次新建终端的下拉项目')
  itemAgain.click()
  const addedSession = await waitFor(async () => {
    const list = (await window.gitReport.terminalList()).sessions || []
    return list.find((s) => !paneIdsBefore.has(s.paneId)) || null
  }, '新建窗格的会话')
  out.addedPaneId = addedSession.paneId
  out.addedSessionId = addedSession.id
  out.panesBeforeClose = document.querySelectorAll('.terminal-grid .term-pane').length
  out.sessionsBeforeClose = (await activeSessions()).length
  const closeBtn = await waitFor(() => [...document.querySelectorAll('.terminal-grid .term-pane')][0]
    ?.querySelector('button[title="关闭这个窗格"]'), '新窗格标题栏的关闭按钮')
  const markBeforeNewClose = closedEvents.length
  closeBtn.click()
  await waitFor(() => document.querySelectorAll('.terminal-grid .term-pane').length === 0, '新窗格关闭')
  await sleep(3000)
  out.closedEventsOnNewPaneClose = closedEvents.slice(markBeforeNewClose)
  out.sessionsAfterNewPaneClose = ((await window.gitReport.terminalList()).sessions || [])
    .map((s) => ({ id: s.id, paneId: s.paneId, pid: s.pid, exited: s.exited }))
  out.sessionsAfterClose = out.sessionsAfterNewPaneClose.length
  // 断言点：关掉那个窗格后，它名下的会话必须结束（按 paneId 判定，不受其他残留干扰）
  out.closedPaneSessionEnded = out.closedEventsOnNewPaneClose.includes(addedSession.id)
    && !out.sessionsAfterNewPaneClose.some((s) => s.paneId === addedSession.paneId)
  out.panesAfterClose = document.querySelectorAll('.terminal-grid .term-pane').length
  } catch (error) { out.error = error.message }
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
      SMOKE_EXIT_MS: '40000',
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
  if (!line) { console.log('  FAIL  探针未返回'); console.log(out.split('\n').slice(-25).join('\n')); return }
  const r = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
  if (r.error) { console.log(`  FAIL  ${r.error}`); console.log(JSON.stringify(r)); failed += 1; return }

  assert('T1 工具栏存在', r.toolbarPresent === true)
  assert('T1 工具栏里已无字号控件', r.fontSizeControlInToolbar === false, `实得 ${r.fontSizeControlInToolbar}`)
  assert('T1 工具栏只剩新建终端与分屏方式', r.toolbarGroups === 1
    && (r.toolbarButtons || []).length === 1 && r.toolbarButtons[0] === '新建终端', JSON.stringify(r.toolbarButtons))
  assert('T2 工具栏不再有「字体」按钮', !(r.toolbarButtons || []).includes('字体'), JSON.stringify(r.toolbarButtons))
  assert('T2 工具栏不再有「关闭全部」按钮', !(r.toolbarButtons || []).includes('关闭全部'), JSON.stringify(r.toolbarButtons))
  assert('T2 工作台不再弹出终端字体对话框', r.fontDialogPresent === false, `实得 ${r.fontDialogPresent}`)
  assert('T2 工作台内没有字体设置组件', r.fontComponentInWorkbench === false, `实得 ${r.fontComponentInWorkbench}`)
  const hs = r.heights || []
  assert('T3 两个控件都量到高度', hs.length === 2, `实得 ${JSON.stringify(hs)}`)
  assert('T3 各控件等高', new Set(hs).size === 1, `高度 ${JSON.stringify(hs)}`)
  const ws = r.radioWidths || []
  assert('T4 分屏方式各段等宽', ws.length >= 5 && new Set(ws).size === 1, `宽度 ${JSON.stringify(ws)}`)
  assert('T4 选中段非实心主色', r.checkedBg !== 'rgb(14, 122, 109)', `实得 ${r.checkedBg}`)
  assert('T4 按钮内无文字（纯图标）', (r.radioTexts || []).every((t) => t === ''), JSON.stringify(r.radioTexts))
  assert('T4 每段都画出图标', r.radioIconCount === 5, `实得 ${r.radioIconCount}`)
  assert('T4 保留可访问名（hover 提示的语义等价）',
    (r.radioAriaLabels || []).filter(Boolean).length === 5, JSON.stringify(r.radioAriaLabels))
  console.log(`  INFO  分段控件边框：${JSON.stringify(r.radioBorder)}`)
  const rb = r.radioBorder || {}
  /** rgb/rgba → 通道和；用于判断 1px 线段相对底色是否看得见 */
  const channels = (color) => {
    const nums = String(color || '').match(/[\d.]+/g)
    if (!nums || /^rgba?\(0, 0, 0, 0\)$/.test(String(color))) return null
    return Number(nums[0]) + Number(nums[1]) + Number(nums[2])
  }
  const borderTone = channels(rb.borderColor)
  const bgTone = channels(rb.innerBg)
  const hostTone = channels(rb.hostBg)
  assert('T4 分段控件整组外框 1px 实线且与底色有对比', typeof rb.border === 'string'
    && rb.border.startsWith('1px solid')
    && borderTone !== null && bgTone !== null && borderTone - bgTone >= 30
    && (hostTone === null || borderTone - hostTone >= 10),
    `边框 ${rb.borderColor} / 段底色 ${rb.innerBg} / 顶栏底色 ${rb.hostBg}`)
  assert('T4 不再依赖每段 outline 画边框', rb.outlineStyle === 'none', JSON.stringify(rb))
  const sepTone = channels(String(rb.secondInnerShadow || '').split(') ')[0] + ')')
  assert('T4 段间分隔线可见（inset 1px，与外框同色）',
    /inset/.test(String(rb.secondInnerShadow)) && sepTone !== null
    && Math.abs(sepTone - (borderTone ?? sepTone)) <= 6, JSON.stringify(rb))
  assert('T5 改动前窗格用偏好里的 14', r.xtermBefore === 14, `实得 ${r.xtermBefore}`)
  assert('T5 设置页 +1 后为 15', r.settingsAfter === r.settingsBefore + 1, `${r.settingsBefore} → ${r.settingsAfter}`)
  assert('T5 回到终端页窗格按新字号渲染', r.xtermAfter === r.settingsAfter, `xterm=${r.xtermAfter} 期望=${r.settingsAfter}`)
  assert('T6 关闭前有窗格与会话', r.panesBeforeClose === 1 && r.sessionsBeforeClose === 1,
    `窗格=${r.panesBeforeClose} 会话=${r.sessionsBeforeClose}`)
  assert('T6 窗格 × 关掉窗格并结束该会话', r.closedPaneSessionEnded === true && r.panesAfterClose === 0,
    '错误：被关窗格 ' + r.addedPaneId + ' 的会话仍在；剩余会话 ' + JSON.stringify(r.leftoverAfterPageSwitchClose))
  console.log('  INFO  切页回来的窗格关闭前会话：' + JSON.stringify(r.sessionBeforePageSwitchClose))
  console.log('  INFO  该次关闭收到的关闭事件：' + JSON.stringify(r.closedEventsOnPageSwitchClose))
  console.log('  INFO  该次关闭后仍存活的会话：' + JSON.stringify(r.leftoverAfterPageSwitchClose))
  console.log('  INFO  新建窗格会话：' + r.addedPaneId + ' / ' + r.addedSessionId)
  console.log('  INFO  关闭该窗格收到的关闭事件：' + JSON.stringify(r.closedEventsOnNewPaneClose))
  console.log('  INFO  关闭该窗格后剩余的会话：' + JSON.stringify(r.sessionsAfterNewPaneClose))

  const saved = JSON.parse(fs.readFileSync(PREFS, 'utf8'))
  assert('T5 字号已落盘', saved.terminalFontSize === r.settingsAfter, `文件=${saved.terminalFontSize}`)

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
}

run().catch((e) => { console.error(e); process.exit(1) }).finally(() => {
  console.log(`沙箱可清理：${SANDBOX}`)
  process.exit(failed ? 1 : 0)
})
