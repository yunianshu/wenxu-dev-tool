/**
 * 内置运行时更新自测（合成资源 + 假 registry + 桩 npm，秒级）
 *
 * 验收标准（源自需求「监听 dsh 是否有更新 → 有更新要提示 → 可在应用内热更新」）：
 *   U1  版本比较正确处理预发布版本（alpha < rc < 正式版）；
 *       最新版本取「源上版本号最大的一个，含预发布」，不受 dist-tags.latest 落后影响
 *   U2  发现源上有更新版本：updateAvailable=true，且首次发现时 notify=true（提示一次）
 *   U3  未到期不重复查询（6 小时节流），同一新版本不重复提示；检查口径变化后立即重查
 *   U4  源不可用时如实记录错误，不崩、不误报有新版本；源上无有效版本号时同样如实报错
 *   U5  应用内热更新：装到暂存目录 → 校验 → 交换 → 写热更新标记 → 目录内容为新版本
 *   U6  热更新装出来的运行时优先复用，不被随包归档覆盖回旧版本
 *   U7  随包版本更新时以随包为准（重新解包，热更新标记不再生效）
 *   U8  打补丁失败 / 版本不符时中止更新，且**保留原有运行时**
 *   U9  非随包形态（DSH_RUNTIME_DIR / 开发态源码目录）拒绝热更新
 *
 * 用法：node scripts/harness-update-selftest.cjs
 */
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const tar = require('tar')

const harnessPatch = require('../electron/harness-patch')
const { compareVersions, isNewer } = require('../electron/version-compare')

const SHIPPED = '0.1.5-alpha.1'
/** 源上真正最新（预发布）：比 dist-tags.latest 更高，更新目标必须是它 */
const LATEST = '0.1.7-rc.1'
/** dist-tags.latest：官方正式 tag 常年落后于 alpha/rc 迭代（实测真实源即如此） */
const LATEST_TAG = '0.1.5-rc.3'
const PLATFORM = process.platform
const ARCH = process.arch

/** 源上的 packument：versions 全集 + 落后的 dist-tags（与真实 @deepseek-ai/dsh 同形） */
const PACKUMENT = {
  'dist-tags': { latest: LATEST_TAG, next: LATEST, alpha: '0.1.7-alpha.2' },
  versions: Object.fromEntries(
    [SHIPPED, '0.1.5-rc.1', LATEST_TAG, '0.1.7-alpha.2', LATEST].map((v) => [v, {}]),
  ),
}

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假 dsh 树的补丁点（与 dsh-win32-process 真实代码同形的三处字面量） */
const PATCH_POINTS = [
  'const a = null, null, 1, 1028, environment',
  'createRestrictedProcess(api, options, commandLine, 4, startupInfo, processInfo)',
  'options.args), 0, startupInfo, processInfo) === 0',
].join('\n')

