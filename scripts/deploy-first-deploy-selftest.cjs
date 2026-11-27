/**
 * 首次部署自测（真实 Bash + 真实 deploy.sh 的 do_deploy，Docker 为替身）：
 *   node scripts/deploy-first-deploy-selftest.cjs
 *
 * 覆盖环境同步把版本搬到全新服务器时暴露的三处问题：
 *   - current 不存在时应判定为「首次发布，无旧版本」，而不是把 readlink -f 输出的路径当成「当前运行版本目录: current」
 *   - 手动指定了数据库备份、但数据库容器随本次发布才会创建：跳过备份并继续（原先必然在备份阶段中止）
 *   - 数据库容器已存在（沿用外部数据库）时照常备份；非首次部署时容器缺失仍然中止
 *   - 阶段跟踪：后一阶段开始即收尾前面的阶段（服务器脚本只发开始标记）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { buildPackage } = require('../electron/deploy/packager')

const tempRoot = fs.realpathSync.native(os.tmpdir())
const root = fs.mkdtempSync(path.join(tempRoot, 'deploy-first-deploy-'))
const posix = (p) => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())
const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const lib = path.join(root, 'functions.sh')
const deploy = fs.readFileSync(path.join(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
fs.writeFileSync(lib, deploy.slice(0, deploy.lastIndexOf('case "$CMD" in')))
const packages = []
let passed = 0
function step(title) { passed += 1; console.log(`  ✓ ${title}`) }

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

/** 一套全新的部署目录：只有上传好的发布包，没有 current、没有数据库容器 */
async function fixture(name, { existingRelease = '', existingDb = '' } = {}) {
  const dir = path.join(root, name)
  const home = path.join(dir, 'home')
  const source = path.join(dir, 'source')
  write(path.join(source, 'docker-compose.yml'), 'services:\n  app:\n    image: busybox\n')
  write(path.join(source, 'app.js'), 'console.log("1.0.0")\n')
  const pkg = await buildPackage({ projectDir: source, appName: `first-deploy-${name}`, version: '1.0.0' })
  packages.push(pkg.zipPath)
  write(path.join(home, 'uploads/bundle.zip'), fs.readFileSync(pkg.zipPath))
  if (existingRelease) write(path.join(home, 'releases', existingRelease, 'app.js'), 'old\n')
  return { dir, home, existingRelease, existingDb }
}

/** 真实执行 deploy.sh 的 do_deploy；Docker 为替身，只有 existingDb 指定的容器能被 exec 到 */
function runDeploy(f, { withCurrent = false } = {}) {
  const script = path.join(f.dir, 'run.sh')
  fs.writeFileSync(script, [
    // 参数一次性传给 source：部署脚本在顶层解析位置参数
    `source '${posix(lib)}' deploy --app first-deploy --home '${posix(f.home)}' --package bundle.zip --version 1.0.0 --compose docker-compose.yml`
      + ` --no-backup-code --backup-db --db-type postgres --db-container ${f.existingDb || 'test-db'} --db-name app --db-user app`
      + ' --auto-rollback --no-health --keep-releases 10 --keep-backups 10 --delete-upload',
    withCurrent && f.existingRelease ? `ln -sfn '${posix(path.join(f.home, 'releases', f.existingRelease))}' '${posix(path.join(f.home, 'current'))}'` : 'true',
    // 部署脚本顶层有 set -u：替身里的位置参数必须带默认值，否则未绑定的 $4 会让 bash 直接退出
    'docker() {',
    '  case "$1" in',
    '    compose) case "${4:-}" in ps) printf "app-1\\n" ;; *) return 0 ;; esac ;;',
    // 带格式参数的是容器状态查询；只给容器名的是存在性检查，只有 existingDb 才存在
    `    inspect) [ "\${2:-}" = -f ] && { printf "true\\n"; return 0; }; [ "\${2:-}" = ${f.existingDb ? JSON.stringify(f.existingDb) : '""'} ] || return 1; printf "[]\\n" ;;`,
    `    exec) [ "\${2:-}" = ${f.existingDb ? JSON.stringify(f.existingDb) : '""'} ] || return 1; printf -- "-- 模拟数据库备份\\n" ;;`,
    '    *) return 98 ;;',
    '  esac',
    '}',
    'export -f docker',
    'do_deploy',
    '',
  ].join('\n'))
  return spawnSync(bash, [posix(script)], { encoding: 'utf8', timeout: 30000, env: { ...process.env, MSYS: process.platform === 'win32' ? 'winsymlinks:nativestrict' : undefined } })
}

/** 失败时带上退出状态，方便定位脚本自身的问题 */
function describe(result) {
  return `status=${result.status} signal=${result.signal} error=${result.error ? result.error.message : ''}\n${result.stdout}${result.stderr}`
}

