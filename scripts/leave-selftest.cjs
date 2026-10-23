/** 一键请假：业务边界、确认门、失败中止、浏览器接口契约；全部使用隔离数据。 */
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { LeaveService, createFileLedger, createPlanStore, buildPlan, normalizeOptions, stamp } = require('../electron/leave-service')
const { italentPage } = require('../electron/italent-page')
const { ItalentBrowser } = require('../electron/italent-browser')
const { ItalentEmbedded, ItalentBookmarklet } = require('../electron/italent-embedded')
const { ItalentAdapter } = require('../electron/italent-adapter')
const { ChromeSSOWatcher } = require('../electron/italent-history')
const { DatabaseSync } = require('node:sqlite')

const NOW = Date.parse('2026-10-15T06:00:00Z')
const OPTIONS = normalizeOptions({}, NOW)
const clone = (data) => JSON.parse(JSON.stringify(data))
const card = (day, time = '09:10:00', rest = {}) => ({ id: `att-${day}`, date: `2026-10-${day}`, firstCard: `2026-10-${day} ${time}`, lastCard: '', dayType: '1', remark: '', ...rest })
const leave = (day, rest = {}) => ({ id: `leave-${day}`, typeId: 'comp', typeName: '调休假', start: `2026-10-${day} 08:30`, end: `2026-10-${day} 09:29`, hoursText: '1小时', status: '2', revocation: '未销假', documentType: '1', ...rest })
const personal = { name: '事假', id: 'personal', hours: null, unlimited: true, available: true }
const source = (attendance = [card('15')], comp = 1.5, annual = 36.5, withPersonal = true, compEntries) => ({ staffId: 'staff-test', staffName: '测试员工', attendance, leaves: [], balances: [{ name: '调休假', id: 'comp', hours: comp, available: true }, { name: '年假', id: 'annual', hours: annual, available: true }, ...(withPersonal ? [personal] : [])], ...(compEntries ? { compEntries } : {}) })
let passed = 0
async function test(name, run) { await run(); passed++; console.log(`✓ ${name}`) }

function setupService(data = source(), changes = {}, planStore = { load: () => null, save() {}, clear() {} }) {
  let stored = []
  const calls = []
  const preparedReasons = []
  const adapter = {
    connect: async () => ({ connected: true }),
    read: async () => clone(data),
    prepare: async ({ entry, reason }) => { preparedReasons.push({ date: entry.date, reason }); return { key: `prepared-${calls.length}`, start: entry.start, end: entry.end, hours: entry.hours, typeId: entry.typeId } },
    apply: async ({ key, confirmed }) => {
      assert.equal(confirmed, true)
      calls.push(key)
      const item = changes.appliedEntries[calls.length - 1]
      data.leaves.push(leave(item.date.slice(-2), { id: `new-${calls.length}`, typeId: item.typeId, typeName: item.typeName, start: item.start, end: item.end, hoursText: `${item.hours}小时` }))
      const balance = data.balances.find(entry => entry.id === item.typeId)
      if (balance && !balance.unlimited) balance.hours -= item.hours
      return { sent: true }
    },
  }
  const ledger = { load: () => clone(stored), save: (rows) => { stored = clone(rows) } }
  const service = new LeaveService({ adapter, ledger, planStore, now: () => NOW, pause: async () => {} })
  return { service, adapter, data, calls, changes, ledger, preparedReasons }
}

