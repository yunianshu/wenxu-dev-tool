/** 共享服务器的迁移、引用、凭据与隔离回归；全部使用临时数据，无远端操作。 */
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-servers-'))
const electron = require.resolve('electron')
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => root } } }
const store = require('../electron/store')
store.encryptText = s => ({ fixture: Buffer.from(s).toString('base64') })
store.decryptText = s => s?.fixture ? Buffer.from(s.fixture, 'base64').toString() : ''
const projects = require('../electron/deploy/deploy-projects')
const identity = require('../electron/deploy/auto-deploy').identity
const file = path.join(root, 'deploy-projects.json')
let passed = 0
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name) }
try {
  const connection = { host: 'example.invalid', port: 22, username: 'root', authType: 'password', secret: store.encryptText('fixture-old-password') }
  const old = ['a', 'b'].map(id => ({ id, name: id, deployMode: 'auto', targets: [{ id: 't-' + id, server: connection, remotePath: '/apps/' + id, dataSync: { importSecret: store.encryptText('import-' + id) } }] }))
  fs.writeFileSync(file, JSON.stringify({ projects: old }))
  let a, b, serverId
  test('旧连接合并为共享服务器，目录/目标ID/凭据保留且迁移幂等', () => {
    [a, b] = projects.list(); serverId = a.targets[0].serverId
    assert.equal(b.targets[0].serverId, serverId)
    assert.equal(projects.listServers().length, 1)
    assert.equal(a.targets[0].id, 't-a'); assert.equal(a.targets[0].remotePath, '/apps/a')
    assert.equal(b.targets[0].remotePath, '/apps/b')
    assert.equal(projects.getCredentials('b', 't-b').password, 'fixture-old-password')
    assert.equal(projects.getDataSyncCredentials('a', 't-a'), 'import-a')
    const raw = JSON.parse(fs.readFileSync(file)); assert(!raw.projects[0].targets[0].server)
    assert.deepStrictEqual(raw.servers[0].secret, connection.secret)
    projects.list(); assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(raw, null, 2))
    assert(!JSON.stringify(projects.listServers()).includes('fixture-old-password'))
    assert(!JSON.stringify(projects.list()).includes('fixture-old-password'))
  })
  test('全局编辑同步全部引用，旧项目快照不能覆盖新口令', () => {
    const saved = projects.saveServer({ ...projects.listServers()[0], name: '正式服务器', host: 'prod.example.invalid', secret: 'fixture-new-password' })
    assert(saved.ok)
    a.targets[0].server.secret = 'stale-password'; projects.save(a)
    for (const p of projects.list()) {
      assert.equal(p.targets[0].server.host, 'prod.example.invalid')
      assert.equal(projects.getCredentials(p.id).password, 'fixture-new-password')
    }
    assert.equal(projects.list().find(p => p.id === 'a').targets[0].remotePath, '/apps/a')
    assert.notEqual(identity(a, 't-a'), identity(b, 't-b'))
  })
  test('同一服务器可被新项目引用，项目间目录保持隔离', () => {
    const p = projects.defaultProject(); p.name = '第三项目'; p.targets[0].serverId = serverId
    assert(projects.save(p).ok)
    assert.equal(projects.listServers().length, 1)
    assert.equal(projects.listServers()[0].projects.length, 3)
    assert.equal(projects.list().find(x => x.id === p.id).targets[0].remotePath, '')
    assert.equal(projects.getCredentials(p.id).password, 'fixture-new-password')
  })
  test('引用中禁止删除，未知引用拒绝保存，解除关联不复制凭据', () => {
    assert.equal(projects.removeServer(serverId).ok, false)
    const p = projects.list().find(x => x.id === 'a')
    p.targets[0].serverId = 'missing'
    assert.equal(projects.save(p).ok, false)
    p.targets[0].serverId = ''; p.targets[0].server = { host: '' }
    assert(projects.save(p).ok)
    assert.equal(projects.getCredentials('a').password, '')
  })
  test('新服务器可选择、切换清除自动部署运行状态，未引用可删除', () => {
    const s = projects.saveServer({ name: '备用', host: 'other.invalid', secret: 'other-fixture' })
    const p = projects.list().find(x => x.id === 'b'); p.targets[0].serverId = s.id
    assert(projects.save(p).ok)
    assert.equal(projects.list().find(x => x.id === 'b').targets[0].remotePath, '')
    assert.equal(projects.getCredentials('b').password, 'other-fixture')
    const unused = projects.saveServer({ host: 'unused.invalid' }); assert(projects.removeServer(unused.id).ok)
  })
  test('同地址不同凭据迁移不能丢弃冲突配置', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: old.map((p, i) => ({ ...p, targets: [{ ...p.targets[0], server: { ...connection, secret: store.encryptText('different-' + i) } }] })) }))
    assert.equal(projects.listServers().length, 2)
    assert.equal(projects.getCredentials('a').password, 'different-0'); assert.equal(projects.getCredentials('b').password, 'different-1')
  })
  test('未配置服务器的旧项目也固定目标 ID，不因管理服务器改变表单身份', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'empty', name: '未配置项目' }] }))
    const targetId = projects.list()[0].targets[0].id
    projects.saveServer({ host: 'new.invalid' })
    assert.equal(projects.list()[0].targets[0].id, targetId)
  })
  console.log(`共享服务器自测通过（${passed} 组断言）`)
} finally {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-servers-')) fs.rmSync(root, { recursive: true, force: true })
}
