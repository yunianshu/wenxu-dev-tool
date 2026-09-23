/** 用隔离密文验证旧版填报密码迁移，真实密码不进入测试输出。 */
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createCipheriv, createHash, randomBytes, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { migrateLegacyConfig } = require('../electron/legacy-safe-storage')

if (process.platform !== 'win32') {
  console.log('非 Windows 平台跳过旧版 DPAPI 迁移测试')
  process.exit(0)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-legacy-secret-'))
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

function encrypt(text) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  return Buffer.concat([Buffer.from('v10'), iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

try {
  assert.equal(protectedKey.status, 0)
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: {
    encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.from(protectedKey.stdout.trim(), 'base64')]).toString('base64'),
  } }))
  const configPath = path.join(dir, 'config.json')
  const original = { ai: { keyEnc: encrypt('fixture-ai-key') },
    zentao: { account: 'fixture-user', pwdEnc: { enc: encrypt('fixture-zt-password'), plain: '' } },
    hanprint: { account: 'fixture-user', pwdEnc: { enc: encrypt('fixture-hp-password'), plain: '' } } }
  fs.writeFileSync(configPath, JSON.stringify(original))
  const vault = new Map()
  const save = (text) => { const id = randomUUID(); vault.set(id, text); return id }
  const remove = (id) => vault.delete(id)
  assert.equal(migrateLegacyConfig(configPath, save, remove), true)
  const migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  assert.equal(vault.get(migrated.ai.keyRef), 'fixture-ai-key')
  assert.equal(vault.get(migrated.zentao.pwdEnc.keyRef), 'fixture-zt-password')
  assert.equal(vault.get(migrated.hanprint.pwdEnc.keyRef), 'fixture-hp-password')
  assert.equal(migrated.ai.keyEnc, original.ai.keyEnc)
  assert.deepEqual(migrated.zentao.pwdEnc.enc, original.zentao.pwdEnc.enc)
  assert.deepEqual(migrated.hanprint.pwdEnc.enc, original.hanprint.pwdEnc.enc)
  assert.equal(migrateLegacyConfig(configPath, save, remove), false)
  assert.equal(vault.size, 3)
  // 走真实 store.load 与 Windows 凭据库，确认界面配置状态和填报取密路径一致。
  fs.writeFileSync(configPath, JSON.stringify(original))
  process.env.PLM_NODE_BACKEND = '1'
  const { electron } = require('../backend/electron-compat.cjs')
  electron.app.setPath('userData', dir)
  const originalLoad = Module._load
  Module._load = function (id, parent, main) {
    return id === 'electron' ? electron : originalLoad.call(this, id, parent, main)
  }
  try {
    const store = require('../electron/store')
    const loaded = store.load()
    assert.equal(loaded.ai.keyConfigured, true)
    assert.equal(loaded.zentao.pwdConfigured, true)
    assert.equal(loaded.hanprint.pwdConfigured, true)
    assert.equal(loaded.zentao.pwdNeedsReentry, false)
    assert.equal(loaded.hanprint.pwdNeedsReentry, false)
    assert.equal(store.getZentaoPwd(), 'fixture-zt-password')
    assert.equal(store.getHanprintPwd(), 'fixture-hp-password')
  } finally {
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const service = `com.prt.devprojectmanager.${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`
    const { Entry } = require('@napi-rs/keyring')
    for (const id of [stored.ai?.keyRef, stored.zentao?.pwdEnc?.keyRef, stored.hanprint?.pwdEnc?.keyRef]) {
      if (id) try { new Entry(service, id).deletePassword() } catch { /* 测试项不存在 */ }
    }
    Module._load = originalLoad
  }
  console.log('旧版 AI 与两项填报凭据迁移验证通过')
} finally {
  key.fill(0)
  const resolved = fs.realpathSync(dir)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('plm-legacy-secret-')) {
    throw new Error('拒绝清理非本测试目录')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}
