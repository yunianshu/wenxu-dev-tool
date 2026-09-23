/** Windows 旧版 Electron safeStorage(v10) 凭据迁移；明文仅在后台进程内流转。 */
const { spawnSync } = require('node:child_process')
const { createDecipheriv, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DPAPI_KEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$state = Get-Content -LiteralPath $env:PLM_LEGACY_LOCAL_STATE -Raw -Encoding UTF8 | ConvertFrom-Json
$blob = [Convert]::FromBase64String([string]$state.os_crypt.encrypted_key)
if ($blob.Length -le 5 -or [Text.Encoding]::ASCII.GetString($blob, 0, 5) -ne 'DPAPI') { exit 2 }
$key = [Security.Cryptography.ProtectedData]::Unprotect($blob[5..($blob.Length - 1)], $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($key))
[Array]::Clear($key, 0, $key.Length)
`

function loadLegacyKey(localStatePath) {
  if (process.platform !== 'win32' || !fs.existsSync(localStatePath)) return null
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(DPAPI_KEY_SCRIPT, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, PLM_LEGACY_LOCAL_STATE: localStatePath },
    windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 4096,
  })
  if (result.status !== 0) return null
  const key = Buffer.from(String(result.stdout || '').trim(), 'base64')
  return key.length === 32 ? key : null
}

function decryptLegacyText(key, encoded) {
  if (!key || !encoded) return null
  try {
    const cipher = Buffer.from(encoded, 'base64')
    if (cipher.length < 31 || cipher.subarray(0, 3).toString('ascii') !== 'v10') return null
    const decipher = createDecipheriv('aes-256-gcm', key, cipher.subarray(3, 15))
    decipher.setAuthTag(cipher.subarray(cipher.length - 16))
    return Buffer.concat([decipher.update(cipher.subarray(15, -16)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** 只补 keyRef；旧密文原样保留，写盘失败时回收本次创建的凭据库条目。 */
function migrateLegacyConfig(configPath, saveSecret, deleteSecret) {
  if (process.platform !== 'win32' || !fs.existsSync(configPath)) return false
  let old
  try { old = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return false }
  const candidates = [
    { target: old.ai, encoded: old.ai?.keyEnc, apply: (id) => { old.ai.keyRef = id } },
    { target: old.zentao?.pwdEnc, encoded: old.zentao?.pwdEnc?.enc, apply: (id) => { old.zentao.pwdEnc.keyRef = id } },
    { target: old.hanprint?.pwdEnc, encoded: old.hanprint?.pwdEnc?.enc, apply: (id) => { old.hanprint.pwdEnc.keyRef = id } },
  ].filter((item) => item.target && item.encoded && !item.target.keyRef)
  if (!candidates.length) return false
  const key = loadLegacyKey(path.join(path.dirname(configPath), 'Local State'))
  if (!key) return false
  const created = []
  let tempPath = ''
  try {
    for (const item of candidates) {
      const plain = decryptLegacyText(key, item.encoded)
      if (plain === null) continue
      try {
        const id = saveSecret(plain)
        if (!id) throw new Error('凭据库未返回引用')
        item.apply(id)
        created.push(id)
      } catch { /* 单项迁移失败不影响其他项，旧密文保持原样 */ }
    }
    if (!created.length) return false
    tempPath = `${configPath}.migrate-${process.pid}-${randomUUID()}`
    fs.writeFileSync(tempPath, JSON.stringify(old, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    fs.renameSync(tempPath, configPath)
    tempPath = ''
    return true
  } catch {
    for (const id of created) try { deleteSecret(id) } catch { /* 旧密文仍在配置中 */ }
    return false
  } finally {
    key.fill(0)
    if (tempPath) try { fs.rmSync(tempPath, { force: true }) } catch { /* 不清理非本次临时文件 */ }
  }
}

module.exports = { loadLegacyKey, decryptLegacyText, migrateLegacyConfig }
