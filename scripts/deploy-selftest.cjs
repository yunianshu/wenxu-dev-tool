/**
 * OneDeploy 主进程纯模块自测（无框架，node scripts/deploy-selftest.cjs 直接运行）
 * 覆盖：版本识别 / 忽略规则 / ZIP 打包 / 部署项目配置（electron 打桩）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message}`)
  }
}

// ── electron 打桩（供 store.js / deploy-projects.js 在纯 Node 下运行） ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onedeploy-test-'))
const stubExports = {
  app: { getPath: () => path.join(tmpRoot, 'userdata') },
  safeStorage: { isEncryptionAvailable: () => false }, // 走明文兜底分支，仍可验证存储往返
}
const Module = require('module')
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stubExports }

const { detectVersion } = require('../electron/deploy/version-detector')
const { createMatcher, buildPackage } = require('../electron/deploy/packager')
const deployProjects = require('../electron/deploy/deploy-projects')
const { buildDeployArgs, resolveCompose, resolveArtifact, sha256File, deployModeOf } = require('../electron/deploy/deploy-service')

// ═══════════ 版本识别 ═══════════
console.log('版本识别 version-detector:')
function mkProj(name, files) {
  const dir = path.join(tmpRoot, 'proj-' + name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [f, content] of Object.entries(files)) {
    const target = path.join(dir, f)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

test('VERSION 文件优先', () => {
  const dir = mkProj('v1', { VERSION: '9.9.9\n', 'package.json': '{"version":"1.0.0"}' })
  assert.deepStrictEqual(detectVersion(dir), { version: '9.9.9', source: 'VERSION' })
})
test('package.json', () => {
  const dir = mkProj('v2', { 'package.json': '{"name":"a","version":"1.2.3"}' })
  assert.deepStrictEqual(detectVersion(dir), { version: '1.2.3', source: 'package.json' })
})
test('pom.xml 跳过 parent 取项目版本', () => {
  const dir = mkProj('v3', {
    'pom.xml': '<project><parent><groupId>g</groupId><artifactId>a</artifactId><version>0.0.1</version></parent><version>2.3.4</version></project>',
  })
  assert.deepStrictEqual(detectVersion(dir), { version: '2.3.4', source: 'pom.xml' })
})
test('build.gradle', () => {
  const dir = mkProj('v4', { 'build.gradle': "plugins { id 'java' }\nversion = '3.4.5'\n" })
  assert.strictEqual(detectVersion(dir).version, '3.4.5')
})
test('build.gradle.kts', () => {
  const dir = mkProj('v4k', { 'build.gradle.kts': 'version = "6.7.8"\n' })
  assert.strictEqual(detectVersion(dir).version, '6.7.8')
})
test('pubspec.yaml（含+build号）', () => {
  const dir = mkProj('v5', { 'pubspec.yaml': 'name: app\nversion: 1.0.0+42\n' })
  assert.strictEqual(detectVersion(dir).version, '1.0.0+42')
})
test('*.csproj 的 <Version>', () => {
  const dir = mkProj('v6', { 'A.csproj': '<Project><PropertyGroup><AssemblyVersion>0.0.0</AssemblyVersion><Version>7.8.9</Version></PropertyGroup></Project>' })
  assert.deepStrictEqual(detectVersion(dir), { version: '7.8.9', source: '*.csproj' })
})
test('无版本文件返回空', () => {
  const dir = mkProj('v7', { 'readme.txt': 'hi' })
  assert.strictEqual(detectVersion(dir).version, '')
})
test('目录不存在返回空（不抛异常）', () => {
  assert.strictEqual(detectVersion(path.join(tmpRoot, 'no-such-dir')).version, '')
})
test('CHANGELOG 跳过 Unreleased 取最新发布版本', () => {
  const dir = mkProj('v8', {
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n\n## [0.2.0] - 2026-09-01\n\n### Changed\n- y\n',
  })
  assert.deepStrictEqual(detectVersion(dir), { version: '0.2.0', source: 'CHANGELOG.md' })
})
test('CHANGELOG 只有 Unreleased 不命中（继续向后探测）', () => {
  const dir = mkProj('v9', { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- x\n' })
  assert.strictEqual(detectVersion(dir).version, '')
})
test('根目录标准文件优先于 CHANGELOG', () => {
  const dir = mkProj('v10', {
    'package.json': '{"version":"2.0.0"}',
    'CHANGELOG.md': '## [1.0.0] - 2026-01-01\n',
  })
  assert.deepStrictEqual(detectVersion(dir), { version: '2.0.0', source: 'package.json' })
})
test('前后端分离项目探测一级子目录（source 带子目录前缀）', () => {
  const dir = mkProj('v11', {
    'readme.txt': 'hi',
    'backend/pom.xml': '<project><version>0.2.0-SNAPSHOT</version></project>',
    'frontend/package.json': '{"version":"0.1.0"}',
  })
  assert.deepStrictEqual(detectVersion(dir), { version: '0.2.0-SNAPSHOT', source: 'backend/pom.xml' })
})
test('子目录探测跳过 node_modules', () => {
  const dir = mkProj('v12', {
    'readme.txt': 'hi',
    'node_modules/dep/package.json': '{"version":"9.9.9"}',
  })
  assert.strictEqual(detectVersion(dir).version, '')
})
test('根目录文件优先于子目录', () => {
  const dir = mkProj('v13', {
    'package.json': '{"version":"1.1.1"}',
    'backend/pom.xml': '<project><version>5.0.0</version></project>',
  })
  assert.deepStrictEqual(detectVersion(dir), { version: '1.1.1', source: 'package.json' })
})
test('CHANGELOG 优先于子目录（项目级发布版本权威）', () => {
  const dir = mkProj('v14', {
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [0.3.0] - 2026-08-01\n',
    'backend/pom.xml': '<project><version>0.3.0-SNAPSHOT</version></project>',
  })
  assert.deepStrictEqual(detectVersion(dir), { version: '0.3.0', source: 'CHANGELOG.md' })
})

// ═══════════ 忽略规则 ═══════════
console.log('忽略规则 packager.matcher:')
const matcher = createMatcher(['*.log', 'local-config/', 'secret.txt', 'a/b'])
test('默认规则：node_modules / .git / dist', () => {
  assert.ok(matcher.ignored('node_modules/x/index.js'))
  assert.ok(matcher.ignored('.git/config'))
  assert.ok(matcher.ignored('apps/web/dist/main.js'))
})
test('默认规则：*.log / *.tmp 任意层级', () => {
  assert.ok(matcher.ignored('logs/app.log'))
  assert.ok(matcher.ignored('src/deep/x.tmp'))
})
test('默认规则不误伤正常文件', () => {
  assert.ok(!matcher.ignored('src/index.js'))
  assert.ok(!matcher.ignored('package.json'))
  assert.ok(!matcher.ignored('build.gradle.kts')) // build 规则不应匹配 build.gradle
})
test('自定义：*.log', () => {
  assert.ok(matcher.ignored('custom/foo.log'))
})
test('自定义：目录 local-config/（任意层级）', () => {
  assert.ok(matcher.ignored('local-config'))
  assert.ok(matcher.ignored('local-config/a.txt'))
  assert.ok(matcher.ignored('x/local-config/a.txt'))
})
test('自定义：精确文件 secret.txt（任意层级）', () => {
  assert.ok(matcher.ignored('secret.txt'))
  assert.ok(matcher.ignored('src/secret.txt'))
})
test('自定义：根路径 a/b 只匹配根下', () => {
  assert.ok(matcher.ignored('a/b'))
  assert.ok(matcher.ignored('a/b/c.js'))
  assert.ok(!matcher.ignored('other/a/b'))
})
test('自定义：前导 / 锚定项目根，不误伤深层同名目录', () => {
  const m = createMatcher(['/source'])
  assert.ok(m.ignored('source/iD880.pdf'), '应忽略顶层 source')
  assert.ok(!m.ignored('backend/src/main/java/com/x/source/Foo.java'), '不应忽略深层 source 包')
})

// ═══════════ ZIP 打包（异步） ═══════════
;(async () => {
  console.log('打包 packager.buildPackage:')
  const projDir = mkProj('zip', {})
  fs.mkdirSync(path.join(projDir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(projDir, 'node_modules/pkg'), { recursive: true })
  fs.mkdirSync(path.join(projDir, '.git'), { recursive: true })
  fs.writeFileSync(path.join(projDir, 'package.json'), '{"version":"2.0.0"}')
  fs.writeFileSync(path.join(projDir, 'src/app.js'), 'console.log(1)')
  fs.writeFileSync(path.join(projDir, 'node_modules/pkg/index.js'), 'x')
  fs.writeFileSync(path.join(projDir, '.git/config'), 'x')
  fs.writeFileSync(path.join(projDir, 'debug.log'), 'x')
  fs.writeFileSync(path.join(projDir, '.deployignore'), 'secret.txt\n')
  fs.writeFileSync(path.join(projDir, 'secret.txt'), 'should be excluded')

  let zipResult = null
  test('生成 ZIP 并计算 SHA256', async () => {
    zipResult = await buildPackage({ projectDir: projDir, appName: 'myapp', version: '2.0.0' })
    assert.ok(fs.existsSync(zipResult.zipPath))
    assert.match(path.basename(zipResult.zipPath), /^myapp-2\.0\.0-\d{8}-\d{6}\.zip$/)
    assert.ok(/^[0-9a-f]{64}$/.test(zipResult.sha256))
    assert.ok(zipResult.fileCount >= 2) // package.json + src/app.js
  })

  test('ZIP 内容排除默认规则与 .deployignore（平铺根目录）', async () => {
    // Windows 的 tar 对含盘符路径会误判为远程主机，改用「进入目录 + 纯文件名」方式列出
    const { execFileSync } = require('child_process')
    const list = execFileSync('tar', ['-tf', path.basename(zipResult.zipPath)], {
      cwd: path.dirname(zipResult.zipPath),
    }).toString().split(/\r?\n/).filter(Boolean)
    assert.ok(list.includes('package.json'), `应含 package.json，实际: ${list}`)
    assert.ok(list.includes('src/app.js'), `应含 src/app.js，实际: ${list}`)
    assert.ok(!list.some((f) => f.includes('node_modules')), `不应含 node_modules: ${list}`)
    assert.ok(!list.some((f) => f.startsWith('.git')), `不应含 .git: ${list}`)
    assert.ok(!list.some((f) => f.endsWith('.log')), `不应含 *.log: ${list}`)
    assert.ok(!list.some((f) => f.includes('secret.txt')), `不应含 .deployignore 排除的 secret.txt: ${list}`)
    assert.ok(!list.some((f) => f.includes('.deployignore')), '忽略规则文件本身不打包')
    assert.ok(!list.some((f) => f.endsWith('.zip')), `不应把生成的 zip 自身打进去: ${list}`)
  })

  // ═══════════ 部署项目配置（electron 打桩：明文兜底） ═══════════
  console.log('项目配置 deploy-projects（多目标）:')
  test('旧版单服务器配置自动迁移为 targets[0]', () => {
    const r = deployProjects.save({
      name: 'demo',
      localPath: 'D:/x',
      remotePath: '/opt/apps/demo',
      server: { host: '10.0.0.1', port: 22, username: 'root', authType: 'password', secret: 'pass#123' },
      health: { enabled: true, url: 'http://h', timeout: 30, interval: 2 },
    })
    assert.ok(r.ok && r.id)
    const p = deployProjects.list().find((x) => x.id === r.id)
    assert.strictEqual(p.server, undefined, '项目根不应再有 server 字段')
    assert.strictEqual(p.targets.length, 1)
    const t = p.targets[0]
    assert.strictEqual(t.server.host, '10.0.0.1')
    assert.strictEqual(t.remotePath, '/opt/apps/demo')
    assert.strictEqual(t.health.url, 'http://h')
    assert.strictEqual(t.server.secret, undefined, '明文密码不应返回渲染层')
    assert.strictEqual(t.server.secretConfigured, true)
  })
  test('凭据可由主进程解出（getCredentials，默认第一个目标）', () => {
    const id = deployProjects.list()[0].id
    assert.strictEqual(deployProjects.getCredentials(id).password, 'pass#123')
  })
  test('新增第二个目标并各自保存凭据', () => {
    const p = deployProjects.list()[0]
    const t2 = { ...deployProjects.defaultTarget(), name: '生产', remotePath: '/opt/apps/demo-prod' }
    t2.server = { ...t2.server, host: '10.0.0.2', authType: 'password', secret: 'prod#456' }
    deployProjects.save({ ...JSON.parse(JSON.stringify(p)), targets: [...p.targets.map((t) => ({ ...t })), t2] })
    const saved = deployProjects.list().find((x) => x.id === p.id)
    assert.strictEqual(saved.targets.length, 2)
    assert.strictEqual(deployProjects.getCredentials(p.id, t2.id).password, 'prod#456')
    assert.strictEqual(deployProjects.getCredentials(p.id).password, 'pass#123', '第一目标凭据不受影响')
  })
  test('更新时空密码分别保留各目标凭据', () => {
    const saved = deployProjects.list()[0]
    const clean = JSON.parse(JSON.stringify(saved))
    for (const t of clean.targets) {
      delete t.server.secretConfigured
      delete t.server.secretMasked
      delete t.server.passphraseConfigured
    }
    clean.name = 'demo2'
    deployProjects.save(clean)
    assert.strictEqual(deployProjects.getCredentials(saved.id, saved.targets[1].id).password, 'prod#456')
    assert.strictEqual(deployProjects.getCredentials(saved.id, saved.targets[0].id).password, 'pass#123')
    assert.strictEqual(deployProjects.list().find((x) => x.id === saved.id).name, 'demo2')
  })
  test('clearSecret 只清除指定目标', () => {
    const saved = deployProjects.list()[0]
    const [t1, t2] = saved.targets
    const payload = JSON.parse(JSON.stringify(saved))
    payload.targets[1].server.clearSecret = true
    deployProjects.save(payload)
    assert.strictEqual(deployProjects.getCredentials(saved.id, t2.id).password, '')
    assert.strictEqual(deployProjects.getCredentials(saved.id, t1.id).password, 'pass#123')
    const after = deployProjects.list().find((x) => x.id === saved.id)
    assert.strictEqual(after.targets[1].server.secretConfigured, false)
  })
  test('删除项目', () => {
    const id = deployProjects.list()[0].id
    deployProjects.remove(id)
    assert.strictEqual(deployProjects.list().length, 0)
  })

  // ═══════════ 客户端参数 ↔ deploy.sh 解析一致性 ═══════════
  console.log('客户端/服务端参数一致性 buildDeployArgs:')
  test('发布参数包含 --version 及其值', () => {
    const project = { name: 'demo', deploy: {}, targets: [{ id: 't1', name: '测试', remotePath: '/opt/apps/demo', health: {} }] }
    const args = buildDeployArgs(
      project, project.targets[0],
      { fileName: 'demo-1.0.0.zip', sha256: 'a'.repeat(64) },
      '1.0.0',
    )
    const i = args.indexOf('--version')
    assert.ok(i > 0, `缺少 --version，实际: ${args}`)
    assert.strictEqual(args[i + 1], '1.0.0')
    for (const k of ['--app', '--home', '--package', '--sha256', '--compose']) {
      assert.ok(args.includes(k), `缺少 ${k}`)
    }
  })
  test('发布路径所有开关均被 deploy.sh 接受（防拼写/遗漏回归）', () => {
    const project = {
      name: 'demo',
      deploy: { backupCode: true, autoRollback: true, deleteUploadAfterSuccess: true, keepReleases: 5, keepBackups: 5 },
      targets: [{
        id: 't1', name: '测试', remotePath: '/opt/apps/demo',
        health: { enabled: true, url: 'http://x', timeout: 30, interval: 2 },
        // 数据库备份配置按部署目标存放（数据库实例随环境不同）
        db: { enabled: true, type: 'postgres', container: 'pg', name: 'db', user: 'u' },
      }],
    }
    const args = buildDeployArgs(
      project, project.targets[0],
      { fileName: 'demo-1.0.0.zip', sha256: 'b'.repeat(64) },
      '1.0.0',
    )
    const sh = fs.readFileSync(path.join(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8')
    const accepted = new Set(
      [...sh.matchAll(/^\s+(--[a-z0-9-]+)\)/gm)].map((m) => m[1]),
    )
    for (const a of args) {
      if (a.startsWith('--')) {
        assert.ok(accepted.has(a), `deploy.sh 不认识参数 ${a}`)
      }
    }
    // 反向：脚本里 deploy/rollback 会消费的带值参数，客户端发布路径必须都传
    for (const req of ['--app', '--home', '--package', '--sha256', '--version', '--compose']) {
      assert.ok(args.includes(req), `发布参数缺少 ${req}`)
    }
    // 数据库备份参数必须取自当前目标（曾为项目级配置，下沉后要防止读回项目级或漏传）
    for (const req of ['--backup-db', '--backup-code', '--auto-rollback', '--delete-upload']) {
      assert.ok(args.includes(req), `发布参数缺少 ${req}`)
    }
    assert.strictEqual(args[args.indexOf('--db-container') + 1], 'pg', '容器名应取当前目标')
    assert.strictEqual(args[args.indexOf('--db-name') + 1], 'db', '库名应取当前目标')
    assert.strictEqual(args[args.indexOf('--db-type') + 1], 'postgres')
    assert.strictEqual(args[args.indexOf('--db-user') + 1], 'u')
  })

  test('数据库备份配置按环境独立：各目标各自读取、不串台', () => {
    const p = {
      name: 'demo',
      deploy: { backupCode: true, autoRollback: true, deleteUploadAfterSuccess: true, keepReleases: 5, keepBackups: 5 },
      targets: [
        { id: 't1', name: '测试', remotePath: '/opt/apps/demo-test', health: { enabled: false }, db: { enabled: true, type: 'postgres', container: 'pg-test', name: 'db_test', user: 'ut' } },
        { id: 't2', name: '生产', remotePath: '/opt/apps/demo-prod', health: { enabled: false }, db: { enabled: false, type: 'postgres', container: '', name: '', user: '' } },
      ],
    }
    const argsTest = buildDeployArgs(p, p.targets[0], { fileName: 'a.zip', sha256: 'c'.repeat(64) }, '1.0.0')
    const argsProd = buildDeployArgs(p, p.targets[1], { fileName: 'a.zip', sha256: 'c'.repeat(64) }, '1.0.0')
    assert.strictEqual(argsTest[argsTest.indexOf('--db-container') + 1], 'pg-test', '测试环境取自身容器名')
    assert.strictEqual(argsTest[argsTest.indexOf('--db-name') + 1], 'db_test')
    assert.ok(argsProd.includes('--no-backup-db'), '未启用备份的环境不得执行数据库备份')
    assert.ok(!argsProd.includes('--db-container'), '生产环境不得带上测试环境的数据库参数')
  })

  // ═══════════ 部署形态：compose 文件名兼容 ═══════════
  console.log('Compose 文件解析 resolveCompose:')
  test('配置的 compose 文件存在则原样使用', () => {
    const dir = mkProj('c1', { 'docker-compose.yml': 'x' })
    assert.deepStrictEqual(resolveCompose({ localPath: dir, composeFile: 'docker-compose.yml' }), { file: 'docker-compose.yml', fallback: false })
  })
  test('配置缺失时回退到项目根的常见命名（compose.yaml）', () => {
    const dir = mkProj('c2', { 'compose.yaml': 'x' })
    assert.deepStrictEqual(resolveCompose({ localPath: dir, composeFile: 'docker-compose.yml' }), { file: 'compose.yaml', fallback: true })
  })
  test('docker-compose.yaml 同样命中回退', () => {
    const dir = mkProj('c3', { 'docker-compose.yaml': 'x' })
    assert.strictEqual(resolveCompose({ localPath: dir, composeFile: 'docker-compose.yml' }).file, 'docker-compose.yaml')
  })
  test('全都不存在时保留配置值（由前置检查报错）', () => {
    const dir = mkProj('c4', { 'readme.txt': 'x' })
    assert.deepStrictEqual(resolveCompose({ localPath: dir, composeFile: 'docker-compose.yml' }), { file: 'docker-compose.yml', fallback: false })
  })
  test('配置的是子目录路径时不做根目录回退', () => {
    const dir = mkProj('c5', { 'compose.yaml': 'x', 'deploy/docker-compose.yml': 'x' })
    assert.strictEqual(resolveCompose({ localPath: dir, composeFile: 'deploy/docker-compose.yml' }).file, 'deploy/docker-compose.yml')
  })
  test('docker 模式发布参数使用回退后的 compose 文件名', () => {
    const dir = mkProj('c6', { 'compose.yaml': 'x' })
    const project = { name: 'demo', localPath: dir, composeFile: 'docker-compose.yml', deploy: {}, targets: [{ id: 't1', name: '测试', remotePath: '/opt/apps/demo', health: {} }] }
    const args = buildDeployArgs(project, project.targets[0], { fileName: 'a.zip', sha256: 'a'.repeat(64) }, '1.0.0')
    const i = args.indexOf('--compose')
    assert.strictEqual(args[i + 1], 'compose.yaml')
  })

  // ═══════════ 部署形态：脚本部署产物解析 ═══════════
  console.log('脚本部署产物 resolveArtifact:')
  function mkArtifact(name, files) {
    const dir = mkProj(name, {})
    const rel = path.join(dir, 'release')
    fs.mkdirSync(rel, { recursive: true })
    for (const [f, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(rel, f), content)
      // mtime 递增，保证「最新」判定稳定
      const t = new Date(Date.now() + Object.keys(files).indexOf(f) * 1000)
      fs.utimesSync(path.join(rel, f), t, t)
    }
    return dir
  }
  test('选中文件名含当前版本的最新发布包', () => {
    const dir = mkArtifact('a1', { 'app-v0.1.0-001.tar.gz': 'x', 'app-v0.1.0-002.tar.gz': 'y', 'app-v0.2.0-001.zip': 'z' })
    const r = resolveArtifact({ localPath: dir, scriptMode: { artifactDir: 'release' } }, '0.1.0')
    assert.ok(r.ok)
    assert.strictEqual(r.fileName, 'app-v0.1.0-002.tar.gz')
    assert.strictEqual(r.sizeBytes, 1)
  })
  test('版本不匹配时报错并提示最新包（不发布过期产物）', () => {
    const dir = mkArtifact('a2', { 'app-v0.1.0-001.tar.gz': 'x' })
    const r = resolveArtifact({ localPath: dir, scriptMode: { artifactDir: 'release' } }, '0.2.0')
    assert.ok(!r.ok)
    assert.match(r.problem, /0\.2\.0/)
    assert.match(r.problem, /app-v0\.1\.0-001\.tar\.gz/)
  })
  test('产物目录为空 / 不存在 / 非目录 分别报错', () => {
    const dir = mkArtifact('a3', {})
    assert.ok(!resolveArtifact({ localPath: dir, scriptMode: { artifactDir: 'release' } }, '1.0.0').ok)
    assert.match(resolveArtifact({ localPath: dir, scriptMode: { artifactDir: 'release' } }, '1.0.0').problem, /没有发布包/)
    const missing = resolveArtifact({ localPath: dir, scriptMode: { artifactDir: 'nope' } }, '1.0.0')
    assert.ok(!missing.ok && /不存在/.test(missing.problem))
  })
  test('sha256File 与 crypto 一次性计算一致', async () => {
    const buf = Buffer.from('hello world'.repeat(1000))
    const f = path.join(tmpRoot, 'sha.txt')
    fs.writeFileSync(f, buf)
    const h = require('crypto').createHash('sha256').update(buf).digest('hex')
    assert.strictEqual(await sha256File(f), h)
  })

  // ═══════════ 部署形态：参数与配置归一化 ═══════════
  console.log('脚本部署参数 buildDeployArgs / deploy-projects:')
  test('script 模式传 --mode script 与 --upgrade-script，不传 --compose', () => {
    const project = {
      name: 'vantage', deployMode: 'script', localPath: 'D:/x',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' },
      deploy: {}, targets: [{ id: 't1', name: '测试', remotePath: '/opt/apps/v', health: {} }],
    }
    const args = buildDeployArgs(project, project.targets[0], { fileName: 'v.tar.gz', sha256: 'c'.repeat(64) }, '0.1.0')
    const sh = fs.readFileSync(path.join(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8')
    const accepted = new Set([...sh.matchAll(/^\s+(--[a-z0-9-]+)\)/gm)].map((m) => m[1]))
    assert.strictEqual(deployModeOf(project), 'script')
    assert.strictEqual(args[args.indexOf('--mode') + 1], 'script')
    assert.strictEqual(args[args.indexOf('--upgrade-script') + 1], 'upgrade.sh')
    assert.ok(!args.includes('--compose'), '脚本部署不应传 --compose')
    assert.ok(args.includes('--no-bootstrap-java') && args.includes('--no-bootstrap-pgdump'), '默认不开启环境引导')
    for (const a of args) if (a.startsWith('--')) assert.ok(accepted.has(a), `deploy.sh 不认识参数 ${a}`)
  })
  test('script 模式开启环境引导时传 --bootstrap-* 开关', () => {
    const project = {
      name: 'vantage', deployMode: 'script', localPath: 'D:/x',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', bootstrapJava: true, bootstrapPgdump: true },
      deploy: {}, targets: [{ id: 't1', name: '测试', remotePath: '/opt/apps/v', health: {} }],
    }
    const args = buildDeployArgs(project, project.targets[0], { fileName: 'v.tar.gz', sha256: 'c'.repeat(64) }, '0.1.0')
    const sh = fs.readFileSync(path.join(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8')
    const accepted = new Set([...sh.matchAll(/^\s+(--[a-z0-9-]+)\)/gm)].map((m) => m[1]))
    assert.ok(args.includes('--bootstrap-java') && args.includes('--bootstrap-pgdump'))
    for (const a of args) if (a.startsWith('--')) assert.ok(accepted.has(a), `deploy.sh 不认识参数 ${a}`)
    // 归一化：非布尔值回退 false
    const bad = deployProjects.normalizeProject({ name: 'x', scriptMode: { bootstrapJava: 'yes' } })
    assert.strictEqual(bad.scriptMode.bootstrapJava, false)
    // 打包命令与超时归一化：空串兜底、超时夹取
    const pkg = deployProjects.normalizeProject({ name: 'x', scriptMode: { packageCommand: '  bash pkg.sh  ', packageTimeoutSec: 5 } })
    assert.strictEqual(pkg.scriptMode.packageCommand, 'bash pkg.sh')
    assert.strictEqual(pkg.scriptMode.packageTimeoutSec, 900, '过小超时应回退默认 900')
    const pkg2 = deployProjects.normalizeProject({ name: 'x', scriptMode: { packageTimeoutSec: 99999 } })
    assert.strictEqual(pkg2.scriptMode.packageTimeoutSec, 3600, '过大超时夹取到 3600')
  })
  test('deploy.sh 语法检查（bash -n，含 script 分支）', () => {
    try {
      execFileSync('bash', ['-n', path.join(__dirname, '../electron/deploy/scripts/deploy.sh')])
    } catch (e) {
      assert.fail(`deploy.sh 语法错误: ${e.stderr || e.message}`)
    }
  })
  test('deploy-projects 归一化：deployMode 默认 docker，scriptMode 兜底非法值', () => {
    const r = deployProjects.save({
      name: 'mode-demo', localPath: 'D:/x', composeFile: '',
      scriptMode: { artifactDir: '../evil', upgradeScript: 'a b.sh' },
      targets: [{ ...deployProjects.defaultTarget() }],
    })
    const p = deployProjects.list().find((x) => x.id === r.id)
    assert.strictEqual(p.deployMode, 'docker')
    assert.strictEqual(p.composeFile, 'docker-compose.yml')
    assert.strictEqual(p.scriptMode.artifactDir, 'release')
    assert.strictEqual(p.scriptMode.upgradeScript, 'upgrade.sh')
    deployProjects.remove(r.id)
  })
  test('deploy-projects 保存 script 模式字段往返', () => {
    const t = deployProjects.defaultTarget()
    const r = deployProjects.save({
      name: 'mode-demo2', localPath: 'D:/x', deployMode: 'script',
      scriptMode: { artifactDir: 'dist/pkg', upgradeScript: 'upgrade.sh' },
      targets: [t],
    })
    const p = deployProjects.list().find((x) => x.id === r.id)
    assert.strictEqual(p.deployMode, 'script')
    assert.deepStrictEqual(p.scriptMode, {
      artifactDir: 'dist/pkg', upgradeScript: 'upgrade.sh',
      bootstrapJava: false, bootstrapPgdump: false,
      packageCommand: '', packageTimeoutSec: 900,
      autoBumpVersion: true, autoReleaseNotes: true,
    })
    deployProjects.remove(r.id)
  })

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`)
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error('自测执行异常:', e)
  process.exit(1)
})
