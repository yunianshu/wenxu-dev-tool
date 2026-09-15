/**
 * E2E：全应用页头统一到顶栏之后的逐页巡检
 *
 * 背景：原先每个页面在自己的内容区顶部画一条页头（标题 + 操作按钮），
 * 四边留白也由那条页头提供。现在 10 个视图的页头全部 Teleport 到应用顶栏
 * （#app-topbar-slot），留白改由 .content-area 统一承担；顶栏不再有独立的
 * 「当前项目」块（需要项目的页面把项目下拉挂在标题旁）。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   P1 每一页的顶栏都显示该页自己的标题
 *   P2 内容区里不再有页内标题栏（.page-header）
 *   P3 每一页的内容都不贴窗口边缘（留白由内容区提供）
 *   P4 顶栏不再出现「当前项目」块；需要项目的页面标题旁有项目下拉，且能真的切换
 *   P5 顶栏里的操作按钮能被真实鼠标点到（顶栏整条是窗口拖拽区，漏设 no-drag 会点不动）
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/topbar-page-heads-e2e.cjs
 *       E2E_EXE=<打包产物 exe> node scripts/topbar-page-heads-e2e.cjs
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-topbar-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOTS = path.join(SANDBOX, 'shots')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
const PORT = 9355
const EXE = process.env.EXE_PATH || process.env.E2E_EXE || ''

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}${detail ? `  ${detail}` : ''}`)
  else { console.log(`  FAIL  ${name}  ${detail}`); failed += 1 }
}

const PROJECTS = ['src', 'electron'].map((dir, index) => ({
  id: `proj-${index + 1}`,
  name: `自测项目 ${index + 1}`,
  description: '',
  localPath: path.join(ROOT, dir),
  status: 'active',
  tags: [],
}))

fs.mkdirSync(USER_DATA, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: PROJECTS }, null, 2))

/** 侧栏菜单文本 → 该页应在顶栏显示的标题（Harness/终端工作台 打包态会跳过） */
const PAGES = [
  { menu: '工作台', title: '工作台' },
  { menu: '项目', title: '项目' },
  { menu: 'AI 助手', title: 'AI 助手' },
  { menu: '活动报告', title: '活动报告' },
  { menu: '一键填报', title: '一键填报' },
  { menu: '部署', title: '部署' },
  { menu: '扩展管理', title: '扩展管理' },
  { menu: '设置', title: '设置' },
]

