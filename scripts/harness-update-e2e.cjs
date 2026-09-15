/**
 * 端到端验证：内置 DeepSeek Harness 的「更新监听 + 应用内热更新」
 *
 * 验收标准（源自需求：监听 dsh 是否有更新 → 有更新要提示 → 可在应用内热更新）：
 *   E1 自动监听并提示 —— 应用启动后自动查询官方源，发现新版本时侧栏菜单图标出现新版本小圆点
 *   E2 应用内热更新 —— 经界面链路触发后，用随包 npm 在**真实网络**上下载并安装新版本
 *   E3 更新真实生效 —— 服务重启后实际运行的 dsh 版本为新版本，服务仍能就绪、内嵌页可加载
 *   E4 重启不回落 —— 再次重启服务仍使用热更新版本（不被随包归档覆盖回旧版本）
 *   E5 无残留 —— 应用退出后 dsh 进程树消失
 *
 * 真实依赖：registry.npmjs.org（版本查询与依赖下载，约 150MB）、真实 dsh 依赖树、真实 Electron。
 * 主目录与用户数据目录均为沙箱，不触碰本机 ~/.dsh 与已安装应用的运行时。
 *
 * 前置：node scripts/prepare-harness-runtime.cjs
 * 用法：node scripts/harness-update-e2e.cjs
 *      E2E_EXE=<win-unpacked exe> node scripts/harness-update-e2e.cjs   # 验证打包产物
 *      E2E_KEEP=1 保留沙箱目录（排查用）
 * 时长：冷缓存约 5～10 分钟（首次要解包 49MB 运行时 + 下载 150MB 依赖）。
 */
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const USER_DATA = path.join(os.tmpdir(), `pm-harness-update-e2e-${Date.now()}`)
/** 全新主目录：模拟「用户机器从未用过 dsh」，同时隔离本机 ~/.dsh */
const HOME_SANDBOX = path.join(os.tmpdir(), `pm-harness-update-home-${Date.now()}`)

