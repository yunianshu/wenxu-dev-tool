/** 执行真实历史组件逻辑，验证发布实例回滚及异步项目切换边界。 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vue = require('vue')

const source = fs.readFileSync(path.resolve(__dirname, '../src/components/deploy/DeployHistoryTable.vue'), 'utf8')
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/mg, '')
const props = vue.reactive({ projectId: 'project-a' })
const state = { deploy: { currentVersion: '1.0.0-current' } }
const pending = [], emitted = [], cleared = []
let confirm, readLog
const window = { gitReport: {
  deployHistoryList: (projectId) => new Promise((resolve) => pending.push({ projectId, resolve })),
  deployHistoryReadLog: () => new Promise((resolve) => { readLog = resolve }),
  deployHistoryClear: async (projectId) => { cleared.push(projectId) },
} }
const scope = vue.effectScope()
const setup = new Function('ref', 'computed', 'watch', 'onMounted', 'onUnmounted', 'defineProps', 'defineEmits', 'defineExpose', 'state', 'window', 'ElMessageBox', 'ElMessage', script + '\nreturn { history, rollbackRecord, loadHistory, viewLog, logDialog, dialogLog, clearHistory }')
const api = scope.run(() => setup(vue.ref, vue.computed, vue.watch, () => {}, () => {}, () => props, () => (...args) => emitted.push(args), () => {}, state, window, { confirm: () => new Promise((resolve) => { confirm = resolve }) }, {}))
const settle = async () => { await Promise.resolve(); await vue.nextTick() }

;(async () => {
  const old = { projectId: 'project-a', targetId: 'target-a', type: 'deploy', status: 'success', version: '1.0.0', releaseId: '1.0.0-older', logFile: 'fixture.log' }
  pending.shift().resolve([old]); await settle()
  api.rollbackRecord(old)
  assert.deepEqual(emitted.pop(), ['rollback', '1.0.0-older', 'target-a'], '同业务版本的另一个实例应按 releaseId 回滚')
  api.rollbackRecord({ ...old, releaseId: state.deploy.currentVersion })
  assert.equal(emitted.length, 0, '当前发布实例不能重复回滚')
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
  console.log('PASS 部署历史：实例回滚、旧记录兼容、切项目事件隔离、异步响应与确认框归属')
})().catch((e) => { console.error(e.stack); process.exitCode = 1 }).finally(() => scope.stop())
