/** 用隔离夹具验证部署凭据（服务器密码/私钥口令、数据同步导入密码）的旧版密文迁移。 */
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createCipheriv, createHash, randomBytes, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { migrateLegacyDeploySecrets } = require('../electron/legacy-safe-storage')

if (process.platform !== 'win32') {
  console.log('非 Windows 平台跳过旧版 DPAPI 部署凭据迁移测试')
  process.exit(0)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-legacy-deploy-'))
const key = randomBytes(32)
const script = String.raw`
Add-Type -AssemblyName System.Security
$key = [Convert]::FromBase64String($env:PLM_FIXTURE_KEY)
$blob = [Security.Cryptography.ProtectedData]::Protect($key, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($blob))
`
const protectedKey = spawnSync('powershell.exe', [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
], { env: { ...process.env, PLM_FIXTURE_KEY: key.toString('base64') }, windowsHide: true, encoding: 'utf8' })

function encrypt(text, useKey = key) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', useKey, iv)
  return Buffer.concat([Buffer.from('v10'), iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

const vault = new Map()
const removed = []
const save = (text) => { const id = randomUUID(); vault.set(id, text); return id }
const remove = (id) => { removed.push(id); vault.delete(id) }

const localState = path.join(dir, 'Local State')
const docPath = path.join(dir, 'deploy-projects.json')

/** 服务器密码与私钥口令被 servers[] 与 targets[].server 引用同一份密文（真实文件即如此）。 */
function docFixture(useKey = key) {
  const serverSecret = { enc: encrypt('fixture-ssh-password', useKey), plain: '' }
  const serverPassphrase = { enc: encrypt('fixture-ssh-passphrase', useKey), plain: '' }
  const importSecret = { enc: encrypt('fixture-import-password', useKey), plain: '' }
  return {
    schemaVersion: 2,
    servers: [{ id: 'sv1', name: 'sv1', host: '10.0.0.1', port: 22, username: 'root', authType: 'key', keyPath: '/k', secret: serverSecret, passphrase: serverPassphrase }],
    projects: [{
      id: 'p1', name: 'P1',
      targets: [
        { id: 't1', serverId: 'sv1', server: { id: 'sv1', host: '10.0.0.1', secret: serverSecret, passphrase: serverPassphrase }, dataSync: { enabled: true, importSecret } },
        { id: 't2', serverId: 'sv1', dataSync: { enabled: true, importSecret } },
      ],
    }],
  }
}

try {
  assert.equal(protectedKey.status, 0, 'DPAPI 夹具密钥不可用')
  fs.writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(protectedKey.stdout.trim(), 'base64')]).toString('base64') } }))

  // 1) 正常迁移：去重、只补 keyRef、密文原样保留
  const fixture = docFixture()
  fs.writeFileSync(docPath, JSON.stringify(fixture, null, 2))
  assert.equal(migrateLegacyDeploySecrets(docPath, save, remove), true)
  const migrated = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  const sshId = migrated.servers[0].secret.keyRef
  const passId = migrated.servers[0].passphrase.keyRef
  const importId = migrated.projects[0].targets[0].dataSync.importSecret.keyRef
  assert.ok(sshId && passId && importId, '三类凭据都应补上 keyRef')
  assert.equal(vault.get(sshId), 'fixture-ssh-password')
  assert.equal(vault.get(passId), 'fixture-ssh-passphrase')
  assert.equal(vault.get(importId), 'fixture-import-password')
  assert.equal(vault.size, 3, '同一密文的重复引用只写一条凭据库记录')
  assert.equal(migrated.projects[0].targets[0].server.secret.keyRef, sshId)
  assert.equal(migrated.projects[0].targets[0].server.passphrase.keyRef, passId)
  assert.equal(migrated.projects[0].targets[1].dataSync.importSecret.keyRef, importId)
  assert.equal(migrated.servers[0].secret.enc, fixture.servers[0].secret.enc, '旧密文必须保留')
  assert.equal(migrated.projects[0].targets[1].dataSync.importSecret.enc, fixture.projects[0].targets[1].dataSync.importSecret.enc)
  // 幂等：已迁移的文档不再重复处理
  assert.equal(migrateLegacyDeploySecrets(docPath, save, remove), false)
  assert.equal(vault.size, 3)

  // 2) 写盘失败：回收本次创建的凭据，磁盘内容保持原样，不留临时文件
  fs.writeFileSync(docPath, JSON.stringify(docFixture(), null, 2))
  const before = fs.readFileSync(docPath)
  removed.length = 0
  const originalRename = fs.renameSync
  let rollbackResult
  try {
    fs.renameSync = () => { throw new Error('模拟写盘失败') }
    rollbackResult = migrateLegacyDeploySecrets(docPath, save, remove)
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(rollbackResult, false, '写盘失败必须报告未迁移')
  assert.deepEqual(fs.readFileSync(docPath), before, '失败时不得留下半份文档')
  assert.equal(removed.length, 3, '已创建的条目都会被回收')
  for (const id of removed) assert.equal(vault.has(id), false, '失败的条目必须回收')
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.migrate-')), [], '临时文件必须清理')

  // 3) 无法解密（密钥不匹配）：不写 keyRef，整体报告未迁移
  fs.writeFileSync(docPath, JSON.stringify(docFixture(randomBytes(32)), null, 2))
  const foreignBefore = fs.readFileSync(docPath)
  assert.equal(migrateLegacyDeploySecrets(docPath, save, remove), false)
  assert.deepEqual(fs.readFileSync(docPath), foreignBefore)

  // 4) 无旧密文 / 无 Local State：直接放行，不动文档
  const clean = { schemaVersion: 2, servers: [{ id: 'sv1', secret: { keyRef: 'kept-id', enc: 'v10xxx' } }], projects: [] }
  fs.writeFileSync(docPath, JSON.stringify(clean, null, 2))
  assert.equal(migrateLegacyDeploySecrets(docPath, save, remove), false)
  fs.rmSync(localState)
  fs.writeFileSync(docPath, JSON.stringify(docFixture(), null, 2))
  const noState = fs.readFileSync(docPath)
  assert.equal(migrateLegacyDeploySecrets(docPath, save, remove), false)
  assert.deepEqual(fs.readFileSync(docPath), noState)
  fs.writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(protectedKey.stdout.trim(), 'base64')]).toString('base64') } }))

  // 5) 真实 store + 真实凭据库 + 真实 deploy-projects
  process.env.PLM_NODE_BACKEND = '1'
  const { electron } = require('../backend/electron-compat.cjs')
  electron.app.setPath('userData', dir)
  const originalLoad = Module._load
  Module._load = function (id, parent, main) {
    return id === 'electron' ? electron : originalLoad.call(this, id, parent, main)
  }
  const requireProjects = () => {
    delete require.cache[require.resolve('../electron/deploy/deploy-projects')]
    return require('../electron/deploy/deploy-projects')
  }
  try {
    // 5a) 迁移不可用（本机没有 Local State）：旧密文保留，取密路径给出可执行的入口指引
    fs.rmSync(localState, { force: true })
    fs.writeFileSync(docPath, JSON.stringify(docFixture(), null, 2))
    const broken = requireProjects()
    const brokenServers = broken.listServers()
    assert.equal(brokenServers[0].secretConfigured, false)
    assert.equal(brokenServers[0].secretNeedsReentry, true, '未迁移时界面要提示重新输入')
    assert.throws(() => broken.getCredentials('p1', 't1'), /服务器管理/, '服务器旧凭据要指向「服务器管理」')
    assert.throws(() => broken.getDataSyncCredentials('p1', 't1'), /数据同步/, '导入密码要指向部署配置的数据同步')
    assert.equal(fs.readFileSync(docPath, 'utf8').includes('keyRef'), false, '迁移不可用时不得改动文档')

    // 5b) 迁移可用：读取部署配置即自动转存，发布取密路径直接拿到明文
    fs.writeFileSync(localState, JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(protectedKey.stdout.trim(), 'base64')]).toString('base64') } }))
    fs.writeFileSync(docPath, JSON.stringify(docFixture(), null, 2))
    const projects = requireProjects()
    const servers = projects.listServers()
    assert.equal(servers.length, 1)
    assert.equal(servers[0].secretConfigured, true)
    assert.equal(servers[0].secretNeedsReentry, false, '迁移后不应再要求重新输入')
    assert.equal(servers[0].passphraseNeedsReentry, false)
    const listed = projects.list().find((p) => p.id === 'p1')
    assert.equal(listed.targets[0].dataSync.importSecretConfigured, true)
    assert.equal(listed.targets[0].dataSync.importSecretNeedsReentry, false)
    assert.deepEqual(projects.getCredentials('p1', 't1'), { password: 'fixture-ssh-password', passphrase: 'fixture-ssh-passphrase' })
    assert.equal(projects.getDataSyncCredentials('p1', 't1'), 'fixture-import-password')
    const stored = JSON.parse(fs.readFileSync(docPath, 'utf8'))
    assert.ok(stored.servers[0].secret.keyRef, '真实链路迁移必须落盘')
    assert.equal(Buffer.from(stored.servers[0].secret.enc, 'base64').subarray(0, 3).toString('ascii'), 'v10', '旧密文仍保留')
    assert.equal(stored.projects[0].targets[0].dataSync.importSecret.keyRef, stored.projects[0].targets[1].dataSync.importSecret.keyRef, '共享密文复用同一条凭据库记录')
  } finally {
    const stored = JSON.parse(fs.readFileSync(docPath, 'utf8'))
    const service = `com.prt.devprojectmanager.${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`
    const { Entry } = require('@napi-rs/keyring')
    const ids = [stored.servers?.[0]?.secret?.keyRef, stored.servers?.[0]?.passphrase?.keyRef,
      ...(stored.projects || []).flatMap((p) => (p.targets || []).map((t) => t.dataSync?.importSecret?.keyRef))]
    for (const id of [...ids, ...vault.keys()]) {
      if (id) try { new Entry(service, id).deletePassword() } catch { /* 测试项不存在 */ }
    }
    Module._load = originalLoad
  }
  console.log('旧版部署凭据迁移验证通过')
} finally {
  key.fill(0)
  const resolved = fs.realpathSync(dir)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('plm-legacy-deploy-')) {
    throw new Error('拒绝清理非本测试目录')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}