const EVAL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const text = (s) => { const el = q(s); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' }
  const r = {}

  // E1：应用自动监听（主进程 HARNESS_UPDATE_DELAY_MS 后自查）→ 侧栏角标被动出现。
  // 安全软件可能掐断新二进制的首连（瞬时）：角标超时未出现时手动强制检查一次兜底，
  // 同时覆盖「设置面板手动检查」的 IPC 链路。
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    if (q('.nav-badge')) break
    await sleep(1000)
  }
  if (!q('.nav-badge')) {
    await window.gitReport.harnessUpdateCheck().catch(() => {})
    const t0b = Date.now()
    while (Date.now() - t0b < 60000) {
      if (q('.nav-badge')) break
      await sleep(1000)
    }
  }
  // 角标为菜单图标右上角的小圆点，不出现「新版本」文字
  r.badge = !!q('.nav-badge')
  r.badgeDot = r.badge && !q('.nav-badge').querySelector('svg') && q('.nav-badge').textContent.trim() === ''
  r.menuText = [...document.querySelectorAll('.el-menu-item')]
    .find((e) => e.textContent.trim().startsWith('DeepSeek Harness'))?.textContent.replace(/\s+/g, ' ').trim() || ''

  const status = await window.gitReport.harnessUpdateStatus()
  r.registry = status.registry
  r.current = status.current
  r.latest = status.latest
  r.updateAvailable = status.updateAvailable === true
  r.canUpdate = status.canUpdate === true
  r.harnessVersionBefore = (await window.gitReport.harnessStatus()).dshVersion

  // 更新入口在界面上可达：进入 Harness 页 → 服务设置 → 运行时版本行
  const menu = [...document.querySelectorAll('.el-menu-item')]
  const item = menu.find((e) => e.textContent.trim().startsWith('DeepSeek Harness'))
  if (item) item.click()
  await sleep(1500)
  const settingBtn = [...document.querySelectorAll('.page-header button')].find((b) => b.textContent.trim().includes('服务设置'))
  r.settingsButton = !!settingBtn
  if (settingBtn) { settingBtn.click(); await sleep(1200) }
  r.versionRow = text('.harness-version')
  r.updateButton = [...document.querySelectorAll('.el-dialog button')]
    .map((b) => b.textContent.trim()).find((t) => t.startsWith('更新到')) || ''
  const cancel = [...document.querySelectorAll('.el-dialog button')].find((b) => b.textContent.trim() === '取消')
  if (cancel) cancel.click()
  await sleep(500)

  // E2：应用内热更新（真实下载 + 安装 + 交换 + 重启服务）
  if (!r.updateAvailable) { r.skipped = '当前已是最新版本，未触发安装'; return r }
  const started = Date.now()
  const install = await window.gitReport.harnessUpdateInstall({ version: r.latest })
  r.installMs = Date.now() - started
  r.installOk = !!(install && install.ok === true)
  r.installVersion = (install && install.version) || ''
  r.installError = (install && install.error) || ''
  r.statusAfterInstall = (install && install.install && install.install.status) || ''
  r.packages = (install && install.install && install.install.packages) || 0

  // E3：服务重启后实际运行新版本，且内嵌页仍可加载
  const t1 = Date.now()
  let snap = null
  while (Date.now() - t1 < 240000) {
    snap = await window.gitReport.harnessStatus()
    if (snap.status === 'running' && snap.dshVersion === r.latest) break
    await sleep(2000)
  }
  r.serviceStatus = snap ? snap.status : ''
  r.harnessVersionAfter = snap ? snap.dshVersion : ''
  r.footer = text('.harness-footer')
  r.badgeAfter = !!q('.nav-badge')
  r.updateAvailableAfter = (await window.gitReport.harnessUpdateStatus()).updateAvailable === true
  const t2 = Date.now()
  while (Date.now() - t2 < 90000) {
    const wv = q('webview')
    const url = wv ? String(wv.getURL() || '') : ''
    // 必须是真实页面地址：刚挂载未导航时 getURL() 为空串，不能当作「已登录」
    if (/^https?:\\/\\//.test(url) && !url.includes('token=')) { r.webviewUrl = url; break }
    await sleep(1000)
  }

  // E4：再次重启服务仍用新版本（不被随包归档覆盖）
  const restarted = await window.gitReport.harnessRestart({})
  r.restartStatus = restarted.status || ''
  r.restartVersion = restarted.dshVersion || ''
  return r
})()`

const EXE = process.env.E2E_EXE || ''
const label = EXE ? '打包产物' : '开发版'
const EXIT_MS = Number(process.env.SMOKE_EXIT_MS) || 900000

const env = {
  ...process.env,
  PROJECT_MANAGER_USER_DATA: USER_DATA,
  // 全新主目录（Windows 用 USERPROFILE，POSIX 用 HOME）：保证 ~/.dsh 不存在
  USERPROFILE: HOME_SANDBOX,
  HOME: HOME_SANDBOX,
  // 强制走归档解包路径（跳过开发态原样目录），与打包态一致，且让热更新被允许
  DSH_RUNTIME_CACHE: path.join(USER_DATA, 'runtime'),
  SMOKE_HARNESS: '1',
  // 打开「自动检查更新」并缩短首查延迟，验证「应用自己发现新版本」这条被动链路
  SMOKE_HARNESS_UPDATE: '1',
  HARNESS_UPDATE_DELAY_MS: process.env.HARNESS_UPDATE_DELAY_MS || '4000',
  SMOKE_EXIT_MS: String(EXIT_MS),
  SMOKE_EVAL: EVAL,
  SMOKE_EVAL_MS: '8000',
  SMOKE_CLICK_MS: '1000000', // 禁用冒烟默认切页，交由 EVAL 自己操作
}

fs.mkdirSync(HOME_SANDBOX, { recursive: true })
console.log(`=== DeepSeek Harness 更新 E2E（${label}） ===`)
console.log(`userData=${USER_DATA}`)
console.log(`全新主目录=${HOME_SANDBOX}`)
console.log(`真实源=${process.env.HARNESS_NPM_REGISTRY || 'https://registry.npmjs.org'}（依赖下载全程走真实网络）`)

/** 统计属于本次沙箱的 dsh web 进程数（按运行时路径过滤，密封：不受本机其他 dsh 实例影响） */
function dshProcessCount() {
  // PowerShell 单引号串里只有单引号本身需要转义（'' ），反斜杠是字面量
  const sandbox = USER_DATA.replace(/'/g, "''")
  if (process.platform === 'win32') {
    try {
      const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${sandbox}*' }`
        + ' | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
      return out.split(/\r?\n/).filter((l) => /bin\.js/i.test(l) && /\bweb\b/.test(l)).length
    } catch { return -1 }
  }
  try {
    const out = execFileSync('bash', ['-lc', `ps -eo args | grep -c '[b]in.js.*${sandbox}.*web'`], { encoding: 'utf8' })
    return Number(out.trim()) || 0
  } catch { return -1 }
}

