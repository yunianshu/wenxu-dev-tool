/** 挂载真实 Vue setup，核对生成、确认、重复点击、切页和编辑后的方案失效。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const vue = require('vue')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { transformSync } = require('esbuild')

async function main() {
  const modules = new Map()
  function load(relative) {
    const filename = path.resolve(__dirname, '..', relative)
    if (modules.has(filename)) return modules.get(filename).exports
    const mod = new Module(filename, module)
    modules.set(filename, mod)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(path.dirname(filename))
    mod.require = id => {
      if (id === 'element-plus') return { ElMessage: { success() {} } }
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
    id: 'isolated-plan', staffName: '测试员工', totalHours: 0.5, entries: [entry],
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
  global.window = { gitReport: {
    leavePlan: async payload => { assert.equal(Object.getPrototypeOf(payload), Object.prototype); return { ok: true, plan: structuredClone(plan) } },
    leaveReplan: async payload => { replanCalls++; assert.equal(payload.planId, 'isolated-plan'); return { ok: true, plan: structuredClone(plan) } },
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
    finishSubmit({ ok: true, results: [{ date: '2026-10-15', status: 'success', message: '已提交' }], completed: true })
    await sending
    assert.equal(state.leave.submitting, false)
    assert.equal(setup.allSucceeded.value, true)
    setup.reviewVisible.value = true
    await setup.submit()
    assert.equal(submitCalls, 1, '已经使用的方案不能重发')
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
    assert.deepEqual(setup.typeOverrides.value['2026-10-15'], { typeId: 'annual', typeName: '年假' })
    setup.setType({ date: '2026-10-15' }, '__auto__')
    assert.equal(setup.typeOverrides.value['2026-10-15'], undefined)
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
    console.log('一键请假界面自测通过：提交与解除标记的确认门、等待期、重复点击、切页状态与编辑失效。')
  } finally { app.unmount(); global.window = originalWindow }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