/** 桩 npm：按 --prefix 造出目标版本依赖树，并打印 http fetch 行以驱动进度计数 */
const STUB_NPM = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const argv = process.argv.slice(2)
const prefix = argv[argv.indexOf('--prefix') + 1]
const spec = String(argv[argv.length - 1] || '')
const version = spec.split('@').pop()
const mode = process.env.STUB_NPM_MODE || 'ok'
for (let i = 0; i < 5; i += 1) console.log('http fetch GET 200 https://registry.example/pkg-' + i)
const write = (rel, text) => {
  const file = path.join(prefix, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
write('node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: mode === 'wrong-version' ? '0.0.0-stub' : version }))
write('node_modules/@deepseek-ai/dsh/lib/bin.js', '// stub dsh entry\\n')
// 补丁点失配：写了文件但没有已知的三处创建标志位
if (mode === 'no-patch-points') write('node_modules/@deepseek-ai/dsh-win32-process/lib/index.js', '// no known create points\\n')
else write('node_modules/@deepseek-ai/dsh-win32-process/lib/index.js', ${JSON.stringify(PATCH_POINTS)} + '\\n')
// 真实安装是分钟级：慢一点才能覆盖进度轮询（自测专用）
setTimeout(() => process.exit(0), Number(process.env.STUB_NPM_MS || 0))
`

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

/** 造一棵最小 dsh 依赖树（与真实结构同形的入口路径 + 可读版本号） */
function writeRuntimeTree(dir, version) {
  writeJson(path.join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    { name: '@deepseek-ai/dsh', version })
  const entry = path.join(dir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, '// dsh entry\n')
  return entry
}

/** 假 registry：只服务 @deepseek-ai/dsh 的 packument（对象或函数，函数用于按状态切换内容） */
function startRegistry(packument, state) {
  const server = http.createServer((req, res) => {
    state.hits += 1
    if (state.failWith) {
      res.writeHead(state.failWith, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (!req.url.startsWith('/@deepseek-ai%2fdsh') && !req.url.startsWith('/@deepseek-ai/dsh')) {
      res.writeHead(404); res.end('{}'); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(typeof packument === 'function' ? packument() : packument))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-harness-update-'))
  const resDir = path.join(root, 'resources')
  const cacheDir = path.join(root, 'runtime')
  fs.mkdirSync(resDir, { recursive: true })

  // ── 合成「随包资源」：运行时归档 + 版本标记 + 更新组件（桩 npm）归档 + 标记 ──
  const srcTree = path.join(root, 'src')
  writeRuntimeTree(srcTree, SHIPPED)
  await tar.c({ gzip: true, cwd: srcTree, file: path.join(resDir, 'harness-runtime.tar.gz'), portable: true }, ['dsh'])
  const shippedMarker = {
    dshVersion: SHIPPED, platform: PLATFORM, arch: ARCH,
    win32NoWindowPatch: harnessPatch.WIN32_NO_WINDOW_PATCH,
  }
  writeJson(path.join(resDir, 'harness-runtime.json'), shippedMarker)

  const updaterSrc = path.join(root, 'updater-src', 'harness-updater', 'node_modules', 'npm', 'bin')
  fs.mkdirSync(updaterSrc, { recursive: true })
  fs.writeFileSync(path.join(updaterSrc, 'npm-cli.js'), STUB_NPM)
  await tar.c({ gzip: true, cwd: path.join(root, 'updater-src'), file: path.join(resDir, 'harness-updater.tar.gz'), portable: true }, ['harness-updater'])
  const updaterMarker = { npmVersion: '0.0.0-stub', platform: PLATFORM, arch: ARCH }
  writeJson(path.join(resDir, 'harness-updater.json'), updaterMarker)

  // 打包态模拟：resources 指向临时目录，缓存目录指定到临时目录，跳过开发态原样目录
  process.resourcesPath = resDir
  process.env.DSH_RUNTIME_CACHE = cacheDir
  delete process.env.DSH_RUNTIME_DIR
  delete process.env.STUB_NPM_MODE

  const rt = require('../electron/harness-runtime')
  const update = require('../electron/harness-update')

  // ── U1 版本比较 ──
  check('U1a 预发布版本排序（alpha < rc < 正式版）',
    compareVersions('0.1.5-alpha.1', '0.1.5-rc.1') < 0
    && compareVersions('0.1.5-rc.1', '0.1.5') < 0
    && compareVersions('1.0.0-beta.2', '1.0.0-beta.11') < 0
    && compareVersions('1.0.0', '1.0.0-alpha') > 0)
  check('U1b 构建元数据不参与比较 / 非法版本不误判',
    compareVersions('1.2.3+build.5', '1.2.3') === 0
    && compareVersions('v1.2.3', '1.2.3') === 0
    && isNewer('garbage', '1.0.0') === false
    && isNewer('1.0.1', 'not-a-version') === false)
  check('U1c 同版本不算更新 / 旧版本不算更新',
    isNewer('0.1.5-alpha.1', '0.1.5-alpha.1') === false
    && isNewer('0.1.5-alpha.1', '0.1.5-rc.1') === false)
  // 需求口径：升级要定位到「源上最新」，预发布版本也算——不能停在落后的 dist-tags.latest
  check('U1d 最新版本取含预发布的版本号最大者（忽略落后的 latest tag）',
    update.pickLatestVersion(PACKUMENT) === LATEST
    && update.pickLatestVersion(PACKUMENT) !== LATEST_TAG)
  check('U1e 更高号正式版优先于预发布 / v 前缀与脏 tag 值不误选',
    update.pickLatestVersion({ versions: { '0.1.7-rc.1': {}, '0.2.0': {} } }) === '0.2.0'
    && update.pickLatestVersion({ 'dist-tags': { latest: 'v1.2.3' }, versions: { '1.2.3': {} } }) === '1.2.3'
    && update.pickLatestVersion({ 'dist-tags': { latest: 'beta' } }) === '')
  check('U1f packument 只有 dist-tags 时退化可用',
    update.pickLatestVersion({ 'dist-tags': { latest: LATEST_TAG } }) === LATEST_TAG
    && update.pickLatestVersion({}) === '')

  // 造出「已解包的随包运行时」
  const runtimeDir = await rt.ensureBundledRuntime()
  check('U0 随包运行时已解包（前置）', runtimeDir === cacheDir && rt.currentRuntimeVersion() === SHIPPED,
    `${runtimeDir} / ${rt.currentRuntimeVersion()}`)

  // ── U2 检查更新 ──
  const registryState = { hits: 0, failWith: 0 }
  const server = await startRegistry(() => (registryState.empty ? {} : PACKUMENT), registryState)
  const registry = `http://127.0.0.1:${server.address().port}`

  const events = []
  update.setEmitter((payload) => events.push(payload))

  const first = await update.check({ force: true, registry })
  check(`U2a 发现新版本（${SHIPPED} → ${LATEST}，非落后的 ${LATEST_TAG}）`,
    first.updateAvailable === true && first.latest === LATEST && first.current === SHIPPED,
    `${first.current} → ${first.latest}`)
  check('U2b 首次发现新版本时要求提示（notify=true）', events.some((e) => e.notify === true))
  check('U2c 检查结果落盘（下次启动仍能提示）',
    JSON.parse(fs.readFileSync(path.join(root, 'harness-update.json'), 'utf8')).latestVersion === LATEST)

  // ── U3 节流与去重提示 ──
  const hitsAfterFirst = registryState.hits
  const second = await update.check({ registry }) // 未 force：6 小时内不再查询
  check('U3a 未到期不重复查询', registryState.hits === hitsAfterFirst && second.latest === LATEST,
    `hits=${registryState.hits}`)
  events.length = 0
  await update.check({ force: true, registry })
  check('U3b 同一新版本不重复提示', !events.some((e) => e.notify === true))

  // 旧版本应用留下的状态里没有检查口径标记：升级后必须立即按新口径重查一次，
  // 否则界面会拿着旧结论（比如「已是最新」）再显示 6 小时
  const statePath = path.join(root, 'harness-update.json')
  const staleState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  delete staleState.checkPolicy
  staleState.lastCheckAt = Date.now()
  fs.writeFileSync(statePath, JSON.stringify(staleState))
  const hitsBeforePolicyChange = registryState.hits
  const repolicy = await update.check({ registry })
  check('U3c 检查口径变化后忽略节流重查',
    registryState.hits > hitsBeforePolicyChange && repolicy.latest === LATEST
    && JSON.parse(fs.readFileSync(statePath, 'utf8')).checkPolicy === update.CHECK_POLICY,
    `hits=${registryState.hits}`)

  // ── U4 源不可用 ──
  const checkedAtBeforeFail = JSON.parse(fs.readFileSync(path.join(root, 'harness-update.json'), 'utf8')).lastCheckAt
  registryState.failWith = 500
  const failedCheck = await update.check({ force: true, registry })
  check('U4 源不可用时如实记录错误且不误报有新版本',
    failedCheck.error.includes('500') && failedCheck.install.status === 'idle',
    failedCheck.error)
  // 失败也记账会把「开机时网络/VPN 未就绪」的一次失败顺延成 6 小时不再自动检查
  check('U4b 检查失败不推进 lastCheckAt',
    JSON.parse(fs.readFileSync(path.join(root, 'harness-update.json'), 'utf8')).lastCheckAt === checkedAtBeforeFail,
    `${checkedAtBeforeFail}`)
  registryState.failWith = 0

  // 源被占位页/镜像接管、packument 里没有任何合法版本号：如实报错，并保留上次已知结论
  registryState.empty = true
  const emptyCheck = await update.check({ force: true, registry })
  check('U4c 源上没有有效版本号时如实记录错误（保留上次结论）',
    /未找到有效的版本号/.test(emptyCheck.error) && emptyCheck.latest === LATEST, emptyCheck.error)
  registryState.empty = false

  // ── U5 应用内热更新（桩 npm 造树） ──
  // 桩 npm 睡够一个进度采样周期，覆盖「下载依赖 → 安装依赖」的阶段广播
  process.env.STUB_NPM_MS = '2200'
  const result = await update.install({ version: LATEST, registry })
  check('U5a 更新成功', result.ok === true && result.version === LATEST, result.error || '')
  check('U5b 运行时目录已换成新版本',
    rt.currentRuntimeVersion() === LATEST && rt.installedVersion(cacheDir) === LATEST,
    rt.currentRuntimeVersion())
  const hot = JSON.parse(fs.readFileSync(rt.hotMarkerPath(cacheDir), 'utf8'))
  check('U5c 写入热更新标记（版本/补丁号/平台自洽）',
    hot.dshVersion === LATEST && hot.win32NoWindowPatch === harnessPatch.WIN32_NO_WINDOW_PATCH
    && hot.platform === PLATFORM && hot.arch === ARCH && hot.source === 'registry')
  check('U5d 暂存目录已清理', !fs.existsSync(path.join(root, 'rt-new')))
  check('U5e 安装进度有阶段广播',
    ['preparing', 'downloading', 'installing', 'verifying', 'swapping', 'done'].every((s) => events.some((e) => e.install.status === s)),
    [...new Set(events.map((e) => e.install.status))].join(','))
  if (PLATFORM === 'win32') {
    check('U5f 新运行时已带 CREATE_NO_WINDOW 补丁', harnessPatch.isRuntimePatched(cacheDir) === true)
  }

  // ── U6 热更新运行时优先复用（核心不变量：不能被随包归档覆盖回旧版本） ──
  fs.writeFileSync(path.join(cacheDir, 'sentinel.txt'), 'hot')
  const reused = await rt.ensureBundledRuntime()
  check('U6 热更新运行时被复用（未被随包旧版本覆盖）',
    reused === cacheDir && rt.currentRuntimeVersion() === LATEST && fs.existsSync(path.join(cacheDir, 'sentinel.txt')),
    rt.currentRuntimeVersion())

  // ── U8 失败保护：打补丁失败 / 版本不符 → 中止且保留现有运行时 ──
  process.env.STUB_NPM_MODE = 'no-patch-points'
  delete process.env.STUB_NPM_MS
  const patchFail = await update.install({ version: '0.1.6-stub', registry })
  check('U8a 补丁点失配时中止更新', patchFail.ok === false && /补丁点/.test(patchFail.error), patchFail.error)
  check('U8b 中止后保留原运行时（版本仍是热更新版本）',
    rt.currentRuntimeVersion() === LATEST && rt.installedVersion(cacheDir) === LATEST)
  check('U8c 中止后暂存目录已清理', !fs.existsSync(path.join(root, 'rt-new')))

  process.env.STUB_NPM_MODE = 'wrong-version'
  const versionFail = await update.install({ version: '0.1.6-stub', registry })
  check('U8d 安装出的版本不符时中止', versionFail.ok === false && /版本不符/.test(versionFail.error), versionFail.error)
  check('U8e 中止后运行时未被破坏', rt.currentRuntimeVersion() === LATEST)
  delete process.env.STUB_NPM_MODE

  // 新树通过静态校验、但重启服务失败时，应把旧树放回去并恢复旧服务。
  const harnessService = require('../electron/harness-service')
  const originals = {
    status: harnessService.status, stop: harnessService.stop,
    restart: harnessService.restart, start: harnessService.start,
  }
  let oldServiceRestarted = false
  harnessService.status = () => ({ status: 'running' })
  harnessService.stop = () => ({ status: 'stopped' })
  harnessService.restart = async () => ({ status: 'error', error: '合成启动失败' })
  harnessService.start = async () => { oldServiceRestarted = true; return { status: 'running' } }
  const restartFail = await update.install({ version: '0.1.7-stub', registry })
  Object.assign(harnessService, originals)
  check('U8f 新服务启动失败时回滚旧运行时', restartFail.ok === false
    && /合成启动失败/.test(restartFail.error) && rt.installedVersion(cacheDir) === LATEST)
  check('U8g 回滚后旧服务重新启动且备份已归位', oldServiceRestarted
    && !fs.existsSync(path.join(root, 'rt-old')) && !fs.existsSync(path.join(root, 'rt-new')))

  // ── U9 非随包形态拒绝热更新 ──
  const overrideDir = path.join(root, 'override')
  fs.mkdirSync(path.join(overrideDir, 'dsh'), { recursive: true })
  process.env.DSH_RUNTIME_DIR = overrideDir
  const guardStatus = update.status()
  const refused = await update.install({ version: LATEST, registry })
  check('U9 DSH_RUNTIME_DIR 指定运行时时拒绝热更新',
    guardStatus.canUpdate === false && refused.ok === false && /DSH_RUNTIME_DIR/.test(refused.error),
    refused.error)
  delete process.env.DSH_RUNTIME_DIR

  // ── U7 随包版本更新时以随包为准 ──
  writeJson(path.join(resDir, 'harness-runtime.json'), { ...shippedMarker, dshVersion: '9.9.9' })
  check('U7a 随包版本更新后热更新标记不再生效', rt.reusableHotRuntime(cacheDir) === false)
  const afterUpgrade = await rt.ensureBundledRuntime()
  check('U7b 重新解包随包运行时（覆盖热更新目录）',
    afterUpgrade === cacheDir && !fs.existsSync(path.join(cacheDir, 'sentinel.txt'))
    && JSON.parse(fs.readFileSync(path.join(cacheDir, '.complete'), 'utf8')).dshVersion === '9.9.9')
  check('U7c 热更新标记随目录一起被替换（不残留）',
    !fs.existsSync(rt.hotMarkerPath(cacheDir)))
  writeJson(path.join(resDir, 'harness-runtime.json'), shippedMarker)

  // ── 补丁实现（构建期与运行时共用）──
  const patchDir = path.join(root, 'patch-probe')
  fs.mkdirSync(path.join(patchDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(patchDir, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js'), PATCH_POINTS)
  const patched = harnessPatch.patchRuntime(patchDir)
  const patchedAgain = harnessPatch.patchRuntime(patchDir)
  check('U10 补丁幂等（已打过不再改写）',
    (PLATFORM === 'win32' ? patched.patched === true : patched.reason === 'not-win32')
    && patchedAgain.patched === false, `${patched.reason || 'patched'} / ${patchedAgain.reason || ''}`)
  let missingMsg = ''
  try { harnessPatch.patchFile(path.join(root, 'nope', 'index.js')) } catch (err) { missingMsg = err.message }
  check('U11 补丁文件缺失时给出明确错误（不是裸 ENOENT）',
    /未找到 dsh-win32-process/.test(missingMsg), missingMsg)

  server.close()
  const resolvedRoot = fs.realpathSync(root)
  if (path.dirname(resolvedRoot) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolvedRoot).startsWith('pm-harness-update-')) {
    throw new Error('拒绝清理非本测试目录')
  }
  try { fs.rmSync(resolvedRoot, { recursive: true, force: true }) } catch { /* noop */ }
  console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
  process.exit(failed ? 1 : 0)
})().catch((err) => {
  console.error('自测异常：', err)
  process.exit(1)
})
