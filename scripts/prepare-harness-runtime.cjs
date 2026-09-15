/**
 * 准备内置 DeepSeek Harness 依赖树（构建期，幂等）
 *
 * 目标：让用户机器**不装 dsh、不装 Node** 也能使用 Harness。
 * 产物：
 *   build/harness-runtime/dsh/node_modules/@deepseek-ai/dsh/...  —— dsh 依赖树（中间产物，不打进安装包）
 *   build/harness-runtime.tar.gz                                 —— 依赖树单文件归档（**随包分发**）
 *   build/harness-runtime.json                                   —— 版本标记，运行时据此判断是否需要重新解包
 *   build/harness-updater.tar.gz + harness-updater.json          —— 随包 npm（应用内热更新内置 dsh 用，**随包分发**）
 *
 * 为什么打成单个归档：依赖树约 2.6 万个文件（264MB），原样放进 NSIS 安装包时
 * 安装器要逐文件解压到临时目录再整树复制，Windows 实测约 16 分钟（同样内容直接
 * 复制约 1 分钟），用户会以为安装卡死。单文件只需数秒，首次启动再由
 * electron/harness-runtime.js 解包到用户数据目录。npm 组件同理（1.1 万个文件）。
 *
 * 运行时用的是 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1` + `--expose-internals`），
 * 因此这里不再下载独立 Node 运行时——Electron 40+ 内置 Node 24，
 * 具备 dsh 需要的 `node:sqlite` 与 `import.meta.main`。
 *
 * 为什么随包 npm：应用内热更新要在**没有 Node/npm 的机器**上安装新版本 dsh，
 * 而依赖解析（范围、可选依赖、平台过滤、提升与冲突嵌套）是 npm 的活。
 * npm 官方包自带全部依赖，压缩后约 3MB，用 Electron 自带的 Node 执行即可。
 *
 * 幂等：已存在且版本标记一致时直接跳过；可用 DSH_RUNTIME_FORCE=1 强制重建。
 * 版本可用环境变量覆盖：DSH_VERSION / HARNESS_NPM_VERSION。
 * 用法：node scripts/prepare-harness-runtime.cjs [--platform win32 --arch x64]
 */
const { spawnSync } = require('child_process')
const https = require('https')
const fs = require('fs')
const path = require('path')
const harnessPatch = require('../electron/harness-patch')

const ROOT = path.resolve(__dirname, '..')
const BUILD_DIR = path.join(ROOT, 'build')
const OUT_DIR = path.join(BUILD_DIR, 'harness-runtime')
const ARCHIVE = path.join(BUILD_DIR, 'harness-runtime.tar.gz')
const SHIPPED_MARKER = path.join(BUILD_DIR, 'harness-runtime.json')
/** dsh 需要 Node ≥22.5 的 node:sqlite 与 ≥22.18 的 import.meta.main（Electron 40+ 内置 Node 24） */
const DSH_VERSION = process.env.DSH_VERSION || '0.1.5-alpha.1'
/** 随包 npm 组件（应用内热更新用）的产物路径 */
const UPDATER_DIR = path.join(BUILD_DIR, 'harness-updater')
const UPDATER_ARCHIVE = path.join(BUILD_DIR, 'harness-updater.tar.gz')
const UPDATER_MARKER = path.join(BUILD_DIR, 'harness-updater.json')
/** 空串=取源上 latest；指定则固定版本（可复现构建用） */
const UPDATER_NPM_VERSION = process.env.HARNESS_NPM_VERSION || ''
const REGISTRY = (process.env.HARNESS_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
/**
 * dsh-win32-process 补丁号（补丁实现与运行时热更新共用 electron/harness-patch.js）。
 * 创建进程时缺 CREATE_NO_WINDOW 会让 Harness 会话每执行一次命令弹一个空白终端窗口
 * （进程链以 ELECTRON_RUN_AS_NODE 跑，没有控制台）。补丁号变化会改变版本标记，
 * 触发客户端重新解包，并让热更新装出的旧树不再被复用。
 */
const WIN32_NO_WINDOW_PATCH = harnessPatch.WIN32_NO_WINDOW_PATCH
const MARKER = path.join(OUT_DIR, 'runtime.json')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const PLATFORM = arg('platform', process.platform)
const ARCH = arg('arch', process.arch)

function log(...args) {
  console.log('[harness-runtime]', ...args)
}

function dirSizeMB(dir) {
  let total = 0
  const walk = (p) => {
    for (const item of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, item.name)
      if (item.isDirectory()) walk(full)
      else if (item.isFile()) total += fs.statSync(full).size
    }
  }
  try { walk(dir) } catch { /* noop */ }
  return (total / 1048576).toFixed(0)
}

