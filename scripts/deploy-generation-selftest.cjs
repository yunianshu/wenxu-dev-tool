/** 新项目生成→校验→写入→套用→发布编排；真实文件与配置，仅替换 AI/SSH 外部边界。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { Writable } = require('stream')
const { execFileSync } = require('child_process')

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-generation-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => path.join(temporary, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false },
} }
const store = require('../electron/store')
const ai = require('../electron/ai-service')
const ssh = require('../electron/deploy/ssh-service')
const projects = require('../electron/deploy/deploy-projects')
const assistant = require('../electron/deploy/ai-deploy')
const service = require('../electron/deploy/deploy-service')
const automatic = require('../electron/deploy/auto-deploy')

store.load = () => ({ ai: { model: 'fixture', baseUrl: 'https://example.invalid' } })
store.getApiKey = () => 'fixture-only'
let replies = [], prompts = [], calls = 0
ai.complete = async ({ messages }) => {
  const text = JSON.stringify(messages)
  assert(!text.includes('private-fixture-value'), '凭据不得进入任何生成请求')
  prompts.push(text)
  calls++
  if (!replies.length) throw new Error('测试没有配置下一轮 AI 响应')
  const next = replies.shift()
  if (next instanceof Error) throw next
  return typeof next === 'object' && Object.hasOwn(next, 'text') ? next : { text: JSON.stringify(next), finishReason: 'stop' }
}
const remote = new Map()
let uploadedZip = '', deploys = 0
ssh.connect = async () => ({ sftp(callback) { callback(null, {
  end() {}, createWriteStream(file) {
    const chunks = []
    return new Writable({ write(chunk, _, done) { chunks.push(chunk); done() }, final(done) { remote.set(file, Buffer.concat(chunks)); done() } })
  },
}) } })
ssh.close = () => {}
ssh.mkdirp = async () => {}
ssh.upload = async (_, local, remotePath) => { remote.set(remotePath, fs.readFileSync(local)); uploadedZip = local }
const tools = '__SEC_OS__\nLinux x86_64\nfixture\n__SEC_TOOLS__\nDocker version 27\nDocker Compose version v2\nunzip=yes\ntar=yes\ncurl=yes\nsha256sum=yes\n__SEC_DIR__\nDIR_MISSING\n__SEC_END__\n'
ssh.exec = async (_, command, onLine) => {
  if (command.includes('__SEC_OS__')) return { code: 0, stdout: tools, stderr: '' }
  if (command === 'printf "%s" "$HOME"') return { code: 0, stdout: '/home/fixture', stderr: '' }
  if (command.startsWith('for p in')) return { code: 0, stdout: '18080\n', stderr: '' }
  if (command.startsWith('cat ') && command.includes('/shared/.env')) {
    const file = command.match(/^cat '([^']+)'/)[1]
    return { code: 0, stdout: remote.get(file)?.toString() || '', stderr: '' }
  }
  if (command.startsWith('sha256sum ')) {
    const file = command.match(/^sha256sum '([^']+)'/)[1]
    return { code: 0, stdout: crypto.createHash('sha256').update(remote.get(file)).digest('hex'), stderr: '' }
  }
  if (command.startsWith('bash ') && command.includes('/deploy.sh')) {
    deploys++
    assert(command.includes(automatic.COMPOSE), '生成方案必须继续使用隔离的自动发布执行器')
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
    const entries = execFileSync(tar, ['-tf', uploadedZip], { encoding: 'utf8' }).split(/\r?\n/)
    for (const file of ['compose.yaml', 'deploy/Dockerfile.server', 'src/server.js', 'package.json']) assert(entries.includes(file), `${file} 必须进入真实发布包`)
    assert(entries.includes(automatic.COMPOSE), '自动编排必须进入快照')
    assert(!entries.includes('.env'), '发布包不能包含运行凭据')
    const output = '__STAGE__:build\n__STAGE__:start\n__STAGE__:health\n__DEPLOY_OK__:0.1.0\n'
    onLine?.(output)
    return { code: 0, stdout: output, stderr: '' }
  }
  return { code: 0, stdout: '', stderr: '' }
}

const source = path.join(temporary, 'fresh')
fs.mkdirSync(path.join(source, 'src'), { recursive: true })
fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fresh', version: '0.1.0', engines: { node: '>=22' }, scripts: { start: 'node src/server.js' } }))
fs.writeFileSync(path.join(source, 'src/server.js'), 'require("node:http").createServer((_,r)=>r.end("healthy")).listen(8080,"0.0.0.0")\n')
fs.writeFileSync(path.join(source, '.env'), 'EXTERNAL_API_KEY=private-fixture-value\n')
const project = projects.defaultProject()
project.name = 'fresh'
project.localPath = source
project.configMode = 'manual'
project.targets[0].remotePath = '/srv/fresh'
project.targets[0].server.host = 'example.invalid'
const saved = projects.save(project)
assert(saved.ok)
const id = saved.id, targetId = project.targets[0].id
const compose = 'x-onedeploy:\n  generatedEnv:\n    - name: SESSION_SECRET\n      kind: hex\n  healthPath: /health\nservices:\n  app:\n    build:\n      context: .\n      dockerfile: deploy/Dockerfile.server\n    environment:\n      SESSION_SECRET: ${SESSION_SECRET}\n    ports:\n      - "18080:8080"\n'
const dockerfile = 'FROM node:22-alpine\nWORKDIR /app\nCOPY package.json ./\nCOPY src ./src\nEXPOSE 8080\nCMD ["npm", "start"]\n'
const files = () => [
  { path: 'compose.yaml', purpose: '应用编排', content: compose },
  { path: 'deploy/Dockerfile.server', purpose: '从源码构建服务', content: dockerfile },
]
const planReply = { summary: '从真实 Node 启动代码生成容器部署', deployMode: 'docker', composeFile: 'compose.yaml',
  version: { strategy: 'auto' }, health: { enabled: true, url: 'http://127.0.0.1:18080/' },
  missingFiles: [], prerequisites: [], fileRequests: files().map(({ path, purpose }) => ({ path, purpose, action: 'create' })),
}

let passed = 0
async function test(label, fn) { await fn(); passed++; console.log('  ✓ ' + label) }
;(async () => {
  let plan
  await test('真实清单与入口补读，缺部署文件的新项目优先 Compose', async () => {
    await assert.rejects(assistant.diagnose(id, 'deleted-target'), /部署环境已不存在/)
    assert.equal((await assistant.generateFileContent(id, 'deleted-target', { path: 'Dockerfile' })).ok, false)
    assert.equal((await assistant.generateFiles(id, 'deleted-target', planReply)).ok, false)
    replies = [{ readFiles: ['src/server.js', '.env', '../outside.js'] }, planReply]
    const result = await assistant.diagnose(id, targetId)
    assert(result.ai.used, result.ai.error)
    assert.equal(result.plan.deployMode, 'docker')
    assert(!result.plan.readyToDeploy)
    assert(result.plan.missingFiles.some((file) => file.path === 'compose.yaml'))
    assert(!result.plan.files.some((file) => file.path === 'docker-compose.yml'), '方案指定路径不能保留过期默认文件')
    assert(prompts[0].includes('package.json') && prompts[0].includes('node src/server.js'))
    assert(prompts[1].includes('createServer') && prompts[1].includes('文件属于运行凭据'))
    plan = result.plan
  })
  await test('补读次数有限，不能把 readFiles 请求伪装为已生成方案', async () => {
    replies = Array.from({ length: 4 }, () => ({ readFiles: ['src/server.js'] }))
    const before = calls
    const result = await assistant.diagnose(id, targetId)
    assert(!result.ai.used)
    assert(result.ai.error.includes('补读已达到上限'))
    assert.equal(calls - before, 4)
  })
  await test('整套生成自动修复缺失构建源，完成跨文件引用校验', async () => {
    const broken = files(); broken[1].content = dockerfile.replace('COPY src', 'COPY missing')
    replies = [{ readFiles: ['src/server.js'] }, { files: broken }, { files: files() }]
    const result = await assistant.generateFiles(id, targetId, plan)
    assert(result.ok, result.error)
    assert(result.validation.ok)
    assert.equal(result.files.length, 2)
    assert(prompts.at(-1).includes('构建源不存在'))
    assert(!fs.existsSync(path.join(source, 'compose.yaml')), '生成与预览不得直接改写源项目')
  })
  await test('截断、重复错误、越界内容均不得成为可写部署文件', async () => {
    replies = [{ text: JSON.stringify({ files: files() }), finishReason: 'length' }]
    const truncated = await assistant.generateFiles(id, targetId, plan)
    assert(!truncated.ok && truncated.truncated && !truncated.files)
    replies = [{ files: [{ path: '../evil.sh', content: 'echo evil' }] }, { files: [{ path: '../evil.sh', content: 'echo evil' }] }]
    const invalid = await assistant.generateFiles(id, targetId, plan)
    assert(!invalid.ok && !invalid.files && !invalid.validation.ok)
    const denied = assistant.writeFiles(id, [{ path: 'compose.yaml', content: 'services: [' }], { targetId, plan })
    assert(!denied.ok && !fs.existsSync(path.join(source, 'compose.yaml')))
  })
  await test('单文件生成共享方案/同组上下文，并拒绝半截脚本', async () => {
    replies = [{ text: dockerfile, finishReason: 'stop' }]
    const result = await assistant.generateFileContent(id, targetId, { path: 'deploy/Dockerfile.server',
      plan: { ...plan, token: 'private-fixture-value' },
      siblings: [...files(), { path: '.env.example', content: 'APP_ENCRYPTION_KEY=private-fixture-value\n' },
        { path: 'deploy/compose.yaml', content: JSON.stringify({ PASSWORD: ['private-fixture-value'],
          SECRET: { value: 'private-fixture-value' }, CONNECTION_STRING: 'private-fixture-value', dsn: 'private-fixture-value' }) }] })
    assert(result.ok && result.validation.ok, result.error)
    assert(prompts.at(-1).includes('node src/server.js') && prompts.at(-1).includes('compose.yaml'))
    replies = [{ text: '#!/usr/bin/env bash\necho partial', finishReason: 'length' }]
    const truncated = await assistant.generateFileContent(id, targetId, { path: 'start.sh' })
    assert(!truncated.ok && !truncated.content)
  })
  await test('写入整套文件后重新体检可用，覆盖保留实际备份，配置套用不改服务器', async () => {
    const written = assistant.writeFiles(id, files(), { targetId, plan })
    assert.equal(written.results.length, 2)
    assert(written.results.every((file) => file.action === 'created'))
    const overwrite = assistant.writeFiles(id, files(), { targetId, plan })
    const result = overwrite.results.find((file) => file.path === 'deploy/Dockerfile.server')
    assert.equal(result.action, 'updated')
    assert.equal(fs.readFileSync(path.join(source, 'deploy', result.backup), 'utf8'), dockerfile)
    const checked = await assistant.diagnose(id, targetId, { useAi: false })
    assert(checked.plan.readyToDeploy, JSON.stringify(checked.plan.blockers))
    assert(checked.plan.health.url.endsWith('/health'))
    assert(!checked.plan.prerequisites.some((item) => item.item.includes('SESSION_SECRET')), '内部凭据不能误报为外部必填配置')
    assert(!checked.plan.files.some((file) => file.path === 'Dockerfile'), '子模块构建文件存在时不得误报根 Dockerfile')
    assert(assistant.applyPlan(id, targetId, { ...checked.plan, composeFile: 'compose.yaml' }).ok)
    const current = projects.list().find((item) => item.id === id)
    assert.equal(current.deployMode, 'auto', '生成与套用不能丢失自动执行器的运行配置隔离')
    assert.equal(current.targets[0].server.host, 'example.invalid')
    assert.equal(current.targets[0].remotePath, '/srv/fresh')
    assert(automatic.evidence(current).compose.some((file) => file.path === 'compose.yaml'), '自动执行器必须发现实际生成的编排')
    assert.deepEqual(service.preCheckLocal(current, current.targets[0], '0.1.0', true), [])
  })
  await test('真实打包/校验/发布编排使用生成文件，外部服务器边界隔离', async () => {
    const record = await service.run(id, targetId)
    assert.equal(record.status, 'success', record.message)
    assert.equal(deploys, 1)
    assert.equal(record.version, '0.1.0')
  })
  await test('内部凭据首次自动准备，升级复用，并保留真实健康检查路径', async () => {
    const envPath = [...remote.keys()].find((file) => file.endsWith('/shared/.env'))
    const first = remote.get(envPath).toString()
    const secret = first.match(/^SESSION_SECRET='([a-f0-9]{64})'$/m)?.[1]
    assert(secret, '内部凭据必须是真实随机生成的 32 字节值')
    const current = projects.list().find((item) => item.id === id)
    const recipe = await automatic.recipeFor(current)
    assert.equal(recipe.healthPath, '/health')
    const record = await service.run(id, targetId)
    assert.equal(record.status, 'success', record.message)
    assert(remote.get(envPath).toString().includes(`SESSION_SECRET='${secret}'`), '升级必须复用远端已有凭据')
    assert(!JSON.stringify(record).includes(secret), '随机凭据不得写入发布日志')
    assert.equal(deploys, 2)
  })
  console.log(`全部通过：${passed} 项新项目部署文件生成与发布编排回归（AI/SSH 边界替换）`)
})().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  // 本脚本独占且确定可再生的临时目录；删除前核对绝对边界。
  const resolved = path.resolve(temporary), parent = path.resolve(os.tmpdir())
  if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('deploy-generation-')) fs.rmSync(resolved, { recursive: true, force: true })
})
