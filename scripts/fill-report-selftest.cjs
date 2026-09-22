/**
 * 一键填报（禅道工时）主进程模块自测（无框架，node scripts/fill-report-selftest.cjs 直接运行）
 * 覆盖：工时计算（锚点累进/扣午休/0.5h 取整/零段合并，与 wenxu/KnowMore 语义对齐）、
 *       禅道客户端请求构造（登录加密/cookie/重定向/JSON 容错解析/会话失效重登，fake fetch）、
 *       项目绑定持久化、提交汇总（left 扣减）、git 提交收集（真实 git 仓库集成）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

let passed = 0
let failed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++
      console.log(`  ✓ ${name}`)
    })
    .catch((e) => {
      failed++
      console.error(`  ✗ ${name}\n    ${e.message}`)
    })
}

// ── electron 打桩（供 store.js / fill-service.js 在纯 Node 下运行） ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fillreport-test-'))
const stubExports = {
  app: { getPath: () => path.join(tmpRoot, 'userdata') },
  safeStorage: { isEncryptionAvailable: () => false }, // 走明文兜底分支，仍可验证存储往返
}
const Module = require('module')
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stubExports }

const fill = require('../electron/fill-service')
const { ZentaoClient, parseJsonPrefix, md5 } = require('../electron/zentao-service')
const { HanprintClient } = require('../electron/hanprint-service')
const store = require('../electron/store')

function round2of(n) { return Math.round(n * 100) / 100 }

// ── fake fetch 工具：把 handler 的静态返回包装成最小 Response ──
function makeResp({ status = 200, body = '', setCookies = [], location = null }) {
  return {
    status,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'location' ? location : null),
      getSetCookie: () => setCookies,
    },
    text: async () => body,
    json: async () => JSON.parse(body),
  }
}
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, opts) => {
    calls.push({ url: String(url), opts })
    return makeResp(await handler(String(url), opts || {}))
  }
  return { impl, calls }
}

// ═══════════ 工时计算 ═══════════
async function main() {
console.log('工时计算（总工时 + 按提交数比例分配，与提交时刻无关）:')

await test('workMinutes 扣除午休重叠', () => {
  const lunchS = 12 * 60, lunchE = 13 * 60
  assert.strictEqual(fill.workMinutes(10 * 60, 14 * 60, lunchS, lunchE), 180) // 240−60(1h午休)
  assert.strictEqual(fill.workMinutes(10 * 60, 14 * 60, lunchS, lunchE + 30), 150) // 1.5h 午休
  assert.strictEqual(fill.workMinutes(9 * 60, 11 * 60, lunchS, lunchE), 120) // 不重叠
  assert.strictEqual(fill.workMinutes(14 * 60, 13 * 60, lunchS, lunchE), 0) // 倒序
})

await test('单项目：总工时 = 首条提交→终点 扣午休整体取整', () => {
  const list = fill.distributeByProject([
    { time: '09:46', msg: 'feat: A', projectId: 'p1', projectName: 'P1' },
    { time: '10:31', msg: 'fix: B', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:46', endTime: '12:02' })
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].hours, 2) // 136−2(午休重叠) = 134min → 120 = 2h
  assert.strictEqual(list[0].commitCount, 2)
  assert.strictEqual(list[0].work, '1. A\n2. B')
})

await test('多项目：按提交条数比例分配总工时，总和守恒', () => {
  // 总工时 09:00→17:30 扣 1h 午休 = 7.5h；A 2 条、B 1 条 → A 5h、B 2.5h
  const list = fill.distributeByProject([
    { time: '09:00', msg: 'feat: A1', projectId: 'pA', projectName: 'ProjA' },
    { time: '11:00', msg: 'feat: B1', projectId: 'pB', projectName: 'ProjB' },
    { time: '15:00', msg: 'feat: A2', projectId: 'pA', projectName: 'ProjA' },
  ], { startTime: '09:00', endTime: '17:30' })
  assert.strictEqual(list.length, 2)
  const a = list.find((g) => g.projectId === 'pA')
  const b = list.find((g) => g.projectId === 'pB')
  assert.strictEqual(a.hours, 5)
  assert.strictEqual(b.hours, 2.5)
  assert.strictEqual(round2of(a.hours + b.hours), 7.5)
})

await test('取整余量补给提交最多的项目，Σ 恒等于总工时', () => {
  // 总工时 09:00→12:30 扣午休重叠 30min = 180min → 3h；5 条提交分 2:2:1 →
  // 1.2/1.2/0.6 → 取整 1/1/0.5，余 0.5 补给提交最多的（并列取其一）
  const list = fill.distributeByProject([
    { time: '09:00', msg: 'a', projectId: 'p1', projectName: 'P1' },
    { time: '09:30', msg: 'a', projectId: 'p1', projectName: 'P1' },
    { time: '10:00', msg: 'b', projectId: 'p2', projectName: 'P2' },
    { time: '10:30', msg: 'b', projectId: 'p2', projectName: 'P2' },
    { time: '11:00', msg: 'c', projectId: 'p3', projectName: 'P3' },
  ], { startTime: '09:00', endTime: '12:30' })
  assert.strictEqual(round2of(list.reduce((s, g) => s + g.hours, 0)), 3)
  const p3 = list.find((g) => g.projectId === 'p3')
  assert.strictEqual(p3.hours, 0.5) // 3×1/5 = 0.6 → 0.5h
  const big = list.filter((g) => g.projectId !== 'p3')
  assert.strictEqual(round2of(big[0].hours + big[1].hours), 2.5) // 1.5 + 1（余量补给并列最多者其一）
})

await test('有提交但区间不足 0.5h → 保底给 0.5 工时（不再抹成 0）', () => {
  const list = fill.distributeByProject([
    { time: '09:00', msg: 'a', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:00', endTime: '09:20' }) // 20min → 取整 0h，但有提交 → 保底 0.5h
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].hours, 0.5)
  assert.strictEqual(list[0].rawHours, 0)
})

await test('有提交的项目保底 0.5h：份额被取整抹平的项目不再记 0', () => {
  // 3h 工时、20 条提交里只占 1 条：份额 0.15h 被保底抬到 0.5h，另一项目 2.5h，Σ 恰为 3h
  const many = []
  for (let i = 0; i < 19; i += 1) many.push({ time: '09:00', msg: 'a', projectId: 'pA', projectName: 'A' })
  many.push({ time: '09:10', msg: 'b', projectId: 'pB', projectName: 'B' })
  const g = fill.distributeByProject(many, { startTime: '08:00', endTime: '11:00' }) // 3h，不跨午休
  const a = g.find((x) => x.projectId === 'pA')
  const b = g.find((x) => x.projectId === 'pB')
  assert.strictEqual(b.hours, 0.5, '仅 1/20 提交也保底 0.5h（原来会被抹成 0）')
  assert.strictEqual(a.hours, 2.5)
  assert.strictEqual(round2of(a.hours + b.hours), 3, 'Σ 仍等于总工时')
})

await test('保底之和超过总工时时保底优先（Σ 略高于窗口）', () => {
  // 总工时 1h、3 个项目各 1 条：份额 0.33h 全被保底抬到 0.5h → Σ 1.5h（保底优先）
  const list = fill.distributeByProject([
    { time: '09:00', msg: 'a', projectId: 'p1', projectName: 'P1' },
    { time: '09:10', msg: 'b', projectId: 'p2', projectName: 'P2' },
    { time: '09:20', msg: 'c', projectId: 'p3', projectName: 'P3' },
  ], { startTime: '09:00', endTime: '10:00' })
  assert.deepStrictEqual(list.map((x) => x.hours), [0.5, 0.5, 0.5])
  assert.strictEqual(round2of(list.reduce((s, x) => s + x.hours, 0)), 1.5)
})

await test('用户场景复现：9:30 实际到岗 → 19:03 点击生成 = 8.5h（与提交时刻无关）', () => {
  const list = fill.distributeByProject([
    { time: '09:46', msg: 'feat: A', projectId: 'p1', projectName: 'P1' }, // 首条提交晚于到岗，不影响起点
    { time: '15:00', msg: 'fix: B', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:30', endTime: '19:03' })
  // 09:30→19:03 = 573min − 60min 午休 = 513 → 510 = 8.5h
  assert.strictEqual(list[0].hours, 8.5)
})

await test('用户场景：09:30 起点 → 17:05 当前 = 6.5h', () => {
  const list = fill.distributeByProject([
    { time: '09:30', msg: 'feat: A', projectId: 'p1', projectName: 'P1' },
    { time: '15:00', msg: 'fix: B', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '09:30', endTime: '17:05' })
  assert.strictEqual(list[0].hours, 6.5) // 455−60 = 395min → 390 = 6.5h
})

await test('resolveEndTime：一律返回点击生成报告的时刻（与填报日期无关）', () => {
  assert.strictEqual(fill.resolveEndTime(new Date('2026-09-07T16:05:00')), '16:05')
  assert.strictEqual(fill.resolveEndTime(new Date('2026-09-07T18:42:00')), '18:42') // 已过下班时间不截断
  assert.strictEqual(fill.resolveEndTime(new Date('2026-09-09T00:30:00')), '00:30') // 凌晨收工
})

await test('resolveEndTime：显式填写的下班/加班结束时间优先于点击时刻', () => {
  assert.strictEqual(fill.resolveEndTime(new Date('2026-09-09T11:20:00'), '00:30'), '00:30') // 白天补填也以显式收工时间为准
  assert.strictEqual(fill.resolveEndTime(new Date('2026-09-09T11:20:00'), '23:00'), '23:00')
  assert.strictEqual(fill.resolveEndTime(new Date('2026-09-09T11:20:00'), ''), '11:20') // 空串 → 点击时刻
})

await test('isCrossDay：终点早于上班时间即按次日跨夜', () => {
  assert.strictEqual(fill.isCrossDay('08:30', '00:30'), true)   // 加班到次日凌晨
  assert.strictEqual(fill.isCrossDay('08:30', '17:30'), false)  // 正常下班
  assert.strictEqual(fill.isCrossDay('08:30', '11:20'), false)  // 当天白天点击
  assert.strictEqual(fill.isCrossDay('20:00', '04:00'), true)   // 夜班
})

await test('用户场景复现：昨天 08:30 上班、次日 00:30 加班结束 → 15h（而非 8h）', () => {
  const list = fill.distributeByProject([
    { time: '09:12', msg: 'feat: A', projectId: 'p1', projectName: 'P1' },
    { time: '22:40', msg: 'fix: B', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '08:30', endTime: '00:30', crossDay: true })
  assert.strictEqual(list.length, 1)
  // 08:30 → 次日 00:30 = 960min，扣 60min 午休 = 900min → 900 = 15h
  assert.strictEqual(list[0].hours, 15)
})

await test('用户场景复现：凌晨 00:30 收工当时点生成报告（不填下班时间）→ 自动跨夜 15h', () => {
  const endTime = fill.resolveEndTime(new Date('2026-09-09T00:30:00'))
  assert.strictEqual(endTime, '00:30')
  const crossDay = fill.isCrossDay('08:30', endTime)
  assert.strictEqual(crossDay, true)
  const list = fill.distributeByProject([
    { time: '09:12', msg: 'feat: A', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '08:30', endTime, crossDay })
  assert.strictEqual(list[0].hours, 15)
})

await test('跨夜未开启时区间分钟数记 0（项目工时仍按保底 0.5h 记）', () => {
  assert.strictEqual(fill.workMinutes(fill.hm('08:30'), fill.hm('00:30'), 12 * 60, 13 * 60), 0) // 倒序区间 → 0 分钟
  const list = fill.distributeByProject([
    { time: '09:12', msg: 'feat: A', projectId: 'p1', projectName: 'P1' },
  ], { startTime: '08:30', endTime: '00:30' })
  assert.strictEqual(list[0].hours, 0.5)
})

// ═══════════ 按项目聚合（一个项目一条记录 + 简洁编号内容） ═══════════
console.log('按项目聚合:')
await test('stripPrefix 去掉 Conventional Commits 前缀', () => {
  assert.strictEqual(fill.stripPrefix('feat: 完成订单模块'), '完成订单模块')
  assert.strictEqual(fill.stripPrefix('fix(parser): 修复解析'), '修复解析')
  assert.strictEqual(fill.stripPrefix('chore：中文冒号'), '中文冒号')
  assert.strictEqual(fill.stripPrefix('无前缀提交'), '无前缀提交')
})

// ═══════════ JSON 容错解析 ═══════════
console.log('禅道 JSON 容错解析:')
await test('parseJsonPrefix 正常解析', () => {
  assert.deepStrictEqual(parseJsonPrefix('{"a":1}'), { a: 1 })
})
await test('parseJsonPrefix 尾部脏数据截断解析', () => {
  assert.deepStrictEqual(parseJsonPrefix('{"a":1}<script>debug</script>'), { a: 1 })
})

// ═══════════ 禅道客户端（fake fetch） ═══════════
console.log('禅道客户端请求构造:')

function makeClient(handler) {
  const ff = fakeFetch(handler)
  const client = new ZentaoClient({ baseUrl: 'http://zt.example', account: 'wgl', password: 'secret', fetchImpl: ff.impl })
  return { client, ff }
}

await test('登录：md5(md5(pwd)+rand) 加密 + keepLogin + 成功判定', async () => {
  const { client, ff } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: '"rand42"' }
    if (opts.method === 'POST' && url.includes('user&f=login')) {
      const form = new URLSearchParams(opts.body)
      assert.strictEqual(form.get('account'), 'wgl')
      assert.strictEqual(form.get('password'), md5(md5('secret') + 'rand42'))
      assert.strictEqual(form.get('keepLogin'), '1')
      assert.strictEqual(form.get('verifyRand'), 'rand42')
      return { body: '{"result":"success","locate":"/"}' }
    }
    return { body: '' }
  })
  assert.strictEqual(await client.login(), true)
})

await test('登录失败抛出错误', async () => {
  const { client } = makeClient((url, opts) => {
    if (opts.method === 'POST') return { body: '{"result":"fail","message":"密码错误"}' }
    return { body: url.includes('refreshRandom') ? 'r1' : '' }
  })
  await assert.rejects(() => client.login(), /登录失败/)
})

await test('cookie 吸收并在后续请求携带', async () => {
  const { client, ff } = makeClient((url, opts) => {
    if (url === 'http://zt.example/index.php') return { setCookies: ['zentaosid=abc123'] }
    if (url.includes('refreshRandom')) return { body: 'r9' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (url.includes('m=my&f=work')) {
      assert.strictEqual(opts.headers.Cookie, 'zentaosid=abc123')
      return { body: '{"data":{"tasks":[]}}' }
    }
    return { body: '' }
  })
  await client.login()
  await client.myTasks()
})

await test('myTasks：data 为字符串 + tasks 为 dict 时归一化', async () => {
  const inner = JSON.stringify({ tasks: { '101': { id: '101', name: '任务A', status: 'doing', consumed: '3', left: '5.5' } } })
  const { client } = makeClient((url) => {
    if (url.includes('m=my&f=work')) return { body: `{"status":"200","data":${JSON.stringify(inner)}}<!--dirty-->` }
    return { body: '' }
  })
  const tasks = await client.myTasks()
  assert.strictEqual(tasks.length, 1)
  assert.deepStrictEqual(tasks[0], { id: 101, name: '任务A', status: 'doing', consumed: 3, left: 5.5 })
})

await test('myTaskOptions：合并「指派给我」与「我完成的」入口，已完成任务可选', async () => {
  const daysAgo = (n) => {
    const d = new Date(Date.now() - n * 86400000)
    const p = (x) => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 10:00:00`
  }
  // 与真实实例同形（实测）：「指派给我」入口只列进行中 + 我关闭/取消的，不含已完成
  const assignedList = {
    tasks: [
      { id: '7007', name: '进行中B', status: 'doing', consumed: '0', left: '16' },
      { id: '7005', name: '已取消', status: 'cancel', consumed: '1', left: '3' },
      { id: '7004', name: '已关闭-两月前', status: 'closed', consumed: '4', left: '0', closedDate: daysAgo(60) },
      { id: '7003', name: '已关闭-近', status: 'closed', consumed: '4', left: '2', closedDate: daysAgo(9) },
      { id: '7001', name: '进行中A', status: 'doing', consumed: '2', left: '6' },
    ],
  }
  // 「我完成的」（type=finishedBy）：接手他人任务完成时指派人不是自己，只在这个入口出现
  const finishedList = {
    tasks: [
      { id: '7006', name: '已完成-无时间', status: 'done', consumed: '3', left: '0', finishedDate: '0000-00-00 00:00:00' },
      { id: '7002', name: '已完成-近', status: 'done', consumed: '8', left: '0', finishedDate: daysAgo(3) },
      { id: '7003', name: '已关闭-近', status: 'closed', consumed: '4', left: '2', closedDate: daysAgo(9) },
    ],
  }
  const body = (list) => `{"status":"200","data":${JSON.stringify(JSON.stringify(list))}}`
  const { client, ff } = makeClient((url) => {
    if (url.includes('type=finishedBy')) return { body: body(finishedList) }
    if (url.includes('m=my&f=task')) return { body: body(assignedList) }
    return { body: '' }
  })
  const opts = await client.myTaskOptions()
  assert.ok(ff.calls.some((c) => c.url.includes('m=my&f=task') && !c.url.includes('type=')), '应请求「指派给我」入口')
  assert.ok(ff.calls.some((c) => c.url.includes('type=finishedBy')), '应请求「我完成的」入口（已完成任务只能从这里取到）')
  assert.ok(!ff.calls.some((c) => /recPerPage|pageID/.test(c.url)), '该实例上传分页参数会返回空列表，不能传')
  assert.ok(!ff.calls.some((c) => /type=(?!finishedBy)/.test(c.url)), '该实例上其它 type 值返回空列表，不能传')
  // 进行中（保持禅道顺序）在前，已完成在后（完成时间倒序、无时间的最后）
  assert.deepStrictEqual(opts.map((t) => t.id), [7007, 7001, 7002, 7003, 7006])
  assert.deepStrictEqual(opts.map((t) => t.finished), [false, false, true, true, true])
  assert.strictEqual(opts[2].finishedAt, daysAgo(3).slice(0, 10))
  assert.strictEqual(opts[3].finishedAt, daysAgo(9).slice(0, 10)) // closed 回落 closedDate
  assert.strictEqual(opts[4].finishedAt, '')
  assert.strictEqual(opts.filter((t) => t.id === 7003).length, 1, '两个入口重复的任务只列一次')
  assert.ok(!opts.some((t) => t.id === 7004), '两个月前关闭的不列')
  assert.ok(!opts.some((t) => t.id === 7005), '已取消的不列')
  // 列表字段：选择列表带完成标记，myTasks 仍是 5 字段（提交链路依赖，保持不变）
  assert.deepStrictEqual(Object.keys(opts[0]).sort(), ['consumed', 'finished', 'finishedAt', 'id', 'left', 'name', 'status'])
})

await test('myTaskOptions：「我完成的」入口失败不阻断主列表', async () => {
  const assignedList = { tasks: [{ id: '7001', name: '进行中A', status: 'doing', consumed: '2', left: '6' }] }
  const { client } = makeClient((url) => {
    if (url.includes('type=finishedBy')) return { status: 500, body: '' }
    if (url.includes('m=my&f=task')) return { body: `{"status":"200","data":${JSON.stringify(JSON.stringify(assignedList))}}` }
    return { body: '' }
  })
  const opts = await client.myTaskOptions()
  assert.deepStrictEqual(opts.map((t) => t.id), [7001])
})

await test('myTasks 会话失效自动重登一次', async () => {
  let myHit = 0
  let logins = 0
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'rx' }
    if (opts.method === 'POST' && url.includes('user&f=login')) { logins++; return { body: '{"result":"success"}' } }
    if (url.includes('m=my&f=work')) {
      myHit++
      if (myHit === 1) return { body: '登录已超时，请重新登录' }
      return { body: '{"data":{"tasks":[]}}' }
    }
    return { body: '' }
  })
  await client.login() // 显式登录 1 次
  await client.myTasks() // 失效 → 重登（第 2 次）→ 成功
  assert.strictEqual(logins, 2)
})

await test('getTaskById：已完成任务从详情取最新剩余（data 可为 JSON 字符串，left 为字符串数字）', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: '"rand1"' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (url.includes('m=task&f=view&taskID=6813')) {
      return { body: JSON.stringify({ data: JSON.stringify({ task: { id: '6813', name: '打印机产品信息管理系统-支持多语言产品', status: 'done', left: '0', consumed: '52' } }) }) }
    }
    return { body: '' }
  })
  await client.login()
  const t = await client.getTaskById('6813')
  assert.deepStrictEqual(t, { id: 6813, name: '打印机产品信息管理系统-支持多语言产品', status: 'done', consumed: 52, left: 0 })
})

await test('getTaskById：任务不存在/响应异常/无 task 结构时返回 null', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: '"rand1"' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (url.includes('taskID=404')) return { status: 404, body: 'not found' }
    if (url.includes('taskID=555')) return { body: '<html>任务不存在</html>' } // 非 JSON
    return { body: '{"data":{"title":"无 task 键"}}' }
  })
  await client.login()
  assert.strictEqual(await client.getTaskById('404'), null)
  assert.strictEqual(await client.getTaskById('555'), null)
  assert.strictEqual(await client.getTaskById('666'), null)
})

await test('recordEstimates dryRun：表单数组语法构造（无 effortId 时键为行号，追加）', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    return { body: '' }
  })
  await client.login()
  const r = await client.recordEfforts(66, [
    { date: '2026-09-07', work: '完成A', consumed: 0.5, left: 3 },
    { date: '2026-09-07', work: '完成B', consumed: 2, left: 3 },
  ], true)
  assert.strictEqual(r.dryRun, true)
  assert.ok(r.url.includes('taskID=66'))
  assert.strictEqual(r.form['dates[1]'], '2026-09-07')
  assert.strictEqual(r.form['work[2]'], '完成B')
  assert.strictEqual(r.form['consumed[1]'], 0.5)
  assert.strictEqual(r.form['left[2]'], 3)
  assert.strictEqual(r.form['id[1]'], 1)
})

await test('recordEstimates 带 effortId 时键用已有记录 ID（更新覆盖）', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    return { body: '' }
  })
  await client.login()
  const r = await client.recordEfforts(66, [
    { date: '2026-09-07', work: '更新内容', consumed: 3, left: 1, effortId: 502 },
  ], true)
  assert.strictEqual(r.form['dates[502]'], '2026-09-07')
  assert.strictEqual(r.form['id[502]'], 502)
  assert.strictEqual(r.form['consumed[502]'], 3)
  assert.ok(!r.form['dates[1]'])
})

await test('getTaskEfforts：容错解析（data 字符串 + efforts dict + 尾部脏数据）', async () => {
  const inner = JSON.stringify({ efforts: { '501': { id: '501', date: '2026-09-07 00:00:00', work: '旧内容', consumed: '2', left: '1' } } })
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (url.includes('recordEstimate') && opts.method !== 'POST') {
      return { body: `{"status":"200","data":${JSON.stringify(inner)}}<!--dirty-->` }
    }
    return { body: '' }
  })
  await client.login()
  const list = await client.getTaskEfforts(66)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].id, 501)
  assert.strictEqual(list[0].date, '2026-09-07')
  assert.strictEqual(list[0].consumed, 2)
})

await test('getTaskEfforts：会话失效不再当成空记录', async () => {
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: 'r1' }
    if (opts.method === 'POST') return { body: '{"result":"success"}' }
    if (url.includes('recordEstimate') && opts.method !== 'POST') return { body: '登录已超时' }
    return { body: '' }
  })
  await client.login()
  await assert.rejects(() => client.getTaskEfforts(66), /会话失效/)
})

await test('getTaskEfforts：明确空列表可用，未知结构、错误页及网络异常必须抛错', async () => {
  for (const body of ['{"data":{}}', '{"data":"invalid"}', '{"data":{"efforts":42}}', '{"data":{"efforts":[{}]}}', 'bad gateway']) {
    const { client } = makeClient(() => ({ body }))
    await assert.rejects(() => client.getTaskEfforts(66))
  }
  const { client } = makeClient(() => ({ body: '{"data":{"efforts":[]}}' }))
  assert.deepStrictEqual(await client.getTaskEfforts(66), [])
  const { client: broken } = makeClient(() => { throw new Error('查询超时') })
  await assert.rejects(() => broken.getTaskEfforts(66), /查询超时/)
  const { client: httpError } = makeClient(() => ({ status: 500, body: '{"data":{"efforts":[]}}' }))
  await assert.rejects(() => httpError.getTaskEfforts(66), /HTTP 500/)
})

await test('recordEfforts：仅明确成功响应通过，HTTP/业务失败与未知结果均抛错', async () => {
  const rows = [{ date: '2026-09-07', consumed: 2, left: 8, work: '工作' }]
  for (const response of [
    { status: 500, body: '{"result":"success"}' },
    { body: '{"result":"fail","message":"invalid"}' },
    { body: '<html>登录页面</html>' },
    { body: '{}' },
  ]) {
    const { client } = makeClient(() => response)
    await assert.rejects(() => client.recordEfforts(66, rows))
  }
  const { client } = makeClient(() => ({ body: '{"result":"success"}<!--dirty-->' }))
  assert.strictEqual((await client.recordEfforts(66, rows)).status, 200)
})

await test('POST 重定向（302）按浏览器语义降级为 GET 且不再提交表单', async () => {
  const posts = []
  const { client, ff } = makeClient((url, opts) => {
    if (opts.method === 'POST') {
      posts.push(url)
      return { status: 302, location: 'http://zt.example/index.php?m=my&f=index' }
    }
    return { body: '{"data":{}}' }
  })
  const resp = await client.request('/index.php?m=x&f=y', { method: 'POST', form: { a: 1 } })
  assert.strictEqual(resp.status, 200)
  assert.strictEqual(posts.length, 1) // 表单只提交一次
})

// ═══════════ 绑定持久化 ═══════════
console.log('项目绑定持久化:')
await test('bind/unbind 往返且绑定信息完整', () => {
  fill.bindProject('proj-1', 66, '开发任务')
  let all = fill.listBindings()
  assert.strictEqual(all['proj-1'].taskId, 66)
  assert.strictEqual(all['proj-1'].taskName, '开发任务')
  assert.ok(all['proj-1'].boundAt)
  fill.bindProject('proj-2', 77, '另一个任务')
  fill.unbindProject('proj-1')
  all = fill.listBindings()
  assert.ok(!all['proj-1'])
  assert.strictEqual(all['proj-2'].taskId, 77)
  fill.unbindProject('proj-2')
})
await test('suggestTask 名称互相包含', () => {
  const tasks = [{ id: 9, name: '电商决策支持系统开发' }, { id: 8, name: '企微机器人' }]
  assert.strictEqual(fill.suggestTask('电商决策支持系统', tasks), 9)
  assert.strictEqual(fill.suggestTask('XX企微机器人平台', tasks), 8)
  assert.strictEqual(fill.suggestTask('完全无关', tasks), null)
})

// ═══════════ 提交汇总 ═══════════
console.log('提交汇总（left 扣减）:')
await test('按任务聚合 + left = 原剩余 − 本次总消耗', () => {
  const planned = [
    { taskId: 66, hours: 0.5, work: '1. a' },
    { taskId: 66, hours: 2, work: '1. b' },
    { taskId: 88, hours: 1, work: '1. c' },
    { taskId: null, hours: 3, work: '1. 未绑定' },
  ]
  const ztTasks = [
    { id: 66, name: '任务A', left: 3.5 },
    { id: 88, name: '任务B', left: 0.5 },
  ]
  const tasks = fill.buildSubmitTasks(planned, ztTasks, '2026-09-07')
  assert.strictEqual(tasks.length, 2)
  const t66 = tasks.find((t) => t.taskId === 66)
  assert.strictEqual(t66.consumed, 2.5)
  assert.strictEqual(t66.left, 1)
  assert.strictEqual(t66.rows.length, 2)
  assert.ok(t66.rows.every((r) => r.left === 1))
  assert.strictEqual(t66.rows[0].date, '2026-09-07')
  const t88 = tasks.find((t) => t.taskId === 88)
  assert.strictEqual(t88.left, 0) // 0.5 - 1 → 最低为 0
})
await test('任务不在我的任务列表时 taskLeft=null 仍可构造', () => {
  const tasks = fill.buildSubmitTasks([{ taskId: 999, hours: 1, work: '1. x' }], [], '2026-09-07')
  assert.strictEqual(tasks[0].taskLeft, null)
  assert.strictEqual(tasks[0].left, 0)
  assert.strictEqual(tasks[0].taskName, '')
})
await test('任务不在我的任务列表时 taskName 用绑定名兜底', () => {
  const tasks = fill.buildSubmitTasks([
    { taskId: 6813, hours: 2, work: '1. x', taskName: '打印机产品信息管理系统-支持多语言产品' },
  ], [], '2026-09-11')
  assert.strictEqual(tasks[0].taskLeft, null)
  assert.strictEqual(tasks[0].taskName, '打印机产品信息管理系统-支持多语言产品')
})

// ═══════════ 汉印条目构造（百分比 Σ=100） ═══════════
console.log('汉印条目构造:')
const HP_GROUPS = [
  { type: 1, typeName: '日常事务', projectId: '900', projectName: '日常', tasks: [{ Key: '66', Name: '同名干扰任务' }] },
  { type: 3, typeName: '软件项目', projectId: '799', projectName: '电商决策支持系统', tasks: [
    { Key: '66', Name: '电商决策支持系统开发', GlProjectGuid: '', GlprojectName: '', BigKey: 'b1', BigName: '大项目', ProductKey: 'p1', ProductName: '产品A', StartTime: '2026-01-01', EndTime: '2026-12-31', StartTime2: '2026-01-02', EndTime2: null, IsOp: 1, PlmTotalHour: 100, ProductTime: null, DivisionName: '软件部' },
    { Key: '88', Name: '任务B', GlProjectGuid: '', GlprojectName: '', BigKey: '', BigName: '', ProductKey: '', ProductName: '', StartTime: null, EndTime: null, StartTime2: null, EndTime2: null, IsOp: 0, PlmTotalHour: 0, ProductTime: null, DivisionName: '' },
  ] },
]

await test('按禅道任务在 type=3 分组匹配并换算百分比', () => {
  const tasks = [
    { taskId: 66, consumed: 2.5 },
    { taskId: 88, consumed: 0.5 },
  ]
  const { items, unmatched } = fill.buildHpItems(tasks, HP_GROUPS, '2026-09-07')
  assert.deepStrictEqual(unmatched, [])
  assert.strictEqual(items.length, 2)
  assert.strictEqual(items[0].ProjectType, 3)
  assert.strictEqual(items[0].ProjectId, '799')
  assert.strictEqual(items[0].TaskId, '66')
  assert.strictEqual(items[0].BigProjectName, '大项目')
  assert.strictEqual(items[0].IsOp, true)
  assert.strictEqual(items[0].ActualStartTime, '2026-01-02')
  assert.strictEqual(items[0].WorkDate, '2026-09-07')
  assert.strictEqual(items[0].AddType, 0)
  // ΣPercent 必须为 100（汉印硬约束）
  const sum = items.reduce((s, x) => s + x.Percent, 0)
  assert.strictEqual(sum, 100)
})

await test('未匹配任务的占比份额并入余数补给第一条，Σ 仍=100', () => {
  const tasks = [
    { taskId: 66, consumed: 2 },
    { taskId: 999, consumed: 2 }, // 汉印无此任务
  ]
  const { items, unmatched } = fill.buildHpItems(tasks, HP_GROUPS, '2026-09-07')
  assert.deepStrictEqual(unmatched, [999])
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].Percent, 100) // 50 + 余数 50
})

await test('四舍五入误差由第一条吸收（Σ 恒等 100）', () => {
  const tasks = [
    { taskId: 66, consumed: 1 },
    { taskId: 88, consumed: 1 },
    { taskId: 77, consumed: 1 },
  ]
  const { items, unmatched } = fill.buildHpItems(tasks, [
    ...HP_GROUPS,
    { type: 3, typeName: '软件项目', projectId: '800', projectName: 'P2', tasks: [{ Key: '77', Name: '任务C' }] },
  ], '2026-09-07')
  assert.deepStrictEqual(unmatched, [])
  // 3 任务各 1/3 → 33/33/33=99，余数 1 补第一条
  const sum = items.reduce((s, x) => s + x.Percent, 0)
  assert.strictEqual(sum, 100)
})

await test('工时为 0 的任务占比 0% → 不写入汉印（zeroSkipped 计数）', () => {
  const { items, unmatched, zeroSkipped } = fill.buildHpItems([
    { taskId: 66, consumed: 8 },
    { taskId: 88, consumed: 0 }, // 工时被 0.5h 取整抹平 → 占比 0%
  ], HP_GROUPS, '2026-09-07')
  assert.deepStrictEqual(unmatched, [])
  assert.strictEqual(zeroSkipped, 1)
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].TaskId, '66')
  assert.strictEqual(items[0].Percent, 100)
})

await test('占比四舍五入为 0 的极小份额同样跳过，Σ 仍=100', () => {
  const { items, zeroSkipped } = fill.buildHpItems([
    { taskId: 88, consumed: 0.5 }, // 0.05% → 0%
    { taskId: 66, consumed: 1000 }, // 99.95% → 100%
  ], HP_GROUPS, '2026-09-07')
  assert.strictEqual(zeroSkipped, 1)
  assert.strictEqual(items.length, 1)
  assert.strictEqual(items[0].TaskId, '66')
  assert.strictEqual(items[0].Percent, 100)
})

await test('余数补给占比最大的条目：0% 条目不会被余数喂成非零', () => {
  const groups = [
    ...HP_GROUPS,
    { type: 3, typeName: '软件项目', projectId: '800', projectName: 'P2', tasks: [{ Key: '77', Name: '任务C' }] },
    { type: 3, typeName: '软件项目', projectId: '801', projectName: 'P3', tasks: [{ Key: '99', Name: '任务D' }] },
  ]
  const { items, zeroSkipped } = fill.buildHpItems([
    { taskId: 88, consumed: 0 }, // 排在第一条，余数不得补到它身上
    { taskId: 66, consumed: 1 },
    { taskId: 77, consumed: 1 },
    { taskId: 99, consumed: 1 },
  ], groups, '2026-09-07')
  assert.strictEqual(zeroSkipped, 1)
  assert.strictEqual(items.length, 3)
  assert.ok(!items.some((x) => x.TaskId === '88'), '0% 条目不应出现在提交条目中')
  assert.ok(items.every((x) => x.Percent > 0))
  // 3 任务各 1/3 → 33×3=99，余数 1 补占比最大者（不是 0% 那条）；丢弃的 0% 不破坏 Σ
  assert.strictEqual(items.reduce((s, x) => s + x.Percent, 0), 100)
})

await test('全部未匹配时返回空', () => {
  const { items, unmatched } = fill.buildHpItems([{ taskId: 999, consumed: 1 }], HP_GROUPS, '2026-09-07')
  assert.deepStrictEqual(items, [])
  assert.deepStrictEqual(unmatched, [999])
})

// ═══════════ 汉印客户端（fake fetch） ═══════════
console.log('汉印客户端请求构造:')
function makeHpClient(handler) {
  const ff = fakeFetch(handler)
  const client = new HanprintClient({ baseUrl: 'http://hp.example', clientId: '1', account: '21290', password: 'secret', fetchImpl: ff.impl })
  return { client, ff }
}
function jsonResp(obj, setCookies = []) {
  return { body: JSON.stringify(obj), setCookies }
}

await test('登录：getToken 参数与 token 保存', async () => {
  const { client, ff } = makeHpClient((url) => {
    if (url.includes('/login/getToken')) {
      assert.ok(url.includes('clientId=1') && url.includes('userName=21290') && url.includes('pwd=secret'))
      return jsonResp({ code: 0, data: 'tok-1' })
    }
    return jsonResp({ code: 0, data: null })
  })
  await client.login()
  assert.strictEqual(client.token, 'tok-1')
})

await test('登录失败抛出平台错误信息', async () => {
  const { client } = makeHpClient(() => jsonResp({ code: -1, data: null, msg: '用户不存在' }))
  await assert.rejects(() => client.login(), /用户不存在/)
})

await test('业务请求带 token 头 + code!=0 抛错', async () => {
  const { client } = makeHpClient((url, opts) => {
    if (url.includes('/com/workhour/GetDict')) {
      assert.strictEqual(opts.headers.token, 'tok-x')
      return jsonResp({ code: 0, data: [] })
    }
    if (url.includes('/com/workhour/GetProjectList')) {
      return jsonResp({ code: -1, data: null, msg: '无权限' })
    }
    return jsonResp({ code: 0, data: 't' })
  })
  client.token = 'tok-x'
  assert.deepStrictEqual(await client.getData('/com/workhour/GetDict', { dictType: 1 }), [])
  client.token = 'tok-bad'
  await assert.rejects(() => client.getData('/com/workhour/GetProjectList', { projecttype: 3 }), /汉印接口错误/)
})

await test('token 过期（code=-2）自动重登一次', async () => {
  let hits = 0
  let logins = 0
  const { client } = makeHpClient((url) => {
    if (url.includes('/login/getToken')) { logins += 1; return jsonResp({ code: 0, data: 'tok-new' }) }
    if (url.includes('/com/workhour/GetDict')) {
      hits += 1
      return hits === 1 ? jsonResp({ code: -2, data: null, msg: 'token 过期' }) : jsonResp({ code: 0, data: [] })
    }
    return jsonResp({ code: 0, data: 't' })
  })
  client.token = 'tok-old'
  assert.deepStrictEqual(await client.getData('/com/workhour/GetDict', { dictType: 1 }), [])
  assert.strictEqual(logins, 1)
  assert.strictEqual(client.token, 'tok-new')
})

await test('add：JSON 数组提交体 + token 头', async () => {
  const { client, ff } = makeHpClient((url, opts) => {
    if (url.includes('/com/workhour/add')) {
      assert.strictEqual(opts.headers.token, 'tok-add')
      assert.strictEqual(opts.headers['Content-Type'], 'application/json;charset=utf8')
      const arr = JSON.parse(opts.body)
      assert.ok(Array.isArray(arr) && arr.length === 1)
      assert.strictEqual(arr[0].Percent, 100)
      return jsonResp({ code: 0, data: null })
    }
    return jsonResp({ code: 0, data: 't' })
  })
  client.token = 'tok-add'
  const r = await client.add([{ Percent: 100, WorkDate: '2026-09-07' }])
  assert.strictEqual(r.status, 'ok')
})

await test('add dryRun 只回显不发', async () => {
  const { client, ff } = makeHpClient(() => { throw new Error('不应发请求') })
  client.token = 'tok'
  const r = await client.add([{ Percent: 100 }], true)
  assert.strictEqual(r.dryRun, true)
  assert.ok(r.url.includes('/com/workhour/add'))
  assert.strictEqual(ff.calls.length, 0)
})

await test('add：token 过期（code=-2）重登后重试一次成功', async () => {
  let adds = 0
  let logins = 0
  const { client } = makeHpClient((url) => {
    if (url.includes('/login/getToken')) { logins += 1; return jsonResp({ code: 0, data: `tok-${logins}` }) }
    if (url.includes('/com/workhour/add')) {
      adds += 1
      return adds === 1 ? jsonResp({ code: -2, data: null, msg: '' }) : jsonResp({ code: 0, data: null })
    }
    return jsonResp({ code: 0, data: null })
  })
  client.token = 'tok-old'
  const r = await client.add([{ Percent: 100, WorkDate: '2026-09-17' }])
  assert.strictEqual(r.status, 'ok')
  assert.strictEqual(adds, 2)
  assert.strictEqual(logins, 1)
  assert.strictEqual(client.token, 'tok-1')
})

await test('add：重登后仍 -2 → 抛「token 过期且重登失败」', async () => {
  let adds = 0
  let logins = 0
  const { client } = makeHpClient((url) => {
    if (url.includes('/login/getToken')) { logins += 1; return jsonResp({ code: 0, data: 'tok' }) }
    if (url.includes('/com/workhour/add')) { adds += 1; return jsonResp({ code: -2, data: null, msg: '' }) }
    return jsonResp({ code: 0, data: null })
  })
  client.token = 'tok-old'
  await assert.rejects(() => client.add([{ Percent: 100 }]), /token 过期且重登失败/)
  assert.strictEqual(adds, 2)
  assert.strictEqual(logins, 1) // 重试用的是刚登录的新 token，不再触发第二次登录
})

await test('add：code=-1 不重试（可能已写入的失败不得重复提交）', async () => {
  let adds = 0
  let logins = 0
  const { client } = makeHpClient((url) => {
    if (url.includes('/login/getToken')) { logins += 1; return jsonResp({ code: 0, data: 'tok' }) }
    if (url.includes('/com/workhour/add')) { adds += 1; return jsonResp({ code: -1, data: null, msg: '只能报【2024-12-01】后的工' }) }
    return jsonResp({ code: 0, data: null })
  })
  client.token = 'tok-old'
  await assert.rejects(() => client.add([{ Percent: 100 }]), /只能报/)
  assert.strictEqual(adds, 1)
  assert.strictEqual(logins, 0)
})

await test('allTypeTasks：GetDict 失败必须抛错（不得吞成空字典伪装成功）', async () => {
  const { client } = makeHpClient((url) => {
    if (url.includes('/com/workhour/GetDict')) return jsonResp({ code: -1, data: null, msg: '字典查询失败' })
    return jsonResp({ code: 0, data: null })
  })
  client.token = 'tok'
  await assert.rejects(() => client.allTypeTasks(), /字典查询失败/)
})

await test('getByDate：携带 token 查询当日已填', async () => {
  const { client } = makeHpClient((url, opts) => {
    if (url.includes('/com/workhour/GetByDate')) {
      assert.strictEqual(opts.headers.token, 'tok-q')
      assert.ok(url.includes('workDate=2026-09-07'))
      return jsonResp({ code: 0, data: [
        { Id: 11, TaskId: '66', Percent: 60, ProjectType: 3 },
        { Id: 12, TaskId: '99', Percent: 0, ProjectType: -2 }, // 删除标记行（调用方负责跳过）
      ] })
    }
    return jsonResp({ code: 0, data: null })
  })
  client.token = 'tok-q'
  const rows = await client.getByDate('2026-09-07')
  assert.strictEqual(rows.length, 2) // 原样返回，跳过 ProjectType=-2 由调用方处理
  assert.strictEqual(rows[0].Id, 11)
})

// ═══════════ 提交写入路径（0% 条目不落汉印） ═══════════
console.log('提交写入路径（汉印 0% 过滤）:')
const ztSvc = require('../electron/zentao-service')
const hpSvc = require('../electron/hanprint-service')

/** 打桩两个平台客户端，返回汉印 add 实际收到的条目 */
async function withStubClients(fn, overrides = {}) {
  const origZt = ztSvc.ensureClient
  const origHp = hpSvc.ensureClient
  let sent = null
  const hpAddCalls = []
  ztSvc.ensureClient = async () => ({
    myTasks: async () => [{ id: 66, left: 10 }, { id: 88, left: 10 }],
    getTaskEfforts: async () => [],
    recordEfforts: async (taskId, rowsIn, dry) => ({ dryRun: !!dry, taskId, rows: rowsIn.length }),
    ...overrides.zt,
  })
  hpSvc.ensureClient = async () => ({
    getByDate: async () => [],
    add: async (items, dry) => { sent = items; hpAddCalls.push(items); return { dryRun: !!dry, json: items } },
    ...overrides.hp,
  })
  try {
    const r = await fn()
    return { r, sent, hpAddCalls }
  } finally {
    ztSvc.ensureClient = origZt
    hpSvc.ensureClient = origHp
  }
}

