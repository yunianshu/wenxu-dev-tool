/** 一键请假：业务边界、确认门、失败中止、浏览器接口契约；全部使用隔离数据。 */
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LeaveService, createFileLedger, buildPlan, normalizeOptions, stamp } = require('../electron/leave-service')
const { italentPage } = require('../electron/italent-page')
const { ItalentBrowser } = require('../electron/italent-browser')
const { ItalentEmbedded } = require('../electron/italent-embedded')

const NOW = Date.parse('2026-10-15T06:00:00Z')
const OPTIONS = normalizeOptions({}, NOW)
const clone = (data) => JSON.parse(JSON.stringify(data))
const card = (day, time = '09:29:00', rest = {}) => ({ id: `att-${day}`, date: `2026-10-${day}`, firstCard: `2026-10-${day} ${time}`, lastCard: '', dayType: '1', remark: '', ...rest })
const leave = (day, rest = {}) => ({ id: `leave-${day}`, typeId: 'comp', typeName: '调休假', start: `2026-10-${day} 08:30`, end: `2026-10-${day} 09:29`, hoursText: '1小时', status: '2', revocation: '未销假', documentType: '1', ...rest })
const source = (attendance = [card('15')], comp = 1.5, annual = 36.5) => ({ staffId: 'staff-test', staffName: '测试员工', attendance, leaves: [], balances: [{ name: '调休假', id: 'comp', hours: comp, available: true }, { name: '年假', id: 'annual', hours: annual, available: true }] })
let passed = 0
async function test(name, run) { await run(); passed++; console.log(`✓ ${name}`) }

function setupService(data = source(), changes = {}) {
  let stored = []
  const calls = []
  const adapter = {
    connect: async () => ({ connected: true }),
    read: async () => clone(data),
    prepare: async ({ entry }) => ({ key: `prepared-${calls.length}`, start: entry.start, end: entry.end, hours: entry.hours, typeId: entry.typeId }),
    apply: async ({ key, confirmed }) => {
      assert.equal(confirmed, true)
      calls.push(key)
      const item = changes.appliedEntries[calls.length - 1]
      data.leaves.push(leave(item.date.slice(-2), { id: `new-${calls.length}`, typeId: item.typeId, typeName: item.typeName, start: item.start, end: item.end, hoursText: `${item.hours}小时` }))
      data.balances.find(balance => balance.id === item.typeId).hours -= item.hours
      return { sent: true }
    },
  }
  const ledger = { load: () => clone(stored), save: (rows) => { stored = clone(rows) } }
  const service = new LeaveService({ adapter, ledger, now: () => NOW, pause: async () => {} })
  return { service, adapter, data, calls, changes, ledger }
}

