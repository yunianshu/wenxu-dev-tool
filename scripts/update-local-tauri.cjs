/**
 * 一键打包并安装到本机（Tauri 通道）：`npm run update:local`
 *
 *   1. 补齐 cargo 的 PATH（本机实测 cargo 不在默认 PATH，直接跑 tauri build 会报
 *      `cargo metadata ... program not found`）
 *   2. npm run build:win —— tauri build --bundles nsis
 *   3. scripts/install-local-tauri.cjs —— 关闭应用、静默安装 /S、校验版本、清理旧包、启动
 *
 * 只想重装已有安装包时直接用 `npm run install:local`。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const env = { ...process.env }

// rustup 默认装在 ~/.cargo/bin，但常不在 PATH 里
const cargoBin = path.join(os.homedir(), '.cargo', 'bin')
const cargoExe = path.join(cargoBin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')
if (fs.existsSync(cargoExe)) {
  const parts = String(env.PATH || '').split(path.delimiter)
  if (!parts.some((p) => p.replace(/[\\/]+$/, '').toLowerCase() === cargoBin.toLowerCase())) {
    env.PATH = `${cargoBin}${path.delimiter}${env.PATH}`
    console.log(`[update-local] 已把 ${cargoBin} 加入 PATH`)
  }
} else {
  // cargo 正常执行时 status 为 0，用 !status 判断会把「可用」判成「找不到」
  const probe = spawnSync('cargo', ['--version'], { env, shell: process.platform === 'win32' })
  if (probe.error || probe.status !== 0) {
    console.error('[update-local] 失败: 找不到 cargo（Rust 工具链），请先安装 rustup')
    process.exit(1)
  }
}

/** npm 在 Windows 上是 npm.cmd，必须经 shell；命令固定在本脚本内，不拼接外部输入 */
function runNpm(label, script) {
  console.log(`[update-local] ${label}`)
  const r = spawnSync(`npm run ${script}`, { stdio: 'inherit', cwd: ROOT, env, shell: true })
  if (r.error) { console.error(`[update-local] 失败: ${r.error.message}`); process.exit(1) }
  if (r.status !== 0) { console.error(`[update-local] 失败: ${label}（退出码 ${r.status}）`); process.exit(r.status || 1) }
}

/** 直接调 node 可执行文件：路径含空格（C:\Program Files\nodejs\node.exe），绝不能经 shell */
function runNode(label, scriptPath) {
  console.log(`[update-local] ${label}`)
  const r = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit', cwd: ROOT, env })
  if (r.error) { console.error(`[update-local] 失败: ${r.error.message}`); process.exit(1) }
  if (r.status !== 0) { console.error(`[update-local] 失败: ${label}（退出码 ${r.status}）`); process.exit(r.status || 1) }
}

runNpm('打包：tauri build --bundles nsis …', 'build:win')
runNode('安装到本机 …', path.join(__dirname, 'install-local-tauri.cjs'))
