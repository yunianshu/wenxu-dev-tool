/** 真实项目存储与发布编排：共享服务器不共享数据库、健康检查和数据同步策略。 */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { Writable } = require('stream')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-project-policy-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => path.join(root, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false },
} }
const projects = require('../electron/deploy/deploy-projects')
const auto = require('../electron/deploy/auto-deploy')
const ssh = require('../electron/deploy/ssh-service')
const remote = new Map(), commands = [], connections = [], timeline = []
let prepareCalls = 0, failDataSync = false
ssh.connect = async (config) => {
  connections.push({ host: config.host, port: config.port })
  return { sftp: (cb) => cb(null, { end() {}, createWriteStream(file, options) {
    assert.equal(options.mode, 0o600)
    const chunks = []
    return new Writable({ write(chunk, _, done) { chunks.push(chunk); done() }, final(done) { remote.set(file, Buffer.concat(chunks)); timeline.push({ kind: 'text', file }); done() } })
  } }) }
}
ssh.close = () => {}
ssh.mkdirp = async () => {}
ssh.upload = async (_, local, target) => { remote.set(target, fs.readFileSync(local)); timeline.push({ kind: 'upload', file: target }) }
ssh.exec = async (_, command, onLine) => {
  commands.push(command)
  timeline.push({ kind: 'exec', command })
  if (command.includes('__DATA_SYNC_PATH_OK__')) return { code: 0, stdout: '__DATA_SYNC_PATH_OK__\n' }
  if (command.startsWith('sha256sum')) {
    const file = command.match(/^sha256sum '([^']+)'/)[1]
    assert(remote.has(file))
    return { code: 0, stdout: crypto.createHash('sha256').update(remote.get(file)).digest('hex') }
  }
  if (command.includes('/deploy.sh') && command.startsWith('bash ')) {
    const prestart = command.includes('--data-sync-script')
    if (prestart && failDataSync) {
      const output = '__STAGE__:backup-db\n__STAGE__:build\n__STAGE__:datasync\n__DEPLOY_FAIL__:启动前数据同步失败（旧版本保持运行）\n'
      onLine?.(output)
      return { code: 1, stdout: output }
    }
    const output = '__STAGE__:backup-db\n__STAGE__:build\n' + (prestart ? '__STAGE__:datasync\n__STAGE_OK__:datasync\n' : '') + '__STAGE__:start\n__STAGE__:health\n__DEPLOY_OK__:1.0.0\n'
    onLine?.(output)
    timeline.push({ kind: 'health-success' })
    return { code: 0, stdout: output }
  }
  if (command.includes('__DATA_SYNC_OK__')) return { code: 0, stdout: '__DATA_SYNC_OK__\n' }
  return { code: 0, stdout: '', stderr: '' }
}
auto.prepare = async (project, target) => {
  prepareCalls++
  return {
  remotePath: `/home/test/apps/${project.name}`, sudo: false, port: project.name === 'project-a' ? 21001 : 21002,
  health: { enabled: true, url: `http://127.0.0.1/${project.name}/automatic-health`, timeout: 180, interval: 3 },
  db: { enabled: true, type: 'postgres', service: `${project.name}-automatic-db`, name: '', user: '', reason: '测试数据库识别' },
  recipe: { compose: 'services: {}' }, files: [{ path: auto.COMPOSE, content: 'services:\n  app:\n    image: node:22-alpine\n' }],
  exclude: auto.privateFile, redact: (text) => text, syncBeforeStart: target.dataSync?.enabled === true,
  }
}
const service = require('../electron/deploy/deploy-service')
const load = (id) => projects.list().find((p) => p.id === id)
const deploymentCommand = (list) => list.find((command) => command.includes('/deploy.sh') && command.startsWith('bash '))

