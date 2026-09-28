/**
 * 极简配置发布自测（无框架，node scripts/deploy-quick-config-selftest.cjs 直接运行）
 *
 * 需求：部署配置只由用户填三项——服务器选择、服务器项目地址（remotePath）、是否同步本地数据；
 *       其余部署配置（部署形态/Compose/脚本参数/版本/健康检查/数据库备份/同步明细）在发布前
 *       按项目自动生成；面对不一样的项目生成不一样的配置。
 *
 * 覆盖：
 *   - generateQuickConfig 对「脚本项目」「Compose 项目」「什么都没有的新项目」生成不同配置
 *   - 用户输入不被覆盖：服务器、部署目录、数据同步开关、凭据全部保持
 *   - 数据同步开/关两态：开启时同步源取体检发现的本地真实目录；关闭时明确不启用
 *   - AI 增强：可用时方案生效；不可用时静默降级启发式并成功生成
 *   - 服务器体检失败：数据库信息不全自动降级关闭，发布前置检查不被生成的配置卡住
 *   - 生成结果通过 deploy-service.preCheckLocal（发布检查不再因配置缺失失败）
 *   - 导入命令依赖未配置的应用账号时只同步文件（凭据不由生成流程写入）
 * 打桩边界：SSH/SFTP（本机无服务器）与 AI 接口（外部服务）打桩；
 *   项目扫描、方案合并、配置生成与落盘（deploy-projects.json）全部走真实实现。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-deploy-test-'))
const userData = path.join(tmpRoot, 'userdata')
fs.mkdirSync(userData, { recursive: true })

// ── electron 打桩（selftest 在纯 node 下运行）──
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: { isEncryptionAvailable: () => false },
  },
}

// ── store 打桩：提供已配置的 AI（不落真实密钥），加解密委托真实实现 ──
const realStore = require('../electron/store')
const storePath = require.resolve('../electron/store')
require.cache[storePath] = {
  id: storePath, filename: storePath, loaded: true,
  exports: {
    load: () => ({ ai: { baseUrl: 'https://ai.example.com/v1', model: 'stub-model', temperature: 0.7 } }),
    getApiKey: () => 'stub-key',
    encryptText: realStore.encryptText,
    decryptText: realStore.decryptText,
  },
}

// ── ssh-service 打桩：可切换「正常体检输出」与「连接失败」 ──
const REMOTE_OUT = `__SEC_OS__
Linux 5.15.0-91-generic x86_64
root
__SEC_TOOLS__
Docker version 24.0.7, build afdd53a
Docker Compose version v2.20.2
unzip=yes
tar=yes
curl=yes
sha256sum=yes
git=yes
java=no
pg_dump=no
ss=yes
lsof=no
nc=no
__SEC_RES__
/dev/sda1 100G 50G 50G 50% /
MemTotal: 8000000 kB MemAvailable: 4000000 kB
__SEC_DIR__
DIR_MISSING
__SEC_COMPOSE__
__SEC_MANAGED__
__SEC_DOCKER__
other-postgres-1|Up 2 weeks (healthy)|postgres:16-alpine
__SEC_VOLUMES__
other_postgres-data
__SEC_PORTS__
0.0.0.0:80
__SEC_END__
`
let sshFail = false
const sshPath = require.resolve('../electron/deploy/ssh-service')
const realSsh = require('../electron/deploy/ssh-service')
require.cache[sshPath] = {
  id: sshPath, filename: sshPath, loaded: true,
  exports: {
    remoteJoin: realSsh.remoteJoin,
    connect: async () => {
      if (sshFail) throw new Error('SSH 连接失败（打桩）')
      return { stub: true }
    },
    exec: async () => ({ code: 0, stdout: REMOTE_OUT, stderr: '' }),
    close: () => {},
  },
}

// ── ai-service 打桩：可返回增强方案 JSON / 抛错 ──
let aiReply = ''
let aiMode = 'error' // 默认不可用：先验证启发式保底
const aiPath = require.resolve('../electron/ai-service')
require.cache[aiPath] = {
  id: aiPath, filename: aiPath, loaded: true,
  exports: {
    complete: async () => {
      if (aiMode === 'error') throw new Error('AI 网关不可达')
      return { text: aiReply, finishReason: 'stop', reasoning: '', model: 'stub-model' }
    },
  },
}

const projects = require('../electron/deploy/deploy-projects')
const aiDeploy = require('../electron/deploy/ai-deploy')
const deployService = require('../electron/deploy/deploy-service')

// ───────────────────────── 测试夹具 ─────────────────────────
function writeFixture(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
}

// 夹具 A：自带发布脚本项目（升级脚本满足 INSTALL_ROOT 契约）
const projScript = path.join(tmpRoot, 'proj-script')
writeFixture(projScript, {
  'VERSION': '1.0.0\n',
  'requirements.txt': 'fastapi\n',
  'compose.yaml': `services:
  app:
    build:
      context: .
    ports:
      - "9000:9000"
    volumes:
      - ./dataSource:/app/dataSource
`,
  'Dockerfile': 'FROM python:3.12-slim\n',
  'package.sh': '#!/usr/bin/env bash\necho pack\n',
  'upgrade.sh': '#!/usr/bin/env bash\nINSTALL_ROOT="${INSTALL_ROOT:-}"\necho upgrade\n',
  'start.sh': '#!/usr/bin/env bash\necho start\n',
  'stop.sh': '#!/usr/bin/env bash\necho stop\n',
  'dataSource/seed.json': '{"seed":1}\n',
})

// 夹具 B：纯 Compose 项目（Node + 绑定挂载 data 目录）
const projDocker = path.join(tmpRoot, 'proj-docker')
writeFixture(projDocker, {
  'package.json': JSON.stringify({ name: 'web', version: '2.3.4' }),
  'Dockerfile': 'FROM nginx:alpine\n',
  'docker-compose.yml': `services:
  web:
    build: .
    ports:
      - "8080:80"
    volumes:
      - ./data:/app/data
`,
  'data/a.txt': 'x',
})

// 夹具 C：没有任何部署文件的新项目
const projNew = path.join(tmpRoot, 'proj-new')
writeFixture(projNew, {
  'package.json': JSON.stringify({ name: 'fresh', version: '0.1.0' }),
  'src/index.js': 'console.log(1)\n',
})

/** 极简配置项目：用户输入只有服务器、服务器项目地址、数据同步开关 */
function saveQuickProject(name, localPath, syncEnabled, remotePath) {
  const r = projects.save({
    name,
    localPath,
    configMode: 'quick',
    deployMode: 'auto',
    targets: [{
      name: '生产',
      server: { host: '10.0.0.9', port: 22, username: 'root', authType: 'password' },
      remotePath: remotePath || '/srv/quick',
      dataSync: { enabled: syncEnabled === true },
    }],
  })
  assert.ok(r && r.ok, `保存极简项目失败: ${JSON.stringify(r)}`)
  return projects.list().find((p) => p.id === r.id)
}

