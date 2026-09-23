/**
 * 真实验证：本机 userData 中部署配置的旧 Electron 密文迁移到系统凭据库。
 * 读取部署配置时自动迁移（幂等）；随后核对凭据库读回值，并对真实服务器做只读体检。
 * 迁移前自动备份；明文不打印（仅长度与状态）。
 */
if (process.platform !== 'win32') {
  console.log('非 Windows 平台跳过')
  process.exit(0)
}
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { createHash } = require('node:crypto')

const userData = path.join(process.env.APPDATA, 'dev-project-manager')
const docPath = path.join(userData, 'deploy-projects.json')
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backup = `${docPath}.bak-migration-${stamp}`
fs.copyFileSync(docPath, backup)
console.log('备份:', path.basename(backup))

const legacyRefs = (doc) => [
  ...(doc.servers || []).flatMap((s) => [s.secret, s.passphrase]),
  ...(doc.projects || []).flatMap((p) => (p.targets || []).flatMap((t) => [t.server && t.server.secret, t.server && t.server.passphrase, t.dataSync && t.dataSync.importSecret])),
].filter((v) => v && v.enc && !v.keyRef)
console.log('迁移前旧密文引用:', legacyRefs(JSON.parse(fs.readFileSync(docPath, 'utf8'))).length)

process.env.PLM_NODE_BACKEND = '1'
const { electron } = require('../backend/electron-compat.cjs')
// 复现应用加载顺序：主进程先 require 部署模块（store 顶层此刻计算凭据库服务名），随后才 setPath。
// 顺序不同会算错服务名，凭据就读不回来。
const serviceBase = electron.app.getPath('userData')
const originalLoad = Module._load
Module._load = (id, parent, main) => (id === 'electron' ? electron : originalLoad.call(this, id, parent, main))

const projects = require('../electron/deploy/deploy-projects')
electron.app.setPath('userData', userData)
const service = `com.prt.devprojectmanager.${createHash('sha256').update(serviceBase).digest('hex').slice(0, 16)}`
console.log('凭据库服务名基准目录:', serviceBase)
const { Entry } = require('@napi-rs/keyring')
const readBack = (v) => {
  if (!v || !v.keyRef) return null
  try { return new Entry(service, v.keyRef).getPassword() } catch { return null }
}

const failed = []
const add = (msg) => { failed.push(msg); console.log('  ✗', msg) }

const servers = projects.listServers()
const listed = projects.list()
const after = JSON.parse(fs.readFileSync(docPath, 'utf8'))
if (legacyRefs(after).length) add(`仍有 ${legacyRefs(after).length} 处旧密文没有 keyRef`)

for (const s of servers) {
  const stored = (after.servers || []).find((x) => x.id === s.id) || {}
  const plain = readBack(stored.secret)
  const kept = stored.secret && Buffer.from(stored.secret.enc, 'base64').subarray(0, 3).toString('ascii') === 'v10'
  console.log(`服务器 ${s.name}: configured=${s.secretConfigured} reentry=${s.secretNeedsReentry} 读回=${plain ? `${plain.length} 位` : '失败'} 密文保留=${kept}`)
  if (!s.secretConfigured || s.secretNeedsReentry) add(`服务器 ${s.name} 凭据状态异常`)
  if (stored.secret && !plain) add(`服务器 ${s.name} 凭据库读回失败`)
  if (stored.secret && stored.secret.enc && !kept) add(`服务器 ${s.name} 旧密文未保留`)
  if (stored.passphrase && stored.passphrase.enc && !stored.passphrase.keyRef) add(`服务器 ${s.name} 私钥口令未迁移`)
}

let importTargets = 0
let importProjects = 0
let serverTargets = 0
for (const p of listed) {
  let hasImport = false
  for (const t of p.targets) {
    const ds = t.dataSync || {}
    if (ds.importSecretNeedsReentry) add(`${p.name} 的导入密码仍需重新输入`)
    if (ds.importSecretConfigured) { hasImport = true; importTargets += 1 }
    if (t.server && t.server.host) {
      serverTargets += 1
      const cred = projects.getCredentials(p.id, t.id)
      if (!cred || !cred.password) add(`${p.name}/${t.id} 取不到服务器明文密码`)
    }
  }
  if (hasImport) importProjects += 1
}
console.log(`导入密码已迁移: ${importTargets} 个目标 / ${importProjects} 个项目；关联服务器的目标: ${serverTargets}`)

const importProject = listed.find((p) => p.targets.some((t) => t.dataSync?.importSecretConfigured))
if (importProject) {
  const t = importProject.targets.find((x) => x.dataSync?.importSecretConfigured)
  try {
    const plain = projects.getDataSyncCredentials(importProject.id, t.id)
    console.log(`导入密码取密（${importProject.name}）:`, plain ? `${plain.length} 位` : '空')
    if (!plain) add(`${importProject.name} 导入密码取密为空`)
  } catch (error) {
    add(`导入密码取密失败: ${error.message}`)
  }
}

// 真实服务器只读体检：走 connectTarget → getCredentials → 凭据库，验证发布链路可用
const probe = listed.flatMap((p) => p.targets.filter((t) => t.server && t.server.host).map((t) => ({ p, t })))[0]
;(async () => {
  if (probe) {
    try {
      const deployService = require('../electron/deploy/deploy-service')
      const info = await deployService.testConnection(probe.p.id, probe.t.id)
      console.log(`真实连接 ${probe.p.name} → ${probe.t.server.host}: ok=${info.ok} os=${info.os || '-'} docker=${info.docker || '缺失'} compose=${info.compose || '缺失'}`)
      if (!info.ok) add(`${probe.p.name} 真实服务器连接失败`)
    } catch (error) {
      add(`真实服务器连接异常: ${error.message}`)
    }
  } else {
    console.log('（没有关联服务器的目标，跳过真实连接体检）')
  }

  Module._load = originalLoad
  if (failed.length) {
    console.log(`\n验证失败 ${failed.length} 项；可用备份恢复：copy "${backup}" "${docPath}"`)
    process.exit(1)
  }
  console.log('\n真实验证通过：旧密文已全部转存系统凭据库，取密与真实 SSH 链路可用')
  console.log('备份保留在:', path.basename(backup))
})()
