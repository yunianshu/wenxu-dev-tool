/**
 * E2E（真实 Electron + CDP 注入真实鼠标/键盘）：终端工作台的交互链路
 *
 * 为什么单独一个脚本：terminal-workbench-e2e.cjs 的断言全部绕过鼠标与键盘，
 * 它验证的是「窗格渲染出来、会话活着、布局落盘」。但窗格被分隔条盖住时，
 * 那些断言照样全绿——界面看着正常，点不动、打不了字。这类问题只有派发
 * 真实输入事件才能暴露，所以这里用 Chromium 调试协议（Input.dispatch*）
 * 注入真实鼠标点击与按键，走完整的 焦点 → xterm → IPC → pty → 回显 链路。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   I1 每个窗格矩形内的采样点都命中窗格自身（不被分隔条抢占）
 *   I2 点哪个窗格，键盘焦点就落在哪个窗格的终端上，该窗格高亮为聚焦态
 *   I3 键盘输入的命令只在被点窗格的会话里回显（不会串到别的窗格）
 *   I4 标题栏关闭按钮可点，点了真的关掉对应的 pty 会话
 *   I5 竖向与横向分隔条都能拖动，分别改变列宽与行高比例
 *   I6 恢复时跳过的失效窗格不会被回写覆盖（布局文件保留原样）
 *   I7 关窗格后切页、紧接着退出应用，这一步改动不丢（切页时立即落盘）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/terminal-workbench-interact-e2e.cjs
 *       E2E_EXE="release/<版本>/win-unpacked/开发项目管理.exe" node scripts/terminal-workbench-interact-e2e.cjs
 *       （带 E2E_EXE 跑打包产物，用于确认 asar 形态下交互同样正常）
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-interact-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9333

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = ['src', 'electron', 'scripts', 'dist'].map((dir, index) => ({
  id: `proj-${index + 1}`,
  name: `自测项目 ${index + 1}`,
  description: '',
  localPath: path.join(ROOT, dir),
  status: 'active',
  tags: [],
}))

fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))
fs.writeFileSync(path.join(USER_DATA, 'terminal-layout.json'), JSON.stringify({
  version: 1,
  gridMode: '2x2',
  columnWidths: [0.5, 0.5],
  rowHeights: [0.5, 0.5],
  panes: PROJECTS.map((p) => ({ projectId: p.id, shellId: '', title: '', width: 0.5 })),
  savedAt: Date.now(),
}, null, 2))

// ─── CDP 极简客户端（Node 24 自带 WebSocket） ───
class Cdp {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map() }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    const client = new Cdp(ws)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      const slot = client.pending.get(msg.id)
      if (!slot) return
      client.pending.delete(msg.id)
      if (msg.error) slot.reject(new Error(`${msg.error.message}（${JSON.stringify(msg.error.data || '')}）`))
      else slot.resolve(msg.result)
    })
    return client
  }

  send(method, params = {}) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (client_timeout_guard(this, id)) reject(new Error(`CDP 超时：${method}`))
      }, 15000).unref?.()
    })
  }

  /** 在页面里求值（自动 await Promise，按值返回） */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description || ''}`)
    return res.result.value
  }

  close() { try { this.ws.close() } catch { /* noop */ } }
}

function client_timeout_guard(client, id) {
  return client.pending.has(id)
}

// ─── 真实输入 ───
async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function drag(cdp, from, to, steps = 8) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  for (let i = 1; i <= steps; i += 1) {
    const x = from.x + ((to.x - from.x) * i) / steps
    const y = from.y + ((to.y - from.y) * i) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await new Promise((r) => setTimeout(r, 25))
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
}

/** 字符 → CDP 键描述（只用小写字母/数字/空格，避开修饰键） */
function keyInfo(ch) {
  if (ch === ' ') return { key: ' ', code: 'Space', vk: 32, text: ' ' }
  if (ch >= 'a' && ch <= 'z') return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), text: ch }
  if (ch >= '0' && ch <= '9') return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), text: ch }
  throw new Error(`未支持的字符：${ch}`)
}

async function typeText(cdp, text) {
  for (const ch of text) {
    const k = keyInfo(ch)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k.key, code: k.code,
      windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, text: k.text, unmodifiedText: k.text,
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    })
  }
}

async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    text: '\r', unmodifiedText: '\r',
  })
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
}

// ─── 启动与连接 ───
/** 指定则跑打包产物（win-unpacked/开发项目管理.exe），否则跑开发态 electron . */
const EXE = process.env.E2E_EXE || ''

function startApp(port = PORT) {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '90000',
    SMOKE_CLICK_MS: '800',        // 尽早切到终端工作台
    SMOKE_VIEW: '终端工作台',
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = EXE
    ? spawn(EXE, [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${port}`], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  return { child, log: () => log }
}

