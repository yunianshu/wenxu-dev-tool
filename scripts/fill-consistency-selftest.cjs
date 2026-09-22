/** 填报总量与并发回归：仅用隔离目录和虚构平台，不连接真实服务。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-consistency-test-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => false },
} }
const fill = require('../electron/fill-service')
const store = require('../electron/store')
const zentao = require('../electron/zentao-service')
const hanprint = require('../electron/hanprint-service')
const date = '2026-09-21'
let cfg = { zentao: { baseUrl: 'https://zt.example.invalid', account: 'review' }, hanprint: { baseUrl: 'https://hp.example.invalid', account: 'review' } }
store.load = () => cfg
let efforts, hpRows, writes, nextId, failWrite, queryGate
const logPath = path.join(root, 'fill-log.json')
function reset() {
  efforts = new Map([[1, []], [2, []]])
  hpRows = []; writes = []; nextId = 100; failWrite = false; queryGate = null
  fs.writeFileSync(logPath, '[]')
}
zentao.ensureClient = async () => ({
  myTasks: async () => { if (queryGate) await queryGate; return [{ id: 1, left: 8 }, { id: 2, left: 8 }] },
  getTaskEfforts: async (id) => (efforts.get(id) || []).map((row) => ({ ...row })),
  recordEfforts: async (id, rows, dryRun) => {
    if (dryRun) return { dryRun: true }
    if (failWrite) throw new Error('模拟平台写入失败')
    writes.push(`zt:${id}`)
    for (const row of rows) {
      const old = efforts.get(id).find((item) => item.id === row.effortId)
      if (old) Object.assign(old, row)
      else efforts.get(id).push({ ...row, id: nextId++ })
    }
    return { status: 200 }
  },
})
hanprint.ensureClient = async () => ({
  getByDate: async () => hpRows.map((row) => ({ ...row })),
  add: async (rows, dryRun) => {
    if (dryRun) return { dryRun: true, json: rows }
    writes.push('hp')
    for (const row of rows) {
      const old = hpRows.find((item) => item.Id === row.Id)
      if (old) Object.assign(old, row)
      else hpRows.push({ ...row, Id: nextId++ })
    }
    return { status: 'ok' }
  },
})
function payload(ids = [1, 2]) {
  return { date, tasks: ids.map((id) => ({ taskId: id, rows: [{ date, work: `项目 ${id}`, consumed: 8 / ids.length }] })),
    hp: { items: ids.map((id) => ({ TaskId: String(id), ProjectType: 3, WorkDate: date, Percent: 100 / ids.length })) } }
}
let passed = 0
async function test(name, fn) { reset(); await fn(); passed++; console.log(`  ✓ ${name}`) }
async function main() {
  await test('取消已写入项目时，预览和正式提交均在任何写入前阻止残留', async () => {
    await fill.submit(payload())
    const count = writes.length
    for (const dryRun of [true, false]) await assert.rejects(() => fill.submit({ ...payload([1]), dryRun }), /任务 #2.*4h.*本次未包含/)
    assert.strictEqual(writes.length, count)
    assert.strictEqual([...efforts.values()].flat().reduce((sum, row) => sum + row.consumed, 0), 8)
    assert.strictEqual(hpRows.reduce((sum, row) => sum + row.Percent, 0), 100)
  })
  await test('同一任务减少工时行时，保留原记录并明确提示', async () => {
    efforts.set(1, [{ id: 21, date, consumed: 4 }, { id: 22, date, consumed: 4 }])
    await assert.rejects(() => fill.submit(payload([1])), /已有 2 条工时，本次只有 1 条/)
    assert.strictEqual(writes.length, 0)
    assert.strictEqual(efforts.get(1).length, 2)
  })
  await test('来源不明的汉印记录不删除，也不能连同新计划突破占比总量', async () => {
    hpRows = [{ Id: 80, TaskId: '99', ProjectType: 3, Percent: 25, WorkDate: date }]
    for (const dryRun of [true, false]) await assert.rejects(() => fill.submit({ ...payload([1]), dryRun }), /#99（25%）.*两个平台均未写入/)
    assert.strictEqual(writes.length, 0)
    assert.strictEqual(hpRows.length, 1)
  })
  await test('完整重新提交仍复用记录 ID，平台总量保持不变', async () => {
    await fill.submit(payload()); await fill.submit(payload())
    assert.strictEqual([...efforts.values()].flat().length, 2)
    assert.strictEqual(hpRows.length, 2)
    assert.strictEqual(hpRows.reduce((sum, row) => sum + row.Percent, 0), 100)
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8'))[0]
    assert.match(log.platformScope.zentao, /^[a-f0-9]{64}$/)
    assert.ok(!JSON.stringify(log.platformScope).includes('review'))
  })
  await test('先前写过汉印却在新计划完全省略时，同样先提示处理旧记录', async () => {
    await fill.submit(payload([1]))
    const count = writes.length
    const withoutHp = payload([1]); delete withoutHp.hp
    await assert.rejects(() => fill.submit(withoutHp), /汉印.*#1（100%）.*两个平台均未写入/)
    assert.strictEqual(writes.length, count)
  })
  await test('旧版无账号摘要的留痕仍可凭实际内容识别遗漏任务', async () => {
    await fill.submit(payload())
    const logs = JSON.parse(fs.readFileSync(logPath, 'utf8'))
    delete logs[0].platformScope
    fs.writeFileSync(logPath, JSON.stringify(logs))
    const count = writes.length
    await assert.rejects(() => fill.submit(payload([1])), /任务 #2.*本次未包含/)
    assert.strictEqual(writes.length, count)
  })
  await test('平台账号变更后不采用其他账号的历史任务范围', async () => {
    await fill.submit(payload())
    const previous = cfg
    cfg = { zentao: { ...cfg.zentao, account: 'other' }, hanprint: { ...cfg.hanprint, account: 'other' } }
    efforts.set(1, []); hpRows = []
    try { await fill.submit(payload([1])) } finally { cfg = previous }
    assert.strictEqual(efforts.get(1).length, 1)
  })
  await test('并发普通提交只执行一次；锁释放后同内容重试仍不重复', async () => {
    let release
    queryGate = new Promise((resolve) => { release = resolve })
    const first = fill.submit(payload([1]))
    await assert.rejects(() => fill.submit(payload([1])), /已有填报正在处理/)
    release(); await first; queryGate = null
    await fill.submit(payload([1]))
    assert.strictEqual(efforts.get(1).length, 1)
    assert.strictEqual(hpRows.length, 1)
  })
  await test('失败重放与普通提交共用互斥，失败后锁也会释放', async () => {
    failWrite = true
    await assert.rejects(() => fill.submit(payload([1])), /模拟平台写入失败/)
    const failed = fill.listLog().find((entry) => entry.failed)
    failWrite = false
    let release
    queryGate = new Promise((resolve) => { release = resolve })
    const first = fill.submit(payload([1]))
    await assert.rejects(() => fill.resubmit(failed.at), /已有填报正在处理/)
    release(); await first; queryGate = null
    await fill.resubmit(failed.at)
    assert.strictEqual(efforts.get(1).length, 1)
    assert.strictEqual(hpRows.length, 1)
  })
  console.log(`\n结果：${passed} 通过，0 失败（未调用真实平台）`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  const expected = path.resolve(os.tmpdir()) + path.sep
  const resolved = path.resolve(root)
  if (!resolved.startsWith(expected) || !path.basename(resolved).startsWith('fill-consistency-test-')) throw new Error('测试临时目录范围不正确')
  fs.rmSync(resolved, { recursive: true, force: true })
})
