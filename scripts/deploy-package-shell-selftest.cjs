/**
 * 本地打包子进程环境回归（node scripts/deploy-package-shell-selftest.cjs）。
 * 使用真实 Git Bash 和隔离 Maven fixture，覆盖桌面应用继承旧 PATH 的场景；
 * 持久环境通过快照注入，不联网、不修改系统设置或应用进程环境。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-shell-test-')))
const processEnvBefore = { ...process.env }
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => path.join(testRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } },
}
const { findGitBashDir, localShellEnv } = require('../electron/deploy/deploy-service')

function pathKeys(env) {
  return Object.keys(env).filter((key) => key.toLowerCase() === 'path')
}

function pathOf(env) {
  const keys = pathKeys(env)
  assert.equal(keys.length, 1, `环境只能有一个 PATH 键，实际：${keys.join(',')}`)
  return env[keys[0]]
}

function normalizedDir(dir) {
  return String(dir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function countDir(env, dir) {
  return String(pathOf(env)).split(';').filter((entry) => normalizedDir(entry) === normalizedDir(dir)).length
}

/** 剔除全部 Git 目录，确实将窄环境传入真实实现，防止完整 process.env 覆盖测试输入。 */
function narrowEnv() {
  const env = { ...process.env }
  const kept = pathKeys(env).flatMap((key) => String(env[key] || '').split(';'))
    .filter((dir) => {
      const normalized = normalizedDir(dir.trim())
      return normalized && !/\/git\/(cmd|bin|usr\/bin|mingw64\/bin)$/.test(normalized)
    })
  for (const key of pathKeys(env)) delete env[key]
  env.Path = kept.join(';')
  return env
}

function runBash(command, env, cwd = testRoot) {
  const result = spawnSync(`bash -c "${command}"`, {
    shell: true, cwd, env, encoding: 'utf8', windowsHide: true, timeout: 10000,
  })
  return { status: result.status, out: String(result.stdout || ''), err: String(result.stderr || '') }
}

function makeMaven(name, marker) {
  const home = path.join(testRoot, name)
  const bin = path.join(home, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'mvn'), `#!/usr/bin/env bash\nprintf 'FIXTURE_MAVEN_${marker}\\n'\n`)
  fs.writeFileSync(path.join(bin, 'mvn.cmd'), `@echo FIXTURE_MAVEN_${marker}\r\n`)
  fs.chmodSync(path.join(bin, 'mvn'), 0o755)
  return { home, bin, marker }
}

function assertMaven(env, fixture, label, cwd) {
  const result = runBash('mvn --version', env, cwd)
  assert.equal(result.status, 0, `${label}：mvn 应成功，stderr：${result.err}`)
  assert.equal(result.out.trim(), `FIXTURE_MAVEN_${fixture.marker}`, `${label}：必须调用指定 fixture`)
}