/** 停掉一个实例并等它真正退出：
 *  应用带单实例锁（app.requestSingleInstanceLock），上一个没退干净时
 *  下一个会直接 app.quit()、连窗口都不建，表现为调试端点等不到 */
async function stopApp(app, port) {
  try { app.child.kill() } catch { /* 已退出 */ }
  await new Promise((resolve) => {
    if (app.child.exitCode !== null || app.child.signalCode) return resolve()
    app.child.on('exit', resolve)
    setTimeout(resolve, 10000).unref?.()
  })
  for (let i = 0; i < 40; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`)
      await new Promise((r) => setTimeout(r, 250))
    } catch { break }   // 端口不再响应：实例已彻底退出
  }
}

async function waitForPage(port = PORT, child = null) {
  for (let i = 0; i < 60; i += 1) {
    if (child && child.exitCode !== null) {
      throw new Error(`应用进程已退出（exit=${child.exitCode}）：多半是上一个实例还占着单实例锁`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 端口还没起来 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等待渲染页调试端点超时')
}

async function waitFor(cdp, expression, label, timeout = 40000) {
  const start = Date.now()
  for (;;) {
    const value = await cdp.eval(expression)
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

const HELPERS = `
  window.__panes = () => [...document.querySelectorAll('.terminal-grid .term-pane')]
  window.__title = (p) => p.querySelector('.term-pane-title strong')?.textContent || ''
  /** 窗格内一个可靠的可点位置：终端区中心（避开 34px 标题栏与底部边缘） */
  window.__hitPoint = (p) => {
    const r = p.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.65) }
  }
  window.__focusPane = () => {
    const a = document.activeElement
    const pane = a && a.closest ? a.closest('.term-pane') : null
    return { cls: a ? String(a.className || '') : 'none', pane: pane ? window.__title(pane) : '' }
  }
  window.__sessions = async () => {
    const res = await window.gitReport.terminalList().catch(() => null)
    return (res?.sessions || []).map((s) => ({ id: s.id, projectId: s.projectId, pid: s.pid, exited: s.exited, shell: s.shellLabel }))
  }
  window.__outputs = async () => {
    const list = await window.__sessions()
    const out = {}
    for (const s of list) {
      const res = await window.gitReport.terminalAttach(s.id).catch(() => null)
      out[s.id] = res?.output || ''
    }
    return out
  }
