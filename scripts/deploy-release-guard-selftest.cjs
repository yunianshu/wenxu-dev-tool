/** docker 形态发布内容门禁：版本一致性 + 发布副本凭证（release-evidence.json），
 *  拒绝工作区快照直传打出「成功」（PlmInsight 1.1.57 事故回归）。 */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { execFileSync } = require('child_process')
const { Writable } = require('stream')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-release-guard-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => path.join(root, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false },
} }
const projects = require('../electron/deploy/deploy-projects')
const service = require('../electron/deploy/deploy-service')

const ssh = require('../electron/deploy/ssh-service')
const remote = new Map(), connections = []
ssh.connect = async (config) => {
  connections.push({ host: config.host, port: config.port })
  return { sftp: (cb) => cb(null, { end() {}, createWriteStream(file, options) {
    assert.equal(options.mode, 0o600)
    const chunks = []
    return new Writable({ write(chunk, _, done) { chunks.push(chunk); done() }, final(done) { remote.set(file, Buffer.concat(chunks)); done() } })
  } }) }
}
ssh.close = () => {}
ssh.mkdirp = async () => {}
ssh.upload = async (_, local, target) => { remote.set(target, fs.readFileSync(local)) }
ssh.exec = async (_, command, onLine) => {
  if (command.startsWith('sha256sum')) {
    const file = command.match(/^sha256sum '([^']+)'/)[1]
    assert(remote.has(file), `校验的文件必须已上传: ${file}`)
    return { code: 0, stdout: crypto.createHash('sha256').update(remote.get(file)).digest('hex') }
  }
  if (command.includes('/deploy.sh') && command.startsWith('bash ')) {
    const output = '__STAGE__:build\n__STAGE__:start\n__STAGE__:health\n__DEPLOY_OK__:1.1.58\n'
    onLine?.(output)
    return { code: 0, stdout: output }
  }
  return { code: 0, stdout: '', stderr: '' }
}

const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
}
const pkg = (version) => `${JSON.stringify({ name: 'app', version }, null, 2)}\n`
const COMPOSE = 'services:\n  app:\n    image: demo:latest\n    build: .\n'
const EVIDENCE = JSON.stringify({ version: '1.1.58', commit: 'd1c9bf1', imageTag: 'demo:1.1.58-d1c9bf1', hashes: {} })

function seedProject(name, localDir, { manual = '', evidence = false, prepare = '' } = {}) {
  const project = projects.defaultProject()
  project.configMode = 'manual'
  project.deployMode = 'docker'
  project.name = name
  project.localPath = localDir
  if (manual) project.version = { strategy: 'manual', manual }
  project.docker.requireReleaseEvidence = evidence
  project.docker.prepareCommand = prepare
  Object.assign(project.targets[0], {
    server: { host: 'guard.example.invalid', port: 22, username: 'root', authType: 'password', keyPath: '', secret: '', passphrase: '' },
    remotePath: `/home/test/${name}`,
    health: { strategy: 'manual', enabled: false, url: '', timeout: 90, interval: 3 },
    db: { strategy: 'manual', enabled: false, type: 'postgres', container: '', name: '', user: '' },
  })
  assert(projects.save(project).ok)
  return project.id
}
const targetOf = (id) => projects.list().find((p) => p.id === id).targets[0]

