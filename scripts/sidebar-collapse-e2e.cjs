/**
 * E2E（真实 Electron + 沙箱主目录）：侧栏展开/收缩按钮
 *
 * 需求：侧边栏添加展开/收缩按钮，收缩后只显示图标。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   S1 侧栏顶部有收起按钮（真实 <button>，带可访问名），初始为展开态
 *   S2 点「收起」：侧栏宽度收窄到 64px；菜单项只剩图标——文案在 DOM 中消失、
 *      图标仍完整可见且横向居中；品牌名与分组标题让位（分组标题退化为细线）；
 *      页脚仍能看清在线状态点与版本号
 *   S3 收起后仍能认出每个图标：悬停菜单项弹出文字提示（工作台 / 部署 / 设置 …）
 *   S4 收起状态落盘 <userData>/ui-prefs.json；重启应用后仍是收起态（真持久化，非内存态）
 *   S5 再点「展开」：完整侧栏恢复（文案、品牌名、分组标题回来），落盘恢复 false
 *   S6 全程渲染层无报错
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 注意：运行期间窗口可见（截图时还会被置顶），请勿手动点它——落在收起按钮上的
 *       一次真实点击就会翻转状态，断言会如实报失败（不对失败做放宽处理）。
 * 用法：node scripts/sidebar-collapse-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-sidebar-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const PREFS_FILE = path.join(USER_DATA, 'ui-prefs.json')

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')

/** 收起/展开的宽度（与 styles.css 的 --sidebar-width / --sidebar-collapsed-width 一致） */
const EXPANDED_WIDTH = 216
const COLLAPSED_WIDTH = 64
/** 菜单项数量（工作台/项目/AI 助手/Harness/终端工作台/活动报告/一键填报/部署/扩展管理/设置） */
const MENU_COUNT = 10

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) } catch { return null }
}

function startInstance(env) {
  const child = spawn(process.execPath, [ELECTRON, '.'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stdout += d })
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })))
  return { child, stdout: () => stdout, done }
}

function killInstance(inst) {
  try { inst.child.kill() } catch { /* 已退出 */ }
}

function runSync(env, timeoutMs) {
  const inst = startInstance(env)
  const timer = setTimeout(() => killInstance(inst), timeoutMs)
  return inst.done.then((r) => { clearTimeout(timer); return r })
}

function parseEval(stdout) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes('[SMOKE][eval]')) {
      try { return JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim()) } catch { return null }
    }
  }
  return null
}

/** 渲染层探针：量一次当前侧栏形态（收起/展开两种形态都用这一份，便于逐项对比） */
const PROBE = `
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 可见性只看盒模型：祖先 display:none 时子元素的 computed display 仍是 block
  const shown = (sel) => {
    const el = document.querySelector(sel)
    return !!el && el.getBoundingClientRect().width > 0
  }
  const sidebar = document.querySelector('.app-sidebar')
  const items = [...document.querySelectorAll('.app-menu .el-menu-item')]
  const titles = [...document.querySelectorAll('.app-menu .el-menu-item-group__title')]
  const toggle = document.querySelector('.sidebar-toggle')
  const footerVersion = document.querySelector('.sidebar-version')
  const sb = sidebar.getBoundingClientRect()
  const iconBox = (item) => {
    const svg = item.querySelector('.el-icon svg')
    return svg ? svg.getBoundingClientRect() : null
  }
  return {
    width: Math.round(sb.width),
    shellCollapsed: document.querySelector('.app-shell').classList.contains('is-sidebar-collapsed'),
    menuCollapsed: document.querySelector('.app-menu').classList.contains('el-menu--collapse'),
    toggleTitle: norm(toggle && toggle.title),
    toggleTag: toggle ? toggle.tagName : '',
    toggleAria: toggle ? norm(toggle.getAttribute('aria-expanded')) : '',
    toggleBox: toggle ? { w: Math.round(toggle.getBoundingClientRect().width), h: Math.round(toggle.getBoundingClientRect().height) } : null,
    // 按钮右缘距侧栏右缘的距离（负数 = 被挤出侧栏）
    toggleRightInset: toggle ? Math.round(sb.right - toggle.getBoundingClientRect().right) : null,
    // 收起态下按钮应居中对齐（与菜单图标同一竖轴）
    toggleCenterOffset: toggle ? Math.round((toggle.getBoundingClientRect().left + toggle.getBoundingClientRect().width / 2) - (sb.left + sb.width / 2)) : null,
    brandNameShown: shown('.brand-name'),
    // 品牌名是否被截断（窄窗口断点下侧栏只有 198px，收起按钮不能把它挤到省略号）
    brandNameClipped: (() => {
      const el = document.querySelector('.brand-name')
      return el ? el.scrollWidth > el.clientWidth + 1 : null
    })(),
    brandNameScroll: document.querySelector('.brand-name')?.scrollWidth || 0,
    brandNameClient: document.querySelector('.brand-name')?.clientWidth || 0,
    brandText: norm(document.querySelector('.brand-name')?.textContent),
    menuCount: items.length,
    labels: items.map((e) => norm(e.textContent)),
    // 图标是否真的可见（有面积）并横向居中于侧栏
    icons: items.map((e) => {
      const b = iconBox(e)
      return b ? { w: Math.round(b.width), h: Math.round(b.height), centerOffset: Math.round((b.left + b.width / 2) - (sb.left + sb.width / 2)) } : null
    }),
    groupTitleFont: titles.map((e) => getComputedStyle(e).fontSize),
    groupTitleHeight: titles.map((e) => Math.round(e.getBoundingClientRect().height)),
    footerLabelShown: shown('.footer-label'),
    // 注意用 .version-num 取版本号：textContent 会把 display:none 的「· 更新日志」也算进来
    versionText: norm(document.querySelector('.version-num')?.textContent),
    versionLabelShown: shown('.version-label'),
    versionWidth: footerVersion ? Math.round(footerVersion.getBoundingClientRect().width) : 0,
    statusDotShown: !!document.querySelector('.status-dot') && document.querySelector('.status-dot').getBoundingClientRect().width > 0,
    // 收起态下页面主体是否拿回了空间（侧栏变窄应让内容区变宽）
    mainWidth: Math.round(document.querySelector('.shell-main').getBoundingClientRect().width),
  }
`

