/** 自动发布数据消费：真实方案解析，SSH/AI 只用隔离桩，不读取或发送真实业务数据。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parse, stringify } = require('yaml')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-auto-data-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => path.join(root, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false },
} }
const auto = require('../electron/deploy/auto-deploy')
const ssh = require('../electron/deploy/ssh-service')
const ai = require('../electron/ai-service')
const store = require('../electron/store')
const marker = 'BUSINESS_CONTENT_MUST_NEVER_BE_READ_OR_SENT'
let aiEnabled = false, execs = [], writes = [], mkdirs = []
store.load = () => ({ ai: aiEnabled ? { model: 'isolated-test', baseUrl: 'https://example.invalid' } : {} })
store.getApiKey = () => aiEnabled ? 'test-only' : ''
ssh.mkdirp = async (_conn, directory) => { mkdirs.push(directory) }
ssh.exec = async (_conn, command) => {
  execs.push(command)
  if (command === 'printf "%s" "$HOME"') return { code: 0, stdout: '/home/review' }
  if (command.includes('__DATA_SYNC_PATH_OK__')) return { code: 0, stdout: '__DATA_SYNC_PATH_OK__' }
  if (command.includes('/prepare.sh')) return { code: 0, stdout: '环境已就绪' }
  if (command.startsWith('for p in')) return { code: 0, stdout: '25123' }
  return { code: 0, stdout: '', stderr: '' }
}
function fixture(name, { directory = 'data', volumes, compose = true, importCommand = '' } = {}) {
  const localPath = path.join(root, name)
  fs.mkdirSync(path.join(localPath, directory, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(localPath, directory, 'payload.json'), JSON.stringify({ value: marker }))
  fs.writeFileSync(path.join(localPath, directory, 'README.md'), marker)
  fs.writeFileSync(path.join(localPath, directory, 'package.json'), JSON.stringify({ version: '9.9.9', description: marker }))
  fs.writeFileSync(path.join(localPath, directory, 'docker-compose.yml'), marker)
  fs.writeFileSync(path.join(localPath, 'server.js'), 'const dataPath = "/app/catalog";')
  const target = { id: 'production', server: { host: 'same-server.example.invalid' }, dataSync: {
    enabled: true, localDir: directory, remoteDir: 'shared/' + name, importMode: importCommand ? 'command' : 'none', importCommand,
  } }
  const project = { id: name, name, localPath, productionTargetId: target.id, targets: [target] }
  if (compose) fs.writeFileSync(path.join(localPath, 'compose.yml'), stringify({ services: { app: {
    image: 'nginx:alpine', ports: ['8080:80'], volumes: volumes === undefined ? [`./${directory}:/app/catalog:ro,z`, { type: 'bind', source: `./${directory}/nested`, target: '/app/nested', read_only: false }] : volumes,
  } } }))
  return { project, target }
}
async function prepare(fixture) {
  return auto.prepare(fixture.project, fixture.target, { conn: {}, releaseId: '1.0.0-test', log() {},
    uploadText: async (_conn, text, file) => { writes.push({ file, text }) },
  })
}
let passed = 0
async function test(name, run) {
  execs = []; writes = []; mkdirs = []; aiEnabled = false
  await run(); passed++; console.log('  ✓ ' + name)
}
async function main() {
  await test('目录绑定保持容器目标与读写语义，改绑项目专属共享目录并预先创建', async () => {
    const one = fixture('project-a')
    const prepared = await prepare(one)
    assert.strictEqual(prepared.syncBeforeStart, true, '容器直接挂载的数据必须在启动前同步')
    const doc = parse(prepared.files.find((file) => file.path === auto.COMPOSE).content)
    assert.strictEqual(doc.services.app.volumes[0].type, 'bind')
    assert.strictEqual(doc.services.app.volumes[0].source, `${prepared.remotePath}/shared/project-a`)
    assert.strictEqual(doc.services.app.volumes[0].target, '/app/catalog')
    assert.strictEqual(doc.services.app.volumes[0].read_only, true)
    assert.strictEqual(doc.services.app.volumes[0].bind.selinux, 'z')
    assert.strictEqual(doc.services.app.volumes[0].bind.create_host_path, false)
    assert.strictEqual(doc.services.app.volumes[1].source, `${prepared.remotePath}/shared/project-a/nested`)
    assert.strictEqual(doc.services.app.volumes[1].read_only, false)
    assert.ok(mkdirs.includes(doc.services.app.volumes[0].source) && mkdirs.includes(doc.services.app.volumes[1].source))
    assert.ok(prepared.exclude('data/payload.json'), '业务数据走单独同步，不混入代码构建快照')
    assert.ok(!prepared.exclude('server.js'))
    const next = await prepare(one)
    assert.strictEqual(parse(next.files.find((file) => file.path === auto.COMPOSE).content).services.app.volumes[0].source, doc.services.app.volumes[0].source, '缓存重用仍指向稳定共享目录')
  })
  await test('同服务器的另一项目使用另一目录；关闭同步不沿用 A 配置', async () => {
    const a = fixture('isolation-a'), b = fixture('isolation-b')
    const first = await prepare(a), second = await prepare(b)
    const source = (prepared) => {
      const volume = parse(prepared.files.find((file) => file.path === auto.COMPOSE).content).services.app.volumes[0]
      return typeof volume === 'string' ? volume.split(':')[0] : volume.source
    }
    assert.notStrictEqual(first.remotePath, second.remotePath)
    assert.notStrictEqual(source(first), source(second))
    b.target.dataSync.enabled = false
    const third = await prepare(b)
    assert.strictEqual(third.syncBeforeStart, false)
    assert.ok(!source(third).startsWith('/home/review/'), '关闭 B 的同步后不得应用 A 或上次 B 的远端数据绑定')
  })
  await test('无可识别的数据用途且无导入钩子，任何 SSH 操作前明确失败', async () => {
    const project = fixture('missing-purpose', { volumes: ['runtime:/runtime'] })
    await assert.rejects(() => prepare(project), /没有把该目录挂载到业务容器.*导入命令/)
    assert.strictEqual(execs.length, 0)
    assert.strictEqual(writes.length, 0)
    assert.strictEqual(mkdirs.length, 0)
  })
  await test('明确配置导入钩子的项目允许无直接挂载，仍创建独立同步目录', async () => {
    const project = fixture('with-import', { volumes: [], importCommand: 'bash import.sh {dataDir}' })
    const prepared = await prepare(project)
    assert.strictEqual(prepared.syncBeforeStart, false, '仅应用导入的数据在服务健康后处理')
    assert.ok(mkdirs.includes(`${prepared.remotePath}/shared/with-import`))
    assert.deepStrictEqual(parse(prepared.files.find((file) => file.path === auto.COMPOSE).content).services.app.volumes, [])
  })
  await test('子目录 Compose 的长格式相对 bind 按原文件位置解析', async () => {
    const project = fixture('nested-compose', { compose: false })
    fs.mkdirSync(path.join(project.project.localPath, 'deploy'))
    fs.writeFileSync(path.join(project.project.localPath, 'deploy/compose.yml'), stringify({ services: { app: {
      image: 'nginx:alpine', ports: ['8080:80'], volumes: [{ type: 'bind', source: '../data', target: '/app/catalog', read_only: true }],
    } } }))
    project.project.composeFile = 'deploy/compose.yml'
    const prepared = await prepare(project)
    assert.strictEqual(parse(prepared.files.find((file) => file.path === auto.COMPOSE).content).services.app.volumes[0].source, `${prepared.remotePath}/shared/nested-compose`)
  })
  await test('AI 获得同步用途元数据，自动扫描和 AI 补读均不读取业务文件内容', async () => {
    const project = fixture('ai-mount', { directory: 'deploy', compose: false })
    project.project.composeFile = 'deploy/docker-compose.yml'
    const originalRead = fs.readFileSync
    const protectedDirectory = path.resolve(project.project.localPath, 'deploy') + path.sep
    let reads = 0, calls = 0
    fs.readFileSync = function (file, ...args) {
      if (typeof file === 'string' && path.resolve(file).startsWith(protectedDirectory)) { reads++; throw new Error('不得读取业务数据') }
      return originalRead.call(this, file, ...args)
    }
    aiEnabled = true
    ai.complete = async ({ messages }) => {
      calls++
      const prompt = JSON.stringify(messages)
      assert.ok(!prompt.includes(marker))
      assert.ok(prompt.includes('shared/ai-mount') && prompt.includes('localDir'))
      if (calls === 1) return { text: JSON.stringify({ readFiles: ['deploy/payload.json', 'deploy/README.md', 'deploy/package.json'] }), finishReason: 'stop' }
      assert.ok(prompt.includes('文件不属于可发送的部署证据'))
      return { text: JSON.stringify({ compose: stringify({ services: { app: { image: 'nginx:alpine', volumes: ['./deploy:/app/catalog:ro'] } } }), publicService: 'app', publicPort: 80, files: [] }), finishReason: 'stop' }
    }
    try {
      const prepared = await prepare(project)
      assert.strictEqual(calls, 2)
      assert.strictEqual(reads, 0, '扫描阶段也不应尝试读取，只禁止发送不够')
      assert.strictEqual(parse(prepared.files.find((file) => file.path === auto.COMPOSE).content).services.app.volumes[0].source, `${prepared.remotePath}/shared/ai-mount`)
    } finally { fs.readFileSync = originalRead; aiEnabled = false }
  })
  console.log(`\n自动数据消费回归通过（${passed} 组；未连接真实 AI/服务器）`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-auto-data-')) fs.rmSync(root, { recursive: true, force: true })
})
