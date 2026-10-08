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
 *   U13 更新渠道（stable=正式版 / alpha=预发布）：
 *       U13a stable 目标 = dist-tags.latest；alpha 目标 = 全集版本号最大者（含预发布）
 *       U13b 渠道变化忽略 6 小时节流立即重查；切渠道后的新结论重新提示一次
 *       U13c 当前版本高于渠道目标（alpha 版上切回正式版）→ switchAvailable
 *       U13d 「切换」走同一条安装链路：装渠道目标版本（降级）成功
 *   U12 字节级下载进度（需求「下载总量/当前下载量/下载速度/安装进度」）：
 *       U12a 依赖分析给出精确总包数（lockfile 解析）
 *       U12b 下载总量 = tarball content-length 之和（HEAD 逐个测量）
 *       U12c 已下载字节为 npm 缓存实测增量且 > 0
 *       U12d 采样到非零下载速度（平滑值）
 *       U12e 安装阶段广播「已落盘包数 / 总包数」
 *       U12f 「分析依赖」阶段已广播
 *       U12g 依赖分析失败时降级为无总量，更新仍完成
 *       U12h tarball 大小测不到时降级（totalBytes=0），更新仍完成
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

/** 桩 npm：分析模式（--package-lock-only）写 lockfile；安装模式造树 + 按节拍向 npm 缓存
 *  写 tarball 字节（字节轮询实测的对象），节拍与时长由环境变量控制 */
const STUB_NPM = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const argv = process.argv.slice(2)
const prefix = argv[argv.indexOf('--prefix') + 1]
const registry = argv[argv.indexOf('--registry') + 1] || ''
const spec = String(argv[argv.length - 1] || '')
const version = spec.split('@').pop()
const mode = process.env.STUB_NPM_MODE || 'ok'
const lockOnly = argv.includes('--package-lock-only')
for (let i = 0; i < 3; i += 1) console.log('http fetch GET 200 https://registry.example/pkg-' + i)
if (lockOnly) {
  // 分析失败降级路径：该模式不产出 lockfile（真实 npm 对应解析报错/超时）
  if (mode === 'skip-lockfile') process.exit(0)
  const packages = { '': {} }
  for (let i = 0; i < 8; i += 1) {
    packages['node_modules/pkg-' + i] = { resolved: registry + '/pkg-' + i + '/-/pkg-' + i + '-1.0.0.tgz' }
  }
  // 其他平台的可选二进制：lockfile 会列出但本机不装，不得计入总包数/总量（U12i）
  packages['node_modules/@esbuild/darwin-arm64'] = { resolved: registry + '/esbuild-darwin/-/esbuild-darwin-arm64-1.0.0.tgz' }
  packages['node_modules/@img/sharp-linux-x64'] = { resolved: registry + '/sharp-linux/-/sharp-linux-x64-1.0.0.tgz' }
  fs.writeFileSync(path.join(prefix, 'package-lock.json'), JSON.stringify({ name: 'harness-runtime', lockfileVersion: 3, packages }))
  process.exit(0)
}
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
// 模拟下载节奏：tarball 内容按节拍落入 npm 缓存 content 区（32KB/拍，真实安装是分钟级）
const cache = process.env.npm_config_cache || ''
const step = Number(process.env.STUB_CACHE_STEP_MS || 700)
const total = Number(process.env.STUB_NPM_MS || 0)
for (let i = 0; i * step < total; i += 1) {
  setTimeout(() => {
    const file = path.join(cache, '_cacache', 'content-v2', 'sha512', 'aa', 'bb', 'stub-' + i)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, Buffer.alloc(32768))
  }, i * step)
}
setTimeout(() => process.exit(0), total)
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

/** 假 registry：@deepseek-ai/dsh 的 packument（对象或函数）+ tarball 大小探测
 *  （与真实源同形：HEAD 回 content-length，Range GET 回 206 + content-range；
 *  大小 = 1000×(序号+1)；probeFail 模拟两种探测都不可用 → 总量测量降级） */