/** 悬停某个菜单项，返回弹出提示里的文字 */
const HOVER_PROBE = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const out = []
  const items = [...document.querySelectorAll('.app-menu .el-menu-item')]
  for (const idx of [0, 2, 9]) {
    const trigger = items[idx]?.querySelector('.el-menu-tooltip__trigger')
    if (!trigger) { out.push({ idx, trigger: false }); continue }
    trigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await sleep(400)
    // 只认可见的 tooltip 弹层：隐藏的旧弹层仍留在 DOM 里（textContent 有文字但不可见）
    const poppers = [...document.querySelectorAll('.el-popper[role="tooltip"]')]
      .filter((p) => p.getBoundingClientRect().width > 0 && getComputedStyle(p).visibility !== 'hidden')
    out.push({ idx, trigger: true, popper: poppers.length ? norm(poppers[poppers.length - 1].textContent) : '' })
    trigger.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }))
    await sleep(350)
  }
  return out
`

async function main() {
  console.log('=== 侧栏展开/收缩 E2E（S1–S6）===')

  // ---------- 场景 1：全新用户目录 → 默认展开 → 点收起 ----------
  console.log('\n— 场景 1：默认展开，点「收起」后只留图标 —')
  const EVAL1 = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const probe = () => { ${PROBE} }
    const before = probe()
    const toggle = document.querySelector('.sidebar-toggle')
    if (!toggle) return { fatal: '未找到收起按钮' }
    toggle.click()
    await sleep(700) // 等待宽度过渡结束
    const after = probe()
    const hover = await (async () => { ${HOVER_PROBE} })()
    const prefs = await window.gitReport.uiPrefsLoad()
    return { before, after, hover, prefs }
  })()`

  const r1 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    // 退出压到截图后不久：断言窗口越短，越不容易被桌面上的人为点击干扰
    SMOKE_EXIT_MS: '18000',
    SMOKE_EVAL_MS: '3000',
    SMOKE_EVAL: EVAL1,
    SMOKE_SCREENSHOT_PATH: path.join(SANDBOX, 'collapsed.png'),
    SMOKE_SHOT_MS: '12000',
  }, 90000)
  const ev1 = parseEval(r1.stdout)
  const out1 = r1.stdout || ''
  const b1 = ev1 && ev1.before
  const a1 = ev1 && ev1.after

  assert('S1 侧栏渲染出 10 个菜单项', b1 && b1.menuCount === MENU_COUNT, `menuCount=${b1 && b1.menuCount}`)
  assert('S1 初始为展开态（宽度 216 / 文案可见 / 品牌名可见）',
    b1 && b1.width === EXPANDED_WIDTH && b1.labels[0] === '工作台' && b1.brandNameShown === true,
    JSON.stringify(b1 && { width: b1.width, first: b1.labels[0], brand: b1.brandNameShown }))
  assert('S1 收起按钮是真实按钮且带可访问名（收起侧栏）',
    b1 && b1.toggleTag === 'BUTTON' && b1.toggleTitle === '收起侧栏' && b1.toggleAria === 'true',
    JSON.stringify(b1 && { tag: b1.toggleTag, title: b1.toggleTitle, aria: b1.toggleAria }))

  assert('S2 点收起后侧栏宽度变为 64px', a1 && a1.width === COLLAPSED_WIDTH, `width=${a1 && a1.width}`)
  assert('S2 外壳与 el-menu 同步进入收起态',
    a1 && a1.shellCollapsed === true && a1.menuCollapsed === true,
    JSON.stringify(a1 && { shell: a1.shellCollapsed, menu: a1.menuCollapsed }))
  assert('S2 菜单文案全部隐藏（10 项 textContent 均为空）',
    a1 && a1.labels.length === MENU_COUNT && a1.labels.every((t) => t === ''),
    `labels=${JSON.stringify(a1 && a1.labels)}`)
  assert('S2 图标仍完整可见（每项都有 17px 级图标）',
    a1 && a1.icons.every((i) => i && i.w >= 12 && i.h >= 12),
    `icons=${JSON.stringify(a1 && a1.icons)}`)
  assert('S2 图标横向居中于侧栏（误差 ≤ 1px）',
    a1 && a1.icons.every((i) => i && Math.abs(i.centerOffset) <= 1),
    `offset=${JSON.stringify(a1 && a1.icons.map((i) => i.centerOffset))}`)
  assert('S2 品牌名让位，收起按钮改名为「展开侧栏」并居中（与菜单图标同轴）',
    a1 && a1.brandNameShown === false && a1.toggleTitle === '展开侧栏' && a1.toggleAria === 'false' && Math.abs(a1.toggleCenterOffset) <= 1,
    JSON.stringify(a1 && { brand: a1.brandNameShown, title: a1.toggleTitle, aria: a1.toggleAria, offset: a1.toggleCenterOffset }))
  assert('S2 分组标题退化为细线（字号 0、高度 ≤ 1px）',
    a1 && a1.groupTitleFont.every((f) => f === '0px') && a1.groupTitleHeight.every((h) => h <= 1),
    `font=${JSON.stringify(a1 && a1.groupTitleFont)} h=${JSON.stringify(a1 && a1.groupTitleHeight)}`)
  assert('S2 页脚仍能看清状态点与版本号（「本地数据 / 更新日志」文字让位）',
    a1 && a1.statusDotShown === true && /^v\d+\.\d+\.\d+$/.test(a1.versionText) && a1.versionWidth <= COLLAPSED_WIDTH &&
      a1.footerLabelShown === false && a1.versionLabelShown === false,
    JSON.stringify(a1 && { dot: a1.statusDotShown, version: a1.versionText, w: a1.versionWidth, label: a1.footerLabelShown, vlabel: a1.versionLabelShown }))
  assert('S2 内容区随侧栏收窄让出空间', a1 && b1 && a1.mainWidth > b1.mainWidth + 100,
    `before=${b1 && b1.mainWidth} after=${a1 && a1.mainWidth}`)

  const hover1 = (ev1 && ev1.hover) || []
  assert('S3 收起后悬停菜单项弹出文字提示（工作台 / AI 助手 / 设置）',
    hover1.length === 3 && hover1.every((h) => h.trigger) &&
      hover1[0].popper === '工作台' && hover1[1].popper === 'AI 助手' && hover1[2].popper === '设置',
    `hover=${JSON.stringify(hover1)}`)

  const prefs1 = readPrefs()
  assert('S4 收起状态落盘 ui-prefs.json（sidebarCollapsed=true）',
    prefs1 && prefs1.sidebarCollapsed === true,
    `prefs=${JSON.stringify(prefs1)}`)
  assert('S4 渲染层读回的偏好一致', ev1 && ev1.prefs && ev1.prefs.sidebarCollapsed === true,
    `ipc=${JSON.stringify(ev1 && ev1.prefs)}`)
  assert('S6 收起过程无渲染层报错', !out1.includes('[SMOKE][renderer:error]'),
    `stdout 尾部=${out1.slice(-400)}`)

  // ---------- 场景 2：重启（同一用户目录）→ 仍是收起态 → 点展开 ----------
  console.log('\n— 场景 2：重启后按收起态恢复，点「展开」回到完整侧栏 —')
  const EVAL2 = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const probe = () => { ${PROBE} }
    const before = probe()
    const toggle = document.querySelector('.sidebar-toggle')
    toggle.click()
    await sleep(700)
    const after = probe()
    return { before, after }
  })()`
  const r2 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '18000',
    SMOKE_EVAL_MS: '3000',
    SMOKE_EVAL: EVAL2,
    SMOKE_SCREENSHOT_PATH: path.join(SANDBOX, 'expanded-again.png'),
    SMOKE_SHOT_MS: '12000',
  }, 90000)
  const ev2 = parseEval(r2.stdout)
  const out2 = r2.stdout || ''
  const b2 = ev2 && ev2.before
  const a2 = ev2 && ev2.after

  assert('S4 重启后仍为收起态（宽度 64、文案隐藏）',
    b2 && b2.width === COLLAPSED_WIDTH && b2.shellCollapsed === true && b2.labels.every((t) => t === ''),
    JSON.stringify(b2 && { width: b2.width, shell: b2.shellCollapsed, labels: b2.labels }))
  assert('S5 点展开后恢复 216px 完整侧栏',
    a2 && a2.width === EXPANDED_WIDTH && a2.shellCollapsed === false && a2.menuCollapsed === false,
    JSON.stringify(a2 && { width: a2.width, shell: a2.shellCollapsed, menu: a2.menuCollapsed }))
  assert('S5 文案与品牌名全部回归',
    a2 && a2.labels[0] === '工作台' && a2.labels[MENU_COUNT - 1] === '设置' && a2.brandNameShown === true && a2.brandText === '文须项目管理',
    JSON.stringify(a2 && { first: a2.labels[0], last: a2.labels[MENU_COUNT - 1], brand: a2.brandText }))
  assert('S5 页脚「本地数据 · 更新日志」文案回归', a2 && a2.footerLabelShown === true && a2.versionLabelShown === true,
    JSON.stringify(a2 && { label: a2.footerLabelShown, vlabel: a2.versionLabelShown }))
  assert('S5 分组标题恢复（字号 12px）',
    a2 && a2.groupTitleFont.every((f) => f === '12px'),
    `font=${JSON.stringify(a2 && a2.groupTitleFont)}`)
  assert('S5 收起按钮改回「收起侧栏」', a2 && a2.toggleTitle === '收起侧栏' && a2.toggleAria === 'true',
    JSON.stringify(a2 && { title: a2.toggleTitle, aria: a2.toggleAria }))
  assert('S5 展开状态落盘 ui-prefs.json（sidebarCollapsed=false）',
    (readPrefs() || {}).sidebarCollapsed === false,
    `prefs=${JSON.stringify(readPrefs())}`)
  assert('S6 展开过程无渲染层报错', !out2.includes('[SMOKE][renderer:error]'),
    `stdout 尾部=${out2.slice(-400)}`)

  // ---------- 场景 3：窄窗口（1180px 断点下侧栏 198px）不能被收起按钮挤坏 ----------
  console.log('\n— 场景 3：窄窗口下品牌名与收起按钮共存 —')
  const EVAL3 = `(() => { ${PROBE} })()`
  const r3 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA, // 上一场景结束时偏好为 false（展开）
    SMOKE_WIDTH: '1150',
    SMOKE_EXIT_MS: '15000',
    SMOKE_EVAL_MS: '3000',
    SMOKE_EVAL: EVAL3,
  }, 60000)
  const b3 = parseEval(r3.stdout)
  assert('S7 窄窗口侧栏宽度为 198px（断点生效）', b3 && b3.width === 198, `width=${b3 && b3.width}`)
  assert('S7 品牌名未被收起按钮挤到截断',
    b3 && b3.brandNameShown === true && b3.brandNameClipped === false,
    JSON.stringify(b3 && { shown: b3.brandNameShown, clipped: b3.brandNameClipped, scroll: b3.brandNameScroll, client: b3.brandNameClient }))
  assert('S7 收起按钮完整落在侧栏内（28px，未被挤出边界）',
    b3 && b3.toggleBox && b3.toggleBox.w === 28 && b3.toggleRightInset >= 0,
    JSON.stringify(b3 && { box: b3.toggleBox, inset: b3.toggleRightInset }))

  console.log(`\n截图：${SANDBOX}`)
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 运行异常：', e)
  process.exit(1)
})
