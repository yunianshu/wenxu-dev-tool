/**
 * 端到端验证：Harness 沉浸全屏（内嵌页铺满整屏）
 *
 * 需求：内置 Harness 会话界面此前被侧栏、顶栏、页头、状态栏挤压，需要能全屏显示。
 *
 * 验收标准（源自需求「全屏显示，不再被压缩空间」）：
 *   F1 进入 Harness 视图有「全屏」入口，点击后窗口进入全屏
 *   F2 全屏时应用外壳让位：侧栏、顶栏、页头、状态栏全部隐藏
 *   F3 webview 铺满整个窗口（宽高与窗口内容区一致，无留白）
 *   F4 全屏时仍有退出入口（悬浮条），点击后恢复窗口与全部外壳
 *   F5 全屏偏好持久化（config.harness.fullscreen 与窗口状态一致）
 *   F6 焦点在 dsh 页面内按 Esc 也能退出全屏（guest 按键不冒泡到宿主页，主进程监听）
 *   F7 全屏悬浮条渲染在 webview 之上（截图人工核对）
 *
 * 用法：node scripts/harness-fullscreen-e2e.cjs              # 两个阶段都跑
 *      node scripts/harness-fullscreen-e2e.cjs --phase=a     # 仅 UI 进出全屏
 *      node scripts/harness-fullscreen-e2e.cjs --phase=b     # 仅 guest 内 Esc 退出
 *      E2E_EXE=<win-unpacked exe> node scripts/harness-fullscreen-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const EXE = process.env.EXE || process.env.E2E_EXE || ''
const label = EXE ? '打包产物' : '开发版'
const phaseArg = (() => {
  const i = process.argv.indexOf('--phase')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : ''
})()

/** 阶段 A：全屏入口 → 外壳让位 → webview 铺满 → 悬浮条退出 → 偏好持久化 */
const EVAL_A = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const r = {}

  const menu = [...document.querySelectorAll('.el-menu-item')]
  const item = menu.find((e) => e.textContent.trim() === 'DeepSeek Harness')
  r.menuFound = !!item
  if (item) item.click()

  // 等 webview 真正挂载（打包产物首跑要先解包内置运行时）
  let wv = null
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const el = q('webview')
    if (el && typeof el.getWebContentsId === 'function') {
      try { el.getWebContentsId(); wv = el; break } catch (e) { /* 尚未附加 */ }
    }
    await sleep(500)
  }
  r.webviewAttached = !!wv
  if (!wv) return r

  const chrome = () => ({
    sidebar: !!q('.app-sidebar'),
    topbar: !!q('.app-topbar'),
    header: !!q('#app-topbar-slot .topbar-page-title'),
    footer: !!q('.harness-footer'),
  })
  r.before = chrome()
  r.fsBefore = await window.gitReport.winIsFullScreen()

  // F1：页头「全屏」按钮
  const fsBtn = [...document.querySelectorAll('#app-topbar-slot button')].find((b) => b.textContent.includes('全屏'))
  r.fsButtonFound = !!fsBtn
  if (fsBtn) fsBtn.click()
  await sleep(1800)

  // F1/F2/F3/F4：窗口全屏、外壳让位、webview 铺满、退出入口在场
  r.fsAfterEnter = await window.gitReport.winIsFullScreen()
  r.during = chrome()
  r.immersiveClass = !!q('.app-shell.is-immersive')
  r.immersiveBar = !!q('.harness-immersive-bar')
  r.exitButtonFound = (q('.harness-immersive-bar button') || {}).textContent || ''
  const rect = wv.getBoundingClientRect()
  r.frame = { w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.left), y: Math.round(rect.top) }
  r.viewport = { w: window.innerWidth, h: window.innerHeight }

  // F5：偏好写回配置
  await sleep(600)
  const cfg = await window.gitReport.configLoad()
  r.prefWhileFullscreen = !!(cfg && cfg.harness && cfg.harness.fullscreen)

  // F4：悬浮条退出
  const exitBtn = q('.harness-immersive-bar button')
  if (exitBtn) exitBtn.click()
  await sleep(1800)
  r.fsAfterExit = await window.gitReport.winIsFullScreen()
  r.afterExit = chrome()
  const cfg2 = await window.gitReport.configLoad()
  r.prefAfterExit = !!(cfg2 && cfg2.harness && cfg2.harness.fullscreen)

  // 留一个全屏状态给截图（F7 人工核对悬浮条在 webview 之上）
  const fsBtn2 = [...document.querySelectorAll('#app-topbar-slot button')].find((b) => b.textContent.includes('全屏'))
  if (fsBtn2) fsBtn2.click()
  await sleep(1200)
  r.fsForShot = await window.gitReport.winIsFullScreen()
  return r
})()`

/** 阶段 B：焦点在 dsh 页面内按 Esc 退出全屏（主进程向 guest 注入 Esc） */
const EVAL_B = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const r = {}

  const menu = [...document.querySelectorAll('.el-menu-item')]
  const item = menu.find((e) => e.textContent.trim() === 'DeepSeek Harness')
  if (item) item.click()

  let wv = null
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const el = q('webview')
    if (el && typeof el.getWebContentsId === 'function') {
      try { el.getWebContentsId(); wv = el; break } catch (e) { /* 尚未附加 */ }
    }
    await sleep(500)
  }
  r.webviewAttached = !!wv
  if (!wv) return r

  const fsBtn = [...document.querySelectorAll('#app-topbar-slot button')].find((b) => b.textContent.includes('全屏'))
  if (fsBtn) fsBtn.click()
  await sleep(1800)
  r.entered = await window.gitReport.winIsFullScreen()

  // 等待主进程注入的 Esc（SMOKE_GUEST_KEY_MS 起周期注入）把全屏关掉
  const t1 = Date.now()
  while (Date.now() - t1 < 100000) {
    if (!(await window.gitReport.winIsFullScreen())) { r.escExited = true; break }
    await sleep(500)
  }
  r.escExited = !!r.escExited
  r.escWaitMs = Date.now() - t1
  await sleep(1200)
  r.afterEsc = {
    sidebar: !!q('.app-sidebar'),
    topbar: !!q('.app-topbar'),
    header: !!q('#app-topbar-slot .topbar-page-title'),
    footer: !!q('.harness-footer'),
  }
  // Esc 退出同样要记下用户意图（否则下次进入又会自动全屏）
  const cfg = await window.gitReport.configLoad()
  r.prefAfterEsc = !!(cfg && cfg.harness && cfg.harness.fullscreen)
  return r
})()`