function installDsh() {
  const dshDir = path.join(OUT_DIR, 'dsh')
  const entry = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (fs.existsSync(entry)) {
    log(`dsh 依赖树已存在：${entry}`)
    return entry
  }
  fs.mkdirSync(dshDir, { recursive: true })
  fs.writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: 'harness-runtime', private: true }, null, 2))
  log(`安装 @deepseek-ai/dsh@${DSH_VERSION}（约 260MB，首次较慢）`)
  const npmArgs = ['install', '--prefix', dshDir, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', `@deepseek-ai/dsh@${DSH_VERSION}`]
  const command = PLATFORM === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm'
  const args = PLATFORM === 'win32' ? ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`] : npmArgs
  const result = spawnSync(command, args, { cwd: dshDir, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(entry)) {
    throw new Error(`安装 @deepseek-ai/dsh@${DSH_VERSION} 失败（exit=${result.status}）`)
  }
  log(`dsh 依赖树就绪：${entry}`)
  return entry
}

/** 把依赖树打成单文件归档（幂等：归档与标记都比依赖树新则跳过） */
async function packArchive(expected) {
  const upToDate = (() => {
    if (process.env.DSH_RUNTIME_FORCE) return false
    if (!fs.existsSync(ARCHIVE) || !fs.existsSync(SHIPPED_MARKER)) return false
    try {
      const shipped = JSON.parse(fs.readFileSync(SHIPPED_MARKER, 'utf8'))
      if (JSON.stringify(shipped) !== JSON.stringify(expected)) return false
      return fs.statSync(ARCHIVE).mtimeMs >= fs.statSync(MARKER).mtimeMs
    } catch { return false }
  })()
  if (upToDate) {
    log(`归档已是最新，跳过：${ARCHIVE}`)
    return
  }
  const tar = require('tar')
  log(`打包归档（约 ${dirSizeMB(OUT_DIR)} MB，gzip 压缩）…`)
  fs.rmSync(ARCHIVE, { force: true })
  await tar.c({ gzip: true, cwd: BUILD_DIR, file: ARCHIVE, portable: true }, ['harness-runtime'])
  fs.writeFileSync(SHIPPED_MARKER, JSON.stringify(expected, null, 2))
  log(`归档完成：${ARCHIVE}（${(fs.statSync(ARCHIVE).size / 1048576).toFixed(0)} MB）`)
}

/** 给内置依赖树打 CREATE_NO_WINDOW 补丁（实现与运行时热更新共用 electron/harness-patch.js） */
function patchWin32Console() {
  const result = harnessPatch.patchRuntime(OUT_DIR)
  if (result.patched) log(`已为 dsh-win32-process 补 CREATE_NO_WINDOW（v${WIN32_NO_WINDOW_PATCH}，3 处创建点）`)
  else log(`dsh-win32-process 补丁无需处理（${result.reason}）`)
}

/** 下载 npm 官方包（自带全部依赖）到指定文件 */
function download(url, target) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(target)
    const request = https.get(url, { timeout: 120000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close()
        fs.rmSync(target, { force: true })
        download(response.headers.location, target).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200) {
        file.close()
        reject(new Error(`下载失败 HTTP ${response.statusCode}：${url}`))
        return
      }
      response.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
    })
    request.on('timeout', () => request.destroy(new Error('下载超时')))
    request.on('error', (err) => { file.close(); reject(err) })
  })
}

async function fetchJson(url) {
  const raw = await new Promise((resolve, reject) => {
    https.get(url, { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' }, timeout: 60000 }, (response) => {
      if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}：${url}`)); return }
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve(text))
    }).on('error', reject)
  })
  return JSON.parse(raw)
}

/**
 * 用 Electron 自带的 Node 实跑随包 npm，确认它在目标环境可用。
 * 这是唯一能真正证明「随包组件能装包」的检查，所以构建期就做掉。
 */