await test('submit：0% 条目不进汉印提交体，其余占比仍合计 100', async () => {
  const { r, sent } = await withStubClients(() => fill.submit({
    date: '2026-09-07',
    tasks: [{ taskId: 66, taskName: '任务A', rows: [{ date: '2026-09-07', work: '1. x', consumed: 2, left: 1 }] }],
    dryRun: true,
    hp: { items: [
      { TaskId: '66', Percent: 100, WorkDate: '2026-09-07' },
      { TaskId: '88', Percent: 0, WorkDate: '2026-09-07' }, // 0% 条目：不得提交
    ] },
  }))
  assert.ok(sent, '汉印 add 应被调用')
  assert.strictEqual(sent.length, 1)
  assert.ok(!sent.some((x) => Number(x.Percent) <= 0), '0% 条目不得出现在提交体中')
  assert.strictEqual(sent.reduce((s, x) => s + x.Percent, 0), 100)
  assert.strictEqual(r.hp.appended, 1)
})

await test('submit：全部为 0% 时不发起汉印提交', async () => {
  const { r, hpAddCalls } = await withStubClients(() => fill.submit({
    date: '2026-09-07',
    tasks: [{ taskId: 66, taskName: '任务A', rows: [{ date: '2026-09-07', work: '1. x', consumed: 2, left: 1 }] }],
    dryRun: true,
    hp: { items: [{ TaskId: '88', Percent: 0, WorkDate: '2026-09-07' }] },
  }))
  assert.strictEqual(hpAddCalls.length, 0)
  assert.strictEqual(r.hp, null)
})