function assertPrestartSync(events, name) {
  const deployIndex = events.findIndex((e) => e.kind === 'exec' && deploymentCommand([e.command]))
  const uploaded = events.filter((e) => e.kind === 'upload' && /-data-.*\.zip$/.test(e.file))
  assert.equal(uploaded.length, 1, '数据 ZIP 只能上传一次')
  assert(events.indexOf(uploaded[0]) < deployIndex, '数据包需要在远端发布脚本前上传')
  const checksums = events.filter((e) => e.kind === 'exec' && e.command.startsWith('sha256sum ') && e.command.includes(uploaded[0].file))
  assert.equal(checksums.length, 1)
  assert(events.indexOf(checksums[0]) < deployIndex, '数据包在启动前执行前必须校验')
  const script = `/home/test/apps/${name}/deployer/data-sync.sh`
  const scriptUpload = events.findIndex((e) => e.kind === 'text' && e.file === script)
  assert(scriptUpload >= 0 && scriptUpload < deployIndex)
  assert(remote.get(script).toString().includes('__DATA_SYNC_OK__'), '上传完整的安全解压脚本')
  assert(events[deployIndex].command.includes(`'--data-sync-script' '${script}'`))
  assert(!events.some((e) => e.kind === 'exec' && e.command.includes('__DATA_SYNC_OK__')), '健康检查后不能再次执行数据解压')
}

