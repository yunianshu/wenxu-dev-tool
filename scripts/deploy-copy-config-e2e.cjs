/**
 * E2E（真实 Electron 环境）：部署设置「从其他项目复制」后，当前目标的服务器信息必须跟着更新
 *
 * 需求：在部署设置抽屉里点「从其他项目复制」并确认后，复制过来的环境应成为当前目标，
 *       【服务器（当前目标）】卡片要显示复制来的主机地址/部署目录（而不是保持原样）。
 *
 * 验收标准（源自需求）：
 *   A1 复制前【服务器（当前目标）】显示目标项目自己的服务器信息
 *   A2 复制落盘：目标项目多出一个环境，且带源项目的 host / remotePath / 环境名
 *   A3 复制后界面：当前目标切到新增环境，【服务器（当前目标）】卡的主机地址与部署目录
 *      变为源项目的值（本测试的核心断言）
 *   A4 环境下拉里出现新增环境，且「部署环境」栏的 host → remotePath 文案同步更新
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/deploy-copy-config-e2e.cjs
 *   PM_E2E_TARGET_EXE=<release/<版本>/win-unpacked/*.exe> 可改跑打包成品（发版冒烟）
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = process.env.PM_E2E_SANDBOX || path.join(os.tmpdir(), `pm-e2e-copy-config-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')

/** 目标项目（当前选中）与源项目：服务器信息刻意取不同值，便于断言“变了没有” */
const TARGET_HOST = '10.0.0.2'
const TARGET_REMOTE = '/opt/apps/target-b'
const SOURCE_HOST = '10.0.0.1'
const SOURCE_REMOTE = '/opt/apps/source-a'

function project(id, name, targetId, targetName, host, remotePath) {
  return {
    id,
    name,
    localPath: '',
    version: { strategy: 'auto', manual: '' },
    deployMode: 'docker',
    composeFile: 'docker-compose.yml',
    deploy: {
      backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
      dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
      keepReleases: 10, keepBackups: 10,
    },
    targets: [{
      id: targetId,
      name: targetName,
      server: { host, port: 22, username: 'root', authType: 'password', keyPath: '' },
      remotePath,
      health: { enabled: true, url: '', timeout: 90, interval: 3 },
      dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
    }],
  }
}

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  // 目标项目放数组首位：渲染层默认选中列表第一个项目
  const projects = [
    project('dp_target_b', '目标项目B', 't_b_1', '测试环境', TARGET_HOST, TARGET_REMOTE),
    project('dp_source_a', '源项目A', 't_a_1', '生产环境', SOURCE_HOST, SOURCE_REMOTE),
  ]
  fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects }, null, 2))
}

