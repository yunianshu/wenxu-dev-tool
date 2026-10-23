/** 在北森页面上下文执行；所有接口与字段取自北森当前表单元数据。 */
async function italentPage(action, options = {}) {
  // probe 需要在登录页上执行，不能被来源检查拦截。
  if (action !== 'probe' && location.origin !== 'https://cloud.italent.cn') throw new Error('请先在浏览器登录北森，再连接一键请假')
  const attendance = 'Attendance.AttendanceStatistics'
  const vacation = 'Attendance.AttendanceVacationInfo'
  const formView = 'Attendance.EmployeeVacationFormView'
  const nav = 'Attendance.EmployeeVacationNavView'
  const value = (row, key) => String(row?.[key]?.value ?? '')
  const text = (row, key) => String(row?.[key]?.text ?? '')
  const date = (s) => String(s || '').replaceAll('/', '-').replace('T', ' ').slice(0, 19)
  const nodes = (root, predicate) => {
    const result = []
    function visit(item) {
      if (!item || typeof item !== 'object') return
      if (predicate(item)) result.push(item)
      Object.values(item).forEach((child) => { if (child && typeof child === 'object') visit(child) })
    }
    visit(root)
    return result
  }
  async function api(path, query = {}, body, formEncoded = false) {
    const url = new URL(path, location.origin)
    url.search = new URLSearchParams({ app: 'Attendance', ...query }).toString()
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'include',
      headers: { 'Content-Type': formEncoded ? 'application/x-www-form-urlencoded' : 'application/json', ...(formEncoded ? { 'X-Sourced-By': 'ajax' } : {}) },
      ...(body === undefined ? {} : { body: formEncoded ? new URLSearchParams({ dataObject: JSON.stringify(body) }).toString() : JSON.stringify(body) }),
      signal: AbortSignal.timeout(25000),
    })
    if (!response.ok) {
      const error = new Error([401, 403].includes(response.status) ? '北森登录失效或没有请假权限，请在浏览器核对登录后重试' : `北森请求失败（${response.status}），请核对平台结果`)
      if ([400, 401, 403, 404, 405, 422].includes(response.status)) error.submissionState = 'notSubmitted'
      throw error
    }
    let data
    try { data = await response.json() } catch { throw new Error('北森登录已失效或返回内容无法识别，请在浏览器重新登录') }
    if (!data || typeof data !== 'object' || data.error || data.tipType === 'error' || data.Message) {
      const error = new Error(String(data?.message || data?.error?.message || '北森返回错误，请在浏览器核对后重试').slice(0, 300))
      error.submissionState = 'notSubmitted'
      throw error
    }
    return data
  }
  async function list(kind) {
    const isAttendance = kind === 'attendance'
    const metaObjName = isAttendance ? attendance : vacation
    const navViewName = isAttendance ? 'Attendance.AttendanceDataRecordNavView' : nav
    const index = await api('/api/v2/UI/IndexPage', { metaObjName, [isAttendance ? 'viewName' : 'navViewName']: navViewName, excludeDataSource: 'true' })
    const table = nodes(index, (x) => x.cmp_type === 'TableList' && x.cmp_data?.metaObjName === metaObjName)[0]
    const search = nodes(index, (x) => x.cmp_type === 'SearchForm' && x.cmp_data?.metaObjectName === metaObjName)[0]
    if (!table || !search || !search.biz_data) throw new Error('北森出勤列表结构已变化，无法可靠读取')
    const items = Object.values(search.biz_data).map((item) => ({ ...item, metaObjName: '', metaFieldRelationIDPath: '', queryAreaSubNodes: false }))
    const staff = items.find((item) => item.name === `${metaObjName}.StaffId`)
    if (!staff?.value) throw new Error('未能识别当前登录员工，已停止读取')
    if (options.staffId && options.staffId !== staff.value) throw new Error('北森登录账号已变化，请重新生成方案')
    if (isAttendance) {
      const field = items.find((item) => item.name === `${metaObjName}.SwipingCardDate`)
      if (!field) throw new Error('未能识别考勤日期过滤条件')
      field.text = field.value = `${options.since.replaceAll('-', '/')}-${options.until.replaceAll('-', '/')}`
    }
    let tableData = { ...table.cmp_data, navViewName }
    const result = []
    const ids = new Set()
    let total = null
    for (let page = 0; page < 100; page++) {
      const data = await api('/api/v2/UI/TableList', { metaObjName, viewName: tableData.viewName, navViewName, 'PaaS-SourceApp': 'Attendance', 'PaaS-CurrentView': navViewName }, {
        table_data: { ...tableData, paging: { ...tableData.paging, capacity: 100, page } },
        search_data: { metaObjName, searchView: search.cmp_data.viewName, items, searchFormFilterJson: null },
      })
      const count = data.cmp_data?.paging?.total
      if (!Number.isInteger(count) || count < 0 || !Array.isArray(data.biz_data)) throw new Error('北森分页响应无法识别，未生成方案')
      if (total !== null && count !== total) throw new Error('读取期间北森记录数量发生变化，请重试')
      total = count
      for (const row of data.biz_data) {
        const id = value(row, '_id')
        if (!id || ids.has(id) || value(row, 'StaffId') !== String(staff.value)) throw new Error('北森记录存在重复、缺少标识或员工不匹配，已停止读取')
        ids.add(id)
        result.push(row)
      }
      if (result.length >= total) {
        if (result.length !== total) throw new Error('北森分页总数不一致')
        return { staffId: String(staff.value), staffName: staff.text, rows: result }
      }
      if (!data.biz_data.length) throw new Error('北森分页缺失，无法确认完整记录')
      tableData = { ...tableData, ...data.cmp_data }
    }
    throw new Error('北森记录过多，未能读取完整列表')
  }
  const formQuery = { metaObjName: vacation, formState: 'create', viewName: formView, method: 'POST', btnMetaObjectName_sa: vacation, btnCode_sa: 'EmployeeVacationBtn', currentViewName: 'Attendance_EmployeeVacationNavView', rootPageType: '1', rootPage: nav, formType: '01', 'PaaS-SourceApp': 'Attendance', 'PaaS-CurrentView': nav }
  // 探测登录态：未登录时页面停在登录域；已加载页面的会话可能已过期，用一次已认证请求核实。
  if (action === 'probe') {
    const origin = location.origin
    if (origin !== 'https://cloud.italent.cn') return { origin, loggedIn: false }
    try { await api('/api/v2/UI/IndexPage', { metaObjName: vacation, viewName: nav, excludeDataSource: 'true' }); return { origin, loggedIn: true } }
    catch { return { origin, loggedIn: false } }
  }
  async function getForm() {
    const form = await api('/api/v2/UI/FormView', formQuery)
    const data = form.biz_data?.[0]
    if (!data || !value(data, 'StaffId')) throw new Error('北森请假表单缺少当前员工信息')
    if (options.staffId && value(data, 'StaffId') !== options.staffId) throw new Error('北森登录账号已变化，请重新生成方案')
    const typeField = nodes(form, (x) => x.cmp_data?.field_name === 'OIdVacationType')[0]
    if (!typeField?.cmp_data?.datasourcename) throw new Error('北森假种数据源无法识别')
    const refreshParams = String(typeField.cmp_data.refreshParams || '').replace(/\{formData\.([^}]+)\}/g, (_match, name) => value(data, name))
    const sources = await api('/api/v2/data/datasource', { metaObjName: vacation, enableShortcut: 'true', scence: 'form', sourceMetaObjName: vacation }, [{
      fieldName: 'OIdVacationType', dsName: typeField.cmp_data.datasourcename, fieldMetaObjectName: vacation,
      filter: new URLSearchParams({ app: 'Attendance', ...formQuery }).toString(), refreshParams, enableAsyncSearch: false,
    }])
    const types = sources.find?.((item) => item.fieldName === 'OIdVacationType')?.dataSourceResults
    if (!Array.isArray(types)) throw new Error('北森假期余额无法识别')
    if (['调休假', '年假', '事假', '请假'].some((name) => types.filter((item) => item.text === name && String(item.isActive) === '1').length > 1)) throw new Error('存在同名假种，无法确定扣减账户，请在北森核对')
    return { form, data, types }
  }
  function balances(types) {
    const result = ['调休假', '年假'].map((name) => {
      const type = types.find((item) => item.text === name && String(item.isActive) === '1')
      if (!type) return { name, id: '', hours: 0, available: false }
      let remaining
      try { remaining = JSON.parse(type.extAttr?.Remain || 'null') } catch { /* 下方统一报告无法识别余额。 */ }
      const parts = Array.isArray(remaining) ? remaining : []
      const amounts = parts.map((part) => /(?:^|\s)(\d+(?:\.\d+)?)\s*小时\s*$/.exec(String(part)))
      if (!parts.length || amounts.some((match) => !match)) throw new Error(`${name}余额单位或数值无法识别，请在北森核对`)
      const hours = Math.round(amounts.reduce((sum, match) => sum + Number(match[1]), 0) * 1000000) / 1000000
      return { name, id: String(type.value), hours, available: true }
    })
    // 调休+年假不足时用事假兜底；不设余额上限，平台校验拒绝时由当天阻断兜底。
    const fallbacks = types.filter((item) => ['事假', '请假'].includes(item.text) && String(item.isActive) === '1')
    if (fallbacks.length > 1) throw new Error('存在多个候补假种（事假/请假），无法确定扣减账户，请在北森核对')
    const fallback = fallbacks[0]
    result.push(fallback
      ? { name: fallback.text, id: String(fallback.value), hours: null, unlimited: true, available: true }
      : { name: '事假', id: '', hours: 0, available: false })
    return result
  }
  // 调休条目列表（加班获得日 + 有效期 + 剩余）：请假日只能使用获得日更早且未过期的条目。
  async function exchange(options) {
    const meta = 'Attendance.ExchangeLeave'
    const nav = 'Attendance.ExchangeLeaveStaffSearchForm'
    const index = await api('/api/v2/UI/IndexPage', { metaObjName: meta, navViewName: nav, excludeDataSource: 'true' })
    const table = nodes(index, (x) => x.cmp_type === 'TableList' && x.cmp_data?.metaObjName === meta)[0]
    const search = nodes(index, (x) => x.cmp_type === 'SearchForm' && x.cmp_data?.metaObjectName === meta)[0]
    if (!table || !search || !search.biz_data) throw new Error('北森调休记录结构已变化，无法可靠读取')
    const items = Object.values(search.biz_data).map((item) => ({ ...item, metaObjName: '', metaFieldRelationIDPath: '', queryAreaSubNodes: false }))
    const staff = items.find((item) => item.name === `${meta}.StaffId`)
    if (!staff?.value) throw new Error('未能识别当前登录员工，已停止读取')
    if (options.staffId && options.staffId !== staff.value) throw new Error('北森登录账号已变化，请重新生成方案')
    let tableData = { ...table.cmp_data }
    const entries = []
    const seen = new Set()
    let total = null
    for (let page = 0; page < 20; page++) {
      const data = await api('/api/v2/UI/TableList', { metaObjName: meta, viewName: tableData.viewName, navViewName: nav, 'PaaS-SourceApp': 'Attendance', 'PaaS-CurrentView': nav }, {
        table_data: { ...tableData, paging: { ...tableData.paging, capacity: 100, page } },
        search_data: { metaObjName: meta, searchView: search.cmp_data.viewName, items, searchFormFilterJson: null },
      })
      const count = data.cmp_data?.paging?.total
      if (!Number.isInteger(count) || count < 0 || !Array.isArray(data.biz_data)) throw new Error('北森调休记录分页响应无法识别，未生成方案')
      if (total !== null && count !== total) throw new Error('读取期间北森调休记录数量发生变化，请重试')
      total = count
      for (const row of data.biz_data) {
        const id = value(row, '_id') || [value(row, 'OvertimeDate'), value(row, 'ValidityDate'), value(row, 'Limit'), value(row, 'Balance')].join('|')
        if (!id || seen.has(id)) throw new Error('北森调休记录存在重复或缺少标识，已停止读取')
        seen.add(id)
        if (value(row, 'Condition') !== '0') continue
        const earned = date(value(row, 'OvertimeDate')).slice(0, 10)
        const expires = date(value(row, 'ValidityDate')).slice(0, 10)
        const hours = Number(value(row, 'Balance'))
        if (!/^\d{4}-\d{2}-\d{2}$/.test(earned) || !/^\d{4}-\d{2}-\d{2}$/.test(expires) || !Number.isFinite(hours) || hours < 0) throw new Error('北森调休记录字段不完整，无法确认可用日期')
        entries.push({ id, earnedDate: earned, expires, hours })
      }
      if (seen.size >= total) return entries
      if (!data.biz_data.length) throw new Error('北森调休记录分页缺失，无法确认完整记录')
      tableData = { ...tableData, ...data.cmp_data }
    }
    throw new Error('北森调休记录过多，未能读取完整列表')
  }
  if (action === 'read') {
    const source = await list('attendance')
    options.staffId = source.staffId
    const leaves = await list('vacation')
    const form = await getForm()
    if (leaves.rows.some((row) => !value(row, 'VacationStartDateTime') || !value(row, 'VacationStopDateTime') || !value(row, 'ApproveStatus'))) throw new Error('北森已有请假记录字段不完整，无法确认是否重复')
    return {
      staffId: source.staffId, staffName: source.staffName,
      attendance: source.rows.map((row) => ({ id: value(row, '_id'), date: date(value(row, 'SwipingCardDate')).slice(0, 10), firstCard: date(value(row, 'ActualForFirstCard')), lastCard: date(value(row, 'ActualForLastCard')), dayType: value(row, 'DateType'), status: text(row, 'AttendanceStatusDetail'), remark: text(row, 'RetroactiveRemark') || value(row, 'RetroactiveRemark') })),
      leaves: leaves.rows.map((row) => ({ id: value(row, '_id'), typeId: value(row, 'OIdVacationType'), typeName: text(row, 'OIdVacationType'), start: date(value(row, 'VacationStartDateTime')), end: date(value(row, 'VacationStopDateTime')), hoursText: text(row, 'VacationDurationIncludeUnit'), status: value(row, 'ApproveStatus'), statusText: text(row, 'ApproveStatus'), revocation: text(row, 'RevocationStatus'), documentType: value(row, 'DocumentType') })).filter((row) => row.start.slice(0, 10) <= options.until && row.end.slice(0, 10) >= options.since),
      balances: balances(form.types),
      compEntries: await exchange(options),
    }
  }
  if (action === 'prepare') {
    const { form, data, types } = await getForm()
    const entry = options.entry
    const type = types.find((item) => item.value === entry.typeId && item.text === entry.typeName)
    if (!type) throw new Error('假种已变化，请重新生成方案')
    const fields = { ...data }
    const set = (name, val, label = val) => { fields[name] = { name, value: val, text: label } }
    set('OIdVacationType', type.value, type.text)
    const changes = async (name) => {
      const node = nodes(form, (x) => x.cmp_data?.field_name === name)[0]
      if (!node?.cmp_data?.fieldChangeTriggerId) throw new Error('北森请假表单缺少时长计算规则')
      const changed = await api('/api/v2/Ext/FieldChange', formQuery, {
        formMetaObjectName: vacation, formState: 'create', formName: form.cmp_name,
        currentChangedField: { name, triggerID: node.cmp_data.fieldChangeTriggerId }, metaFields: Object.values(fields),
      })
      if (!Array.isArray(changed.targetToChangeFields)) throw new Error('北森请假时长计算失败')
      for (const field of changed.targetToChangeFields) set(field.name, field.value, field.text)
    }
    await changes('OIdVacationType')
    set('VacationStartDateTime', entry.start.replaceAll('-', '/'))
    set('VacationStopDateTime', entry.end.replaceAll('-', '/'))
    set('VacationStartDate', entry.date.replaceAll('-', '/'))
    set('VacationStopDate', entry.date.replaceAll('-', '/'))
    await changes('VacationStartDateTime')
    // 起点联动可能调整终点，再用用户已确认的终点触发最终计算。
    set('VacationStopDateTime', entry.end.replaceAll('-', '/'))
    await changes('VacationStopDateTime')
    set('Description', options.reason || '')
    const platformStart = date(value(fields, 'VacationStartDateTime')).slice(0, 16)
    const platformEnd = date(value(fields, 'VacationStopDateTime')).slice(0, 16)
    const hours = /^(\d+(?:\.\d+)?)\s*小时$/.exec(value(fields, 'VacationDurationIncludeUnit'))
    if (platformStart !== entry.start || platformEnd !== entry.end || !hours || Number(hours[1]) !== entry.hours) throw new Error('北森计算的起止时间或扣减时长与方案不一致，请在平台核对')
    // 与原生表单一样只发送绑定控件的字段，排除 _id、IsFirst 等内部初始化/计算数据。
    const bound = new Set(nodes(form, (x) => x.cmp_data?.field_name).map((x) => x.cmp_data.field_name))
    const payload = { metaFields: Object.entries(fields).filter(([name]) => bound.has(name)).map(([name, field]) => ({ name, text: field.text, value: field.value, metaObjName: vacation })), viewName: formView, checkRequired: true, formState: 'create' }
    const verified = await api('/VacationDomainMRest/100000/AgainVerify/AttendanceVacationInfoFromVerify', { ...formQuery, metaObjName: vacation }, payload)
    if (verified.flag !== false || verified.message || verified.listMessage?.length || Number(verified.StrictControl || 0) !== 0 || Number(verified.IsBeyondEstablishment || 0) !== 0) throw new Error(String(verified.message || '北森要求额外确认，请到平台核对后重新生成方案').slice(0, 300))
    // 完整报文只在浏览器内存保留，桌面端只能用一次性标识提交。
    const key = crypto.randomUUID()
    window.__plmLeavePrepared ||= new Map()
    const now = Date.now()
    for (const [id, saved] of window.__plmLeavePrepared) if (now - saved.at > 10 * 60 * 1000) window.__plmLeavePrepared.delete(id)
    window.__plmLeavePrepared.set(key, { payload, staffId: value(fields, 'StaffId'), at: now })
    return { key, start: platformStart, end: platformEnd, hours: Number(hours[1]), typeId: type.value }
  }
  if (action === 'apply') {
    if (options.confirmed !== true) throw new Error('请先确认请假方案')
    let sending = false
    try {
      const saved = window.__plmLeavePrepared?.get(options.key)
      if (!saved || Date.now() - saved.at > 10 * 60 * 1000) throw new Error('请假表单已失效，请重新生成并确认')
      window.__plmLeavePrepared.delete(options.key)
      const current = await getForm()
      if (value(current.data, 'StaffId') !== saved.staffId) throw new Error('北森登录账号已变化，已停止提交')
      sending = true
      // 原生表单把 JSON 放在 dataObject 表单字段中；只读校验接口仍接收 JSON。
      const data = await api('/VacationDomainMRest/100000/AttendanceVacation/ApplyVacation', {
        navViewName: nav, btnCode_sa: 'EmployeeVacationBtn', btnMetaObjectName_sa: vacation,
        'PaaS-SourceApp': 'Attendance', 'PaaS-SourceView': nav, 'PaaS-SourceMetaObj': vacation,
        'PaaS-CurrentView': nav, showCard: 'true', rootPage: nav, rootPageType: '1', _qsrcapp: 'attendance',
      }, { ...saved.payload, checkRequired: false }, true)
      if (data.tipType && !['normalTip', 'success'].includes(data.tipType)) {
        const error = new Error(String(data.message || '北森要求额外确认，请在平台核对后重试').slice(0, 300))
        // 额外确认或警告不一定能证明后台完全没有受理，保持待核对。
        throw error
      }
      // 北森可能异步入库；HTTP 成功仅表示已发送，成功状态由后台回查确认。
      return { sent: true }
    } catch (error) {
      if (!sending) error.submissionState = 'notSubmitted'
      throw error
    }
  }
  throw new Error('未知北森操作')
}

module.exports = { italentPage }