function startRegistry(packument, state) {
  const server = http.createServer((req, res) => {
    state.hits += 1
    const tarball = req.url.match(/pkg-(\d+)\//)
    if (tarball && (req.method === 'HEAD' || String(req.headers.range || '').includes('bytes=0-0'))) {
      if (state.probeFail) { res.writeHead(405); res.end(); return }
      const size = 1000 * (Number(tarball[1]) + 1)
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-length': String(size) })
        res.end()
        return
      }
      res.writeHead(206, { 'content-range': `bytes 0-0/${size}` })
      res.end('x')
      return
    }
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
  // alpha 渠道口径：追「源上最大版本」，预发布也算——不能停在落后的 dist-tags.latest
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

  // ── U2 检查更新（默认渠道 stable：目标 = dist-tags.latest） ──
  const registryState = { hits: 0, failWith: 0, probeFail: false }
  const server = await startRegistry(() => (registryState.empty ? {} : PACKUMENT), registryState)
  const registry = `http://127.0.0.1:${server.address().port}`

  const events = []
  update.setEmitter((payload) => events.push(payload))

  const first = await update.check({ force: true, registry })
  check(`U2a 正式渠道发现新版本（${SHIPPED} → ${LATEST_TAG}）`,
    first.updateAvailable === true && first.latest === LATEST_TAG && first.current === SHIPPED
    && first.channel === 'stable',
    `${first.current} → ${first.latest}（${first.channel}）`)
  check('U2b 首次发现新版本时要求提示（notify=true）', events.some((e) => e.notify === true))
  check('U2c 检查结果落盘（下次启动仍能提示）',
    JSON.parse(fs.readFileSync(path.join(root, 'harness-update.json'), 'utf8')).latestVersion === LATEST_TAG)

  // ── U13a/b alpha 渠道：目标 = 全集版本号最大者（含预发布） ──
  events.length = 0
  const alphaCheck = await update.check({ force: true, registry, channel: 'alpha' })
  check(`U13a alpha 渠道目标为最大版本（${LATEST}，非落后的 ${LATEST_TAG}）`,
    alphaCheck.latest === LATEST && alphaCheck.channel === 'alpha' && alphaCheck.updateAvailable === true,
    `${alphaCheck.latest}（${alphaCheck.channel}）`)
  check('U13b 渠道变化后的新结论重新提示一次（notify=true）', events.some((e) => e.notify === true))

  // ── U3 节流与去重提示 ──
  const hitsAfterFirst = registryState.hits
  const second = await update.check({ registry, channel: 'alpha' }) // 未 force：6 小时内不再查询
  check('U3a 未到期不重复查询', registryState.hits === hitsAfterFirst && second.latest === LATEST,
    `hits=${registryState.hits}`)
  events.length = 0
  await update.check({ force: true, registry, channel: 'alpha' })
  check('U3b 同一新版本不重复提示', !events.some((e) => e.notify === true))

  // 旧版本应用留下的状态里没有检查口径标记：升级后必须立即按新口径重查一次，
  // 否则界面会拿着旧结论（比如「已是最新」）再显示 6 小时
  const statePath = path.join(root, 'harness-update.json')
  const staleState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  delete staleState.checkPolicy
  staleState.lastCheckAt = Date.now()
  fs.writeFileSync(statePath, JSON.stringify(staleState))
  const hitsBeforePolicyChange = registryState.hits
  const repolicy = await update.check({ registry, channel: 'alpha' })
  check('U3c 检查口径变化后忽略节流重查',
    registryState.hits > hitsBeforePolicyChange && repolicy.latest === LATEST
    && JSON.parse(fs.readFileSync(statePath, 'utf8')).checkPolicy === update.CHECK_POLICY,
    `hits=${registryState.hits}`)

  // ── U13c 渠道变化忽略节流（切回 stable 立即重查，不等 6 小时） ──
  const hitsBeforeChannelChange = registryState.hits
  const backToStable = await update.check({ registry }) // 未 force，且刚查过：仅因渠道变化重查
  check('U13c 渠道变化后忽略节流重查',
    registryState.hits > hitsBeforeChannelChange && backToStable.latest === LATEST_TAG
    && JSON.parse(fs.readFileSync(statePath, 'utf8')).channel === 'stable',
    `hits=${registryState.hits} / ${backToStable.latest}`)

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
    /未找到有效的版本号/.test(emptyCheck.error) && emptyCheck.latest === LATEST_TAG, emptyCheck.error)
  registryState.empty = false

  // ── U5 应用内热更新（桩 npm 造树） ──
  // 桩 npm 睡够两个进度采样周期，且按 700ms 节拍写缓存字节，覆盖「下载量/速度」实测链路
  process.env.STUB_NPM_MS = '4500'
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
  check('U5e 安装进度有阶段广播（含分析依赖/测量总量）',
    ['analyzing', 'preparing', 'measuring', 'downloading', 'installing', 'verifying', 'swapping', 'done'].every((s) => events.some((e) => e.install.status === s)),
    [...new Set(events.map((e) => e.install.status))].join(','))
  if (PLATFORM === 'win32') {
    check('U5f 新运行时已带 CREATE_NO_WINDOW 补丁', harnessPatch.isRuntimePatched(cacheDir) === true)
  }

  // ── U12 字节级下载进度（总量 / 已下载 / 速度 / 包数进度） ──
  check('U12a 依赖分析给出精确总包数（lockfile 解析）',
    result.install.totalPackages === 8, String(result.install.totalPackages))  // 桩 registry 对 8 个 tarball 报 1000×(序号+1) 字节：总和必须分毫不差
  check('U12b 下载总量 = tarball content-length 之和',
    result.install.totalBytes === 36000, String(result.install.totalBytes))
  check('U12c 已下载字节为 npm 缓存实测增量（>0）',
    result.install.downloadedBytes > 0, String(result.install.downloadedBytes))
  check('U12d 采样到非零下载速度（EMA 平滑值）',
    events.some((e) => e.install.status === 'installing' && e.install.bytesPerSecond > 0))
  check('U12e 安装阶段广播「已落盘包数 / 总包数」',
    events.some((e) => e.install.status === 'installing' && e.install.packages > 0 && e.install.totalPackages === 8))
  check('U12f 「分析依赖」阶段已广播', events.some((e) => e.install.status === 'analyzing'))
  // 桩 lockfile 里混入了 darwin-arm64 / linux-x64 二进制包：他平台包不进总包数也不进总量
  check('U12i 其他平台的可选二进制包不计入总包数与总量',
    result.install.totalPackages === 8 && result.install.totalBytes === 36000,
    `totalPackages=${result.install.totalPackages} totalBytes=${result.install.totalBytes}`)

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

  // ── U12g/U12h 降级路径：分析失败 / 总量测量失败都不能阻塞更新本身 ──
  process.env.STUB_NPM_MODE = 'skip-lockfile'
  const noAnalyze = await update.install({ version: '0.1.6-stub', registry })
  check('U12g 依赖分析失败时降级为无总量并完成更新',
    noAnalyze.ok === true && noAnalyze.install.totalPackages === 0 && noAnalyze.install.totalBytes === 0,
    noAnalyze.error || `totalPackages=${noAnalyze.install.totalPackages}`)
  delete process.env.STUB_NPM_MODE

  registryState.probeFail = true
  const noHead = await update.install({ version: '0.1.6-stub', registry })
  check('U12h tarball 大小探测不可用时降级（totalBytes=0）且更新成功',
    noHead.ok === true && noHead.install.totalPackages === 8 && noHead.install.totalBytes === 0,
    noHead.error || `totalBytes=${noHead.install.totalBytes}`)
  registryState.probeFail = false

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

  // ── U13d/e 渠道切换：运行时版本高于正式渠道目标 → 切换入口 → 降级安装 ──
  const switchCheck = await update.check({ force: true, registry })
  check(`U13d 当前版本高于正式渠道目标（${LATEST_TAG}）时提供切换入口`,
    switchCheck.channel === 'stable' && switchCheck.latest === LATEST_TAG
    && switchCheck.updateAvailable === false && switchCheck.switchAvailable === true,
    `${switchCheck.current} → ${switchCheck.latest}`)
  const switched = await update.install({ registry }) // 不指定版本：装当前渠道目标（降级）
  check('U13e 切换走同一条安装链路装渠道目标版本（降级成功）',
    switched.ok === true && switched.version === LATEST_TAG && rt.currentRuntimeVersion() === LATEST_TAG,
    switched.error || rt.currentRuntimeVersion())

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