;(async () => {
  // ── 单元：releaseContentProblems 门禁矩阵 ──
  const ws = path.join(root, 'unit-ws')
  writeTree(ws, { 'docker-compose.yml': COMPOSE, 'plm-bi-dashboard/package.json': pkg('1.1.33') })
  const base = (extra = {}) => ({ localPath: ws, version: { strategy: 'manual', manual: '1.1.57' }, docker: {}, ...extra })

  const drift = service.releaseContentProblems(base(), { version: '1.1.57' })
  assert.equal(drift.length, 1, '手动版本与包内版本漂移必须拦截')
  assert(drift[0].includes('1.1.33') && drift[0].includes('1.1.57') && drift[0].includes('plm-bi-dashboard'), drift[0])

  assert.equal(service.releaseContentProblems(base(), { version: '1.1.33' }).length, 0, '手动版本与包内一致时放行')
  assert.equal(service.releaseContentProblems({ localPath: ws, version: { strategy: 'auto' }, docker: {} }, { version: '9.9.9' }).length, 0, 'auto 策略版本同源自洽，不校验')
  assert.equal(service.releaseContentProblems(base(), { version: '' }).length, 0, '无版本由前置检查报错，此处不重复')
  assert.equal(service.releaseContentProblems({ localPath: path.join(root, 'nope'), version: { strategy: 'manual', manual: '1.0.0' }, docker: {} }, { version: '1.0.0' }).length, 0, '目录缺失由前置检查报错')

  // ── 单元：发布副本凭证（PlmInsight 发布链契约） ──
  const src = path.join(root, 'chain-src')
  writeTree(src, { 'docker-compose.yml': COMPOSE, 'plm-bi-dashboard/package.json': pkg('1.1.58'), 'release-evidence.json': EVIDENCE })
  const chain = () => base({ localPath: src, version: { strategy: 'manual', manual: '1.1.58' }, docker: { requireReleaseEvidence: true } })

  const missing = service.releaseContentProblems(base({ docker: { requireReleaseEvidence: true } }), { version: '1.1.57' })
  assert.equal(missing.length, 1, '凭证拦截时只报 prepare 指引，不叠加版本漂移误导')
  assert(missing[0].includes('release-evidence.json') && missing[0].includes('prepare'), missing.join('\n'))

  const mismatch = service.releaseContentProblems(chain(), { version: '1.1.59' })
  assert.equal(mismatch.length, 1, '凭证版本不符同样只报凭证问题')
  assert(mismatch[0].includes('1.1.58') && mismatch[0].includes('1.1.59'), mismatch[0])

  assert.equal(service.releaseContentProblems(chain(), { version: '1.1.58' }).length, 0, '发布链形态（source 副本 + 凭证版本一致）必须放行')
  fs.writeFileSync(path.join(src, 'release-evidence.json'), 'not-json')
  assert.equal(service.releaseContentProblems(chain(), { version: '1.1.58' }).length, 1, '凭证损坏按无凭证处理')
  fs.writeFileSync(path.join(src, 'release-evidence.json'), EVIDENCE)

  // ── 单元：发布副本自动发现（prepare 产物在 output/<发布目录>/source） ──
  const wsPickup = path.join(root, 'pickup-ws')
  writeTree(wsPickup, { 'docker-compose.yml': COMPOSE, 'package.json': pkg('1.9.0') })
  const copyAt = (name, version, preparedAt) => {
    writeTree(path.join(wsPickup, 'output', name, 'source'), {
      'release-evidence.json': preparedAt === 'broken'
        ? 'not-json' : JSON.stringify({ version, preparedAt, hashes: {} }),
    })
  }
  copyAt('rel-old', '2.0.0', '2026-11-04T10:00:00.000Z')
  copyAt('rel-wrong', '1.9.0', '2026-11-04T11:00:00.000Z')
  copyAt('rel-new', '2.0.0', '2026-11-04T12:00:00.000Z')
  copyAt('rel-broken', '2.0.0', 'broken')
  const flagged = (dir) => ({ localPath: dir, docker: { requireReleaseEvidence: true } })
  const picked = service.findReleaseCopy(flagged(wsPickup), { version: '2.0.0' })
  assert.equal(picked && picked.rel, 'output/rel-new/source', '取凭证版本匹配且最新的副本')
  assert.equal(service.findReleaseCopy(flagged(wsPickup), { version: '2.0.1' }), null, '无匹配副本时返回 null')
  assert.equal(service.findReleaseCopy({ localPath: wsPickup, docker: {} }, { version: '2.0.0' }), null, '未开启凭证校验不查找')
  assert.equal(service.findReleaseCopy(flagged(src), { version: '1.1.58' }), null, '根目录已带匹配凭证（链式调用）无需查找')

  // ── 配置归一化：docker.requireReleaseEvidence 默认关、布尔清洗、存取往返 ──
  assert.equal(projects.defaultProject().docker.requireReleaseEvidence, false)
  const dirty = projects.defaultProject()
  dirty.name = 'dirty'; dirty.localPath = ws; dirty.configMode = 'manual'; dirty.deployMode = 'docker'
  dirty.docker.requireReleaseEvidence = 'yes'
  assert(projects.save(dirty).ok)
  assert.equal(projects.list().find((p) => p.name === 'dirty').docker.requireReleaseEvidence, false, '非布尔强制为 false')
  const kept = projects.list().find((p) => p.name === 'dirty')
  kept.docker.requireReleaseEvidence = true
  assert(projects.save(kept).ok)
  assert.equal(projects.list().find((p) => p.name === 'dirty').docker.requireReleaseEvidence, true, '开启后往返保留')

  // ── 集成：门禁在 check 阶段（SSH 连接之前）拦截，失败运行不碰服务器 ──
  const wsBad = path.join(root, 'ws-bad')
  writeTree(wsBad, { 'docker-compose.yml': COMPOSE, 'package.json': pkg('0.9.0') })
  const a = seedProject('guard-drift', wsBad, { manual: '1.1.57' })
  let record = await service.run(a, targetOf(a).id)
  assert.equal(record.status, 'failed')
  assert.equal(record.stages.check.status, 'failed')
  assert(record.message.includes('0.9.0') && record.message.includes('1.1.57'), record.message)
  assert.equal(connections.length, 0, '版本漂移必须在连接服务器前失败')

  const wsNoEvidence = path.join(root, 'ws-no-evidence')
  writeTree(wsNoEvidence, { 'docker-compose.yml': COMPOSE, 'package.json': pkg('1.0.0') })
  const b = seedProject('guard-evidence', wsNoEvidence, { manual: '1.0.0', evidence: true })
  record = await service.run(b, targetOf(b).id)
  assert.equal(record.status, 'failed')
  assert.equal(record.stages.check.status, 'failed')
  assert(record.message.includes('release-evidence.json'), record.message)
  assert.equal(connections.length, 0, '缺凭证必须在连接服务器前失败')

  // ── 集成：发布链形态全流程成功（不破坏 PlmInsight deploy.cjs 的调用契约） ──
  const c = seedProject('guard-chain', src, { manual: '1.1.58', evidence: true })
  record = await service.run(c, targetOf(c).id)
  assert.equal(record.status, 'success', record.message)
  assert.equal(record.version, '1.1.58')
  assert.equal(connections.length, 1)

  // ── 集成：工作区无凭证但 output 里有匹配发布副本 → 自动改用副本发布 ──
  const wsMixed = path.join(root, 'ws-mixed')
  writeTree(wsMixed, { 'docker-compose.yml': COMPOSE, 'package.json': pkg('1.9.0'), 'from-ws.txt': 'workspace' })
  writeTree(path.join(wsMixed, 'output', 'rel-x', 'source'), {
    'docker-compose.yml': COMPOSE,
    'package.json': pkg('2.0.0'),
    'release-evidence.json': JSON.stringify({ version: '2.0.0', preparedAt: '2026-11-04T12:00:00.000Z', hashes: {} }),
    'from-copy.txt': 'copy',
  })
  const d = seedProject('guard-pickup', wsMixed, { manual: '2.0.0', evidence: true })
  record = await service.run(d, targetOf(d).id)
  assert.equal(record.status, 'success', record.message)
  assert.equal(connections.length, 2)
  // 上传的 ZIP 必须来自发布副本而非工作区（bsdtar 列包，System32 tar + cwd 避开盘符坑）
  const zipKey = [...remote.keys()].find((k) => k.includes('/uploads/') && k.includes('guard-pickup') && k.endsWith('.zip'))
  assert(zipKey, '发布包已上传')
  const tmp = path.join(root, 'pickup-check')
  fs.mkdirSync(tmp, { recursive: true })
  fs.writeFileSync(path.join(tmp, 'pack.zip'), remote.get(zipKey))
  const names = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', 'pack.zip'], { cwd: tmp, encoding: 'utf8' }).split(/\r?\n/)
  assert(names.includes('from-copy.txt'), `ZIP 应来自发布副本: ${names.join(',')}`)
  assert(!names.includes('from-ws.txt'), '工作区独有文件不得进入发布包')

  // ── 集成：无副本但配置了准备命令 → 自动执行生成副本再发布（一键） ──
  const wsPrep = path.join(root, 'ws-prep')
  writeTree(wsPrep, { 'docker-compose.yml': COMPOSE, 'package.json': pkg('1.9.0') })
  fs.writeFileSync(path.join(wsPrep, 'make-release.cjs'), [
    "const fs = require('fs'), path = require('path')",
    'const version = process.argv[2]',
    "const src = path.join(__dirname, 'output', 'auto-release', 'source')",
    'fs.mkdirSync(src, { recursive: true })',
    "fs.writeFileSync(path.join(src, 'docker-compose.yml'), 'services:\\n  app:\\n    image: demo:latest\\n    build: .\\n')",
    "fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version }))",
    "fs.writeFileSync(path.join(src, 'from-copy.txt'), 'copy ' + version)",
    "fs.writeFileSync(path.join(src, 'release-evidence.json'), JSON.stringify({ version, preparedAt: new Date().toISOString(), hashes: {} }))",
    "console.log('prepared ' + version)",
  ].join('\n'))
  const e = seedProject('guard-prepare', wsPrep, { manual: '3.0.0', evidence: true, prepare: 'node make-release.cjs {version}' })
  record = await service.run(e, targetOf(e).id)
  assert.equal(record.status, 'success', record.message)
  assert.equal(connections.length, 3)
  {
    const zipKey = [...remote.keys()].find((k) => k.includes('/uploads/') && k.includes('guard-prepare') && k.endsWith('.zip'))
    assert(zipKey, '准备命令路径的发布包已上传')
    const tmp2 = path.join(root, 'prep-check')
    fs.mkdirSync(tmp2, { recursive: true })
    fs.writeFileSync(path.join(tmp2, 'pack.zip'), remote.get(zipKey))
    const names2 = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-tf', 'pack.zip'], { cwd: tmp2, encoding: 'utf8' }).split(/\r?\n/)
    assert(names2.includes('from-copy.txt') && names2.some((n) => n.endsWith('release-evidence.json')), 'ZIP 来自准备命令产出的副本')
    assert.equal(JSON.parse(fs.readFileSync(path.join(wsPrep, 'package.json'), 'utf8')).version, '1.9.0', '准备命令不得改写工作区版本文件')
  }

  // ── 集成：准备命令失败 / 未产出副本（用新版本号确保无现成副本） ──
  fs.writeFileSync(path.join(wsPrep, 'make-release.cjs'), "console.error('boom'); process.exit(1)\n")
  const f = seedProject('guard-prep-fail', wsPrep, { manual: '3.0.1', evidence: true, prepare: 'node make-release.cjs {version}' })
  record = await service.run(f, targetOf(f).id)
  assert.equal(record.status, 'failed')
  assert(record.message.includes('准备命令退出码 1'), record.message)

  fs.writeFileSync(path.join(wsPrep, 'make-release.cjs'), "console.log('nothing')\n")
  const g = seedProject('guard-prep-none', wsPrep, { manual: '3.0.2', evidence: true, prepare: 'node make-release.cjs {version}' })
  record = await service.run(g, targetOf(g).id)
  assert.equal(record.status, 'failed')
  assert(record.message.includes('未生成版本 3.0.2 的发布副本'), record.message)
  assert.equal(connections.length, 3, '准备命令失败路径不得连接服务器')

  // ── 归一化：docker.prepareCommand / prepareTimeoutSec ──
  assert.equal(projects.defaultProject().docker.prepareCommand, '')
  assert.equal(projects.defaultProject().docker.prepareTimeoutSec, 900)
  const prepCfg = projects.defaultProject()
  prepCfg.name = 'prep-cfg'; prepCfg.localPath = ws; prepCfg.configMode = 'manual'; prepCfg.deployMode = 'docker'
  prepCfg.docker.prepareCommand = '  node x.cjs {version}  '
  prepCfg.docker.prepareTimeoutSec = 5
  assert(projects.save(prepCfg).ok)
  const savedPrep = projects.list().find((p) => p.name === 'prep-cfg').docker
  assert.equal(savedPrep.prepareCommand, 'node x.cjs {version}', '准备命令去除首尾空白')
  assert.equal(savedPrep.prepareTimeoutSec, 900, '非法超时回退默认 900')

  console.log('PASS 发布内容门禁：版本漂移拦截、发布副本凭证校验与自动改用副本、准备命令一键生成、check 阶段先于连接、发布链形态放行')
})().catch((e) => { console.error(e.stack); process.exitCode = 1 }).finally(() => {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-release-guard-')) fs.rmSync(root, { recursive: true, force: true })
})
