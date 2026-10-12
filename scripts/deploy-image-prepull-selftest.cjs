/** 真实 Bash 验证镜像预拉取与脚本部署；用隔离 Docker 桩，不访问网络或服务器。 */
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os')
const { spawnSync } = require('child_process')
const repo = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-image-prepull-'))
const posix = p => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())
const quote = value => "'" + String(value).replace(/'/g, "'\"'\"'") + "'"
const bashCandidates = process.platform === 'win32' ? [
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'),
  path.join(process.env.LOCALAPPDATA || 'C:/Users/Administrator/AppData/Local', 'Programs/Git/bin/bash.exe'),
] : []
const bash = bashCandidates.find(file => fs.existsSync(file)) || 'bash'
const recordBefore = process.argv.includes('--record-before')
let lastRun = null, passed = 0

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content.replace(/\r\n/g, '\n'))
}

function execute(script, cwd = root) {
  const result = spawnSync(bash, [posix(script)], { cwd, encoding: 'utf8', timeout: 20000 })
  lastRun = result
  assert.ifError(result.error)
  assert.strictEqual(result.status, 0, 'Bash 执行失败：\n' + result.stdout + result.stderr)
  return result.stdout + result.stderr
}

function parseCalls(state) {
  const file = path.join(state, 'calls.tsv')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split('\t')) : []
}

function callsFor(result, operation) {
  return result.calls.filter(args => args[0] === operation)
}

function pulls(result) { return callsFor(result, 'pull').map(args => args[args.length - 1]) }
function inspections(result) { return result.calls.filter(args => args[0] === 'image' && args[1] === 'inspect').map(args => args[args.length - 1]) }
function assertPulled(result, expected) {
  assert.deepStrictEqual(pulls(result).sort(), expected.slice().sort(), '预拉取镜像不符合期望：\n' + result.output)
}