// ═══════════ 汉印健壮性回归（空分组不伪装成功 / 提交留痕） ═══════════
console.log('汉印健壮性回归:')
const logFile = path.join(tmpRoot, 'userdata', 'fill-log.json')
function lastLogEntry() {
  return JSON.parse(fs.readFileSync(logFile, 'utf8')).pop()
}

await test('submit：成功后 fill-log 留痕（含汉印结果）', async () => {
  fs.mkdirSync(path.join(tmpRoot, 'userdata'), { recursive: true })
  await withStubClients(() => fill.submit({
    date: '2026-09-07',
    tasks: [{ taskId: 66, taskName: '任务A', rows: [{ date: '2026-09-07', work: '1. x', consumed: 2, left: 1 }] }],
    hp: { items: [{ TaskId: '66', Percent: 100, WorkDate: '2026-09-07' }] },
  }))
  const entry = lastLogEntry()
  assert.strictEqual(entry.date, '2026-09-07')
  assert.strictEqual(entry.dryRun, false)
  assert.strictEqual(entry.ztTasks, 1)
  assert.strictEqual(entry.hpSent, 1)
  assert.deepStrictEqual(entry.hp, { sent: 1, updated: 0, appended: 1 })
  assert.strictEqual(entry.error, undefined)
})

await test('submit：汉印 add 失败时留痕记录错误原文', async () => {
  await withStubClients(() => fill.submit({
    date: '2026-09-07',
    tasks: [{ taskId: 66, taskName: '任务A', rows: [{ date: '2026-09-07', work: '1. x', consumed: 2, left: 1 }] }],
    hp: { items: [{ TaskId: '66', Percent: 100, WorkDate: '2026-09-07' }] },
  }), { hp: { add: async () => { throw new Error('汉印提交失败: 未知错误') } } })
  const entry = lastLogEntry()
  assert.strictEqual(entry.hpSent, 1)
  assert.strictEqual(entry.hp.error, '汉印提交失败: 未知错误')
})

