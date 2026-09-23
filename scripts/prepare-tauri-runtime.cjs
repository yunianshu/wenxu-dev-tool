/** 准备 Tauri 随包 Node 与后台生产依赖；产物仅写入 build/tauri-runtime。 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const out = path.join(root, 'build', 'tauri-runtime')
const pkg = require('../package.json')
const nodeVersion = process.versions.node.split('.').map(Number)
if (nodeVersion[0] !== 24) throw new Error(`需要 Node 24 构建随包运行时，当前为 ${process.version}`)

fs.mkdirSync(out, { recursive: true })
const backendPackages = ['@napi-rs/keyring', 'archiver', 'node-pty', 'ssh2', 'tar', 'yaml']
const dependencies = Object.fromEntries(backendPackages.map((name) => {
  if (!pkg.dependencies[name]) throw new Error(`后台依赖缺失：${name}`)
  return [name, pkg.dependencies[name]]
}))
const manifest = { name: 'personnel-plm-backend', version: pkg.version, private: true, dependencies }
const manifestPath = path.join(out, 'package.json')
const next = JSON.stringify(manifest, null, 2)
const changed = !fs.existsSync(manifestPath) || fs.readFileSync(manifestPath, 'utf8') !== next
if (changed) fs.writeFileSync(manifestPath, next)

const binary = path.join(out, process.platform === 'win32' ? 'node.exe' : 'node')
const bundledVersion = fs.existsSync(binary)
  ? spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim()
  : ''
if (bundledVersion !== process.version) {
  fs.copyFileSync(process.execPath, binary)
}
if (process.platform !== 'win32') fs.chmodSync(binary, 0o755)
const installed = path.join(out, 'node_modules', 'node-pty', 'package.json')
if (changed || !fs.existsSync(installed)) {
  const args = ['install', '--prefix', out, '--omit=dev', '--no-audit', '--no-fund']
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd: out, stdio: 'inherit', windowsHide: true })
    : spawnSync('npm', args, { cwd: out, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`后台依赖安装失败：exit=${result.status}`)
}
// node-pty 的 npm 包仅提供 Windows/macOS 预编译产物；Linux 在构建机显式编译。
// 这里不修改 npm 的脚本信任记录，且不会在目标机器上执行编译。
if (process.platform === 'linux') {
  const ptyDir = path.join(out, 'node_modules', 'node-pty')
  const nativeAddon = path.join(ptyDir, 'build', 'Release', 'pty.node')
  if (!fs.existsSync(nativeAddon)) {
    const gyp = require.resolve('node-gyp/bin/node-gyp.js')
    const result = spawnSync(binary, [gyp, 'rebuild'], { cwd: ptyDir, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Linux node-pty 编译失败：exit=${result.status}`)
  }
}
// 仅在本任务生成的运行时目录内裁剪其他平台的 PTY 二进制和 Windows 调试符号。
const workspace = fs.realpathSync(root)
const generated = fs.realpathSync(out)
if (!generated.startsWith(workspace + path.sep)) throw new Error('运行时目录不在项目工作区内，拒绝裁剪')
const prebuilds = path.join(generated, 'node_modules', 'node-pty', 'prebuilds')
if (fs.existsSync(prebuilds)) {
  const actual = fs.realpathSync(prebuilds)
  if (actual !== prebuilds) throw new Error('PTY 预编译目录不是预期路径，拒绝裁剪')
  const current = `${process.platform}-${process.arch}`
  for (const item of fs.readdirSync(actual, { withFileTypes: true })) {
    const target = path.join(actual, item.name)
    if (path.dirname(fs.realpathSync(target)) !== actual) throw new Error('PTY 裁剪目标越界')
    if (item.isDirectory() && item.name !== current) fs.rmSync(target, { recursive: true, force: true })
    else if (item.name === current && item.isDirectory() && process.platform === 'win32') {
      for (const file of fs.readdirSync(target)) {
        if (file.endsWith('.pdb')) fs.unlinkSync(path.join(target, file))
      }
    }
  }
}
const probe = spawnSync(binary, ['-e', "require('node-pty'); require('ssh2'); require('tar'); require('@napi-rs/keyring');"], {
  cwd: out, encoding: 'utf8', windowsHide: true,
})
if (probe.status !== 0) throw new Error(`后台原生依赖校验失败：${probe.stderr || probe.stdout}`)
console.log(`[tauri-runtime] Node ${process.version} 与后台依赖就绪`)
