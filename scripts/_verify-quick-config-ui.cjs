// 发版校验（本机安装产物）：极简部署配置 UI —— 配置方式切换、极简视图三项输入、取消不落盘
// 只读校验：切换视图后点「取消」回滚；哈希基线取在抽屉打开之后（避开应用启动期的一次性写回），
// 对比「抽屉打开后 vs 取消后」，绝不写用户配置。
// 需要本机已安装目标版本；会先关闭正在运行的实例，跑完再正常启动一次。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const crypto = require('crypto')

const EXE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Personnel PLM', 'personnel-plm.exe')
const DEPLOY_JSON = path.join(process.env.APPDATA || os.homedir(), 'dev-project-manager', 'deploy-projects.json')
const PORT = Number(process.env.PLM_CDP_PORT || 9225)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const fileHash = () => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(DEPLOY_JSON)).digest('hex') } catch { return 'missing' }
}

function runningPids() {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', "&{ $p = Get-Process personnel-plm -ErrorAction SilentlyContinue; if ($p) { ($p | ForEach-Object { $_.Id }) -join ',' } }"], { encoding: 'utf8' })
  return String(out.stdout || '').trim().split(',').map(Number).filter(Boolean)
}

function closeApp() {
  if (!runningPids().length) return
  spawnSync('taskkill', ['/IM', 'personnel-plm.exe'], { stdio: 'pipe' })
  for (let i = 0; i < 20 && runningPids().length; i++) sleep(500)
  if (runningPids().length) {
    spawnSync('taskkill', ['/F', '/IM', 'personnel-plm.exe'], { stdio: 'pipe' })
    for (let i = 0; i < 20 && runningPids().length; i++) sleep(500)
  }
}

async function withPage(fn) {
  for (let i = 0; i < 60; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
      const page = pages.find((item) => item.url.startsWith('http://tauri.localhost/'))
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve)
          socket.addEventListener('error', reject)
        })
        let id = 0
        const evaluate = (expression, timeout = 20000) => new Promise((resolve, reject) => {
          const messageId = ++id
          const timer = setTimeout(() => reject(new Error('CDP 求值超时')), timeout)
          const onMessage = (event) => {
            const message = JSON.parse(event.data)
            if (message.id !== messageId) return
            socket.removeEventListener('message', onMessage)
            clearTimeout(timer)
            if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.exception?.description || 'CDP 异常'))
            else resolve(message.result?.result?.value)
          }
          socket.addEventListener('message', onMessage)
          socket.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }))
        })
        try { return await fn(evaluate) } finally { socket.close() }
      }
    } catch { /* 页面还没就绪 */ }
    sleep(2000)
  }
  throw new Error('等待 Tauri 主页面超时')
}

