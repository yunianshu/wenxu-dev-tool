/**
 * E2E（真实 Electron + 沙箱主目录）：发布卡「线上版本」在查不到服务器时按记录回退
 *
 * 需求：线上版本此前只来自实时 SSH 查询（releases 目录 + current 软链/CURRENT 文件）与发布事件，
 *       服务器查不到就永远显示「未知」——即便本地有成功发布记录、服务器 releases 里有版本。
 *       用户要求：有记录就要能查到版本。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   B1 本地有该环境最近一次成功发布记录、且从未向服务器查询过 → 发布卡显示该版本并标注「按发布记录」
 *   B2 记录按环境过滤：甲环境有成功记录、乙环境无记录 → 切到乙显示「未知」（不串用甲）
 *   B3 只认成功记录：某环境最近一条是失败记录 → 取更早的成功记录版本
 *   B4 实时查询失败（服务器不可达）不影响回退展示，且给出错误提示
 *   B5 切换项目不残留上一个项目的线上版本，并加载新项目自己的记录
 *   B6 发布确认弹窗的「当前线上版本」同样使用回退值
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-online-version-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-deploy-ver-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const PROJECT_DIR = path.join(SANDBOX, 'alpha-src')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')
const HISTORY_FILE = path.join(USER_DATA, 'deploy-history.json')

const P_ALPHA = 'dp_online_alpha'
const P_BETA = 'dp_online_beta'

function mkTarget(id, name) {
  return {
    id,
    name,
    // 127.0.0.1:59999 无监听：实时查询必然失败，用来验证「查询失败不破坏回退展示」
    server: { host: '127.0.0.1', port: 59999, username: 'root', authType: 'password', keyPath: '' },
    remotePath: `/opt/apps/${id}`,
    health: { enabled: false, url: '', timeout: 90, interval: 3 },
    dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
  }
}

function mkRecord({ id, projectId, projectName, targetId, targetName, version, status, startedAt, message }) {
  return {
    id, projectId, projectName, targetId, targetName, type: 'deploy',
    version, oldVersion: '', status,
    startedAt, finishedAt: startedAt + 1000, durationMs: 1000,
    host: '127.0.0.1:59999', remotePath: `/opt/apps/${targetId}`, message: message || '', logFile: '', stages: {},
  }
}

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(PROJECT_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, 'docker-compose.yml'), 'services:\n  app:\n    image: nginx\n')

  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    projects: [
      {
        id: P_ALPHA, name: 'Alpha项目', localPath: PROJECT_DIR,
        version: { strategy: 'manual', manual: '1.2.3' },
        composeFile: 'docker-compose.yml',
        deploy: { backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '', dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true, keepReleases: 10, keepBackups: 10 },
        targets: [mkTarget(`${P_ALPHA}_t1`, '环境甲'), mkTarget(`${P_ALPHA}_t2`, '环境乙')],
      },
      {
        id: P_BETA, name: 'Beta项目', localPath: PROJECT_DIR,
        version: { strategy: 'manual', manual: '2.0.0' },
        composeFile: 'docker-compose.yml',
        targets: [mkTarget(`${P_BETA}_t1`, '环境甲')],
      },
    ],
  }, null, 2))

  // 甲环境：成功 1.2.3（较早）→ 失败 1.2.4（最新，必须跳过）；乙环境：无记录
  const base = Date.now()
  fs.writeFileSync(HISTORY_FILE, JSON.stringify({
    records: [
      mkRecord({ id: 'h_a1', projectId: P_ALPHA, projectName: 'Alpha项目', targetId: `${P_ALPHA}_t1`, targetName: '环境甲', version: '1.2.3', status: 'success', startedAt: base - 3 * 3600e3 }),
      mkRecord({ id: 'h_a2', projectId: P_ALPHA, projectName: 'Alpha项目', targetId: `${P_ALPHA}_t1`, targetName: '环境甲', version: '1.2.4', status: 'failed', startedAt: base - 2 * 3600e3, message: '健康检查失败' }),
      mkRecord({ id: 'h_b1', projectId: P_BETA, projectName: 'Beta项目', targetId: `${P_BETA}_t1`, targetName: '环境甲', version: '9.9.9', status: 'success', startedAt: base - 3600e3 }),
    ],
  }, null, 2))
}

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const q = (s) => document.querySelector(s)
  const waitFor = async (fn, ms = 8000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
    return false
  }
  const viewReady = (ms = 20000) => waitFor(() => q('.deploy-page') && q('.bar-card .el-select') && q('.ver-info'), ms, 150)
  const onlineText = () => norm(q('.ver-info')?.textContent)
  const waitOnline = async (expect, ms = 10000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (onlineText().includes(expect)) return true; await sleep(150) }
    return false
  }
  const selectBy = async (scope, name) => {
    const sel = q(scope); if (!sel) return 'no-select'
    const trigger = sel.querySelector('.el-select__wrapper') || sel
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    let opt = null
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      opt = [...document.querySelectorAll('.el-select-dropdown__item')].find((x) => norm(x.textContent) === name && x.offsetParent !== null)
      if (opt) break
      await sleep(100)
    }
    if (!opt) return 'no-option'
    opt.click()
    await sleep(400)
    return 'ok'
  }
  const btnByText = (scope, text) => [...document.querySelectorAll(scope + ' button')].find((b) => norm(b.textContent).includes(text))
  const messageBox = () => {
    const box = q('.el-message-box')
    if (!box) return null
    const rect = box.getBoundingClientRect()
    return rect.width > 0 ? box : null
  }
  const messageBoxText = () => { const b = messageBox(); return b ? norm(b.querySelector('.el-message-box__message')?.textContent) : '(no-box)' }
  const messageBoxBtn = (text) => { const b = messageBox(); if (!b) return null; return [...b.querySelectorAll('.el-message-box__btns button')].find((x) => norm(x.textContent).includes(text)) }
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL1 = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '部署页未就绪' } }

  // B1 + B3：甲环境显示成功记录版本 1.2.3（最新一条是失败的 1.2.4，必须跳过），并标注来源
  r.b1ok = await waitOnline('1.2.3')
  r.b1text = onlineText()
  r.b3skippedFailed = !onlineText().includes('1.2.4')

  // B2：切到乙环境（无记录）→ 未知
  r.sw2 = await selectBy('.bar-card .el-select', '环境乙')
  r.b2ok = await waitOnline('未知')
  r.b2text = onlineText()

  // 切回甲环境 → 恢复 1.2.3
  r.sw1 = await selectBy('.bar-card .el-select', '环境甲')
  r.b2back = await waitOnline('1.2.3')
  r.b2backText = onlineText()

  // B4：实时查询（服务器不可达）失败后仍显示回退值，并给出错误提示
  const queryBtn = btnByText('.ver-info', '查询')
  r.queryEnabled = !!queryBtn && !queryBtn.disabled
  if (queryBtn) queryBtn.click()
  r.b4toast = await waitFor(() => !!q('.el-message--error'), 15000)
  r.b4toastText = norm(q('.el-message--error')?.textContent)
  r.b4stillFallback = onlineText().includes('1.2.3')

  // B6：发布确认弹窗的当前线上版本同样用回退值
  const pub = btnByText('.publish-row', '发布')
  r.publishEnabled = !!pub && !pub.disabled
  if (pub) pub.click()
  r.b6boxShown = await waitFor(() => !!messageBox(), 6000)
  r.b6text = messageBoxText()
  const cancel = messageBoxBtn('取消')
  if (cancel) cancel.click()
  await waitFor(() => !messageBox(), 4000)

  // B5：切到 Beta 项目 → 显示 Beta 自己的记录 9.9.9，不残留 Alpha 的 1.2.3
  // 页头项目选择器统一到顶栏插槽后类名为 .topbar-project-select（原 .app-topbar .project-select 在部署页已隐藏）
  r.swProject = await selectBy('.topbar-project-select', 'Beta项目')
  r.b5ok = await waitOnline('9.9.9')
  r.b5text = onlineText()
  r.b5noResidue = !onlineText().includes('1.2.3')

  // 切回 Alpha → 再次显示 1.2.3
  r.swBack = await selectBy('.topbar-project-select', 'Alpha项目')
  r.b5back = await waitOnline('1.2.3')
  r.b5backText = onlineText()
  done()
  return r
})()`

/** 设置 E2E_EXE 时驱动打包产物，否则用开发版 Electron */
const EXE = process.env.E2E_EXE || ''

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '180000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  const bin = EXE || process.execPath
  const args = EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.']
  return spawnSync(bin, args, {
    cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: 180000, env,
  })
}

