/** 挂载真实 Vue setup，核对方案状态、确认门以及北森窗口的收起和重开。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { transformSync } = require('esbuild')

async function main() {
  const messages = []
  const views = new Map()
  const createdViews = []
  const invokes = []
  const listeners = new Set()
  let listenDelay = null
  const emitClose = () => { for (const handler of [...listeners]) handler({ payload: null }) }
  class LoginWindow {
    constructor(label, options) {
      this.label = label; this.visible = options.visible !== false; this.hideCalls = 0; this.focusCalls = 0
      views.set(label, this); createdViews.push(this)
    }
    async once(event, handler) { if (event === 'tauri://created') queueMicrotask(handler); return () => {} }
    async show() { this.visible = true }
    async setFocus() { this.focusCalls++ }
    async hide() {
      this.hideCalls++
      if (this.failHide) throw new Error('隔离窗口隐藏失败')
      this.visible = false
    }
  }
  const modules = new Map()
  function load(relative) {
    const filename = path.resolve(__dirname, '..', relative)
    if (modules.has(filename)) return modules.get(filename).exports
    const mod = new Module(filename, module)
    modules.set(filename, mod)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(path.dirname(filename))
    mod.require = id => {
      if (id === 'element-plus') return { ElMessage: { success(message) { messages.push(message) } } }
      if (id === '@tauri-apps/api/core') return { invoke: async (command, args) => { invokes.push({ command, args }) } }
      if (id === '@tauri-apps/api/webviewWindow') return { WebviewWindow: LoginWindow, getAllWebviewWindows: async () => [...views.values()] }
      if (id === '@tauri-apps/api/event') return { listen: async (event, handler) => {
        assert.equal(event, 'leave-italent-closed')
        if (listenDelay) await listenDelay
        listeners.add(handler)
        return () => listeners.delete(handler)
      } }
      if (id.startsWith('.')) {
        let file = path.resolve(path.dirname(filename), id)
        if (!path.extname(file)) file += '.js'
        return load(path.relative(path.resolve(__dirname, '..'), file))
      }
      return Module.prototype.require.call(mod, id)
    }
    let source = fs.readFileSync(filename, 'utf8')
    if (filename.endsWith('.vue')) {
      const { descriptor, errors } = parse(source, { filename }); assert.equal(errors.length, 0)
      source = compileScript(descriptor, { id: filename }).content
    }
    mod._compile(transformSync(source, { format: 'cjs', target: 'node20' }).code, filename)
    return mod.exports
  }
  const { state } = load('src/store.js')
  const entry = { id: 'entry', date: '2026-10-15', typeId: 'annual', typeName: '年假', start: '2026-10-15 08:30', end: '2026-10-15 09:00', hours: 0.5 }
  const plan = {
    id: 'isolated-plan', staffName: '测试员工', totalHours: 0.5, entries: [entry], overrides: {},
    rows: [{ date: '2026-10-15', firstCard: '2026-10-15 09:00', lateMinutes: 30, status: 'ready', countLate: true, remainingLate: 0, allocations: [entry] }],
    balances: [
      { name: '调休假', id: 'comp', hours: 0, available: true, used: 0, remaining: 0 },
      { name: '年假', id: 'annual', hours: 4, available: true, used: 0.5, remaining: 3.5 },
      { name: '事假', id: 'personal', hours: null, unlimited: true, available: true, used: 0, remaining: null },
    ],
  }
  let submitCalls = 0
  let replanCalls = 0
  let resolveCalls = 0
  const submitPayloads = []
  let finishSubmit
  const copied = []
  const originalWindow = global.window
  global.window = { __TAURI_INTERNALS__: {}, gitReport: {
    leavePlan: async payload => { assert.equal(Object.getPrototypeOf(payload), Object.prototype); return { ok: true, plan: structuredClone(plan) } },
    leaveReplan: async payload => { replanCalls++; assert.equal(payload.planId, 'isolated-plan'); return { ok: true, plan: { ...structuredClone(plan), overrides: structuredClone(payload.overrides) } } },
    leaveSubmit: async payload => { submitCalls++; submitPayloads.push(payload); return new Promise(resolve => { finishSubmit = resolve }) },
    leaveResolve: async payload => { resolveCalls++; assert.deepEqual(payload, { planId: 'isolated-plan', markerId: 'isolated-marker', confirmedMissing: true }); return { ok: true, resolved: true } },
    leaveConnect: async () => ({ ok: true, connected: true, mode: 'embedded', loggedIn: false, bookmarklet: 'javascript:void(1)' }),
    copyText: async text => { copied.push(text); return true },
  } }
  const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  let setup
  const component = load('src/views/LeaveView.vue').default
  const mount = () => { const app = renderer.createApp({ setup() { setup = component.setup({}, { expose() {} }); return () => null } }); app.mount({}); return app }
  let app = mount()
  try {
    await setup.generate()
    assert.equal(submitCalls, 0, '生成方案不得提交')
    await setup.submit()
    assert.equal(submitCalls, 0, '确认弹窗未打开时不得提交')
    setup.openReview()
    await setup.replanPlan({ '2026-10-15': { countLate: false } })
    assert.equal(replanCalls, 1, '调整计算迟到/假种应走 replan')
    setup.dateReasons.value['2026-10-15'] = '家里有事'
    const sending = setup.submit()
    assert.equal(state.leave.submitting, true)
    await setup.submit()
    assert.equal(submitCalls, 1, '重复点击不能重复发起')
    assert.deepEqual(submitPayloads[0], { planId: 'isolated-plan', confirmed: true, dates: ['2026-10-15'], reasons: { '2026-10-15': '家里有事' } }, '确认时按天携带请假事由与所选日期')
    app.unmount(); app = mount()
    assert.equal(setup.plan.value.id, plan.id)
    assert.equal(setup.busy.value, true, '切换视图保留执行状态')
    finishSubmit({ ok: true, results: [{ date: '2026-10-15', status: 'success', message: '已提交' }], completed: true, plan: { ...structuredClone(plan), id: 'refreshed-plan', totalHours: 0, entries: [], rows: [{ ...structuredClone(plan.rows[0]), status: 'covered', reason: '已有审批中或已通过的请假覆盖', allocations: [] }] } })
    await sending
    assert.equal(state.leave.submitting, false)
    assert.equal(setup.allSucceeded.value, true)
    assert.equal(state.leave.plan.id, 'refreshed-plan', '提交后应用平台最新重算的方案')
    assert.equal(state.leave.consumed, false)
    setup.reviewVisible.value = true
    await setup.submit()
    assert.equal(submitCalls, 1, '已提交方案没有剩余条目，不能再次提交')
    await setup.generate()
    const marker = { id: 'isolated-marker', canRetry: true }
    setup.openResolve({ ...marker, canRetry: false })
    assert.equal(setup.resolveTarget.value, null, '等待期内不能解除标记')
    setup.openResolve(marker)
    await setup.resolvePending()
    assert.equal(resolveCalls, 0, '未勾选本人核查确认时不得解除标记')
    setup.resolveChecked.value = true
    await setup.resolvePending()
    assert.equal(resolveCalls, 1)
    assert.equal(submitCalls, 1, '解除标记和重新生成不得提交申请')
    assert.equal(setup.resolveTarget.value, null)
    assert.equal(setup.plan.value.id, plan.id, '解除后已重新生成方案')
    setup.openResolve(marker)
    setup.reviewVisible.value = true
    // 假种下拉显示当前实际生效的假种；单一假种直接显示，混合分段显示“自动”哨兵。
    assert.equal(setup.selectedTypeId({ date: '2026-10-15', allocations: [{ typeId: 'annual' }] }), 'annual')
    assert.equal(setup.selectedTypeId({ date: '2026-10-15', allocations: [{ typeId: 'comp' }, { typeId: 'annual' }] }), '__auto__')
    setup.setType({ date: '2026-10-15' }, 'annual')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(setup.typeOverrides.value['2026-10-15'].typeId, 'annual')
    setup.setType({ date: '2026-10-15' }, '__auto__')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(setup.typeOverrides.value['2026-10-15'].typeId, undefined)
    assert.ok(replanCalls >= 2, '调整假种会触发 replan 重算')
    await new Promise(resolve => setTimeout(resolve, 20))
    // 浏览器书签通道：不打开登录窗口也能拿到连接脚本，并可复制到剪贴板。
    await setup.showBookmarklet()
    assert.equal(setup.loginMode.value, 'bookmarklet')
    assert.equal(setup.loginWaiting.value, true)
    assert.equal(setup.bookmarkletHref.value, 'javascript:void(1)')
    await setup.copyBookmarklet()
    assert.deepEqual(copied, ['javascript:void(1)'])
    setup.stopLoginWatcher()
    setup.options.workStart = '09:00'
    await vue.nextTick()
    assert.equal(state.leave.plan, null)
    assert.equal(setup.reviewVisible.value, false)
    assert.equal(setup.resolveTarget.value, null)
    assert.equal(state.leave.results.length, 0)
    // 延迟重算、切页以及配置变化都不能恢复旧方案。
    await setup.generate()
    let finishReplan
    window.gitReport.leaveReplan = async () => new Promise(resolve => { finishReplan = resolve })
    const updating = setup.replanPlan({})
    assert.equal(setup.locked.value, true)
    app.unmount(); app = mount()
    assert.equal(setup.locked.value, true, '切页后仍保留重算锁')
    setup.options.workStart = '10:00'
    finishReplan({ ok: true, plan: structuredClone(plan) })
    await updating
    assert.equal(state.leave.plan, null, '旧响应不能复活配置变化前的方案')
    assert.equal(setup.locked.value, false)
    window.gitReport.leaveRestore = async () => ({ ok: true, plan: structuredClone(plan) })
    app.unmount(); app = mount()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.leave.plan, null, '配置变化后切页也不能重新恢复旧方案')

    // 接入真实业务服务，核对显式假种跨页面和后台恢复后仍可继续调整。
    const { LeaveService } = require('../electron/leave-service')
    const data = { staffId: 'staff-test', staffName: '测试员工', attendance: [{ id: 'a', date: '2026-10-15', firstCard: '2026-10-15 09:10:00', dayType: '1', remark: '' }], leaves: [], balances: [{ name: '调休假', id: 'comp', hours: 10, available: true }, { name: '年假', id: 'annual', hours: 10, available: true }] }
    let saved
    const planStore = { load: () => structuredClone(saved), save: value => { saved = structuredClone(value) }, clear: () => { saved = null } }
    let service = new LeaveService({ adapter: { read: async () => structuredClone(data) }, planStore, now: () => Date.parse('2026-10-15T06:00:00Z') })
    const generated = await service.plan({})
    const forced = await service.replan({ planId: generated.plan.id, overrides: { '2026-10-15': { typeId: 'annual', countLate: true } } })
    state.leave.plan = forced.plan
    app.unmount(); app = mount()
    let replanDone
    window.gitReport.leaveReplan = async payload => { replanDone = service.replan(payload); return { ok: true, ...await replanDone } }
    setup.setCountLate(state.leave.plan.rows[0], false)
    await replanDone; await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.leave.plan.entries[0].typeId, 'annual', '切页后更改迟到不能丢失手选年假')
    assert.equal(state.leave.plan.entries[0].hours, 1)
    service = new LeaveService({ adapter: { read: async () => structuredClone(data) }, planStore, now: () => Date.parse('2026-10-15T06:00:00Z') })
    state.leave.plan = null
    state.leave.invalidated = false // 模拟应用重启后的全新界面状态。
    window.gitReport.leaveRestore = async () => ({ ok: true, ...await service.restore() })
    app.unmount(); app = mount()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(setup.options.workStart, '08:30', '恢复时同步留存方案的工作时间')
    assert.equal(setup.typeOverrides.value['2026-10-15'].typeId, 'annual')
    setup.setCountLate(state.leave.plan.rows[0], true)
    await replanDone; await new Promise(resolve => setImmediate(resolve))
    assert.equal(state.leave.plan.entries[0].typeId, 'annual', '后台重启恢复后仍保留手选假种')

    // 使用真实 Vue 连接流程和隔离 Tauri 边界，不访问北森或创建真实申请。
    const realSetInterval = global.setInterval
    const realClearInterval = global.clearInterval
    const ticks = new Map()
    let nextTimer = 0
    global.setInterval = callback => { const id = ++nextTimer; ticks.set(id, callback); return id }
    global.clearInterval = id => ticks.delete(id)
    const poll = () => { assert.equal(ticks.size, 1); return [...ticks.values()][0]() }
    const notLoggedIn = async () => ({ ok: true, connected: true, mode: 'embedded', loggedIn: false, bookmarklet: 'javascript:void(1)' })
    window.gitReport.leaveConnect = notLoggedIn
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(listeners.size, 1, '切页必须移除旧窗口监听，当前仅保留一个监听')
      await setup.connect()
      const popup = views.get('leave-italent')
      assert.equal(popup.visible, true)
      assert.equal(setup.loginWaiting.value, true)
      assert.equal(createdViews.length, 1)

      for (let i = 0; i < 3; i++) {
        popup.visible = false // 隔离宿主的原生 × 收起结果；Rust 测试覆盖事件分流。
        emitClose()
        assert.equal(setup.loginWaiting.value, false, '原生 × 立即停止登录等待')
        assert.equal(ticks.size, 0)
        await setup.connect()
        assert.equal(popup.visible, true, '收起后再次连接能显示原窗口')
        assert.equal(createdViews.length, 1, '重复连接复用原窗口，保留登录会话')
      }
      assert.equal(popup.focusCalls, 3)
      assert.equal(invokes.length, 3)
      assert.ok(invokes.every(call => call.command === 'eval_in_webview' && call.args.label === 'leave-italent'))
      assert.equal(await setup.closeItalentWindow(), true, '界面收起按钮也能收起窗口')
      assert.equal(popup.visible, false)
      assert.equal(setup.loginWaiting.value, false)

      await setup.connect()
      let finishStatus
      window.gitReport.leaveConnect = () => new Promise(resolve => { finishStatus = resolve })
      const beforeLateReply = messages.length
      const polling = poll()
      popup.visible = false; emitClose()
      const hiddenAtClose = popup.hideCalls
      finishStatus({ ok: true, loggedIn: true, mode: 'embedded' })
      await polling
      assert.equal(setup.loginWaiting.value, false)
      assert.equal(popup.hideCalls, hiddenAtClose, '手动关闭后的旧登录响应不能再操作窗口')
      assert.equal(messages.length, beforeLateReply, '手动关闭后的旧响应不能弹登录成功提示')

      window.gitReport.leaveConnect = notLoggedIn
      views.delete('leave-italent'); emitClose() // 隔离隐藏失败后原生销毁的兜底路径。
      await setup.connect()
      const replacement = views.get('leave-italent')
      assert.notEqual(replacement, popup)
      assert.equal(createdViews.length, 2, '窗口被销毁后能重建')
      window.gitReport.leaveConnect = async () => ({ ok: true, loggedIn: true, mode: 'embedded' })
      await poll()
      assert.equal(replacement.visible, false, '登录成功后自动收起')
      assert.equal(setup.loginWaiting.value, false)
      assert.equal(messages.at(-1), '北森登录成功，窗口已收起')

      window.gitReport.leaveConnect = notLoggedIn
      await setup.connect()
      replacement.failHide = true
      assert.equal(await setup.closeItalentWindow(), false)
      assert.match(state.leave.error, /右上角 ×/)
      assert.equal(setup.loginWaiting.value, true, '主动收起失败仍保留重试入口')
      window.gitReport.leaveConnect = async () => ({ ok: true, loggedIn: true, mode: 'embedded' })
      await poll()
      assert.equal(setup.loginWaiting.value, false)
      assert.equal(messages.at(-1), '北森登录成功', '隐藏失败不能宣称已收起')
      replacement.visible = false; emitClose()
      replacement.failHide = false

      window.gitReport.leaveConnect = notLoggedIn
      await setup.showBookmarklet()
      emitClose()
      assert.equal(setup.loginWaiting.value, true, '北森子窗口关闭不能停止浏览器书签等待')
      setup.stopLoginWatcher()
      app.unmount()
      assert.equal(listeners.size, 0, '卸载后清理窗口监听')
      let finishListen
      listenDelay = new Promise(resolve => { finishListen = resolve })
      app = mount(); app.unmount()
      finishListen()
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(listeners.size, 0, '异步注册晚于卸载时也必须清理监听')
      listenDelay = null
      app = mount()
    } finally {
      setup.stopLoginWatcher()
      global.setInterval = realSetInterval
      global.clearInterval = realClearInterval
      window.gitReport.leaveConnect = notLoggedIn
    }

    const connectionArguments = []
    window.gitReport.leaveConnect = async (...args) => { connectionArguments.push(args); return notLoggedIn() }
    await setup.showBookmarklet()
    assert.deepEqual(connectionArguments, [[]], '书签入口恢复旧版无参数连接契约')
    setup.stopLoginWatcher()
    console.log('一键请假界面自测通过：旧连接契约、确认门、跨页重算锁、过期响应丢弃、手选假种恢复及北森窗口收起/重开/迟到响应/监听清理。')
  } finally { app.unmount(); global.window = originalWindow }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
