/** 执行真实历史组件逻辑，验证发布实例回滚、按环境显示与清空、异步项目切换边界。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vue = require('vue')

const source = fs.readFileSync(path.resolve(__dirname, '../src/components/deploy/DeployHistoryTable.vue'), 'utf8')
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/mg, '')
const props = vue.reactive({ projectId: 'project-a', targetId: 'target-a', targetName: '环境甲' })
const currentVersion = '1.0.0-current'
const deployOnlineVersion = (projectId, targetId) => projectId === 'project-a' && targetId === 'target-a' ? currentVersion : ''
const pending = [], emitted = [], cleared = []
let confirm, readLog
const window = { gitReport: {
  deployHistoryList: (projectId) => new Promise((resolve) => pending.push({ projectId, resolve })),
  deployHistoryReadLog: () => new Promise((resolve) => { readLog = resolve }),
  deployHistoryClear: async (projectId, targetId) => { cleared.push({ projectId, targetId }) },
} }
const scope = vue.effectScope()
const setup = new Function('ref', 'computed', 'watch', 'onMounted', 'onUnmounted', 'defineProps', 'defineEmits', 'defineExpose', 'deployOnlineVersion', 'window', 'ElMessageBox', 'ElMessage', script + '\nreturn { history, rollbackRecord, loadHistory, viewLog, logDialog, dialogLog, clearHistory }')
const api = scope.run(() => setup(vue.ref, vue.computed, vue.watch, () => {}, () => {}, () => props, () => (...args) => emitted.push(args), () => {}, deployOnlineVersion, window, { confirm: () => new Promise((resolve) => { confirm = resolve }) }, {}))
const settle = async () => { await Promise.resolve(); await vue.nextTick() }

// 后端：清空可以只作用于一个环境，连同日志文件一起清
const os = require('os')
const storeRoot = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'deploy-history-selftest-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => storeRoot } } }
const historyStore = require('../electron/deploy/history')

;(async () => {
  for (const [id, projectId, targetId] of [['a1', 'p1', 't1'], ['a2', 'p1', 't1'], ['b1', 'p1', 't2'], ['c1', 'p2', 't1']]) {
    historyStore.add({ id, projectId, targetId, logFile: historyStore.writeLog(id, 'log') })
  }
  historyStore.add({ id: 'legacy', projectId: 'p1', targetId: undefined })
  historyStore.clear('p1', 't2')
  // 无法归属环境的旧记录在每个环境下都显示，按「看到什么就清什么」随所清环境一并清掉
  assert.deepEqual(historyStore.list('p1').map((r) => r.id).sort(), ['a1', 'a2'], '只清指定环境的记录（含无法归属的旧记录），别的环境保留')
  assert.deepEqual(historyStore.list('p2').map((r) => r.id), ['c1'], '别的项目不受影响')
  assert(!fs.existsSync(path.join(storeRoot, 'deploy-logs', 'b1.log')) && fs.existsSync(path.join(storeRoot, 'deploy-logs', 'a1.log')), '被清记录的日志一并删除，其余保留')
  historyStore.clear('p1')
  assert.deepEqual(historyStore.list('p1'), [], '不带环境时仍清整个项目')

  const old = { projectId: 'project-a', targetId: 'target-a', type: 'deploy', status: 'success', version: '1.0.0', releaseId: '1.0.0-older', logFile: 'fixture.log' }
  pending.shift().resolve([old]); await settle()
  api.rollbackRecord(old)
  assert.deepEqual(emitted.pop(), ['rollback', '1.0.0-older', 'target-a'], '同业务版本的另一个实例应按 releaseId 回滚')
  api.rollbackRecord({ ...old, releaseId: currentVersion })
  assert.equal(emitted.length, 0, '当前发布实例不能重复回滚')
  api.rollbackRecord({ ...old, targetId: 'other-target', releaseId: currentVersion })
  assert.deepEqual(emitted.pop(), ['rollback', currentVersion, 'other-target'], '同名版本在另一个环境仍可回滚')
  api.rollbackRecord({ ...old, releaseId: undefined, version: '0.9.0' })
  assert.deepEqual(emitted.pop(), ['rollback', '0.9.0', 'target-a'], '旧历史仍兼容业务版本目录')

  const log = api.viewLog(old)
  const clearing = api.clearHistory()
  props.projectId = 'project-b'
  assert.deepEqual(api.history.value, [], '切换时立即移除旧历史，不等待服务器响应')
  api.rollbackRecord(old)
  assert.equal(emitted.length, 0, '旧行事件不能回滚新项目')
  readLog('旧项目日志'); confirm(); await Promise.all([log, clearing])
  assert.equal(api.logDialog.value, false)
  assert.equal(api.dialogLog.value, '')
  assert.deepEqual(cleared, [], '旧项目确认框不得清空新项目历史')

  const slowB = pending.shift()
  props.projectId = 'project-a'
  const latestA = pending.shift()
  slowB.resolve([{ projectId: 'project-b' }]); await settle()
  assert.deepEqual(api.history.value, [])
  latestA.resolve([old]); await settle()
  assert.equal(api.history.value[0].projectId, 'project-a')
  const older = api.loadHistory(), oldRequest = pending.shift()
  const newer = api.loadHistory(), newRequest = pending.shift()
  newRequest.resolve([{ ...old, releaseId: 'newest' }]); await newer
  oldRequest.resolve([old]); await older
  assert.equal(api.history.value[0].releaseId, 'newest', '同项目较旧请求不能覆盖最新结果')

  // ── 按环境显示：只留当前环境的记录（无法归属的旧记录除外），切换环境不重新请求 ──
  const envB = { ...old, releaseId: 'env-b', targetId: 'target-b' }
  const legacy = { ...old, releaseId: 'legacy', targetId: undefined }
  const envLoad = api.loadHistory(), envRequest = pending.shift()
  envRequest.resolve([{ ...old, releaseId: 'newest' }, envB, legacy]); await envLoad
  assert.deepEqual(api.history.value.map((r) => r.releaseId), ['newest', 'legacy'], '只显示当前环境的记录，没有环境 id 的旧记录照常显示')
  props.targetId = 'target-b'
  await settle()
  assert.deepEqual(api.history.value.map((r) => r.releaseId), ['env-b', 'legacy'], '切换环境立即按新环境过滤')
  assert.equal(pending.length, 0, '切换环境不重新请求历史')

  // ── 清空只作用于当前环境；确认期间换了环境就放弃 ──
  const clearingB = api.clearHistory()
  props.targetId = 'target-a'; confirm(); await clearingB
  assert.deepEqual(cleared, [], '确认期间切换了环境，不得清空')
  const clearingA = api.clearHistory()
  confirm(); await clearingA
  assert.deepEqual(cleared, [{ projectId: 'project-a', targetId: 'target-a' }], '清空只作用于当前环境')
  pending.length = 0 // 清空后组件会重新加载一次，这里用不到它的结果

  // 未保存的新项目：查的是全部项目的历史，不按环境过滤，清空也不带环境
  props.projectId = ''
  props.targetId = 'draft-target'
  assert.deepEqual(api.history.value, [], '未保存的新项目切换时先清空旧项目的记录')
  const allRequest = pending.shift()
  assert.equal(allRequest.projectId, undefined, '未保存的新项目查询全部项目的历史')
  allRequest.resolve([old, envB]); await settle()
  assert.equal(api.history.value.length, 2, '未保存的新项目显示全部项目、全部环境的记录')
  const clearingAll = api.clearHistory()
  confirm(); await clearingAll
  assert.deepEqual(cleared[1], { projectId: undefined, targetId: '' }, '未保存的新项目清空全部历史，不带环境')

  console.log('PASS 部署历史：实例回滚、旧记录兼容、切项目事件隔离、异步响应与确认框归属、按环境显示与清空')
})().catch((e) => { console.error(e.stack); process.exitCode = 1 }).finally(() => {
  scope.stop()
  if (path.dirname(storeRoot) === fs.realpathSync.native(os.tmpdir()) && path.basename(storeRoot).startsWith('deploy-history-selftest-')) fs.rmSync(storeRoot, { recursive: true, force: true })
})