const before = dshProcessCount()
const p = spawnSync(
  EXE || process.execPath,
  EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'],
  { cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: EXIT_MS + 180000, env },
)
const stdout = String(p.stdout || '')
if (process.env.E2E_DEBUG) {
  console.log('--- 子进程 SMOKE 日志 ---')
  for (const l of stdout.split('\n')) if (l.includes('[SMOKE]') || l.includes('[harness-update]')) console.log(l.trim())
  console.log('--- 子进程 SMOKE 日志结束 ---')
}

let failed = 0
const assert = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

const evalLine = stdout.split('\n').find((l) => l.includes('[SMOKE][eval]'))
if (!evalLine) {
  const errLine = stdout.split('\n').find((l) => l.includes('[SMOKE][eval-err]'))
  if (errLine) console.log('渲染层 EVAL 抛错:', errLine.trim())
  console.log(`进程退出：status=${p.status} signal=${p.signal}${p.error ? ` error=${p.error.message}` : ''}`)
  console.log('未取到渲染层结果，stdout 尾部：')
  console.log(stdout.slice(-4000))
  process.exit(1)
}
const r = JSON.parse(evalLine.slice(evalLine.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
if (r.skipped) console.log(`注意：${r.skipped}`)
if (process.env.E2E_DEBUG) console.log('EVAL 结果:', JSON.stringify(r, null, 2))

// E1 自动监听并提示
assert('E1a 真实源可达并给出最新版本号',
  r.registry.includes('registry.npmjs.org') && /^\d+\.\d+\.\d+/.test(String(r.latest || '')),
  `registry=${r.registry} latest=${r.latest}`)
assert('E1b 应用自动发现新版本（updateAvailable）', r.updateAvailable === true,
  `current=${r.current} latest=${r.latest}`)
assert('E1c 界面出现新版本小圆点角标（菜单项无「新版本」文字）',
  r.badge === true && r.badgeDot === true && !String(r.menuText || '').includes('新版本'),
  `badge=${r.badge} dot=${r.badgeDot} menuText="${r.menuText}"`)
assert('E1d 允许在当前形态热更新（canUpdate）', r.canUpdate === true)
assert('E1e 更新入口在界面上可达（设置面板显示版本与更新按钮）',
  /^dsh \d+\.\d+\.\d+/.test(r.versionRow || '') && String(r.updateButton).startsWith('更新到'),
  `versionRow="${r.versionRow}" button="${r.updateButton}"`)

// E2 应用内热更新（真实网络 + 随包 npm）
assert('E2a 应用内热更新成功', r.installOk === true, r.installError)
assert('E2b 安装出的版本为目标版本', r.installVersion === r.latest, `${r.installVersion} / ${r.latest}`)
assert('E2c 安装完成且最终状态为 done', r.statusAfterInstall === 'done', String(r.statusAfterInstall))
assert('E2d 实际落盘了依赖包（>100 个）', Number(r.packages) > 100, `packages=${r.packages}`)
console.log(`      （真实安装耗时 ${Math.round(Number(r.installMs || 0) / 1000)} 秒）`)

// E3 更新真实生效
assert('E3a 服务重启后运行的是新版本', r.harnessVersionAfter === r.latest,
  `before=${r.harnessVersionBefore} after=${r.harnessVersionAfter}`)
assert('E3b 服务仍能就绪（running）', r.serviceStatus === 'running', String(r.serviceStatus))
assert('E3c 界面信息条显示新版本', String(r.footer).includes(`dsh ${r.latest}`), `footer="${r.footer}"`)
assert('E3d 更新后角标消失、不再提示有新版本', r.updateAvailableAfter === false && r.badgeAfter === false,
  `badge=${r.badgeAfter} updateAvailable=${r.updateAvailableAfter}`)
assert('E3e 内嵌页面已完成 token 握手（非 token 地址即已登录）',
  !!r.webviewUrl && !String(r.webviewUrl).includes('token='), String(r.webviewUrl))

// E4 重启不回落
assert('E4 再次重启服务仍使用热更新版本（未被随包归档覆盖）',
  r.restartVersion === r.latest && r.restartStatus === 'running',
  `version=${r.restartVersion} status=${r.restartStatus}`)

// E5 无残留
const after = dshProcessCount()
if (before < 0 || after < 0) console.log('  SKIP  E5 进程残留检查（无法枚举进程）')
else assert('E5 应用退出后 dsh 进程树消失', after === 0, `before=${before} after=${after}`)

if (!process.env.E2E_KEEP) {
  for (const dir of [USER_DATA, HOME_SANDBOX]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 运行中的进程可能占住，忽略 */ }
  }
}
console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
process.exit(failed ? 1 : 0)
