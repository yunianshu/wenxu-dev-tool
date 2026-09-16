/**
 * 清理 release/ 下的历史版本产物 —— 只保留当前 package.json 版本。
 *
 * 为什么要清：每次打包都会在 release/<版本>/ 生成约 758MB（安装包 158MB +
 * 便携版 158MB + win-unpacked 约 440MB），逐版本累积下来轻松上 GB；
 * 而这些产物对本地更新通道并非必需——更新只读当前版本的 win-unpacked，
 * 更早的版本要用时从 git 重新打包即可。
 *
 * 安全约定：
 *   - 只删 release/ 下**严格形如 x.y.z 的目录**，其余文件/目录一律不碰
 *   - 当前版本始终保留（含安装包与 win-unpacked）
 *   - 清理失败只警告，不影响已经完成的安装
 *
 * 用法：node scripts/prune-releases.cjs [--keep 1.4.75] [--dry-run]
 *      安装通道会在 install-local 成功后自动调用（见 scripts/install-local.cjs）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const RELEASES = path.join(ROOT, 'release')

/** 版本目录名：x.y.z（可带 -rc 之类的后缀），避免误删非版本目录 */
const VERSION_DIR = /^\d+\.\d+\.\d+[-.\w]*$/

function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const ent of ents) {
      const abs = path.join(cur, ent.name)
      if (ent.isDirectory()) stack.push(abs)
      else { try { total += fs.statSync(abs).size } catch { /* 文件刚被删/被占用，跳过 */ } }
    }
  }
  return total
}

function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)}MB`
  return `${Math.round(bytes / 1024)}KB`
}

/**
 * 删除 release/ 下除 keep 之外的所有版本目录。
 * @returns {{ removed: string[], kept: string[], freedBytes: number, failed: string[] }}
 */
function prune({ keep, dryRun = false, log = () => {} } = {}) {
  const keepVersion = keep || require(path.join(ROOT, 'package.json')).version
  const result = { removed: [], kept: [], freedBytes: 0, failed: [] }
  if (!fs.existsSync(RELEASES)) return result

  for (const ent of fs.readdirSync(RELEASES, { withFileTypes: true })) {
    if (!ent.isDirectory() || !VERSION_DIR.test(ent.name)) continue
    if (ent.name === keepVersion) { result.kept.push(ent.name); continue }
    const dir = path.join(RELEASES, ent.name)
    const bytes = dirSize(dir)
    if (dryRun) {
      result.removed.push(ent.name)
      result.freedBytes += bytes
      log(`[prune] 将删除 release/${ent.name}（${formatSize(bytes)}）`)
      continue
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      result.removed.push(ent.name)
      result.freedBytes += bytes
      log(`[prune] 已删除 release/${ent.name}（${formatSize(bytes)}）`)
    } catch (err) {
      // 常见于产物仍在被占用（杀软扫描/资源管理器打开）：保留目录并提示，不打断流程
      result.failed.push(ent.name)
      log(`[prune] 跳过 release/${ent.name}：${(err && err.message) || err}`)
    }
  }
  return result
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  const keepIdx = argv.indexOf('--keep')
  const dryRun = argv.includes('--dry-run')
  const r = prune({
    keep: keepIdx >= 0 ? argv[keepIdx + 1] : undefined,
    dryRun,
    log: (m) => console.log(m),
  })
  console.log(
    `${dryRun ? '[prune] 预演' : '[prune] 完成'}：保留 ${r.kept.join(', ') || '(无)'}；`
    + `${dryRun ? '待删除' : '已删除'} ${r.removed.length} 个版本，`
    + `${dryRun ? '可释放' : '释放'} ${formatSize(r.freedBytes)}`
    + (r.failed.length ? `；${r.failed.length} 个被占用未删除：${r.failed.join(', ')}` : ''),
  )
}

module.exports = { prune, dirSize, formatSize }
