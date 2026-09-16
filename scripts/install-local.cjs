/**
 * 一键本地更新：打包（npm run build:win）后无需安装向导、无需 UAC，直接把
 * win-unpacked 同步到当前用户目录的固定位置并重启应用。
 *
 * 为什么不用 NSIS 安装器：Administrator 账户下 NSIS 静默安装（/S，即便带 /currentuser）
 * 实测仍按「所有用户」装进 Program Files，每次更新都要点一次 UAC。本方案同步到
 * %LOCALAPPDATA%\Programs（用户可写），一次迁移后永久零交互：
 *
 *   1. 关闭正在运行的应用
 *   2. 如残留「所有用户」安装（Program Files + 注册表），静默卸载（最后一次 UAC）
 *   3. robocopy /MIR 同步 release/<版本>/win-unpacked → 固定安装位置
 *   4. 校验安装后 exe 版本与 package.json 一致
 *   5. 桌面快捷方式指向固定位置（每次覆盖刷新）
 *   6. 清理 release/ 下的旧版本产物（只留当前版本，见 scripts/prune-releases.cjs）
 *   7. 启动应用
 *
 * 注意：本机自用更新通道，不写卸载器/注册表（应用用户数据在
 * %APPDATA%\dev-project-manager，不受更新影响）。分发给他人用 release/<当前版本>/
 * 里的安装包；旧版本的安装包会被第 6 步清掉，需要时从 git 重新打包。
 *
 * 用法：npm run install:local（或 node scripts/install-local.cjs）
 */
const { spawnSync, spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { prune, formatSize } = require('./prune-releases.cjs')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const productName = pkg.build.productName
const appExeName = `${productName}.exe`
const unpacked = path.join(ROOT, 'release', pkg.version, 'win-unpacked')
const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', pkg.name)
const installedExe = path.join(installDir, appExeName)

function die(msg) {
  console.error(`[install-local] 失败: ${msg}`)
  process.exit(1)
}
/** 同步等待（Node 无 sleep，Atomics.wait 阻塞主线程） */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function ps(cmd) {
  // 注册表值含中文（卸载器路径/显示名），PowerShell 默认按系统码表输出会变乱码——强制 UTF-8
  return spawnSync('powershell', ['-NoProfile', '-Command',
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${cmd}`], { encoding: 'utf8' })
}

if (!fs.existsSync(path.join(unpacked, appExeName))) {
  die(`未找到 ${unpacked}\\${appExeName}，请先 npm run build:win`)
}
console.log(`[install-local] 更新到 v${pkg.version}（源: release/${pkg.version}/win-unpacked）`)

// ── 1. 关闭正在运行的应用（含残留的 GPU 子进程，按镜像名全杀）──
for (let i = 0; i < 10; i++) {
  const k = spawnSync('taskkill', ['/F', '/IM', appExeName], { encoding: 'utf8' })
  if (k.status !== 0) break // 已无运行实例
  if (i === 0) console.log('[install-local] 已关闭正在运行的应用')
  sleep(600)
}

// ── 2. 一次性迁移：卸载残留的「所有用户」安装（Program Files）──
const regQuery = ps(`
  Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '${productName}*' } |
  Select-Object DisplayName, UninstallString | ConvertTo-Json -Compress`)
const entries = (() => {
  const txt = (regQuery.stdout || '').trim()
  if (!txt) return []
  try { const j = JSON.parse(txt); return Array.isArray(j) ? j : [j] } catch { return [] }
})()
const machineEntry = entries.find((e) => (e.UninstallString || '').includes('Program Files'))
if (machineEntry) {
  const uninstaller = machineEntry.UninstallString.split('"')[1] || machineEntry.UninstallString
  console.log(`[install-local] 检测到「所有用户」安装（${machineEntry.DisplayName}），静默卸载……`)
  console.log('[install-local] ※ 屏幕会弹一次 UAC，请点「是」（迁移完成后永不再出现）')
  const un = ps(`Start-Process -FilePath '${uninstaller.replace(/'/g, "''")}' -ArgumentList '/S' -Verb RunAs -Wait`)
  if (un.status !== 0) die(`旧版卸载未完成（UAC 被取消或失败）：${(un.stderr || '').slice(0, 200)}`)
  sleep(1500)
  console.log('[install-local] 旧「所有用户」安装已卸载')
} else {
  console.log('[install-local] 无「所有用户」安装残留')
}

// ── 3. 同步 win-unpacked → 固定安装位置（/MIR 清理旧版本文件）──
fs.mkdirSync(installDir, { recursive: true })
// 直接以参数数组调用（不经 shell，避免各层引号重包装）；robocopy 退出码 0-7 都是成功
//（1=有文件复制 0=无变化），≥8 才是失败
const rc = spawnSync('robocopy',
  [unpacked, installDir, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
  { encoding: 'utf8' })
if (rc.status >= 8) die(`robocopy 失败（退出码 ${rc.status}）：${(rc.stdout || rc.stderr || '').slice(-300)}`)

// ── 4. 校验版本 ──
if (!fs.existsSync(installedExe)) die(`未找到安装产物 ${installedExe}`)
const ver = ps(`(Get-Item '${installedExe.replace(/'/g, "''")}').VersionInfo.FileVersion`)
const fileVersion = (ver.stdout || '').trim()
if (fileVersion !== pkg.version) die(`版本不符：期望 ${pkg.version}，实际 ${fileVersion}`)
console.log(`[install-local] 已就位 v${fileVersion} → ${installedExe}`)

// ── 5. 桌面快捷方式（覆盖刷新，始终指向固定位置）──
const desktop = path.join(process.env.USERPROFILE || process.env.HOME, 'Desktop', `${productName}.lnk`)
ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${desktop.replace(/'/g, "''")}'); $s.TargetPath = '${installedExe.replace(/'/g, "''")}'; $s.WorkingDirectory = '${installDir.replace(/'/g, "''")}'; $s.Save()`)
console.log('[install-local] 桌面快捷方式已刷新')

// ── 6. 清理旧版本产物：release/ 每个版本约 758MB，逐版本累积会把磁盘吃满。
//      安装已经完成，清理失败（产物被占用等）只警告，不影响这次更新 ──
const pruned = prune({ log: (m) => console.log(m) })
if (pruned.removed.length || pruned.failed.length) {
  console.log(`[install-local] 旧版本产物清理：删除 ${pruned.removed.length} 个、释放 ${formatSize(pruned.freedBytes)}，保留 v${pkg.version}`)
}

// ── 7. 启动 ──
spawn(installedExe, [], { detached: true, stdio: 'ignore', cwd: installDir }).unref()
console.log(`[install-local] 完成：v${pkg.version} 已更新并启动`)