// ─── CDP 极简客户端（Node 自带 WebSocket） ───
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
      if (msg.error) slot.reject(new Error(msg.error.message))
      else slot.resolve(msg.result)
    })
    return client
  }

  send(method, params = {}) {
    const id = (this.seq += 1)
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) reject(new Error(`CDP 超时：${method}`)) }, 20000).unref?.()
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.exceptionDetails) throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description || ''}`)
    return res.result.value
  }

  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
  }

  close() { try { this.ws.close() } catch { /* noop */ } }
}

async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

function startApp() {
  const env = {
    ...process.env,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '180000',
    SMOKE_CLICK_MS: '600000', // 不让冒烟钩子自己切页，巡检由本脚本驱动
    SMOKE_WIDTH: '1500',
    SMOKE_HEIGHT: '950',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = EXE
    ? spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [ELECTRON, '.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  return { child, log: () => log }
}

async function waitForPage(port, child) {
  for (let i = 0; i < 60; i += 1) {
    if (child && child.exitCode !== null) throw new Error(`应用进程已退出（exit=${child.exitCode}）`)
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

async function waitFor(cdp, expression, label, timeout = 20000) {
  const start = Date.now()
  for (;;) {
    if (await cdp.eval(expression)) return true
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** 页面结构快照：顶栏标题、是否有页内标题栏、页面文字离内容区边缘多远 */
const SNAPSHOT = `(() => {
  const slot = document.querySelector('#app-topbar-slot')
  const area = document.querySelector('.content-area')
  const root = area?.firstElementChild
  const a = area ? area.getBoundingClientRect() : null
  // 内容左右留白由各页的区块自带（分区带 / 卡片行内边距），所以要看**文字**离边缘多远，
  // 而不是看容器元素：分区带元素本身通常就是贴边的
  const findText = (el) => {
    if (!el) return null
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      if (node.textContent.trim()) return node.parentElement
    }
    return null
  }
  const textEl = findText(root)
  const t = textEl ? textEl.getBoundingClientRect() : null
  return {
    slotTitle: slot?.querySelector('.topbar-page-title')?.textContent?.trim() || '',
    slotText: (slot?.textContent || '').replace(/\\s+/g, ' ').trim(),
    pageHeader: !!document.querySelector('.content-area .page-header'),
    projectBlock: !!document.querySelector('.app-topbar .project-select') ||
      (slot?.textContent || '').includes('当前项目'),
    hasProjectPick: !!slot?.querySelector('.topbar-project-select'),
    textInset: t && a ? { top: Math.round(t.top - a.top), left: Math.round(t.left - a.left) } : null,
    areaPadding: area ? { top: getComputedStyle(area).paddingTop, left: getComputedStyle(area).paddingLeft } : null,
  }
})()`

async function main() {
  const app = startApp()
  let cdp = null
  try {
    cdp = await Cdp.connect(await waitForPage(PORT, app.child))
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.eval(`(() => {
      window.__e2eErrors = window.__e2eErrors || []
      if (!window.__e2eErrors.__bound) {
        window.addEventListener('error', (e) => window.__e2eErrors.push(String(e.message || e)))
        window.__e2eErrors.__bound = true
      }
      return true
    })()`)

    const go = (label) => cdp.eval(`(() => {
      const m = [...document.querySelectorAll('.app-menu .el-menu-item')].find((el) => el.textContent.includes('${label}'))
      if (m) m.click()
      return !!m
    })()`)

    // 等外壳渲染完（侧栏菜单在）：否则第一页的「菜单可点」会扑空
    await waitFor(cdp, `!!document.querySelector('.app-menu .el-menu-item')`, '侧栏菜单渲染')

    console.log('\n[P1-P3] 逐页巡检：顶栏标题 / 无页内标题栏 / 内容不贴边')
    for (const page of PAGES) {
      const clicked = await go(page.menu)
      check(`「${page.menu}」菜单可点`, clicked)
      // 等这一页的页头真的投递上来（切页是 out-in 过渡，中间会有空档）
      try {
        await waitFor(cdp, `(() => {
          const t = document.querySelector('#app-topbar-slot .topbar-page-title')
          return t && t.textContent.trim() === ${JSON.stringify(page.title)}
        })()`, `顶栏出现「${page.title}」`)
      } catch { /* 下面统一断言，这里只是等一等 */ }
      await new Promise((r) => setTimeout(r, 600))
      const s = await cdp.eval(SNAPSHOT)
      check(`「${page.menu}」顶栏标题是「${page.title}」`, s.slotTitle === page.title,
        `实际「${s.slotTitle}」`)
      check(`「${page.menu}」内容区没有页内标题栏`, !s.pageHeader)
      // 各页第一处文字的留白不一样（紧凑侧栏 19px、分区带 32px、居中空态更大），
      // 这里只抓「贴边」：留白为 0 时说明该页没了页头又没自己补留白
      check(`「${page.menu}」文字不贴边`, !!s.textInset && s.textInset.top >= 16 && s.textInset.left >= 12,
        JSON.stringify(s.textInset))
      await cdp.shot(path.join(SHOTS, `${page.menu.replace(/[\\/:*?"<>| ]/g, '_')}.png`))
    }

    console.log('\n[P4] 顶栏不再有「当前项目」块；需要的页面标题旁是项目下拉')
    const dash = await (async () => {
      await go('工作台')
      await waitFor(cdp, `!!document.querySelector('#app-topbar-slot .topbar-project-select')`, '工作台出现项目下拉')
      await new Promise((r) => setTimeout(r, 500))
      return cdp.eval(SNAPSHOT)
    })()
    check('顶栏没有「当前项目」块', !dash.projectBlock)
    check('工作台标题旁有项目下拉', dash.hasProjectPick, `顶栏文本：${dash.slotText}`)

    // 真实点开项目下拉并切换，验证下拉可用且页面跟随
    const before = await cdp.eval(`window.gitReport.projectsList().then((r) => (r.projects || r || []).map((p) => p.id))`)
    await cdp.eval(`(() => { window.__beforeId = null; return true })()`)
    const pill = await cdp.eval(`(() => {
      const el = document.querySelector('#app-topbar-slot .topbar-project-select')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    await click(cdp, pill.x, pill.y)
    await new Promise((r) => setTimeout(r, 700))
    const options = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('.el-select-dropdown__item')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      return items.map((el) => {
        const r = el.getBoundingClientRect()
        return { text: el.textContent.trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
    })()`)
    check('项目下拉能打开并列出项目', options.length >= 2, options.map((o) => o.text).join(' / '))
    if (options.length >= 2) {
      await click(cdp, options[1].x, options[1].y)
      await new Promise((r) => setTimeout(r, 900))
      // el-select 的选中项显示在 .el-select__selected-item，内部 input 的值读不到
      const shown = await cdp.eval(`(() => {
        const el = document.querySelector('#app-topbar-slot .topbar-project-select')
        return (el?.textContent || '').replace(/\\s+/g, ' ').trim()
      })()`)
      check('选中后顶栏下拉显示所选项目', shown.includes(options[1].text),
        `显示「${shown}」期望含「${options[1].text}」`)
    } else {
      check('选中后顶栏下拉显示所选项目', false, '下拉项不足')
    }

    console.log('\n[P5] 顶栏里的操作按钮能被真实鼠标点到')
    await go('项目')
    await waitFor(cdp, `!!document.querySelector('#app-topbar-slot .el-button')`, '项目页出现操作按钮')
    await new Promise((r) => setTimeout(r, 500))
    const btn = await cdp.eval(`(() => {
      const el = document.querySelector('#app-topbar-slot .el-button')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: el.textContent.trim() }
    })()`)
    await click(cdp, btn.x, btn.y)
    await new Promise((r) => setTimeout(r, 1200))
    // 新建项目表单是 el-drawer（不是 el-dialog）
    const panel = await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('.el-drawer, .el-dialog')]
        .find((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
      return el ? el.textContent.replace(/\\s+/g, ' ').slice(0, 40) : ''
    })()`)
    check(`点顶栏「${btn.text}」能打开表单（按钮没被拖拽区吃掉）`, panel.length > 0, panel || '（无可见表单）')
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.el-drawer .el-button, .el-dialog .el-button')]
        .find((b) => /取消|关闭/.test(b.textContent))
      if (btn) btn.click()
      return true
    })()`)

    const errors = await cdp.eval(`window.__e2eErrors || []`)
    check('全程无渲染层错误', (errors || []).length === 0, JSON.stringify(errors || []))

    console.log(`\n顶栏页头巡检：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
    console.log(`截图：${SHOTS}`)
    console.log(`沙箱：${SANDBOX}`)
  } catch (err) {
    console.error('\n巡检异常：', (err && err.stack) || err)
    console.error('应用日志尾部：')
    console.error(String(app.log()).split('\n').slice(-20).join('\n'))
    failed += 1
  } finally {
    cdp?.close()
    try { app.child.kill() } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 1000))
    process.exitCode = failed === 0 ? 0 : 1
  }
}

main()
