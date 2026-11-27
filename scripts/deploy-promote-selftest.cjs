/**
 * 环境同步（测试 → 正式）编排自测（无框架，node scripts/deploy-promote-selftest.cjs 直接运行）
 *
 * 验证策略（同 deploy-scriptmode-selftest.cjs 的边界划分）：
 *   - deploy-service.run()/promote()/promotePreview() 走真实业务编排（预检、取包、SHA256 校验、阶段跟踪、历史落盘）
 *   - deploy.sh 不打桩：SSH 桩把远端路径改写到本地「服务器根」后经 Git Bash 真实执行
 *   - 仅模拟无法在本机接入的外部系统：SSH/SFTP 传输、docker 命令
 *   - 数据库同步：找到 PostgreSQL 工具（环境变量 PLM_TEST_PG_BIN 或本机便携版）时拉起真实集群，
 *     用真实 pg_dump/psql 验证最终库状态；找不到时退回替身，只验证命令契约
 * 覆盖：脚本形态同机同步（留存原始发布包）/ 版本已一致只同步数据 / 阻塞项 /
 *   旧版本无留存包时重新打包（剔除运行期文件与指向源环境的链接）/ docker 形态（.env 软链不带过去）/
 *   跨服务器经本机中转 / 留存包随版本轮转清理
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')

// os.tmpdir() 可能是 8.3 短名（ADMINI~1）：MSYS 工具解析不了，Node 在其下建嵌套目录也会出错，创建后立刻规范成长路径
const tempRoot = fs.realpathSync.native(os.tmpdir())
const tmpRoot = fs.mkdtempSync(path.join(tempRoot, 'deploy-promote-'))
const posix = (p) => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name)
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data) }
const passed = []
function step(title) { passed.push(title); console.log(`  ✓ ${title}`) }

// ── 真实 PostgreSQL（可选）：找不到工具时数据库相关断言退回命令契约 ──
function findPgBin() {
  const candidates = [process.env.PLM_TEST_PG_BIN, path.resolve(__dirname, '../../AINeed/.tools/pgsql/bin')]
  for (const base of ['C:/Program Files/PostgreSQL', '/usr/lib/postgresql']) {
    let names = []
    try { names = fs.readdirSync(base) } catch { /* 未安装 */ }
    for (const name of names.sort((a, b) => Number(b) - Number(a))) candidates.push(path.join(base, name, 'bin'))
  }
  return candidates.find((dir) => dir && fs.existsSync(path.join(dir, exe('pg_dump')))) || ''
}
const PG_PORT = 55439
const pgBin = findPgBin()
let pgData = ''
let pgChild = null
function startPg() {
  if (!pgBin) return
  const run = (name, args) => {
    const r = spawnSync(path.join(pgBin, exe(name)), args, { encoding: 'utf8', windowsHide: true, timeout: 180000 })
    if (r.status !== 0) throw new Error(`${name} 失败: ${r.stderr || r.stdout}`)
    return r.stdout
  }
  pgData = path.join(tmpRoot, 'pgdata')
  run('initdb', ['-D', pgData, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'])
  // postgres 会继承管道句柄：输出必须落文件，否则本进程的管道收集永不结束
  const logFd = fs.openSync(path.join(tmpRoot, 'pg.log'), 'a')
  pgChild = spawn(path.join(pgBin, exe('postgres')), ['-D', pgData, '-p', String(PG_PORT), '-h', '127.0.0.1'], { stdio: ['ignore', logFd, logFd], windowsHide: true })
  // 子进程已有自己的句柄；本进程必须关闭，否则收尾时临时目录里的日志文件删不掉
  fs.closeSync(logFd)
  const deadline = Date.now() + 90000
  for (;;) {
    if (spawnSync(path.join(pgBin, exe('pg_isready')), ['-h', '127.0.0.1', '-p', String(PG_PORT)], { encoding: 'utf8', windowsHide: true }).status === 0) break
    if (Date.now() > deadline) throw new Error('测试 PostgreSQL 未就绪')
    spawnSync(bash, ['-c', 'sleep 0.3'])
  }
  for (const name of PG_DATABASES) run('psql', ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE ${name}`])
}
function stopPg() {
  if (!pgData) return
  const logFd = fs.openSync(path.join(tmpRoot, 'pg-stop.log'), 'a')
  try { spawnSync(path.join(pgBin, exe('pg_ctl')), ['-D', pgData, '-m', 'fast', 'stop'], { stdio: ['ignore', logFd, logFd], windowsHide: true, timeout: 60000 }) } finally { fs.closeSync(logFd) }
}
/** 直连真实 PostgreSQL 查询（不经 docker 替身）；SQL 经 stdin 以 UTF-8 传入，避开 Windows 命令行参数的本地代码页 */
function sql(database, statement) {
  const r = spawnSync(path.join(pgBin, exe('psql')), ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-d', database, '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: Buffer.from(`${statement};\n`, 'utf8'), encoding: 'utf8', windowsHide: true, env: { ...process.env, PGCLIENTENCODING: 'UTF8' } })
  assert.equal(r.status, 0, `${database} 查询失败: ${r.stderr}`)
  return r.stdout.trim()
}

// ── electron 打桩：userData 指向临时目录（真实 deploy-projects / history 落盘） ──
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => path.join(tmpRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } },
}

// ── 「服务器」：本地目录模拟远端安装根；REMOTE_* 是 deploy.sh 收到的逻辑路径 ──
const SERVER = path.join(tmpRoot, 'server-a')
const SERVER_B = path.join(tmpRoot, 'server-b')
const REMOTES = {
  '/srv/test': path.join(SERVER, 'test'), '/srv/prod': path.join(SERVER, 'prod'),
  '/srv/dtest': path.join(SERVER, 'dtest'), '/srv/dprod': path.join(SERVER, 'dprod'),
  '/srv/xsrc': path.join(SERVER_B, 'xsrc'), '/srv/xprod': path.join(SERVER_B, 'xprod'),
  // 从未发布过的目录：用于「有版本差」的预检
  '/srv/fresh': path.join(SERVER, 'fresh'),
}
/** 远端路径 → 本机「服务器根」路径（给 Node 的 fs 用，必须是原生路径；/c/... 形式会被当成当前盘根下的相对目录） */
const local = (remotePath) => {
  const hit = Object.keys(REMOTES).filter((prefix) => remotePath === prefix || remotePath.startsWith(`${prefix}/`))
    .sort((a, b) => b.length - a.length)[0]
  return hit ? REMOTES[hit] + remotePath.slice(hit.length) : remotePath
}
/** 整条命令里的远端路径改写为「服务器根」的 MSYS 路径（长前缀优先，避免 /srv/test 误伤同前缀目录） */
const localizeCommand = (command) => Object.keys(REMOTES).sort((a, b) => b.length - a.length)
  .reduce((out, prefix) => out.split(prefix).join(posix(REMOTES[prefix])), command)
const PG_DATABASES = ['envsync_src', 'envsync_dst', 'envsync_xdst']
// docker 替身的容器清单：容器名 → 数据库；working_dir 标签用于按部署目录识别各环境的数据库
const CONTAINERS = {
  'test-db-1': ['envsync_src', '/srv/test/releases/rel'],
  'prod-db-1': ['envsync_dst', '/srv/prod/releases/rel'],
  'dtest-db-1': ['envsync_src', '/srv/dtest/releases/rel'],
  'xsrc-db': ['envsync_src', '/srv/xsrc/releases/rel'],
  'xdst-db': ['envsync_xdst', '/srv/xprod/releases/rel'],
  'fresh-db-1': ['envsync_fresh', '/srv/fresh/releases/2.1.0'],
}

const pgWrap = path.join(tmpRoot, 'pg-wrap')
const trace = path.join(tmpRoot, 'pg-trace.log')
const flow = path.join(tmpRoot, 'docker-flow.log')
fs.mkdirSync(pgWrap)
for (const tool of ['psql', 'pg_dump', 'pg_isready']) {
  const breakDump = tool === 'pg_dump' ? [
    'if [ "${FIXTURE_INVALID_SOURCE_DUMP:-0}" = 1 ] && [[ "$*" = *--no-owner* ]]; then',
    `  ${shQuote(posix(path.join(pgBin, exe(tool))))} "$@" || exit $?`,
    '  printf "\\nSELECT missing_test_function();\\n"',
    '  exit 0',
    'fi',
  ].join('\n') + '\n' : ''
  write(path.join(pgWrap, tool), pgBin || tool === 'pg_isready'
    ? `#!/usr/bin/env bash\nexport PGHOST=127.0.0.1 PGPORT=${PG_PORT} PGCLIENTENCODING=UTF8\n${pgBin ? `${breakDump}exec ${shQuote(posix(path.join(pgBin, exe(tool))))} "$@"` : 'exit 0'}\n`
    : `#!/usr/bin/env bash\nprintf '%s\\n' '${tool} '"$*" >> ${shQuote(posix(trace))}\n[ '${tool}' != pg_dump ] || printf '%s\\n' '-- 模拟导出' '-- PostgreSQL database dump complete'\ncat >/dev/null 2>&1 || true\n`)
}
const wrapper = [
  `export PGWRAP=${shQuote(posix(pgWrap))}`,
  `export FIXTURE_FLOW=${shQuote(posix(flow))}`,
  // 替身里的「已存在的 docker 网络」：以 FIXTURE_NETS 下是否有同名标记文件为准
  `export FIXTURE_NETS=${shQuote(posix(path.join(tmpRoot, 'fixture-networks')))}`,
  'docker() {',
  '  case "$1" in',
  // docker compose [-f <文件>] exec -T <服务> <命令…>：按服务名进容器执行，这里直接落到本机真实的 PostgreSQL 工具上
  '    compose) [ "${2:-}" = version ] && return 0; if [ "${2:-}" = exec ] || { [ "${2:-}" = -f ] && [ "${4:-}" = exec ]; }; then shift; [ "${1:-}" = -f ] && shift 2; [ "${1:-}" = exec ] || return 94; [ "${2:-}" = -T ] || return 95; shift 3; case "$*" in "psql "*" -d ${FIXTURE_FAIL_DB:-__none__} "*) echo "psql: error: 模拟目标库无法读取" >&2; return 2 ;; esac; ( cd /; PATH="$PGWRAP:$PATH" "$@" ); return $?; fi; case "${4:-}" in config) if [ "${5:-}" != --quiet ]; then echo "name: fixture-proj"; fi ;; build|down|up) printf "%s\\n" "${4:-}" >> "$FIXTURE_FLOW" ;; ps) printf "appcontainer\\n" ;; *) return 99 ;; esac; return 0 ;;',
  '    network) shift; [ "${1:-}" = inspect ] || return 96; [ -f "$FIXTURE_NETS/${2:-}" ] ;;',
  `    ps) if [ "\${2:-}" = -a ]; then printf '%s\\n' "\${FIXTURE_COMPOSE_OWNER:-}"; return 0; fi; printf '%s\\n' ${Object.entries(CONTAINERS).filter(([name]) => name !== 'fresh-db-1').map(([name, [, dir]]) => shQuote(`${name}\tpostgres:16-alpine\t${dir}`)).join(' ')}; if [ "\${FIXTURE_FRESH_RUNNING:-0}" = 1 ]; then printf '%s\\n' ${shQuote('fresh-db-1\tpostgres:16-alpine\t/srv/fresh/releases/2.1.0')}; fi; return 0 ;;`,
  '    inspect) case "$*" in *com.docker.compose.project*) printf "fixture-proj\\n" ;; *) printf "true\\n" ;; esac; return 0 ;;',
  '    restart) printf "restart\\n" >> "$FIXTURE_FLOW"; return 0 ;;',
  '    exec)',
  '      shift; [ "${1:-}" = -i ] && shift',
  '      fixture_container="$1"; fixture_script="$4"; shift 5',
  `      case "$fixture_container" in ${Object.keys(CONTAINERS).map((name) => `${name}) fixture_db=${CONTAINERS[name][0]} ;;`).join(' ')} *) return 97 ;; esac`,
  '      ( export POSTGRES_USER=postgres POSTGRES_DB="$fixture_db" POSTGRES_PASSWORD=fixture; cd /; PATH="$PGWRAP:$PATH" sh -ceu "$fixture_script" -- "$@" )',
  '      ;;',
  '    *) return 98 ;;',
  '  esac',
  '}',
  'export -f docker',
].join('\n')
const bashEnv = { ...process.env, MSYS: 'winsymlinks:nativestrict', PGCLIENTENCODING: 'UTF8' }
const runBash = (command, options = {}) => spawnSync(bash, ['-c', `${wrapper}\n${command}`], { windowsHide: true, timeout: 180000, maxBuffer: 1 << 30, env: bashEnv, ...options })
const connections = { opened: 0, closed: 0, uploads: [] }

// ── ssh-service 打桩：命令改写后真实执行，传输落盘到「服务器目录」 ──
const realSsh = require('../electron/deploy/ssh-service')
require.cache[require.resolve('../electron/deploy/ssh-service')] = {
  id: require.resolve('../electron/deploy/ssh-service'), filename: require.resolve('../electron/deploy/ssh-service'), loaded: true,
  exports: {
    remoteJoin: realSsh.remoteJoin,
    connect: async (config) => {
      connections.opened += 1
      return {
        endpoint: `${config.host}:${config.port}`,
        sftp: (cb) => cb(null, {
          createWriteStream: (remotePath) => {
            const dest = local(remotePath)
            fs.mkdirSync(path.dirname(dest), { recursive: true })
            const stream = fs.createWriteStream(dest)
            const end = stream.end.bind(stream)
            // 上传的服务器脚本（如启动前灌库的 data-sync.sh）里写的是逻辑远端路径，落盘时一并映射到本地
            stream.end = (...args) => {
              if (typeof args[0] === 'string') args[0] = localizeCommand(args[0])
              setTimeout(() => stream.emit('close'), 20)
              return end(...args)
            }
            return stream
          },
          end: () => {},
        }),
      }
    },
    close: (conn) => { if (conn) connections.closed += 1 },
    mkdirp: async (_conn, dir) => { fs.mkdirSync(local(dir), { recursive: true }) },
    upload: async (_conn, localPath, remotePath, onProgress) => {
      const dest = local(remotePath)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(localPath, dest)
      connections.uploads.push({ localPath, remotePath, sha256: sha256(localPath) })
      if (process.env.PROMOTE_DEBUG) console.error(`[upload] ${remotePath} -> ${dest} exists=${fs.existsSync(dest)}`)
      if (onProgress) onProgress(1, 1)
      return { remotePath }
    },
    exec: async (_conn, command, onLine) => {
      const r = runBash(localizeCommand(command), { encoding: 'utf8' })
      if (process.env.PROMOTE_DEBUG && r.stderr) console.error(`[stderr] ${command.slice(0, 80)}\n${r.stderr}`)
      if (process.env.PROMOTE_DEBUG) console.error(`[exec ${r.status}] ${localizeCommand(command)}\n${r.stdout}${r.stderr}`)
      const out = `${r.stdout || ''}${r.stderr || ''}`
      if (onLine) for (const line of out.split(/\r?\n/)) if (line) onLine(`${line}\n`, 'stdout')
      return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
    },
    execToFile: async (_conn, command, localPath, onProgress) => {
      const r = runBash(localizeCommand(command), { encoding: 'buffer' })
      const out = r.stdout || Buffer.alloc(0)
      fs.writeFileSync(localPath, out)
      if (onProgress) onProgress(out.length)
      return { code: r.status === null ? 1 : r.status, stderr: (r.stderr || Buffer.alloc(0)).toString('utf8'), bytes: out.length }
    },
  },
}

const deployProjects = require('../electron/deploy/deploy-projects')
const deployService = require('../electron/deploy/deploy-service')
const server = { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' }
const target = (id, name, remotePath, host = server.host, extra = {}) => ({
  id, name, remotePath, server: { ...server, host },
  health: { strategy: 'manual', enabled: false, url: '', timeout: 10, interval: 1 }, db: { strategy: 'off' }, ...extra,
})

// ── 脚本形态项目（生命周期脚本随发布包分发；start.sh 像真实项目一样把 pid 写进版本目录） ──
function makeArtifact(projectDir, name) {
  const stage = path.join(projectDir, '.staging', name)
  write(path.join(stage, 'VERSION'), `${name.split('-v')[1].split('-')[0]}\n`)
  write(path.join(stage, 'payload.txt'), `payload of ${name}\n`)
  write(path.join(stage, 'upgrade.sh'), [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="$INSTALL_ROOT"',
    'printf "%s\\n" "$(basename -- "$SD")" > "$IR/CURRENT"',
    'INSTALL_ROOT="$IR" bash "$SD/start.sh"',
  ].join('\n'))
  write(path.join(stage, 'start.sh'), [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
    'echo $$ > "$SD/app.pid"; touch "$SD/.started"',
  ].join('\n'))
  write(path.join(stage, 'stop.sh'), 'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\nrm -f "$SD/.started" "$SD/app.pid"\n')
  const out = path.join(projectDir, 'release', `${name}.tar.gz`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const r = spawnSync(bash, ['-c', `cd ${shQuote(posix(path.dirname(stage)))} && tar -czf ${shQuote(posix(out))} ${shQuote(name)}`], { encoding: 'utf8' })
  assert.equal(r.status, 0, `打测试发布包失败: ${r.stderr}`)
  return out
}

function saveProject(config) {
  return deployProjects.save(deployProjects.normalizeProject(config)).id
}

let lastEvents = null
function capture() {
  lastEvents = { logs: [], stages: [] }
  deployService.setEmitter((channel, payload) => {
    if (channel === 'deploy:log') lastEvents.logs.push(payload.text)
    if (channel === 'deploy:stage') lastEvents.stages.push(`${payload.stage}:${payload.status}`)
  })
}
const logText = () => (lastEvents ? lastEvents.logs.join('\n') : '(尚无日志)')

async function main() {
  startPg()
  if (pgBin) {
    for (const statement of [
      "CREATE TABLE accounts (id serial PRIMARY KEY, name text NOT NULL, balance numeric(12,2) NOT NULL DEFAULT 0)",
      "INSERT INTO accounts (name, balance) VALUES ('张三', 100.50), ('李四', -2.25), ('O''Neil', 0)",
      'CREATE TABLE tags (id int PRIMARY KEY, label text)',
      "INSERT INTO tags VALUES (1,'a'),(2,'b'),(3,'c')",
      'CREATE TABLE "mixed""quote" (v text)',
      "INSERT INTO \"mixed\"\"quote\" VALUES ('x')",
      'CREATE VIEW account_names AS SELECT name FROM accounts',
    ]) sql('envsync_src', statement)
    // 目标库预置另一套结构与数据：同步后应被源库完全替换
    sql('envsync_dst', 'CREATE TABLE legacy_only (id int)')
    sql('envsync_dst', 'CREATE TABLE accounts (id int PRIMARY KEY)')
    sql('envsync_dst', 'INSERT INTO accounts VALUES (1), (2)')
  }
  const state = (database) => pgBin ? {
    tables: sql(database, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1").split(/\r?\n/),
    accounts: sql(database, 'SELECT count(*), coalesce(sum(balance), 0), min(name) FROM accounts'),
    tags: sql(database, 'SELECT count(*) FROM tags'),
    sequence: sql(database, 'SELECT last_value FROM accounts_id_seq'),
  } : null
  const srcBefore = state('envsync_src')

  // ═══════════ 场景一：脚本形态，同一台服务器（源环境留存了原始发布包） ═══════════
  capture()
  const scriptDir = path.join(tmpRoot, 'proj-script')
  write(path.join(scriptDir, 'VERSION'), '1.0.0\n')
  const scriptId = saveProject({
    name: '同步脚本项目', localPath: scriptDir, deployMode: 'script', configMode: 'manual',
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' }, version: { strategy: 'auto', manual: '' },
    targets: [target('t1', '测试环境', '/srv/test'), target('t2', '正式环境', '/srv/prod')],
  })
  // 各环境自己的运行配置：同名应用密钥取值不同（预检应提示），且任何同步都不得改写它
  const envOf = (home) => `ENV=${home.slice(5)}\nAPP_ENCRYPTION_KEY=${home.slice(5)}-key\n`
  for (const home of ['/srv/test', '/srv/prod']) write(path.join(local(home), 'shared', '.env'), envOf(home))
  makeArtifact(scriptDir, 'app-v1.0.0-001')
  const first = await deployService.run(scriptId, 't1')
  assert.equal(first.status, 'success', `首次发布测试环境应成功:\n${logText()}`)
  assert(fs.existsSync(path.join(local('/srv/test'), 'releases/.packages/app-v1.0.0-001.tar.gz')), '多环境项目应留存原始发布包')
  step('多环境项目发布后在源环境留存原始发布包')

  // ── 阻塞项 ──
  const same = await deployService.promotePreview(scriptId, { sourceTargetId: 't1', destTargetId: 't1' })
  assert.equal(same.ok, false)
  assert.match(same.error, /不能相同/)
  const preview = await deployService.promotePreview(scriptId, { sourceTargetId: 't1', destTargetId: 't2' })
  assert.equal(preview.ok, true, JSON.stringify(preview.problems))
  assert.equal(preview.sameServer, true)
  assert.equal(preview.source.version, 'app-v1.0.0-001')
  assert.equal(preview.source.package, 'kept')
  assert.equal(preview.dest.version, '')
  assert.equal(preview.needDeploy, true)
  assert.equal(preview.dataSync.available, true, preview.dataSync.reason)
  assert.equal(preview.dataSync.source.container, 'test-db-1')
  assert.equal(preview.dataSync.source.name, 'envsync_src')
  assert.equal(preview.dataSync.dest.container, 'prod-db-1')
  assert.equal(preview.dataSync.dest.name, 'envsync_dst')
  assert.equal(preview.problems.length, 0)
  assert(preview.warnings.some((warning) => /APP_ENCRYPTION_KEY 取值不同/.test(warning)), `应提示两侧应用密钥不同:\n${JSON.stringify(preview.warnings)}`)
  assert(!JSON.stringify(preview).includes('-key'), '预检结果不得带出密钥取值')
  const srcAfterPreview = state('envsync_src')
  assert.deepEqual(srcAfterPreview, srcBefore, '预检不得改动源数据库')
  step('预检：同源同目标拒绝；识别源/目标版本、留存包与两侧数据库，且不改动任何数据')

  const stale = await deployService.promote(scriptId, { sourceTargetId: 't1', destTargetId: 't2', options: { syncData: true, expectedVersion: 'app-v0.9.0' } })
  assert.equal(stale.status, 'failed')
  assert.match(stale.message, /源环境版本已变化/)
  assert.equal(connections.opened, connections.closed, '失败后必须释放连接')
  step('确认后源环境版本变化 → 检查阶段失败且不触碰服务器')

  // ── 版本 + 数据同步 ──
  const promoted = await deployService.promote(scriptId, { sourceTargetId: 't1', destTargetId: 't2', options: { syncData: true, expectedVersion: 'app-v1.0.0-001' } })
  assert.equal(promoted.status, 'success', `环境同步应成功:\n${logText()}`)
  assert.equal(promoted.type, 'promote')
  assert.equal(promoted.version, 'app-v1.0.0-001')
  assert.equal(promoted.releaseId, 'app-v1.0.0-001')
  assert.equal(promoted.deployed, true)
  assert.equal(promoted.dataSynced, true)
  assert.match(promoted.message, /版本 app-v1.0.0-001 已发布到 正式环境/)
  assert.match(promoted.message, /数据库 envsync_dst 已同步/)
  for (const stage of ['check', 'package', 'upload', 'start', 'datasync']) assert.equal(promoted.stages[stage].status, 'success', `阶段 ${stage}`)
  assert.equal(promoted.stages.build.status, 'skipped')
  assert.equal(fs.readFileSync(path.join(local('/srv/prod'), 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-001')
  assert.equal(fs.readFileSync(path.join(local('/srv/prod'), 'releases/app-v1.0.0-001/payload.txt'), 'utf8'), `payload of app-v1.0.0-001\n`)
  assert(fs.existsSync(path.join(local('/srv/prod'), 'releases/.packages/app-v1.0.0-001.tar.gz')), '目标环境也应留存同步过去的发布包')
  assert(!fs.readdirSync(path.join(local('/srv/prod'), 'uploads')).some((name) => name.startsWith('promote_')), '同步包不得残留')
  assert.equal(fs.readFileSync(path.join(local('/srv/prod'), 'shared/.env'), 'utf8'), envOf('/srv/prod'), '目标环境运行配置不得被改动')
  assert.equal(fs.readFileSync(path.join(local('/srv/test'), 'shared/.env'), 'utf8'), envOf('/srv/test'))
  assert.equal(fs.readFileSync(path.join(local('/srv/test'), 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-001', '源环境版本不得变化')
  assert(fs.readdirSync(path.join(local('/srv/prod'), 'backups')).some((name) => /^db_guard_\w+\.sql$/.test(name)), '同步前应生成目标库保底备份')
  assert(fs.readdirSync(path.join(local('/srv/prod'), 'backups')).some((name) => /^db_sync_\w+\.sql$/.test(name)), '源库导出应保存在目标环境备份目录')
  assert(logText().includes('行数核对一致：3 张表 7 行') || !pgBin, logText())
  assert(lastEvents.stages.includes('datasync:success'))
  assert.deepEqual(state('envsync_src'), srcBefore, '同步不得改动源数据库')
  if (pgBin) {
    const dst = state('envsync_dst')
    assert.deepEqual(dst.tables.sort(), ['accounts', 'mixed"quote', 'tags'].sort(), '目标库结构应与源库一致（旧表消失、带引号的表名保留）')
    assert.equal(sql('envsync_dst', "SELECT viewname FROM pg_views WHERE schemaname = 'public'"), 'account_names', '视图应一并同步')
    assert.equal(sql('envsync_dst', "SELECT string_agg(name, ',' ORDER BY id) FROM accounts"), '张三,李四,O\'Neil', '中文字符与引号应原样往返')
    assert.equal(dst.accounts, srcBefore.accounts, '目标库数据应与源库一致')
    assert.equal(dst.tags, srcBefore.tags)
    assert.equal(dst.sequence, srcBefore.sequence, '序列进度应一并同步')
    // 刚灌入的库要带上查询计划统计信息：否则应用一启动就按缺省估算走执行计划
    assert.equal(sql('envsync_dst', 'SELECT count(*) FROM pg_stat_user_tables WHERE last_analyze IS NULL'), '0', '灌库后应刷新查询计划统计信息')
  }
  step('脚本形态同机同步：原始发布包原样搬运、正式环境切到新版本、运行配置不变、数据库完全替换且行数核对一致')

  // ── 版本已一致：只同步数据 ──
  if (pgBin) sql('envsync_dst', "INSERT INTO tags VALUES (9,'prod-only')")
  const again = await deployService.promotePreview(scriptId, { sourceTargetId: 't1', destTargetId: 't2' })
  assert.equal(again.needDeploy, false)
  assert.equal(again.problems.length, 0, '版本一致但可同步数据时不应阻塞')
  capture()
  const dataOnly = await deployService.promote(scriptId, { sourceTargetId: 't1', destTargetId: 't2', options: { syncData: true, expectedVersion: 'app-v1.0.0-001' } })
  assert.equal(dataOnly.status, 'success', `仅同步数据应成功:\n${logText()}`)
  assert.equal(dataOnly.deployed, false)
  assert.equal(dataOnly.stages.package.status, 'skipped')
  assert.equal(dataOnly.stages.upload.status, 'skipped')
  assert.equal(dataOnly.stages.start.status, 'skipped')
  assert.equal(dataOnly.stages.datasync.status, 'success')
  if (pgBin) assert.equal(state('envsync_dst').tags, srcBefore.tags, '目标库新增的数据应被源库覆盖')
  capture()
  const nothing = await deployService.promote(scriptId, { sourceTargetId: 't1', destTargetId: 't2', options: { expectedVersion: 'app-v1.0.0-001' } })
  assert.equal(nothing.status, 'failed')
  assert.match(nothing.message, /没有可同步的内容/)
  assert.equal(nothing.stages.check.status, 'failed')
  step('版本已一致：只做数据同步（版本阶段全部跳过）；既无版本差又未选数据同步时在检查阶段拒绝')

  // ═══════════ 场景二：源环境版本没有留存包 → 重新打包版本目录 ═══════════
  capture()
  write(path.join(scriptDir, 'VERSION'), '1.1.0\n')
  makeArtifact(scriptDir, 'app-v1.1.0-001')
  const second = await deployService.run(scriptId, 't1')
  assert.equal(second.status, 'success', `测试环境升级应成功:\n${logText()}`)
  const kept = path.join(local('/srv/test'), 'releases/.packages/app-v1.1.0-001.tar.gz')
  fs.rmSync(kept)
  const rel = path.join(local('/srv/test'), 'releases/app-v1.1.0-001')
  // 运行期写进版本目录的文件，以及指向源环境自身的绝对链接
  write(path.join(rel, 'app.pid'), '99999')
  write(path.join(rel, 'run.log'), 'runtime log\n')
  write(path.join(rel, '__pycache__/x.pyc'), 'bytecode')
  write(path.join(rel, 'notes.txt'), 'packaged file\n')
  const escape = path.join(rel, 'shared-link')
  // 用与 deploy.sh 相同的方式建原生符号链接；无符号链接权限的环境跳过该断言
  const linked = runBash(`ln -s ${shQuote(`${local('/srv/test')}/shared`)} ${shQuote(`${posix(rel)}/shared-link`)}`).status === 0
  let archived = await deployService.promotePreview(scriptId, { sourceTargetId: 't1', destTargetId: 't2' })
  if (linked) {
    assert.equal(archived.problems.length, 1, JSON.stringify(archived.problems))
    assert.match(archived.problems[0], /指向源环境的链接.*shared-link/)
    fs.rmSync(escape)
    archived = await deployService.promotePreview(scriptId, { sourceTargetId: 't1', destTargetId: 't2' })
  }
  assert.equal(archived.problems.length, 0, JSON.stringify(archived.problems))
  assert.equal(archived.source.package, 'archive')
  assert(archived.warnings.some((warning) => /未留存原始发布包/.test(warning)))
  capture()
  const archivedRun = await deployService.promote(scriptId, { sourceTargetId: 't1', destTargetId: 't2', options: { expectedVersion: 'app-v1.1.0-001' } })
  assert.equal(archivedRun.status, 'success', `重新打包同步应成功:\n${logText()}`)
  assert.equal(archivedRun.dataSynced, false)
  assert.equal(archivedRun.stages.datasync.status, 'skipped')
  const moved = path.join(local('/srv/prod'), 'releases/app-v1.1.0-001')
  assert.equal(fs.readFileSync(path.join(local('/srv/prod'), 'CURRENT'), 'utf8').trim(), 'app-v1.1.0-001')
  assert.equal(fs.readFileSync(path.join(moved, 'notes.txt'), 'utf8'), 'packaged file\n')
  assert.equal(fs.readFileSync(path.join(moved, 'payload.txt'), 'utf8'), `payload of app-v1.1.0-001\n`)
  assert(!fs.existsSync(path.join(moved, 'run.log')), '运行期日志不得带到目标环境')
  assert(!fs.existsSync(path.join(moved, '__pycache__')), '字节码缓存不得带到目标环境')
  assert(fs.existsSync(path.join(moved, 'app.pid')) && fs.readFileSync(path.join(moved, 'app.pid'), 'utf8').trim() !== '99999', '源环境的 pid 文件不得带到目标环境（否则启动脚本误判已在运行）')
  assert(!fs.existsSync(path.join(moved, 'shared-link')), '指向源环境的链接不得带到目标环境')
  step('无留存包：预检标注重新打包并拦截指向源环境的链接；同步剔除 pid/日志/字节码缓存，其余文件原样搬运')

  // ═══════════ 场景三：docker 形态，同一台服务器 ═══════════
  capture()
  const dockerDir = path.join(tmpRoot, 'proj-docker')
  // 编排声明了一个外部网络和一个绝对路径的宿主机挂载：发布流程不会替目标服务器创建它们
  const fixtureData = posix(path.join(tmpRoot, 'fixture-data'))
  write(path.join(dockerDir, 'VERSION'), '2.0.0\n')
  write(path.join(dockerDir, 'docker-compose.yml'), [
    'services:',
    '  app:',
    '    image: busybox',
    '    volumes:',
    `      - ${fixtureData}:/data`,
    '    networks:',
    '      - default',
    '      - fixture-shared',
    // 编排里的数据库服务：全新目标环境同步数据时，应用首次启动前单独拉起它并灌入源库
    '  pg:',
    '    image: postgres:16-alpine',
    '    environment:',
    '      POSTGRES_USER: postgres',
    '      POSTGRES_DB: envsync_fresh',
    'networks:',
    '  fixture-shared:',
    '    external: true',
    '',
  ].join('\n'))
  write(path.join(dockerDir, 'app.js'), 'console.log("2.0.0")\n')
  // .backupignore 是 tar 排除模式（带尾斜杠的 cache/ 不生效），与既有代码备份行为一致
  write(path.join(dockerDir, '.backupignore'), 'cache\n')
  write(path.join(dockerDir, 'cache/junk.txt'), 'junk\n')
  write(path.join(dockerDir, 'config/settings.json'), '{}\n')
  const dockerId = saveProject({
    name: '同步容器项目', localPath: dockerDir, deployMode: 'docker', configMode: 'manual', composeFile: 'docker-compose.yml',
    version: { strategy: 'auto', manual: '' },
    targets: [target('d1', '测试环境', '/srv/dtest'), target('d2', '正式环境', '/srv/dprod')],
  })
  write(path.join(local('/srv/dtest'), 'shared/.env'), 'ENV=dtest\n')
  write(path.join(local('/srv/dprod'), 'shared/.env'), 'ENV=dprod\n')
  const dockerFirst = await deployService.run(dockerId, 'd1')
  assert.equal(dockerFirst.status, 'success', `docker 形态发布测试环境应成功:\n${logText()}`)
  assert.equal(fs.readFileSync(path.join(local('/srv/dtest'), 'releases/2.0.0/.env'), 'utf8'), 'ENV=dtest\n')
  // ── 目标服务器前提：缺外部网络是阻塞项（服务启动必然失败），缺宿主机目录只是提醒 ──
  const unready = await deployService.promotePreview(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2' })
  assert(unready.problems.some((problem) => /目标服务器缺少编排声明的外部网络：fixture-shared/.test(problem)), JSON.stringify(unready.problems))
  assert(unready.warnings.some((warning) => warning.includes(`目标服务器缺少编排挂载的宿主机目录：${fixtureData}`)), JSON.stringify(unready.warnings))
  capture()
  const blocked = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2', options: { expectedVersion: '2.0.0' } })
  assert.equal(blocked.status, 'failed')
  assert.match(blocked.message, /目标服务器缺少编排声明的外部网络：fixture-shared/)
  assert.equal(blocked.stages.check.status, 'failed', '应在检查阶段拦下')
  assert.equal(blocked.stages.package.status, 'waiting', '不得进入取包阶段')
  assert(!fs.existsSync(path.join(local('/srv/dprod'), 'releases')), '前提缺失时不得改动目标服务器')
  fs.mkdirSync(path.join(tmpRoot, 'fixture-data'))
  write(path.join(tmpRoot, 'fixture-networks/fixture-shared'), '')
  const dockerPreview = await deployService.promotePreview(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2' })
  assert.equal(dockerPreview.problems.length, 0, JSON.stringify(dockerPreview.problems))
  assert(!dockerPreview.warnings.some((warning) => warning.startsWith('目标服务器缺少')), JSON.stringify(dockerPreview.warnings))
  step('目标服务器前提检查：缺外部网络在检查阶段拦下且不动服务器，补齐后放行；缺宿主机目录只提醒')
  assert.equal(dockerPreview.source.package, 'kept')
  // 目标尚未部署且没有现成的数据库容器：编排里有数据库服务，按「应用首次启动前灌入」给出数据同步
  assert.equal(dockerPreview.dataSync.available, true, dockerPreview.dataSync.reason)
  assert.equal(dockerPreview.dataSync.fresh, true)
  assert.equal(dockerPreview.dataSync.dest.service, 'pg')
  const staleTarget = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2', options: { expectedVersion: '2.0.0', expectedDestVersion: '1.9.0' } })
  assert.equal(staleTarget.status, 'failed')
  assert.match(staleTarget.message, /目标环境版本已变化/)
  assert(!fs.existsSync(path.join(local('/srv/dprod'), 'current')), '预检过期时不得部署')
  bashEnv.FIXTURE_COMPOSE_OWNER = '/another-env/releases/2.0.0'
  const foreignCompose = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2', options: { expectedVersion: '2.0.0', expectedDestVersion: '' } })
  delete bashEnv.FIXTURE_COMPOSE_OWNER
  assert.equal(foreignCompose.status, 'failed')
  assert.match(foreignCompose.message, /Compose 项目 fixture-proj 已被其他部署目录使用/)
  capture()
  const dockerPromoted = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2', options: { expectedVersion: '2.0.0' } })
  assert.equal(dockerPromoted.status, 'success', `docker 形态同步应成功:\n${logText()}`)
  for (const stage of ['extract', 'build', 'start', 'health']) assert.equal(dockerPromoted.stages[stage].status, 'success', `阶段 ${stage}`)
  assert.equal(fs.readFileSync(path.join(local('/srv/dprod'), 'releases/2.0.0/.env'), 'utf8'), 'ENV=dprod\n', '目标版本目录应链接目标环境自己的运行配置')
  assert.equal(fs.readFileSync(path.join(local('/srv/dprod'), 'releases/2.0.0/app.js'), 'utf8'), 'console.log("2.0.0")\n')
  assert(fs.lstatSync(path.join(local('/srv/dprod'), 'current')).isSymbolicLink())
  step('docker 形态：留存的 ZIP 原样搬运，目标版本目录使用目标环境自己的 .env')

  // docker 形态回退：tar 包走 deploy.sh 的 docker 发布路径，.env 软链不随包迁移，代码备份从 tar 包读取排除规则
  capture()
  write(path.join(dockerDir, 'VERSION'), '2.1.0\n')
  write(path.join(dockerDir, 'app.js'), 'console.log("2.1.0")\n')
  const dockerSecond = await deployService.run(dockerId, 'd1')
  assert.equal(dockerSecond.status, 'success', `docker 形态升级测试环境应成功:\n${logText()}`)
  fs.rmSync(path.join(local('/srv/dtest'), 'releases/.packages/2.1.0.zip'))
  const sourceEnvFile = path.join(local('/srv/dtest'), 'releases/2.1.0/.env')
  fs.unlinkSync(sourceEnvFile)
  write(sourceEnvFile, 'ENV=source-specific-copy\n')
  const dockerArchived = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2', options: { expectedVersion: '2.1.0' } })
  assert.equal(dockerArchived.status, 'success', `docker 形态重新打包同步应成功:\n${logText()}`)
  assert(logText().includes('正在打包版本目录'))
  assert.equal(fs.readFileSync(path.join(local('/srv/dprod'), 'releases/2.1.0/.env'), 'utf8'), 'ENV=dprod\n', '源版本的普通 .env 文件也不得覆盖目标环境')
  assert.equal(fs.readFileSync(path.join(local('/srv/dprod'), 'releases/2.1.0/app.js'), 'utf8'), 'console.log("2.1.0")\n')
  // 代码备份从 tar 包里读取 .backupignore：cache/ 不进备份，业务文件照常备份
  const codeBackup = fs.readdirSync(path.join(local('/srv/dprod'), 'backups')).find((name) => /^app_\w+\.tar\.gz$/.test(name))
  assert(codeBackup, 'docker 形态同步前应备份目标环境旧版本代码')
  const backupList = runBash(`tar -tzf ${shQuote(posix(path.join(local('/srv/dprod'), 'backups', codeBackup)))}`).stdout
  assert(backupList.includes('./app.js'), `业务文件应进代码备份:\n${backupList}`)
  assert(!backupList.includes('cache/junk.txt'), `排除规则应生效:\n${backupList}`)
  assert(fs.existsSync(path.join(local('/srv/dprod'), 'releases/2.1.0/cache/junk.txt')), '发布包内容不受备份排除规则影响')
  assert(fs.readdirSync(path.join(local('/srv/dprod'), 'uploads')).every((name) => !name.startsWith('promote_')), '同步包不得残留')
  step('docker 形态无留存包：重新打成 tar 包发布，.env 软链不迁移，代码备份从 tar 包读取排除规则')
  // 版本已一致时不会再打包，也就不必再提醒「将重新打包版本目录」
  const settled = await deployService.promotePreview(dockerId, { sourceTargetId: 'd1', destTargetId: 'd2' })
  assert.equal(settled.needDeploy, false)
  assert(!settled.warnings.some((warning) => /未留存原始发布包/.test(warning)), JSON.stringify(settled.warnings))

  // ═══════════ 场景三·二：全新目标环境 + 同步数据 → 先灌数据库，再启动应用 ═══════════
  // PlmInsight 迁移到新服务器的真实情形：应用在空库上启动要先做漫长的初始化（甚至起不来），
  // 数据必须在第一次启动之前就位。数据库服务随本次发布才创建，按编排里的服务名操作。
  assert.deepEqual(
    deployService.composeDatabase(['services:', '  postgres:', '    image: m.daocloud.io/docker.io/library/postgres:16-alpine', '    environment:', '      POSTGRES_DB: plm_bi', '      POSTGRES_USER: plm_bi', '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}', '  web:', '    image: nginx:1.25-alpine', ''].join('\n')),
    { service: 'postgres', user: 'plm_bi', name: 'plm_bi', type: 'postgres', fresh: true },
    '应从编排里认出唯一的 PostgreSQL 服务及其库账号',
  )
  assert.equal(deployService.composeDatabase('services:\n  a:\n    image: postgres:16\n  b:\n    image: postgres:16\n'), null, '多个数据库服务时不能猜')
  assert.equal(deployService.composeDatabase('services:\n  web:\n    image: nginx:1.25-alpine\n'), null, '没有数据库服务时不能猜')
  const withFresh = deployProjects.list().find((p) => p.id === dockerId)
  assert(deployProjects.save({ ...JSON.parse(JSON.stringify(withFresh)), targets: [...withFresh.targets.map((t) => ({ ...t })), target('d3', '全新环境', '/srv/fresh')] }).ok)
  capture()
  const freshPreview = await deployService.promotePreview(dockerId, { sourceTargetId: 'd1', destTargetId: 'd3' })
  assert.equal(freshPreview.problems.length, 0, JSON.stringify(freshPreview.problems))
  assert.equal(freshPreview.dest.version, '', '目标尚未部署')
  assert.equal(freshPreview.dataSync.available, true, freshPreview.dataSync.reason)
  assert.equal(freshPreview.dataSync.fresh, true, '全新目标应按「应用首次启动前灌入」处理')
  assert.deepEqual([freshPreview.dataSync.dest.service, freshPreview.dataSync.dest.name, freshPreview.dataSync.dest.user], ['pg', 'envsync_fresh', 'postgres'])
  const freshRun = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd3', options: { syncData: true, expectedVersion: '2.1.0' } })
  assert.equal(freshRun.status, 'success', `全新目标环境同步应成功:\n${logText()}`)
  assert.equal(freshRun.deployed, true)
  assert.equal(freshRun.dataSynced, true)
  for (const stage of ['upload', 'build', 'datasync', 'start', 'health']) assert.equal(freshRun.stages[stage].status, 'success', `阶段 ${stage}：${JSON.stringify(Object.fromEntries(Object.entries(freshRun.stages).map(([id, s]) => [id, s.status])))}`)
  const text = logText()
  assert(text.indexOf('灌入源环境数据库') > text.indexOf('镜像构建完成') && text.indexOf('灌入源环境数据库') < text.indexOf('Docker 服务已启动'), '数据库应在镜像构建之后、启动服务之前灌入')
  assert(text.includes('行数核对一致'), '灌入后应核对行数')
  assert(/数据库 envsync_fresh 已同步到 全新环境（应用首次启动前灌入）/.test(freshRun.message), freshRun.message)
  assert.equal(fs.readFileSync(path.join(local('/srv/fresh'), 'current', 'app.js'), 'utf8'), 'console.log("2.1.0")\n', '全新环境应运行同步过去的版本')
  if (pgBin) {
    const [freshState, sourceState] = [state('envsync_fresh'), state('envsync_src')]
    assert.deepEqual({ ...freshState, tables: freshState.tables.sort() }, { ...sourceState, tables: sourceState.tables.sort() }, '全新环境的数据库应与源库一致（表、数据、序列）')
    assert.equal(sql('envsync_fresh', 'SELECT count(*) FROM pg_stat_user_tables WHERE last_analyze IS NULL'), '0', '应用启动前应已刷新查询计划统计信息')
    assert(text.indexOf('刷新查询计划统计信息') < text.indexOf('数据库已就绪'), '统计信息应在应用启动之前刷新')
  }
  assert(fs.readdirSync(path.join(local('/srv/fresh'), 'uploads')).every((name) => !name.startsWith('promote_')), '数据库导出与同步包不得残留')
  step('全新目标环境：先启动数据库服务灌入源库，再启动应用；数据与源库一致，导出文件不残留')

  // ═══════════ 场景三·三：全新目标上的库已存在却读不了 ═══════════
  // 查询失败不能当成「库里没内容」：那样会不做备份直接删库。这里中止，库里的数据原样保留
  fs.rmSync(path.join(local('/srv/fresh'), 'current'), { force: true })
  const oldGuards = new Set(fs.readdirSync(path.join(local('/srv/fresh'), 'backups')))
  bashEnv.FIXTURE_FAIL_DB = 'envsync_fresh'
  capture()
  const unreadable = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd3', options: { syncData: true, expectedVersion: '2.1.0' } })
  delete bashEnv.FIXTURE_FAIL_DB
  assert.equal(unreadable.status, 'failed', `目标库读不了时同步应失败：${JSON.stringify({ status: unreadable.status, message: unreadable.message })}`)
  assert.equal(unreadable.deployed, false)
  assert(logText().includes('目标库 envsync_fresh 已存在但无法读取'), `应说明中止原因:\n${logText()}`)
  assert(!fs.existsSync(path.join(local('/srv/fresh'), 'current')), '中止后目标环境不应处于已部署状态')
  assert(!fs.readdirSync(path.join(local('/srv/fresh'), 'backups')).some((name) => name.startsWith('db_guard_') && !oldGuards.has(name)), '尚未备份就不应走到切换数据库')
  if (pgBin) {
    const kept = state('envsync_fresh')
    assert.deepEqual({ ...kept, tables: kept.tables.sort() }, { ...state('envsync_src'), tables: state('envsync_src').tables.sort() }, '中止时目标库必须原样保留')
  }
  step('全新目标的库已存在却读不了：中止同步，不做任何改动（不把查询失败当成空库去删）')

  if (pgBin) {
    const beforeInvalidDump = state('envsync_fresh')
    bashEnv.FIXTURE_INVALID_SOURCE_DUMP = '1'
    const badImport = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd3', options: { syncData: true, expectedVersion: '2.1.0' } })
    delete bashEnv.FIXTURE_INVALID_SOURCE_DUMP
    assert.equal(badImport.status, 'failed')
    assert.equal(badImport.dataSynced, false)
    assert(badImport.dataGuard, '导入失败仍要记录保底备份')
    assert.deepEqual(state('envsync_fresh'), beforeInvalidDump, 'SQL 导入出错后目标库原样保留')
    assert.equal(sql('postgres', "SELECT count(*) FROM pg_database WHERE datname LIKE 'plm_import_%'"), '0', '清理导入失败的暂存数据库')
    oldGuards.add(badImport.dataGuard)
    step('真 PostgreSQL：导入错误只影响暂存库，清理暂存库并保留源库和目标库')
  }

  // ═══════════ 场景三·四：全新目标上留着上一次失败发布的半截数据 ═══════════
  // 版本目录还在、current 不在（发布失败被撤回）、数据库卷里已有表：仍按全新目标处理，
  // 灌库之前先把库里的内容保底备份，再整库换成源库的内容
  if (pgBin) {
    sql('envsync_fresh', 'CREATE TABLE leftover (id int); INSERT INTO leftover VALUES (1)')
    sql('envsync_src', "INSERT INTO tags VALUES (9,'src-new')")
  }
  fs.rmSync(path.join(local('/srv/fresh'), 'current'), { force: true })
  bashEnv.FIXTURE_FRESH_RUNNING = '1'
  const retryPreview = await deployService.promotePreview(dockerId, { sourceTargetId: 'd1', destTargetId: 'd3' })
  assert.equal(retryPreview.dest.version, '', 'current 不在时应按未部署处理')
  assert.equal(retryPreview.dataSync.fresh, true, '仍应按「应用首次启动前灌入」处理')
  capture()
  const retry = await deployService.promote(dockerId, { sourceTargetId: 'd1', destTargetId: 'd3', options: { syncData: true, expectedVersion: '2.1.0' } })
  delete bashEnv.FIXTURE_FRESH_RUNNING
  assert.equal(retry.status, 'success', `全新目标留着半截数据时同步应成功:\n${logText()}`)
  assert(logText().includes('目标库已先保底备份'), `灌库前应保底备份目标库里已有的数据:\n${logText()}`)
  const guards = fs.readdirSync(path.join(local('/srv/fresh'), 'backups')).filter((name) => /^db_guard_\w+\.sql$/.test(name) && !oldGuards.has(name))
  assert.equal(guards.length, 1, `应生成一份保底备份：${fs.readdirSync(path.join(local('/srv/fresh'), 'backups')).join(' ')}`)
  assert(fs.readFileSync(path.join(local('/srv/fresh'), 'backups', guards[0]), 'utf8').includes('CREATE TABLE public.leftover'), '保底备份应是灌库之前目标库里的内容')
  if (pgBin) {
    assert(!state('envsync_fresh').tables.includes('leftover'), '半截数据应被源库替换')
    assert.deepEqual({ ...state('envsync_fresh'), tables: state('envsync_fresh').tables.sort() }, { ...state('envsync_src'), tables: state('envsync_src').tables.sort() }, '替换后新库应与源库一致')
  }
  step('全新目标留着上次失败发布的半截数据：灌库前保底备份，再整库替换为源库内容')

  // ═══════════ 场景四：跨服务器，发布包与数据库导出经本机中转 ═══════════
  capture()
  const crossDir = path.join(tmpRoot, 'proj-cross')
  write(path.join(crossDir, 'VERSION'), '1.0.0\n')
  const crossId = saveProject({
    name: '跨服务器项目', localPath: crossDir, deployMode: 'script', configMode: 'manual',
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' }, version: { strategy: 'auto', manual: '' },
    targets: [target('s', '测试环境', '/srv/xsrc', '203.0.113.20'), target('p', '正式环境', '/srv/xprod', '203.0.113.30')],
  })
  makeArtifact(crossDir, 'cross-v1.0.0-001')
  const crossFirst = await deployService.run(crossId, 's')
  assert.equal(crossFirst.status, 'success', `跨服务器场景发布源环境应成功:\n${logText()}`)
  if (pgBin) sql('envsync_xdst', 'CREATE TABLE legacy (id int)')
  const crossPreview = await deployService.promotePreview(crossId, { sourceTargetId: 's', destTargetId: 'p' })
  assert.equal(crossPreview.sameServer, false)
  assert.equal(crossPreview.problems.length, 0, JSON.stringify(crossPreview.problems))
  assert.equal(crossPreview.dataSync.source.container, 'xsrc-db')
  assert.equal(crossPreview.dataSync.dest.container, 'xdst-db')
  const uploadsBefore = connections.uploads.length
  capture()
  const crossRun = await deployService.promote(crossId, { sourceTargetId: 's', destTargetId: 'p', options: { syncData: true, expectedVersion: 'cross-v1.0.0-001' } })
  assert.equal(crossRun.status, 'success', `跨服务器同步应成功:\n${logText()}`)
  assert.equal(crossRun.deployed, true)
  assert.equal(crossRun.dataSynced, true)
  const relayed = connections.uploads.slice(uploadsBefore)
  assert.equal(relayed.length, 2, '发布包与数据库导出各中转一次')
  assert.equal(relayed[0].sha256, sha256(path.join(local('/srv/xsrc'), 'releases/.packages/cross-v1.0.0-001.tar.gz')), '中转的发布包应与留存包逐字节一致')
  assert.equal(fs.readFileSync(path.join(local('/srv/xprod'), 'CURRENT'), 'utf8').trim(), 'cross-v1.0.0-001')
  if (pgBin) {
    assert.equal(state('envsync_xdst').tables.sort().join(','), srcBefore.tables.sort().join(','))
    assert.equal(state('envsync_xdst').accounts, srcBefore.accounts)
  }
  assert.equal(connections.opened, connections.closed, '同步结束后两个服务器的连接都要释放')
  step('跨服务器：发布包与数据库导出经本机中转，SHA256 两端一致，目标库数据与源库一致')

  // ── 阻塞项：自动发布形态、两侧同一数据库、非 PostgreSQL ──
  const saved = deployProjects.list().find((p) => p.id === scriptId)
  assert(deployService.promoteEnvironments({ ...saved, deployMode: 'auto' }, 't1', 't2').problems.some((problem) => /自动发布形态/.test(problem)))
  const manualDb = { strategy: 'manual', enabled: true, type: 'postgres', container: 'prod-db-1', name: 'envsync_dst', user: '' }
  const sharedDbId = saveProject({
    name: '同库项目', localPath: scriptDir, deployMode: 'script', configMode: 'manual',
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' },
    targets: [target('a', '甲', '/srv/test', server.host, { db: manualDb }), target('b', '乙', '/srv/prod', server.host, { db: manualDb })],
  })
  const sharedDb = await deployService.promotePreview(sharedDbId, { sourceTargetId: 'a', destTargetId: 'b' })
  assert.equal(sharedDb.dataSync.available, false)
  assert.match(sharedDb.dataSync.reason, /同一个数据库/)
  const mysqlId = saveProject({
    name: 'MySQL 项目', localPath: scriptDir, deployMode: 'script', configMode: 'manual',
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' },
    targets: [target('a', '甲', '/srv/test', server.host, { db: { ...manualDb, type: 'mysql', container: 'test-db-1', name: 'envsync_src' } }), target('b', '乙', '/srv/fresh')],
  })
  const mysql = await deployService.promotePreview(mysqlId, { sourceTargetId: 'a', destTargetId: 'b' })
  assert.match(mysql.dataSync.reason, /源环境配置的数据库是 MySQL/)
  assert.equal(mysql.needDeploy, true)
  assert.deepEqual(mysql.problems, [], 'MySQL 只让数据同步不可用，不阻塞版本同步')
  assert.equal(deployService.databaseEngine('postgres:18-bookworm'), 'postgres')
  assert.equal(deployService.databaseEngine('registry-1.docker.io/library/mysql:8'), 'mysql')
  assert.equal(deployService.databaseEngine('pgvector/pgvector:pg16'), 'postgres')
  assert.equal(deployService.databaseEngine('secwatch-abc-server:1.0'), '')
  step('阻塞项：自动发布形态拒绝；两侧同一数据库或 MySQL 时数据同步不可用但不阻塞版本同步')

  // ── 留存包随版本轮转清理 ──
  const rotate = path.join(tmpRoot, 'rotate')
  for (const name of ['keep-1.zip', 'keep-2.tar.gz', 'gone-1.zip', 'gone-2.tgz', 'stray.txt']) write(path.join(rotate, 'releases/.packages', name), 'x')
  fs.mkdirSync(path.join(rotate, 'releases/keep-1'))
  fs.mkdirSync(path.join(rotate, 'releases/keep-2'))
  const script = fs.readFileSync(path.resolve(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
  const lib = path.join(rotate, 'lib.sh')
  fs.writeFileSync(lib, script.slice(0, script.lastIndexOf('case "$CMD" in')))
  const rotated = runBash(`source ${shQuote(posix(lib))} deploy --home ${shQuote(posix(rotate))} --package gone-1.zip; cleanup_packages; echo __LIST__; ls -1A ${shQuote(posix(path.join(rotate, 'releases/.packages')))}`, { encoding: 'utf8' })
  assert.deepEqual(rotated.stdout.split('__LIST__')[1].trim().split('\n').sort(), ['keep-1.zip', 'keep-2.tar.gz', 'stray.txt'], rotated.stdout + rotated.stderr)
  step('留存发布包随版本目录轮转清理，版本仍在的保留')

  console.log(`\n环境同步编排自测通过（${passed.length} 组，${pgBin ? '真实 PostgreSQL' : '数据库为替身'}）`)
}

main().catch((error) => {
  console.error(logText())
  console.error((error && error.stack) || error)
  process.exitCode = 1
}).finally(() => {
  stopPg()
  if (pgChild && pgChild.exitCode === null) pgChild.kill()
  // Windows 下 PostgreSQL 退出后文件句柄释放有延迟：重试到能删为止，避免留下临时目录
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (path.dirname(tmpRoot) === tempRoot && path.basename(tmpRoot).startsWith('deploy-promote-')) fs.rmSync(tmpRoot, { recursive: true, force: true })
      break
    } catch {
      spawnSync(bash, ['-c', 'sleep 0.3'])
    }
  }
})
