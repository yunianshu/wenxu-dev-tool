/**
 * AI 部署助手自测（无框架，node scripts/deploy-ai-selftest.cjs 直接运行）
 *
 * 覆盖：
 *   - scanLocal 对「自带发布脚本的项目」「只有 Compose 的项目」「什么部署文件都没有的新项目」的体检结论
 *   - buildHeuristicPlan 的形态判定/产物目录/健康检查/数据库/数据同步候选
 *   - parseCompose / parseEnvKeys / assertWritablePath / mergePlan（AI 输出校验与合并）
 *   - writeFiles 的路径防护、覆盖前备份、换行规范化
 *   - diagnose 全链路（SSH 与 AI 打桩）与 applyPlan 落盘（凭据不丢）
 * 打桩边界：SSH/SFTP（本机无服务器）与 AI 接口（外部服务）打桩；
 *   项目扫描、方案合并、文件写入、配置落盘全部走真实实现。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-deploy-test-'))
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

// ── ssh-service 打桩：返回一段固定的「服务器体检」输出 ──
const REMOTE_OUT = `__SEC_OS__
Linux 5.15.0-91-generic x86_64
hprt
__SEC_TOOLS__
Docker version 24.0.7, build afdd53b
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
DIR_EXISTS
compose.yaml
.env
runtime
__SEC_COMPOSE__
shopmetrics|running(3)|/home/hprt/docker/openclaw-ds/shopmetrics/compose.yaml
__SEC_MANAGED__
__SEC_DOCKER__
shopmetrics-postgres-1|Up 2 weeks (healthy)|postgres:16-alpine
shopmetrics-shopmetrics-1|Up 2 weeks (healthy)|shopmetrics-shopmetrics
__SEC_VOLUMES__
shopmetrics_postgres-data
shopmetrics_clickhouse-data
__SEC_PORTS__
0.0.0.0:9000
__SEC_END__
`
let lastExecCmd = ''
const sshPath = require.resolve('../electron/deploy/ssh-service')
require.cache[sshPath] = {
  id: sshPath, filename: sshPath, loaded: true,
  exports: {
    remoteJoin: require('../electron/deploy/ssh-service').remoteJoin,
    connect: async () => ({ stub: true }),
    exec: async (_conn, cmd) => { lastExecCmd = cmd; return { code: 0, stdout: REMOTE_OUT, stderr: '' } },
    close: () => {},
  },
}

// ── ai-service 打桩：记录提示词并按需返回计划 JSON ──
let lastPrompt = ''
let aiReply = ''
const aiCalls = []
// json=直接返回 JSON；error=抛错；reasoning=首次只回推理内容（正文为空），第二次回 JSON
let aiMode = 'json'
// 记录每次调用是否带「关闭推理」参数，以及带参数时是否被网关拒绝（4xx → 去掉参数重试）
const effortSeen = []
let rejectEffort = false
const aiPath = require.resolve('../electron/ai-service')
require.cache[aiPath] = {
  id: aiPath, filename: aiPath, loaded: true,
  exports: {
    // AI 部署方案走非流式 complete()：返回 finish_reason / reasoning 便于降级判断
    complete: async ({ messages, reasoningEffort }) => {
      lastPrompt = JSON.stringify(messages)
      aiCalls.push(lastPrompt)
      effortSeen.push(reasoningEffort)
      if (reasoningEffort && rejectEffort) {
        const e = new Error('AI 接口请求失败（HTTP 400）：unsupported parameter reasoning_effort')
        e.status = 400
        throw e
      }
      if (aiMode === 'error') throw aiReply
      if (aiMode === 'reasoning' && aiCalls.length === 1) {
        return { text: '', finishReason: 'length', reasoning: '先想一想……（推理占满预算）', model: 'stub-model' }
      }
      return { text: typeof aiReply === 'string' ? aiReply : '', finishReason: 'stop', reasoning: '', model: 'stub-model' }
    },
  },
}

const projects = require('../electron/deploy/deploy-projects')
const aiDeploy = require('../electron/deploy/ai-deploy')

// ───────────────────────── 测试夹具 ─────────────────────────
function writeFixture(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
}

// 夹具 A：自带发布脚本的项目（形态同 ShopMetrics）
const projScript = path.join(tmpRoot, 'proj-script')
writeFixture(projScript, {
  'VERSION': '1.0.0\n',
  'requirements.txt': 'fastapi\n',
  'compose.yaml': `services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: shopmetrics
      POSTGRES_USER: shopmetrics
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data
  shopmetrics:
    build:
      context: .
    ports:
      - "\${SHOPMETRICS_BIND_IP}:9000:9000"
    volumes:
      - ./runtime/shopmetrics/output:/app/output
      - ./dataSource:/app/dataSource
    secrets:
      - shopmetrics_api_token
secrets:
  shopmetrics_api_token:
    file: ./secrets/shopmetrics_api_token.txt
volumes:
  postgres-data:
`,
  'Dockerfile': 'FROM python:3.12-slim\n',
  '.env.example': 'SHOPMETRICS_BIND_IP=10.0.0.10\nPOSTGRES_PASSWORD=change-this-postgres-password\n',
  'package.sh': '#!/usr/bin/env bash\necho pack\n',
  'upgrade.sh': '#!/usr/bin/env bash\nINSTALL_ROOT="${INSTALL_ROOT:-}"\necho upgrade\n',
  'start.sh': '#!/usr/bin/env bash\necho start\n',
  'stop.sh': '#!/usr/bin/env bash\necho stop\n',
  'runtime/shopmetrics/output/ai_settings.json': '{"model":"x"}\n',
  'dataSource/2025年1月进销存.xlsx': 'dummy-bytes',
  'dist/shopmetrics-v1.0.0-20260101010101.tar.gz': 'dummy-archive',
})
fs.mkdirSync(path.join(projScript, 'secrets'), { recursive: true })
fs.writeFileSync(path.join(projScript, 'secrets', 'shopmetrics_api_token.txt'), 'tok\n')

// 夹具 B：纯 Compose 项目
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
volumes:
  web-data:
`,
  'data/a.txt': 'x',
})

// 夹具 C：新项目，没有任何部署文件
const projNew = path.join(tmpRoot, 'proj-new')
writeFixture(projNew, {
  'package.json': JSON.stringify({ name: 'fresh', version: '0.1.0' }),
  'src/index.js': 'console.log(1)\n',
})

const projectOf = (localPath, name) => ({ id: 'p1', name, localPath, composeFile: 'docker-compose.yml', scriptMode: { artifactDir: 'release', packageCommand: '' }, targets: [] })
const TARGET = { id: 't1', name: '默认环境', remotePath: '/srv/app', server: { host: '10.0.0.9', port: 22, username: 'root', authType: 'password' }, health: {}, db: {} }

async function main() {
  // ── ① parseCompose / parseEnvKeys ──
  const composeText = fs.readFileSync(path.join(projScript, 'compose.yaml'), 'utf8')
  const c = aiDeploy.parseCompose(composeText)
  assert.deepStrictEqual(c.services.sort(), ['postgres', 'shopmetrics'], 'parseCompose 服务名')
  assert.ok(c.images.includes('postgres:16-alpine'), 'parseCompose 镜像')
  assert.ok(c.ports.includes('${SHOPMETRICS_BIND_IP}:9000:9000'), `parseCompose 端口: ${c.ports}`)
  assert.ok(c.bindMounts.some((b) => b.host === './runtime/shopmetrics/output' && b.container === '/app/output'), 'parseCompose 绑定挂载')
  assert.ok(c.secretFiles.includes('./secrets/shopmetrics_api_token.txt'), 'parseCompose secret 文件')
  assert.ok(c.requiredEnv.includes('POSTGRES_PASSWORD') && c.requiredEnv.includes('SHOPMETRICS_BIND_IP'), `parseCompose 变量: ${c.requiredEnv}`)

  const keys = aiDeploy.parseEnvKeys('A=1\n# c\nB=change-this-x\nC=\n')
  assert.deepStrictEqual(keys.map((k) => k.key), ['A', 'B', 'C'], 'parseEnvKeys 键名')
  assert.strictEqual(keys[0].placeholder, false)
  assert.strictEqual(keys[1].placeholder, true, '示例值应识别为占位')
  assert.strictEqual(keys[2].placeholder, true, '空值应识别为占位')

  // ── ② scanLocal：自带发布脚本的项目 ──
  const localA = aiDeploy.scanLocal(projectOf(projScript, 'proj-script'))
  assert.strictEqual(localA.exists, true)
  assert.strictEqual(localA.version.version, '1.0.0', `版本识别: ${JSON.stringify(localA.version)}`)
  const presentA = localA.deployFiles.present.map((f) => f.rel)
  for (const rel of ['compose.yaml', 'Dockerfile', 'package.sh', 'upgrade.sh', 'start.sh', 'stop.sh', 'VERSION', '.env.example']) {
    assert.ok(presentA.includes(rel), `应识别到部署文件 ${rel}（实际 ${presentA}）`)
  }
  assert.deepStrictEqual(localA.artifactDirs.map((a) => a.path), ['dist'], `产物目录: ${JSON.stringify(localA.artifactDirs)}`)
  assert.ok(localA.dataCandidates.some((d) => d.path === 'runtime/shopmetrics/output'), '数据目录候选应含 runtime/shopmetrics/output')
  assert.ok(localA.dataCandidates.some((d) => d.path === 'dataSource'), '数据目录候选应含 dataSource')
  assert.ok(localA.dataCandidates.find((d) => d.path === 'runtime/shopmetrics/output').mounted, '被 Compose 挂载的目录应标记 mounted')
  assert.ok(localA.sensitive.includes('secrets'), '敏感目录应被识别')

  // ── ③ 启发式方案：脚本形态 ──
  const planA = aiDeploy.buildHeuristicPlan(projectOf(projScript, 'proj-script'), TARGET, localA, { ok: false, error: '未体检' })
  assert.strictEqual(planA.deployMode, 'script', '自带发布脚本应判为脚本部署')
  assert.strictEqual(planA.scriptMode.artifactDir, 'dist', `产物目录: ${planA.scriptMode.artifactDir}`)
  assert.strictEqual(planA.scriptMode.upgradeScript, 'upgrade.sh')
  assert.strictEqual(planA.scriptMode.packageCommand, 'bash package.sh')
  assert.strictEqual(planA.health.url, 'http://127.0.0.1:9000/', `健康检查: ${planA.health.url}`)
  // 跨版本共享 vs 本地推送：Compose 挂在项目目录下的运行时数据属于「必须迁到 shared 共享」，
  // 不需要把本地数据推送到服务器（needed=false, mode=share）
  assert.strictEqual(planA.dataSync.needed, false, '服务器自己产生的运行时数据不需要本地推送')
  assert.strictEqual(planA.dataSync.mode, 'share')
  assert.ok(
    planA.dataSync.sharedDirs.includes('runtime/shopmetrics/output') && planA.dataSync.sharedDirs.includes('dataSource'),
    `应列出必须跨版本共享的目录: ${JSON.stringify(planA.dataSync.sharedDirs)}`,
  )
  assert.ok(planA.dataSync.items.every((i) => i.kind === 'share'), `全部应为共享项: ${JSON.stringify(planA.dataSync.items)}`)
  assert.ok(/shared/.test(planA.dataSync.reason), `理由应说明迁到 shared: ${planA.dataSync.reason}`)
  assert.ok(planA.dataSync.items.some((i) => i.localDir === 'runtime/shopmetrics/output' && i.remoteDir === 'shared/output'), `共享去向: ${JSON.stringify(planA.dataSync.items)}`)
  assert.ok(planA.prerequisites.some((p) => /POSTGRES_PASSWORD/.test(p.item)), '应提示 Compose 必填变量')
  assert.ok(planA.prerequisites.some((p) => /shopmetrics_api_token/.test(p.item)), '应提示 Docker secret 文件')

  // ── ④ 启发式方案：纯 Compose 项目 → docker 形态 ──
  const localB = aiDeploy.scanLocal(projectOf(projDocker, 'proj-docker'))
  const planB = aiDeploy.buildHeuristicPlan(projectOf(projDocker, 'proj-docker'), TARGET, localB, { ok: false, error: '未体检' })
  assert.strictEqual(planB.deployMode, 'docker', '只有 Compose 时按 docker 形态')
  assert.strictEqual(planB.composeFile, 'docker-compose.yml')
  assert.strictEqual(planB.health.url, 'http://127.0.0.1:8080/')
  assert.strictEqual(localB.version.version, '2.3.4', 'package.json 版本识别')

  // ── ⑤ 启发式方案：新项目（无任何部署文件）──
  const localC = aiDeploy.scanLocal(projectOf(projNew, 'proj-new'))
  const planC = aiDeploy.buildHeuristicPlan(projectOf(projNew, 'proj-new'), TARGET, localC, { ok: false, error: '未体检' })
  assert.ok(localC.risks.some((r) => /没有 Compose 编排，也没有发布脚本/.test(r)), `新项目风险: ${JSON.stringify(localC.risks)}`)
  const missingC = planC.missingFiles.map((m) => m.path)
  for (const rel of ['upgrade.sh', 'start.sh', 'package.sh']) {
    assert.ok(missingC.includes(rel), `新项目应提示缺 ${rel}（实际 ${missingC}）`)
  }

  // ── ⑥ assertWritablePath：只允许部署相关文件 ──
  for (const ok of ['Dockerfile', '.deployignore', '.env.example', 'docker-compose.yml', 'compose.release.yaml', 'upgrade.sh', 'deploy/bootstrap.sh', 'scripts/build.sh', 'migrations/001-init.sh']) {
    assert.strictEqual(aiDeploy.assertWritablePath(ok).ok, true, `应允许生成 ${ok}`)
  }
  for (const bad of ['src/app.js', '../evil.sh', '/etc/passwd', 'package.json', 'tests/a.sh', 'README.md', 'a/../../../b.sh', 'C:/x.sh']) {
    const r = aiDeploy.assertWritablePath(bad)
    assert.strictEqual(r.ok, false, `应拒绝 ${bad}`)
  }

  // ── ⑦ mergePlan：AI 输出校验与合并 ──
  const aiPlan = {
    summary: 'AI 结论',
    deployMode: 'script',
    deployModeReason: '项目自带发布脚本',
    composeFile: 'compose.yaml',
    scriptMode: { artifactDir: 'dist', upgradeScript: 'upgrade.sh', packageCommand: 'bash package.sh', autoBumpVersion: false },
    version: { strategy: 'manual', manual: '1.0.1' },
    health: { enabled: true, url: 'not-a-url', timeout: 9999, interval: 0 },
    db: { enabled: true, type: 'postgres', container: 'shopmetrics-postgres-1', name: 'shopmetrics', user: 'shopmetrics' },
    dataSync: { needed: true, reason: '服务端数据由后台上传，本地只同步初始 Excel', items: [{ kind: 'upload', localDir: 'dataSource', remoteDir: 'shared/dataSource', note: '首次导入用' }], importMode: 'command', importCommand: 'bash import.sh {dataDir}' },
    missingFiles: [{ path: 'upgrade.sh', why: '需支持 INSTALL_ROOT' }],
    prerequisites: [{ item: '共享 .env', why: '缺了起不来', how: '复制样例并改密码' }],
    risks: ['数据库卷名必须保持 shopmetrics 前缀'],
    files: [
      { path: 'upgrade.sh', action: 'update', purpose: '适配部署契约', content: '#!/usr/bin/env bash\necho ok\n' },
      { path: 'src/hack.py', action: 'update', purpose: '越权修改业务代码', content: 'x' },
      { path: 'start.sh', action: 'create', purpose: '空内容应被丢弃', content: '   ' },
    ],
  }
  const merged = aiDeploy.mergePlan(planA, aiPlan)
  assert.strictEqual(merged.source, 'ai')
  assert.strictEqual(merged.scriptMode.autoBumpVersion, false, 'AI 的布尔字段应生效')
  assert.strictEqual(merged.scriptMode.artifactDir, 'dist')
  assert.strictEqual(merged.version.manual, '1.0.1')
  assert.strictEqual(merged.health.url, 'http://127.0.0.1:9000/', '非法健康检查地址应回落到启发式结果')
  assert.strictEqual(merged.db.container, 'shopmetrics-postgres-1')
  assert.strictEqual(merged.dataSync.items[0].localDir, 'dataSource')
  assert.strictEqual(merged.dataSync.importMode, 'command')
  assert.strictEqual(merged.files.length, 1, `只应保留白名单内的非空文件（实际 ${JSON.stringify(merged.files.map((f) => f.path))}）`)
  assert.strictEqual(merged.files[0].path, 'upgrade.sh')
  assert.ok(merged.risks.some((r) => /src\/hack\.py/.test(r)), '被拒绝的文件应记入风险')
  // 只认 --install-root 参数、不读 INSTALL_ROOT 环境变量的升级脚本 → 必须提示改写
  const projArgOnly = path.join(tmpRoot, 'proj-arg-only')
  writeFixture(projArgOnly, {
    'VERSION': '0.1.0\n',
    'upgrade.sh': '#!/usr/bin/env bash\n# 用法: ./upgrade.sh --install-root <目录>\nARG=""; [ "$1" = "--install-root" ] && ARG="$2"\nSHOPMETRICS_INSTALL_ROOT="$ARG"\necho upgrade\n',
    'start.sh': '#!/usr/bin/env bash\necho start\n',
    'compose.yaml': 'services:\n  app:\n    image: nginx\n',
  })
  const localArgOnly = aiDeploy.scanLocal(projectOf(projArgOnly, 'arg-only'))
  const planArgOnly = aiDeploy.buildHeuristicPlan(projectOf(projArgOnly, 'arg-only'), TARGET, localArgOnly, { ok: false, error: '未体检' })
  assert.ok(
    planArgOnly.files.some((f) => f.path === 'upgrade.sh' && f.action === 'update'),
    `参数式安装根的升级脚本应进入改写清单: ${JSON.stringify(planArgOnly.files)}`,
  )
  // DB 信息不全时自动降级关闭，避免发布到服务器才失败
  const mergedBadDb = aiDeploy.mergePlan(planA, { db: { enabled: true, type: 'postgres', container: 'x', name: '' } })
  assert.strictEqual(mergedBadDb.db.enabled, false)

  // ── ⑧ extractJson：容忍围栏与前后废话，并能修复被截断的 JSON ──
  assert.deepStrictEqual(aiDeploy.extractJson('前置说明\n```json\n{"a":1}\n```\n后置'), { a: 1 })
  assert.deepStrictEqual(aiDeploy.extractJson('{"a":2}'), { a: 2 })
  assert.strictEqual(aiDeploy.extractJson('不是 JSON'), null)
  // 输出被 token 上限截断：字符串未闭合 + 括号未闭合，应尽量抢救出可解析部分
  const truncated = '{"summary":'
  assert.strictEqual(aiDeploy.extractJson(truncated), null, '缺少值的截断无法抢救')
  const truncated2 = '{"summary":"服务已有旧部署，需要接管","risks":["风险一","风险二"],"migration":["步骤1","步骤2被截'
  const salvaged = aiDeploy.extractJson(truncated2)
  assert.ok(salvaged && salvaged.summary === '服务已有旧部署，需要接管', `截断修复应保留已完整字段: ${JSON.stringify(salvaged)}`)
  assert.deepStrictEqual(salvaged.risks, ['风险一', '风险二'])
  assert.strictEqual(salvaged.__repaired, true, '修复过的 JSON 必须带标记（用于丢弃半截内容）')
  // 修复标记生效：被截断的 AI 输出不得采纳其生成的文件内容（会写入半截脚本）
  const salvagedWithFiles = aiDeploy.extractJson(truncated2)
  salvagedWithFiles.files = [{ path: 'upgrade.sh', action: 'update', purpose: '半截内容', content: '#!/usr/bin/env bash\necho 半截' }]
  const repairedMerge = aiDeploy.mergePlan(planA, salvagedWithFiles)
  assert.strictEqual(repairedMerge.files.length, 0, '截断修复的输出不应采纳生成文件')
  assert.ok(repairedMerge.risks.some((r) => /截断/.test(r)), '丢弃生成文件应记入风险')

  // ── ⑨ writeFiles：真实落盘 + 备份 + 路径防护 ──
  const saved = projects.save({ name: 'proj-script', localPath: projScript, composeFile: 'compose.yaml', targets: [TARGET] })
  assert.ok(saved.ok)
  const before = fs.readFileSync(path.join(projScript, 'upgrade.sh'), 'utf8')
  const w = aiDeploy.writeFiles(saved.id, [
    { path: 'upgrade.sh', content: '#!/usr/bin/env bash\r\necho new\r\n' },
    { path: 'legacy/notes.md', content: 'x' },
    { path: 'start.sh', content: '   ' },
  ])
  const byPath = Object.fromEntries((w.results || []).map((r) => [r.path, r]))
  assert.strictEqual(byPath['upgrade.sh'].action, 'updated', JSON.stringify(w.results))
  assert.ok(byPath['upgrade.sh'].backup, '覆盖前应生成备份')
  assert.strictEqual(fs.readFileSync(path.join(projScript, 'upgrade.sh'), 'utf8'), '#!/usr/bin/env bash\necho new\n', '应按 LF 写入')
  assert.ok(fs.existsSync(path.join(projScript, byPath['upgrade.sh'].backup)), '备份文件应存在')
  assert.strictEqual(fs.readFileSync(path.join(projScript, byPath['upgrade.sh'].backup), 'utf8'), before, '备份内容应为原文件')
  assert.strictEqual(byPath['legacy/notes.md'].action, 'rejected', '白名单外文件必须拒绝')
  assert.strictEqual(byPath['start.sh'].action, 'rejected', '空内容必须拒绝')
  assert.ok(!fs.existsSync(path.join(projScript, 'legacy')), '被拒绝的文件不得落盘')

  // ── ⑩ scanRemote：解析服务器体检输出 ──
  const target = { ...TARGET, remotePath: '/home/hprt/docker/openclaw-ds/shopmetrics' }
  const remote = await aiDeploy.scanRemote({ id: saved.id, targets: [target] }, target)
  assert.strictEqual(remote.ok, true, `服务器体检应成功: ${remote.error}`)
  assert.ok(lastExecCmd.includes('/home/hprt/docker/openclaw-ds/shopmetrics'), '体检命令应包含部署目录')
  assert.strictEqual(remote.pathExists, true)
  assert.deepStrictEqual(remote.pathEntries.slice(0, 3), ['compose.yaml', '.env', 'runtime'])
  assert.strictEqual(remote.tools.docker, true)
  assert.strictEqual(remote.tools.java, false)
  assert.ok(remote.containers.some((x) => x.name === 'shopmetrics-postgres-1'))
  assert.ok(remote.volumes.includes('shopmetrics_postgres-data'))

  // 容器名参与数据库配置推断（远端同名 postgres 容器）；项目名用 ShopMetrics 以命中服务器上的同名资源
  const projShop = projectOf(projScript, 'ShopMetrics')
  const planA2 = aiDeploy.buildHeuristicPlan(projShop, target, localA, remote)
  assert.strictEqual(planA2.db.enabled, true, 'Compose 有 postgres 应建议开启数据库备份')
  assert.strictEqual(planA2.db.container, 'shopmetrics-postgres-1', '容器名应由远端同名容器推断')
  assert.strictEqual(planA2.db.name, 'shopmetrics')
  assert.strictEqual(planA2.db.user, 'shopmetrics')

  // ── ⑩.1 已有部署识别：服务器上已经部署过同一个服务（首次接入必须接管）──
  assert.strictEqual(remote.composeProjects.length, 1, 'scanRemote 应解析 docker compose ls')
  assert.strictEqual(remote.composeProjects[0].name, 'shopmetrics')
  const ex = planA2.existing
  assert.strictEqual(ex.checked, true)
  assert.strictEqual(ex.kind, 'legacy', `已有部署类型: ${ex.kind}`)
  assert.ok(ex.evidence.some((e) => /docker compose 项目/.test(e)), `证据应含 compose 项目: ${JSON.stringify(ex.evidence)}`)
  assert.ok(ex.evidence.some((e) => /同名数据卷/.test(e) && /shopmetrics_postgres-data/.test(e)), '证据应点名数据卷')
  assert.ok(ex.volumes.includes('shopmetrics_postgres-data'), '应识别出同项目数据卷')
  assert.strictEqual(ex.runningContainers, 2, `应识别出运行中的同名容器（实际 ${ex.runningContainers}）`)
  assert.deepStrictEqual(ex.portConflicts.map((p) => p.port), ['9000'], `端口占用: ${JSON.stringify(ex.portConflicts)}`)
  assert.strictEqual(ex.adopt, true)
  assert.ok(ex.requiredSteps.some((s) => /备份/.test(s)), '接管步骤必须包含备份')
  assert.ok(ex.requiredSteps.some((s) => /shared/.test(s)), '接管步骤必须包含迁移到 shared')
  assert.ok(ex.risks.some((r) => /接管/.test(r)))
  assert.strictEqual(planA2.readyToDeploy, false, '存在旧部署时不得直接判定为可发布')
  assert.ok(planA2.blockers.some((b) => /已存在旧部署/.test(b)), `闸门应拦截: ${JSON.stringify(planA2.blockers)}`)
  assert.ok(planA2.blockers.some((b) => /前置条件/.test(b)), '闸门应包含前置条件')
  assert.ok(planA2.migrationPlan.length >= 3, '应给出接管步骤清单')

  // 已被本工具接管过的目标 → managed
  const remoteManaged = { ...remote, managed: { current: 'shopmetrics-v1.0.0-20260101010101', currentLink: '', releases: ['shopmetrics-v1.0.0-20260101010101'] } }
  const planManaged = aiDeploy.buildHeuristicPlan(projShop, target, localA, remoteManaged)
  const exManaged = planManaged.existing
  assert.strictEqual(exManaged.kind, 'managed')
  assert.ok(exManaged.requiredSteps.some((s) => /直接发布/.test(s)))
  assert.ok(
    !planManaged.blockers.some((b) => /首次部署前置条件/.test(b)),
    `已受管部署不应再把首次部署前置条件当作阻塞项: ${JSON.stringify(planManaged.blockers)}`,
  )
  assert.ok(planManaged.readyToDeploy, `已受管部署且无缺文件时应可直接发布: ${JSON.stringify(planManaged.blockers)}`)
  // 但 AI 补进来的"缺文件"仍会阻塞（不能因为已受管就放过缺失的部署文件）
  const managedWithMissing = aiDeploy.mergePlan(planManaged, { missingFiles: [{ path: 'upgrade.sh', why: '缺少升级脚本' }] })
  assert.ok(managedWithMissing.blockers.some((b) => /缺少部署文件/.test(b)))
  assert.strictEqual(managedWithMissing.readyToDeploy, false)

  // 服务器上什么部署都没有 → none，且不因「已有部署」阻塞
  const remoteNone = { ...remote, pathExists: false, pathEntries: [], containers: [], volumes: [], composeProjects: [], managed: { current: '', currentLink: '', releases: [] } }
  const exNone = aiDeploy.buildHeuristicPlan(projShop, target, localA, remoteNone).existing
  assert.strictEqual(exNone.kind, 'none')
  assert.strictEqual(exNone.adopt, false)
  assert.ok(exNone.requiredSteps.some((s) => /首次发布将自动创建/.test(s)))

  // AI 给出的接管步骤与必须保留项应被采纳，但不能绕过闸门
  const mergedExisting = aiDeploy.mergePlan(planA2, {
    existingDeployment: { alreadyDeployed: true, kind: 'legacy', summary: '已有手工部署', mustPreserve: ['shopmetrics_postgres-data'], adoptPlan: ['备份', '迁移 shared', '停旧实例'] },
    risks: [],
  })
  assert.deepStrictEqual(mergedExisting.migrationPlan, ['备份', '迁移 shared', '停旧实例'])
  assert.deepStrictEqual(mergedExisting.existing.mustPreserve, ['shopmetrics_postgres-data'])
  assert.strictEqual(mergedExisting.readyToDeploy, false, 'AI 结论不得绕过部署条件闸门')

  // ── ⑪ diagnose：AI 增强链路（提示词含部署契约，计划被合并）──
  aiReply = JSON.stringify(aiPlan)
  const diag = await aiDeploy.diagnose(saved.id, target.id)
  assert.strictEqual(diag.ai.used, true, `AI 应参与: ${diag.ai.error}`)
  assert.strictEqual(diag.plan.source, 'ai')
  assert.strictEqual(diag.plan.version.manual, '1.0.1')
  assert.ok(lastPrompt.includes('INSTALL_ROOT'), '提示词必须包含部署契约（INSTALL_ROOT）')
  assert.ok(lastPrompt.includes('dataSync'), '提示词必须要求回答数据同步结论')
  assert.ok(!lastPrompt.includes('stub-key'), '提示词不得包含 AI Key')

  // AI 不可用 → 降级为确定性结论，不抛错
  aiMode = 'error'
  aiReply = new Error('AI 网关不可达')
  const diagErr = await aiDeploy.diagnose(saved.id, target.id)
  assert.strictEqual(diagErr.ai.used, false)
  assert.strictEqual(diagErr.plan.source, 'heuristic')
  assert.ok(/不可达/.test(diagErr.ai.error))

  // 推理型模型：首次正文为空（推理占满预算）→ 压缩提示词重试一次（不带既有文件全文）
  aiMode = 'reasoning'
  aiReply = JSON.stringify(aiPlan)
  aiCalls.length = 0
  effortSeen.length = 0
  const diagRetry = await aiDeploy.diagnose(saved.id, target.id)
  assert.strictEqual(diagRetry.ai.used, true, '压缩重试后应拿到方案')
  assert.strictEqual(aiCalls.length, 2, `应重试一次（实际 ${aiCalls.length} 次）`)
  assert.ok(aiCalls[0].includes('package.sh'), '首次提示词应带既有脚本内容')
  assert.ok(!aiCalls[1].includes('echo pack'), '压缩提示词不应再带既有脚本全文')
  assert.deepStrictEqual(effortSeen, ['none', 'none'], '结构化输出应请求关闭推理（reasoning_effort=none）')
  aiMode = 'json'

  // 网关不支持 reasoning_effort（HTTP 400）→ 去掉该参数重试，仍应拿到方案
  aiCalls.length = 0
  effortSeen.length = 0
  rejectEffort = true
  const diagEffort = await aiDeploy.diagnose(saved.id, target.id)
  assert.strictEqual(diagEffort.ai.used, true, `去掉不支持参数后应成功: ${diagEffort.ai.error}`)
  assert.deepStrictEqual(effortSeen, ['none', undefined], `应按 400 回落一次（实际 ${JSON.stringify(effortSeen)}）`)
  rejectEffort = false

  // ── ⑫ applyPlan：写回配置且保留凭据 ──
  const rawPath = path.join(userData, 'deploy-projects.json')
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'))
  raw.servers.find((s) => s.id === raw.projects[0].targets[0].serverId).secret = { enc: '', plain: 'ssh-password' }
  raw.projects[0].targets[0].dataSync.importSecret = { enc: '', plain: 'import-secret' }
  fs.writeFileSync(rawPath, JSON.stringify(raw, null, 2), 'utf8')

  const applied = aiDeploy.applyPlan(saved.id, target.id, merged)
  assert.strictEqual(applied.ok, true, JSON.stringify(applied))
  const after = projects.list().find((p) => p.id === saved.id)
  assert.strictEqual(after.deployMode, 'script')
  assert.strictEqual(after.composeFile, 'compose.yaml')
  assert.strictEqual(after.scriptMode.artifactDir, 'dist')
  assert.strictEqual(after.scriptMode.packageCommand, 'bash package.sh')
  assert.strictEqual(after.version.strategy, 'manual')
  assert.strictEqual(after.version.manual, '1.0.1')
  assert.strictEqual(after.targets[0].health.url, 'http://127.0.0.1:9000/')
  assert.strictEqual(after.targets[0].db.container, 'shopmetrics-postgres-1')
  assert.strictEqual(after.targets[0].dataSync.enabled, true)
  assert.strictEqual(after.targets[0].dataSync.localDir, 'dataSource')
  assert.strictEqual(after.targets[0].dataSync.remoteDir, 'shared/dataSource')
  assert.strictEqual(after.targets[0].server.secretConfigured, true, '凭据必须保留')
  assert.strictEqual(after.targets[0].dataSync.importSecretConfigured, true, '数据同步凭据必须保留')

  // ── 审核回归：链接越界、凭据外发、部署闸门、混合同步目录 ──
  const auditDir = path.join(tmpRoot, 'audit-project')
  const outside = path.join(tmpRoot, 'outside')
  writeFixture(auditDir, {
    'compose.yaml': 'services:\n  app:\n    image: demo/app\n    environment:\n      API_TOKEN: audit-fake-token\n      POSTGRES_PASSWORD: ${PASSWORD:-audit-fake-default}\n      PRIVATE_KEY: |\n        audit-fake-multiline\n    volumes:\n      - ./runtime/output:/app/output\n',
    'start.sh': '#!/bin/bash\nPASSWORD="audit-fake-password"\ncurl -u audit:fake-basic https://example.invalid\necho safe-reference\n',
    'data/seed.txt': 'seed',
    'runtime/output/result.txt': 'local-output',
  })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'start.sh'), '原文件')
  fs.symlinkSync(outside, path.join(auditDir, 'deploy'), 'junction')
  const auditSaved = projects.save({ name: 'audit', localPath: auditDir, composeFile: 'compose.yaml', targets: [TARGET] })
  // 新项目会自动继承其他项目配置；再次按 id 保存以建立无版本、无打包命令的准确前提。
  projects.save({ id: auditSaved.id, name: 'audit', localPath: auditDir, composeFile: 'compose.yaml', version: { strategy: 'auto', manual: '' }, scriptMode: { packageCommand: '' }, targets: [TARGET] })
  for (const rel of ['deploy/start.sh', 'deploy/new.sh']) {
    const rejected = aiDeploy.writeFiles(auditSaved.id, [{ path: rel, content: 'echo overwritten' }])
    assert.strictEqual(rejected.results[0].action, 'rejected', `链接路径必须拒绝：${rel}`)
  }
  assert.strictEqual(fs.readFileSync(path.join(outside, 'start.sh'), 'utf8'), '原文件')
  assert.strictEqual(fs.existsSync(path.join(outside, 'new.sh')), false)
  const backup1 = aiDeploy.writeFiles(auditSaved.id, [{ path: 'start.sh', content: 'echo first' }]).results[0].backup
  const backup2 = aiDeploy.writeFiles(auditSaved.id, [{ path: 'start.sh', content: 'echo second' }]).results[0].backup
  assert.notStrictEqual(backup1, backup2, '连续写入不得覆盖同一备份')
  // 把含凭据的原文件还原到隔离夹具，仅供提示词验证。
  fs.copyFileSync(path.join(auditDir, backup1), path.join(auditDir, 'start.sh'))
  const auditProject = projects.list().find((p) => p.id === auditSaved.id)
  const auditLocal = aiDeploy.scanLocal(auditProject)
  const auditPlan = aiDeploy.buildHeuristicPlan(auditProject, {}, auditLocal, { ok: false, error: 'offline' })
  const emptyAi = aiDeploy.mergePlan(auditPlan, { missingFiles: [], prerequisites: [], readyToDeploy: true })
  assert.strictEqual(emptyAi.readyToDeploy, false)
  for (const hint of ['版本号', '服务器地址', '远程部署目录', '体检未完成', '首次部署前置条件']) {
    assert.ok(emptyAi.blockers.some((b) => b.includes(hint)), `AI 空清单不得清除 ${hint}`)
  }
  const manualAi = aiDeploy.mergePlan(auditPlan, { version: { strategy: 'manual', manual: '1.2.3' } })
  assert.ok(!manualAi.blockers.some((b) => b.includes('版本号')), '有效手动版本应解除版本阻塞')
  const invalidVersion = aiDeploy.mergePlan(auditPlan, { version: { strategy: 'manual', manual: 'bad version' } })
  assert.ok(invalidVersion.blockers.some((b) => b.includes('版本号')), '保存配置时会被清空的非法手动版本不得通过检查')
  const scriptAi = aiDeploy.mergePlan(auditPlan, { deployMode: 'script', missingFiles: [] })
  assert.ok(scriptAi.missingFiles.some((f) => f.path === 'upgrade.sh'), '切换部署形态后应重新检查入口脚本')
  const prompts = aiDeploy.buildPrompt({ project: auditProject, target: {}, local: auditLocal, remote: {}, heuristic: auditPlan })
  const assertNoSecrets = (prompt) => {
    for (const secret of ['audit-fake-token', 'audit-fake-default', 'audit-fake-multiline', 'audit-fake-password', 'audit:fake-basic']) {
      assert.ok(!prompt.includes(secret), `提示词不得包含虚构凭据 ${secret}`)
    }
  }
  assertNoSecrets(JSON.stringify(prompts))
  aiReply = '#!/bin/bash\necho generated'
  const generated = await aiDeploy.generateFileContent(auditSaved.id, TARGET.id, { path: 'start.sh', action: 'update' })
  assert.strictEqual(generated.ok, true)
  assertNoSecrets(lastPrompt)
  assert.ok(lastPrompt.includes('safe-reference'), '脱敏后仍应保留安全的脚本参考')
  assert.strictEqual((await aiDeploy.generateFileContent(auditSaved.id, TARGET.id, { path: 'deploy/start.sh' })).ok, false)
  const mixedApply = aiDeploy.applyPlan(auditSaved.id, TARGET.id, auditPlan)
  assert.strictEqual(mixedApply.ok, true)
  const sync = projects.list().find((p) => p.id === auditSaved.id).targets[0].dataSync
  assert.strictEqual(sync.localDir, 'data', '应选择 upload 项，不得把 share 项作为上传源')
  assert.strictEqual(sync.remoteDir, 'shared/data')
  const beforeReject = JSON.stringify(projects.list())
  for (const items of [
    [{ kind: 'upload', localDir: 'a' }, { kind: 'upload', localDir: 'b' }],
    [{ localDir: 'unknown' }],
  ]) {
    const rejected = aiDeploy.applyPlan(auditSaved.id, TARGET.id, { ...auditPlan, dataSync: { needed: true, items } })
    assert.strictEqual(rejected.ok, false, '多个上传目录或用途不明时不得静默套用')
    assert.strictEqual(JSON.stringify(projects.list()), beforeReject, '拒绝套用时配置必须保持不变')
  }
  assert.strictEqual(aiDeploy.applyPlan(auditSaved.id, 'deleted-target', auditPlan).ok, false, '失效环境不得回退写入第一个环境')
  // 最终形态检查也必须放行合法镜像编排及自定义构建路径。
  writeFixture(auditDir, { 'VERSION': '1.0.0', 'compose.yaml': 'services:\n  app:\n    image: demo/app\n' })
  const imagePlan = aiDeploy.buildHeuristicPlan(auditProject, TARGET, aiDeploy.scanLocal(auditProject), remoteNone)
  assert.strictEqual(imagePlan.readyToDeploy, true, '纯镜像编排不应要求 Dockerfile')
  writeFixture(auditDir, {
    'compose.yaml': 'services:\n  app:\n    build:\n      context: ./server\n      dockerfile: Dockerfile.prod\n',
    'server/Dockerfile.prod': 'FROM demo/app\n',
  })
  const buildPlan = aiDeploy.buildHeuristicPlan(auditProject, TARGET, aiDeploy.scanLocal(auditProject), remoteNone)
  assert.strictEqual(buildPlan.readyToDeploy, true, '应按 build.context/dockerfile 检查真实构建文件')
  const changedCompose = aiDeploy.mergePlan(buildPlan, { composeFile: 'deploy/missing.yaml', missingFiles: [] })
  assert.strictEqual(changedCompose.readyToDeploy, false, '最终方案引用不存在的编排时必须阻塞')

  console.log('全部通过：AI 部署助手（体检 / 方案合并 / 文件生成防护 / 配置套用 / 审核安全回归）')
}

main().catch((e) => {
  console.error('自测失败:', e && e.stack || e)
  process.exit(1)
})