async function main() {
  const checks = []
  console.log(`安装 exe：${EXE}`)
  console.log(`部署配置：${DEPLOY_JSON}（抽屉打开后 vs 取消后哈希必须一致）`)
  closeApp()
  sleep(2000)

  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env: { ...process.env, PLM_CDP_PORT: String(PORT), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: 'ignore', detached: true,
  })
  child.unref()

  // 第一段：切部署页 → 打开抽屉 → 验证配置方式选项（哈希基线在此之后取，避开启动期写回）
  const r1 = await withPage(async (evaluate) => {
    const wait = async (fn, ms = 15000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; sleep(300) }
      return null
    }
    const out = {}
    out.deployReady = await wait(async () => await evaluate("(() => { const m = [...document.querySelectorAll('.app-menu .el-menu-item')].find(el => el.textContent.includes('部署')); if (m) { m.click(); return true } return false })()"))
    await wait(async () => await evaluate("!!document.querySelector('.deploy-page .bar')"))
    out.hasProject = await evaluate("!!document.querySelector('.deploy-page .deploy-run-workspace')")
    // 「部署设置」按钮经 Teleport 挂在应用顶栏，不在 .deploy-page 子树内：全文档查找
    out.drawerOpened = await wait(async () => await evaluate("(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('部署设置')); if (b) { b.click(); return true } return false })()"))
    out.drawerVisible = await wait(async () => await evaluate("!!document.querySelector('.deploy-config-drawer .deploy-config-scroll')"))
    out.modeOptions = await evaluate("[...document.querySelectorAll('.deploy-config-drawer .el-radio-button')].map(el => el.textContent.trim())")
    return out
  })
  const hashBaseline = fileHash()

  // 第二段：切到极简配置（不保存）→ 验证三项视图 → 取消
  const r2 = await withPage(async (evaluate) => {
    const wait = async (fn, ms = 15000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; sleep(300) }
      return null
    }
    const out = {}
    out.quickSwitched = await evaluate("(() => { const b = [...document.querySelectorAll('.deploy-config-drawer .el-radio-button')].find(el => el.textContent.includes('极简配置')); if (b) { b.click(); return true } return false })()")
    sleep(600)
    out.quickView = await evaluate("(() => { const q = [...document.querySelectorAll('.deploy-config-drawer .f-row .f-label')].map(el => el.textContent.trim()); const hasServer = q.includes('部署服务器'); const hasPath = q.includes('项目地址'); const hasSync = q.includes('数据同步'); const noAdvanced = !q.includes('部署形态') && !q.includes('版本号') && !q.includes('Compose'); const noAdvancedCards = ![...document.querySelectorAll('.deploy-config-drawer .card-header span')].map(el => el.textContent).some(t => t.includes('数据库备份') || t.includes('健康检查') || t.includes('部署选项')); return { labels: q, hasServer, hasPath, hasSync, noAdvanced, noAdvancedCards } })()")
    out.quickPathInput = await evaluate("(() => { const rows = [...document.querySelectorAll('.deploy-config-drawer .f-row')]; const row = rows.find(r => r.querySelector('.f-label')?.textContent.trim() === '项目地址'); return !!(row && row.querySelector('input')) })()")
    out.cancelled = await evaluate("(() => { const b = [...document.querySelectorAll('.deploy-config-drawer button')].find(x => x.textContent.trim() === '取消'); if (b) { b.click(); return true } return false })()")
    // el-drawer 关闭后仅隐藏 overlay、保留面板 DOM：以 overlay 可见性判定开合
    out.drawerClosed = await wait(async () => await evaluate("(() => { const el = document.querySelector('.deploy-config-drawer .deploy-config-scroll'); if (!el) return true; const overlay = el.closest('.el-overlay'); return !overlay || getComputedStyle(overlay).display === 'none' })()"))
    return out
  })
  const hashAfter = fileHash()

  const assert = (name, cond, detail) => { if (cond) console.log(`  PASS  ${name}`); else { console.log(`  FAIL  ${name}  ${detail || ''}`); checks.push(name) } }
  assert('部署页与项目就绪', r1.deployReady && r1.hasProject)
  assert('部署设置抽屉可打开', r1.drawerOpened && r1.drawerVisible)
  assert('配置方式提供 极简配置/完整配置 两个选项', (r1.modeOptions || []).includes('极简配置') && (r1.modeOptions || []).includes('完整配置'), JSON.stringify(r1.modeOptions))
  assert('可切换到极简配置', r2.quickSwitched)
  assert('极简视图只含 部署服务器/项目地址/数据同步 三项', r2.quickView && r2.quickView.hasServer && r2.quickView.hasPath && r2.quickView.hasSync, JSON.stringify(r2.quickView && r2.quickView.labels))
  assert('极简视图隐藏部署形态/版本号/数据库/健康检查等高级配置', r2.quickView && r2.quickView.noAdvanced && r2.quickView.noAdvancedCards, JSON.stringify(r2.quickView && r2.quickView.labels))
  assert('服务器项目地址输入框存在', r2.quickPathInput)
  assert('取消后抽屉关闭', r2.cancelled && r2.drawerClosed)
  assert('部署配置文件未被改动（切换视图后取消，不落盘）', hashBaseline === hashAfter, `${hashBaseline} → ${hashAfter}`)

  closeApp()
  sleep(1500)
  const restart = spawn(EXE, [], { cwd: path.dirname(EXE), stdio: 'ignore', detached: true })
  restart.unref()
  console.log(checks.length ? `失败 ${checks.length} 项` : '极简部署配置 UI 校验：全部通过')
  process.exit(checks.length ? 1 : 0)
}

main().catch((e) => { console.error('校验脚本异常:', e.message); closeApp(); process.exit(1) })