function parseEval(stdout) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes('[SMOKE][eval]')) {
      try { return JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim()) } catch { return null }
    }
  }
  return null
}

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

console.log('=== 发布卡「线上版本」按记录回退（B1–B6）===')
preseed()

const p1 = launch(EVAL1, 'deploy-online-version.png')
const ev = parseEval(p1.stdout || '')
if (!ev) {
  console.log('  FAIL  未取到 eval 结果')
  console.log((p1.stdout || '').slice(-2500))
  failed++
} else {
  if (ev.fatal) assert('部署页就绪', false, ev.fatal)
  assert('B1 有成功记录即显示线上版本 1.2.3', ev.b1ok === true && String(ev.b1text).includes('1.2.3'), `实际="${ev.b1text}"`)
  assert('B1 标注来源「按发布记录」', String(ev.b1text).includes('按发布记录'), `实际="${ev.b1text}"`)
  assert('B3 跳过更新的失败记录（不显示 1.2.4）', ev.b3skippedFailed === true, `实际="${ev.b1text}"`)
  assert('B2 切到无记录环境显示「未知」', ev.sw2 === 'ok' && ev.b2ok === true && String(ev.b2text).includes('未知'), `sw=${ev.sw2} 实际="${ev.b2text}"`)
  assert('B2 切到无记录环境不残留来源标注', !String(ev.b2text).includes('按发布记录'), `实际="${ev.b2text}"`)
  assert('B2 切回甲环境恢复 1.2.3', ev.sw1 === 'ok' && ev.b2back === true, `实际="${ev.b2backText}"`)
  assert('B4 查询按钮可用（表单不脏）', ev.queryEnabled === true)
  assert('B4 查询失败给出错误提示', ev.b4toast === true, `toast="${ev.b4toastText}"`)
  assert('B4 查询失败后仍显示回退值 1.2.3', ev.b4stillFallback === true, `实际="${ev.b4toastText}"`)
  assert('B6 发布按钮可用并弹出确认框', ev.publishEnabled === true && ev.b6boxShown === true, `enabled=${ev.publishEnabled} shown=${ev.b6boxShown}`)
  assert('B6 确认框当前线上版本为 1.2.3', String(ev.b6text).includes('当前线上版本 1.2.3'), `实际="${ev.b6text}"`)
  assert('B5 切项目后显示新项目记录 9.9.9', ev.swProject === 'ok' && ev.b5ok === true, `sw=${ev.swProject} 实际="${ev.b5text}"`)
  assert('B5 切项目不残留上一个项目版本', ev.b5noResidue === true, `实际="${ev.b5text}"`)
  assert('B5 切回 Alpha 恢复 1.2.3', ev.swBack === 'ok' && ev.b5back === true, `实际="${ev.b5backText}"`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev, null, 1))
}

if (process.env.KEEP_SANDBOX) {
  console.log(`\n[e2e] 沙箱保留（KEEP_SANDBOX=1）：${SANDBOX}`)
} else {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
}
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
