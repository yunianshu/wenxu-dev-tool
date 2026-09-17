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
 *   I4 切换分屏方式（左右/上下/四宫格/三宫格/自动）后，每个窗格都留在可视区内
 *   I5 标题栏关闭按钮可点，点了真的关掉对应的 pty 会话
 *   I6 竖向与横向分隔条都能拖动，分别改变列宽与行高比例
 *   I7 页头投递到顶栏：标题与工具栏出现在顶栏、内容区不再有页内标题栏、
 *      插槽不是窗口拖拽区（按钮能被真实鼠标点到）、内容区吃到了省下的高度
 *   I8 Harness 页同样投递（打包态跳过：首次进入会解包内置运行时，分钟级）；
 *      来回切页顶栏不残留、普通页面的「当前项目」选择器恢复
 *   I9 恢复时跳过的失效窗格不会被回写覆盖，且「上下」4 行布局能原样还原
 *   I10 关窗格后切页、紧接着退出应用，这一步改动不丢（切页时立即落盘）
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

    console.log('\n[I4] 切换分屏方式：每个窗格都必须留在可视区内')
    for (const mode of ['左右', '上下', '四宫格', '三宫格', '自动']) {
      const clicked = await cdp.eval(`(() => {
        const btn = [...document.querySelectorAll('.terminal-toolbar .el-radio-button__inner')]
          .find((el) => el.textContent.trim() === '${mode}')
        if (btn) btn.click()
        return !!btn
      })()`)
      await new Promise((r) => setTimeout(r, 900))
      const sizes = await cdp.eval(`(() => { ${HELPERS}; return __panes().map((p) => {
        const r = p.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height), t: __title(p) }
      }) })()`)
      const ok = clicked && sizes.length === 4 && sizes.every((s) => s.w > 40 && s.h > 40)
      check(`「${mode}」下 4 个窗格都在可视区`, ok,
        `按钮${clicked ? '已点' : '未找到'}，各窗格尺寸 ${sizes.map((s) => `${s.w}×${s.h}`).join(' ')}`)
      const blocked = await cdp.eval(`(() => { ${HELPERS}; return __panes().reduce((n, p) => {
        const r = p.getBoundingClientRect()
        let bad = 0
        for (let ry = 1; ry <= 3; ry += 1) for (let rx = 1; rx <= 3; rx += 1) {
          const hit = document.elementFromPoint(Math.round(r.x + r.width * rx / 4), Math.round(r.y + r.height * ry / 4))
          if (!p.contains(hit)) bad += 1
        }
        return n + bad
      }, 0) })()`)
      check(`「${mode}」下窗格未被盖住`, blocked === 0, `被抢占 ${blocked}/36`)
    }

    console.log('\n[I5] 标题栏关闭按钮可点，且真的关掉对应 pty 会话')
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

    console.log('\n[I6] 拖动分隔条改变比例')
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

    console.log('\n[I7] 页头投递到顶栏：结构、拖拽区与真实点击')
    const topbar = await cdp.eval(`(() => {
      const slot = document.querySelector('#app-topbar-slot')
      const grid = document.querySelector('.terminal-grid')
      const area = document.querySelector('.content-area')
      const g = grid ? grid.getBoundingClientRect() : null
      const a = area.getBoundingClientRect()
      const boxes = [...document.querySelectorAll('.terminal-grid .term-pane')].map((el) => el.getBoundingClientRect())
      return {
        slotExists: !!slot,
        slotTitle: slot?.querySelector('.topbar-page-title')?.textContent || '',
        slotHasToolbar: !!slot?.querySelector('.terminal-toolbar'),
        anyProjectSwitcher: !!document.querySelector('.app-topbar .project-select'),
        // 插槽容器**故意保持可拖拽**（整条 no-drag 会让顶栏中间大片空白拖不动窗口），
        // 需要退出拖拽区的是里面的控件：断言按钮而不是插槽本身
        addBtnRegion: slot?.querySelector('.terminal-toolbar .el-button')
          ? String(getComputedStyle(slot.querySelector('.terminal-toolbar .el-button')).webkitAppRegion) : '',
        titleRegion: slot?.querySelector('.topbar-page-title')
          ? String(getComputedStyle(slot.querySelector('.topbar-page-title')).webkitAppRegion) : '',
        pageHeaderInContent: !!document.querySelector('.content-area .page-header'),
        gridTopOffset: g ? Math.round(g.top - a.top) : -1,
        gridHeight: g ? Math.round(g.height) : -1,
        areaHeight: Math.round(a.height),
        // 网格相对内容区的四边留白：四个方向必须一样宽
        inset: g ? {
          left: Math.round(g.left - a.left), top: Math.round(g.top - a.top),
          right: Math.round(a.right - g.right), bottom: Math.round(a.bottom - g.bottom),
        } : null,
        // 窗格之间的间隙：横向取第 1|2 格，纵向取第 1|3 格
        paneGapH: boxes[1] ? Math.round(boxes[1].left - boxes[0].right) : -1,
        paneGapV: boxes[2] ? Math.round(boxes[2].top - boxes[0].bottom) : -1,
      }
    })()`)
    check('顶栏出现插槽容器', topbar.slotExists)
    check('插槽里是该页标题', topbar.slotTitle === '终端工作台', `实际「${topbar.slotTitle}」`)
    check('插槽里是终端工具栏', topbar.slotHasToolbar)
    check('工具页不再显示「当前项目」选择器', !topbar.anyProjectSwitcher)
    // 顶栏整条是窗口拖拽区，只有控件退出拖拽区：按钮必须是 no-drag（点得动），
    // 标题保持 drag/继承（顶栏空白与标题文字上都能拖动窗口）
    check('插槽里的按钮退出拖拽区（点得动）', topbar.addBtnRegion === 'no-drag', `webkitAppRegion=${topbar.addBtnRegion}`)
    check('插槽标题仍是窗口拖拽区（能拖动窗口）', topbar.titleRegion !== 'no-drag', `webkitAppRegion=${topbar.titleRegion}`)
    check('内容区不再有页内标题栏', !topbar.pageHeaderInContent)
    check('终端网格吃到了省下的高度',
      topbar.gridTopOffset >= 0 && topbar.gridTopOffset <= 24 && topbar.gridHeight >= topbar.areaHeight - 60,
      `网格距内容区顶 ${topbar.gridTopOffset}px，网格高 ${topbar.gridHeight} / 内容区高 ${topbar.areaHeight}`)
    check('页面四边留白一致（左右与上下同宽）',
      !!topbar.inset && new Set(Object.values(topbar.inset)).size === 1, JSON.stringify(topbar.inset))
    check('窗格横竖间隙一致',
      topbar.paneGapH > 0 && topbar.paneGapH === topbar.paneGapV,
      `横向 ${topbar.paneGapH}px / 纵向 ${topbar.paneGapV}px`)

    // 真实点击顶栏里的「添加窗格」下拉：既验证按钮没被拖拽区吃掉，也验证弹层定位正常
    const beforeAdd = await cdp.eval(`(() => { ${HELPERS}; return __panes().length })()`)
    const addBtn = await cdp.eval(`(() => {
      const btn = document.querySelector('#app-topbar-slot .terminal-toolbar .el-button')
      if (!btn) return null
      const r = btn.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: !!btn.disabled }
    })()`)
    check('顶栏里的「添加窗格」按钮可用', !!addBtn && !addBtn.disabled, addBtn ? `位置 ${addBtn.x},${addBtn.y}` : '未找到按钮')
    if (addBtn) {
      await click(cdp, addBtn.x, addBtn.y)
      await new Promise((r) => setTimeout(r, 800))
      // 用 getBoundingClientRect 判可见：弹层是 fixed 定位，offsetParent 恒为 null
      const menu = await cdp.eval(`(() => {
        const items = [...document.querySelectorAll('.el-dropdown-menu__item')]
          .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
        const first = items[0]?.getBoundingClientRect()
        return {
          texts: items.map((el) => el.textContent.trim()),
          point: first ? { x: Math.round(first.x + first.width / 2), y: Math.round(first.y + first.height / 2) } : null,
        }
      })()`)
      check('点顶栏的「添加窗格」能弹出项目菜单', menu.texts.length > 0, `菜单：${menu.texts.join(' / ') || '（空）'}`)
      if (menu.point) {
        await click(cdp, menu.point.x, menu.point.y)
        await new Promise((r) => setTimeout(r, 1800))
      }
      const afterAdd = await cdp.eval(`(() => { ${HELPERS}; return __panes().length })()`)
      check('选项目后真的新增了一个窗格', afterAdd === beforeAdd + 1, `${beforeAdd} → ${afterAdd}`)
    }

    console.log('\n[I8] Harness 页同样投递；来回切页顶栏不残留')
    const gotoMenu = (label) => cdp.eval(`(() => {
      const m = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.includes('${label}'))
      if (m) m.click()
      return !!m
    })()`)
    if (EXE) {
      // 打包产物首次进入 Harness 会解包内置 dsh 运行时（tar.gz → runtime，分钟级），
      // 期间渲染层被卡住会让 CDP 求值超时。该页的投递逻辑与终端页共用同一套
      // 顶栏插槽机制，已在开发态验证；打包态这里只验证「离开工具页后插槽清空」。
      console.log('  SKIP  Harness 切页断言（打包产物首次进入会解包内置运行时，分钟级）')
    } else {
      await gotoMenu('DeepSeek Harness')
      await new Promise((r) => setTimeout(r, 2500))
      const harnessBar = await cdp.eval(`(() => {
        const slot = document.querySelector('#app-topbar-slot')
        return {
          title: slot?.querySelector('.topbar-page-title')?.textContent || '',
          buttons: [...(slot?.querySelectorAll('.harness-actions .el-button') || [])].map((b) => b.textContent.trim()),
          hasTerminalToolbar: !!slot?.querySelector('.terminal-toolbar'),
          pageHeaderInContent: !!document.querySelector('.content-area .page-header'),
        }
      })()`)
      check('Harness 页标题出现在顶栏', harnessBar.title === 'DeepSeek Harness', `实际「${harnessBar.title}」`)
      check('Harness 的操作按钮出现在顶栏', harnessBar.buttons.length > 0, harnessBar.buttons.join(' / '))
      check('顶栏不再残留终端页的工具栏', !harnessBar.hasTerminalToolbar)
      check('Harness 页内容区也不再有页内标题栏', !harnessBar.pageHeaderInContent)
    }

    await gotoMenu('工作台')
    // 等该页页头投递上来再断言（视图过渡是 out-in，固定延时偶尔会撞上中间态）
    await waitFor(cdp, `(() => {
      const t = document.querySelector('#app-topbar-slot .topbar-page-title')
      return t && t.textContent.trim() === '工作台'
    })()`, '工作台页头投递到顶栏')
    const plainPage = await cdp.eval(`(() => {
      const slot = document.querySelector('#app-topbar-slot')
      return {
        slotTitle: slot?.querySelector('.topbar-page-title')?.textContent.trim() || '',
        projectSwitcher: !!document.querySelector('.app-topbar .project-select'),
        projectBlockText: (slot?.textContent || '').includes('当前项目'),
        pageHeaderInContent: !!document.querySelector('.content-area .page-header'),
      }
    })()`)
    check('离开工具页后顶栏换成该页自己的标题', plainPage.slotTitle === '工作台', `实际「${plainPage.slotTitle}」`)
    check('顶栏不再有独立的「当前项目」块', !plainPage.projectSwitcher && !plainPage.projectBlockText)
    check('普通页面的内容区也没有页内标题栏', !plainPage.pageHeaderInContent)

    // 活动报告页同样把标题投递到顶栏（它按当前项目过滤，但顶栏不带项目控件）
    await gotoMenu('活动报告')
    await waitFor(cdp, `!!document.querySelector('.report-toolbar-card')`, '活动报告页渲染出工具条')
    const reportPage = await cdp.eval(`(() => {
      const card = document.querySelector('.report-toolbar-card')
      const area = document.querySelector('.content-area')
      const slot = document.querySelector('#app-topbar-slot')
      const c = card ? card.getBoundingClientRect() : null
      const a = area.getBoundingClientRect()
      return {
        slotTitle: slot?.querySelector('.topbar-page-title')?.textContent.trim() || '',
        hasProjectPick: !!slot?.querySelector('.topbar-project-select'),
        pageHeader: !!document.querySelector('.content-area .page-header'),
        cardTopOffset: c ? Math.round(c.top - a.top) : -1,
        cardLeftOffset: c ? Math.round(c.left - a.left) : -1,
      }
    })()`)
    check('活动报告页的标题也在顶栏', reportPage.slotTitle === '活动报告', `实际「${reportPage.slotTitle}」`)
    check('活动报告页不再有页内标题栏', !reportPage.pageHeader)
    // 该页的卡片直接铺到内容区边缘，左右留白靠自己的 padding（上下由内容区提供）
    check('活动报告的工具条不贴边',
      reportPage.cardTopOffset >= 16 && reportPage.cardLeftOffset >= 24,
      `距内容区 顶 ${reportPage.cardTopOffset}px / 左 ${reportPage.cardLeftOffset}px`)
    check('活动报告页顶栏不带项目控件（按你选的「不需要」）', !reportPage.hasProjectPick)

    await gotoMenu('终端工作台')
    await waitFor(cdp, `(() => { ${HELPERS}; return __panes().length > 0 })()`, '切回终端工作台')

    const errors = await cdp.eval(`window.__e2eErrors || []`)
    check('全程无渲染层错误', (errors || []).length === 0, JSON.stringify(errors || []))

    // 必须先退干净：应用带单实例锁，旧实例还活着时新实例会直接退出
    await stopApp(app, PORT)

    console.log('\n[I9] 恢复：跳过的失效窗格不被回写覆盖，「上下」4 行布局能原样还原')
    const layoutPath = path.join(USER_DATA, 'terminal-layout.json')
    const readLayout = () => JSON.parse(fs.readFileSync(layoutPath, 'utf8'))
    fs.writeFileSync(layoutPath, JSON.stringify({
      ...readLayout(),
      gridMode: '2x1',
      columnWidths: [1],
      rowHeights: [0.25, 0.25, 0.25, 0.25],
      panes: [
        { projectId: 'proj-1', shellId: '', title: '', width: 0.5 },
        { projectId: 'proj-2', shellId: '', title: '', width: 0.5 },
        { projectId: 'proj-3', shellId: '', title: '', width: 0.5 },
        { projectId: 'proj-4', shellId: '', title: '', width: 0.5 },
        { projectId: 'ghost-not-exist', shellId: '', title: '', width: 0.5 },
      ],
    }, null, 2))

    const second = startApp(PORT + 1)
    const cdp2 = await Cdp.connect(await waitForPage(PORT + 1, second.child))
    await cdp2.send('Runtime.enable')
    try {
      await waitFor(cdp2, `(() => { ${HELPERS}; return __panes().length === 4 })()`, '跳过失效窗格后恢复出 4 个窗格')
      await new Promise((r) => setTimeout(r, 2000)) // 超过 400ms 防抖窗口，观察是否会回写
      const after = readLayout()
      check('只渲染可用窗格', true, '4 个窗格（失效窗格被跳过）')
      check('布局文件保留被跳过的窗格（未被覆盖成 4 个）', after.panes.length === 5,
        `文件 ${after.panes.length} 个窗格：${after.panes.map((p) => p.projectId).join(',')}`)

      // 「上下」= 单列多行：每格占满整宽，高度约等于网格高度均分
      const boxes = await cdp2.eval(`(() => {
        ${HELPERS}
        const grid = document.querySelector('.terminal-grid').getBoundingClientRect()
        return {
          grid: { w: Math.round(grid.width), h: Math.round(grid.height) },
          panes: __panes().map((p) => { const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }),
        }
      })()`)
      const expectH = (boxes.grid.h - 3 * 6) / 4
      const stacked = boxes.panes.length === 4
        && boxes.panes.every((b) => b.w === boxes.grid.w && Math.abs(b.h - expectH) < 10)
      check('「上下」4 窗格重启后按 4 行竖排还原', stacked,
        `网格 ${boxes.grid.w}×${boxes.grid.h}，各格 ${boxes.panes.map((b) => `${b.w}×${b.h}`).join(' ')}，期望高约 ${Math.round(expectH)}`)

      console.log('\n[I10] 关窗格 → 切页 → 立刻退出应用，这一步改动不丢')
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