const logs = []
const log = (level, text) => logs.push([level, text])

async function main() {
  // ── ① 新项目默认极简 + 旧数据不受影响（configMode 兼容） ──
  assert.strictEqual(projects.list().length, 0, '夹具环境应为空')
  const savedA = saveQuickProject('quickscript', projScript, true, '/srv/quick-a')
  assert.strictEqual(savedA.configMode, 'quick', '极简模式应原样落盘')
  const legacy = projects.save({ name: 'legacy', localPath: projNew, targets: [] })
  const legacyP = projects.list().find((p) => p.id === legacy.id)
  assert.strictEqual(legacyP.configMode, 'manual', '未声明 configMode 的旧项目必须保持完整配置模式')

  // ── ② AI 不可用 → 启发式保底：生成成功且不同项目配置不同 ──
  const genA = await aiDeploy.generateQuickConfig(savedA.id, savedA.targets[0].id, { log })
  assert.strictEqual(genA.ok, true, `脚本项目生成应成功: ${JSON.stringify(genA)}`)
  const afterA = projects.list().find((p) => p.id === savedA.id)
  const tA = afterA.targets[0]
  assert.strictEqual(afterA.configMode, 'quick', '生成后仍是极简模式（下次发布继续自动生成）')
  assert.strictEqual(afterA.deployMode, 'script', '自带升级脚本的项目应生成脚本部署形态')
  assert.strictEqual(afterA.scriptMode.upgradeScript, 'upgrade.sh')
  assert.strictEqual(afterA.scriptMode.packageCommand, 'bash package.sh')
  assert.strictEqual(afterA.version.strategy, 'auto', 'VERSION 文件可识别，版本策略自动')
  assert.strictEqual(tA.health.enabled, true)
  assert.strictEqual(tA.health.url, 'http://127.0.0.1:9000/', `健康检查按项目端口生成: ${tA.health.url}`)
  assert.strictEqual(tA.server.host, '10.0.0.9', '服务器选择不被生成改动')
  assert.strictEqual(tA.remotePath, '/srv/quick-a', '服务器项目地址不被生成改动')
  // 数据同步开关为开：同步源取体检发现的本地真实目录（dataSource）
  assert.strictEqual(tA.dataSync.enabled, true, '用户开的同步开关必须生效')
  assert.strictEqual(tA.dataSync.localDir, 'dataSource', `同步源应取项目数据目录: ${tA.dataSync.localDir}`)
  assert.strictEqual(tA.dataSync.remoteDir, 'shared/dataSource')
  // 数据库：Compose 无数据库镜像 → 不开启备份
  assert.strictEqual(tA.db.enabled, false)

  const savedB = saveQuickProject('quickdocker', projDocker, false, '/srv/quick-b')
  const genB = await aiDeploy.generateQuickConfig(savedB.id, savedB.targets[0].id, { log })
  assert.strictEqual(genB.ok, true)
  const afterB = projects.list().find((p) => p.id === savedB.id)
  const tB = afterB.targets[0]
  assert.strictEqual(afterB.deployMode, 'docker', '纯 Compose 项目应生成 Docker 形态')
  assert.strictEqual(afterB.composeFile, 'docker-compose.yml')
  assert.strictEqual(tB.health.url, 'http://127.0.0.1:8080/', `与脚本项目端口不同: ${tB.health.url}`)
  assert.strictEqual(tB.dataSync.enabled, false, '用户关的同步开关必须保持关闭')
  assert.notStrictEqual(afterB.scriptMode.packageCommand, afterA.scriptMode.packageCommand, '两个项目的脚本参数应不同')

  const savedC = saveQuickProject('quicknew', projNew, false, '/srv/quick-c')
  const genC = await aiDeploy.generateQuickConfig(savedC.id, savedC.targets[0].id, { log })
  assert.strictEqual(genC.ok, true, '新项目也应能生成配置（缺部署文件由发布检查提示）')
  const afterC = projects.list().find((p) => p.id === savedC.id)
  assert.strictEqual(afterC.deployMode, 'script', '无编排无脚本的项目按脚本形态给出待办')
  assert.ok(genC.plan.missingFiles.some((m) => m.path === 'upgrade.sh'), '应提示缺升级脚本')

  // ── ③ 生成配置必须让发布前置检查通过（A/B 有版本与部署文件） ──
  for (const p of [afterA, afterB]) {
    const t = p.targets[0]
    const ver = deployService.resolveVersion(p)
    assert.ok(ver.version, `${p.name} 应识别到版本号`)
    const problems = deployService.preCheckLocal(p, t, ver.version, false)
    assert.deepStrictEqual(problems, [], `${p.name} 生成后的配置不应被发布检查拦截: ${JSON.stringify(problems)}`)
  }

  // ── ④ 生成日志：输出配置摘要，标注结论来源 ──
  assert.ok(logs.some(([, text]) => /已按项目生成部署配置（来源：本地体检/.test(text)), `应有生成日志: ${JSON.stringify(logs)}`)
  assert.ok(logs.some(([, text]) => /部署形态：脚本部署/.test(text)))
  assert.ok(logs.some(([, text]) => /数据同步：dataSource → shared\/dataSource/.test(text)))

  // ── ⑤ AI 可用：增强方案生效（改健康检查/数据库/导入命令） ──
  aiMode = 'json'
  aiReply = JSON.stringify({
    summary: 'AI 结论',
    deployMode: 'docker',
    composeFile: 'docker-compose.yml',
    health: { enabled: true, url: 'http://127.0.0.1:8081/healthz', timeout: 120, interval: 4 },
    db: { enabled: false, type: 'postgres', container: '', name: '', user: '' },
    dataSync: { needed: false, reason: '无需推送', items: [], importMode: 'none', importCommand: '' },
  })
  const savedB2 = projects.list().find((p) => p.id === savedB.id)
  const genB2 = await aiDeploy.generateQuickConfig(savedB2.id, savedB2.targets[0].id, { log })
  assert.strictEqual(genB2.ok, true)
  const afterB2 = projects.list().find((p) => p.id === savedB2.id)
  assert.strictEqual(afterB2.targets[0].health.url, 'http://127.0.0.1:8081/healthz', 'AI 增强的健康检查应生效')
  assert.strictEqual(afterB2.targets[0].dataSync.enabled, false, '用户开关关闭时 AI 的 needed 不得打开同步')

  // 用户开关开启时，AI 结论不能关闭同步；导入命令依赖未配置账号 → 降级为只同步文件
  aiReply = JSON.stringify({
    deployMode: 'docker',
    dataSync: { needed: false, reason: 'AI 认为不需要', items: [{ kind: 'upload', localDir: 'data', remoteDir: 'shared/data' }], importMode: 'command', importCommand: 'bash import.sh {user} {secret}' },
  })
  const savedB3 = projects.list().find((p) => p.id === savedB2.id)
  savedB3.targets[0].dataSync.enabled = true
  projects.save(savedB3)
  const genB3 = await aiDeploy.generateQuickConfig(savedB3.id, savedB3.targets[0].id, { log })
  assert.strictEqual(genB3.ok, true)
  const afterB3 = projects.list().find((p) => p.id === savedB3.id)
  assert.strictEqual(afterB3.targets[0].dataSync.enabled, true, '用户开的同步开关优先于 AI 结论')
  assert.strictEqual(afterB3.targets[0].dataSync.importMode, 'none', '导入命令依赖未配置账号时必须降级为只同步文件')
  assert.ok(logs.some(([, text]) => /导入命令需要应用账号/.test(text)), '降级应写日志说明')
  aiMode = 'error'

  // ── ⑥ 服务器体检失败：数据库信息不全自动降级，发布检查仍通过 ──
  // 夹具 D：Compose 带数据库镜像（启发式会开启备份）但 env 无库名 → 体检失败时容器名也为空
  const projDb = path.join(tmpRoot, 'proj-db')
  writeFixture(projDb, {
    'package.json': JSON.stringify({ name: 'dbapp', version: '3.0.0' }),
    'Dockerfile': 'FROM node:20-alpine\n',
    'docker-compose.yml': `services:
  app:
    build: .
    ports:
      - "8500:3000"
  db:
    image: postgres:16-alpine
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  db-data:
`,
  })
  const savedD = saveQuickProject('quickdb', projDb, false, '/srv/quick-d')
  sshFail = true
  logs.length = 0
  const genD = await aiDeploy.generateQuickConfig(savedD.id, savedD.targets[0].id, { log })
  assert.strictEqual(genD.ok, true, `体检失败也应生成: ${JSON.stringify(genD)}`)
  const afterD = projects.list().find((p) => p.id === savedD.id)
  assert.strictEqual(afterD.deployMode, 'docker')
  assert.strictEqual(afterD.targets[0].db.enabled, false, '容器名/库名识别不全时应降级关闭备份')
  assert.ok(logs.some(([, text]) => /数据库容器名\/库名识别不全/.test(text)), '降级应写日志')
  const problemsD = deployService.preCheckLocal(afterD, afterD.targets[0], deployService.resolveVersion(afterD).version, false)
  assert.deepStrictEqual(problemsD, [], `体检失败后的生成配置不得卡住发布检查: ${JSON.stringify(problemsD)}`)
  sshFail = false

  // ── ⑦ 缺少用户输入时的明确失败（不静默） ──
  const rE = projects.save({
    name: 'nopath', localPath: projNew, configMode: 'quick', deployMode: 'auto',
    targets: [{
      name: '生产',
      server: { host: '10.0.0.9', port: 22, username: 'root', authType: 'password' },
      remotePath: '',
      dataSync: { enabled: false },
    }],
  })
  const savedE = projects.list().find((p) => p.id === rE.id)
  assert.strictEqual(savedE.targets[0].remotePath, '', '空部署目录应原样保存（不自动补默认）')
  const genE = await aiDeploy.generateQuickConfig(savedE.id, savedE.targets[0].id, { log })
  assert.strictEqual(genE.ok, false)
  assert.ok(/服务器项目地址/.test(genE.error), `失败原因应指向缺失的用户输入: ${genE.error}`)
  assert.strictEqual(projects.list().find((p) => p.id === savedE.id).deployMode, 'auto', '失败时不得改动配置')

  // ── ⑧ 凭据保留：生成不触碰服务器与数据同步凭据 ──
  const rawPath = path.join(userData, 'deploy-projects.json')
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
  const rawA = raw.projects.find((p) => p.id === savedA.id)
  raw.servers.find((s) => s.id === rawA.targets[0].serverId).secret = { enc: '', plain: 'ssh-password' }
  rawA.targets[0].dataSync.importSecret = { enc: '', plain: 'import-secret' }
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2), 'utf8')
  const genA2 = await aiDeploy.generateQuickConfig(savedA.id, savedA.targets[0].id, { log })
  assert.strictEqual(genA2.ok, true)
  const afterA2 = projects.list().find((p) => p.id === savedA.id)
  assert.strictEqual(afterA2.targets[0].server.secretConfigured, true, 'SSH 凭据必须保留')
  assert.strictEqual(afterA2.targets[0].dataSync.importSecretConfigured, true, '数据同步凭据必须保留')
  // 配了应用账号后，导入命令可被生成启用（凭据仍来自用户，不是生成写入的）
  const raw2 = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
  const rawA2 = raw2.projects.find((p) => p.id === savedA.id)
  assert.strictEqual(rawA2.targets[0].dataSync.importSecret.plain, 'import-secret', '落盘凭据原样保留')

  // ── ⑨ 发布入口编排：deploy:run 对极简项目先自动生成再走发布链路 ──
  const runLogs = []
  deployService.setEmitter((channel, payload) => {
    if (channel === 'deploy:log') runLogs.push(payload.text)
  })
  // 新项目（无打包脚本）：生成应完成并落盘，随后发布链路按生成后的形态继续，
  // 最终因「缺发布包构建脚本」在检查阶段失败——失败点在生成之后，证明编排顺序正确
  const rRun = projects.save({
    name: 'quickrun', localPath: projNew, configMode: 'quick', deployMode: 'auto',
    targets: [{
      name: '生产',
      server: { host: '10.0.0.9', port: 22, username: 'root', authType: 'password' },
      remotePath: '/srv/quick-run',
      dataSync: { enabled: false },
    }],
  })
  const record = await deployService.run(rRun.id, null)
  assert.strictEqual(record.status, 'failed', `缺打包脚本的极简发布应失败: ${JSON.stringify(record.message)}`)
  assert.ok(runLogs.some((t) => /已按项目生成部署配置/.test(t)), `发布日志应含生成记录: ${JSON.stringify(runLogs)}`)
  const afterRun = projects.list().find((p) => p.id === rRun.id)
  assert.strictEqual(afterRun.deployMode, 'script', '发布过程中生成的形态应已落盘')
  assert.strictEqual(afterRun.targets[0].remotePath, '/srv/quick-run', '用户填写的项目地址不被发布流程改动')
  // 缺用户输入时发布入口同样给出明确失败（后端兜底，前端守卫之外的防线）
  const rBad = projects.save({
    name: 'quickbad', localPath: projNew, configMode: 'quick', deployMode: 'auto',
    targets: [{
      name: '生产',
      server: { host: '10.0.0.9', port: 22, username: 'root', authType: 'password' },
      remotePath: '',
      dataSync: { enabled: false },
    }],
  })
  const recordBad = await deployService.run(rBad.id, null)
  assert.strictEqual(recordBad.status, 'failed')
  assert.ok(/服务器项目地址/.test(recordBad.message), `失败信息应指向用户输入: ${recordBad.message}`)

  console.log('全部通过：极简配置发布（三项用户输入 / 按项目生成 / 开关语义 / AI 降级 / 发布检查兼容 / 凭据保留 / 发布入口编排）')
}

main().catch((e) => {
  console.error('自测失败:', e && e.stack || e)
  process.exit(1)
})