`

async function main() {
  const app = startApp()
  let cdp = null
  try {
    const wsUrl = await waitForPage()
    cdp = await Cdp.connect(wsUrl)
    await cdp.send('Runtime.enable')
    // 渲染层错误收集（用于最后一条断言）
    await cdp.eval(`(() => {
      window.__e2eErrors = window.__e2eErrors || []
      if (!window.__e2eErrors.__bound) {
        window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message || e)))
        window.__e2eErrors.__bound = true
      }
      return true
    })()`)

    // 等终端工作台恢复出 4 个窗格
    await waitFor(cdp, `(() => { ${HELPERS}; return __panes().length === 4 })()`, '4 个窗格就绪')
    await new Promise((r) => setTimeout(r, 2500)) // 等会话与首屏输出稳定

    console.log('\n[I1] 每个窗格都能被点到（命中自身，未被分隔条抢占）')
    const hits = await cdp.eval(`(() => {
      ${HELPERS}
      return __panes().map((p, i) => {
        const r = p.getBoundingClientRect()
        let blocked = 0
        let by = ''
        for (let ry = 1; ry <= 3; ry += 1) {
          for (let rx = 1; rx <= 3; rx += 1) {
            const x = Math.round(r.x + (r.width * rx) / 4)
            const y = Math.round(r.y + (r.height * ry) / 4)
            const hit = document.elementFromPoint(x, y)
            if (!p.contains(hit)) { blocked += 1; by = String(hit?.className || hit?.tagName || '') }
          }
        }
        return { i, title: __title(p), blocked, by }
      })
    })()`)
    for (const h of hits) {
      check(`窗格「${h.title}」9 个采样点全部命中自身`, h.blocked === 0, h.blocked ? `${h.blocked}/9 被 ${h.by} 挡住` : '')
    }

    console.log('\n[I2] 点击窗格 → 键盘焦点落在该窗格')
    const titles = hits.map((h) => h.title)
    // 挑第 3 个窗格（右下角：修复前完全不可点）
    const targetIndex = 3
    const point = await cdp.eval(`(() => { ${HELPERS}; return __hitPoint(__panes()[${targetIndex}]) })()`)
    await click(cdp, point.x, point.y)
    await new Promise((r) => setTimeout(r, 600))
    const focus = await cdp.eval(`(() => { ${HELPERS}; return __focusPane() })()`)
    check(`点第 ${targetIndex + 1} 个窗格后焦点在该窗格`,
      focus.pane === titles[targetIndex] && /xterm-helper-textarea/.test(focus.cls),
      `焦点：${focus.cls} @ ${focus.pane || '无'}`)
    const focusedClass = await cdp.eval(`(() => { ${HELPERS}; return __panes()[${targetIndex}].className })()`)
    check('被点窗格高亮为聚焦态', /is-focused/.test(focusedClass), focusedClass)

    console.log('\n[I3] 输入的命令只在被点窗格的会话里回显')
    const marker = 'hitpane3ok'
    await typeText(cdp, `echo ${marker}`)
    await pressEnter(cdp)
    await new Promise((r) => setTimeout(r, 2500))
    const outputs = await cdp.eval(`(async () => { ${HELPERS}; return await __outputs() })()`)
    const sessions = await cdp.eval(`(async () => { ${HELPERS}; return await __sessions() })()`)
    const echoCount = Object.values(outputs).filter((o) => String(o).includes(marker)).length
    const byProject = {}
    for (const s of sessions) byProject[s.projectId] = String(outputs[s.id] || '').includes(marker)
    check('命令执行有回显（pty 真的收到了键盘输入）', echoCount >= 1,
      `含标记的会话数 ${echoCount}`)
    check('回显只出现在被点的窗格（未串到其他窗格）', echoCount === 1,
      Object.entries(byProject).map(([k, v]) => `${k}:${v ? '有' : '无'}`).join(' '))
    const echoedProject = Object.entries(byProject).find(([, v]) => v)?.[0]
    check('回显落在右下窗格绑定的项目上', echoedProject === 'proj-4', `实际 ${echoedProject}`)

    console.log('\n[I4] 标题栏关闭按钮可点，且真的关掉对应 pty 会话')
    const before = await cdp.eval(`(async () => { ${HELPERS}; return (await __sessions()).length })()`)
    const closeBtnPoint = await cdp.eval(`(() => {
      ${HELPERS}
      const pane = __panes()[${targetIndex}]
      const btn = [...pane.querySelectorAll('.term-pane-actions .term-mini')].pop()
      const r = btn.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: btn.getAttribute('title') }
    })()`)
    await click(cdp, closeBtnPoint.x, closeBtnPoint.y)
    await new Promise((r) => setTimeout(r, 1200))
    const after = await cdp.eval(`(async () => { ${HELPERS}; return (await __sessions()).length })()`)
    const paneCount = await cdp.eval(`(() => { ${HELPERS}; return __panes().length })()`)
    check('点关闭按钮后窗格减少一个', paneCount === 3, `剩 ${paneCount} 个窗格（按钮 title=${closeBtnPoint.title}）`)
    check('对应 pty 会话被真正关闭', after === before - 1, `${before} → ${after}`)

    console.log('\n[I5] 拖动分隔条改变比例')
    const beforeCols = await cdp.eval(`getComputedStyle(document.querySelector('.terminal-grid')).gridTemplateColumns`)
    const beforeRows = await cdp.eval(`getComputedStyle(document.querySelector('.terminal-grid')).gridTemplateRows`)
    // 取点避开两分隔条的 6px 交叉带：竖条在中点、横条在中列，恰好重叠在几何中心
    const sepV = await cdp.eval(`(() => {
      const el = document.querySelector('.term-splitter--v')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * 0.25) }
    })()`)
    const sepH = await cdp.eval(`(() => {
      const el = document.querySelector('.term-splitter--h')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width * 0.25), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (!sepV || !sepH) {
      check('存在竖向与横向分隔条', false, `v=${!!sepV} h=${!!sepH}`)
    } else {
      await drag(cdp, sepV, { x: sepV.x - 220, y: sepV.y })
      await new Promise((r) => setTimeout(r, 700))
      const afterCols = await cdp.eval(`getComputedStyle(document.querySelector('.terminal-grid')).gridTemplateColumns`)
      check('拖竖向分隔条改变列宽比例', beforeCols !== afterCols, `${beforeCols} → ${afterCols}`)

      await drag(cdp, sepH, { x: sepH.x, y: sepH.y - 120 })
      await new Promise((r) => setTimeout(r, 700))
      const afterRows = await cdp.eval(`getComputedStyle(document.querySelector('.terminal-grid')).gridTemplateRows`)
      check('拖横向分隔条改变行高比例', beforeRows !== afterRows, `${beforeRows} → ${afterRows}`)
    }

    const errors = await cdp.eval(`window.__e2eErrors || []`)
    check('全程无渲染层错误', (errors || []).length === 0, JSON.stringify(errors || []))

    // 必须先退干净：应用带单实例锁，旧实例还活着时新实例会直接退出
    await stopApp(app, PORT)

    console.log('\n[I6] 恢复时会跳过失效窗格，且不把布局文件回写成跳过后的样子')
    const layoutPath = path.join(USER_DATA, 'terminal-layout.json')
    const readLayout = () => JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
    fs.writeFileSync(layoutPath, JSON.stringify({
      ...readLayout(),
      gridMode: '2x2',
      columnWidths: [0.5, 0.5],
      rowHeights: [0.5, 0.5],
      panes: [
        { projectId: 'proj-1', shellId: '', title: '', width: 0.5 },
        { projectId: 'proj-2', shellId: '', title: '', width: 0.5 },
        { projectId: 'ghost-not-exist', shellId: '', title: '', width: 0.5 },
      ],
    }, null, 2))

    const second = startApp(PORT + 1)
    const cdp2 = await Cdp.connect(await waitForPage(PORT + 1, second.child))
    await cdp2.send('Runtime.enable')
    try {
      await waitFor(cdp2, `(() => { ${HELPERS}; return __panes().length === 2 })()`, '跳过失效窗格后恢复出 2 个窗格')
      await new Promise((r) => setTimeout(r, 2000)) // 超过 400ms 防抖窗口，观察是否会回写
      const after = readLayout()
      check('只渲染可用窗格', true, '2 个窗格')
      check('布局文件保留被跳过的窗格（未被覆盖成 2 个）', after.panes.length === 3,
        `文件 ${after.panes.length} 个窗格：${after.panes.map((p) => p.projectId).join(',')}`)

      console.log('\n[I7] 关窗格 → 切页 → 立刻退出应用，这一步改动不丢')
      const closePoint = await cdp2.eval(`(() => {
        ${HELPERS}
        const pane = __panes()[__panes().length - 1]
        const btn = [...pane.querySelectorAll('.term-pane-actions .term-mini')].pop()
        const r = btn.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)
      await click(cdp2, closePoint.x, closePoint.y)
      const panesNow = await cdp2.eval(`(() => { ${HELPERS}; return __panes().length })()`)
      await new Promise((r) => setTimeout(r, 120)) // 让 watch 装好防抖定时器，但远不到 400ms
      await cdp2.eval(`(() => {
        const m = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.includes('工作台'))
        if (m) m.click()
        return !!m
      })()`)
      await new Promise((r) => setTimeout(r, 150)) // 只给落盘 IPC 一个往返时间，不等防抖
      await stopApp(second, PORT + 1)
      check('切页后立刻退出，磁盘上已是切走前的窗格数',
        readLayout().panes.length === panesNow,
        `磁盘 ${readLayout().panes.length} 个，期望 ${panesNow} 个`)
    } finally {
      cdp2.close()
      await stopApp(second, PORT + 1)
    }

    console.log(`\n终端工作台交互 E2E：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
    console.log(`沙箱：${SANDBOX}`)
  } catch (err) {
    console.error('\n终端工作台交互 E2E 异常：', (err && err.stack) || err)
    console.error('应用日志尾部：')
    console.error(String(app.log()).split('\n').slice(-25).join('\n'))
    try { app.child.kill() } catch { /* noop */ }
    failed += 1
  } finally {
    cdp?.close()
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main().then(() => {
  // 失败时保留沙箱现场便于排查；成功时清理
  if (process.exitCode === 0) {
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  }
})
