/**
 * E2E（真实 Electron + 沙箱主目录）：AI 服务与一键填报的默认地址固定为公司内网地址
 *
 * 需求：AI 服务的「服务商」默认自定义、接口地址默认 http://ai.sysapp.prttech.com:18080/v1；
 *       一键填报 · 禅道账号 与 一键填报 · 汉印工时账号 的默认地址也都先固定（公司内网），
 *       汉印「所属公司」默认选 1（厦门汉印）。用户不必每次手填。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   C1 全新安装（无 config.json）：AI 服务商「自定义」+ 接口地址 http://ai.sysapp.prttech.com:18080/v1；
 *      禅道地址 http://10.11.34.2；汉印平台地址 http://10.10.21.2:5293；所属公司「1 · 厦门汉印」
 *   C2 历史配置里这些地址/公司留空 → 同样回落默认（不显示空值）
 *   C3 用户填过其他地址/公司 → 原样保留，不被默认值覆盖
 *   C4 主进程下发的配置（config:load）与界面显示一致（不是只有界面糊上去的）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-default-endpoints-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-endpoint-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')

const ZENTAO_DEFAULT = 'http://10.11.34.2'
const HANPRINT_DEFAULT = 'http://10.10.21.2:5293'
const AI_DEFAULT = 'http://ai.sysapp.prttech.com:18080/v1'

/** case: 'fresh' 无配置 / 'empty' 历史配置留空 / 'custom' 自定义地址 */
function preseed(caseName) {
  fs.rmSync(USER_DATA, { recursive: true, force: true })
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  if (caseName === 'empty') {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      ai: { baseUrl: '', model: '' },
      zentao: { baseUrl: '', account: '', workStart: '08:30', workEnd: '17:30', lunchStart: '12:00', lunchEnd: '13:00' },
      hanprint: { baseUrl: '', clientId: '', account: '' },
    }, null, 2))
  } else if (caseName === 'custom') {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      ai: { baseUrl: 'http://192.168.1.9:8080/v1', model: 'my-model' },
      zentao: { baseUrl: 'http://192.168.1.9:8080', account: '', workStart: '08:30', workEnd: '17:30', lunchStart: '12:00', lunchEnd: '13:00' },
      hanprint: { baseUrl: 'http://192.168.1.9:5293', clientId: '2', account: '' },
    }, null, 2))
  }
}

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const q = (s) => document.querySelector(s)
  // E2E_NO_CLOSE=1：调试/截图时保持窗口不关，等 SMOKE_SHOT_MS 截图
  const NO_CLOSE = ${JSON.stringify(!!process.env.E2E_NO_CLOSE)}
  const waitFor = async (fn, ms = 12000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
    return false
  }
  const rowOf = (label) => [...document.querySelectorAll('.ai-row')].find((r) => norm(r.querySelector('.ai-label')?.textContent) === label)
  const inputValue = (label) => { const r = rowOf(label); const i = r && r.querySelector('input'); return i ? i.value : '(no-row)' }
  const selectText = (label) => { const r = rowOf(label); return r ? norm(r.querySelector('.el-select')?.textContent) : '(no-row)' }
  const openFillSection = async () => {
    // el-segmented 的点击要点内部 input/label（Vue 监听在原生 input 上）
    const item = [...document.querySelectorAll('.el-segmented__item')].find((x) => norm(x.textContent).includes('一键填报'))
    if (!item) return 'no-item'
    const hit = item.querySelector('input') || item.querySelector('label') || item
    hit.click()
    await sleep(500)
    return (await waitFor(() => rowOf('禅道地址') && rowOf('平台地址'), 6000)) ? 'ok' : 'not-shown'
  }
  const done = () => { if (!NO_CLOSE) setTimeout(() => window.close(), 400) }