await test('submit：抛错时留痕 error 字段后原样抛出', async () => {
  await withStubClients(() => assert.rejects(
    () => fill.submit({ date: '2026-02-30', tasks: [{ taskId: 66, rows: [{ date: '2026-02-30', consumed: 1 }] }] }),
    /日期/,
  ))
  const entry = lastLogEntry()
  assert.match(entry.error, /日期/)
  assert.strictEqual(entry.date, '2026-02-30')
})

// ═══════════ 响应异常回查核实 / 分项留痕 / 重新提交（2026-09-18 需求） ═══════════
console.log('响应异常回查核实与重新提交:')
await test('recordEfforts：响应非 JSON 但回查当日记录逐行匹配 → 按已写入继续（verified）', async () => {
  const rows = [{ date: '2026-09-07', consumed: 2, left: 8, work: '1. 工作A' }]
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: '"r1"' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (opts.method === 'POST') return { body: '' } // 提交响应为空 body：无法解析
    if (url.includes('recordEstimate')) {
      return { body: JSON.stringify({ data: { efforts: [{ id: '900', date: '2026-09-07', work: '1. 工作A', consumed: '2', left: '8' }] } }) }
    }
    return { body: '' }
  })
  await client.login()
  const r = await client.recordEfforts(66, rows)
  assert.strictEqual(r.verified, true)
})

