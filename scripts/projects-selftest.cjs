/**
 * 通用项目服务自测（无框架，node scripts/projects-selftest.cjs 直接运行，electron 打桩）
 * 覆盖：
 *   - 只填名称即可创建项目（无 .git / Compose / 服务器 / API Key）
 *   - 项目持久化，重启（新进程）后仍存在
 *   - 旧版 deploy-projects.json 格式兼容（server 在根上、无 targets）
 *   - 凭据加密落盘、list() 脱敏（渲染层拿不到明文），getCredentials 主进程可取
 *   - 保存保留未知字段与原加密字节
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message}`)
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-test-'))
const stubExports = {
  app: { getPath: () => path.join(tmpRoot, 'userdata') },
  safeStorage: { isEncryptionAvailable: () => false },
}
const Module = require('module')
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stubExports }

const projectService = require('../electron/project-service')
const deployProjects = require('../electron/deploy/deploy-projects')
const dataFile = path.join(tmpRoot, 'userdata', 'deploy-projects.json')

console.log('通用项目服务 project-service:')

test('只填名称即可创建项目', () => {
  const r = projectService.save({ name: '纯资料项目' })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  const found = projectService.list().find((p) => p.id === r.id)
  assert.ok(found, 'list 应包含新项目')
  assert.strictEqual(found.name, '纯资料项目')
  assert.strictEqual(found.status, 'active')
  assert.ok(Array.isArray(found.targets), '应有惰性默认 targets')
})

test('空名称拒绝保存', () => {
  const r = projectService.save({ name: '  ' })
  assert.strictEqual(r.ok, false)
})

test('项目持久化：模拟重启（清模块缓存重载）后仍存在', () => {
  const before = projectService.list()
  assert.ok(before.length >= 1)
  for (const key of Object.keys(require.cache)) {
    if (key.includes('project-service') || key.includes('deploy-projects') || key.includes(`${path.sep}store.js`)) {
      delete require.cache[key]
    }
  }
  const reloaded = require('../electron/project-service')
  const names = reloaded.list().map((p) => p.name)
  assert.ok(names.includes('纯资料项目'), `重启后项目丢失：${JSON.stringify(names)}`)
})

test('旧版部署项目格式兼容：根级 server/remotePath 迁移到 targets[0]', () => {
  const legacy = {
    projects: [{
      id: 'legacy-1',
      name: '旧部署项目',
      localPath: 'D:\\legacy\\app',
      composeFile: 'docker-compose.yml',
      server: { host: '10.0.0.8', port: 22, username: 'root', authType: 'password', secret: 'legacy-enc-blob' },
      remotePath: '/opt/app',
      health: { enabled: true, url: 'http://10.0.0.8/health' },
    }],
  }
  fs.writeFileSync(dataFile, JSON.stringify(legacy), 'utf8')
  const found = projectService.list().find((p) => p.id === 'legacy-1')
  assert.ok(found, '旧项目应出现在列表')
  assert.strictEqual(found.targets[0].server.host, '10.0.0.8')
  assert.strictEqual(found.targets[0].remotePath, '/opt/app')
  assert.strictEqual(found.targets[0].health.url, 'http://10.0.0.8/health')
  assert.ok(!('server' in found) && !('remotePath' in found), '旧根级字段应被清除')
})

test('凭据脱敏：list() 不含 secret 字段与凭据字节，仅有配置标记', () => {
  const found = projectService.list().find((p) => p.id === 'legacy-1')
  assert.ok(found, '旧项目应出现在列表')
  const srv = found.targets[0].server
  assert.ok(!('secret' in srv), `list 泄露 secret 字段：${JSON.stringify(Object.keys(srv))}`)
  assert.ok(!('passphrase' in srv), 'list 泄露 passphrase 字段')
  assert.ok(typeof srv.secretConfigured === 'boolean', '应有 secretConfigured 标记')
  assert.ok(!JSON.stringify(found).includes('legacy-enc-blob'), 'list 输出不得包含凭据字节')
})

test('保存新凭据：secret 结构化落盘、再次保存空凭据原样保留、主进程可取回', () => {
  const r = projectService.save({ name: '带凭据项目', targets: [{ name: '生产', server: { host: 'h', secret: 'plain-pass-123' } }] })
  assert.strictEqual(r.ok, true)
  const raw1 = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  const srv1 = raw1.servers.find((s) => s.id === raw1.projects.find((p) => p.id === r.id).targets[0].serverId)
  // encryptText 返回 {enc, plain} 结构；safeStorage 可用时 enc 为密文，不可用走明文兜底（与 AI Key 同规则）
  assert.ok(srv1.secret && typeof srv1.secret === 'object' && 'enc' in srv1.secret && 'plain' in srv1.secret,
    `secret 应为 {enc, plain} 结构：${JSON.stringify(srv1.secret)}`)
  const bytes1 = srv1.secret
  // 再次保存（凭据留空）→ 字节原样保留
  const listed = projectService.list().find((p) => p.id === r.id)
  assert.ok(!('secret' in listed.targets[0].server), 'list 结果不应携带 secret，模拟渲染层回传')
  const r2 = projectService.save({ ...listed, name: '带凭据项目2' })
  assert.strictEqual(r2.ok, true)
  const raw2 = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  const srv2 = raw2.servers.find((s) => s.id === raw2.projects.find((p) => p.id === r.id).targets[0].serverId)
  assert.deepStrictEqual(srv2.secret, bytes1, '凭据字节应原样保留')
  // 主进程可取回明文
  const cred = deployProjects.getCredentials(r.id)
  assert.strictEqual(cred.password, 'plain-pass-123')
})

test('保存保留未知自定义字段', () => {
  const r = projectService.save({ name: '自定义字段项目', customField: { a: 1 } })
  assert.strictEqual(r.ok, true)
  const r2 = projectService.save({ id: r.id, name: '自定义字段项目', customField: { a: 1 } })
  assert.strictEqual(r2.ok, true)
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  const p = raw.projects.find((x) => x.id === r.id)
  assert.deepStrictEqual(p.customField, { a: 1 })
})

test('删除项目', () => {
  const r = projectService.save({ name: '待删除' })
  projectService.remove(r.id)
  assert.ok(!projectService.list().some((p) => p.id === r.id))
  assert.strictEqual(projectService.remove('').ok, false, '空 ID 应报错')
})

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
