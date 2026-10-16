const fs = require('node:fs')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')

const MINUTE = 60000
const PLAN_TTL = 10 * MINUTE
const stamp = (s) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || ''))
  if (!match) return NaN
  const [, y, m, d, h, mi, sec = '0'] = match
  if (+h > 23 || +mi > 59 || +sec > 59) return NaN
  const result = Date.UTC(+y, +m - 1, +d, +h, +mi, +sec)
  return new Date(result).toISOString().slice(0, 10) === `${y}-${m}-${d}` ? result : NaN
}
const formatStamp = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
// 北森请假按完整分钟判断：30 分 59 秒仍按 30 分钟，不把秒数进到下一分钟。
const minuteStamp = (s) => Math.floor(stamp(s) / MINUTE) * MINUTE
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && Number.isFinite(stamp(`${s} 00:00`))
const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '')
const shanghaiDate = (ms = Date.now()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))

function normalizeOptions(input = {}, now = Date.now()) {
  const today = shanghaiDate(now)
  const result = { since: input.since || `${today.slice(0, 7)}-01`, until: input.until || today, workStart: input.workStart || '08:30', workEnd: input.workEnd || '17:30', reason: String(input.reason || '').trim() }
  if (!validDate(result.since) || !validDate(result.until) || result.since > result.until || result.until > today) throw new Error('请选择有效的历史日期范围，截止日期不能晚于今天')
  if (!validTime(result.workStart) || !validTime(result.workEnd) || result.workStart >= result.workEnd) throw new Error('上下班时间应为同一天内的有效时间，且下班晚于上班')
  if (result.reason.length > 1000) throw new Error('请假事由不能超过 1000 字')
  return result
}

function activeLeave(leave) {
  return ['1', '2'].includes(leave.status) && leave.revocation !== '已销假'
}
const overlap = (a, b, c, d) => a < d && c < b
const entryKey = (staffId, entry) => [staffId, entry.typeId, entry.start, entry.end].join('|')
const preparedKey = (entry) => JSON.stringify([entry.typeId, entry.start, entry.end, entry.hours])
const markerId = (entry) => createHash('sha256').update(entry.key).digest('hex')
const matchesMarker = (leave, entry) => activeLeave(leave) && leave.typeId === (entry.typeId || entry.key.split('|')[1]) && leave.start.slice(0, 16) === entry.start && leave.end.slice(0, 16) === entry.end && /^\d+(?:\.\d+)?\s*小时$/.test(leave.hoursText) && Number.parseFloat(leave.hoursText) === entry.hours

