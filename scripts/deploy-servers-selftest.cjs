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
function assertRuntimeCleared(target) {
  assert.equal(target.remotePath, '')
  for (const key of ['autoSudo', 'autoHealth', 'autoDb']) assert(!Object.hasOwn(target, key), key + ' 必须失效')
}
function withRuntime(target, suffix) {
  return { ...target, remotePath: '/apps/' + suffix, autoSudo: true, autoHealth: { enabled: true, url: 'http://127.0.0.1:21000/health' }, autoDb: { enabled: true, type: 'postgres', service: 'db' } }
}
try {
  const connection = { host: 'example.invalid', port: 22, username: 'root', authType: 'password', secret: store.encryptText('fixture-old-password') }
  const old = ['a', 'b'].map(id => ({ id, name: id, deployMode: 'auto', targets: [withRuntime({ id: 't-' + id, server: connection, health: { enabled: false, url: 'http://custom.invalid/health' }, db: { strategy: 'manual', enabled: true, container: 'custom-db', name: 'custom', user: 'operator' }, dataSync: { enabled: true, localDir: 'custom-data', importSecret: store.encryptText('import-' + id) } }, id)] }))
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
  test('旧健康检查显式关闭保持手动关闭，新项目与显式自动策略不受影响', () => {
    const variants = [
      [{ enabled: false }, 'manual', false],
      [{ enabled: true }, 'auto', true],
      [undefined, 'auto', true],
      [{ strategy: 'auto', enabled: false }, 'auto', false],
      [{ strategy: 'manual', enabled: true }, 'manual', true],
    ]
    for (const [health, strategy, enabled] of variants) {
      for (const source of [{ health }, { targets: [{ health }] }]) {
        const normalized = projects.normalizeProject({ deployMode: 'auto', ...source })
        assert.equal(normalized.targets[0].health.strategy, strategy)
        assert.equal(normalized.targets[0].health.enabled, enabled)
        assert.deepStrictEqual(projects.normalizeProject(normalized).targets[0].health, normalized.targets[0].health)
      }
    }
    assert.equal(a.targets[0].health.strategy, 'manual')
    assert.equal(a.targets[0].health.enabled, false)
    assert(projects.save(a).ok)
    assert.equal(JSON.parse(fs.readFileSync(file)).projects[0].targets[0].health.strategy, 'manual')
  })
  test('全局编辑地址使全部自动目标探测失效，旧快照不能恢复运行状态或覆盖新口令', () => {
    const saved = projects.saveServer({ ...projects.listServers()[0], name: '正式服务器', host: 'prod.example.invalid', secret: 'fixture-new-password' })
    assert(saved.ok)
    for (const p of projects.list()) assertRuntimeCleared(p.targets[0])
    a.targets[0].server.secret = 'stale-password'; projects.save(a)
    for (const p of projects.list()) {
      assert.equal(p.targets[0].server.host, 'prod.example.invalid')
      assert.equal(projects.getCredentials(p.id).password, 'fixture-new-password')
      assertRuntimeCleared(p.targets[0])
      assert.deepStrictEqual(p.targets[0].db, a.targets[0].db)
      assert.deepStrictEqual(p.targets[0].health, a.targets[0].health)
      assert.equal(p.targets[0].dataSync.localDir, 'custom-data')
      assert.equal(projects.getDataSyncCredentials(p.id), 'import-' + p.id)
    }
    assert.notEqual(identity(a, 't-a'), identity(b, 't-b'))
  })
  test('仅名称口令编辑保留探测，端口/账号变更只清所引用服务器的自动目标', () => {
    const second = projects.saveServer({ host: 'isolated.invalid' })
    assert(second.ok)
    for (const [id, mode, selectedServer] of [['manual', 'docker', serverId], ['script', 'script', serverId], ['unrelated', 'auto', second.id]]) {
      const p = projects.defaultProject(); p.id = id; p.deployMode = mode
      p.targets = [withRuntime({ ...p.targets[0], serverId: selectedServer }, id)]
      assert(projects.save(p).ok)
    }
    const reseedAutomatic = () => {
      for (const id of ['a', 'b']) {
        const p = projects.list().find(p => p.id === id)
        p.targets[0] = withRuntime(p.targets[0], id)
        assert(projects.save(p).ok)
      }
    }
    reseedAutomatic()
    const before = projects.list()
    assert(projects.saveServer({ ...projects.listServers().find(s => s.id === serverId), name: '服务器改名', secret: 'fixture-renamed-password' }).ok)
    assert.equal(projects.getCredentials('a').password, 'fixture-renamed-password')
    for (const p of projects.list()) {
      const expected = before.find(x => x.id === p.id).targets[0]
      for (const key of ['remotePath', 'autoSudo', 'autoHealth', 'autoDb']) assert.deepStrictEqual(p.targets[0][key], expected[key])
    }
    for (const update of [{ port: 2222 }, { username: 'deploy' }]) {
      reseedAutomatic()
      assert(projects.saveServer({ ...projects.listServers().find(s => s.id === serverId), ...update }).ok)
      for (const p of projects.list()) {
        if (['a', 'b'].includes(p.id)) {
          assertRuntimeCleared(p.targets[0])
          assert.equal(p.targets[0].db.name, 'custom')
          assert.equal(p.targets[0].health.enabled, false)
          assert.equal(p.targets[0].dataSync.localDir, 'custom-data')
        } else {
          assert.equal(p.targets[0].remotePath, '/apps/' + p.id)
          assert.equal(p.targets[0].autoDb.service, 'db')
        }
      }
    }
    for (const id of ['manual', 'script', 'unrelated']) assert(projects.remove(id).ok)
    assert(projects.removeServer(second.id).ok)
  })
  test('同一服务器可被新项目引用，项目间目录保持隔离', () => {
    const p = projects.defaultProject(); p.name = '第三项目'; p.targets[0].serverId = serverId
    assert(projects.save(p).ok)
    assert.equal(projects.listServers().length, 1)
    assert.equal(projects.listServers()[0].projects.length, 3)
    assert.equal(projects.list().find(x => x.id === p.id).targets[0].remotePath, '')
    assert.equal(projects.getCredentials(p.id).password, 'fixture-renamed-password')
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
