/** 使用真实项目配置、打包和历史，替换 SSH 以验证多项目同时提交。 */
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Writable } = require('node:stream')
const { setTimeout: delay } = require('node:timers/promises')

const tempDir = path.resolve(os.tmpdir())
const fixtureDir = fs.mkdtempSync(path.join(tempDir, 'deploy-multi-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { loaded: true, exports: { app: { getPath: () => fixtureDir }, safeStorage: { isEncryptionAvailable: () => false } } }
const projects = require('../electron/deploy/deploy-projects')
const service = require('../electron/deploy/deploy-service')
const history = require('../electron/deploy/history')
const ssh = require('../electron/deploy/ssh-service')

const connections = []
const deployments = new Map()
const events = []
service.setEmitter((channel, payload) => events.push({ channel, ...payload }))
ssh.connect = async ({ host }) => {
  connections.push(host)
  return { host, sftp: (callback) => callback(null, {
    end() {}, createWriteStream: () => new Writable({ write(_chunk, _encoding, done) { done() } }),
  }) }
}
ssh.close = (conn) => { conn?.interrupt?.(new Error('SSH 已断开')) }
ssh.mkdirp = async () => {}
ssh.upload = async (conn, zipPath, _remotePath, progress) => {
  conn.zipPath = zipPath
  conn.sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
  progress?.(7, 10)
}
ssh.exec = async (conn, command, onLine) => {
  if (command.startsWith('sha256sum ')) return { code: 0, stdout: conn.sha256 }
  if (!onLine) return { code: 0, stdout: '' }
  const title = `来自 ${conn.host} 的发布日志`
  onLine(`__STAGE__:start\n${title}\n`)
  return new Promise((resolve, reject) => {
    conn.interrupt = reject
    deployments.set(conn.host, {
      zipPath: conn.zipPath,
      finish(ok) {
        onLine(ok ? '__DEPLOY_OK__:完成\n' : '__DEPLOY_FAIL__:模拟失败\n')
        resolve({ code: ok ? 0 : 1, stdout: '' })
      },
    })
  })
}

function fixture(id, host, directory = id) {
  const project = projects.defaultProject()
  Object.assign(project, { id, name: '同名项目', localPath: path.join(fixtureDir, directory), configMode: 'manual', deployMode: 'docker' })
  fs.mkdirSync(project.localPath, { recursive: true })
  fs.writeFileSync(path.join(project.localPath, 'VERSION'), '1.0.0\n')
  fs.writeFileSync(path.join(project.localPath, 'docker-compose.yml'), 'services: {}\n')
  Object.assign(project.targets[0], { name: `${id} 环境`, remotePath: `/srv/${id}` })
  project.targets[0].server.host = host
  assert.equal(projects.save(project).ok, true)
  return { id, host, targetId: project.targets[0].id }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, '等待部署测试事件超时：' + events.filter((event) => event.record).map((event) => event.record.message).join('；'))
    await delay(10)
  }
}

async function main() {
  const first = fixture('multi-a', 'a.invalid')
  const parallel = fixture('multi-b', 'b.invalid')
  const sameHost = fixture('multi-c', first.host)
  const canceled = fixture('multi-d', first.host)
  const sameWorkspace = fixture('multi-e', 'e.invalid', parallel.id)
  const start = ({ id, targetId }) => service.run(id, targetId, `request-${id}`)
  const a = start(first)
  const b = start(parallel)
  const c = start(sameHost)
  const d = start(canceled)
  const e = start(sameWorkspace)
  await waitFor(() => deployments.has(first.host) && deployments.has(parallel.host))

  assert.equal(fs.existsSync(deployments.get(first.host).zipPath), true)
  assert.equal(fs.existsSync(deployments.get(parallel.host).zipPath), true)
  assert.notEqual(deployments.get(first.host).zipPath, deployments.get(parallel.host).zipPath)
  assert.deepEqual([...connections].sort(), [first.host, parallel.host])
  assert.equal(service.cancel().ok, false, '多个任务时必须明确取消对象')
  await assert.rejects(start(first), /该项目已有发布任务/)
  await assert.rejects(start(sameHost), /该项目已有发布任务/)
  const statusOf = (projectId) => events.filter((event) => event.projectId === projectId && event.channel === 'deploy:status')
  assert.deepEqual(statusOf(sameHost.id).map(({ queued }) => queued), [true])
  assert.deepEqual(statusOf(sameWorkspace.id).map(({ queued }) => queued), [true])
  assert.equal(service.cancel(canceled.id, '过期任务').ok, false)
  assert.equal(service.cancel(canceled.id, statusOf(canceled.id)[0].runId).ok, true)
  assert.equal((await d).status, 'canceled')
  assert.equal(connections.filter((host) => host === first.host).length, 1)

  deployments.get(parallel.host).finish(false)
  assert.equal((await b).status, 'failed')
  await waitFor(() => deployments.has(sameWorkspace.host))
  deployments.get(sameWorkspace.host).finish(true)
  assert.equal((await e).status, 'success')
  assert.equal(service.isBusy(first.id), true, '其他项目完成不得释放本项目')

  deployments.delete(first.host)
  assert.equal(service.cancel(first.id, statusOf(first.id)[0].runId).ok, true)
  assert.equal((await a).status, 'canceled')
  await waitFor(() => deployments.has(sameHost.host))
  deployments.get(sameHost.host).finish(true)
  assert.equal((await c).status, 'success')
  assert.equal(service.isBusy(), false)
  assert.deepEqual(statusOf(sameHost.id).map(({ queued }) => queued), [true, false])

  for (const project of [first, parallel, sameHost, canceled, sameWorkspace]) {
    const [record] = history.list(project.id)
    assert.ok(record)
    const ownEvents = events.filter((event) => event.projectId === project.id)
    assert.ok(ownEvents.every((event) => event.runId === record.id && event.targetId === project.targetId && event.requestId === `request-${project.id}`))
    assert.equal(ownEvents.filter((event) => event.channel === 'deploy:done').length, 1)
    const log = history.readLog(record.logFile)
    if (project !== canceled) {
      assert.ok(ownEvents.some((event) => event.channel === 'deploy:progress' && event.percent === 70))
      assert.deepEqual(log.split('\n').filter((line) => line.includes('的发布日志')).map((line) => line.split('] ')[1]), [`来自 ${project.host} 的发布日志`])
    } else assert.equal(log, '')
  }
  console.log('通过：实际发布打包并发、共享服务器与目录排队、定向取消、失败后续跑、进度与历史隔离')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  assert.equal(path.dirname(fs.realpathSync(fixtureDir)), fs.realpathSync(tempDir))
  fs.rmSync(fixtureDir, { recursive: true, force: true })
})
