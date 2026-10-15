// 发版校验（本机安装产物）：CDP 读 DOM —— 一键填报的提交记录状态配色与两个工时记录页签
// 跑之前先关掉运行中的实例，跑完恢复正常启动。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const EXE = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Personnel PLM', 'personnel-plm.exe')
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
const PORT = Number(process.env.PLM_CDP_PORT || 9227)
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
        const evaluate = (expression, timeout = 30000) => new Promise((resolve, reject) => {
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

/** 轮询直到表达式返回真值（平台取数要等真实网络） */
async function waitFor(evaluate, expression, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await evaluate(expression)
    if (value) return value
    if (Date.now() > deadline) return null
    sleep(2000)
  }
}

const ACTIVE_PANE = "document.querySelector('.fill-history .el-tab-pane:not([style*=\"display: none\"])')"
const tabButton = (label) => `([...document.querySelectorAll('.fill-history .el-tabs__item')].find(el => el.textContent.trim() === '${label}') || null)`

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

    // 进入一键填报页
    await evaluate(`([...document.querySelectorAll('.app-menu .el-menu-item')].find(el => el.textContent.trim() === '一键填报') || null)?.click(); true`)
    const tabsReady = await waitFor(evaluate, `!!document.querySelector('.fill-history .history-tabs')`)
    checks.push(['一键填报底部区域渲染为页签', !!tabsReady, String(!!tabsReady)])
    if (!tabsReady) return

    const labels = await evaluate(`[...document.querySelectorAll('.fill-history .el-tabs__item')].map(el => el.textContent.trim())`)
    checks.push([
      '页签为 提交记录 / 禅道工时记录 / 汉印工时记录',
      JSON.stringify(labels) === JSON.stringify(['提交记录', '禅道工时记录', '汉印工时记录']),
      JSON.stringify(labels),
    ])

    // 提交记录：成功绿色、失败仍红色（对比主题里的成功色与危险色）
    const colors = await evaluate(`(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--el-color-success)'
      document.body.appendChild(probe)
      const expectSuccess = getComputedStyle(probe).color
      probe.style.color = 'var(--danger)'
      const expectDanger = getComputedStyle(probe).color
      probe.remove()
      const panes = [...document.querySelectorAll('.fill-history .el-tab-pane')]
      const pane = panes.find((p) => getComputedStyle(p).display !== 'none')
      const rows = [...(pane?.querySelectorAll('.el-table__body tr') || [])]
      const find = (text) => {
        const row = rows.find((r) => r.querySelector('.log-status')?.textContent.trim() === text)
        return row ? { color: getComputedStyle(row.querySelector('.log-status')).color, text: row.querySelector('.log-status').textContent.trim() } : null
      }
      return { expectSuccess, expectDanger, ok: find('成功'), failed: find('失败'), rowCount: rows.length }
    })()`)
    checks.push(['提交记录里有成功行', !!colors.ok, JSON.stringify(colors.ok)])
    checks.push(['成功状态文字为主题成功色（绿色）', !!colors.ok && colors.ok.color === colors.expectSuccess, `${colors.ok?.color} vs ${colors.expectSuccess}`])
    checks.push(['失败状态文字仍为危险色', !colors.failed || colors.failed.color === colors.expectDanger, `${colors.failed?.color || '无失败行'} vs ${colors.expectDanger}`])

    // 禅道工时记录：切页签后才取数，表里应有真实记录
    await evaluate(`${tabButton('禅道工时记录')}?.click(); true`)
    const ztLoaded = await waitFor(evaluate, `(() => {
      const pane = ${ACTIVE_PANE}
      const rows = pane ? pane.querySelectorAll('.el-table__body tr').length : 0
      return rows > 0 ? rows : 0
    })()`)
    const zt = await evaluate(`(() => {
      const pane = ${ACTIVE_PANE}
      if (!pane) return null
      const first = pane.querySelector('.el-table__body tr')
      // 展开列占一个空单元格，只取有内容的单元格
      const cells = first ? [...first.querySelectorAll('td .cell')].map((c) => c.textContent.trim()).filter(Boolean) : []
      return { meta: pane.querySelector('.history-meta')?.textContent.trim() || '', alert: pane.querySelector('.el-alert__title')?.textContent.trim() || '', cells }
    })()`)
    checks.push(['禅道工时记录页签取到记录', !!ztLoaded, `行数 ${ztLoaded}`])
    checks.push(['禅道记录字段为 日期/任务/工时/说明', !!zt && /^\d{4}-\d{2}-\d{2}$/.test(zt.cells[0] || '') && /^#\d+ /.test(zt.cells[1] || '') && /h$/.test(zt.cells[2] || ''), JSON.stringify(zt?.cells)])
    checks.push(['禅道页签无错误提示', !!zt && !zt.alert, zt?.alert || ''])
    checks.push(['禅道页签标题给出条数', !!zt && /共 \d+ 条/.test(zt.meta), zt?.meta || ''])

    // 任务配色：同一页签里不同任务颜色不同，跨页签同一任务颜色一致，任务名与圆点同色
    const ztTasks = await evaluate(`(() => {
      const pane = ${ACTIVE_PANE}
      const list = []
      for (const cell of pane ? pane.querySelectorAll('.task-cell') : []) {
        const idText = cell.querySelector('.task-color')?.textContent.trim() || ''
        const name = cell.textContent.replace(/\\s+/g, ' ').trim().slice(idText.length).trim()
        const dot = cell.querySelector('.task-dot')
        if (idText && dot) list.push({ id: idText, name, color: getComputedStyle(dot).backgroundColor, textColor: getComputedStyle(cell.querySelector('.task-color')).color })
      }
      return list
    })()`)
    const ztColors = new Map(ztTasks.map((t) => [t.id, t.color]))
    checks.push([
      '禅道页签：不同任务用不同颜色',
      ztColors.size >= 2 && new Set(ztColors.values()).size === ztColors.size,
      `${ztColors.size} 个任务 / ${new Set(ztColors.values()).size} 种颜色`,
    ])
    checks.push([
      '禅道页签：任务标题与圆点同色',
      ztTasks.length > 0 && ztTasks.every((t) => t.textColor === t.color),
      ztTasks.map((t) => `${t.id}: ${t.textColor} vs ${t.color}`).slice(0, 2).join(' | '),
    ])
    const ztRowCells = await evaluate(`(() => {
      const pane = ${ACTIVE_PANE}
      const row = pane ? pane.querySelector('.el-table__body tr') : null
      if (!row) return []
      return [...row.querySelectorAll('td .cell')].map((c) => ({ text: c.textContent.trim().slice(0, 10), color: getComputedStyle(c).color }))
    })()`)
    console.log('禅道行各列文字色：', JSON.stringify(ztRowCells))

    // 记录行上的任务状态图标（已完成/已关闭的任务也会出现在工时记录里）
    const ztStatusIcons = await evaluate(`(() => {
      const pane = ${ACTIVE_PANE}
      const icons = [...(pane ? pane.querySelectorAll('.task-cell .task-status') : [])]
      return { count: icons.length, labels: [...new Set(icons.map((el) => el.getAttribute('aria-label') || ''))], missingTitle: icons.filter((el) => !el.getAttribute('title')).length }
    })()`)
    checks.push(['禅道工时记录行带状态图标', ztStatusIcons.count > 0, `图标 ${ztStatusIcons.count} 个`])
    checks.push([
      '状态图标标签为已知状态且带悬停提示',
      ztStatusIcons.labels.length > 0 && ztStatusIcons.labels.every((l) => ['未开始', '进行中', '已完成', '已暂停', '已取消', '已关闭'].includes(l)) && ztStatusIcons.missingTitle === 0,
      ztStatusIcons.labels.join('/'),
    ])
    checks.push([
      '工时记录里含已完成或已关闭的任务（可补填）',
      ztStatusIcons.labels.some((l) => l === '已完成' || l === '已关闭'),
      ztStatusIcons.labels.join('/'),
    ])

    // 汉印工时记录
    await evaluate(`${tabButton('汉印工时记录')}?.click(); true`)
    const hpLoaded = await waitFor(evaluate, `(() => {
      const pane = ${ACTIVE_PANE}
      const rows = pane ? pane.querySelectorAll('.el-table__body tr').length : 0
      return rows > 0 ? rows : 0
    })()`)
    const hp = await evaluate(`(() => {
      const pane = ${ACTIVE_PANE}
      if (!pane) return null
      const first = pane.querySelector('.el-table__body tr')
      const cells = first ? [...first.querySelectorAll('td .cell')].map((c) => c.textContent.trim()) : []
      const tasks = []
      for (const cell of pane.querySelectorAll('.task-cell')) {
        const name = cell.querySelector('.task-color')?.textContent.trim() || ''
        const dot = cell.querySelector('.task-dot')
        if (name && dot) tasks.push({ name, color: getComputedStyle(dot).backgroundColor, textColor: getComputedStyle(cell.querySelector('.task-color')).color })
      }
      return { meta: pane.querySelector('.history-meta')?.textContent.trim() || '', alert: pane.querySelector('.el-alert__title')?.textContent.trim() || '', cells, tasks }
    })()`)
    checks.push(['汉印工时记录页签取到记录', !!hpLoaded, `行数 ${hpLoaded}`])
    checks.push(['汉印记录字段为 日期/项目/任务/占比', !!hp && /^\d{4}-\d{2}-\d{2}$/.test(hp.cells[0] || '') && /%$/.test(hp.cells[3] || ''), JSON.stringify(hp?.cells)])
    checks.push(['汉印页签无错误提示', !!hp && !hp.alert, hp?.alert || ''])
    checks.push(['汉印页签标题给出窗口与条数', !!hp && /近 \d+ 天 · 共 \d+ 条/.test(hp.meta), hp?.meta || ''])
    const hpColors = new Map((hp?.tasks || []).map((t) => [t.name, t.color]))
    checks.push([
      '汉印页签：不同任务用不同颜色',
      hpColors.size >= 2 && new Set(hpColors.values()).size === hpColors.size,
      `${hpColors.size} 个任务 / ${new Set(hpColors.values()).size} 种颜色`,
    ])
    checks.push([
      '汉印页签：任务名与圆点同色',
      (hp?.tasks || []).length > 0 && (hp?.tasks || []).every((t) => t.textColor === t.color),
      (hp?.tasks || []).map((t) => `${t.name}: ${t.textColor} vs ${t.color}`).slice(0, 2).join(' | '),
    ])
    const sharedTask = ztTasks.find((t) => t.name && hpColors.has(t.name))
    checks.push([
      '同一任务在禅道/汉印两个页签颜色一致',
      !!sharedTask && sharedTask.color === hpColors.get(sharedTask.name),
      sharedTask ? `${sharedTask.name}: ${sharedTask.color} vs ${hpColors.get(sharedTask.name)}` : '两页签没有同名任务，无法比对',
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