/** 阶段 C：全屏偏好跨启动生效（第一次全屏后直接退出应用，第二次进入 Harness 自动铺满） */
const EVAL_C_SET = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const r = {}
  const menu = [...document.querySelectorAll('.el-menu-item')]
  const item = menu.find((e) => e.textContent.trim() === 'DeepSeek Harness')
  if (item) item.click()
  let wv = null
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const el = q('webview')
    if (el && typeof el.getWebContentsId === 'function') {
      try { el.getWebContentsId(); wv = el; break } catch (e) { /* 尚未附加 */ }
    }
    await sleep(500)
  }
  r.webviewAttached = !!wv
  const fsBtn = [...document.querySelectorAll('#app-topbar-slot button')].find((b) => b.textContent.includes('全屏'))
  if (fsBtn) fsBtn.click()
  await sleep(1800)
  r.entered = await window.gitReport.winIsFullScreen()
  const cfg = await window.gitReport.configLoad()
  r.prefSaved = !!(cfg && cfg.harness && cfg.harness.fullscreen)
  return r
})()`

const EVAL_C_CHECK = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const r = {}
  const menu = [...document.querySelectorAll('.el-menu-item')]
  const item = menu.find((e) => e.textContent.trim() === 'DeepSeek Harness')
  if (item) item.click()
  let wv = null
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const el = q('webview')
    if (el && typeof el.getWebContentsId === 'function') {
      try { el.getWebContentsId(); wv = el; break } catch (e) { /* 尚未附加 */ }
    }
    await sleep(500)
  }
  r.webviewAttached = !!wv
  // 不点任何按钮：进入视图就应因上次的偏好自动全屏
  await sleep(3000)
  r.autoFullscreen = await window.gitReport.winIsFullScreen()
  r.sidebarHidden = !q('.app-sidebar')
  return r
})()`

/** 启动一次应用跑给定 EVAL，返回渲染层结果（取不到返回 null） */
function launch(evalCode, extraEnv, userData) {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: userData,
    SMOKE_HARNESS: '1',
    SMOKE_EXIT_MS: '200000',
    SMOKE_EVAL: evalCode,
    SMOKE_EVAL_MS: '1000',
    SMOKE_CLICK_MS: '600000', // 禁用冒烟默认切页，交由 EVAL 自己点击
    ...extraEnv,
  }
  const p = spawnSync(
    EXE || process.execPath,
    EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'],
    { cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: EXE ? 330000 : 260000, env },
  )
  const stdout = String(p.stdout || '')
  // 关键冒烟行始终打印：EVAL 抛错/截图异常时不必靠猜（这些行会被后续输出挤出尾部）
  for (const l of stdout.split('\n')) {
    if (/\[SMOKE\]\[(eval-err|screenshot|screenshot-err|renderer:error)\]/.test(l)) console.log('  ', l.trim())
  }
  const line = stdout.split('\n').find((l) => l.includes('[SMOKE][eval]'))
  if (!line) {
    console.log('未取到渲染层结果，stdout 尾部：')
    console.log(stdout.slice(-2500))
    return null
  }
  const r = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
  console.log('  渲染层结果:', JSON.stringify(r))
  return r
}

