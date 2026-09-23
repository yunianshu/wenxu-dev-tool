/**
 * 一键本地更新（Tauri 通道）：打包（npm run build:win）后，静默安装 NSIS 包到当前用户目录并重启应用。
 *
 * 为什么用 NSIS 静默安装而不是 robocopy：Tauri 的 NSIS 包是 currentUser 模式（装到
 * %LOCALAPPDATA%\<productName>），静默安装（/S）不需要 UAC，且会同步更新卸载器、
 * 快捷方式与注册表项，保持与正式分发一致的安装形态。Electron 时代的 robocopy 通道
 * 保留在 scripts/install-local.cjs（npm run install:local:electron）。
 *
 *   1. 校验 release 产物存在（bundle/nsis/<productName>_<version>_x64-setup.exe）
 *   2. 关闭正在运行的应用（先优雅关闭，超时再强制）
 *   3. 静默安装 /S
 *   4. 校验安装目录 exe 文件版本与 package.json 一致
 *   5. 清理同目录下旧版本的安装包
 *   6. 启动应用
 *
 * 用法：npm run install:local
 */
const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const version = pkg.version
const productName = require(path.join(ROOT, 'src-tauri', 'tauri.conf.json')).productName
const bundleDir = path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle', 'nsis')
const setup = path.join(bundleDir, `${productName}_${version}_x64-setup.exe`)
const installDir = path.join(process.env.LOCALAPPDATA, productName)
// 主二进制名取自 src-tauri/Cargo.toml 的 package name（personnel-plm）
const appExe = path.join(installDir, 'personnel-plm.exe')

function log(msg) { console.log(`[install-local] ${msg}`) }
function die(msg) { console.error(`[install-local] 失败: ${msg}`); process.exit(1) }
/** 同步等待（Node 无 sleep，Atomics.wait 阻塞主线程） */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
function ps(cmd) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' })
  return (r.stdout || '').trim()
}
const appPids = () => ps("@(Get-Process -Name 'personnel-plm' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*Personnel PLM*' }) | ForEach-Object { $_.Id }")
  .split(/\s+/).filter(Boolean)

if (!fs.existsSync(setup)) die(`未找到安装包 ${setup}，请先运行 npm run build:win`)
log(`更新到 v${version}（源: ${path.relative(ROOT, setup)}）`)

// 1. 关闭应用：先优雅（WM_CLOSE），5 秒内没退就强制
const running = appPids()
if (running.length) {
  log(`关闭正在运行的应用（PID ${running.join(', ')}）`)
  spawnSync('taskkill', ['/IM', 'personnel-plm.exe'], { stdio: 'pipe' })
  for (let i = 0; i < 10 && appPids().length; i++) sleep(500)
  if (appPids().length) {
    spawnSync('taskkill', ['/F', '/IM', 'personnel-plm.exe'], { stdio: 'pipe' })
    sleep(1000)
  }
  if (appPids().length) die('应用无法关闭，请手动结束后重试')
}

// 2. 静默安装
log('开始静默安装…')
const t0 = Date.now()
const r = spawnSync(setup, ['/S'], { stdio: 'pipe', timeout: 300000, encoding: 'utf8' })
if (r.error) die(`安装进程启动失败: ${r.error.message}`)
if (r.status !== 0) die(`安装器退出码 ${r.status}${r.stderr ? '：' + String(r.stderr).slice(0, 300) : ''}`)
log(`安装完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`)

// 3. 校验安装结果：exe 存在且文件版本与 package.json 一致
if (!fs.existsSync(appExe)) die(`安装目录缺少 ${appExe}`)
const fileVersion = ps(`(Get-Item '${appExe}').VersionInfo.FileVersion`)
if (fileVersion !== version) die(`安装版本不符：期望 ${version}，实际 ${fileVersion || '(未知)'}`)
log(`已就位 v${fileVersion} → ${appExe}`)

// 4. 清理旧版本安装包（只留当前版本，安装包每个约 85 MB）
let freed = 0, removed = 0
for (const f of fs.readdirSync(bundleDir)) {
  if (!/setup\.exe$/i.test(f) || f === path.basename(setup)) continue
  const target = path.join(bundleDir, f)
  freed += fs.statSync(target).size
  fs.rmSync(target, { force: true })
  removed++
}
if (removed) log(`旧安装包清理：删除 ${removed} 个、释放 ${(freed / 1048576).toFixed(0)}MB`)

// 5. 启动（detached，父进程退出后继续运行）
const child = spawn(appExe, [], { detached: true, stdio: 'ignore' })
child.unref()
log(`完成：v${fileVersion} 已更新并启动`)