const EVAL = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const r = {}
  const btnByText = (txt) => [...document.querySelectorAll('button')].find(b => b.textContent.includes(txt))
  const waitFor = async (fn, ms = 8000, step = 100) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step) }
    return null
  }
  const drawer = () => document.querySelector('.deploy-config-drawer')
  // el-drawer 关闭后 DOM 仍留在页面上（v-show），必须按可见性判断开合
  const drawerVisible = () => { const d = drawer(); return !!(d && d.getBoundingClientRect().height > 0) }
  /** 只取「当前可见」那个下拉的选项：Element Plus 会把历史下拉留在 DOM 里，
   *  全局 querySelectorAll('.el-select-dropdown__item') 会串到顶部项目下拉等其它下拉，
   *  点错项会把应用当前项目切走（曾因此把「选源项目」变成了切换整个应用的项目） */
  const visibleItems = () => {
    const drops = [...document.querySelectorAll('.el-select-dropdown')]
      .filter(d => d.style.display !== 'none' && d.getBoundingClientRect().height > 0)
    const last = drops[drops.length - 1]
    return last ? [...last.querySelectorAll('.el-select-dropdown__item')] : []
  }
  const openSelectAndPick = async (selectEl, text) => {
    const wrapper = selectEl.querySelector('.el-select__wrapper') || selectEl
    wrapper.click()
    const item = await waitFor(() => visibleItems().find(o => o.textContent.trim().includes(text)))
    if (!item) return { ok: false, options: visibleItems().map(o => o.textContent.trim()) }
    item.click()
    await sleep(300)
    return { ok: true, selected: selectEl.textContent.trim() }
  }
  // 【服务器（当前目标）】卡：主机地址输入框占位符唯一，部署目录同理
  const hostInput = () => { const el=drawer() && drawer().querySelector('.selected-server'); return el ? {value:el.dataset.host} : null }
  const remoteInput = () => drawer() && drawer().querySelector('input[placeholder^="/opt/apps"]')
  const nameInput = () => drawer() && drawer().querySelector('input[placeholder="如 myapp"]')
  // 抽屉内「部署目标」环境下拉的当前选中项文案
  const drawerTargetText = () => {
    const el = drawer() && drawer().querySelector('.target-row .el-select')
    return el ? el.textContent.trim() : ''
  }
  const barHostText = () => {
    const el = document.querySelector('.bar-card .target-host')
    return el ? el.textContent.trim() : ''
  }
  const snapshot = (tag) => ({
    tag,
    visible: drawerVisible(),
    project: nameInput() ? nameInput().value : null,
    host: hostInput() ? hostInput().value : null,
    remote: remoteInput() ? remoteInput().value : null,
    targetSelect: drawerTargetText(),
    barHost: barHostText(),
  })

  const openBtn = await waitFor(() => btnByText('部署设置'))
  if (!openBtn) return { fatal: '部署页未就绪：找不到「部署设置」按钮', body: document.body.innerText.slice(0, 300) }
  await sleep(400)
  openBtn.click()
  if (!await waitFor(() => hostInput(), 8000)) return { fatal: '抽屉未打开或服务器卡片未渲染' }
  r.before = snapshot('before')

  // 打开「从其他项目复制」对话框
  const copyBtn = btnByText('从其他项目复制')
  if (!copyBtn) return { fatal: '找不到「从其他项目复制」按钮' }
  copyBtn.click()
  const dialog = await waitFor(() => document.querySelector('.el-dialog'))
  if (!dialog) return { fatal: '复制对话框未出现' }
  await sleep(300)
  const select = dialog.querySelector('.el-select')
  if (!select) return { fatal: '对话框内没有源项目下拉' }
  const picked = await openSelectAndPick(select, '源项目A')
  r.sourcePick = picked
  if (!picked.ok) return { fatal: '下拉里找不到源项目', options: picked.options }
  // 选源项目只应设置下拉值，不允许把应用的当前项目切走
  r.afterPick = snapshot('after-source-pick')

  const confirm = btnByText('复制配置')
  if (!confirm) return { fatal: '找不到「复制配置」按钮' }
  confirm.click()
  // 复制是 IPC + 落盘 + 重新拉列表 + 回填：给足时间
  await sleep(2500)
  r.after = snapshot('after')
  r.toast = [...document.querySelectorAll('.el-message')].map(m => m.textContent.trim()).join(' | ')

  // 环境下拉的全部选项（只看当前可见下拉）
  const sel2 = drawer() && drawer().querySelector('.target-row .el-select')
  if (sel2) {
    ;(sel2.querySelector('.el-select__wrapper') || sel2).click()
    await sleep(500)
    r.targetOptionTexts = visibleItems().map(o => o.textContent.trim())
  }

  // A5 复制已落盘不可撤销：点抽屉「取消」后表单不得回滚成复制前的状态，重开抽屉仍显示复制来的信息
  const cancelBtn = drawer() && [...drawer().querySelectorAll('.drawer-footer button')].find(b => b.textContent.includes('取消'))
  if (cancelBtn) {
    cancelBtn.click()
    await waitFor(() => !drawerVisible(), 5000)
    await sleep(500)
    r.afterCancel = snapshot('after-cancel')
    const reopen = btnByText('部署设置')
    if (reopen) {
      reopen.click()
      await waitFor(() => drawerVisible() && hostInput(), 6000)
      await sleep(400)
    }
    r.afterReopen = snapshot('after-reopen')
  }
  return r
})()`

function launch(shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '25000',
    SMOKE_VIEW: '部署',
    SMOKE_CLICK_MS: '3000',
    SMOKE_EVAL: EVAL,
    SMOKE_EVAL_MS: '6500',
    SMOKE_SCREENSHOT_PATH: path.join(SANDBOX, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  if (process.env.PM_E2E_TARGET_EXE) {
    return spawnSync(process.env.PM_E2E_TARGET_EXE, [], { cwd: ROOT, encoding: 'utf8', timeout: 90000, env })
  }
  return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
    cwd: ROOT, encoding: 'utf8', timeout: 90000, env,
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

console.log('=== 部署设置「从其他项目复制」E2E（A1–A4）===')
preseed()
const run = launch('copy-config.png')
const ev = parseEval(run.stdout || '')
if (!ev) {
  console.log('  FAIL  未取到 eval 结果')
  console.log(String(run.stdout || '').slice(-3000))
  process.exit(1)
}
if (ev.fatal) { assert('页面就绪', false, `${ev.fatal} ${ev.body || ''} ${JSON.stringify(ev.options || '')}`) }
console.log(`  复制前: ${JSON.stringify(ev.before)}`)
console.log(`  选源项目后: ${JSON.stringify(ev.afterPick)}  选中所选=${JSON.stringify(ev.sourcePick)}`)
console.log(`  复制后: ${JSON.stringify(ev.after)}`)
console.log(`  提示: ${ev.toast || '(无)'}   环境选项: ${JSON.stringify(ev.targetOptionTexts || [])}`)

assert('A1 复制前【服务器（当前目标）】显示目标项目自己的主机', ev.before && ev.before.host === TARGET_HOST, `host=${ev.before && ev.before.host}`)
assert('A0 选源项目不会切换应用当前项目', ev.afterPick && ev.afterPick.project === '目标项目B', `project=${ev.afterPick && ev.afterPick.project}`)
assert('A1 复制前部署目录为目标项目的值', ev.before && ev.before.remote === TARGET_REMOTE, `remote=${ev.before && ev.before.remote}`)

// A2 磁盘断言：目标项目多出一个环境且带源项目信息
try {
  const data = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'deploy-projects.json'), 'utf8'))
  const b = data.projects.find((p) => p.id === 'dp_target_b')
  assert('A2 目标项目落盘为 2 个环境', b && b.targets.length === 2, `targets=${b && b.targets.length}`)
  const copied = b && b.targets[1]
  const copiedServer = copied && data.servers.find(s => s.id === copied.serverId)
  assert('A2 复制来的环境引用源项目服务器但不继承部署目录', copiedServer && copiedServer.host === SOURCE_HOST && copied.remotePath === '',
    `host=${copiedServer && copiedServer.host} remote=${copied && copied.remotePath}`)
  assert('A2 复制来的环境保留源环境名与独立 id', copied && copied.name === '生产环境' && copied.id !== 't_a_1', `name=${copied && copied.name} id=${copied && copied.id}`)
} catch (e) {
  assert('A2 磁盘断言', false, e.message)
}

assert('A3 复制后【服务器（当前目标）】主机切换为源项目的主机', ev.after && ev.after.host === SOURCE_HOST, `host=${ev.after && ev.after.host}`)
assert('A3 复制后部署目录留空待当前项目独立配置', ev.after && ev.after.remote === '', `remote=${ev.after && ev.after.remote}`)
assert('A4 复制后当前环境名切换为复制来的环境', ev.after && ev.after.targetSelect.includes('生产环境'), `targetSelect=${ev.after && ev.after.targetSelect}`)
assert('A4 「部署环境」栏 host → 目录文案同步更新', ev.after && ev.after.barHost.includes(SOURCE_HOST), `barHost=${ev.after && ev.after.barHost}`)
assert('A4 环境下拉包含两个环境', Array.isArray(ev.targetOptionTexts) && ev.targetOptionTexts.length === 2, `options=${JSON.stringify(ev.targetOptionTexts)}`)

if (ev.afterCancel) {
  console.log(`  点取消后: ${JSON.stringify(ev.afterCancel)}`)
  console.log(`  重开抽屉: ${JSON.stringify(ev.afterReopen)}`)
  assert('A5 点「取消」后抽屉关闭', ev.afterCancel.visible === false, `visible=${ev.afterCancel.visible}`)
  assert('A5 「取消」不会把已落盘的复制结果回滚掉（表单仍是复制来的服务器）',
    ev.afterCancel.host === SOURCE_HOST && ev.afterCancel.remote === '',
    `host=${ev.afterCancel.host} remote=${ev.afterCancel.remote}`)
  assert('A5 重开抽屉仍显示复制来的服务器信息',
    ev.afterReopen && ev.afterReopen.visible === true && ev.afterReopen.host === SOURCE_HOST && ev.afterReopen.remote === '',
    JSON.stringify(ev.afterReopen))
}

if (!process.env.PM_E2E_KEEP) { try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留现场便于排查 */ } } else { console.log('沙箱保留在：' + SANDBOX) }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