function pageFixture({ count = 2, balance = '1.5 小时', applyStatus = 200, applyError = '', pageFunction = italentPage } = {}) {
  const calls = []
  const att = 'Attendance.AttendanceStatistics'
  const vac = 'Attendance.AttendanceVacationInfo'
  let owner = 'staff-test'
  const field = (name, val, label = val) => ({ name, value: val, text: label })
  const metadataField = (name) => ({ cmp_data: { field_name: name, fieldChangeTriggerId: 'trigger-from-platform', datasourcename: 'Attendance.EveryVacationItems', refreshParams: 'StaffId={formData.StaffId}' } })
  const types = [{ text: '调休假', value: 'comp', isActive: '1', extAttr: { Remain: JSON.stringify([`余额 ${balance}`]) } }, { text: '年假', value: 'annual', isActive: '1', extAttr: { Remain: '["年假 36.5 小时"]' } }, { text: '事假', value: 'personal', isActive: '1' }]
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
      if (query.metaObjName === 'Attendance.ExchangeLeave') {
        const exchangeRows = [
          { _id: field('_id', 'ex-1'), OvertimeDate: field('OvertimeDate', '2026/10/01'), ValidityDate: field('ValidityDate', '2026/11/30'), Limit: field('Limit', '1.5'), Balance: field('Balance', '1.5'), Condition: field('Condition', '0') },
          { _id: field('_id', 'ex-2'), OvertimeDate: field('OvertimeDate', '2026/10/14'), ValidityDate: field('ValidityDate', '2026/10/20'), Limit: field('Limit', '2'), Balance: field('Balance', '0'), Condition: field('Condition', '0') },
        ]
        data = { cmp_data: { paging: { total: exchangeRows.length } }, biz_data: exchangeRows }
        return { ok: true, status: 200, json: async () => data }
      }
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
  await test('15 分钟内迟到走额度不申请；超过 15 分钟必须请假', () => {
    for (const time of ['08:30:01', '08:30:59']) {
      const plan = buildPlan(source([card('15', time)]), OPTIONS)
      assert.equal(plan.totalHours, 0, time)
      assert.equal(plan.rows[0].reason, '未迟到', time)
    }
    for (const time of ['08:31:00', '08:40:00', '08:45:00', '08:45:59']) {
      const plan = buildPlan(source([card('15', time)]), OPTIONS)
      assert.equal(plan.entries.length, 0, time)
      assert.equal(plan.rows[0].status, 'tolerated', time)
      assert.match(plan.rows[0].reason, /计入本月迟到额度/, time)
    }
    for (const time of ['08:46:00', '08:59:59', '09:00:00']) {
      const plan = buildPlan(source([card('15', time)]), OPTIONS)
      assert.deepEqual([plan.totalHours, plan.entries[0].end.slice(11)], [0.5, '09:00'], time)
      assert.equal(plan.rows[0].reason, '待确认', time)
      // 08:46–09:00 到岗（含 9 点整）没有可计余量：取消“计算迟到”也不多请。
      const forced = buildPlan(source([card('15', time)]), OPTIONS, {}, new Set(), { '2026-10-15': { countLate: false } })
      assert.deepEqual([forced.totalHours, forced.rows[0].residualLate], [0.5, 0], time)
    }
    assert.match(buildPlan(source([card('15', '09:10:00')]), OPTIONS).rows[0].reason, /09:00 后仍有 10 分钟迟到，计入本月额度/)
    for (const [time, hours, end] of [['09:15:59', 0.5, '09:00'], ['09:16:00', 1, '09:30'], ['09:29:59', 1, '09:30'], ['09:31:00', 1.5, '10:00'], ['09:59:00', 1.5, '10:00'], ['10:00:00', 1.5, '10:00'], ['10:05:00', 2, '10:30'], ['10:16:00', 2, '10:30'], ['10:31:00', 2.5, '11:00'], ['11:59:00', 3.5, '12:00'], ['12:15:00', 3.5, '12:00'], ['13:00:00', 3.5, '12:00'], ['13:30:00', 4, '13:30'], ['14:30:00', 5, '14:30'], ['16:40:00', 7.5, '17:00'], ['17:29:59', 8, '17:30']]) {
      const plan = buildPlan(source([card('15', time)]), OPTIONS)
      assert.deepEqual([plan.totalHours, plan.entries[0].end.slice(11)], [hours, end], time)
    }
  })
  await test('已有请假覆盖后 9 点余量计入迟到额度，卡片展示已用/还可用', () => {
    const data = source([card('08', '09:02:00')])
    data.leaves.push(leave('08', { id: 'existing', typeId: 'annual', typeName: '年假', start: '2026-10-08 08:30', end: '2026-10-08 09:00', hoursText: '0.5小时' }))
    const plan = buildPlan(data, OPTIONS)
    const row = plan.rows[0]
    assert.equal(row.status, 'covered')
    assert.equal(row.remainingLate, 2)
    assert.match(row.reason, /09:00 后 2 分钟计入本月迟到额度/)
    assert.deepEqual(plan.quota['2026-10'], { days: 1, minutes: 2 })
    // 覆盖到 09:15 前无余量时不占额度；09:16 后覆盖到岗也不占。
    const toArrival = source([card('08', '09:02:00')])
    toArrival.leaves.push(leave('08', { end: '2026-10-08 09:02', hoursText: '0.5小时' }))
    assert.equal(buildPlan(toArrival, OPTIONS).quota['2026-10'], undefined)
    const early = source([card('08', '08:50:00')])
    early.leaves.push(leave('08', { end: '2026-10-08 08:50', hoursText: '0.5小时' }))
    assert.equal(buildPlan(early, OPTIONS).quota['2026-10'], undefined)
  })
  await test('调休按获得日与有效期限制：当日获得不可用于之前/当天，过期不可用', () => {
    const entries = [
      { id: 'today', earnedDate: '2026-10-15', expires: '2026-11-30', hours: 1 },
      { id: 'expired', earnedDate: '2026-10-01', expires: '2026-10-14', hours: 1 },
      { id: 'ok', earnedDate: '2026-09-01', expires: '2026-11-30', hours: 1 },
    ]
    // 10-15 只能用 9 月获得的条目；10-16 起当日条目也可用。
    const plan = buildPlan(source([card('15', '09:10:00'), card('16', '09:10:00')], 3, 36.5, true, entries), { ...OPTIONS, until: '2026-10-16' })
    assert.deepEqual(plan.entries.map(item => [item.date, item.typeName, item.hours]), [['2026-10-16', '调休假', 0.5], ['2026-10-15', '调休假', 0.5]])
    assert.equal(plan.compValidUntil, '2026-11-30', '已过期条目不计入有效至')
    // 只有“当天获得”的条目时当天不可用调休，改年假并说明原因。
    const onlyToday = buildPlan(source([card('15', '09:10:00')], 1, 36.5, true, [{ id: 'today', earnedDate: '2026-10-15', expires: '2026-11-30', hours: 1 }]), OPTIONS)
    assert.deepEqual(onlyToday.entries.map(item => [item.typeName, item.hours]), [['年假', 0.5]])
    assert.match(onlyToday.rows[0].reason, /调休获得日晚于当天或已过期/)
    // 全部过期时同口径；指定调休也被限制。
    const forced = buildPlan(source([card('15', '09:10:00')], 1, 36.5, true, [{ id: 'old', earnedDate: '2026-10-01', expires: '2026-10-10', hours: 1 }]), OPTIONS, {}, new Set(), { '2026-10-15': { typeId: 'comp' } })
    assert.deepEqual(forced.entries.map(item => [item.typeName, item.hours]), [['年假', 0.5]])
    assert.match(forced.rows[0].reason, /调休获得日/)
    // 无条目（旧数据/隔离夹具）回退总额限制。
    assert.deepEqual(buildPlan(source([card('15', '09:10:00')], 1, 36.5), OPTIONS).entries.map(item => [item.typeName, item.hours]), [['调休假', 0.5]])
  })
  await test('重复覆盖按请假块终点判断，部分覆盖阻断', () => {
    const data = source([card('15', '09:00:59')], 0.5, 0)
    data.leaves.push(leave('15', { end: '2026-10-15 09:00', hoursText: '0.5小时' }))
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'covered')
    const plan = buildPlan(source([card('15', '09:10:00')], 0, 1), OPTIONS)
    assert.deepEqual(plan.entries.map(item => [item.typeName, item.hours, item.end]), [['年假', 0.5, '2026-10-15 09:00']])
    const none = buildPlan(source([card('15', '09:10:00')], 0.25, 0.25, false), OPTIONS)
    assert.equal(none.entries.length, 0)
    assert.equal(none.rows[0].reason, '调休假、年假与事假合计不足以覆盖当天请假时长，先不处理')
  })
  await test('假种级联：整段调休、不足整段年假、再不足分段拼够', () => {
    const plan = buildPlan(source([card('13', '08:35:00'), card('15', '09:10:00'), card('14', '08:50:00')], 0.5, 0.5), OPTIONS)
    assert.deepEqual(plan.entries.map(item => [item.date, item.typeName, item.hours]), [['2026-10-15', '调休假', 0.5], ['2026-10-14', '年假', 0.5]])
    assert.deepEqual(plan.rows.map(item => item.status), ['ready', 'ready', 'tolerated'])
    assert.equal(plan.balances[0].remaining, 0)
    assert.equal(plan.balances[1].remaining, 0)
    const split = buildPlan(source([card('15', '10:05:00')], 1, 1), OPTIONS)
    assert.deepEqual(split.entries.map(item => [item.typeName, item.start.slice(11), item.end.slice(11), item.hours]), [['调休假', '08:30', '09:30', 1], ['年假', '09:30', '10:30', 1]])
    assert.match(split.rows[0].reason, /分段拼够/)
    // 跨午休拆分：分段终点按有效工时推进，第二段跳过 12:00–13:00。
    const lunch = buildPlan(source([card('15', '14:30:00')], 2, 3), OPTIONS)
    assert.deepEqual(lunch.entries.map(item => [item.typeName, item.start.slice(11), item.end.slice(11), item.hours]), [['调休假', '08:30', '10:30', 2], ['年假', '10:30', '14:30', 3]])
    const both = buildPlan(source([card('15', '10:05:00')], 0.5, 0, false), OPTIONS)
    assert.equal(both.entries.length, 0)
    assert.equal(both.rows[0].reason, '调休假、年假与事假合计不足以覆盖当天请假时长，先不处理')
    const personalPlan = buildPlan(source([card('15', '10:05:00')], 0.5, 0), OPTIONS)
    assert.deepEqual(personalPlan.entries.map(item => [item.typeName, item.hours]), [['调休假', 0.5], ['事假', 1.5]])
  })
  await test('计算迟到开关：勾选少请 0.5 小时，取消多请 0.5 小时并清零剩余迟到', () => {
    const base = buildPlan(source([card('15', '08:43:00'), card('14', '09:10:00')], 10), OPTIONS)
    const early = base.rows.find(item => item.date === '2026-10-15')
    const grace = base.rows.find(item => item.date === '2026-10-14')
    assert.deepEqual([early.status, early.hours, early.countLate, early.remainingLate], ['tolerated', 0, true, 13])
    assert.deepEqual([grace.hours, grace.countLate, grace.remainingLate], [0.5, true, 10])
    const adjusted = buildPlan(source([card('15', '08:43:00'), card('14', '09:10:00')], 10), OPTIONS, {}, new Set(), {
      '2026-10-15': { countLate: false },
      '2026-10-14': { countLate: false },
    })
    const a = adjusted.rows.find(item => item.date === '2026-10-15')
    const b = adjusted.rows.find(item => item.date === '2026-10-14')
    assert.deepEqual([a.hours, a.remainingLate, a.allocations[0].end.slice(11)], [0.5, 0, '09:00'])
    assert.deepEqual([b.hours, b.remainingLate, b.allocations[0].end.slice(11)], [1, 0, '09:30'])
    const noResidual = buildPlan(source([card('15', '09:00:00')], 10), OPTIONS, {}, new Set(), { '2026-10-15': { countLate: false } })
    assert.deepEqual([noResidual.rows[0].hours, noResidual.rows[0].allocations[0].end.slice(11)], [0.5, '09:00'])
    // 三条件同时成立：手动全勾也只能计 5 次，第 6 次自动改为多请 0.5 小时。
    const forced = buildPlan(source(['10', '11', '12', '13', '14', '15'].map(day => card(day, '08:40:00')), 10), OPTIONS, {}, new Set(), Object.fromEntries(['10', '11', '12', '13', '14', '15'].map(day => [`2026-10-${day}`, { countLate: true }])))
    const sixth = forced.rows.find(item => item.date === '2026-10-10')
    assert.deepEqual([forced.quota['2026-10'].days, forced.quota['2026-10'].minutes, forced.quotaLimits], [5, 50, { days: 5, minutes: 50 }])
    assert.equal(sixth.countLate, false)
    assert.deepEqual([sixth.hours, sixth.remainingLate], [0.5, 0])
    assert.match(sixth.reason, /不计算迟到/)
  })
  await test('replan 按天调整计算迟到与假种，提交使用调整后的方案', async () => {
    const env = setupService(source([card('15', '08:43:00'), card('14', '09:10:00')], 10))
    const { plan } = await env.service.plan({})
    assert.equal(plan.rows.find(item => item.date === '2026-10-15').status, 'tolerated')
    const adjusted = await env.service.replan({
      planId: plan.id,
      overrides: {
        '2026-10-15': { countLate: false },
        '2026-10-14': { typeId: 'personal' },
      },
    })
    assert.equal(adjusted.plan.id, plan.id)
    assert.deepEqual(adjusted.plan.rows.find(item => item.date === '2026-10-15').allocations.map(item => [item.typeName, item.hours]), [['调休假', 0.5]])
    assert.deepEqual(adjusted.plan.rows.find(item => item.date === '2026-10-14').allocations.map(item => [item.typeName, item.hours]), [['事假', 0.5]])
    env.changes.appliedEntries = adjusted.plan.entries
    const result = await env.service.submit({ planId: plan.id, confirmed: true, dates: ['2026-10-15', '2026-10-14'], reasons: { '2026-10-15': '早高峰' } })
    assert.equal(result.completed, true)
    assert.deepEqual(result.results.map(item => [item.date, item.typeName]), [['2026-10-15', '调休假'], ['2026-10-14', '事假']])
  })
  await test('指定假种余额不足时自动回退级联，调休与年假都不超扣', () => {
    const plan = buildPlan(source([card('15', '09:10:00')], 0, 10), OPTIONS, {}, new Set(), { '2026-10-15': { typeId: 'comp' } })
    assert.equal(plan.rows[0].status, 'ready')
    assert.deepEqual(plan.rows[0].allocations.map(item => [item.typeName, item.hours]), [['年假', 0.5]])
    assert.match(plan.rows[0].reason, /调休.*不足，自动改用/)
    // 取消“计算迟到”多请 0.5 小时后，指定假种不够同样回退并分段。
    const grown = buildPlan(source([card('15', '09:10:00')], 0.5, 0.5), OPTIONS, {}, new Set(), { '2026-10-15': { typeId: 'comp', countLate: false } })
    assert.equal(grown.rows[0].status, 'ready')
    assert.deepEqual(grown.rows[0].allocations.map(item => [item.typeName, item.hours]), [['调休假', 0.5], ['年假', 0.5]])
  })
  await test('方案留存与恢复：重启后台后直接提交，提交后留存清除', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-plan-store-'))
    try {
      const store = createPlanStore(directory)
      const env = setupService(source([card('15')]), {}, store)
      const { plan } = await env.service.plan({})
      // 模拟后台重启：同一留存目录上的新服务实例。
      const reborn = setupService(env.data, { appliedEntries: [{ ...plan.entries[0], date: '2026-10-15' }] }, createPlanStore(directory))
      const restored = await reborn.service.restore()
      assert.equal(restored.plan.id, plan.id)
      assert.deepEqual(restored.plan.entries.map(item => [item.date, item.typeName]), [['2026-10-15', plan.entries[0].typeName]])
      const adjusted = await reborn.service.replan({ planId: restored.plan.id, overrides: { '2026-10-15': { countLate: false } } })
      assert.equal(adjusted.plan.entries[0].hours, 1, '恢复后仍可调整计算迟到')
      reborn.changes.appliedEntries = adjusted.plan.entries
      const result = await reborn.service.submit({ planId: restored.plan.id, confirmed: true })
      assert.equal(result.completed, true)
      assert.equal((await setupService(env.data, {}, createPlanStore(directory)).service.restore()).plan, null, '提交后留存清除')
    } finally {
      fs.rmSync(fs.realpathSync(directory), { recursive: true, force: true })
    }
  })
  await test('每月迟到额度：最多 5 次、合计 50 分钟，额度不足改为请假', () => {
    const six = buildPlan(source(['10', '11', '12', '13', '14', '15'].map(day => card(day, '08:40:00')), 10), OPTIONS)
    assert.equal(six.rows.filter(item => item.status === 'tolerated').length, 5)
    assert.deepEqual(six.rows.find(item => item.date === '2026-10-10').allocations.map(item => item.hours), [0.5])
    const minutes = buildPlan(source(['12', '13', '14', '15'].map(day => card(day, '08:44:00')), 10), OPTIONS)
    assert.equal(minutes.rows.filter(item => item.status === 'tolerated').length, 3)
    assert.deepEqual(minutes.rows.find(item => item.date === '2026-10-12').allocations.map(item => item.hours), [0.5])
    const upgrade = buildPlan(source(['12', '13', '14', '15'].map(day => card(day, '09:14:00')), 10), OPTIONS)
    const upgraded = upgrade.rows.find(item => item.date === '2026-10-12')
    assert.deepEqual([upgraded.hours, upgraded.reason], [1, '不计算迟到，多请 0.5 小时'])
    assert.equal(upgrade.rows.filter(item => item.reason.includes('计入本月额度')).length, 3)
  })
  await test('单日余额不足时不挪用零头，差额用事假补足', () => {
    const plan = buildPlan(source([card('15', '09:10:00'), card('14', '08:48:00')], 0.75, 0), OPTIONS)
    assert.equal(plan.rows[0].status, 'ready')
    assert.equal(plan.rows[1].status, 'ready')
    assert.equal(plan.totalHours, 1)
    assert.equal(plan.balances[0].remaining, 0.25)
    assert.deepEqual(plan.entries.map(item => [item.date, item.typeName, item.hours]), [['2026-10-15', '调休假', 0.5], ['2026-10-14', '事假', 0.5]])
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
    data.leaves[0].end = '2026-10-15 08:50'
    assert.equal(buildPlan(data, OPTIONS).rows[0].status, 'blocked')
    data.leaves.push(leave('15', { id: 'second', start: '2026-10-15 08:50', end: '2026-10-15 09:00' }))
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
    assert.equal(env.data.leaves[0].hoursText, '0.5小时')
    assert.deepEqual(env.ledger.load(), [])
    await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true }), /变化/)
  })
  await test('确认时可按条覆盖请假事由，未覆盖与空值回落默认事由', async () => {
    const env = setupService(source([card('13'), card('15')], 10))
    const { plan } = await env.service.plan({ reason: '默认事由' })
    env.changes.appliedEntries = plan.entries
    env.preparedReasons.length = 0
    const result = await env.service.submit({ planId: plan.id, confirmed: true, reasons: { [plan.entries[1].id]: ' 家里有事 ', [plan.entries[0].id]: '', unknown: '方案外条目' } })
    assert.equal(result.completed, true)
    assert.deepEqual(env.preparedReasons, [{ date: '2026-10-15', reason: '默认事由' }, { date: '2026-10-13', reason: '家里有事' }])
    const strict = setupService()
    const next = (await strict.service.plan({ reason: '默认' })).plan
    await assert.rejects(strict.service.submit({ planId: next.id, confirmed: true, reasons: { [next.entries[0].id]: '长'.repeat(1001) } }), /1000/)
    await assert.rejects(strict.service.submit({ planId: next.id, confirmed: true, reasons: '整串' }), /格式/)
    assert.equal(strict.calls.length, 0)
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
  await test('可只提交勾选的日期：按天整选、未知或空日期拒绝，提交后方案失效', async () => {
    const env = setupService(source([card('13'), card('15'), card('14')], 10))
    const { plan } = await env.service.plan({})
    assert.equal(plan.entries.length, 3)
    await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true, dates: ['2026-10-01'] }), /不在本次方案/)
    await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true, dates: [] }), /至少选择一天/)
    await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true, dates: '2026-10-15' }), /日期/)
    assert.equal(env.calls.length, 0)
    const chosen = plan.entries.filter(item => ['2026-10-15', '2026-10-13'].includes(item.date))
    env.changes.appliedEntries = chosen
    const result = await env.service.submit({ planId: plan.id, confirmed: true, dates: ['2026-10-13', '2026-10-15'] })
    assert.deepEqual(result.results.map(item => [item.date, item.status]), [['2026-10-15', 'success'], ['2026-10-13', 'success']])
    assert.equal(env.calls.length, 2)
    assert.equal(env.data.leaves.some(item => item.start.startsWith('2026-10-14')), false, '未勾选的日期不写入北森')
    await assert.rejects(env.service.submit({ planId: plan.id, confirmed: true, dates: ['2026-10-14'] }), /确认/)
    const next = (await env.service.plan({})).plan
    assert.deepEqual(next.entries.map(item => item.date), ['2026-10-14'], '未提交的日期仍可在重新生成后提交')
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
    env.data.leaves.push(leave('15', { end: '2026-10-15 09:00', hoursText: '0.5小时' }))
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
    env.data.leaves.push(leave('15', { end: '2026-10-15 09:00' }))
    await assert.rejects(env.service.resolve(input), /重叠申请/)
    assert.equal(env.ledger.load().length, 1)
    env.data.leaves = []
    await env.service.resolve(input)
    assert.deepEqual(env.ledger.load(), [])
    assert.equal(env.calls.length, 0)
    assert.equal((await env.service.plan({})).plan.entries.length, 1)
  })
  await test('同一天调休+年假分段按序提交，互不判为重复', async () => {
    const env = setupService(source([card('15', '10:05:00')], 1, 1))
    const { plan } = await env.service.plan({})
    assert.equal(plan.entries.length, 2)
    env.changes.appliedEntries = plan.entries
    const result = await env.service.submit({ planId: plan.id, confirmed: true })
    assert.equal(result.completed, true)
    assert.deepEqual(result.results.map(item => [item.typeName, item.status]), [['调休假', 'success'], ['年假', 'success']])
    assert.equal(env.calls.length, 2)
  })
  await test('平台拒绝调休时当天自动改用年假', async () => {
    const env = setupService(source([card('15'), card('14')], 1, 1))
    const prepare = env.adapter.prepare
    env.adapter.prepare = async (options) => { if (options.entry.date.endsWith('15') && options.entry.typeName === '调休假') throw new Error('平台要求手工校对'); return prepare(options) }
    const { plan } = await env.service.plan({})
    assert.deepEqual(plan.rows.map(item => item.status), ['ready', 'ready'])
    assert.deepEqual(plan.entries.map(item => [item.date, item.typeName]), [['2026-10-15', '年假'], ['2026-10-14', '调休假']])
    env.service.busy = true
    await assert.rejects(env.service.plan({}), /进行中/)
    await assert.rejects(env.service.submit({ confirmed: true, planId: plan.id }), /进行中/)
  })
  await test('并发生成/提交被拒绝，两个假种都被拒后当天阻断', async () => {
    const env = setupService(source([card('15'), card('14')], 1, 1))
    const prepare = env.adapter.prepare
    env.adapter.prepare = async (options) => { if (options.entry.date.endsWith('15')) throw new Error('平台要求手工校对'); return prepare(options) }
    const { plan } = await env.service.plan({})
    assert.deepEqual(plan.rows.map(item => item.status), ['blocked', 'ready'])
    assert.match(plan.rows[0].reason, /平台要求手工校对/)
    env.service.busy = true
    await assert.rejects(env.service.plan({}), /进行中/)
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
    assert.equal(JSON.stringify(data.compEntries), JSON.stringify([{ id: 'ex-1', earnedDate: '2026-10-01', expires: '2026-11-30', hours: 1.5 }, { id: 'ex-2', earnedDate: '2026-10-14', expires: '2026-10-20', hours: 0 }]))
    assert.deepEqual(Array.from(data.balances, item => item.hours), [1.5, 36.5, null])
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
    assert.equal(prepared.hours, 0.5)
    await assert.rejects(fixture.run('apply', { key: prepared.key }), /确认/)
    await fixture.run('apply', { key: prepared.key, confirmed: true, staffId: 'staff-test' })
    await assert.rejects(fixture.run('apply', { key: prepared.key, confirmed: true }), /失效/)
    const applies = fixture.calls.filter(item => item.path.endsWith('/ApplyVacation'))
    assert.equal(applies.length, 1)
    const fields = Object.fromEntries(applies[0].body.metaFields.map(item => [item.name, item.value]))
    assert.equal(fields.VacationStartDateTime, '2026/10/15 08:30')
    assert.equal(fields.VacationStopDateTime, '2026/10/15 09:00')
    assert.equal(fields.VacationDurationIncludeUnit, '0.5小时')
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
    assert.equal(probed.loggedIn, true)
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
    // 已认证请求失败（会话过期）与登录页来源都报告未登录，而不是报错。
    const stale = await leaky.connect()
    assert.equal(stale.loggedIn, false)
    const loginFixture = pageFixture()
    const loginPageFetch = loginFixture.context.fetch
    loginFixture.context.location = { origin: 'https://www.italent.cn' }
    loginFixture.context.fetch = (input, opts) => String(input).startsWith('http://127.0.0.1') ? realFetch(input, opts) : loginPageFetch(input, opts)
    const loggedOut = await new ItalentEmbedded({ host: { call: async (_action, payload) => { vm.runInContext(payload.code, loginFixture.context) } }, timeout: 8000 }).connect()
    assert.equal(loggedOut.loggedIn, false)
    assert.equal(loggedOut.origin, 'https://www.italent.cn')
  })
  await test('书签桥：页面长轮询领取任务执行，结果回传回调；未连接时明确报错', async () => {
    const fixture = pageFixture()
    const realFetch = globalThis.fetch.bind(globalThis)
    const pageFetch = fixture.context.fetch
    fixture.context.fetch = (input, opts) => String(input).startsWith('http://127.0.0.1') ? realFetch(input, opts) : pageFetch(input, opts)
    const bridge = new ItalentBookmarklet({ timeout: 8000 })
    const reading = bridge.read(OPTIONS)
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('未取到任务')), 8000)
      ;(async () => {
        for (let i = 0; i < 40; i++) {
          const response = await realFetch(`http://127.0.0.1:${bridge.port}/bridge/next?b=selftest`, { method: 'GET' }).catch(() => null)
          if (response && response.status === 200) { clearTimeout(timer); resolve(await response.json()) ; return }
          await new Promise((r) => setTimeout(r, 100))
        }
        clearTimeout(timer); reject(new Error('轮询超时'))
      })()
    })
    assert.equal(typeof answer.code, 'string')
    assert.equal(bridge.attached(), true)
    await vm.runInContext(answer.code, fixture.context)
    const data = await reading
    assert.equal(data.attendance.length, 2)
    const script = await (await realFetch(`http://127.0.0.1:${bridge.port}/bridge.js`)).text()
    assert(script.includes(`127.0.0.1:${bridge.port}/bridge/next`))
    // 新版浏览器从公网页面访问 localhost 会先发私有网络预检；必须放行并声明 allow-private-network。
    const preflight = await realFetch(`http://127.0.0.1:${bridge.port}/bridge.js`, { method: 'OPTIONS', headers: { Origin: 'https://cloud.italent.cn', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' } })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true')
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://cloud.italent.cn')
    const bridged = await realFetch(`http://127.0.0.1:${bridge.port}/bridge.js`, { headers: { Origin: 'https://cloud.italent.cn' } })
    assert.equal(bridged.headers.get('access-control-allow-private-network'), 'true')
    assert(bridge.href().startsWith('javascript:'))
    bridge.close()
    const idle = new ItalentBookmarklet({ timeout: 200 })
    await assert.rejects(idle.read(OPTIONS), /书签桥未连接/)
    idle.close()
  })
  await test('通道链：默认只走书签桥与内嵌（不碰 Kimi），强制 browser 才用浏览器桥', async () => {
    const embeddedStub = { connect: async () => ({ connected: true, origin: 'https://cloud.italent.cn', loggedIn: false }) }
    const make = (browser, bookmarklet, forced = '') => new ItalentAdapter({ browser, bookmarklet, embedded: embeddedStub, forced })
    // 已登录浏览器存在也不再自动借用：落到内嵌。
    const reachable = make({ connect: async () => { throw new Error('默认链路不应触碰浏览器桥') }, run: async () => { throw new Error('不应执行') } }, { ensureServer: async () => {}, attached: () => false, href: () => 'javascript:1' })
    const chained = await reachable.connect()
    assert.equal(chained.mode, 'embedded')
    assert.equal(chained.bookmarklet, 'javascript:1')
    // 书签桥连接时优先书签桥。
    const bridged = make({ connect: async () => { throw new Error('不应执行') }, run: async () => { throw new Error('不应执行') } }, { ensureServer: async () => {}, attached: () => true, evaluate: async () => ({ loggedIn: true }), href: () => 'javascript:3' })
    assert.equal((await bridged.connect()).mode, 'bookmarklet')
    // 强制 browser 逃生门仍可用。
    const forced = make({ connect: async () => ({ connected: true }), run: async () => { throw new Error('不应执行') } }, { ensureServer: async () => {}, attached: () => true, evaluate: async () => ({ loggedIn: true }), href: () => 'javascript:4' }, 'browser')
    const forcedResult = await forced.connect()
    assert.equal(forcedResult.mode, 'browser')
    assert.equal(forcedResult.loggedIn, true)
  })
  await test('Chrome 历史捕获：新签名 URL 触发回调，旧的忽略，超时返回空', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-sso-'))
    try {
      const historyPath = path.join(directory, 'History')
      const chromeTime = (unixSeconds) => Math.round((unixSeconds + 11644473600) * 1000000)
      const now = Date.now() / 1000
      const db = new DatabaseSync(historyPath)
      db.exec('CREATE TABLE urls (url TEXT PRIMARY KEY, last_visit_time INTEGER)')
      db.prepare('INSERT INTO urls VALUES (?, ?)').run('https://www.italent.cn/v1/sso/italent/auth?old=1', chromeTime(now - 7200))
      db.close()
      const watcher = new ChromeSSOWatcher({ historyPath, intervalMs: 20, timeoutMs: 3000 })
      const captured = watcher.wait()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const db2 = new DatabaseSync(historyPath)
      db2.prepare('INSERT INTO urls VALUES (?, ?)').run('https://www.italent.cn/v1/sso/italent/auth?fresh=1', chromeTime(now))
      db2.close()
      const result = await captured
      assert.equal(/fresh=1/.test(result?.url || ''), true)
      const stale = new ChromeSSOWatcher({ historyPath, intervalMs: 20, timeoutMs: 200 })
      assert.equal(await stale.wait(), null)
    } finally {
      fs.rmSync(fs.realpathSync(directory), { recursive: true, force: true })
    }
  })
  await test('SSO 捕获覆盖 Chrome/Edge 多配置：任一 History 出现新签名即触发', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-sso-multi-'))
    try {
      const chromePath = path.join(directory, 'chrome-History')
      const edgePath = path.join(directory, 'edge-History')
      const chromeTime = (unixSeconds) => Math.round((unixSeconds + 11644473600) * 1000000)
      const now = Date.now() / 1000
      for (const file of [chromePath, edgePath]) {
        const db = new DatabaseSync(file)
        db.exec('CREATE TABLE urls (url TEXT PRIMARY KEY, last_visit_time INTEGER)')
        db.prepare('INSERT INTO urls VALUES (?, ?)').run(`https://www.italent.cn/v1/sso/italent/auth?old=${path.basename(file)}`, chromeTime(now - 7200))
        db.close()
      }
      const watcher = new ChromeSSOWatcher({ historyPaths: [chromePath, edgePath], intervalMs: 20, timeoutMs: 3000 })
      const captured = watcher.wait()
      await new Promise((resolve) => setTimeout(resolve, 100))
      const db = new DatabaseSync(edgePath)
      db.prepare('INSERT INTO urls VALUES (?, ?)').run('https://www.italent.cn/v1/sso/italent/auth?fresh=edge', chromeTime(now))
      db.close()
      const result = await captured
      assert.equal(/fresh=edge/.test(result?.url || ''), true)
    } finally {
      fs.rmSync(fs.realpathSync(directory), { recursive: true, force: true })
    }
  })
  console.log(`一键请假自测通过：${passed} 组`)
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { pageFixture }
