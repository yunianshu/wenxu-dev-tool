// 发版校验（本机安装产物）：CDP 驱动「绑定禅道任务」抽屉，检查任务状态用小图标表示
// 流程：切到昨天 → 生成报告（只读采集）→ 打开绑定抽屉 → 检查状态图标与筛选
// 跑之前先关掉运行中的实例，跑完恢复正常启动。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const EXE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Personnel PLM', 'personnel-plm.exe')
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
const PORT = Number(process.env.PLM_CDP_PORT || 9229)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

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
        const evaluate = (expression, timeout = 60000) => new Promise((resolve, reject) => {
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

async function waitFor(evaluate, expression, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression)
    if (value) return value
    if (Date.now() > deadline) return null
    sleep(2000)
  }
}

/** 抽屉里的行：任务标题 + 状态图标（aria-label 即状态文字）+ 说明 */
const DRAWER_ROWS = `(() => {
  return [...document.querySelectorAll('.bind-tasks .bind-task')].map((row) => {
    const status = row.querySelector('.task-status')
    const icon = status ? status.querySelector('svg') : null
    return {
      title: row.querySelector('strong')?.textContent.trim() || '',
      status: status ? status.getAttribute('aria-label') || '' : '',
      title_attr: status ? status.getAttribute('title') || '' : '',
      icon: icon ? icon.innerHTML.replace(/\\s+/g, ' ').trim() : '',
      meta: row.querySelector('.task-meta')?.textContent.trim() || '',
    }
  })
})()`

async function main() {
  const checks = []
  console.log(`安装 exe：${EXE}`)
  closeApp()
  sleep(2000)

  const child = spawn(EXE, [], {
    cwd: path.dirname(EXE),
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  child.unref()
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })

  await withPage(async (evaluate) => {
    const version = await evaluate("document.querySelector('.sidebar-version .version-num')?.textContent || ''")
    checks.push([`侧栏版本号 v${APP_VERSION}`, version === `v${APP_VERSION}`, version])

    await evaluate(`([...document.querySelectorAll('.app-menu .el-menu-item')].find(el => el.textContent.trim() === '一键填报') || null)?.click(); true`)
    await waitFor(evaluate, `!!document.querySelector('.fill-page')`)

    // 切到昨天（有提交记录的一天），再生成报告
    await evaluate(`(document.querySelector('.fill-date input') || null)?.click(); true`)
    sleep(800)
    await evaluate(`([...document.querySelectorAll('.el-picker-panel__shortcut')].find(el => el.textContent.trim() === '昨天') || null)?.click(); true`)
    sleep(800)
    // 页头按钮被 Teleport 到顶栏插槽，不在页面容器里
    const dateValue = await evaluate("document.querySelector('.fill-date input')?.value || ''")
    const buttonText = await evaluate("(document.querySelector('#app-topbar-slot .page-primary') || document.querySelector('.page-primary'))?.textContent.trim() || ''")
    console.log(`当前填报日期：${dateValue}｜页头按钮：${buttonText}`)
    await evaluate(`(document.querySelector('#app-topbar-slot .page-primary') || document.querySelector('.page-primary') || null)?.click(); true`)
    const planned = await waitFor(evaluate, `document.querySelectorAll('.fill-detail .prow').length || 0`, 120000)
    checks.push(['生成报告后出现项目明细行', !!planned, `行数 ${planned}`])
    if (!planned) return

    await evaluate(`(document.querySelector('.fill-detail .bind-button') || null)?.click(); true`)
    const opened = await waitFor(evaluate, `document.querySelectorAll('.bind-tasks .bind-task').length || 0`, 60000)
    checks.push(['绑定抽屉列出禅道任务', !!opened, `行数 ${opened}`])
    if (!opened) return

    const rows = await evaluate(DRAWER_ROWS)
    const known = ['未开始', '进行中', '已完成', '已暂停', '已取消', '已关闭']
    checks.push([
      '每个任务都有状态图标（可访问名即状态文字）',
      rows.length > 0 && rows.every((r) => known.includes(r.status) && r.icon),
      rows.slice(0, 3).map((r) => `${r.title.slice(0, 12)}=${r.status}`).join(' | '),
    ])
    checks.push(['状态图标带悬停提示（title 同状态文字）', rows.every((r) => r.title_attr === r.status), rows.slice(0, 2).map((r) => `${r.status}/${r.title_attr}`).join(' ')])

    const byStatus = new Map()
    for (const r of rows) if (!byStatus.has(r.status)) byStatus.set(r.status, r.icon)
    checks.push([
      '不同状态用不同图标',
      byStatus.size >= 2 && new Set(byStatus.values()).size === byStatus.size,
      [...byStatus.keys()].join('/'),
    ])
    checks.push([
      '说明列不再重复状态文字，只留剩余工时或完成时间',
      rows.every((r) => /^剩余 [\d.]+h$/.test(r.meta) || /^完成于 \d{4}-\d{2}-\d{2}$/.test(r.meta) || r.meta === ''),
      rows.slice(0, 3).map((r) => `${r.status}→"${r.meta}"`).join(' | '),
    ])

    // 已完成筛选：已完成/已关闭的任务仍在列表里（可继续补填工时）
    await evaluate(`(document.querySelector('.bind-status input') || null)?.click(); true`)
    sleep(800)
    await evaluate(`([...document.querySelectorAll('.el-select-dropdown__item')].find(el => el.textContent.trim().startsWith('已完成')) || null)?.click(); true`)
    sleep(1200)
    const finished = await evaluate(DRAWER_ROWS)
    checks.push([
      '筛已完成仍列出已完成任务（可继续补填工时）',
      finished.length > 0 && finished.every((r) => r.status === '已完成' || r.status === '已关闭'),
      finished.slice(0, 3).map((r) => `${r.title.slice(0, 12)}=${r.status}`).join(' | ') || '空',
    ])
  })

  let pass = 0
  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail ? `(${detail})` : ''}`)
    if (ok) pass += 1
  }
  if (stderr.trim()) console.log(`stderr: ${stderr.trim().slice(0, 500)}`)

  closeApp()
  sleep(2000)
  const app = spawn(EXE, [], { cwd: path.dirname(EXE), detached: true, stdio: 'ignore' })
  app.unref()
  sleep(5000)
  console.log(`恢复正常启动：实例数 ${runningPids().length}`)
  console.log(`结果：${pass}/${checks.length} 项通过`)
  process.exit(pass === checks.length ? 0 : 1)
}

main().catch((error) => { console.error(`校验失败：${error.message}`); process.exit(2) })
