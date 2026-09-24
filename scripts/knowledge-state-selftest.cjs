/** 执行真实知识状态仓库，控制 IPC 回包顺序验证草稿与保存归属。 */
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const { buildSync } = require('esbuild')

const bundle = buildSync({ entryPoints: [path.join(__dirname, '../src/composables/useKnowledge.js')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vue'] }).outputFiles[0].text
const copy = value => JSON.parse(JSON.stringify(value))
const row = (id, revision = 1, body = `${id} 原文`) => ({ id, title: `${id} 标题`, body, type: 'idea', status: 'inbox', tags: [], projectId: '', projectName: '', sourceIds: [], createdAt: 1, updatedAt: revision, revision, deletedAt: null, contentHash: `${id}-hash-${revision}` })
const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function pending(input) {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { input: copy(input), promise, resolve, reject }
}
function harness(storage = null) {
  const timers = new Map()
  let nextTimer = 0
  const context = { module: { exports: {} }, require, Date, Map, Promise, console,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
  }
  vm.runInNewContext(bundle, context)
  const calls = { list: [], save: [], trash: [], restore: [], import: [] }
  const api = {}
  for (const [method, kind] of [['knowledgeList', 'list'], ['knowledgeSave', 'save'], ['knowledgeTrash', 'trash'], ['knowledgeRestore', 'restore'], ['knowledgeImport', 'import']]) {
    api[method] = (...args) => { const call = pending(args); calls[kind].push(call); return call.promise }
  }
  const store = context.module.exports.createKnowledgeStore(api, 600, storage)
  async function load(records) {
    const task = store.load(true)
    calls.list.at(-1).resolve({ ok: true, records: copy(records), warnings: [], directory: '/isolated/knowledge' })
    assert.equal(await task, true)
  }
  function saved(index, overrides = {}) {
    const input = calls.save[index].input[0]
    const id = input.id || `new-${index}`
    const revision = (input.revision || 0) + 1
    const record = { ...row(id, revision), ...input, id, revision, updatedAt: revision, contentHash: `${id}-hash-${revision}`, ...overrides }
    calls.save[index].resolve({ ok: true, record })
    return record
  }
  function fireTimers() {
    const callbacks = [...timers.values()]
    timers.clear()
    return Promise.all(callbacks.map(callback => callback()))
  }
  return { store, calls, timers, load, saved, fireTimers }
}

function memoryStorage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }
}

const cases = [
  ['同一记录连续输入串行保存，旧回包不覆盖新输入', async () => {
    const h = harness(); await h.load([row('A')])
    h.store.change({ ...h.store.record('A'), body: '第一次输入' })
    const first = h.store.flush('A')
    h.store.change({ ...h.store.record('A'), body: '保存期间的第二次输入' })
    const second = h.store.flush('A')
    assert.equal(h.calls.save.length, 1)
    h.saved(0); await ticks()
    assert.equal(h.store.record('A').body, '保存期间的第二次输入')
    assert.equal(h.calls.save.length, 2)
    assert.equal(h.calls.save[1].input[0].revision, 2)
    assert.equal(h.calls.save[1].input[0].contentHash, 'A-hash-2', '连续输入必须沿用自己上次保存后的文件指纹')
    h.saved(1)
    assert.equal(await first, true); assert.equal(await second, true)
    assert.equal(h.store.record('A').body, '保存期间的第二次输入')
    assert.equal(h.store.dirty('A'), false)
    assert.equal(h.store.data.drafts.A, undefined)
  }],
  ['切换记录与不同记录逆序回包保持保存归属', async () => {
    const h = harness(); await h.load([row('A'), row('B')])
    h.store.openRecord(h.store.record('A'))
    h.store.change({ ...h.store.record('A'), body: 'A_ONLY' }); const a = h.store.flush('A')
    h.store.openRecord(h.store.record('B'))
    h.store.change({ ...h.store.record('B'), body: 'B_ONLY' }); const b = h.store.flush('B')
    assert.deepEqual(h.calls.save.map(call => call.input[0].id), ['A', 'B'])
    h.saved(1); await b; h.saved(0); await a
    assert.equal(h.store.workspace.selectedId, 'B')
    assert.equal(h.store.record('A').body, 'A_ONLY'); assert.equal(h.store.record('B').body, 'B_ONLY')
    assert.equal(h.store.dirty('A'), false); assert.equal(h.store.dirty('B'), false)
  }],
  ['保存失败保留草稿，同值重试可恢复', async () => {
    const h = harness(); await h.load([row('A')])
    h.store.change({ ...h.store.record('A'), body: '磁盘失败也不能丢失' })
    const failed = h.store.flush('A'); h.calls.save[0].resolve({ ok: false, error: '磁盘已满', code: 'ENOSPC' })
    assert.equal(await failed, false)
    assert.equal(h.store.record('A').body, '磁盘失败也不能丢失')
    assert.equal(h.store.dirty('A'), true); assert.equal(h.store.data.saving.A, false)
    assert.match(h.store.data.errors.A, /磁盘/)
    const retry = h.store.flush('A')
    assert.deepEqual(h.calls.save[1].input, h.calls.save[0].input)
    h.saved(1); assert.equal(await retry, true)
    assert.equal(h.store.dirty('A'), false); assert.equal(h.store.data.errors.A, '')
  }],
  ['迟到列表不回退已保存版本或移除期间新建记录', async () => {
    const h = harness(); await h.load([row('A')])
    const late = h.store.load(true)
    h.store.change({ ...h.store.record('A'), body: '已保存新版' })
    const save = h.store.flush('A'); h.saved(0); await save
    const create = h.store.create({ title: '期间新建' }); const created = h.saved(1); await create
    h.calls.list[1].resolve({ ok: true, records: [row('A')], directory: '/isolated/knowledge', warnings: [] }); await late
    assert.equal(h.store.record('A').revision, 2)
    assert.equal(h.store.record('A').body, '已保存新版')
    assert.equal(h.store.record(created.id).title, '期间新建')
  }],
  ['force 读取期间编辑保留草稿基线，外部更新不能自动重定基线', async () => {
    const h = harness(); await h.load([row('A')])
    const late = h.store.load(true)
    h.store.change({ ...h.store.record('A'), body: '基于第一版的本地草稿' })
    h.calls.list[1].resolve({ ok: true, records: [row('A', 2, '外部第二版')], directory: '/isolated/knowledge', warnings: [] }); await late
    assert.equal(h.store.record('A').body, '基于第一版的本地草稿')
    const save = h.store.flush('A')
    assert.equal(h.calls.save[0].input[0].revision, 1, '刷新不能悄悄让旧正文获得新版 revision')
    assert.equal(h.calls.save[0].input[0].contentHash, 'A-hash-1')
    h.calls.save[0].resolve({ ok: false, code: 'REVISION_CONFLICT', error: '记录已更新' }); assert.equal(await save, false)
    await h.load([row('A', 2, '外部第二版')])
    const retry = h.store.flush('A')
    assert.equal(h.calls.save[1].input[0].revision, 1)
    assert.equal(h.calls.save[1].input[0].contentHash, 'A-hash-1')
    h.calls.save[1].resolve({ ok: false, code: 'REVISION_CONFLICT', error: '记录已更新' }); assert.equal(await retry, false)
    assert.equal(h.store.record('A').body, '基于第一版的本地草稿')
  }],
  ['回收站操作先保存，生命周期期间拒绝新编辑且不影响另一记录', async () => {
    const h = harness(); await h.load([row('A'), row('B')])
    h.store.change({ ...h.store.record('A'), body: '删除前最后输入' })
    const removal = h.store.lifecycle('A', 'trash')
    assert.equal(h.calls.save.length, 1); assert.equal(h.calls.trash.length, 0)
    assert.equal(h.store.change({ ...h.store.record('A'), body: '生命周期期间的过期编辑事件' }), false)
    h.saved(0); await ticks()
    assert.equal(h.calls.trash.length, 1)
    assert.deepEqual(h.calls.trash[0].input, ['A', 2])
    assert.equal(h.store.change({ ...h.store.record('A'), body: '回收站响应前过期事件' }), false)
    h.store.change({ ...h.store.record('B'), body: 'B 仍可编辑' })
    h.calls.trash[0].resolve({ ok: true, record: { ...row('A', 3, '删除前最后输入'), deletedAt: 100 } }); await removal
    assert.equal(h.store.record('A').deletedAt, 100)
    assert.equal(h.store.record('A').body, '删除前最后输入')
    assert.equal(h.store.dirty('A'), false)
    assert.equal(h.store.record('B').body, 'B 仍可编辑')
    assert.equal(await h.store.flush('A'), true, '生命周期结束不能遗留无草稿的脏状态')
  }],
  ['保存失败阻止回收站请求，操作失败后草稿仍可继续编辑', async () => {
    const h = harness(); await h.load([row('A')])
    h.store.change({ ...h.store.record('A'), body: '必须先保存' })
    const removal = h.store.lifecycle('A', 'trash')
    const rejected = assert.rejects(removal, /保存失败/)
    h.calls.save[0].resolve({ ok: false, error: '保存失败' }); await rejected
    assert.equal(h.calls.trash.length, 0)
    assert.equal(h.store.record('A').body, '必须先保存')
    assert.notEqual(h.store.change({ ...h.store.record('A'), body: '失败后继续输入' }), false)
    const retry = h.store.flush('A'); h.saved(1); assert.equal(await retry, true)
  }],
  ['刷新失败保留已有数据，重叠加载只发一条请求', async () => {
    const h = harness(); await h.load([row('A')])
    const first = h.store.load(true), second = h.store.load(true)
    assert.equal(h.calls.list.length, 2)
    h.calls.list[1].reject(new Error('读取失败'))
    assert.equal(await first, false); assert.equal(await second, false)
    assert.equal(h.store.record('A').body, 'A 原文')
    assert.match(h.store.data.error, /读取失败/)
  }],
  ['同步草稿备份在重启后恢复，自动保存成功才清除备份', async () => {
    const storage = memoryStorage()
    const original = harness(storage); await original.load([row('A')])
    original.store.change({ ...original.store.record('A'), body: '退出前尚未发给后台的输入' })
    const key = [...storage.values.keys()][0]
    assert.equal(JSON.parse(storage.getItem(key)).A.body, '退出前尚未发给后台的输入', '输入事件内就应完成备份，无须等待节流计时器')
    const restarted = harness(storage)
    assert.equal(restarted.store.record('A').body, '退出前尚未发给后台的输入')
    assert.equal(restarted.store.dirty('A'), true)
    await restarted.load([row('A')])
    assert.equal(restarted.timers.size, 1)
    const automatic = restarted.fireTimers()
    assert.equal(restarted.calls.save.length, 1)
    assert.equal(restarted.calls.save[0].input[0].revision, 1)
    assert.equal(restarted.calls.save[0].input[0].contentHash, 'A-hash-1')
    assert.equal(JSON.parse(storage.getItem(key)).A.body, '退出前尚未发给后台的输入')
    restarted.saved(0); await automatic
    assert.equal(restarted.store.dirty('A'), false)
    assert.deepEqual(JSON.parse(storage.getItem(key)), {})
    assert.equal(harness(storage).store.data.drafts.A, undefined)
  }],
  ['后台已落盘但回包前退出，重启冲突仍保留备份正文', async () => {
    const storage = memoryStorage()
    const original = harness(storage); await original.load([row('A')])
    original.store.change({ ...original.store.record('A'), body: '后台已收到但尚未确认的输入' })
    void original.store.flush('A')
    const restarted = harness(storage)
    await restarted.load([row('A', 2, '后台已收到但尚未确认的输入')])
    const automatic = restarted.fireTimers()
    assert.equal(restarted.calls.save[0].input[0].revision, 1)
    restarted.calls.save[0].resolve({ ok: false, code: 'REVISION_CONFLICT', error: '记录已被更新，请核对' })
    await automatic
    assert.equal(restarted.store.record('A').body, '后台已收到但尚未确认的输入')
    assert.equal(restarted.store.dirty('A'), true)
    assert.match(restarted.store.data.errors.A, /更新/)
    const key = [...storage.values.keys()][0]
    assert.equal(JSON.parse(storage.getItem(key)).A.body, '后台已收到但尚未确认的输入')
  }],
  ['原文件缺失时恢复草稿仍可在列表中找到并另存', async () => {
    const storage = memoryStorage()
    const original = harness(storage); await original.load([row('A')])
    original.store.change({ ...original.store.record('A'), body: '原文件不可读时的恢复正文' })
    const restarted = harness(storage); await restarted.load([])
    assert(restarted.store.data.records.some(record => record.id === 'A'), '恢复的孤立草稿必须进入可见列表，避免只能藏在 localStorage 中')
    assert.equal(restarted.store.record('A').body, '原文件不可读时的恢复正文')
    const automatic = restarted.fireTimers()
    restarted.calls.save[0].resolve({ ok: false, code: 'NOT_FOUND', error: '记录原文件不存在' })
    await automatic
    assert.equal(restarted.store.dirty('A'), true)
    assert.equal(restarted.store.record('A').body, '原文件不可读时的恢复正文')
    const copy = restarted.store.create({ ...restarted.store.record('A'), title: '恢复副本' })
    const created = restarted.saved(1); await copy
    assert.notEqual(created.id, 'A')
    assert.equal(created.body, '原文件不可读时的恢复正文')
    assert.equal(restarted.store.discard('A'), true)
    assert.deepEqual(JSON.parse(storage.getItem([...storage.values.keys()][0])), {})
  }],
  ['备用存储配额或读取失败可见，仍允许实际文件保存', async () => {
    const storage = { getItem() { throw new Error('备用存储不可读') }, setItem() { throw new Error('备用存储已满') } }
    const h = harness(storage)
    assert.match(h.store.data.backupError, /读取/)
    await h.load([row('A')])
    assert.equal(h.store.change({ ...h.store.record('A'), body: '备用存储故障时的正文' }), true)
    assert.match(h.store.data.backupError, /备份失败/)
    const saving = h.store.flush('A'); h.saved(0); assert.equal(await saving, true)
    assert.equal(h.store.record('A').body, '备用存储故障时的正文')
    assert.equal(h.store.dirty('A'), false)
  }],
  ['真实共享筛选覆盖标题正文标签、项目、类型及回收站边界', async () => {
    const source = buildSync({ entryPoints: [path.join(__dirname, '../src/utils/knowledge.js')], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text
    const context = { module: { exports: {} } }
    vm.runInNewContext(source, context)
    const { knowledgeMatches } = context.module.exports
    const record = { ...row('A'), title: 'API 故障复盘', body: '检查连接超时', tags: ['排查'], projectId: 'project-A', projectName: '历史项目', type: 'experience', status: 'organized' }
    assert.equal(knowledgeMatches(record, { query: 'api 超时 排查' }), true)
    assert.equal(knowledgeMatches(record, { query: '历史项目' }), true)
    assert.equal(knowledgeMatches(record, { query: 'API 缺失词' }), false)
    assert.equal(knowledgeMatches(record, { projectId: 'project-A', type: 'experience', view: 'reviews' }), true)
    assert.equal(knowledgeMatches(record, { projectId: 'project-B' }), false)
    assert.equal(knowledgeMatches(record, { projectId: '__none__' }), false)
    assert.equal(knowledgeMatches({ ...record, projectId: '' }, { projectId: '__none__' }), true)
    assert.equal(knowledgeMatches(record, { view: 'inbox' }), false)
    assert.equal(knowledgeMatches({ ...record, status: 'inbox' }, { view: 'inbox' }), true)
    assert.equal(knowledgeMatches({ ...record, type: 'sop' }, { view: 'methods' }), true)
    assert.equal(knowledgeMatches(record, { view: 'methods' }), false)
    assert.equal(knowledgeMatches({ ...record, type: 'principle' }, { view: 'principles' }), true)
    assert.equal(knowledgeMatches({ ...record, deletedAt: 10 }, { view: 'all' }), false)
    assert.equal(knowledgeMatches({ ...record, deletedAt: 10 }, { view: 'trash' }), true)
    assert.equal(knowledgeMatches(record, { view: 'trash' }), false)
    assert.equal(knowledgeMatches({ ...record, status: 'archived' }, { view: 'all' }), true)
  }],
]

async function main() {
  let failures = 0
  for (const [name, run] of cases) {
    try { await run(); console.log(`  ✓ ${name}`) }
    catch (error) { failures++; console.error(`  ✗ ${name}\n    ${error.stack || error}`) }
  }
  console.log(`知识状态自测：${cases.length - failures}/${cases.length} 组通过。`)
  if (failures) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })
