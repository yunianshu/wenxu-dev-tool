/** 使用隔离配置目录验证 Tauri 后台的凭据存储和旧密文保留。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-tauri-store-'))
process.env.PLM_NODE_BACKEND = '1'
const { electron } = require('../backend/electron-compat.cjs')
electron.app.setPath('userData', dir)
const originalLoad = Module._load
Module._load = function (id, parent, main) {
  return id === 'electron' ? electron : originalLoad.call(this, id, parent, main)
}

let aiRef = ''
let deployRef = ''
try {
  const store = require('../electron/store')
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ ai: { keyEnc: 'b2xkLWNpcGhlcnRleHQ=' } }))
  const old = store.load()
  assert.equal(old.ai.keyNeedsReentry, true)
  assert.equal(old.ai.keyConfigured, false)
  assert.equal(store.save(old), true)
  assert.equal(JSON.parse(fs.readFileSync(configPath)).ai.keyEnc, 'b2xkLWNpcGhlcnRleHQ=')

  old.ai.apiKey = 'isolated-test-key'
  assert.equal(store.save(old), true)
  const saved = JSON.parse(fs.readFileSync(configPath))
  aiRef = saved.ai.keyRef
  assert.ok(aiRef)
  assert.equal(saved.ai.apiKey, undefined)
  assert.equal(store.getApiKey(), 'isolated-test-key')

  const secret = store.encryptText('isolated-test-password')
  deployRef = secret.keyRef
  assert.ok(deployRef)
  assert.equal(store.decryptText(secret), 'isolated-test-password')
  assert.throws(() => store.decryptText({ enc: 'b2xkLWNpcGhlcnRleHQ=' }), /重新输入/)
  const cleared = store.load()
  cleared.ai.clearKey = true
  assert.equal(store.save(cleared), true)
  assert.equal(store.getApiKey(), '')
  console.log('Tauri 凭据隔离验证通过')
} finally {
  const { createHash } = require('node:crypto')
  const { Entry } = require('@napi-rs/keyring')
  const service = `com.prt.devprojectmanager.${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`
  for (const id of [aiRef, deployRef]) {
    if (id) try { new Entry(service, id).deletePassword() } catch { /* 测试项不存在 */ }
  }
  Module._load = originalLoad
  const resolved = fs.realpathSync(dir)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('plm-tauri-store-')) {
    throw new Error('拒绝清理非本测试目录')
  }
  fs.rmSync(resolved, { recursive: true, force: true })
}