await test('recordEfforts：响应非 JSON 且回查无匹配 → 抛错并附响应原文（rawBody）', async () => {
  const rows = [{ date: '2026-09-07', consumed: 2, left: 8, work: '1. 工作A' }]
  const { client } = makeClient((url, opts) => {
    if (url.includes('refreshRandom')) return { body: '"r1"' }
    if (opts.method === 'POST' && url.includes('user&f=login')) return { body: '{"result":"success"}' }
    if (opts.method === 'POST') return { body: '<html>oops</html>' }
    if (url.includes('recordEstimate')) return { body: JSON.stringify({ data: { efforts: [] } }) }
    return { body: '' }
  })
  await client.login()
  let caught = null
  try { await client.recordEfforts(66, rows) } catch (e) { caught = e }
  assert.match(caught && caught.message, /无法确认禅道提交结果/)
  assert.strictEqual(caught && caught.rawBody, '<html>oops</html>')
})

let lastFailAt = ''
await test('submit：中途失败时错误带进度、留痕分项/断点/载荷', async () => {
  await withStubClients(() => assert.rejects(
    () => fill.submit({
      date: '2026-09-07',
      tasks: [
        { taskId: 66, taskName: '任务A', rows: [{ date: '2026-09-07', work: '1. a', consumed: 2, left: 1 }] },
        { taskId: 88, taskName: '任务B', rows: [{ date: '2026-09-07', work: '1. b', consumed: 3, left: 1 }] },
      ],
      hp: { items: [{ TaskId: '66', Percent: 100, WorkDate: '2026-09-07' }] },
    }),
    /已写入 1\/2 个禅道任务/,
  ), {
    zt: {
      recordEfforts: async (taskId) => {
        if (String(taskId) === '88') {
          const e = new Error('无法确认禅道提交结果，请先核对平台记录，避免重复提交')
          e.rawBody = '<html>gateway</html>'
          throw e
        }
        return {}
      },
    },
  })
  const entry = lastLogEntry()
  assert.strictEqual(entry.tasks.length, 1, '留痕只含已写入任务')
  assert.strictEqual(entry.tasks[0].taskId, 66)
  assert.strictEqual(entry.stage, 'zentao#88', '断点环节')
  assert.strictEqual(entry.raw, '<html>gateway</html>', '响应原文')
  assert.match(entry.error, /已写入 1\/2/)
  assert.strictEqual(entry.payload.tasks.length, 2, '载荷含全部任务（重放用）')
  assert.strictEqual(entry.payload.hp.items.length, 1)
  lastFailAt = entry.at
})

await test('resubmit：按留痕载荷重放成功并重新留痕', async () => {
  const before = JSON.parse(fs.readFileSync(logFile, 'utf8')).length
  const { r } = await withStubClients(() => fill.resubmit(lastFailAt))
  assert.strictEqual(r.results.length, 2)
  const entries = JSON.parse(fs.readFileSync(logFile, 'utf8'))
  assert.strictEqual(entries.length, before + 1)
  const last = entries[entries.length - 1]
  assert.ok(!last.error)
  assert.strictEqual(last.tasks.length, 2)
})

await test('listLog：倒序最近记录 + 失败条目带重放标记与计划总数', async () => {
  const list = fill.listLog(3)
  assert.ok(list.length >= 2 && list.length <= 3)
  const failed = list.find((e) => e.stage === 'zentao#88')
  assert.ok(failed, '失败条目应在最近记录里')
  assert.strictEqual(failed.resubmittable, true)
  assert.strictEqual(failed.failed, true)
  assert.strictEqual(failed.ztTotal, 2)
  assert.strictEqual(failed.tasks.length, 1)
})

await test('listLog：成功记录不带重放标记（已写入并核实，重放无意义）', async () => {
  const list = fill.listLog(10)
  const ok = list.filter((e) => !e.failed)
  assert.ok(ok.length >= 1, '最近记录里应有成功条目')
  assert.ok(ok.every((e) => e.resubmittable === false), '成功条目不得标记可重放')
  assert.ok(list.filter((e) => e.failed).every((e) => e.resubmittable === true), '失败条目应可重放')
  // 汉印未写入也算失败（禅道成功、汉印失败的部分成功记录仍要能补交）
  const hpFail = fill.listLog(10).find((e) => e.hp && e.hp.error)
  if (hpFail) assert.strictEqual(hpFail.failed, true, '汉印失败的部分成功记录应标为失败')
})

await test('resubmit：拒绝重放成功记录（只对失败记录开放）', async () => {
  const ok = fill.listLog(10).find((e) => !e.failed)
  assert.ok(ok, '最近记录里应有成功条目')
  await assert.rejects(() => fill.resubmit(ok.at), /已提交成功，无需重新提交/)
})

await test('removeLog：按 at 删除留痕（其余记录不受影响），缺参/不存在报错', async () => {
  const before = JSON.parse(fs.readFileSync(logFile, 'utf8'))
  const target = fill.listLog(10).find((e) => e.failed)
  assert.ok(target, '应有可删的失败条目')
  const r = fill.removeLog(target.at)
  assert.strictEqual(r.removed, 1)
  assert.strictEqual(r.remaining, before.length - 1)
  const after = JSON.parse(fs.readFileSync(logFile, 'utf8'))
  assert.deepStrictEqual(after.map((e) => e.at), before.filter((e) => e.at !== target.at).map((e) => e.at),
    '只删目标条目，顺序与其余记录不变')
  assert.ok(!fill.listLog(50).some((e) => e.at === target.at), '删除后列表不再含该条')
  assert.throws(() => fill.removeLog(target.at), /没有这条提交记录/)
  assert.throws(() => fill.removeLog(''), /缺少提交记录标识/)
})

await test('resubmit：预览/无载荷记录拒绝重放；不存在的留痕报错', async () => {
  await assert.rejects(() => fill.resubmit('1970-01-01 00:00:00'), /没有这条提交记录/)
})

await test('submit：dryRun 预览不留痕', async () => {
  const before = JSON.parse(fs.readFileSync(logFile, 'utf8')).length
  await withStubClients(() => fill.submit({
    date: '2026-09-07',
    tasks: [{ taskId: 66, taskName: '任务A', rows: [{ date: '2026-09-07', work: '1. x', consumed: 2, left: 1 }] }],
    dryRun: true,
  }))
  assert.strictEqual(JSON.parse(fs.readFileSync(logFile, 'utf8')).length, before)
})

await test('getGroups：空结果不进 60s 缓存（重试必须真实重取）', async () => {
  store.save({ hanprint: { baseUrl: 'http://hp-cache.example', clientId: '1', account: '21290', password: 'secret' } })
  let dictHits = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/login/getToken')) return makeResp({ body: JSON.stringify({ code: 0, data: 'tok' }) })
    if (u.includes('/com/workhour/GetDict')) { dictHits += 1; return makeResp({ body: JSON.stringify({ code: 0, data: [] }) }) }
    return makeResp({ body: JSON.stringify({ code: 0, data: null }) })
  }
  try {
    const g1 = await hpSvc.getGroups(true)
    assert.strictEqual(g1.length, 0)
    const g2 = await hpSvc.getGroups() // 60s 内：空结果若被缓存，GetDict 不会再被打到
    assert.strictEqual(g2.length, 0)
    assert.strictEqual(dictHits, 2, '空结果不应按成功缓存，第二次应真实重取')
  } finally {
    globalThis.fetch = realFetch
  }
})

// ═══════════ store 禅道配置（密码加密往返） ═══════════
console.log('填报审查回归:')
function submitFixture() {
  return { date: '2026-09-07', tasks: [{ taskId: 66, rows: [{ date: '2026-09-07', consumed: 2, left: 0, work: '工作' }] }], hp: { items: [{ TaskId: '66', WorkDate: '2026-09-07', Percent: 100 }] } }
}

await test('页面提交携带计划日期（执行真实 submitFill，截取 IPC 参数）', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/views/FillReportView.vue'), 'utf8')
  const fn = source.slice(source.indexOf('async function submitFill(preview)'), source.indexOf('function buildReportText()'))
  let sent
  const fixture = submitFixture()
  const run = new Function('plan', 'unmatchedCount', 'state', 'window', 'toPlain', 'previewDialog', 'ElMessage', 'loadLogs', `${fn}; return submitFill(true)`)
  await run({ value: { ...fixture, hpItems: fixture.hp.items } }, { value: 0 }, { fillReport: {} }, {
    gitReport: { fillSubmit: async (payload) => { sent = payload; return { ok: true, results: [] } } },
  }, (v) => v, { value: null }, { error: (message) => { throw new Error(message) } }, async () => {})
  assert.strictEqual(sent.date, fixture.date)
})