`

const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await waitFor(() => q('.settings-page'), 20000)) { done(); return { fatal: '设置页未就绪' } }
  // AI 服务是默认分区：先读它（后面切到一键填报后该分区只是 v-show 隐藏，值仍可读）
  r.aiProvider = selectText('服务商')
  r.aiBaseUrl = inputValue('接口地址')
  r.section = await openFillSection()
  r.zentaoAddr = inputValue('禅道地址')
  r.hanprintAddr = inputValue('平台地址')
  r.company = selectText('所属公司')
  r.zentaoHint = norm(rowOf('禅道地址')?.querySelector('.ai-hint')?.textContent)
  // C4：主进程下发的配置与界面一致
  const cfg = await window.gitReport.configLoad()
  r.cfgAi = cfg?.ai?.baseUrl
  r.cfgZentao = cfg?.zentao?.baseUrl
  r.cfgHanprint = cfg?.hanprint?.baseUrl
  r.cfgClientId = cfg?.hanprint?.clientId
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
    SMOKE_EXIT_MS: process.env.E2E_EXIT_MS || '90000',
    SMOKE_VIEW: '设置',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: process.env.E2E_SHOT_MS || '5000',
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

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

console.log('=== 一键填报默认地址固定（C1–C4）===')

function runCase(caseName, shotName) {
  preseed(caseName)
  const p = launch(EVAL, shotName)
  const ev = parseEval(p.stdout || '')
  if (!ev) {
    console.log(`  FAIL  [${caseName}] 未取到 eval 结果`)
    console.log((p.stdout || '').slice(-2000))
    failed++
    return null
  }
  if (ev.fatal) { assert(`[${caseName}] 页面就绪`, false, ev.fatal); return ev }
  assert(`[${caseName}] 一键填报分区展开`, ev.section === 'ok', `section=${ev.section}`)
  return ev
}

// C1：全新安装
const c1 = runCase('fresh', 'endpoint-fresh.png')
if (c1) {
  assert('C1 AI 服务商默认「自定义」', String(c1.aiProvider).includes('自定义'), `实际="${c1.aiProvider}"`)
  assert('C1 AI 接口地址默认 http://ai.sysapp.prttech.com:18080/v1', c1.aiBaseUrl === AI_DEFAULT, `实际="${c1.aiBaseUrl}"`)
  assert('C1 禅道地址默认 http://10.11.34.2', c1.zentaoAddr === ZENTAO_DEFAULT, `实际="${c1.zentaoAddr}"`)
  assert('C1 汉印地址默认 http://10.10.21.2:5293', c1.hanprintAddr === HANPRINT_DEFAULT, `实际="${c1.hanprintAddr}"`)
  assert('C1 汉印所属公司默认 1 · 厦门汉印', String(c1.company).includes('1 · 厦门汉印'), `实际="${c1.company}"`)
  // 默认地址断言兜住「改了渲染层但没重新 build」的假通过；地址行说明文案已按
  // 「UI 禁止描述性文本」要求移除（f4c4456），此处断言其不再回潮
  assert('C1 地址行不再保留描述性说明文案', !String(c1.zentaoHint).trim(), `实际="${c1.zentaoHint}"`)
  assert('C4 主进程配置与界面一致',
    c1.cfgAi === AI_DEFAULT && c1.cfgZentao === ZENTAO_DEFAULT && c1.cfgHanprint === HANPRINT_DEFAULT && c1.cfgClientId === '1',
    `cfg=${JSON.stringify({ a: c1.cfgAi, z: c1.cfgZentao, h: c1.cfgHanprint, c: c1.cfgClientId })}`)
}

// C2：历史配置留空
const c2 = runCase('empty', 'endpoint-empty.png')
if (c2) {
  assert('C2 留空的 AI 接口地址回落默认', c2.aiBaseUrl === AI_DEFAULT, `实际="${c2.aiBaseUrl}"`)
  assert('C2 留空的禅道地址回落默认', c2.zentaoAddr === ZENTAO_DEFAULT, `实际="${c2.zentaoAddr}"`)
  assert('C2 留空的汉印地址回落默认', c2.hanprintAddr === HANPRINT_DEFAULT, `实际="${c2.hanprintAddr}"`)
  assert('C2 留空的公司回落 1 · 厦门汉印', String(c2.company).includes('1 · 厦门汉印'), `实际="${c2.company}"`)
}

// C3：自定义地址保留
const c3 = runCase('custom', 'endpoint-custom.png')
if (c3) {
  assert('C3 自定义 AI 接口地址保留', c3.aiBaseUrl === 'http://192.168.1.9:8080/v1', `实际="${c3.aiBaseUrl}"`)
  assert('C3 自定义禅道地址保留', c3.zentaoAddr === 'http://192.168.1.9:8080', `实际="${c3.zentaoAddr}"`)
  assert('C3 自定义汉印地址保留', c3.hanprintAddr === 'http://192.168.1.9:5293', `实际="${c3.hanprintAddr}"`)
  assert('C3 自定义公司 2 · 江西外协保留', String(c3.company).includes('2 · 江西外协'), `实际="${c3.company}"`)
}

if (process.env.KEEP_SANDBOX) {
  console.log(`\n[e2e] 沙箱保留（KEEP_SANDBOX=1）：${SANDBOX}`)
} else {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
}
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