function verifyUpdater(cli, version) {
  if (process.platform !== PLATFORM) {
    log(`跳过随包 npm 执行校验（交叉构建 platform=${PLATFORM}）`)
    return
  }
  const electronBin = (() => {
    try { const bin = require('electron'); return typeof bin === 'string' ? bin : '' } catch { return '' }
  })()
  if (!electronBin || !fs.existsSync(electronBin)) {
    log('跳过随包 npm 执行校验（未找到 Electron 可执行文件）')
    return
  }
  const result = spawnSync(electronBin, ['--expose-internals', cli, '--version'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  const out = String(result.stdout || '').trim()
  if (result.status !== 0 || out !== version) {
    throw new Error(`随包 npm 校验失败：期望 ${version}，实际 ${out || `exit=${result.status}`} ${String(result.stderr || '').trim()}`)
  }
  log(`随包 npm 校验通过（Electron 自带 Node 下运行）：${out}`)
}

/** 准备随包 npm 组件（幂等；HARNESS_SKIP_UPDATER=1 可跳过，此时应用内热更新不可用） */
async function prepareUpdater() {
  if (process.env.HARNESS_SKIP_UPDATER === '1') {
    log('已按 HARNESS_SKIP_UPDATER=1 跳过随包 npm 组件')
    return
  }
  const cli = path.join(UPDATER_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const upToDate = () => {
    if (process.env.DSH_RUNTIME_FORCE) return false
    if (!fs.existsSync(cli) || !fs.existsSync(UPDATER_ARCHIVE) || !fs.existsSync(UPDATER_MARKER)) return false
    try {
      const marker = JSON.parse(fs.readFileSync(UPDATER_MARKER, 'utf8'))
      return !!marker.npmVersion && fs.statSync(UPDATER_ARCHIVE).mtimeMs >= fs.statSync(cli).mtimeMs
    } catch { return false }
  }
  if (upToDate()) {
    verifyUpdater(cli, JSON.parse(fs.readFileSync(UPDATER_MARKER, 'utf8')).npmVersion)
    log('随包 npm 组件已是最新，跳过')
    return
  }
  const packument = await fetchJson(`${REGISTRY}/npm`)
  const version = UPDATER_NPM_VERSION || String((packument['dist-tags'] || {}).latest || '')
  if (!version) throw new Error('未能从源上解析 npm 版本（可用 HARNESS_NPM_VERSION 指定）')
  log(`下载 npm@${version}（随包分发，约 3MB）…`)
  // 临时目录放在 build/ 内：跨盘（C: 临时目录 → D: 仓库）rename 会 EXDEV
  const tmp = fs.mkdtempSync(path.join(BUILD_DIR, '.updater-'))
  const tgz = path.join(tmp, 'npm.tgz')
  const tarball = String((packument.versions || {})[version]
    ? packument.versions[version].dist.tarball
    : `${REGISTRY}/npm/-/npm-${version}.tgz`)
  await download(tarball, tgz)
  const tar = require('tar')
  await tar.x({ file: tgz, cwd: tmp })   // 官方 tarball 顶层目录为 package/
  const target = path.join(UPDATER_DIR, 'node_modules', 'npm')
  fs.rmSync(UPDATER_DIR, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(path.join(tmp, 'package'), target)
  fs.rmSync(tmp, { recursive: true, force: true })
  verifyUpdater(cli, version)

  log(`打包随包 npm 归档（约 ${dirSizeMB(UPDATER_DIR)} MB，gzip 压缩）…`)
  fs.rmSync(UPDATER_ARCHIVE, { force: true })
  await tar.c({ gzip: true, cwd: BUILD_DIR, file: UPDATER_ARCHIVE, portable: true }, ['harness-updater'])
  const marker = { npmVersion: version, platform: PLATFORM, arch: ARCH, registry: REGISTRY }
  fs.writeFileSync(UPDATER_MARKER, JSON.stringify(marker, null, 2))
  log(`随包 npm 就绪：${UPDATER_ARCHIVE}（${(fs.statSync(UPDATER_ARCHIVE).size / 1048576).toFixed(1)} MB）`)
}

async function main() {
  const expected = { dshVersion: DSH_VERSION, platform: PLATFORM, arch: ARCH, win32NoWindowPatch: WIN32_NO_WINDOW_PATCH }
  let needInstall = true
  if (!process.env.DSH_RUNTIME_FORCE && fs.existsSync(MARKER)) {
    try {
      const current = JSON.parse(fs.readFileSync(MARKER, 'utf8'))
      if (JSON.stringify(current) === JSON.stringify(expected)) {
        log('内置依赖树已是目标版本，跳过安装')
        needInstall = false
      }
    } catch { /* 标记损坏则重建 */ }
  }
  if (needInstall) {
    log(`准备内置依赖树：platform=${PLATFORM} arch=${ARCH} dsh=${DSH_VERSION}`)
    installDsh()
    fs.writeFileSync(MARKER, JSON.stringify(expected, null, 2))
    log(`依赖树完成：${OUT_DIR}（约 ${dirSizeMB(OUT_DIR)} MB）`)
  }
  patchWin32Console()
  await prepareUpdater()
  await packArchive(expected)
}

/** electron-builder beforePack 钩子入口；直接执行时也走同一逻辑 */
module.exports = async function beforePack() {
  await main()
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[harness-runtime] 失败：', err.message)
    process.exit(1)
  })
}