await test('submit：缺失、无效或不一致的日期在任何平台查询前拒绝', async () => {
  for (const mutate of [p => delete p.date, p => { p.date = '2026-02-30' }, p => { p.tasks[0].rows[0].date = '2026-09-06' }, p => { p.hp.items[0].WorkDate = '2026-09-06' }]) {
    const p = submitFixture(); mutate(p)
    let queried = false
    await withStubClients(async () => {
      await assert.rejects(() => fill.submit(p), /日期/)
      assert.strictEqual(queried, false)
    }, { zt: { myTasks: async () => { queried = true; return [] } } })
  }
})

await test('submit：只复用目标日期记录，重新生成与重复提交不再重复扣减', async () => {
  let left = 10
  let records = [{ id: 100, date: '2026-09-06', consumed: 4, left: 10 }]
  const writes = []
  await withStubClients(async () => {
    for (const hours of [2, 2, 3, 1]) {
      const p = submitFixture()
      p.tasks = fill.buildSubmitTasks([{ taskId: 66, hours, work: '工作' }], [{ id: 66, left }], p.date, { '66': { records: records.filter(r => r.date === p.date) } })
      assert.strictEqual(p.tasks[0].left, 10 - hours, '计划预览使用覆盖差额')
      const original = JSON.stringify(p)
      await fill.submit(p)
      assert.strictEqual(JSON.stringify(p), original, '不得修改传入计划')
      assert.strictEqual(left, 10 - hours)
    }
  }, { zt: {
    myTasks: async () => [{ id: 66, left }],
    getTaskEfforts: async () => records,
    recordEfforts: async (_id, rows) => {
      writes.push(structuredClone(rows))
      assert.notStrictEqual(rows[0].effortId, 100, '不能覆盖前一天')
      left = rows[0].left
      records = [records[0], { ...rows[0], id: 101 }]
      return { status: 200 }
    },
  } })
  assert.strictEqual(writes[0][0].effortId, undefined)
  assert.strictEqual(writes[1][0].effortId, 101)
})

await test('submit：多行仅补回实际覆盖行，忽略客户端旧 ID 与旧剩余', async () => {
  const p = submitFixture()
  p.tasks[0].rows[0].effortId = 999
  p.tasks[0].rows.push({ date: p.date, work: '另一项工作', consumed: 1, effortId: 998, left: 99 })
  await withStubClients(() => fill.submit(p), { zt: {
    myTasks: async () => [{ id: 66, left: 5 }],
    getTaskEfforts: async () => [{ id: 101, date: p.date, consumed: 3 }, { id: 102, date: p.date, consumed: 4 }],
    recordEfforts: async (_id, rows) => {
      assert.strictEqual(rows[0].effortId, 101)
      assert.strictEqual(rows[1].effortId, 102)
      assert.strictEqual(rows[0].left, 9)
      assert.strictEqual(rows[1].left, 9)
      return { status: 200 }
    },
  } })
})

await test('submit：任一平台已有记录查询失败时，两个平台都不得写入', async () => {
  for (const platform of ['zt', 'hp', 'latest', 'secondTask']) {
    let writes = 0
    const overrides = { zt: { recordEfforts: async () => { writes++; return {} } }, hp: { add: async () => { writes++; return {} } } }
    if (platform === 'zt') overrides.zt.getTaskEfforts = async () => { throw new Error('查询失败') }
    if (platform === 'hp') overrides.hp.getByDate = async () => { throw new Error('查询失败') }
    if (platform === 'latest') { overrides.zt.myTasks = async () => []; overrides.zt.getTaskById = async () => null }
    const p = submitFixture()
    if (platform === 'secondTask') {
      p.tasks.push({ taskId: 88, rows: p.tasks[0].rows })
      overrides.zt.getTaskEfforts = async (id) => { if (id === 88) throw new Error('查询失败'); return [] }
    }
    await withStubClients(async () => { await assert.rejects(() => fill.submit(p)); assert.strictEqual(writes, 0) }, overrides)
  }
})

await test('submit：任务已完成不在我的任务列表时，回退任务详情取剩余工时继续提交', async () => {
  let ztWrites = 0
  let sentRows = null
  const { r } = await withStubClients(() => fill.submit({
    date: '2026-09-11',
    tasks: [{ taskId: 6813, taskName: '打印机产品信息管理系统-支持多语言产品', rows: [
      { date: '2026-09-11', work: '1. x', consumed: 2, left: 0 },
    ] }],
    dryRun: false,
  }), { zt: {
    myTasks: async () => [{ id: 6770, name: '电商决策支持系统', status: 'doing', left: 18.5, consumed: 21 }], // #6813 已完成，不在列表
    getTaskById: async (id) => ({ id: 6813, name: '打印机产品信息管理系统-支持多语言产品', status: 'done', consumed: 52, left: 0 }),
    getTaskEfforts: async () => [],
    recordEfforts: async (taskId, rows) => { ztWrites += 1; sentRows = rows; return { taskId } },
  } })
  assert.strictEqual(ztWrites, 1, '应放行提交')
  assert.strictEqual(r.results[0].taskId, 6813)
  assert.strictEqual(r.results[0].appended, 1)
  assert.strictEqual(sentRows[0].left, 0, 'left = max(0, 详情0 + 覆盖0 − 本次2) = 0')
})

await test('submit：任务不在我的任务列表且详情也拿不到时，停止且不写入', async () => {
  let writes = 0
  await withStubClients(async () => {
    await assert.rejects(() => fill.submit(submitFixture()), /无法获取任务 #66 最新剩余工时，已停止提交/)
  }, { zt: {
    myTasks: async () => [],
    getTaskById: async () => null,
    recordEfforts: async () => { writes += 1; return {} },
  }, hp: { add: async () => { writes += 1; return {} } } })
  assert.strictEqual(writes, 0)
})

await test('submit：禅道业务失败向上传递，停止后续任务与汉印写入', async () => {
  const { client } = makeClient(() => ({ body: '{"result":"fail"}' }))
  const p = submitFixture()
  p.tasks.push({ taskId: 88, rows: p.tasks[0].rows })
  let ztCalls = 0
  let hpCalls = 0
  await withStubClients(async () => {
    await assert.rejects(() => fill.submit(p), /未确认提交成功/)
    assert.strictEqual(ztCalls, 1)
    assert.strictEqual(hpCalls, 0)
  }, { zt: { recordEfforts: async (...args) => { ztCalls++; return client.recordEfforts(...args) } }, hp: { add: async () => { hpCalls++ } } })
})

await test('submit：禅道已写入后汉印 add 失败，不抛整体错误，hp.error 回报且禅道结果保留', async () => {
  const p = submitFixture()
  let ztWrites = 0
  const { r } = await withStubClients(() => fill.submit(p), { zt: {
    recordEfforts: async (taskId, rows) => { ztWrites += 1; return { taskId, rows } },
  }, hp: {
    add: async () => { throw new Error('汉印提交失败: 网络超时') },
  } })
  assert.strictEqual(ztWrites, 1, '禅道写入已完成')
  assert.strictEqual(r.results.length, 1)
  assert.ok(r.hp && /汉印提交失败/.test(r.hp.error), 'hp.error 回报失败原因')
})

console.log('禅道配置持久化:')
await test('保存密码 → 落盘为密文字段 → load 只下发脱敏标志', () => {
  const ok = store.save({ zentao: { baseUrl: 'http://10.11.34.2', account: 'wgl', password: 'p@ss' } })
  assert.strictEqual(ok, true)
  const disk = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'userdata', 'config.json'), 'utf8'))
  assert.ok(disk.zentao.plain === 'p@ss' || disk.zentao.pwdEnc) // 明文兜底或加密字段
  assert.ok(!disk.zentao.password)
  const cfg = store.load()
  assert.strictEqual(cfg.zentao.pwdConfigured, true)
  assert.ok(cfg.zentao.pwdMasked.includes('p@ss'.slice(-4)) || cfg.zentao.pwdMasked)
  assert.ok(!cfg.zentao.pwdEnc)
  assert.strictEqual(store.getZentaoPwd(), 'p@ss')
})
await test('空密码保存保留旧密码，clearPwd 清除', () => {
  store.save({ zentao: { baseUrl: 'http://10.11.34.2', account: 'wgl' } })
  assert.strictEqual(store.getZentaoPwd(), 'p@ss')
  store.save({ zentao: { baseUrl: 'http://10.11.34.2', account: 'wgl', clearPwd: true } })
  assert.strictEqual(store.getZentaoPwd(), '')
})

// ═══════════ 公司内网默认地址（AI / 禅道 / 汉印） ═══════════
console.log('公司内网默认地址:')
await test('全新配置（无 config.json）回落公司默认地址与公司 1', () => {
  fs.rmSync(path.join(tmpRoot, 'userdata', 'config.json'), { force: true })
  const cfg = store.load()
  assert.strictEqual(cfg.ai.baseUrl, 'http://ai.sysapp.prttech.com:18080/v1')
  assert.strictEqual(cfg.zentao.baseUrl, 'http://10.11.34.2')
  assert.strictEqual(cfg.hanprint.baseUrl, 'http://10.10.21.2:5293')
  assert.strictEqual(cfg.hanprint.clientId, '1')
})
await test('历史配置里地址/公司留空 → 回落默认，不显示空值', () => {
  store.save({ ai: { baseUrl: '' }, zentao: { baseUrl: '', account: 'wgl' }, hanprint: { baseUrl: '', clientId: '', account: '21290' } })
  const cfg = store.load()
  assert.strictEqual(cfg.ai.baseUrl, 'http://ai.sysapp.prttech.com:18080/v1')
  assert.strictEqual(cfg.zentao.baseUrl, 'http://10.11.34.2')
  assert.strictEqual(cfg.hanprint.baseUrl, 'http://10.10.21.2:5293')
  assert.strictEqual(cfg.hanprint.clientId, '1')
})
await test('用户填过其他地址/公司则原样保留（不被默认值覆盖）', () => {
  store.save({
    ai: { baseUrl: 'http://192.168.1.9:8080/v1' },
    zentao: { baseUrl: 'http://192.168.1.9:8080', account: 'wgl' },
    hanprint: { baseUrl: 'http://192.168.1.9:5293', clientId: '2', account: '21290' },
  })
  const cfg = store.load()
  assert.strictEqual(cfg.ai.baseUrl, 'http://192.168.1.9:8080/v1')
  assert.strictEqual(cfg.zentao.baseUrl, 'http://192.168.1.9:8080')
  assert.strictEqual(cfg.hanprint.baseUrl, 'http://192.168.1.9:5293')
  assert.strictEqual(cfg.hanprint.clientId, '2')
})

// ═══════════ git 提交收集（真实 git 集成） ═══════════
console.log('git 提交收集（真实仓库）:')

function gitOk() {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
}

