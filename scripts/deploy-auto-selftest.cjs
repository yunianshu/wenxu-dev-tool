/** 自动发布回归：真实配置/方案/打包/编排，SSH 与 AI 仅替换外部边界。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Writable } = require('stream')
const { parse, stringify } = require('yaml')
const { execFileSync } = require('child_process')
// Git 自带的 GNU tar 会把 "C:\..." 的盘符当作远程主机（tar: Cannot connect to C: resolve failed），
// 而它常排在 PATH 里系统的前面；优先用系统自带 bsdtar（zip 与 tar.gz 都能处理）。
const TAR_BIN = (() => {
  const systemRoot = process.env.SystemRoot || process.env.windir
  if (process.platform === 'win32' && systemRoot) {
    const bsdtar = path.join(systemRoot, 'System32', 'tar.exe')
    if (fs.existsSync(bsdtar)) return bsdtar
  }
  return 'tar'
})()
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-auto-test-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => path.join(root, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false },
} }
const projects = require('../electron/deploy/deploy-projects')
const auto = require('../electron/deploy/auto-deploy')
const packager = require('../electron/deploy/packager')
const ssh = require('../electron/deploy/ssh-service')
const ai = require('../electron/ai-service')
const store = require('../electron/store')
const service = require('../electron/deploy/deploy-service')
const { validateArtifact } = require('../electron/deploy/artifact-check')
const remote = new Map()
let aiCalls = 0, connects = 0, deploys = 0, collision = false, outputZip = '', cancelAi = false, failBuild = false
const logs = []
service.setEmitter((name, payload) => { if (name === 'deploy:log') logs.push(payload.text) })
store.load = () => ({ ai: { baseUrl: 'https://example.invalid', model: 'test' } })
store.getApiKey = () => 'test-only'
const compose = 'services:\n  app:\n    build:\n      context: .\n      dockerfile: .onedeploy/Dockerfile\n    environment:\n      DB_PASSWORD: ${DB_PASSWORD}\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n'
const raw = () => ({ compose, publicService: 'app', publicPort: 8080, healthPath: '/', generatedEnv: [{ name: 'DB_PASSWORD', kind: 'hex' }], files: [{ path: '.onedeploy/Dockerfile', content: 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "server.js"]\n' }] })
ai.complete = async ({ messages, signal }) => {
  aiCalls++
  assert(!JSON.stringify(messages).includes('never-send-this-value'))
  if (cancelAi) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true }))
  return { text: JSON.stringify(raw()), finishReason: 'stop' }
}
ssh.connect = async () => {
  connects++
  return { sftp: (cb) => cb(null, { end() {}, createWriteStream(file, opts) {
    assert.equal(opts.mode, 0o600)
    const chunks = []
    return new Writable({ write(chunk, _, done) { chunks.push(chunk); done() }, final(done) { remote.set(file, Buffer.concat(chunks).toString()); done() } })
  } }) }
}
ssh.close = () => {}
ssh.mkdirp = async () => {}
ssh.upload = async (_, local, target) => { remote.set(target, fs.readFileSync(local)); outputZip = local }
ssh.exec = async (_, command, onLine) => {
  if (command === 'printf "%s" "$HOME"') return { code: 0, stdout: '/home/test', stderr: '' }
  if (command.startsWith('if [ -d')) return { code: 0, stdout: collision ? 'CONFLICT' : '' }
  if (command.includes('/prepare.sh')) return { code: 0, stdout: '[OK] 已就绪' }
  if (command.startsWith('for p in')) return { code: 0, stdout: '24567\n' }
  if (command.includes('shared/.env') && command.startsWith('cat ')) {
    const file = command.match(/^cat '([^']+)'/)[1]
    return { code: 0, stdout: remote.get(file) || '' }
  }
  if (command.startsWith('sha256sum')) {
    const file = command.match(/^sha256sum '([^']+)'/)[1]
    return { code: 0, stdout: crypto.createHash('sha256').update(remote.get(file)).digest('hex') }
  }
  if (command.includes('/deploy.sh') && command.startsWith('bash ')) {
    deploys++
    if (failBuild) {
      failBuild = false
      const output = '__STAGE__:build\n构建错误：缺少源码\n__DEPLOY_FAIL__:Docker 镜像构建失败（旧版本保持运行）\n'
      onLine?.(output)
      return { code: 1, stdout: output }
    }
    assert(command.includes('--project-name') && command.includes('--release-id'))
    assert(command.includes(auto.COMPOSE))
    const entries = execFileSync(TAR_BIN, ['-tf', outputZip], { encoding: 'utf8' })
    assert(entries.includes(auto.COMPOSE) && entries.includes('.onedeploy/Dockerfile'))
    assert(entries.includes('dist/app.js'), '本地产物可进入 Docker 构建快照')
    assert(!entries.split(/\r?\n/).some((f) => f === '.env'), '运行凭据不得进入 ZIP')
    onLine?.('__STAGE__:build\n__STAGE__:start\n__STAGE__:health\n__DEPLO')
    onLine?.('Y_OK__:1.0.0\n')
    return { code: 0, stdout: '__DEPLOY_OK__:1.0.0' }
  }
  return { code: 0, stdout: '', stderr: '' }
}
let passed = 0
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name) }
function project(name) {
  const p = projects.defaultProject()
  p.name = name
  p.localPath = path.join(root, name)
  fs.mkdirSync(path.join(p.localPath, 'server'), { recursive: true })
  fs.mkdirSync(path.join(p.localPath, 'worker'), { recursive: true })
  fs.mkdirSync(path.join(p.localPath, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(p.localPath, 'VERSION'), '1.0.0')
  fs.writeFileSync(path.join(p.localPath, 'server/pom.xml'), '<project><version>1.0.0</version><properties><java.version>21</java.version></properties></project>')
  fs.writeFileSync(path.join(p.localPath, 'worker/pyproject.toml'), '[project]\nname="worker"\nrequires-python=">=3.12"')
  fs.writeFileSync(path.join(p.localPath, 'dist/app.js'), 'console.log("app")')
  fs.writeFileSync(path.join(p.localPath, '.env'), 'EXTERNAL_TOKEN=never-send-this-value\n')
  p.targets[0].server.host = 'example.invalid'
  p.targets[0].remotePath = '/legacy/other-project'
  return p
}

;(async () => {
  const p = project('auto-app')
  const saved = projects.save(p)
  await test('新项目隔离；显式复制仅服务器连接', () => {
    const second = projects.defaultProject(); second.name = 'second'; projects.save(second)
    let loaded = projects.list().find((x) => x.id === second.id)
    assert.equal(loaded.targets.length, 1); assert.equal(loaded.targets[0].server.host, '')
    projects.copyConfig({ fromProjectId: saved.id, toProjectId: second.id })
    loaded = projects.list().find((x) => x.id === second.id)
    assert.equal(loaded.targets[1].server.host, 'example.invalid'); assert.equal(loaded.targets[1].remotePath, '')
    assert.equal(loaded.version.strategy, 'auto'); assert.equal(loaded.deployMode, 'auto')
  })
  await test('技术栈识别 Java/Python 子模块，凭据不进证据', () => {
    const e = auto.evidence(p)
    assert(e.stack.some((s) => s.file === 'server/pom.xml'))
    assert(e.stack.some((s) => s.file === 'worker/pyproject.toml'))
    assert(!JSON.stringify(e).includes('never-send-this-value'))
  })
  await test('方案拒绝越界、宿主权限与外部密钥伪造', () => {
    const bad = raw(); bad.files[0].path = '.onedeploy/../../outside'; assert.throws(() => auto.validateRecipe(p, bad))
    assert.throws(() => auto.validateRecipe(p, { ...raw(), compose: 'services:\n  app:\n    image: nginx\n    privileged: true' }))
    assert.throws(() => auto.validateRecipe(p, { ...raw(), compose: 'services:\n  app:\n    image: nginx\n    volumes: ["/etc:/host"]' }))
    assert.throws(() => auto.validateRecipe(p, { ...raw(), generatedEnv: [{ name: 'EXTERNAL_API_KEY', kind: 'hex' }] }))
    const valid = raw(); valid.files[0].content += 'RUN mkdir -p /data\n'
    assert.doesNotThrow(() => auto.validateRecipe(p, valid), 'mkdir -p 不是密码参数')
    assert.equal(auto.parseEnv("TOKEN='a\\'b'\n").TOKEN, "a'b", '凭据引号往返不能改变值')
  })
  await test('忽略规则支持反向包含；精确版本且搜索版本子目录', () => {
    assert.equal(packager.createMatcher(['!dist/']).ignored('dist/app.js'), false)
    const dir = path.join(p.localPath, 'release', '1.0.1'); fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(p.localPath, 'release', 'app-1.0.10.tar.gz'), '')
    assert.equal(service.resolveArtifact({ ...p, scriptMode: { artifactDir: 'release' } }, '1.0.1').ok, false)
    fs.writeFileSync(path.join(dir, 'app-v1.0.1.tar.gz'), '')
    assert.equal(service.resolveArtifact({ ...p, scriptMode: { artifactDir: 'release' } }, '1.0.1').fileName, 'app-v1.0.1.tar.gz')
    assert.equal(projects.normalizeProject({ scriptMode: { upgradeScript: 'scripts/upgrade.sh' } }).scriptMode.upgradeScript, 'scripts/upgrade.sh')
  })
  await test('真实自动发布编排：AI→准备→新快照→上传→成功，源项目零改动', async () => {
    const result = await service.run(saved.id, p.targets[0].id)
    assert.equal(result.status, 'success', result.message + '\n' + logs.join('\n'))
    assert.equal(result.serviceUrl, 'http://example.invalid:24567')
    assert.equal(aiCalls, 1); assert.equal(deploys, 1)
    assert.equal(fs.readFileSync(path.join(p.localPath, 'VERSION'), 'utf8'), '1.0.0')
    assert(!fs.existsSync(path.join(p.localPath, auto.COMPOSE)))
    const updated = projects.list().find((x) => x.id === p.id)
    assert(updated.targets[0].remotePath.endsWith(auto.identity(p, p.targets[0].id)))
    const env = [...remote.entries()].find(([file]) => file.endsWith('shared/.env'))[1]
    const password = auto.parseEnv(env).DB_PASSWORD
    assert.equal(auto.parseEnv(env).ONEDEPLOY_URL, result.serviceUrl)
    assert(password.length === 64 && !logs.join('\n').includes(password))
    const again = await service.run(saved.id, p.targets[0].id)
    assert.equal(again.status, 'success', again.message)
    assert.notEqual(again.releaseId, result.releaseId)
    assert.equal(aiCalls, 1, '项目证据不变复用已校验方案')
    assert.equal(auto.parseEnv([...remote.entries()].find(([file]) => file.endsWith('shared/.env'))[1]).DB_PASSWORD, password)
  })
  await test('其他项目目录冲突在上传部署前停止', async () => {
    collision = true
    const before = deploys
    const r = await service.run(saved.id, p.targets[0].id)
    assert.equal(r.status, 'failed'); assert(r.message.includes('其他内容')); assert.equal(deploys, before)
    collision = false
  })
  await test('构建失败依据真实错误自动修复并重试一次', async () => {
    const before = deploys, calls = aiCalls
    failBuild = true
    const r = await service.run(saved.id, p.targets[0].id)
    assert.equal(r.status, 'success', r.message)
    assert.equal(deploys, before + 2); assert.equal(aiCalls, calls + 1)
  })
  await test('AI 准备阶段可以取消，不进入部署', async () => {
    const other = project('cancel-app'); projects.save(other); cancelAi = true
    const before = aiCalls
    const pending = service.run(other.id, other.targets[0].id)
    for (let i = 0; aiCalls === before && i < 100; i++) await new Promise((r) => setTimeout(r, 10))
    service.cancel()
    const r = await pending
    assert.equal(r.status, 'canceled'); assert.equal(service.isBusy(), false)
    cancelAi = false
  })
  await test('部署证据变化后重新规划仍保留持久化挂载', async () => {
    const loaded = projects.list().find((x) => x.id === p.id)
    const scoped = { ...loaded, _deployTargetId: p.targets[0].id }
    const complete = ai.complete
    fs.writeFileSync(path.join(p.localPath, 'README.md'), '新增构建说明')
    ai.complete = async () => ({ text: JSON.stringify({ ...raw(), compose: compose.replace('data:/data', 'data:/other-data') }), finishReason: 'stop' })
    try { await assert.rejects(() => auto.recipeFor(scoped), /数据挂载/) } finally { ai.complete = complete }
  })
  await test('脚本包契约上传前校验', async () => {
    const flat = path.join(root, 'flat'); fs.mkdirSync(flat); fs.writeFileSync(path.join(flat, 'upgrade.sh'), 'exit 0'); fs.writeFileSync(path.join(flat, 'start.sh'), 'exit 0')
    const tarFile = path.join(root, 'flat.tar.gz'); execFileSync(TAR_BIN, ['-czf', tarFile, '-C', flat, 'upgrade.sh', 'start.sh'])
    await assert.rejects(() => validateArtifact(tarFile), /顶层目录/)
  })
  await test('已有 Compose 多运行配置保持顺序与格式，单独上传且不进入构建快照', async () => {
    const p = project('compose-runtime')
    fs.mkdirSync(path.join(p.localPath, 'deploy/config'), { recursive: true })
    fs.writeFileSync(path.join(p.localPath, 'Dockerfile'), 'FROM node:22-alpine\nCOPY . /app\n')
    const rootEnv = 'ROOT_VALUE=root-fixture-private\n'
    const runtime = 'BUSINESS_OPTION=business-fixture\nRAW_VALUE="${ROOT_VALUE} with quotes"\nSHORT_TOKEN=qZ!\n'
    const worker = 'WORKER_OPTION=${ROOT_VALUE}\n'
    fs.writeFileSync(path.join(p.localPath, '.env'), rootEnv)
    fs.writeFileSync(path.join(p.localPath, 'deploy/config/runtime.properties'), runtime)
    fs.writeFileSync(path.join(p.localPath, 'README.md'), worker)
    const doc = { services: {
      api: { build: { context: '..' }, ports: ['8080:8080'], env_file: ['../.env', { path: 'config/runtime.properties', required: true, format: 'raw' }, { path: 'missing.properties', required: false }], healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost:8080/health'] } },
      worker: { image: 'node:22-alpine', env_file: ['../README.md'] },
    } }
    fs.writeFileSync(path.join(p.localPath, 'deploy/compose.yaml'), stringify(doc))
    const evidence = auto.evidence(p)
    assert(!evidence.files.some((f) => f.path === 'README.md'), '声明为 env_file 的任意文件名不能作为 AI 证据')
    const opts = { conn: {}, uploadText: async (_, text, file) => remote.set(file, text), log: () => {}, releaseId: '1.0.0-runtime-first' }
    const prepared = await auto.prepare(p, p.targets[0], opts)
    const output = parse(prepared.files.find((f) => f.path === auto.COMPOSE).content)
    const entries = output.services.api.env_file
    assert.equal(entries.length, 3)
    assert.equal(remote.get(entries[0]), rootEnv)
    assert.equal(entries[1].format, 'raw'); assert.equal(entries[1].required, true)
    assert.equal(remote.get(entries[1].path), runtime, 'raw 内容必须保持引号与插值原文')
    assert.equal(entries[2].required, false); assert(!remote.has(entries[2].path))
    assert.equal(remote.get(output.services.worker.env_file[0]), worker)
    assert.notEqual(output.services.worker.env_file[0], entries[0], '不同服务变量文件不能合并为同一份')
    assert.equal(auto.parseEnv(remote.get(prepared.remotePath + '/shared/.env')).ROOT_VALUE, 'root-fixture-private', 'env_file 引用的项目插值变量也需提供')
    for (const value of ['root-fixture-private', 'business-fixture', 'qZ!']) {
      assert(!prepared.redact('output=' + value).includes(value))
      assert(!JSON.stringify(prepared.recipe).includes(value))
      assert(!JSON.stringify(prepared.files).includes(value))
    }
    const zip = await packager.buildPackage({ projectDir: p.localPath, appName: p.name, version: '1.0.0', files: prepared.files, safeRoot: true, exclude: prepared.exclude })
    try {
      const names = execFileSync(TAR_BIN, ['-tf', zip.zipPath], { encoding: 'utf8' }).split(/\r?\n/)
      for (const rel of ['.env', 'deploy/config/runtime.properties', 'README.md']) assert(!names.includes(rel), `${rel} 不得进入 ZIP`)
    } finally { fs.unlinkSync(zip.zipPath) }
    const firstPath = entries[1].path
    fs.writeFileSync(path.join(p.localPath, 'deploy/config/runtime.properties'), 'BUSINESS_OPTION=second-runtime-fixture\n')
    const next = await auto.prepare(p, p.targets[0], { ...opts, releaseId: '1.0.1-runtime-second' })
    const nextEntries = parse(next.files.find((f) => f.path === auto.COMPOSE).content).services.api.env_file
    assert.notEqual(nextEntries[1].path, firstPath)
    assert.equal(remote.get(firstPath), runtime, '后续发布不能覆盖旧版本回滚所需的运行配置')
    assert.equal(remote.get(nextEntries[1].path), 'BUSINESS_OPTION=second-runtime-fixture\n')
    assert.equal(prepared.health.enabled, false)
    assert.equal(prepared.health.url, '', '已有容器 /health 检查不能再强制探测 /')
    assert(service.buildDeployArgs(p, { ...p.targets[0], health: prepared.health }, { fileName: 'app.zip', sha256: 'abc' }, '1.0.0').includes('--no-health'))
  })
  await test('运行配置路径与 required 校验，禁用 healthcheck 不能绕过业务探测', () => {
    const p = project('compose-validation')
    const recipe = (env_file, healthcheck) => ({ compose: stringify({ services: { app: { image: 'node:22-alpine', env_file, healthcheck } } }), publicService: 'app', publicPort: 8080 })
    assert.throws(() => auto.validateRecipe(p, recipe('../outside.env')), /路径/)
    assert.throws(() => auto.validateRecipe(p, recipe('/etc/passwd')), /路径/)
    assert.throws(() => auto.validateRecipe(p, recipe({ path: '../outside.env', required: false })), /路径/)
    assert.throws(() => auto.validateRecipe(p, recipe('missing.env')), /不存在/)
    assert.doesNotThrow(() => auto.validateRecipe(p, recipe({ path: 'missing.env', required: false })))
    assert.equal(auto.validateRecipe(p, recipe(undefined, { disable: true, test: ['CMD', 'true'] })).healthPath, '/')
    assert.equal(auto.validateRecipe(p, recipe(undefined, { test: ['NONE'] })).healthPath, '/')
    assert.equal(auto.validateRecipe(p, recipe(undefined, { test: ['CMD', 'true'] })).healthPath, null)
    assert.equal(auto.validateRecipe(p, { ...recipe(undefined, { test: ['CMD', 'true'] }), healthPath: '/ready' }).healthPath, '/ready')
  })
  console.log(`\n自动发布自测通过（${passed} 组断言）`)
})().catch((e) => { console.error(e.stack); process.exitCode = 1 }).finally(() => {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-auto-test-')) fs.rmSync(root, { recursive: true, force: true })
})