function buildPlan(source, options, blocked = {}, banned = new Set()) {
  if (!source?.staffId || !Array.isArray(source.attendance) || !Array.isArray(source.leaves) || !Array.isArray(source.balances)) throw new Error('北森出勤或余额数据不完整')
  const balances = ['调休假', '年假'].map((name) => {
    const item = source.balances.find((row) => row.name === name)
    if (!item || !Number.isFinite(item.hours) || item.hours < 0 || (item.hours > 0 && !item.id)) throw new Error(`${name}余额数据不完整`)
    return { ...item, usable: Math.floor((item.hours + 1e-8) * 2) / 2, used: 0 }
  })
  const rows = []
  const entries = []
  const dates = new Set()
  if (source.leaves.some((leave) => !leave.status || (activeLeave(leave) && (!Number.isFinite(stamp(leave.start)) || !Number.isFinite(stamp(leave.end)) || stamp(leave.start) >= stamp(leave.end))))) throw new Error('已有请假记录不完整，请在北森核对')
  for (const record of [...source.attendance].sort((a, b) => b.date.localeCompare(a.date))) {
    if (record.date < options.since || record.date > options.until) continue
    if (!validDate(record.date) || dates.has(record.date)) throw new Error('出勤日期无效或同一天存在多条记录，请在北森核对')
    dates.add(record.date)
    const row = { date: record.date, firstCard: record.firstCard || '', lateMinutes: 0, hours: 0, status: 'skipped', reason: '', allocations: [] }
    rows.push(row)
    if (record.dayType !== '1') { row.reason = record.dayType ? '非工作日' : '班次类型不明，请在北森核对'; continue }
    if (!record.firstCard) { row.reason = '缺少首打卡，需手动核对'; continue }
    const first = minuteStamp(record.firstCard)
    const start = stamp(`${record.date} ${options.workStart}`)
    const end = stamp(`${record.date} ${options.workEnd}`)
    if (!Number.isFinite(first) || record.firstCard.slice(0, 10) !== record.date || first >= end) { row.status = 'blocked'; row.reason = '首打卡超出当天工作时间，需手动核对'; continue }
    if (first <= start) { row.reason = '未迟到'; continue }
    row.lateMinutes = (first - start) / MINUTE
    row.hours = Math.ceil((first - start) / (30 * MINUTE)) / 2
    const overlaps = source.leaves.filter((leave) => activeLeave(leave) && overlap(start, first, stamp(leave.start), stamp(leave.end)))
    if (overlaps.length) {
      let covered = start
      for (const leave of overlaps.sort((a, b) => a.start.localeCompare(b.start))) {
        if (stamp(leave.start) <= covered && !/部分/.test(leave.revocation || '') && ['1', '3'].includes(leave.documentType)) covered = Math.max(covered, stamp(leave.end))
      }
      row.status = covered >= first ? 'covered' : 'blocked'
      row.reason = covered >= first ? '已有审批中或已通过的请假覆盖' : '存在重叠或部分销假的申请，请在北森核对'
      continue
    }
    if (/(?:假|出差|外出|补签)/.test(record.remark || '')) { row.status = 'blocked'; row.reason = '考勤备注已有相关申请，需手动核对'; continue }
    if (blocked[record.date]) { row.status = 'blocked'; row.reason = blocked[record.date]; continue }
    // 整天只用一种假：优先调休假；调休假盖不住整天迟到时整天改用年假；都不够则先不处理。
    // 平台拒绝过的假种（banned）不参与当天分配，留另一假种兜底。
    const choice = balances.find((balance) => !banned.has(`${record.date}|${balance.id}`) && balance.usable - balance.used + 1e-8 >= row.hours)
    if (!choice) { row.status = 'blocked'; row.reason = '调休假与年假都不足以覆盖当天迟到，先不处理'; continue }
    const entry = { id: `${record.id}:${choice.id}`, date: record.date, firstCard: record.firstCard, start: formatStamp(start), end: formatStamp(first), hours: row.hours, typeId: choice.id, typeName: choice.name }
    choice.used += row.hours
    row.allocations.push(entry)
    entries.push(entry)
    row.status = 'ready'
    row.reason = '待确认'
  }
  return { staffId: source.staffId, staffName: source.staffName, options, rows, entries, balances: balances.map(({ usable, ...item }) => ({ ...item, remaining: Math.round((item.hours - item.used) * 1000000) / 1000000 })), totalHours: entries.reduce((sum, entry) => sum + entry.hours, 0) }
}

function fingerprint(source) {
  const attendance = source.attendance.map(({ id, date, firstCard, dayType, remark }) => ({ id, date, firstCard: Number.isFinite(minuteStamp(firstCard)) ? minuteStamp(firstCard) : firstCard, dayType, remark })).sort((a, b) => a.date.localeCompare(b.date))
  const leaves = source.leaves.filter(activeLeave).sort((a, b) => a.id.localeCompare(b.id))
  const balances = [...source.balances].sort((a, b) => a.name.localeCompare(b.name))
  return createHash('sha256').update(JSON.stringify({ staffId: source.staffId, attendance, leaves, balances })).digest('hex')
}

/** 只保存结果待核对的请求，不保存表单、Cookie 或签名；重启后仍防止盲目重发。 */
function createFileLedger(directory) {
  const file = path.join(directory, 'leave-pending.json')
  return {
    load() {
      if (!fs.existsSync(file)) return []
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(data)) throw new Error('请假待核对记录无法读取，请检查本地数据')
      return data
    },
    save(data) {
      fs.mkdirSync(directory, { recursive: true })
      const temp = `${file}.${randomUUID()}.tmp`
      try { fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(temp, file) }
      finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    },
  }
}