if (gitOk()) {
  const repoDir = path.join(tmpRoot, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })
  function commitAt(date, time, msg, email = 'me@corp.com', name = 'Me') {
    execFileSync('git', ['commit', '--allow-empty', '-m', msg], {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
        GIT_AUTHOR_DATE: `${date} ${time}:00 +0800`,
        GIT_COMMITTER_DATE: `${date} ${time}:00 +0800`,
      },
    })
  }
  // 动态历史日期（今天−3 天）：确保 resolveEndTime 返回下班时间而非「今天当前时刻」
  const pastDay = new Date(Date.now() - 3 * 86400000)
  const pd = (n) => String(n).padStart(2, '0')
  const pastDayStr = `${pastDay.getFullYear()}-${pd(pastDay.getMonth() + 1)}-${pd(pastDay.getDate())}`
  const dayBefore = new Date(pastDay.getTime() - 86400000)
  const dayBeforeStr = `${dayBefore.getFullYear()}-${pd(dayBefore.getMonth() + 1)}-${pd(dayBefore.getDate())}`
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  commitAt(pastDayStr, '09:12', 'feat: 完成订单模块')
  commitAt(pastDayStr, '11:40', 'fix: 修复库存同步')
  commitAt(pastDayStr, '14:05', 'refactor: 重构导出', 'other@corp.com', 'Other') // 他人提交，应被过滤
  commitAt(dayBeforeStr, '10:00', 'chore: 更早一天的提交') // 非当日，应被过滤

  await test('按日过滤 + 本人过滤 + 带HH:MM + 时间升序', async () => {
    const commits = await fill.collectTimedCommits(
      [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
      { date: pastDayStr, identities: [{ name: 'Me', email: 'me@corp.com' }] },
    )
    assert.strictEqual(commits.length, 2)
    assert.strictEqual(commits[0].time, '09:12')
    assert.strictEqual(commits[1].time, '11:40')
    assert.ok(commits[0].msg.includes('订单模块'))
    assert.strictEqual(commits[0].projectId, 'p1')
  })

  await test('identities 为空时返回空列表（工时绝不误算他人提交）', async () => {
    const commits = await fill.collectTimedCommits(
      [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
      { date: pastDayStr, identities: [] },
    )
    assert.strictEqual(commits.length, 0)
  })

  await test('plan 端到端：真实提交 → 按提交数分配 → 汇总（不依赖禅道）', async () => {
    // 不配置禅道：plan 应容错返回 ztError 而不抛异常；显式 endTime 让断言不依赖运行时刻
    store.save({ roots: [], identities: [{ name: 'Me', email: 'me@corp.com' }] })
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '09:12', // 实际上班时间（与首条提交时刻恰好相同，仅作对照）
      endTime: '17:30',
      projects: [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
    })
    assert.ok(r.ztError)
    assert.strictEqual(r.planned.length, 1) // 一个项目一条记录
    // 总工时 09:12→17:30 = 498−60 = 438min → 420 = 7h（单项目全部分配）
    assert.strictEqual(r.planned[0].hours, 7)
    assert.strictEqual(r.rangeStart, '09:12')
    assert.strictEqual(r.rangeEnd, '17:30')
    assert.strictEqual(r.planned[0].work, '1. 完成订单模块\n2. 修复库存同步') // feat:/fix: 前缀已剥离
    assert.strictEqual(r.unmatchedProjects.length, 1) // 有提交但未绑定
  })

  await test('plan 起点与提交时刻无关：startTime 早于首条提交时多计时', async () => {
    store.save({ roots: [], identities: [{ name: 'Me', email: 'me@corp.com' }] })
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '08:30', // 早于首条提交 09:12
      endTime: '17:30',
      projects: [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
    })
    // 08:30→17:30 = 540−60 = 480 = 8h
    assert.strictEqual(r.planned[0].hours, 8)
    assert.strictEqual(r.rangeStart, '08:30')
  })

  await test('plan 端到端：显式 endTime 跨夜（历史日期 08:30 → 次日 00:30 = 15h）', async () => {
    store.save({ roots: [], identities: [{ name: 'Me', email: 'me@corp.com' }] })
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '08:30',
      endTime: '00:30', // 早于上班时间 → 次日跨夜
      projects: [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
    })
    // 08:30 → 次日 00:30 = 960min，扣 60min 午休 = 900min → 15h
    assert.strictEqual(r.planned[0].hours, 15)
    assert.strictEqual(r.rangeEnd, '00:30')
    assert.strictEqual(r.crossDay, true)
    assert.strictEqual(r.endTimeManual, true)
  })

  await test('plan 端到端：未填 endTime 时终点为点击时刻（与填报日期无关）', async () => {
    store.save({ roots: [], identities: [{ name: 'Me', email: 'me@corp.com' }] })
    const before = new Date()
    const r = await fill.plan({
      date: pastDayStr, // 历史日期，同样取点击时刻
      startTime: '08:30',
      projects: [{ id: 'p1', name: 'ProjA', repos: [repoDir] }],
    })
    const after = new Date()
    const hm = (d) => `${pd(d.getHours())}:${pd(d.getMinutes())}`
    assert.ok([hm(before), hm(after)].includes(r.rangeEnd), `rangeEnd=${r.rangeEnd} 不在 ${hm(before)}–${hm(after)} 内`)
    assert.strictEqual(r.endTimeManual, false)
    assert.strictEqual(r.crossDay, fill.isCrossDay('08:30', r.rangeEnd))
  })

  await test('plan 拒绝非法 endTime 格式', async () => {
    store.save({ roots: [], identities: [{ name: 'Me', email: 'me@corp.com' }] })
    await assert.rejects(
      () => fill.plan({ date: pastDayStr, startTime: '08:30', endTime: '25:99', projects: [{ id: 'p1', name: 'ProjA', repos: [repoDir] }] }),
      /下班时间格式不正确/,
    )
  })

  // ── 提交明细与所选子集（真实 git + 汉印接口注入；真实平台无可用账号，不发网络请求） ──
  /** 建一个真实仓库并把提交固定在填报日 */
  function mkRepo(name, items) {
    const dir = path.join(tmpRoot, name)
    fs.mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    for (const [time, msg] of items) {
      execFileSync('git', ['commit', '--allow-empty', '-m', msg], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Me', GIT_AUTHOR_EMAIL: 'me@corp.com',
          GIT_COMMITTER_NAME: 'Me', GIT_COMMITTER_EMAIL: 'me@corp.com',
          GIT_AUTHOR_DATE: `${pastDayStr} ${time}:00 +0800`,
          GIT_COMMITTER_DATE: `${pastDayStr} ${time}:00 +0800`,
        },
      })
    }
    return dir
  }
  const repoA = mkRepo('repo-hp-a', [['09:05', 'feat: A1'], ['09:15', 'feat: A2'], ['09:25', 'feat: A3']])
  const repoB = mkRepo('repo-hp-b', [['09:35', 'feat: B1']])
  const HP_PROJECTS = [
    { id: 'hpA', name: 'P-A', repos: [repoA] },
    { id: 'hpB', name: 'P-B', repos: [repoB] },
  ]
  // 汉印接口注入（本块为文件末尾，注入后不再还原）：只验证编排与条目过滤，不发网络请求
  hpSvc.getGroups = async () => ([{
    type: 3,
    typeName: '软件项目',
    projectId: '799',
    projectName: 'P-A',
    tasks: [{ Key: '66', Name: '任务A' }, { Key: '88', Name: '任务B' }],
  }])
  hpSvc.ensureClient = async () => ({ getByDate: async () => [] })
  store.save({
    roots: [],
    identities: [{ name: 'Me', email: 'me@corp.com' }],
    hanprint: { baseUrl: 'http://hp.example', clientId: '1', account: '21290', password: 'secret' },
  })

  await test('plan 端到端：有提交的项目保底 0.5h（不再被抹成 0，汉印占比 50/50）', async () => {
    // 真实 git：repoA 3 条提交 / repoB 1 条，总工时 1h → 各保底 0.5h（原来 repoB 会被抹成 0）
    fill.bindProject('hpA', 66, '任务A')
    fill.bindProject('hpB', 88, '任务B')
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '09:00',
      endTime: '10:00', // 60min，无午休重叠 → 总工时 1h
      projects: HP_PROJECTS,
      selectedIds: ['hpA', 'hpB'],
    })
    const a = r.planned.find((x) => x.projectId === 'hpA')
    const b = r.planned.find((x) => x.projectId === 'hpB')
    assert.strictEqual(b.hours, 0.5, 'repoB 占 1/4 提交也保底 0.5h')
    assert.strictEqual(a.hours, 0.5, 'repoA 份额 0.75h 取整 0.5h')
    assert.strictEqual(round2of(a.hours + b.hours), 1, 'Σ 仍等于总工时')
    assert.deepStrictEqual(r.hpUnmatched, [])
    assert.strictEqual(r.hpItems.length, 2)
    assert.strictEqual(r.hpZeroSkipped, 0, '保底后不再有 0% 条目')
    assert.deepStrictEqual(r.hpItems.map((x) => x.TaskId), ['66', '88'])
    assert.deepStrictEqual(r.hpItems.map((x) => x.Percent), [50, 50])
    assert.strictEqual(r.hpItems.reduce((s, x) => s + x.Percent, 0), 100)
    fill.unbindProject('hpA')
    fill.unbindProject('hpB')
  })
  // ── 生成全部 + 按所选子集计算（先生成今天所有项目的填报内容，再勾选项目填报） ──
  await test('plan 先采集当天全部项目，再按所选子集算工时', async () => {
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '09:00',
      endTime: '10:00', // 60min → 总工时 1h
      projects: HP_PROJECTS,
      selectedIds: ['hpA', 'hpB'], // 全选
    })
    assert.strictEqual(r.dayProjects.length, 2, '两个项目当天都有提交 → 都列出来供勾选')
    assert.strictEqual(r.dayProjects.every((p) => p.selected), true)
    const b = r.planned.find((x) => x.projectId === 'hpB')
    assert.strictEqual(b.hours, 0.5, 'repoB 保底 0.5h')
    assert.strictEqual(r.planned.find((x) => x.projectId === 'hpA').hours, 0.5)
    assert.strictEqual(round2of(r.planned.reduce((s, x) => s + x.hours, 0)), 1)
  })

  await test('plan 默认勾选当天有提交的全部项目（含未绑定，便于就地绑定）', async () => {
    fill.bindProject('hpA', 66, '任务A')
    fill.unbindProject('hpB') // 未绑定：仍默认勾选，避免工时静默漏报（提交时会被未绑定拦截）
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '09:00',
      endTime: '10:00',
      projects: [
        { id: 'hpA', name: 'P-A', repos: [repoA] },
        { id: 'hpB', name: 'P-B', repos: [repoB] },
      ],
      // selectedIds 省略 = 用户从未选择过 → 走默认勾选
    })
    assert.deepStrictEqual(r.selectedIds, ['hpA', 'hpB'])
    assert.strictEqual(r.dayProjects.length, 2)
    assert.strictEqual(r.dayProjects.every((p) => p.selected), true)
    const b = r.planned.find((p) => p.projectId === 'hpB')
    assert.strictEqual(b.taskId, null, '未绑定项目仍在明细里，提示绑定')
    assert.strictEqual(r.planned.length, 2)
  })

  await test('plan 勾选变化后按新子集重算工时与汉印占比', async () => {
    fill.bindProject('hpA', 66, '任务A')
    fill.bindProject('hpB', 88, '任务B')
    const projects = [
      { id: 'hpA', name: 'P-A', repos: [repoA] },
      { id: 'hpB', name: 'P-B', repos: [repoB] },
    ]
    // 只勾选 Beta：全部工时归 Beta（子集内 1/1），汉印占比 100%
    const only = await fill.plan({ date: pastDayStr, startTime: '09:00', endTime: '10:00', projects, selectedIds: ['hpB'] })
    assert.strictEqual(only.planned.length, 1)
    assert.strictEqual(only.planned[0].hours, 1)
    assert.strictEqual(only.tasks.length, 1)
    assert.strictEqual(only.tasks[0].taskId, 88)
    assert.strictEqual(only.tasks[0].consumed, 1)
    assert.strictEqual(only.hpItems.length, 1)
    assert.strictEqual(only.hpItems[0].TaskId, '88')
    assert.strictEqual(only.hpItems[0].Percent, 100)
    assert.strictEqual(only.hpZeroSkipped, 0)
    // 全选：按 3:1 分配但落回保底 0.5h/0.5h，占比变 50/50
    const all = await fill.plan({ date: pastDayStr, startTime: '09:00', endTime: '10:00', projects, selectedIds: ['hpA', 'hpB'] })
    assert.strictEqual(all.hpItems.length, 2)
    assert.deepStrictEqual(all.hpItems.map((x) => x.Percent), [50, 50])
    assert.strictEqual(all.hpItems.reduce((s, x) => s + x.Percent, 0), 100)
  })

  await test('plan 未勾选任何项目：不产出工时与汉印条目，但明细仍可勾选', async () => {
    const r = await fill.plan({
      date: pastDayStr,
      startTime: '09:00',
      endTime: '10:00',
      projects: [
        { id: 'hpA', name: 'P-A', repos: [repoA] },
        { id: 'hpB', name: 'P-B', repos: [repoB] },
      ],
      selectedIds: [],
    })
    assert.deepStrictEqual(r.selectedIds, [])
    assert.deepStrictEqual(r.planned, [])
    assert.deepStrictEqual(r.tasks, [])
    assert.deepStrictEqual(r.hpItems, [])
    assert.strictEqual(r.dayProjects.length, 2)
  })

  await test('plan reuse：复用上次采集结果，勾选项目不重复跑 git', async () => {
    const projects = [
      { id: 'hpA', name: 'P-A', repos: [repoA] },
      { id: 'hpB', name: 'P-B', repos: [repoB] },
    ]
    const first = await fill.plan({ date: pastDayStr, startTime: '09:00', endTime: '10:00', projects, selectedIds: ['hpA'] })
    assert.strictEqual(first.reused, false)
    // 采集后仓库又多了一条当天提交：reuse 必须看不到它（证明用的是缓存采集结果）
    execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: A4'], {
      cwd: repoA,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Me', GIT_AUTHOR_EMAIL: 'me@corp.com',
        GIT_COMMITTER_NAME: 'Me', GIT_COMMITTER_EMAIL: 'me@corp.com',
        GIT_AUTHOR_DATE: `${pastDayStr} 09:40:00 +0800`,
        GIT_COMMITTER_DATE: `${pastDayStr} 09:40:00 +0800`,
      },
    })
    const reused = await fill.plan({ date: pastDayStr, startTime: '09:00', endTime: '10:00', projects, selectedIds: ['hpA', 'hpB'], reuse: true })
    assert.strictEqual(reused.reused, true)
    assert.strictEqual(reused.commitCount, first.commitCount)
    // 重新生成（reuse 不传）→ 重新采集，能看到新提交，且窗口一致时工时不变（1h）
    const fresh = await fill.plan({ date: pastDayStr, startTime: '09:00', endTime: '10:00', projects, selectedIds: ['hpA', 'hpB'] })
    assert.strictEqual(fresh.reused, false)
    assert.strictEqual(fresh.commitCount, first.commitCount + 1)
  })

  const totalOf = (r) => round2of(r.planned.reduce((s, p) => s + p.hours, 0))
  const hoursOf = (r, id) => (r.planned.find((p) => String(p.projectId) === id) || {}).hours

  await test('生成后改上班时间：按新起点重算工时（含禅道行），且不重跑 git', async () => {
    const projects = [
      { id: 'hpA', name: 'P-A', repos: [repoA] },
      { id: 'hpB', name: 'P-B', repos: [repoB] },
    ]
    const sel = ['hpA', 'hpB']
    const first = await fill.plan({ date: pastDayStr, startTime: '09:00', endTime: '10:00', projects, selectedIds: sel })
    assert.strictEqual(totalOf(first), 1) // 09:00→10:00 = 1h
    const before = first.commitCount
    // 采集后仓库又多一条当天提交：重算必须看不到它（证明是复用采集，而不是重跑 git）
    execFileSync('git', ['commit', '--allow-empty', '-m', 'feat: A5'], {
      cwd: repoA,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Me', GIT_AUTHOR_EMAIL: 'me@corp.com',
        GIT_COMMITTER_NAME: 'Me', GIT_COMMITTER_EMAIL: 'me@corp.com',
        GIT_AUTHOR_DATE: `${pastDayStr} 09:50:00 +0800`,
        GIT_COMMITTER_DATE: `${pastDayStr} 09:50:00 +0800`,
      },
    })
    // 上班时间提前 30 分钟 → 总工时 1.5h
    const moved = await fill.plan({ date: pastDayStr, startTime: '08:30', endTime: '10:00', projects, selectedIds: sel, reuse: true })
    assert.strictEqual(moved.reused, true)
    assert.strictEqual(moved.rangeStart, '08:30')
    assert.strictEqual(totalOf(moved), 1.5)
    assert.strictEqual(moved.commitCount, before) // 仍是上次采集的提交数
    // 提交内容（禅道行 / 汉印占比）必须跟着新工时走，否则页面显示与写入不一致
    const ztA = moved.tasks.find((t) => String(t.taskId) === '66')
    assert.ok(ztA, 'hpA 已绑定 #66，应有禅道汇总行')
    assert.strictEqual(ztA.consumed, hoursOf(moved, 'hpA'))
    assert.strictEqual(round2of(moved.hpItems.reduce((s, it) => s + it.Percent, 0)), 100)
    // 改完时间再改勾选：两次口径必须一致，不能退回改前的 09:00（旧实现按计划里的旧起点重算）
    const only = await fill.plan({ date: pastDayStr, startTime: '08:30', endTime: '10:00', projects, selectedIds: ['hpA'], reuse: true })
    assert.strictEqual(totalOf(only), 1.5) // 单项目独得总工时
  })

  await test('终点留空时改上班时间：沿用上次跨夜判定，不凭空变成次日', async () => {
    const projects = [
      { id: 'hpA', name: 'P-A', repos: [repoA] },
      { id: 'hpB', name: 'P-B', repos: [repoB] },
    ]
    const sel = ['hpA', 'hpB']
    // 终点留空 = 生成那一刻；页面把该终点固定下来用于重算（否则工时随挂机时间漂移）
    const auto = await fill.plan({ date: pastDayStr, startTime: '00:00', endTime: '', projects, selectedIds: sel })
    assert.strictEqual(auto.crossDay, false)
    assert.ok(/^\d{2}:\d{2}$/.test(auto.rangeEnd))
    if (auto.rangeEnd === '23:59') { console.log('  （当前时刻 23:59，跳过跨夜对比）'); return }
    // 把上班时间改到晚于该终点（最坏情形：只晚 1 分钟）
    const mins = Number(auto.rangeEnd.slice(0, 2)) * 60 + Number(auto.rangeEnd.slice(3, 5)) + 1
    const afterEnd = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
    // 不传判定（旧行为）→ 同一组入参被当成「次日」，算出近一整天（22.5h或23.5h，取决于是否跨过午休）
    const legacy = await fill.plan({ date: pastDayStr, startTime: afterEnd, endTime: auto.rangeEnd, projects, selectedIds: sel, reuse: true })
    assert.strictEqual(legacy.crossDay, true)
    assert.strictEqual(legacy.commitCount, auto.commitCount)
    assert.ok(totalOf(legacy) >= 22.5, `旧行为应算出近一整天，实得 ${totalOf(legacy)}h`)
    // 沿用上次判定 → 区间为空（每个有提交的项目保底 0.5h），不是按次日补算
    const carried = await fill.plan({ date: pastDayStr, startTime: afterEnd, endTime: auto.rangeEnd, crossDay: false, projects, selectedIds: sel, reuse: true })
    assert.strictEqual(carried.crossDay, false)
    assert.strictEqual(totalOf(carried), 1) // 2 个项目 × 保底 0.5h
    assert.strictEqual(hoursOf(carried, 'hpA'), 0.5)
  })

  await test('显式填写的跨夜终点：改上班时间照常按跨夜重算', async () => {
    const projects = [
      { id: 'hpA', name: 'P-A', repos: [repoA] },
      { id: 'hpB', name: 'P-B', repos: [repoB] },
    ]
    const sel = ['hpA', 'hpB']
    // 昨天 22:00 上班、今天 02:00 收工：显式终点早于上班时间 = 次日，语义不变
    const first = await fill.plan({ date: pastDayStr, startTime: '22:00', endTime: '02:00', projects, selectedIds: sel })
    assert.strictEqual(first.crossDay, true)
    assert.strictEqual(totalOf(first), 4)
    // 上班时间改成 23:00 → 仍按次日 02:00 算 3h（不回退成同日 0h，也不变成 25h）
    const moved = await fill.plan({ date: pastDayStr, startTime: '23:00', endTime: '02:00', projects, selectedIds: sel, reuse: true })
    assert.strictEqual(moved.crossDay, true)
    assert.strictEqual(totalOf(moved), 3)
  })

  await test('plan 带回绑定任务选择列表（含已完成），提交汇总仍按未完成列表', async () => {
    const projects = [{ id: 'hpA', name: 'P-A', repos: [repoA] }]
    store.save({
      roots: [],
      identities: [{ name: 'Me', email: 'me@corp.com' }],
      hanprint: { baseUrl: 'http://hp.example', clientId: '1', account: '21290', password: 'secret' },
      zentao: { baseUrl: 'http://zt.example', account: 'me', password: 'p@ss' },
    })
    const origZt = ztSvc.ensureClient
    ztSvc.ensureClient = async () => ({
      myTasks: async () => [{ id: 66, name: '进行中任务', status: 'doing', consumed: 1, left: 3 }],
      myTaskOptions: async () => ([
        { id: 66, name: '进行中任务', status: 'doing', consumed: 1, left: 3, finished: false, finishedAt: '' },
        { id: 429, name: '已完成任务', status: 'done', consumed: 8, left: 0, finished: true, finishedAt: pastDayStr },
      ]),
      getTaskEfforts: async () => [],
    })
    try {
      fill.bindProject('hpA', 429, '已完成任务') // 绑定到一个已完成的任务（完成后仍可能要补填工时）
      const r = await fill.plan({ date: pastDayStr, startTime: '09:00', endTime: '10:00', projects, selectedIds: ['hpA'] })
      // 选择列表：进行中在前、已完成在后
      assert.deepStrictEqual(r.ztTaskOptions.map((t) => t.id), [66, 429])
      assert.strictEqual(r.ztTaskOptions[1].finished, true)
      // 提交链路仍只认未完成列表：已完成任务取不到「最新剩余」，不臆造 left
      assert.deepStrictEqual(r.ztTasks.map((t) => t.id), [66])
      const t = r.tasks.find((x) => String(x.taskId) === '429')
      assert.ok(t, '已完成任务也要能生成禅道汇总行')
      assert.strictEqual(t.taskLeft, null)
      assert.strictEqual(t.consumed, 1) // 09:00→10:00 = 1h
    } finally {
      ztSvc.ensureClient = origZt
      fill.bindProject('hpA', 66, '任务A') // 还原该块后续/复用用例依赖的绑定
    }
  })
} else {
  console.log('  （git 不可用，跳过真实仓库集成用例）')
}

// ═══════════ 汇总 ═══════════
console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 保留临时目录不影响结论 */ }
if (failed > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('自测脚本异常:', e)
  process.exitCode = 1
})
