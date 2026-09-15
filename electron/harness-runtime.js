/**
 * 内置 Harness 运行时解包
 *
 * 为什么不在安装包里放原样的依赖树：dsh 依赖树约 2.6 万个文件（217MB），
 * NSIS 安装器要先把它们解压到临时目录、再整树复制到安装目录，Windows 上实测
 * 需要约 16 分钟（同样内容直接复制约 1 分钟），用户会以为安装卡死。
 * 改为随包分发**单个归档** harness-runtime.tar.gz（安装器只写 1 个文件，约 49MB），
 * 首次使用时解包到用户数据目录，之后按版本标记复用（实测系统 tar 约 26 秒）。
 *
 * 目录取 <userData>/runtime（短路径）：依赖树里最深的相对路径约 166 字符，
 * 加上带版本号的目录名会超过 Windows 默认 260 字符上限。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** 随包分发的归档与版本标记（标记即 build/harness-runtime/runtime.json） */
const ARCHIVE_NAME = 'harness-runtime.tar.gz'
const MARKER_NAME = 'harness-runtime.json'
/** 归档内顶层目录名，解包时剥掉 */
const TOP_DIR = 'harness-runtime'
/** 解包完成标记：内容为随包版本标记，用于判断是否需要重新解包 */
const COMPLETE = '.complete'
/**
 * 应用内热更新标记：记录「这个运行时目录是用户更新到哪个 dsh 版本」。
 * 存在且版本不低于随包版本时，目录被复用而不是被随包归档覆盖
 * （否则每次启动都会把用户刚更新好的版本重新解包回随包旧版本）。
 */
const HOT = '.hot.json'

let cachedDir = ''
let pending = null

function log(...args) {
  console.log('[harness-runtime]', ...args)
}

function resourcesDir() {
  try { return process.resourcesPath || '' } catch { return '' }
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate } catch { /* noop */ }
  }
  return ''
}

/** 随包分发的文件路径（resources 优先，开发态回落到 build/） */
function shippedFile(name) {
  const res = resourcesDir()
  return firstExisting([
    res && path.join(res, name),
    path.join(__dirname, '..', 'build', name),
  ])
}

/** 随包分发的归档路径；开发态回落到 build/ */
function shippedArchive() {
  return shippedFile(ARCHIVE_NAME)
}

function shippedMarkerFile() {
  return shippedFile(MARKER_NAME)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function shippedMarker() {
  return readJson(shippedMarkerFile())
}

/** 解包根目录（用户数据目录；安装目录通常只读，不能往里写） */
function extractBase() {
  const override = (process.env.DSH_RUNTIME_CACHE || '').trim()
  if (override) return override
  try {
    const { app } = require('electron')
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'runtime')
  } catch { /* 非 Electron 环境（自测脚本） */ }
  return path.join(os.homedir(), '.dev-project-manager', 'runtime')
}