async function main() {
  // ── 1. 全新服务器 + 手动数据库备份：没有可备份的数据库，跳过并完成发布 ──
  const fresh = await fixture('fresh')
  let r = runDeploy(fresh)
  assert.equal(r.status, 0, `首次部署应成功：${describe(r)}`)
  assert(r.stdout.includes('首次发布，无旧版本'), '应判定为首次发布')
  assert(!/当前运行版本目录: current/.test(r.stdout), '不得把不存在的 current 当成运行中的版本目录')
  assert(r.stdout.includes('首次发布，数据库容器 test-db 尚未创建，跳过数据库备份'), '数据库容器尚未创建时应跳过备份')
  assert(r.stdout.includes('__DEPLOY_OK__:1.0.0'), '发布应完成')
  assert(fs.existsSync(path.join(fresh.home, 'releases/1.0.0/app.js')), '新版本应解压')
  assert(!fs.existsSync(path.join(fresh.home, 'backups')) || !fs.readdirSync(path.join(fresh.home, 'backups')).some((n) => n.startsWith('db_')), '不应产生数据库备份文件')
  assert.equal(fs.readFileSync(path.join(fresh.home, 'deploy-history.jsonl'), 'utf8').trim().split('\n').length, 1, '服务器历史应记录一次成功')
  step('全新服务器：判定首次发布、数据库容器尚未创建时跳过备份并完成发布')

  // ── 2. 全新服务器 + 沿用已存在的数据库容器：照常备份 ──
  const external = await fixture('external-db', { existingDb: 'external-db' })
  r = runDeploy(external)
  assert.equal(r.status, 0, `沿用已有数据库的首次部署应成功：${describe(r)}`)
  const dumps = fs.existsSync(path.join(external.home, 'backups')) ? fs.readdirSync(path.join(external.home, 'backups')).filter((n) => /^db_[\w.-]+\.sql$/.test(n)) : []
  assert.equal(dumps.length, 1, `数据库容器已存在时应先备份：${describe(r)}`)
  assert.equal(fs.readFileSync(path.join(external.home, 'backups', dumps[0]), 'utf8').trim(), '-- 模拟数据库备份')
  step('全新服务器：数据库容器已存在（沿用外部数据库）时照常备份')

  // ── 3. 已有运行版本，但数据库容器不见了：备份失败仍然中止，不改动运行状态 ──
  const broken = await fixture('broken', { existingRelease: '0.9.0' })
  r = runDeploy(broken, { withCurrent: true })
  assert.equal(r.status, 1, `非首次部署备份失败应中止：${describe(r)}`)
  assert(r.stdout.includes('当前运行版本目录: 0.9.0'), '已有运行版本时应识别出来')
  assert(r.stdout.includes('PostgreSQL 备份失败'), '备份失败应报告中止')
  assert(r.stdout.includes('__DEPLOY_FAIL__'), '应报告失败标记')
  assert(!fs.existsSync(path.join(broken.home, 'releases/1.0.0')), '中止时不应解压新版本')
  step('非首次部署：数据库容器缺失时备份失败仍然中止，不改动服务器')

  // ── 4. 阶段跟踪：后一阶段开始即收尾前面的阶段 ──
  const electronPath = require.resolve('electron')
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => false } } }
  const service = require('../electron/deploy/deploy-service')
  const events = []
  const tracker = service.newStageTracker((channel, payload) => events.push(`${payload.stage}:${payload.status}`))
  tracker.begin('check')
  tracker.begin('package')
  tracker.begin('upload')
  tracker.begin('backup')
  tracker.begin('extract')
  tracker.begin('build')
  assert.deepEqual(
    Object.entries(tracker.state).filter(([, s]) => s.status === 'running').map(([id]) => id), ['build'],
    '任一时刻只有最新开始的阶段处于进行中')
  for (const id of ['check', 'package', 'upload', 'backup', 'extract']) assert.equal(tracker.state[id].status, 'success', `阶段 ${id} 应在后一阶段开始时收尾`)
  assert.equal(events.filter((e) => e === 'extract:success').length, 1, '每个阶段只收尾一次')
  // 失败时只有出事的阶段标记为回滚/失败，前面已完成的阶段保持成功
  tracker.begin('start')
  tracker.end('start', 'failed')
  assert.equal(tracker.state.build.status, 'success')
  assert.equal(tracker.state.start.status, 'failed')
  assert.equal(tracker.state.health.status, 'waiting')
  step('阶段跟踪：后一阶段开始即收尾前面的阶段，当前阶段不再停在最先开始的那个')

  console.log(`首次部署自测通过（${passed} 组）`)
}

main().catch((error) => {
  console.error(error && error.stack || error)
  process.exitCode = 1
}).finally(() => {
  for (const file of packages) { try { fs.rmSync(file, { force: true }) } catch { /* 临时包已清理 */ } }
  try { if (path.dirname(root) === tempRoot && path.basename(root).startsWith('deploy-first-deploy-')) fs.rmSync(root, { recursive: true, force: true }) } catch { /* 留给系统清理 */ }
})
