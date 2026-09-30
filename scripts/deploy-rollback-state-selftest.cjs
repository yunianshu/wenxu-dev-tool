/** SSH 替身验证连接期互斥、取消、失败结果及历史服务器脚本更新。 */
const assert = require('assert/strict'), fs = require('fs'), path = require('path'), Module = require('module')
const { EventEmitter } = require('events')
const vm = require('vm')
const filename = path.resolve(__dirname, '../electron/deploy/deploy-service.js')
const project = { id: 'fixture', name: '隔离项目', deployMode: 'script', targets: [{ id: 't', name: '测试', server: { host: 'fixture.invalid' }, remotePath: '/fixture', health: { enabled: false } }] }
let connect, commands = [], uploaded = [], records = [], events = [], executionFailed = false
const ssh = {
  connect: () => new Promise((resolve, reject) => { connect = { resolve, reject } }),
  close: conn => { if (conn) conn.closed = true },
  mkdirp: async () => {}, remoteJoin: (...parts) => parts.join('/'),
  exec: async (conn, command, onLine) => {
    assert.equal(conn.closed, false)
    commands.push(command)
    if (!onLine) return { code: 0, stdout: 'stable\n' }
    onLine('__STAGE__:start\n__STAGE__:health\n' + (executionFailed ? '__DEPLOY_FAIL__:目标健康失败（已自动回滚到 stable）\n' : '__DEPLOY_OK__:target\n'))
    return { code: executionFailed ? 1 : 0, stdout: '' }
  },
}
function connection() {
  return { closed: false, sftp: cb => cb(null, { end() {}, createWriteStream(remote) {
    const stream = new EventEmitter()
    stream.end = content => { uploaded.push({ remote, content }); queueMicrotask(() => stream.emit('close')) }
    return stream
  } }) }
}
const mod = new Module(filename, module)
mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename))
mod.require = name => {
  if (name === './ssh-service') return ssh
  if (name === './deploy-projects') return { list: () => [project], getCredentials: () => ({}) }
  if (name === './history') return { writeLog: () => '隔离日志', add: record => records.push(structuredClone(record)) }
  if (name.startsWith('.')) return {}
  return Module.prototype.require.call(mod, name)
}
mod._compile(fs.readFileSync(filename, 'utf8'), filename)
const service = mod.exports
service.setEmitter((channel, payload) => { if (channel === 'deploy:done') events.push(payload.record) })
// 执行真实 IPC 注册函数，验证项目页与部署页都不能绕过正在运行的任务。
const handlers = new Map(), writes = []
const backend = new Proxy({}, { get: (_, name) => () => { writes.push(name); return { ok: true } } })
const mainSource = fs.readFileSync(path.resolve(__dirname, '../electron/main.js'), 'utf8')
const context = { ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, deployService: service, deployProjects: backend, projectService: backend, aiDeploy: backend }
const ipcCases = [
  ['projects:save', { id: 'fixture' }], ['projects:remove', 'fixture'],
  ['deploy:projects:save', {}], ['deploy:projects:copyConfig', {}], ['deploy:projects:remove', 'fixture'],
  ['deploy:ai:apply', { projectId: 'fixture', targetId: 't', plan: {} }],
]
for (const [name] of ipcCases) {
  const start = mainSource.indexOf(`ipcMain.handle('${name}'`)
  assert(start >= 0, name)
  const end = name === 'deploy:ai:apply' ? mainSource.indexOf('\n  })', start) + 5 : mainSource.indexOf('\n', start)
  vm.runInNewContext(mainSource.slice(start, end), context)
}
async function main() {
  let flight = service.rollback('fixture', 'target', 't')
  assert.equal(service.isBusy(), true)
  assert.equal(service.isBusy('fixture'), true)
  assert.equal(service.isBusy('other-project'), false)
  for (const [name, payload] of ipcCases) assert.equal(handlers.get(name)(null, payload).ok, false, name + ' 应拦截运行期写入')
  assert.equal(writes.length, 0)
  assert.equal(handlers.get('projects:save')(null, { id: 'other-project' }).ok, true, '其他项目的基础编辑不受影响')
  await assert.rejects(service.rollback('fixture', 'target', 't'), /已有发布任务/)
  await assert.rejects(service.run('fixture', 't'), /已有发布任务/)
  await assert.rejects(service.restoreDbBackup('fixture', 't', 'db_fixture.sql'), /已有发布任务/)
  connect.resolve(connection())
  assert.equal((await flight).status, 'success')
  assert.equal(service.isBusy(), false)
  for (const [name, payload] of ipcCases) assert.equal(handlers.get(name)(null, payload).ok, true, name + ' 结束后应解锁')
  assert.equal(uploaded.length, 1)
  assert.match(uploaded[0].content, /do_rollback_script/)
  assert.doesNotMatch(uploaded[0].content, /\r/)
  const before = commands.length
  flight = service.rollback('fixture', 'target', 't')
  assert.equal(service.cancel().ok, true)
  const canceled = connection(); connect.resolve(canceled)
  assert.equal((await flight).status, 'canceled')
  assert.equal(canceled.closed, true)
  assert.equal(commands.length, before)
  assert.equal(service.isBusy(), false)
  flight = service.rollback('fixture', 'target', 't')
  connect.reject(new Error('隔离连接失败'))
  assert.equal((await flight).message, '隔离连接失败')
  assert.equal(service.isBusy(), false)
  executionFailed = true
  flight = service.rollback('fixture', 'target', 't'); connect.resolve(connection())
  const failed = await flight
  assert.equal(failed.status, 'failed')
  assert.match(failed.message, /已自动回滚到 stable/)
  assert.equal(failed.oldVersion, 'stable')
  assert.equal(failed.stages.health.status, 'failed')
  assert.equal(uploaded.length, 2, '每次实际回滚都更新服务器脚本')
  assert.equal(events.length, 4)
  assert.equal(records.length, 4)
  assert.equal(service.isBusy(), false)
  console.log('通过：连接期互斥、真实 IPC 写入门禁、取消零写入、连接失败解锁、失败详情、阶段及脚本更新')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