function runtimeEntry(dir) {
  return path.join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** 解包是否已完成且版本一致 */
function hasRuntime(dir) {
  if (!dir) return false
  try {
    if (!fs.existsSync(runtimeEntry(dir))) return false
    const done = readJson(path.join(dir, COMPLETE))
    const expected = shippedMarker()
    if (!expected) return true
    return !!done && JSON.stringify(done) === JSON.stringify(expected)
  } catch { return false }
}

/** 运行时目录里 dsh 自身的版本（读依赖树里的 package.json，是磁盘事实而非标记） */
function installedVersion(dir) {
  if (!dir) return ''
  const pkg = readJson(path.join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  return (pkg && pkg.version) || ''
}

/** 热更新标记文件路径（供 electron/harness-update.js 写入） */
function hotMarkerPath(dir = extractBase()) {
  return path.join(dir, HOT)
}

/**
 * 目录是否是可复用的**热更新**运行时：标记、磁盘版本、平台与补丁号四者自洽，
 * 且版本不低于随包版本（随包版本更新时以随包为准，重新解包）。
 * 校验磁盘版本是刻意的：标记可能残留于被覆盖过的目录，只有版本对得上才算数。
 */
function reusableHotRuntime(dir) {
  if (!dir) return false
  try {
    if (!fs.existsSync(runtimeEntry(dir))) return false
    const hot = readJson(hotMarkerPath(dir))
    if (!hot || !hot.dshVersion) return false
    if (installedVersion(dir) !== hot.dshVersion) return false
    const shipped = shippedMarker()
    if (!shipped) return true
    if (hot.platform !== shipped.platform || hot.arch !== shipped.arch) return false
    // 随包补丁号更新（改了 CREATE_NO_WINDOW 补丁点）时随包树优先，重新解包
    if ((hot.win32NoWindowPatch || 0) !== (shipped.win32NoWindowPatch || 0)) return false
    const { compareVersions } = require('./version-compare')
    return compareVersions(hot.dshVersion, shipped.dshVersion) >= 0
  } catch { return false }
}

/** 系统 tar（Windows 10+ 自带 bsdtar；POSIX 一定有）——比纯 JS 解包快约 7 倍 */
function systemTar() {
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows'
    const bundled = path.join(root, 'System32', 'tar.exe')
    try { if (fs.existsSync(bundled)) return bundled } catch { /* noop */ }
  }
  return 'tar'
}

/** 系统 tar 解包；成功返回 true（DSH_RUNTIME_FORCE_JS=1 可强制走 JS 解包器，自测用） */
function extractWithSystemTar(archive, target, entryProbe) {
  if (process.env.DSH_RUNTIME_FORCE_JS === '1') return false
  try {
    const result = spawnSync(systemTar(), ['-xzf', archive, '-C', target, '--strip-components=1'],
      { stdio: 'ignore', windowsHide: true })
    return result.status === 0 && entryProbe(target)
  } catch { return false }
}

/** 纯 JS 兜底解包（系统 tar 缺失或被拦截时） */
async function extractWithJsTar(archive, target, entryProbe) {
  const tar = require('tar')
  await tar.x({ file: archive, cwd: target, strip: 1 })
  if (!entryProbe(target)) throw new Error('解包后未找到入口文件')
}

/**
 * 通用归档解包：清空目标目录 → 系统 tar（快）→ 失败回退 JS 解包器。
 * 同时供内置 dsh 运行时与热更新用的 npm 运行时使用。
 * @param {(dir: string) => boolean} [opts.entry] 入口校验（缺省只要求目录存在）
 */
async function extractArchive(archive, target, opts = {}) {
  const entryProbe = typeof opts.entry === 'function' ? opts.entry : (dir) => fs.existsSync(dir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  if (opts.onStage) opts.onStage('extract')
  if (extractWithSystemTar(archive, target, entryProbe)) return
  log('系统 tar 解包失败，改用内置解包器…')
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  await extractWithJsTar(archive, target, entryProbe)
}

/**
 * 随包原样目录（开发态 <repo>/build 或旧布局 <resources>/harness-runtime）。
 * DSH_RUNTIME_CACHE 指定缓存目录时跳过（自测/排查用，强制走解包路径）。
 */
function looseRuntime() {
  if ((process.env.DSH_RUNTIME_CACHE || '').trim()) return ''
  const res = resourcesDir()
  const dir = firstExisting([
    res && path.join(res, TOP_DIR),
    path.join(__dirname, '..', 'build', TOP_DIR),
  ])
  return dir && fs.existsSync(path.join(dir, 'dsh')) ? dir : ''
}

/**
 * 当前实际会被使用的运行时目录与来源：
 *   override=DSH_RUNTIME_DIR 指定 / loose=随包原样目录（开发态）/ extracted=用户目录（解包或热更新）
 *   archive=仅随包归档（尚未解包）/ none=都没有
 */
function resolveRuntime() {
  const override = (process.env.DSH_RUNTIME_DIR || '').trim()
  if (override) {
    const ok = fs.existsSync(path.join(override, 'dsh'))
    return { dir: ok ? override : '', source: ok ? 'override' : 'none' }
  }
  const loose = looseRuntime()
  if (loose) return { dir: loose, source: 'loose' }
  const target = extractBase()
  if (reusableHotRuntime(target)) return { dir: target, source: 'extracted' }
  if (hasRuntime(target)) return { dir: target, source: 'extracted' }
  if (shippedArchive()) return { dir: '', source: 'archive' }
  return { dir: '', source: 'none' }
}

/** 随包 dsh 版本（无归档时为空串） */
function shippedVersion() {
  const shipped = shippedMarker()
  return (shipped && shipped.dshVersion) || ''
}

/** 当前运行时的 dsh 版本：优先读磁盘事实，无运行时则回落到随包版本 */
function currentRuntimeVersion() {
  const { dir } = resolveRuntime()
  return (dir && installedVersion(dir)) || shippedVersion()
}

/**
 * 确保内置运行时可用，返回运行时目录（不可用时返回空串，由调用方回退到系统 dsh）。
 *
 * 优先级：DSH_RUNTIME_DIR 显式指定 → 随包原样目录（开发态/旧布局）→ 已解包目录
 *        （含应用内热更新装出来的版本）→ 解包归档。
 * 幂等：同一版本重复调用直接复用；并发调用共享同一次解包。
 *
 * @param {{onStage?: (stage: string) => void}} [opts]
 */
async function ensureBundledRuntime(opts = {}) {
  const override = (process.env.DSH_RUNTIME_DIR || '').trim()
  if (override) return fs.existsSync(path.join(override, 'dsh')) ? override : ''

  const loose = looseRuntime()
  if (loose) { cachedDir = loose; return loose }

  const target = extractBase()
  // 热更新装出来的运行时同样在此复用，否则会被随包归档覆盖回旧版本
  if (reusableHotRuntime(target) || hasRuntime(target)) { cachedDir = target; return target }

  const archive = shippedArchive()
  if (!archive) return ''
  if (pending) return pending

  pending = (async () => {
    try {
      const started = Date.now()
      log(`解包内置运行时：${archive} → ${target}`)
      await extractArchive(archive, target, { entry: runtimeEntry, onStage: opts.onStage })
      fs.writeFileSync(path.join(target, COMPLETE), JSON.stringify(shippedMarker() || {}, null, 2))
      cachedDir = target
      log(`内置运行时就绪（${Math.round((Date.now() - started) / 1000)} 秒）：${runtimeEntry(target)}`)
      return target
    } catch (err) {
      log('解包失败：', (err && err.message) || String(err))
      try { fs.rmSync(target, { recursive: true, force: true }) } catch { /* noop */ }
      return ''
    } finally {
      pending = null
    }
  })()
  return pending
}

/** resolveLaunch 等同步路径使用：已解包（或原样目录）的运行时位置 */
function cachedRuntimeDir() {
  return cachedDir
}

/** 是否随包分发了内置运行时（归档存在即可，不必等解包完成） */
function hasShippedRuntime() {
  return !!shippedArchive()
}

module.exports = {
  ensureBundledRuntime,
  cachedRuntimeDir,
  hasShippedRuntime,
  shippedArchive,
  shippedMarkerFile,
  shippedFile,
  shippedVersion,
  extractBase,
  extractArchive,
  runtimeEntry,
  resolveRuntime,
  currentRuntimeVersion,
  installedVersion,
  reusableHotRuntime,
  hotMarkerPath,
  HOT_MARKER: HOT,
}
