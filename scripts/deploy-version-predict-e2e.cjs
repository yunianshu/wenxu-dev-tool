/**
 * E2E（真实 Electron + 沙箱主目录）：发布卡「新版本」候选预测（spec R7）
 *
 * 需求：不再让用户手输版本号，而是基于当前版本预测 patch/minor/major 候选供选择，
 *       同时保留自定义输入。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   A1 本地版本 0.0.1、该环境历史成功发布 0.1.3 → 基准取 0.1.3，候选 0.1.4 / 0.2.0 / 1.0.0，
 *      并标注基准来自线上/历史
 *   A2 切换到无历史的环境 → 基准回到本地 0.0.1（不继承上一个环境的历史版本）
 *   A3 选「0.2.0（新功能）」保存 → 发布按钮显示 0.2.0，且已持久化到磁盘
 *   A4 再次打开 → 基准随当前版本变为 0.2.0；选「自定义」输入 0.9.9 保存 →
 *      发布按钮显示 0.9.9，且已持久化到磁盘
 *   A5 当前版本无法解析为 x.y.z（如 20260908）→ 不提供候选，仅保留自定义输入且可直接保存
 *   A6 无法递增时一键发布提示设置版本，设置后连续点击也只提交一次发布，无需确认
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-version-predict-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const TEMP_DIR = fs.realpathSync(os.tmpdir())
const SANDBOX = fs.mkdtempSync(path.join(TEMP_DIR, 'pm-e2e-ver-'))
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const PROJ_FILE = path.join(USER_DATA, 'deploy-projects.json')
const PROJECT_ID = 'dp_e2e_ver'

function mkTarget(id, name) {
  return {
    id,
    name,
    // 127.0.0.1:59999 无监听：SSH 查询立即失败，验证「查询失败不影响候选」
    server: { host: '127.0.0.1', port: 59999, username: 'root', authType: 'password', keyPath: '' },
    remotePath: `/opt/apps/${id}`,
    health: { enabled: false, url: '', timeout: 90, interval: 3 },
    dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
  }
}

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  if (process.platform === 'win32') fs.mkdirSync(path.join(SANDBOX, 'AppData', 'Roaming'), { recursive: true })
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({ closeAction: 'quit' }))
  fs.writeFileSync(PROJ_FILE, JSON.stringify({
    schemaVersion: 3,
    projects: [{
      id: PROJECT_ID,
      name: '版本预测项目',
      localPath: path.join(SANDBOX, 'no-such-project'),
      version: { strategy: 'manual', manual: '0.0.1' }, // 本地（手动）版本
      configMode: 'manual',
      deployMode: 'docker',
      composeFile: 'docker-compose.yml',
      deploy: {
        backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
        dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
        keepReleases: 10, keepBackups: 10,
      },
      targets: [mkTarget(`${PROJECT_ID}_t1`, '环境甲'), mkTarget(`${PROJECT_ID}_t2`, '环境乙')],
    }],
  }, null, 2))
  // 环境甲曾发布 0.1.3，随后回滚到 0.1.2。环境乙无历史。
  const base = Date.now()
  const successfulRelease = {
    id: 'h_ver_1', projectId: PROJECT_ID, projectName: '版本预测项目',
    targetId: `${PROJECT_ID}_t1`, targetName: '环境甲', type: 'deploy',
    version: '0.1.3', oldVersion: '0.1.2', status: 'success',
    startedAt: base, finishedAt: base + 1000, durationMs: 1000,
    host: '127.0.0.1:59999', remotePath: '/opt/apps/dp_e2e_ver_t1', message: '发布成功', logFile: '', stages: {},
  }
  fs.writeFileSync(path.join(USER_DATA, 'deploy-history.json'), JSON.stringify({
    records: [successfulRelease, {
      ...successfulRelease, id: 'h_ver_2', type: 'rollback', version: '0.1.2', oldVersion: '0.1.3',
      startedAt: base + 1000, finishedAt: base + 2000, message: '回滚成功',
    }],
  }, null, 2))
}

const sleep = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))'

const helpers = `
  ${sleep}
  const q = (s) => document.querySelector(s)
  const publishBtnText = () => { const b = q('.publish-btn'); return b ? b.textContent.trim() : '' }
  const verDialog = () => [...document.querySelectorAll('.el-dialog')].find((d) => {
    const t = d.querySelector('.el-dialog__title')
    return t && t.textContent.includes('添加新版本')
  })
  const dialogShown = () => {
    const d = verDialog()
    if (!d) return false
    const ov = d.closest('.el-overlay')
    if (!ov || ov.style.display === 'none') return false
    const rect = d.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const verBaseText = () => {
    const d = verDialog(); const h = d && d.querySelector('.ver-hint')
    return h ? h.textContent.replace(/\\s+/g, ' ').trim() : ''
  }
  const verOptions = () => {
    const d = verDialog()
    return d ? [...d.querySelectorAll('.el-radio')].map((x) => x.textContent.trim()) : []
  }
  const verSourceNote = () => {
    const d = verDialog(); const h = d && d.querySelector('.ver-hint')
    return !!(h && h.querySelector('span'))
  }
  const pickOption = (text) => {
    const d = verDialog(); if (!d) return false
    const el = [...d.querySelectorAll('.el-radio')].find((x) => x.textContent.trim().includes(text))
    if (!el) return false
    el.click(); return true
  }
  const typeCustom = (v) => {
    const d = verDialog(); if (!d) return false
    const input = d.querySelector('.el-input input'); if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, v)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  const clickSave = () => {
    const d = verDialog(); if (!d) return false
    const btn = [...d.querySelectorAll('.el-dialog__footer button')].find((b) => b.textContent.includes('保存并使用'))
    if (!btn) return false
    btn.click(); return true
  }
  const openVerDialog = async () => {
    const btn = [...document.querySelectorAll('.publish-row button')].find((b) => b.textContent.includes('新版本'))
    if (!btn) return 'no-btn'
    btn.click()
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) { if (dialogShown()) return 'ok'; await sleep(100) }
    return 'not-shown'
  }
  const closeVerDialog = async () => {
    const d = verDialog(); if (!d) return
    const btn = [...d.querySelectorAll('.el-dialog__footer button')].find((b) => b.textContent.includes('取消'))
    if (btn) btn.click()
    const t0 = Date.now()
    while (Date.now() - t0 < 3000) { if (!dialogShown()) return; await sleep(100) }
  }
  const waitBase = async (expect, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (verBaseText().includes(expect)) return true; await sleep(120) }
    return false
  }
  const waitPublishBtn = async (expect, ms = 10000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (publishBtnText().includes(expect)) return true; await sleep(150) }
    return false
  }
  const switchTarget = async (name) => {
    const sel = q('.environment-select'); if (!sel) return 'no-select'
    const trigger = sel.querySelector('.el-select__wrapper') || sel
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const opt = await new Promise(async (resolve) => {
      const t0 = Date.now()
      while (Date.now() - t0 < 4000) {
        const o = [...document.querySelectorAll('.el-select-dropdown__item')].find((x) => x.textContent.trim() === name && x.offsetParent !== null)
        if (o) return resolve(o)
        await sleep(100)
      }
      resolve(null)
    })
    if (!opt) return 'no-option'
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(400)
    return 'ok'
  }
  const ready = async (ms = 10000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (q('.publish-btn') && q('.environment-select')) return true; await sleep(150) }
    return false
  }
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL1 = `(async () => {
  ${helpers}
  const r = {}
  if (!await ready()) { done(); return { fatal: '部署页未就绪' } }
  r.btn0 = publishBtnText()

  // A1：环境甲（本地 0.0.1 + 历史 0.1.3）→ 基准 0.1.3，候选 0.1.4 / 0.2.0 / 1.0.0
  r.open1 = await openVerDialog()
  r.waitBase1 = await waitBase('0.1.3')
  r.base1 = verBaseText()
  r.opts1 = verOptions()
  r.note1 = verSourceNote()
  await closeVerDialog()

  // A2：切到环境乙（无历史）→ 基准回到本地 0.0.1
  r.sw2 = await switchTarget('环境乙')
  r.open2 = await openVerDialog()
  r.waitBase2 = await waitBase('0.0.1')
  r.base2 = verBaseText()
  r.opts2 = verOptions()
  r.note2 = verSourceNote()
  await closeVerDialog()

  // 切回环境甲 → 基准恢复 0.1.3
  r.sw1 = await switchTarget('环境甲')
  r.open3 = await openVerDialog()
  r.waitBase3 = await waitBase('0.1.3')
  r.base3 = verBaseText()

  // A3：选 0.2.0（新功能）保存 → 发布按钮显示 0.2.0
  r.pick1 = pickOption('0.2.0')
  r.save1 = clickSave()
  r.btnSaved = await waitPublishBtn('0.2.0')
  r.btn1 = publishBtnText()
  done()
  return r
})()`

const EVAL2 = `(async () => {
  ${helpers}
  const r = {}
  if (!await ready()) { done(); return { fatal: '部署页未就绪' } }
  r.btn0 = publishBtnText()

  // A4：基准随当前版本变为 0.2.0
  r.open1 = await openVerDialog()
  r.waitBase = await waitBase('0.2.0')
  r.base1 = verBaseText()
  r.opts1 = verOptions()

  // 选「自定义」输入 0.9.9 → 发布按钮显示 0.9.9
  r.pickCustom = pickOption('自定义')
  await sleep(300)
  r.typed = typeCustom('0.9.9')
  r.save = clickSave()
  r.btnSaved = await waitPublishBtn('0.9.9')
  r.btn1 = publishBtnText()
  done()
  return r
})()`

const EVAL3 = `(async () => {
  ${helpers}
  const r = {}
  if (!await ready()) { done(); return { fatal: '部署页未就绪' } }
  r.btn0 = publishBtnText()
  const patchButton = () => [...document.querySelectorAll('.publish-actions button')]
    .find((b) => b.textContent.trim() === '一键小版本发布')
  patchButton()?.click()
  for (let i = 0; i < 30 && !r.noVersionWarning; i++) {
    r.noVersionWarning = q('.el-message--warning')?.textContent.includes('设置三段版本号')
    if (!r.noVersionWarning) await sleep(100)
  }
  const history = () => window.gitReport.deployHistoryList(${JSON.stringify(PROJECT_ID)})
  r.noVersionRunCount = (await history()).length

  // A5：当前版本无法解析为 x.y.z → 不提供候选，仅保留自定义输入
  r.open1 = await openVerDialog()
  await sleep(1200)
  r.base1 = verBaseText()
  r.opts1 = verOptions()
  r.customInputShown = (() => {
    const d = verDialog(); return !!(d && d.querySelector('.el-input input'))
  })()
  // 自定义输入仍可用
  r.typed = typeCustom('1.0.0')
  r.save = clickSave()
  r.btnSaved = await waitPublishBtn('1.0.0')
  r.btn1 = publishBtnText()
  const patch = patchButton()
  patch?.click()
  patch?.click()
  r.patchUpdated = await waitPublishBtn('1.0.1')
  r.patchRuns = (await history()).map(({ version, requestedVersion, targetId, status }) => ({
    version, requestedVersion, targetId, status,
  }))
  done()
  return r
})()`

/** 设置 E2E_EXE 时驱动打包产物（win-unpacked 可执行文件），否则用开发版 Electron */
const EXE = process.env.E2E_EXE || ''

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '120000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  const bin = EXE || process.execPath
  const args = EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.']
  return spawnSync(bin, args, {
    cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: 150000, env,
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

/** 磁盘终态：项目已保存的版本策略与手动版本 */
function savedVersion() {
  const p = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8')).projects.find((x) => x.id === PROJECT_ID)
  return p && p.version ? { strategy: p.version.strategy, manual: p.version.manual } : null
}

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

console.log('=== 发布卡「新版本」候选预测（spec R7）===')
preseed()

// —— 第一次启动：候选预测 + 环境切换 + 选择候选保存 ——
const p1 = launch(EVAL1, 'ver-predict-1.png')
const ev1 = parseEval(p1.stdout || '')
if (!ev1) {
  console.log('  FAIL  第一次启动未取到 eval 结果')
  console.log((p1.stdout || '').slice(-2500))
  console.log((p1.stderr || '').slice(-1500))
  failed++
} else {
  if (ev1.fatal) assert('第一次启动页面就绪', false, ev1.fatal)
  assert('初始发布按钮显示本地版本 0.0.1', String(ev1.btn0).includes('0.0.1'), `实际="${ev1.btn0}"`)
  assert('A1 对话框打开', ev1.open1 === 'ok', `open=${ev1.open1}`)
  assert('A1 基准取历史最高 0.1.3', ev1.waitBase1 === true && String(ev1.base1).includes('0.1.3'), `实际="${ev1.base1}"`)
  assert('A1 候选含 0.1.4 / 0.2.0 / 1.0.0',
    ['0.1.4', '0.2.0', '1.0.0'].every((v) => (ev1.opts1 || []).some((o) => o.includes(v))),
    `实际=${JSON.stringify(ev1.opts1)}`)
  assert('A1 标注基准来自线上/历史', ev1.note1 === true)
  assert('A2 切到环境乙成功', ev1.sw2 === 'ok', `sw2=${ev1.sw2}`)
  assert('A2 无历史环境基准回到本地 0.0.1',
    ev1.waitBase2 === true && String(ev1.base2).includes('0.0.1') && !String(ev1.base2).includes('0.1.3'),
    `实际="${ev1.base2}"`)
  assert('A2 无历史环境候选为 0.0.2 / 0.1.0 / 1.0.0',
    ['0.0.2', '0.1.0', '1.0.0'].every((v) => (ev1.opts2 || []).some((o) => o.includes(v))),
    `实际=${JSON.stringify(ev1.opts2)}`)
  assert('A2 无历史环境不标注远程来源', ev1.note2 === false)
  assert('A2 切回环境甲基准恢复 0.1.3', ev1.sw1 === 'ok' && ev1.waitBase3 === true, `实际="${ev1.base3}"`)
  assert('A3 选中候选并保存后发布按钮显示 0.2.0',
    ev1.pick1 === true && ev1.save1 === true && ev1.btnSaved === true && String(ev1.btn1).includes('0.2.0'),
    `pick=${ev1.pick1} save=${ev1.save1} btn="${ev1.btn1}"`)
  const sv1 = savedVersion()
  assert('A3 配置持久化（strategy=manual, manual=0.2.0）',
    !!sv1 && sv1.strategy === 'manual' && sv1.manual === '0.2.0', `磁盘=${JSON.stringify(sv1)}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev1, null, 1))
}

// —— 第二次启动：基准随当前版本更新 + 自定义输入 ——
const p2 = launch(EVAL2, 'ver-predict-2.png')
const ev2 = parseEval(p2.stdout || '')
if (!ev2) {
  console.log('  FAIL  第二次启动未取到 eval 结果')
  console.log((p2.stdout || '').slice(-2500))
  console.log((p2.stderr || '').slice(-1500))
  failed++
} else {
  if (ev2.fatal) assert('第二次启动页面就绪', false, ev2.fatal)
  assert('重启后发布按钮保留 0.2.0', String(ev2.btn0).includes('0.2.0'), `实际="${ev2.btn0}"`)
  assert('A4 基准随当前版本变为 0.2.0', ev2.waitBase === true && String(ev2.base1).includes('0.2.0'), `实际="${ev2.base1}"`)
  assert('A4 候选为 0.2.1 / 0.3.0 / 1.0.0',
    ['0.2.1', '0.3.0', '1.0.0'].every((v) => (ev2.opts1 || []).some((o) => o.includes(v))),
    `实际=${JSON.stringify(ev2.opts1)}`)
  assert('A4 自定义输入保存后发布按钮显示 0.9.9',
    ev2.pickCustom === true && ev2.typed === true && ev2.btnSaved === true && String(ev2.btn1).includes('0.9.9'),
    `pick=${ev2.pickCustom} typed=${ev2.typed} btn="${ev2.btn1}"`)
  const sv2 = savedVersion()
  assert('A4 配置持久化（manual=0.9.9）',
    !!sv2 && sv2.strategy === 'manual' && sv2.manual === '0.9.9', `磁盘=${JSON.stringify(sv2)}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev2, null, 1))
}

// —— 第三次启动：当前版本无法解析 → 仅自定义输入（历史也清空，确保基准只剩不可解析的版本）——
const rawProj = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8'))
rawProj.projects.find((x) => x.id === PROJECT_ID).version.manual = '20260908'
fs.writeFileSync(PROJ_FILE, JSON.stringify(rawProj, null, 2))
fs.writeFileSync(path.join(USER_DATA, 'deploy-history.json'), JSON.stringify({ records: [] }, null, 2))

const p3 = launch(EVAL3, 'ver-predict-3.png')
const ev3 = parseEval(p3.stdout || '')
if (!ev3) {
  console.log('  FAIL  第三次启动未取到 eval 结果')
  console.log((p3.stdout || '').slice(-2500))
  console.log((p3.stderr || '').slice(-1500))
  failed++
} else {
  if (ev3.fatal) assert('第三次启动页面就绪', false, ev3.fatal)
  assert('A5 无法解析的版本基准原样显示', String(ev3.base1).includes('20260908'), `实际="${ev3.base1}"`)
  assert('A5 不提供候选（仅「自定义」）',
    Array.isArray(ev3.opts1) && ev3.opts1.length === 1 && ev3.opts1[0].includes('自定义'),
    `实际=${JSON.stringify(ev3.opts1)}`)
  assert('A5 自定义输入框默认可见且可用',
    ev3.customInputShown === true && ev3.typed === true && ev3.save === true && ev3.btnSaved === true && String(ev3.btn1).includes('1.0.0'),
    `shown=${ev3.customInputShown} typed=${ev3.typed} btn="${ev3.btn1}"`)
  assert('A6 缺少三段版本号时提示设置版本，未创建发布任务',
    ev3.noVersionWarning === true && ev3.noVersionRunCount === 0)
  assert('A6 连续点击仅启动一次 1.0.1 发布，无需确认',
    ev3.patchUpdated === true && ev3.patchRuns?.length === 1
      && ev3.patchRuns[0].version === '1.0.1' && ev3.patchRuns[0].requestedVersion === '1.0.1'
      && ev3.patchRuns[0].targetId === `${PROJECT_ID}_t1` && ev3.patchRuns[0].status === 'failed',
    `实际任务=${JSON.stringify(ev3.patchRuns)}`)
  const sv3 = savedVersion()
  assert('A6 任务开始时持久化版本（manual=1.0.1）',
    !!sv3 && sv3.strategy === 'manual' && sv3.manual === '1.0.1', `磁盘=${JSON.stringify(sv3)}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev3, null, 1))
}

if (!failed && path.dirname(fs.realpathSync(SANDBOX)) === TEMP_DIR) {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 临时目录可稍后清理 */ }
}
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