function seed(name, serverId, sync) {
  const project = projects.defaultProject()
  project.name = name; project.localPath = path.join(root, name)
  fs.mkdirSync(path.join(project.localPath, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(project.localPath, 'VERSION'), '1.0.0')
  fs.writeFileSync(path.join(project.localPath, 'assets/items.json'), JSON.stringify({ project: name }))
  Object.assign(project.targets[0], {
    serverId,
    health: { strategy: 'manual', enabled: true, url: `http://127.0.0.1/${name}/manual-health`, timeout: 47, interval: 2 },
    db: { strategy: 'manual', enabled: true, type: 'postgres', container: `${name}-manual-db`, name: `${name.replace(/-/g, '_')}_data`, user: `${name.replace(/-/g, '_')}_user` },
    dataSync: { enabled: sync, localDir: 'assets', remoteDir: `shared/${name}-assets`, importMode: 'none' },
  })
  assert(projects.save(project).ok)
  return project.id
}

;(async () => {
  const server = projects.saveServer({ name: '共享服务器', host: 'shared.example.invalid', port: 22, username: 'root' })
  assert(server.ok)
  const a = seed('project-a', server.id, true), b = seed('project-b', server.id, false)
  for (const [id, name, sync] of [[a, 'project-a', true], [b, 'project-b', false]]) {
    const before = load(id).targets[0], start = commands.length, eventStart = timeline.length
    const result = await service.run(id, before.id)
    assert.equal(result.status, 'success', result.message)
    const target = load(id).targets[0]
    assert.deepEqual(target.db, before.db)
    assert.deepEqual(target.health, before.health)
    assert.deepEqual(target.dataSync, before.dataSync)
    assert.equal(target.autoDb.service, `${name}-automatic-db`)
    assert.equal(target.autoHealth.url, `http://127.0.0.1/${name}/automatic-health`)
    const runCommands = commands.slice(start), command = deploymentCommand(runCommands)
    assert(command.includes(`'--db-container' '${name}-manual-db'`))
    assert(!command.includes('--db-service'))
    assert(command.includes(`'--health-url' 'http://127.0.0.1/${name}/manual-health'`))
    assert.equal(runCommands.some((x) => x.includes('__DATA_SYNC_PATH_OK__')), sync)
    assert.equal(runCommands.some((x) => x.includes('__DATA_SYNC_OK__')), false, '已声明启动前同步，客户端不得在健康后再执行解压')
    if (sync) assertPrestartSync(timeline.slice(eventStart), name)
    else assert(!command.includes('--data-sync-script'))
    assert.equal(result.stages.datasync.status, sync ? 'success' : 'skipped')
    assert(!JSON.stringify(load(id)).includes('dataSyncScript'), '临时同步脚本仅通过 pack 参数传递，不应落入项目配置')
  }
  assert(connections.every((c) => c.host === 'shared.example.invalid'))
  assert.notEqual(load(a).targets[0].remotePath, load(b).targets[0].remotePath)

  const withImport = load(a)
  withImport.targets[0].dataSync.importMode = 'command'
  withImport.targets[0].dataSync.importCommand = "printf '__IMPORT_DONE__'"
  assert(projects.save(withImport).ok)
  let eventStart = timeline.length
  let importResult = await service.run(a, withImport.targets[0].id)
  assert.equal(importResult.status, 'success', importResult.message)
  let events = timeline.slice(eventStart)
  assertPrestartSync(events, 'project-a')
  const imports = events.filter((e) => e.kind === 'exec' && e.command.includes('__IMPORT_DONE__'))
  assert.equal(imports.length, 1, '启动前已同步仍需在健康后执行导入钩子一次')
  assert(events.indexOf(imports[0]) > events.findIndex((e) => e.kind === 'health-success'))

  failDataSync = true
  const beforePrepare = prepareCalls
  eventStart = timeline.length
  const failed = await service.run(a, withImport.targets[0].id)
  failDataSync = false
  assert.equal(failed.status, 'failed')
  assert.equal(failed.stages.datasync.status, 'failed')
  assert.equal(prepareCalls, beforePrepare + 1, '启动前数据同步失败不能当作构建失败再次调用 AI prepare')
  events = timeline.slice(eventStart)
  assert.equal(events.filter((e) => e.kind === 'exec' && deploymentCommand([e.command])).length, 1)
  assert(!events.some((e) => e.kind === 'exec' && e.command.includes('__IMPORT_DONE__')), '同步失败不能执行导入钩子')

  let project = load(b), target = project.targets[0]
  target.db.strategy = 'auto'; target.health.strategy = 'auto'
  assert(projects.save(project).ok)
  let start = commands.length
  let result = await service.run(b, target.id)
  assert.equal(result.status, 'success', result.message)
  let command = deploymentCommand(commands.slice(start))
  assert(command.includes("'--db-service' 'project-b-automatic-db'"))
  assert(!command.includes('--db-container'))
  assert(command.includes("'--health-url' 'http://127.0.0.1/project-b/automatic-health'"))
  assert.equal(load(b).targets[0].db.container, 'project-b-manual-db', '自动探测不能覆盖手动配置内容')
  assert.equal(load(b).targets[0].health.url, 'http://127.0.0.1/project-b/manual-health')

  project = load(b); target = project.targets[0]
  target.db.strategy = 'off'; target.health.strategy = 'manual'; target.health.enabled = false
  assert(projects.save(project).ok)
  start = commands.length
  result = await service.run(b, target.id)
  assert.equal(result.status, 'success', result.message)
  command = deploymentCommand(commands.slice(start))
  assert(command.includes('--no-backup-db') && !command.includes('--db-service') && !command.includes('--db-container'))
  assert(command.includes('--no-health') && !command.includes('--health-url'))

  const anotherServer = projects.saveServer({ name: '替换服务器', host: 'another.example.invalid', port: 22, username: 'root' })
  const before = load(a).targets[0]
  project = load(a); project.targets[0].serverId = anotherServer.id
  assert(projects.save(project).ok)
  target = load(a).targets[0]
  assert(!target.autoDb && !target.autoHealth && !target.autoSudo)
  assert.equal(target.remotePath, '')
  assert.deepEqual(target.db, before.db)
  assert.deepEqual(target.health, before.health)
  assert.deepEqual(target.dataSync, before.dataSync)
  assert.equal(load(b).targets[0].serverId, server.id, '切换 A 服务器不能影响共享原服务器的 B')
  console.log('PASS 项目发布策略：共享服务器配置独立、手动/自动/关闭优先级、自动模式数据同步、切换服务器仅重置探测结果')
})().catch((e) => { console.error(e.stack); process.exitCode = 1 }).finally(() => {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-project-policy-')) fs.rmSync(root, { recursive: true, force: true })
})