function runPhase(phase) {
  const userData = path.join(os.tmpdir(), `pm-harness-fs-${phase}-${Date.now()}`)
  console.log(`--- 阶段 ${phase.toUpperCase()}（${label}） ---`)

  let failed = 0
  const assert = (name, cond, detail) => {
    if (cond) console.log(`  PASS  ${name}`)
    else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
  }

  // 阶段 C：两次启动共享 userData —— 第一次留下全屏偏好，第二次进入即自动铺满
  if (phase === 'c') {
    const first = launch(EVAL_C_SET, {}, userData)
    if (!first) return { failed: failed + 1 }
    assert('F8 首次全屏并写入偏好', first.entered === true && first.prefSaved === true,
      `entered=${first.entered} prefSaved=${first.prefSaved}`)
    const second = launch(EVAL_C_CHECK, {}, userData)
    if (!second) return { failed: failed + 1 }
    assert('F8 重启后进入 Harness 自动全屏（偏好跨启动生效）',
      second.webviewAttached === true && second.autoFullscreen === true && second.sidebarHidden === true,
      `auto=${second.autoFullscreen} sidebarHidden=${second.sidebarHidden}`)
    return { failed }
  }

  const extraEnv = phase === 'b'
    // guest 内 Esc 注入：webview 就绪最迟约 60 秒，60 秒起每 5 秒注入一次，
    // 保证 EVAL 的等待阶段一定能收到（早于等待阶段收到同样证明该链路有效）
    ? { SMOKE_GUEST_KEY: 'Escape', SMOKE_GUEST_KEY_MS: '60000', SMOKE_GUEST_KEY_TIMES: '9' }
    // F7：全屏状态下截图，人工核对悬浮条压在 webview 之上
    : { SMOKE_SCREENSHOT_PATH: path.join(ROOT, 'output', `harness-fullscreen-${EXE ? 'packed' : 'dev'}.png`), SMOKE_SHOT_MS: '55000' }
  const r = launch(phase === 'b' ? EVAL_B : EVAL_A, extraEnv, userData)
  if (!r) return { failed: failed + 1 }

  if (phase === 'b') {
    assert('F6 进入全屏成功（前置条件）', r.entered === true, `entered=${r.entered}`)
    assert('F6 焦点在 dsh 页面内按 Esc 退出全屏', r.escExited === true, `escExited=${r.escExited} wait=${r.escWaitMs}ms`)
    assert('F6 Esc 退出后应用外壳恢复', !!r.afterEsc && r.afterEsc.sidebar && r.afterEsc.topbar && r.afterEsc.header && r.afterEsc.footer,
      JSON.stringify(r.afterEsc))
    assert('F6 Esc 退出同样写回偏好（下次进入不自动全屏）', r.prefAfterEsc === false, `prefAfterEsc=${r.prefAfterEsc}`)
    return { failed }
  }

  const full = r.during || {}
  assert('F1 Harness 页头有「全屏」入口且点击后窗口全屏',
    r.menuFound === true && r.fsButtonFound === true && r.fsBefore === false && r.fsAfterEnter === true,
    `menu=${r.menuFound} btn=${r.fsButtonFound} before=${r.fsBefore} after=${r.fsAfterEnter}`)
  assert('F2 全屏时侧栏/顶栏/页头/状态栏全部隐藏',
    r.immersiveClass === true && !full.sidebar && !full.topbar && !full.header && !full.footer,
    `immersive=${r.immersiveClass} during=${JSON.stringify(full)}`)
  const fr = r.frame || {}
  const vp = r.viewport || {}
  assert('F3 webview 铺满窗口（无留白）',
    fr.x === 0 && fr.y === 0 && Math.abs((fr.w || 0) - (vp.w || 0)) <= 2 && Math.abs((fr.h || 0) - (vp.h || 0)) <= 2,
    `frame=${JSON.stringify(fr)} viewport=${JSON.stringify(vp)}`)
  assert('F4 全屏时有退出入口且点击后恢复窗口与外壳',
    r.immersiveBar === true && /退出全屏/.test(r.exitButtonFound || '') && r.fsAfterExit === false
      && !!r.afterExit && r.afterExit.sidebar && r.afterExit.topbar && r.afterExit.header && r.afterExit.footer,
    `bar=${r.immersiveBar} btn="${r.exitButtonFound}" fsAfterExit=${r.fsAfterExit} after=${JSON.stringify(r.afterExit)}`)
  assert('F5 全屏偏好持久化（进入写 true / 退出写 false）',
    r.prefWhileFullscreen === true && r.prefAfterExit === false,
    `whileFullscreen=${r.prefWhileFullscreen} afterExit=${r.prefAfterExit}`)
  assert('F7 截图前处于全屏（供人工核对悬浮条层级）', r.fsForShot === true, `fsForShot=${r.fsForShot}`)
  return { failed }
}

const phases = phaseArg ? [phaseArg] : ['a', 'b', 'c']
console.log(`=== Harness 沉浸全屏 E2E（${label}） ===`)
let failed = 0
for (const phase of phases) failed += runPhase(phase).failed
console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
process.exit(failed ? 1 : 0)