function pageFixture({ count = 2, balance = '1.5 小时', applyStatus = 200, applyError = '', pageFunction = italentPage } = {}) {
  const calls = []
  const att = 'Attendance.AttendanceStatistics'
  const vac = 'Attendance.AttendanceVacationInfo'
  let owner = 'staff-test'
  const field = (name, val, label = val) => ({ name, value: val, text: label })
  const metadataField = (name) => ({ cmp_data: { field_name: name, fieldChangeTriggerId: 'trigger-from-platform', datasourcename: 'Attendance.EveryVacationItems', refreshParams: 'StaffId={formData.StaffId}' } })
  const types = [{ text: '调休假', value: 'comp', isActive: '1', extAttr: { Remain: JSON.stringify([`余额 ${balance}`]) } }, { text: '年假', value: 'annual', isActive: '1', extAttr: { Remain: '["年假 36.5 小时"]' } }]
  const fetch = async (input, opts = {}) => {
    const url = new URL(input)
    const query = Object.fromEntries(url.searchParams)
    const applying = url.pathname.endsWith('/ApplyVacation')
    let body
    if (applying) {
      // 契约取自北森原生表单的实际拦截报文，校验接口与提交接口的编码不同。
      assert.equal(opts.headers['Content-Type'], 'application/x-www-form-urlencoded')
      const form = new URLSearchParams(opts.body)
      assert.deepEqual(Array.from(form.keys()), ['dataObject'])
      body = JSON.parse(form.get('dataObject'))
      assert.equal(query.navViewName, 'Attendance.EmployeeVacationNavView')
      assert.equal(body.checkRequired, false)
    } else body = opts.body ? JSON.parse(opts.body) : undefined
    calls.push({ path: url.pathname, query, body })
    let data
    if (url.pathname.endsWith('/IndexPage')) {
      const meta = query.metaObjName
      data = { sub_cmps: [{ cmp_type: 'SearchForm', cmp_data: { metaObjectName: meta, viewName: 'search-from-platform' }, biz_data: { staff: field(`${meta}.StaffId`, owner), date: field(`${meta}.SwipingCardDate`, '2026/01/01-2026/01/31') } }, { cmp_type: 'TableList', cmp_data: { metaObjName: meta, viewName: 'list-from-platform', paging: { capacity: 15, page: 0 }, sort_fields: [{ sort_column: 'SwipingCardDate', sort_dir: 'desc' }] } }] }
    } else if (url.pathname.endsWith('/TableList')) {
      assert.equal(query.viewName, 'list-from-platform')
      assert.equal(body.search_data.items[0].value, owner)
      const isAtt = query.metaObjName === att
      const size = isAtt ? count : 0
      const page = body.table_data.paging.page
      const rows = Array.from({ length: Math.max(0, Math.min(100, size - page * 100)) }, (_, index) => {
        const id = page * 100 + index
        return { _id: field('_id', `row-${id}`), StaffId: field('StaffId', owner), SwipingCardDate: field('SwipingCardDate', '2026/10/15'), ActualForFirstCard: field('ActualForFirstCard', '2026/10/15 09:29:00'), DateType: field('DateType', '1') }
      })
      data = { cmp_data: { paging: { total: size }, ext_data: { SortCursor: 'cursor-from-platform' } }, biz_data: rows }
    } else if (url.pathname.endsWith('/FormView')) {
      data = { cmp_name: 'Attendance_EmployeeVacationFormView', biz_data: [{ _id: field('_id', 'new-form-id'), StaffId: field('StaffId', owner), IsFirst: field('IsFirst', 'true') }], sub_cmps: ['OIdVacationType', 'VacationStartDateTime', 'VacationStopDateTime', 'VacationStartDate', 'VacationStopDate', 'StaffId', 'Description', 'VacationDurationIncludeUnit'].map(metadataField) }
    } else if (url.pathname.endsWith('/datasource')) {
      assert.equal(body[0].refreshParams, `StaffId=${owner}`)
      data = [{ fieldName: 'OIdVacationType', dataSourceResults: types }]
    } else if (url.pathname.endsWith('/FieldChange')) {
      assert.equal(body.currentChangedField.triggerID, 'trigger-from-platform')
      const values = Object.fromEntries(body.metaFields.map(item => [item.name, item.value]))
      const initial = body.currentChangedField.name === 'OIdVacationType'
      const start = initial ? '2026/10/15 08:30' : values.VacationStartDateTime
      const end = initial ? '2026/10/15 17:30' : values.VacationStopDateTime
      const hours = Math.ceil((stamp(end.replaceAll('/', '-')) - stamp(start.replaceAll('/', '-'))) / 1800000) / 2
      data = { targetToChangeFields: [field('VacationStartDateTime', start), field('VacationStopDateTime', end), field('VacationDurationIncludeUnit', `${hours}小时`), field('IsFirst', 'false')] }
    } else if (url.pathname.includes('/AgainVerify/')) {
      assert.equal(typeof body, 'object', '校验报文必须是 JSON 对象，不能重复编码')
      data = { IsBeyondEstablishment: 0, StrictControl: 0, flag: false, message: null, listMessage: null }
    } else if (url.pathname.endsWith('/ApplyVacation')) {
      assert.equal(typeof body, 'object', '提交报文必须是 JSON 对象')
      data = applyError ? { tipType: 'error', message: applyError } : { tipType: 'normalTip', param: 'queued-task' }
    } else throw new Error(`夹具未允许的请求：${url.pathname}`)
    const status = applying ? applyStatus : 200
    return { ok: status < 400, status, json: async () => data }
  }
  const context = { document: { readyState: 'complete' }, location: { origin: 'https://cloud.italent.cn' }, fetch, URL, URLSearchParams, AbortSignal, crypto: require('node:crypto').webcrypto, window: {} }
  const run = vm.runInNewContext(`(${pageFunction.toString()})`, context)
  return { calls, context, run, types, setOwner: (value) => { owner = value } }
}