try {
  const deploy = fs.readFileSync(path.join(repo, 'electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
  const marker = deploy.lastIndexOf('case "$CMD" in')
  assert(marker > 0, '未找到 deploy.sh 主命令入口')
  const lib = path.join(root, 'functions.sh')
  const beforeFile = path.join(repo, '.sdd/bugs/image502/before-functions.sh')
  write(lib, recordBefore && fs.existsSync(beforeFile) ? fs.readFileSync(beforeFile, 'utf8') : deploy.slice(0, marker))
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  // 调用计数和镜像缓存落盘，保证命令替换与升级子进程使用同一份 Docker 状态。
  write(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -uo pipefail
printf '%s' "$1" >> "$FAKE_STATE/calls.tsv"
for arg in "\${@:2}"; do printf '\\t%s' "$arg" >> "$FAKE_STATE/calls.tsv"; done
printf '\\n' >> "$FAKE_STATE/calls.tsv"
cached() { grep -Fxq -- "$1" "$FAKE_STATE/cache"; }
add_cache() { cached "$1" || printf '%s\\n' "$1" >> "$FAKE_STATE/cache"; }
image="\${!#}"
case "$1" in
  image)
    [ "\${2:-}" = inspect ] && cached "$image"
    exit $?
    ;;
  pull)
    direct=0
    case "$image" in registry-1.docker.io/*) direct=1 ;; esac
    attempt=$(awk -F '\\t' -v ref="$image" '$1 == "pull" && $NF == ref { n++ } END { print n+0 }' "$FAKE_STATE/calls.tsv")
    case "$FAKE_MODE" in
      success) add_cache "$image"; exit 0 ;;
      retry3) [ "$attempt" -ge 3 ] && { add_cache "$image"; exit 0; } ;;
      mirror502|mirror503|mirror504|network|tagfail)
        [ "$direct" = 1 ] && { add_cache "$image"; exit 0; }
        ;;
    esac
    case "$FAKE_MODE" in
      auth401) echo 'unauthorized: authentication required (401)' >&2 ;;
      manifest) echo 'manifest unknown: requested image not found' >&2 ;;
      network) echo 'net/http: request canceled while waiting for connection (Client.Timeout exceeded)' >&2 ;;
      mirror503) echo 'unexpected status from HEAD request: 503 Service Unavailable' >&2 ;;
      mirror504) echo 'unexpected status from HEAD request: 504 Gateway Timeout' >&2 ;;
      *) echo 'unexpected status from HEAD request: 502 Bad Gateway' >&2 ;;
    esac
    exit 1
    ;;
  tag)
    [ "$FAKE_MODE" != tagfail ] && cached "$2" && { add_cache "$3"; exit 0; }
    echo '镜像标记失败' >&2
    exit 1
    ;;
  compose)
    if [ "\${2:-}" = build ]; then
      for ref in eclipse-temurin:21-jre-jammy python:3.12-slim-bookworm node:24-bookworm-slim; do
        cached "$ref" || { echo "构建基础镜像缺失: $ref" >&2; exit 22; }
      done
    fi
    exit 0
    ;;
esac
echo '测试遇到未支持的 Docker 调用' >&2
exit 91
`)
  write(path.join(bin, 'sleep'), `#!/usr/bin/env bash
printf 'sleep\\t%s\\n' "$*" >> "$FAKE_STATE/calls.tsv"
`)
  write(path.join(bin, 'curl'), `#!/usr/bin/env bash
echo '错误：隔离测试不允许访问网络' >&2
exit 92
`)
  write(path.join(bin, 'java'), `#!/usr/bin/env bash
echo 'openjdk version "17.0.1"' >&2
`)
  write(path.join(bin, 'pg_dump'), '#!/usr/bin/env bash\nexit 0\n')
  for (const file of fs.readdirSync(bin)) fs.chmodSync(path.join(bin, file), 0o755)

  function fixture(name, files, { mode = 'success', cache = [], compose = 'docker-compose.yml', rawFiles = {} } = {}) {
    const dir = path.join(root, name), release = path.join(dir, 'release'), state = path.join(dir, 'state')
    fs.mkdirSync(release, { recursive: true })
    fs.mkdirSync(state, { recursive: true })
    write(path.join(state, 'cache'), cache.join('\n') + '\n')
    for (const [file, content] of Object.entries(files)) write(path.join(release, file), content)
    for (const [file, content] of Object.entries(rawFiles)) {
      fs.mkdirSync(path.dirname(path.join(release, file)), { recursive: true })
      fs.writeFileSync(path.join(release, file), content)
    }
    const setup = `export PATH=${quote(posix(bin))}:"$PATH"
export FAKE_STATE=${quote(posix(state))} FAKE_MODE=${quote(mode)}
`
    const test = path.join(dir, 'check.sh')
    write(test, setup + `source ${quote(posix(lib))} deploy
NEW_RELEASE=${quote(posix(release))}
COMPOSE_FILE=${quote(compose)}
prepull_release_images
status=$?
[ "$status" = 0 ] || { echo "错误：镜像预拉取不应终止发布（退出码 $status）"; exit 93; }
`)
    const output = execute(test)
    return { dir, release, state, setup, output, calls: parseCalls(state) }
  }

  function test(name, check) {
    check()
    passed++
    console.log('PASS ' + name)
  }

  test('用户发布包三个 Dockerfile FROM 均被预拉取', () => {
    const result = fixture('reported-from', {
      'server.Dockerfile': 'FROM eclipse-temurin:21-jre-jammy\n',
      'worker.Dockerfile': 'FROM python:3.12-slim-bookworm AS worker\nFROM node:24-bookworm-slim AS web\n',
    })
    assertPulled(result, ['eclipse-temurin:21-jre-jammy', 'python:3.12-slim-bookworm', 'node:24-bookworm-slim'])
  })

  test('标准 Compose 文件与自定义 Compose 路径均扫描，镜像去重并忽略变量', () => {
    const result = fixture('compose-names', {
      'compose.yml': 'services:\n  a:\n    image: "redis:7-alpine" # 注释\n',
      'compose.yaml': 'services:\n  b:\n    image: postgres:16-alpine\n',
      'docker-compose.yml': "services:\n  c:\n    image: 'nginx:alpine'\n",
      'docker-compose.yaml': 'services:\n  d:\n    image: alpine:3.20\n',
      'deploy/production.yml': 'services:\n  e:\n    image: busybox:1.36\n  local:\n    image: ${APP_IMAGE:-local-app:latest}\n',
      'nested/Dockerfile': 'FROM redis:7-alpine\n',
    }, { compose: 'deploy/production.yml' })
    assertPulled(result, ['redis:7-alpine', 'postgres:16-alpine', 'nginx:alpine', 'alpine:3.20', 'busybox:1.36'])
  })

  test('递归识别三种 Dockerfile 命名与大小写 FROM，跳过平台、变量、scratch 和阶段别名', () => {
    const result = fixture('dockerfile-syntax', {
      'Dockerfile': 'ARG BASE=alpine:3.20\nFROM $BASE AS configured\nFROM scratch AS empty\nFROM --platform=$TARGETPLATFORM alpine:3.20 AS variablePlatform\nFROM --platform=linux/arm64 alpine:3.21 AS fixedPlatform\nFROM variablePlatform\nFROM fixedPlatform\n',
      'nested/Dockerfile.production': '  fRoM busybox:1.36 aS Builder\nFROM Builder AS final\nFROM final\nFROM configured\n',
      'nested/build/web.Dockerfile': 'from node:24-bookworm-slim as assets\nFROM assets\n',
    })
    // 阶段名称仅在同一 Dockerfile 有效；另一个文件的 configured 是普通镜像名称。
    assertPulled(result, ['busybox:1.36', 'node:24-bookworm-slim', 'configured'])
  })

  test('保留原字节的 CRLF Dockerfile 正确提取镜像，不把回车带进镜像名称', () => {
    const result = fixture('dockerfile-crlf', {}, { rawFiles: {
      'server.Dockerfile': Buffer.from('FROM eclipse-temurin:21-jre-jammy\r\n'),
      'nested/Dockerfile': Buffer.from('FROM python:3.12-slim-bookworm AS worker\r\nFROM worker\r\nFROM node:24-bookworm-slim\r\n'),
    } })
    assert(fs.readFileSync(path.join(result.release, 'server.Dockerfile')).includes(Buffer.from('\r\n')), '测试输入必须保留 CRLF 原字节')
    assertPulled(result, ['eclipse-temurin:21-jre-jammy', 'python:3.12-slim-bookworm', 'node:24-bookworm-slim'])
  })

  test('已有本机缓存直接复用，不再拉取', () => {
    const result = fixture('cache', { 'Dockerfile': 'FROM python:3.12-slim-bookworm\n' }, {
      mode: 'all502', cache: ['python:3.12-slim-bookworm'],
    })
    assertPulled(result, [])
    assert(inspections(result).includes('python:3.12-slim-bookworm'), '应先检查本机镜像缓存')
    assert(!result.output.includes('[WARN]'), '已有缓存不应提示预拉失败')
  })

  test('原镜像前两次失败后第三次成功，重试带等待且无需直连', () => {
    const ref = 'python:3.12-slim-bookworm'
    const result = fixture('third-attempt', { 'Dockerfile': 'FROM ' + ref + '\n' }, { mode: 'retry3' })
    assertPulled(result, [ref, ref, ref])
    assert.strictEqual(callsFor(result, 'sleep').length, 2, '三次拉取之间应有两次退避等待')
    assert(!result.output.includes('[WARN]'), '原镜像已拉取成功不应警告')
  })

  for (const mode of ['mirror502', 'mirror503', 'mirror504', 'network']) {
    test(mode + ' 时 Docker Hub 官方直连一次并标记回原镜像', () => {
      const ref = 'python:3.12-slim-bookworm', direct = 'registry-1.docker.io/library/' + ref
      const result = fixture(mode, { 'Dockerfile': 'FROM ' + ref + '\n' }, { mode })
      assertPulled(result, [ref, ref, ref, direct])
      assert.deepStrictEqual(callsFor(result, 'tag'), [['tag', direct, ref]], '直连成功应恢复发布包使用的镜像名称')
      assert(inspections(result).filter(image => image === ref).length >= 2, '官方镜像标记后应确认原名可用')
      assert(!/本机.*(?:没有|无缓存|缺少|缺失|不存在)/.test(result.output), '直连恢复成功不应报告缓存缺失')
    })
  }

  test('Docker Hub 命名空间与显式 docker.io 名称转换正确', () => {
    const refs = ['acme/service:2', 'docker.io/acme/worker:3', 'docker.io/library/nginx:alpine']
    const result = fixture('hub-namespaces', { 'Dockerfile': refs.map(ref => 'FROM ' + ref).join('\n') + '\n' }, { mode: 'mirror502' })
    for (const ref of refs) assert.strictEqual(pulls(result).filter(image => image === ref).length, 3)
    assert.deepStrictEqual(pulls(result).filter(image => image.startsWith('registry-1.docker.io/')).sort(), [
      'registry-1.docker.io/acme/service:2', 'registry-1.docker.io/acme/worker:3', 'registry-1.docker.io/library/nginx:alpine',
    ])
  })

  test('全部拉取失败只警告缓存缺失，保留非致命语义', () => {
    const ref = 'eclipse-temurin:21-jre-jammy'
    const result = fixture('all-failed', { 'Dockerfile': 'FROM ' + ref + '\n' }, { mode: 'all502' })
    assertPulled(result, [ref, ref, ref, 'registry-1.docker.io/library/' + ref])
    assert(result.output.includes('[WARN]'), '原拉取与官方直连都失败时应警告')
    assert(/(?:本机|缓存).*(?:没有|无缓存|缺少|缺失|不存在)/.test(result.output), '应准确提示镜像缓存缺失')
    assert(!/将沿用本机已有镜像/.test(result.output), '镜像不存在时不能承诺沿用缓存')
  })

  test('私有仓库、localhost、带端口仓库与 digest 镜像不替换来源', () => {
    const refs = ['private.example.com/team/app:2', 'localhost/app:3', 'registry:5000/app:4', 'python@sha256:' + 'a'.repeat(64)]
    const result = fixture('private-digest', { 'Dockerfile': refs.map(ref => 'FROM ' + ref).join('\n') + '\n' }, { mode: 'all502' })
    assertPulled(result, refs.flatMap(ref => [ref, ref, ref]))
    assert.strictEqual(callsFor(result, 'tag').length, 0, '私有镜像与 digest 镜像不得改名')
  })

  for (const mode of ['auth401', 'manifest']) {
    test(mode + ' 非网络错误不触发来源替换', () => {
      const ref = 'node:24-bookworm-slim'
      const result = fixture(mode, { 'Dockerfile': 'FROM ' + ref + '\n' }, { mode })
      assertPulled(result, [ref, ref, ref])
      assert.strictEqual(callsFor(result, 'tag').length, 0)
    })
  }

  test('官方直连后标记失败不假称镜像已就绪', () => {
    const result = fixture('tag-failed', { 'Dockerfile': 'FROM python:3.12-slim-bookworm\n' }, { mode: 'tagfail' })
    assert(result.output.includes('[WARN]'), '标记失败应警告')
    assert(/(?:本机|缓存).*(?:没有|无缓存|缺少|缺失|不存在)/.test(result.output), '原名缓存不可用应准确报告')
  })

  test('真实 tar.gz 发布流程先准备三个基础镜像，再仅执行一次 upgrade.sh', () => {
    const dir = path.join(root, 'script-deploy'), state = path.join(dir, 'state'), home = path.join(dir, 'home')
    const packageRoot = path.join(dir, 'package'), versionDir = 'secwatch-v1.1.6-test'
    fs.mkdirSync(state, { recursive: true })
    fs.mkdirSync(path.join(home, 'uploads'), { recursive: true })
    write(path.join(state, 'cache'), '\n')
    write(path.join(packageRoot, versionDir, 'server.Dockerfile'), 'FROM eclipse-temurin:21-jre-jammy\n')
    write(path.join(packageRoot, versionDir, 'worker.Dockerfile'), 'FROM python:3.12-slim-bookworm AS worker\nFROM node:24-bookworm-slim AS web\n')
    write(path.join(packageRoot, versionDir, 'start.sh'), '#!/usr/bin/env bash\nexit 0\n')
    write(path.join(packageRoot, versionDir, 'upgrade.sh'), `#!/usr/bin/env bash
printf 'upgrade\\n' >> "$FAKE_STATE/calls.tsv"
docker compose build || exit $?
`)
    const deployFile = path.join(dir, 'deploy.sh'), wrapper = path.join(dir, 'deploy-check.sh')
    write(deployFile, deploy)
    const setup = `export PATH=${quote(posix(bin))}:"$PATH"
export FAKE_STATE=${quote(posix(state))} FAKE_MODE=mirror502
`
    write(wrapper, setup + `tar -czf ${quote(posix(path.join(home, 'uploads', 'release.tar.gz')))} -C ${quote(posix(packageRoot))} ${quote(versionDir)} || exit 94
bash ${quote(posix(deployFile))} deploy --mode script --app secwatch --home ${quote(posix(home))} --package release.tar.gz --version 1.1.6 --keep-upload --no-bootstrap-java --no-bootstrap-pgdump
`)
    const output = execute(wrapper), calls = parseCalls(state)
    assert(output.includes('__DEPLOY_OK__:1.1.6'), '完整部署应成功：\n' + output)
    assert.strictEqual(calls.filter(args => args[0] === 'upgrade').length, 1, 'upgrade.sh 必须只执行一次')
    assert.strictEqual(calls.filter(args => args[0] === 'compose' && args[1] === 'build').length, 1)
    assert.strictEqual(calls.filter(args => args[0] === 'pull').length, 12, '三个 FROM 各重试三次、官方直连一次，不能重复预拉')
    assert.strictEqual(fs.readFileSync(path.join(home, 'CURRENT'), 'utf8').trim(), versionDir, '版本指针应指向新发布包')
  })

  console.log(`镜像预拉取自测：${passed} 项通过（真实 Bash，隔离 Docker 与网络）`)
} catch (error) {
  if (recordBefore) {
    const reproduction = path.join(repo, '.sdd/bugs/image502/reproduction-before.txt')
    write(reproduction, `修复前隔离复现：${new Date().toISOString()}\n命令：node scripts/deploy-image-prepull-selftest.cjs --record-before\n结果：失败，基础镜像未进入预拉取流程。\n${error.stack || error}\n${lastRun ? lastRun.stdout + lastRun.stderr : ''}`)
    console.error('修复前复现证据已保存：.sdd/bugs/image502/reproduction-before.txt')
  }
  console.error(error.stack || error)
  process.exitCode = 1
} finally {
  // 仅清理由本次测试创建、位于系统临时目录内的可再生产物。
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-image-prepull-')) fs.rmSync(root, { recursive: true, force: true })
}
