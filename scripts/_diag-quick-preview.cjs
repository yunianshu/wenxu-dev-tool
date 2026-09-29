// 只读预演：现有 11 个项目若切到「极简配置」，发布时会自动生成成什么样（纯本地体检，不连服务器、不写盘）。
// 用法：node scripts/_diag-quick-preview.cjs
const path = require('path')
const os = require('os')

// 打桩 electron（纯 node 运行）：userData 指向真实配置目录，只读
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dev-project-manager')
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } },
}

const projects = require('../electron/deploy/deploy-projects')
const aiDeploy = require('../electron/deploy/ai-deploy')

const list = projects.list()
console.log(`配置目录：${userData}`)
console.log(`项目数：${list.length}\n`)

for (const p of list) {
  const target = (p.targets || [])[0] || {}
  const local = aiDeploy.scanLocal(p)
  // remote 传「未体检」：等价于服务器体检不可用时的保底结果（真实发布会先体检，结果通常更准）
  const rawPlan = aiDeploy.buildHeuristicPlan(p, target, local, { ok: false, error: '预演：未连服务器' })
  // 与发布时同一套保留规则：生成不得回退已有手工配置（版本/健康/数据库/形态）
  const { plan, kept } = aiDeploy.applyQuickKeepPlan(p, target, rawPlan, local)
  // 数据同步开关语义同 generateQuickConfig：用户开关为准
  const syncOn = !!(target.dataSync && target.dataSync.enabled)
  plan.dataSync = syncOn
    ? { ...plan.dataSync, needed: true, items: [{ ...((plan.dataSync.items || [])[0] || { localDir: target.dataSync.localDir, remoteDir: target.dataSync.remoteDir }), kind: 'upload' }] }
    : { ...plan.dataSync, needed: false }
  const cur = {
    mode: p.deployMode, compose: p.composeFile,
    version: p.version.strategy === 'manual' ? `手动 ${p.version.manual}` : `自动 ${local.version.version || '未识别'}`,
    artifact: p.scriptMode.artifactDir, upgrade: p.scriptMode.upgradeScript, pkg: p.scriptMode.packageCommand || '（无）',
    health: target.health?.strategy === 'manual' ? `手动 ${target.health.url}` : `策略 ${target.health?.strategy || '默认'}`,
    db: `${target.db?.strategy || '默认'} / ${target.db?.container || '-'} / ${target.db?.name || '-'}`,
  }
  const gen = {
    mode: plan.deployMode, compose: plan.composeFile,
    version: plan.version.strategy === 'manual' ? `手动 ${plan.version.manual}` : `自动 ${local.version.version || '未识别'}`,
    artifact: plan.scriptMode.artifactDir, upgrade: plan.scriptMode.upgradeScript, pkg: plan.scriptMode.packageCommand || '（无）',
    health: plan.health.enabled ? plan.health.url : '未启用',
    db: plan.db.enabled ? `${plan.db.type} / ${plan.db.container || '-'} / ${plan.db.name || '-'}` : '不备份',
  }
  const diff = Object.keys(cur).filter((k) => String(cur[k]) !== String(gen[k]))
  console.log(`■ ${p.name}  [configMode=${p.configMode}]  ${diff.length ? `差异 ${diff.length} 项` : '完全一致'}`)
  if (diff.length) {
    for (const k of diff) console.log(`    ${k.padEnd(9)} 现在: ${cur[k]}`)
    for (const k of diff) console.log(`    ${''.padEnd(9)} 生成: ${gen[k]}`)
  }
  const missing = (plan.missingFiles || []).map((m) => m.path)
  if (kept.length) console.log(`    沿用手工配置: ${kept.join('；')}`)
  if (missing.length) console.log(`    缺文件: ${missing.join(', ')}`)
  console.log('')
}