class LeaveService {
  constructor({ adapter, ledger, now = Date.now, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    this.adapter = adapter
    this.ledger = ledger || { load: () => [], save() {} }
    this.now = now
    this.pause = pause
    this.busy = false
    this.pending = null
  }

  async exclusive(fn) {
    if (this.busy) throw new Error('请假操作进行中，请等待完成')
    this.busy = true
    try { return await fn() } finally { this.busy = false }
  }

  connect() { return this.exclusive(() => { this.pending = null; return this.adapter.connect() }) }

  plan(input) {
    return this.exclusive(async () => {
      this.pending = null
      const options = normalizeOptions(input, this.now())
      const source = await this.adapter.read(options)
      const blocked = {}
      const previous = this.ledger.load()
      // 平台迟到入库的申请可以自动核销本地标记；查不到记录时仍需本人确认。
      const ledger = previous.filter((entry) => entry.staffId !== source.staffId || !source.leaves.some((leave) => matchesMarker(leave, entry)))
      if (ledger.length !== previous.length) this.ledger.save(ledger)
      const unresolved = ledger.filter((entry) => entry.staffId === source.staffId && entry.date >= options.since && entry.date <= options.until).map((entry) => ({
        id: markerId(entry), date: entry.date, typeName: entry.typeName, start: entry.start, end: entry.end, hours: entry.hours, at: entry.at,
        message: entry.message || '旧版只保留了待核对标记，未记录具体错误', canRetry: this.now() - Date.parse(entry.at) >= MINUTE,
      }))
      for (const entry of unresolved) blocked[entry.date] = '上次提交结果待核对，请先核查下方记录'
      const prepared = new Map()
      const banned = new Set()
      let plan = buildPlan(source, options, blocked)
      // 平台拒绝某假种时当天改用另一假种重算；两个假种都不可用才阻断当天，余额留给较旧日期。
      while (true) {
        const entry = plan.entries.find((item) => !prepared.has(preparedKey(item)))
        if (!entry) break
        try {
          const result = await this.adapter.prepare({ staffId: source.staffId, entry, reason: options.reason })
          this.verifyPrepared(entry, result)
          prepared.set(preparedKey(entry), true)
        } catch (error) {
          banned.add(`${entry.date}|${entry.typeId}`)
          plan = buildPlan(source, options, blocked, banned)
          const row = plan.rows.find((item) => item.date === entry.date)
          if (row && row.status === 'blocked' && row.reason.includes('先不处理')) row.reason = `北森校验未通过：${error.message}`
        }
      }
      const createdAt = this.now()
      const publicPlan = { ...plan, unresolved, id: randomUUID(), createdAt, expiresAt: createdAt + PLAN_TTL }
      this.pending = { publicPlan, fingerprint: fingerprint(source), blocked }
      return { plan: publicPlan }
    })
  }

  verifyPrepared(entry, result) {
    if (!result?.key || result.start !== entry.start || result.end !== entry.end || result.hours !== entry.hours || result.typeId !== entry.typeId) throw new Error('北森表单与预览方案不一致')
  }

  resolve(input = {}) {
    return this.exclusive(async () => {
      if (input.confirmedMissing !== true) throw new Error('请先在北森核查，并确认没有审批中或已通过的对应申请')
      const plan = this.pending?.publicPlan
      if (!plan || input.planId !== plan.id || this.now() > plan.expiresAt) throw new Error('核对方案已失效，请重新生成')
      if (!plan.unresolved.some((entry) => entry.id === input.markerId)) throw new Error('待核对记录已变化，请重新生成')
      const ledger = this.ledger.load()
      const marker = ledger.find((entry) => entry.staffId === plan.staffId && markerId(entry) === input.markerId)
      if (!marker) throw new Error('待核对记录已变化，请重新生成')
      if (!(this.now() - Date.parse(marker.at) >= MINUTE)) throw new Error('提交不足一分钟，请稍后重新生成并核对，避免平台仍在处理')
      const current = await this.adapter.read({ ...plan.options, staffId: plan.staffId })
      if (current.staffId !== plan.staffId) throw new Error('北森登录账号已变化，请重新生成')
      const overlaps = current.leaves.filter((leave) => activeLeave(leave) && overlap(stamp(marker.start), stamp(marker.end), stamp(leave.start), stamp(leave.end)))
      if (overlaps.length && !overlaps.some((leave) => matchesMarker(leave, marker))) throw new Error('北森已存在重叠申请，请先在平台核对后重新生成')
      this.ledger.save(ledger.filter((entry) => entry !== marker))
      this.pending = null
      return { resolved: true, found: overlaps.length > 0 }
    })
  }

  submit(input = {}) {
    return this.exclusive(async () => {
      if (input.confirmed !== true) throw new Error('请先核对并确认请假方案')
      const pending = this.pending
      if (!pending || input.planId !== pending.publicPlan.id) throw new Error('请假方案已变化，请重新生成并确认')
      if (this.now() > pending.publicPlan.expiresAt) { this.pending = null; throw new Error('请假方案已过期，请重新生成并确认') }
      const plan = pending.publicPlan
      if (!plan.entries.length) throw new Error('没有可提交的请假记录')
      this.pending = null
      const options = { ...plan.options, staffId: plan.staffId }
      const source = await this.adapter.read(options)
      if (fingerprint(source) !== pending.fingerprint) throw new Error('出勤、已有请假或余额发生变化，请重新生成并确认方案')
      const results = plan.entries.map((entry) => ({ ...entry, status: 'notSubmitted', message: '尚未提交' }))
      let ledger = this.ledger.load()
      for (const result of results) {
        const key = entryKey(plan.staffId, result)
        if (ledger.some((item) => item.key === key)) { result.status = 'blocked'; result.message = '存在待核对的提交记录，已停止后续申请'; break }
        let attempted = false
        try {
          const current = await this.adapter.read(options)
          if (current.staffId !== plan.staffId || minuteStamp(current.attendance.find((item) => item.date === result.date)?.firstCard) !== minuteStamp(result.firstCard)) throw new Error('登录账号或首打卡发生变化，请重新生成方案')
          if (current.leaves.some((leave) => activeLeave(leave) && overlap(stamp(result.start), stamp(result.end), stamp(leave.start), stamp(leave.end)))) throw new Error('该时段已有请假申请，请重新生成方案')
          if ((current.balances.find((item) => item.id === result.typeId)?.hours ?? -1) < result.hours) throw new Error('假期余额已不足，请重新生成方案')
          const prepared = await this.adapter.prepare({ staffId: plan.staffId, entry: result, reason: options.reason })
          this.verifyPrepared(result, prepared)
          const marker = { key, staffId: plan.staffId, typeId: result.typeId, date: result.date, typeName: result.typeName, start: result.start, end: result.end, hours: result.hours, at: new Date(this.now()).toISOString() }
          ledger.push(marker)
          this.ledger.save(ledger)
          attempted = true
          await this.adapter.apply({ staffId: plan.staffId, key: prepared.key, confirmed: true })
          let found = null
          for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt) await this.pause(1500)
            try {
              const check = await this.adapter.read(options)
              if (check.staffId !== plan.staffId) throw new Error('北森登录账号已变化')
              found = check.leaves.find((leave) => activeLeave(leave) && leave.typeId === result.typeId && leave.start.slice(0, 16) === result.start && leave.end.slice(0, 16) === result.end && /^\d+(?:\.\d+)?\s*小时$/.test(leave.hoursText) && Number.parseFloat(leave.hoursText) === result.hours)
              if (found) break
            } catch { /* 回查暂时失败时只重查，不重复发送。 */ }
          }
          if (!found) throw new Error('平台尚未确认申请结果，请先到北森核对；后续记录已停止')
          result.status = 'success'
          result.message = '已提交，平台记录回查确认'
          result.recordId = found.id
          ledger = ledger.filter((item) => item.key !== key)
          this.ledger.save(ledger)
        } catch (error) {
          const uncertain = attempted && error.submissionState !== 'notSubmitted'
          result.status = uncertain ? 'unknown' : 'failed'
          result.message = error.message
          if (attempted) {
            ledger = uncertain ? ledger.map((entry) => entry.key === key ? { ...entry, message: result.message } : entry) : ledger.filter((entry) => entry.key !== key)
            try { this.ledger.save(ledger) } catch { result.message += '；本地核对状态保存失败，请先核对北森记录' }
          }
          break
        }
      }
      return { results, completed: results.every((item) => item.status === 'success') }
    })
  }
}

module.exports = { LeaveService, createFileLedger, buildPlan, normalizeOptions, stamp, fingerprint }