async function main() {
  await test('默认本月至今天，按上海日期计算并拒绝无效日期、未来日期和跨夜班次', () => {
    assert.equal(normalizeOptions({}, Date.parse('2026-10-14T16:01:00Z')).until, '2026-10-15')
    assert.deepEqual([OPTIONS.since, OPTIONS.until, OPTIONS.workStart, OPTIONS.workEnd], ['2026-10-01', '2026-10-15', '08:30', '17:30'])
    for (const opts of [{ since: '2026-02-30' }, { until: '2026-10-16' }, { since: '2026-10-16' }, { workStart: '24:00' }, { workEnd: '08:00' }]) assert.throws(() => normalizeOptions(opts, NOW))
  })
  await test('先舍弃秒数再按半小时进位：29:59、30:59 计 0.5h，31:00 才计 1h', () => {
    for (const time of ['08:30:01', '08:30:59']) {
      const plan = buildPlan(source([card('15', time)]), OPTIONS)
      assert.equal(plan.totalHours, 0, time)
      assert.equal(plan.rows[0].reason, '未迟到', time)
    }
    for (const [time, hours, end] of [['08:31:00', 0.5, '08:31'], ['08:48:00', 0.5, '08:48'], ['08:59:59', 0.5, '08:59'], ['09:00:00', 0.5, '09:00'], ['09:00:01', 0.5, '09:00'], ['09:00:59', 0.5, '09:00'], ['09:01:00', 1, '09:01'], ['09:29:59', 1, '09:29'], ['09:30:59', 1, '09:30'], ['09:31:00', 1.5, '09:31']]) {
      const plan = buildPlan(source([card('15', time)]), OPTIONS)
      assert.equal(plan.totalHours, hours, time)
      assert.equal(plan.entries[0].end.slice(11), end, time)
      assert.equal(Number.isInteger(plan.rows[0].lateMinutes), true)
    }
  })
  await test('重复覆盖和假种拆分都使用舍弃秒数后的分钟终点', () => {
    const data = source([card('15', '09:00:59')], 0.5, 0)
    data.leaves.push(leave('15', { end: '2026-10-15 09:00', hoursText: '0.5小时' }))
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'covered')
    const plan = buildPlan(source([card('15', '09:30:59')], 0.5, 0.5), OPTIONS)
    assert.deepEqual(plan.entries.map(item => [item.typeName, item.hours, item.end]), [['调休假', 0.5, '2026-10-15 09:00'], ['年假', 0.5, '2026-10-15 09:30']])
  })
  await test('日期倒序、调休优先、跨假种拆分和余额守恒', () => {
    const plan = buildPlan(source([card('13'), card('15'), card('14')], 1.5, 1), OPTIONS)
    assert.deepEqual(plan.entries.map(item => [item.date, item.typeName, item.hours]), [['2026-10-15', '调休假', 1], ['2026-10-14', '调休假', 0.5], ['2026-10-14', '年假', 0.5]])
    assert.equal(plan.rows[2].status, 'blocked')
    assert.equal(plan.entries[1].end, plan.entries[2].start)
    assert.equal(plan.balances[0].remaining, 0)
    assert.equal(plan.balances[1].remaining, 0.5)
  })
  await test('不足半小时余额不挪用，单日不足整日阻止并保留余额', () => {
    const plan = buildPlan(source([card('15'), card('14', '08:48:00')], 0.75, 0), OPTIONS)
    assert.equal(plan.rows[0].status, 'blocked')
    assert.equal(plan.rows[1].status, 'ready')
    assert.equal(plan.totalHours, 0.5)
    assert.equal(plan.balances[0].remaining, 0.25)
  })
  await test('排除正常、休息日、缺卡和跨日首卡；补班工作日与未结算当天正常处理', () => {
    const plan = buildPlan(source([card('15'), card('14', '08:30:00'), card('13', '', { firstCard: '' }), card('12', '09:00:00', { dayType: '2' }), card('11', '09:00:00', { firstCard: '2026-10-12 09:00:00' }), card('10', '09:00:00', { status: '旷工' })]), OPTIONS)
    assert.deepEqual(plan.rows.map(item => item.status), ['ready', 'skipped', 'skipped', 'skipped', 'blocked', 'ready'])
  })
  await test('审批中、已通过和连续申请覆盖后跳过；部分重叠阻止；驳回可重报', () => {
    const data = source()
    data.leaves = [leave('15')]
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'covered')
    data.leaves[0].status = '1'
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'covered')
    data.leaves[0].end = '2026-10-15 09:00'
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'blocked')
    data.leaves.push(leave('15', { id: 'second', start: '2026-10-15 09:00' }))
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'covered')
    data.leaves.forEach(item => { item.status = '3' })
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'ready')
  })
  await test('考勤备注、损坏记录和同日多条数据不会生成重复请假', () => {
    assert.equal(buildPlan(source([card('15', '09:29:00', { remark: '年假 审批中' })]), OPTIONS).rows[0].status, 'blocked')
    assert.throws(() => buildPlan(source([card('15'), card('15')]), OPTIONS))
    const data = source(); data.leaves.push(leave('15', { end: '' }))
    assert.throws(() => buildPlan(data, OPTIONS))
  })
  await test('未确认、伪造方案和过期方案均不写入，客户端无法替换报文', async () => {
    const env = setupService()
    const { plan } = await env.service.plan({})
    await assert.rejects(env.service.submit({ planId: plan.id }), /确认/)
    await assert.rejects(env.service.submit({ planId: 'forged', confirmed: true }), /变化/)
    env.service.now = () => NOW + 11 * 60000
    await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true }), /过期/)
    assert.equal(env.calls.length, 0)
  })
  await test('确认前余额、首打卡或已有申请变化时停止，末打卡变化不影响迟到', async () => {
    for (const mutate of [data => { data.balances[0].hours = 0.5 }, data => { data.attendance[0].firstCard = '2026-10-15 09:30:00' }, data => { data.leaves.push(leave('15')) }]) {
      const env = setupService(); const { plan } = await env.service.plan({}); mutate(env.data)
      await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true }), /发生变化/)
      assert.equal(env.calls.length, 0)
    }
    const env = setupService(); const { plan } = await env.service.plan({}); env.changes.appliedEntries = plan.entries
    env.data.attendance[0].lastCard = '2026-10-15 18:30:00'
    const result = await env.service.submit({ planId: plan.id, confirmed: true, entries: [{ hours: 100 }] })
    assert.equal(result.completed, true)
    assert.equal(env.data.leaves[0].hoursText, '1小时')
    assert.deepEqual(env.ledger.load(), [])
    await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true }), /变化/)
  })
  await test('批量按倒序写入并回查，第二笔失败时保留第一笔成功并停止第三笔', async () => {
    const env = setupService(source([card('13'), card('15'), card('14')], 10))
    const { plan } = await env.service.plan({}); env.changes.appliedEntries = plan.entries
    const apply = env.adapter.apply
    env.adapter.apply = async (opts) => { if (env.calls.length === 1) throw new Error('连接中断'); return apply(opts) }
    const result = await env.service.submit({ planId: plan.id, confirmed: true })
    assert.deepEqual(result.results.map(item => item.status), ['success', 'unknown', 'notSubmitted'])
    assert.equal(env.calls.length, 1)
    assert.equal(env.data.leaves[0].start, '2026-10-15 08:30')
    assert.equal(env.ledger.load().length, 1)
    const again = await env.service.plan({})
    assert.equal(again.plan.rows.find(item => item.date === '2026-10-14').status, 'blocked')
  })
  await test('HTTP 接受后未能回查属于待核对，不能标记成功或自动重发', async () => {
    const env = setupService(); env.adapter.apply = async () => { env.calls.push('sent'); return { sent: true } }
    const { plan } = await env.service.plan({})
    const result = await env.service.submit({ planId: plan.id, confirmed: true })
    assert.equal(result.results[0].status, 'unknown')
    assert.equal(env.calls.length, 1)
    assert.equal(env.ledger.load().length, 1)
    assert.match(env.ledger.load()[0].message, /尚未确认/)
  })
  await test('发送前失败和平台明确拒绝不永久锁定日期，重新生成仍需确认', async () => {
    const env = setupService()
    env.adapter.apply = async () => { throw Object.assign(new Error('北森明确拒绝申请'), { submissionState: 'notSubmitted' }) }
    const { plan } = await env.service.plan({})
    const result = await env.service.submit({ planId: plan.id, confirmed: true })
    assert.equal(result.results[0].status, 'failed')
    assert.deepEqual(env.ledger.load(), [])
    const next = await env.service.plan({})
    assert.equal(next.plan.entries.length, 1)
    await assert.rejects(env.service.submit({ planId: next.plan.id }), /确认/)
  })
  await test('结果不确定后保留错误，平台记录延迟出现时自动核销本地标记', async () => {
    const env = setupService(); env.adapter.apply = async () => { throw new Error('提交连接中断') }
    const { plan } = await env.service.plan({})
    await env.service.submit({ planId: plan.id, confirmed: true })
    const uncertain = await env.service.plan({})
    assert.equal(uncertain.plan.unresolved.length, 1)
    assert.equal(uncertain.plan.unresolved[0].message, '提交连接中断')
    assert.equal(uncertain.plan.entries.length, 0)
    env.data.leaves.push(leave('15'))
    const reconciled = await env.service.plan({})
    assert.equal(reconciled.plan.unresolved.length, 0)
    assert.equal(reconciled.plan.rows[0].status, 'covered')
    assert.deepEqual(env.ledger.load(), [])
  })
  await test('解除旧标记需本人确认、后台再查且不发送申请；新请求至少等待一分钟', async () => {
    const env = setupService(); env.adapter.apply = async () => { throw new Error('未知结果') }
    const { plan } = await env.service.plan({})
    await env.service.submit({ planId: plan.id, confirmed: true })
    const first = (await env.service.plan({})).plan
    const params = { planId: first.id, markerId: first.unresolved[0].id, confirmedMissing: true }
    await assert.rejects(env.service.resolve({ ...params, confirmedMissing: false }), /确认/)
    await assert.rejects(env.service.resolve({ ...params, markerId: 'forged' }), /变化/)
    await assert.rejects(env.service.resolve(params), /一分钟/)
    env.service.now = () => NOW + 61000
    // 兼容旧版没有假种 ID、错误消息的标记。
    env.ledger.save(env.ledger.load().map(({ typeId, message, ...rest }) => rest))
    const second = (await env.service.plan({})).plan
    assert.equal(second.unresolved[0].canRetry, true)
    assert.match(second.unresolved[0].message, /旧版/)
    const input = { planId: second.id, markerId: second.unresolved[0].id, confirmedMissing: true }
    env.data.leaves.push(leave('15', { end: '2026-10-15 09:00', hoursText: '0.5小时' }))
    await assert.rejects(env.service.resolve(input), /重叠申请/)
    assert.equal(env.ledger.load().length, 1)
    env.data.leaves = []
    await env.service.resolve(input)
    assert.deepEqual(env.ledger.load(), [])
    assert.equal(env.calls.length, 0)
    assert.equal((await env.service.plan({})).plan.entries.length, 1)
  })
  await test('并发生成/提交被拒绝，平台校验失败释放当日余额给更旧日期', async () => {
    const env = setupService(source([card('15'), card('14')], 1, 0))
    const prepare = env.adapter.prepare
    env.adapter.prepare = async (options) => { if (options.entry.date.endsWith('15')) throw new Error('平台要求手工校对'); return prepare(options) }
    const { plan } = await env.service.plan({})
    assert.deepEqual(plan.rows.map(item => item.status), ['blocked', 'ready'])
    env.service.busy = true
    await assert.rejects(env.service.plan({}), /进行中/)
    await assert.rejects(env.service.submit({ confirmed: true, planId: plan.id }), /进行中/)
  })
  await test('本地待核对标记原子保存并能跨服务实例读取', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-ledger-'))
    try {
      const ledger = createFileLedger(directory)
      assert.deepEqual(ledger.load(), [])
      ledger.save([{ key: 'isolated-request', date: '2026-10-15' }])
      assert.equal(createFileLedger(directory).load()[0].key, 'isolated-request')
      ledger.save([])
      assert.deepEqual(ledger.load(), [])
      assert.equal(fs.readdirSync(directory).length, 1)
    } finally {
      const resolved = fs.realpathSync(directory)
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
      assert(path.basename(resolved).startsWith('leave-ledger-'))
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  })
  await test('浏览器列表由实时元数据读取本人、日期和分页，101 条完整返回', async () => {
    const fixture = pageFixture({ count: 101 })
    const data = await fixture.run('read', OPTIONS)
    assert.equal(data.attendance.length, 101)
    assert.deepEqual(Array.from(data.balances, item => item.hours), [1.5, 36.5])
    const pages = fixture.calls.filter(item => item.path.endsWith('/TableList') && item.query.metaObjName === 'Attendance.AttendanceStatistics')
    assert.deepEqual(pages.map(item => item.body.table_data.paging.page), [0, 1])
    assert.equal(pages[1].body.table_data.ext_data.SortCursor, 'cursor-from-platform')
    assert.equal(pages[0].body.search_data.items[1].value, '2026/10/01-2026/10/15')
  })
  await test('无法识别余额单位、账号变化和同名假种均拒绝', async () => {
    await assert.rejects(pageFixture({ balance: '1.5 天' }).run('read', OPTIONS), /余额单位/)
    await assert.rejects(pageFixture().run('read', { ...OPTIONS, staffId: 'another-staff' }), /账号/)
    const fixture = pageFixture(); fixture.types.push(clone(fixture.types[0]))
    await assert.rejects(fixture.run('read', OPTIONS), /同名假种/)
  })
  await test('准备只计算和校验；确认后一次写入，报文包含元数据与正确起止时间', async () => {
    const fixture = pageFixture()
    const entry = buildPlan(source(), OPTIONS).entries[0]
    const prepared = await fixture.run('prepare', { entry, staffId: 'staff-test', reason: '测试事由' })
    assert.equal(fixture.calls.filter(item => item.path.endsWith('/ApplyVacation')).length, 0)
    assert.equal(prepared.hours, 1)
    await assert.rejects(fixture.run('apply', { key: prepared.key }), /确认/)
    await fixture.run('apply', { key: prepared.key, confirmed: true, staffId: 'staff-test' })
    await assert.rejects(fixture.run('apply', { key: prepared.key, confirmed: true }), /失效/)
    const applies = fixture.calls.filter(item => item.path.endsWith('/ApplyVacation'))
    assert.equal(applies.length, 1)
    const fields = Object.fromEntries(applies[0].body.metaFields.map(item => [item.name, item.value]))
    assert.equal(fields.VacationStartDateTime, '2026/10/15 08:30')
    assert.equal(fields.VacationStopDateTime, '2026/10/15 09:29')
    assert.equal(fields.VacationDurationIncludeUnit, '1小时')
    assert.equal(fields.Description, '测试事由')
    assert.equal(fields.StaffId, 'staff-test')
    assert.equal('_id' in fields, false, '内部新建 ID 不得作为表单字段发送')
    assert.equal('IsFirst' in fields, false, '只提交表单绑定字段')
  })
  await test('提交时账号切换和平台时长偏差均不写入', async () => {
    const fixture = pageFixture(); const entry = buildPlan(source(), OPTIONS).entries[0]
    await assert.rejects(fixture.run('prepare', { entry: { ...entry, hours: 2 }, staffId: 'staff-test' }), /不一致/)
    const prepared = await fixture.run('prepare', { entry, staffId: 'staff-test' })
    fixture.setOwner('new-staff')
    await assert.rejects(fixture.run('apply', { key: prepared.key, confirmed: true, staffId: 'staff-test' }), /账号/)
    assert.equal(fixture.calls.filter(item => item.path.endsWith('/ApplyVacation')).length, 0)
  })
  await test('表单失效、账号切换、登录失效和平台拒绝均保留明确未提交状态', async () => {
    const entry = buildPlan(source(), OPTIONS).entries[0]
    const fixture = pageFixture()
    await assert.rejects(fixture.run('apply', { confirmed: true, key: 'expired' }), error => error.submissionState === 'notSubmitted' && /失效/.test(error.message))
    for (const options of [{ applyStatus: 401 }, { applyError: '余额发生变化，申请失败' }]) {
      const f = pageFixture(options)
      const prepared = await f.run('prepare', { entry, staffId: 'staff-test' })
      await assert.rejects(f.run('apply', { key: prepared.key, confirmed: true, staffId: 'staff-test' }), error => error.submissionState === 'notSubmitted')
    }
    const failing = pageFixture({ applyStatus: 500 })
    const prepared = await failing.run('prepare', { entry, staffId: 'staff-test' })
    await assert.rejects(failing.run('apply', { key: prepared.key, confirmed: true, staffId: 'staff-test' }), error => error.submissionState !== 'notSubmitted')
  })
  await test('浏览器桥接保留错误阶段，关闭标签后的重连只用于准备操作', async () => {
    const fixture = pageFixture({ applyError: '平台拒绝本次申请' })
    const sessions = []
    let closed = false
    const fetchImpl = async (_url, opts) => {
      const call = JSON.parse(opts.body); sessions.push(call.session)
      const data = call.action === 'evaluate' ? { type: 'string', value: await vm.runInContext(call.args.code, fixture.context) }
        : call.action === 'list_tabs' ? { tabs: closed ? [] : [{ tabId: 7, url: 'https://cloud.italent.cn/attendance' }] } : { tabId: 7 }
      return { ok: true, json: async () => ({ ok: true, data }) }
    }
    const browser = new ItalentBrowser({ fetchImpl })
    const entry = buildPlan(source(), OPTIONS).entries[0]
    const prepared = await browser.prepare({ entry, staffId: 'staff-test' })
    await assert.rejects(browser.apply({ key: prepared.key, confirmed: true, staffId: 'staff-test' }), error => error.submissionState === 'notSubmitted' && /平台拒绝/.test(error.message))
    const originalSession = browser.session
    closed = true
    await browser.read(OPTIONS)
    assert.notEqual(browser.session, originalSession)
    assert(sessions.includes(originalSession) && sessions.includes(browser.session))
  })
  await test('平台表单收到 30:59 的分钟终点 09:00，校验时长为 0.5 小时', async () => {
    const fixture = pageFixture()
    const entry = buildPlan(source([card('15', '09:00:59')]), OPTIONS).entries[0]
    const prepared = await fixture.run('prepare', { entry, staffId: 'staff-test' })
    assert.equal(prepared.end, '2026-10-15 09:00')
    assert.equal(prepared.hours, 0.5)
    assert.equal(fixture.calls.filter(item => item.path.endsWith('/ApplyVacation')).length, 0)
  })
  await test('浏览器连接仅允许本机，失败不回传底层请求和签名', async () => {
    assert.throws(() => new ItalentBrowser({ endpoint: 'https://remote.invalid' }), /本机/)
    const browser = new ItalentBrowser({ fetchImpl: async () => { throw new Error('sensitive-request') } })
    await assert.rejects(browser.connect(), error => /无法连接浏览器/.test(error.message) && !error.message.includes('sensitive'))
  })
  await test('内嵌适配器经宿主注入脚本，结果由页面回传本机回调', async () => {
    const fixture = pageFixture()
    // 页面上下文里：北森接口走夹具，127.0.0.1 回调走真实网络送回适配器。
    const realFetch = globalThis.fetch.bind(globalThis)
    const pageFetch = fixture.context.fetch
    fixture.context.fetch = (input, opts) => String(input).startsWith('http://127.0.0.1') ? realFetch(input, opts) : pageFetch(input, opts)
    const requests = []
    const host = {
      call: async (action, payload) => {
        requests.push({ action, label: payload.label })
        // 模拟桌面宿主的 eval：代码在北森页面上下文执行。
        vm.runInContext(payload.code, fixture.context)
      },
    }
    const adapter = new ItalentEmbedded({ host, timeout: 8000 })
    const probed = await adapter.connect()
    assert.equal(probed.origin, 'https://cloud.italent.cn')
    assert(requests.every(item => item.action === 'leave-eval' && item.label === 'leave-italent'))
    const data = await adapter.read(OPTIONS)
    assert.equal(data.attendance.length, 2)
    const entry = buildPlan(source(), OPTIONS).entries[0]
    const prepared = await adapter.prepare({ entry, staffId: 'staff-test', reason: '内嵌测试' })
    await adapter.apply({ key: prepared.key, confirmed: true, staffId: 'staff-test' })
    assert.equal(fixture.calls.filter(item => item.path.endsWith('/ApplyVacation')).length, 1)
    assert.equal(fixture.calls.some(item => item.path.includes('/AgainVerify/')), true)
  })
  await test('内嵌适配器保留未提交状态、隐藏请求地址并区分窗口未开与超时', async () => {
    const fixture = pageFixture({ applyError: '平台拒绝本次申请' })
    const realFetch = globalThis.fetch.bind(globalThis)
    const pageFetch = fixture.context.fetch
    fixture.context.fetch = (input, opts) => String(input).startsWith('http://127.0.0.1') ? realFetch(input, opts) : pageFetch(input, opts)
    const host = { call: async (_action, payload) => { vm.runInContext(payload.code, fixture.context) } }
    const adapter = new ItalentEmbedded({ host, timeout: 8000 })
    const entry = buildPlan(source(), OPTIONS).entries[0]
    const prepared = await adapter.prepare({ entry, staffId: 'staff-test' })
    await assert.rejects(adapter.apply({ key: prepared.key, confirmed: true, staffId: 'staff-test' }), error => error.submissionState === 'notSubmitted' && /平台拒绝/.test(error.message))
    const missing = new ItalentEmbedded({ host: { call: async () => { throw new Error('北森窗口未打开，请先点击连接北森') } }, timeout: 200 })
    await assert.rejects(missing.read(OPTIONS), /连接北森/)
    const silent = new ItalentEmbedded({ host: { call: async () => {} }, timeout: 200 })
    await assert.rejects(silent.read(OPTIONS), /超时/)
    // 页面请求失败时错误正文里的北森地址必须被隐藏后再回传。
    const leakyFixture = pageFixture()
    leakyFixture.context.fetch = (input, opts) => String(input).startsWith('http://127.0.0.1') ? realFetch(input, opts) : Promise.reject(new Error('请求 https://cloud.italent.cn/api/v2/UI/IndexPage 失败'))
    const leaky = new ItalentEmbedded({ host: { call: async (_action, payload) => { vm.runInContext(payload.code, leakyFixture.context) } }, timeout: 8000 })
    await assert.rejects(leaky.read(OPTIONS), error => !error.message.includes('cloud.italent.cn') && !error.message.includes('http') && /请求地址已隐藏/.test(error.message))
  })
  console.log(`一键请假自测通过：${passed} 组`)
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { pageFixture }