function main() {
  if (process.platform !== 'win32') {
    assert.equal(findGitBashDir(), null, '非 Windows 不定位 Git Bash')
    const inherited = { ...process.env, JAVA_HOME: '/fixture/inherited-java' }
    assert.deepEqual(localShellEnv(inherited, { User: { Path: '/fixture/persistent-bin', JAVA_HOME: '/fixture/new-java' } }), inherited,
      '非 Windows 保持继承环境，不读取或合并 Windows 配置')
    console.log('非 Windows 平台：继承环境约束通过；Windows 子进程回归未执行')
    return
  }

  const bashDir = findGitBashDir()
  const shellEnv = localShellEnv(process.env, {})
  pathOf(shellEnv)
  if (!bashDir) {
    console.log('本机未检出 Git for Windows，真实 bash/Maven 子进程回归未执行')
    return
  }
  assert.ok(fs.existsSync(path.join(bashDir, 'bash.exe')), '定位的 Git Bash 入口必须存在')
  assert.equal(normalizedDir(pathOf(shellEnv).split(';')[0]), normalizedDir(bashDir), 'Git Bash 目录必须位于 PATH 首位')

  const narrow = narrowEnv()
  const narrowBefore = { ...narrow }
  const fixed = runBash('uname -s; command -v bash', localShellEnv(narrow, {}))
  assert.equal(fixed.status, 0, `窄 PATH 下 bash 应可执行：${fixed.err}`)
  assert.ok(/^MINGW64/i.test(fixed.out), `必须命中 Git Bash，实际：${fixed.out.trim()}`)
  const control = runBash('uname -s; command -v bash', narrow)
  assert.ok(!/^MINGW64/i.test(control.out), '未前置 Git Bash 的窄 PATH 不应命中 Git Bash')
  assert.deepEqual(narrow, narrowBefore, '不能修改传入的窄环境')
  console.log('  ✓ 窄 PATH 的真实 Git Bash 选择与对照组通过')

  const machine = makeMaven('machine Maven', 'MACHINE')
  const user = makeMaven('用户 Maven 含空格', 'USER')
  const inherited = makeMaven('inherited Maven', 'INHERITED')
  const systemBin = path.join(process.env.SystemRoot || 'C:/Windows', 'System32')
  const gitCmd = path.join(path.dirname(bashDir), 'cmd')
  const baseEnv = { ...process.env }
  for (const key of Object.keys(baseEnv)) {
    if (/^(path|java_home|maven_home|m2_home)$/i.test(key)) delete baseEnv[key]
  }
  baseEnv.Path = `${systemBin};${gitCmd}`
  const baseBefore = { ...baseEnv }

  const missing = runBash('mvn --version', localShellEnv(baseEnv, {}))
  assert.notEqual(missing.status, 0, '窄 PATH 且无配置时必须复现 mvn 不可用')
  const pathOnly = localShellEnv(baseEnv, { Machine: { Path: machine.bin }, User: { Path: user.bin } })
  assertMaven(pathOnly, machine, '应用无 HOME 时从持久 PATH 找到 Maven')
  assert.equal(normalizedDir(pathOf(pathOnly).split(';')[1]), normalizedDir(systemBin), '原有 PATH 必须先于追加的持久 PATH')
  console.log('  ✓ 缺 HOME/旧 PATH 的错误复现与当前持久 PATH 恢复通过')

  const snapshot = { Machine: { MAVEN_HOME: machine.home }, User: { MAVEN_HOME: user.home } }
  const snapshotBefore = structuredClone(snapshot)
  const fallback = localShellEnv({ ...baseEnv, MAVEN_HOME: path.join(testRoot, '不存在的 Maven') }, snapshot)
  assert.equal(fallback.MAVEN_HOME, user.home, '无效继承 HOME 优先回退有效 User HOME')
  assertMaven(fallback, user, '含中文和空格的 User MAVEN_HOME')
  const machineFallback = localShellEnv(baseEnv, { Machine: { MAVEN_HOME: machine.home }, User: { MAVEN_HOME: path.join(testRoot, 'missing') } })
  assert.equal(machineFallback.MAVEN_HOME, machine.home, '无效 User HOME 回退有效 Machine HOME')
  assertMaven(machineFallback, machine, 'Machine HOME 回退')
  const kept = localShellEnv({ ...baseEnv, MAVEN_HOME: inherited.home }, snapshot)
  assert.equal(kept.MAVEN_HOME, inherited.home, '有效继承 HOME 不得被持久 HOME 覆盖')
  assertMaven(kept, inherited, '继承 HOME 优先')
  const readerUnavailable = localShellEnv({ ...baseEnv, SystemRoot: path.join(testRoot, 'missing-windows'), MAVEN_HOME: inherited.home })
  assertMaven(readerUnavailable, inherited, '持久配置读取失败时仍使用有效继承 HOME')
  const m2 = localShellEnv(baseEnv, { User: { M2_HOME: user.home } })
  assertMaven(m2, user, 'M2_HOME 补入 Maven bin')
  assert.deepEqual(snapshot, snapshotBefore, '不能修改持久环境快照')
  console.log('  ✓ HOME 有效性、User/Machine 回退、继承优先与 M2_HOME 通过')

  const duplicate = { ...baseEnv, PATH: `${systemBin.toUpperCase()};${user.bin};${user.bin.replace(/\\/g, '/')}` }
  const duplicateBefore = { ...duplicate }
  const merged = localShellEnv(duplicate, { Machine: { Path: `${systemBin};${user.bin}` }, User: { Path: `${user.bin};` } })
  assert.equal(countDir(merged, systemBin), 1, '重复系统目录必须去重，忽略大小写')
  assert.equal(countDir(merged, user.bin), 1, '重复工具目录必须去重，忽略分隔符差异')
  assert.equal(normalizedDir(pathOf(merged).split(';')[0]), normalizedDir(bashDir), '合并后 Git Bash 仍位于首位')
  assertMaven(merged, user, '重复 PATH 键合并')
  assert.deepEqual(duplicate, duplicateBefore, '不能修改含重复 PATH 键的输入环境')

  const expanded = localShellEnv(baseEnv, {
    Machine: { Path: '%MAVEN_HOME%/bin' },
    User: { MAVEN_HOME: user.home, Path: '%maven_home%/bin;%SystemRoot%/System32' },
  })
  assert.equal(countDir(expanded, user.bin), 1, 'PATH 中 HOME 引用必须按当前快照展开并去重')
  assert.ok(!/%(?:maven_home|systemroot)%/i.test(pathOf(expanded)), 'Windows 变量引用必须忽略大小写展开')
  assertMaven(expanded, user, '旧进程缺变量时按持久快照展开 PATH')
  const buildDir = path.join(testRoot, '构建副本 cwd')
  fs.mkdirSync(buildDir)
  assertMaven(expanded, user, '切换构建 cwd 后仍找到源环境 Maven', buildDir)
  assert.deepEqual(baseEnv, baseBefore, '不能修改调用方环境')
  console.log('  ✓ PATH 键与目录去重、变量展开、构建 cwd 隔离通过')
}

try {
  main()
  assert.deepEqual({ ...process.env }, processEnvBefore, '所有测试不得修改应用进程环境')
  console.log('deploy-package-shell-selftest 全部已执行断言通过')
} finally {
  assert.equal(path.dirname(testRoot), fs.realpathSync(os.tmpdir()), '清理对象必须位于本机临时目录')
  assert.ok(path.basename(testRoot).startsWith('pkg-shell-test-'), '只清理本测试创建的目录')
  assert.ok(!fs.lstatSync(testRoot).isSymbolicLink(), '不允许通过链接清理其他目录')
  fs.rmSync(testRoot, { recursive: true, force: true })
}
