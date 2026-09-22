/** 真实 deploy.sh 验证数据同步先于切换和启动；仅 Docker 命令用本地替身。 */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const { spawnSync } = require('child_process')
const archiver = require('archiver')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-prestart-data-'))
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const posix = (p) => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())
const bin = path.join(root, 'bin'), script = path.join(root, 'deploy.sh')
fs.mkdirSync(bin)
fs.writeFileSync(script, fs.readFileSync(path.resolve(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n'))
fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
if [ "$1" = compose ]; then
  [ "$2" = version ] && exit 0
  case "$4" in
    config) [ "\${5:-}" = --services ] && echo app; exit 0 ;;
    build) echo build >> "$FLOW"; [ "\${BUILD_FAIL:-0}" != 1 ]; exit $? ;;
    down) echo down >> "$FLOW"; exit 0 ;;
    up) [ -f "$FIXTURE_HOME/shared/data/items.txt" ] || { echo missing-data >> "$FLOW"; exit 8; }; echo up >> "$FLOW"; exit 0 ;;
    ps) echo app-container; exit 0 ;;
  esac
elif [ "$1" = inspect ]; then
  if [[ "$3" == *Running* ]]; then echo true; else echo healthy; fi
  exit 0
fi
exit 20
`, { mode: 0o755 })

async function seed(name, old = true) {
  const home = path.join(root, name), flow = path.join(home, 'flow.txt')
  fs.mkdirSync(path.join(home, 'deployer'), { recursive: true })
  fs.mkdirSync(path.join(home, 'uploads'))
  fs.writeFileSync(flow, '')
  if (old) {
    fs.mkdirSync(path.join(home, 'releases/old'), { recursive: true })
    fs.writeFileSync(path.join(home, 'releases/old/docker-compose.yml'), 'services:\n  app:\n    image: fixture\n')
    fs.symlinkSync(path.join(home, 'releases/old'), path.join(home, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const sync = path.join(home, 'deployer/data-sync.sh')
  fs.writeFileSync(sync, `#!/usr/bin/env bash
set -eu
echo sync >> "$FLOW"
mkdir -p "$FIXTURE_HOME/shared/data"
printf fixture > "$FIXTURE_HOME/shared/data/items.txt"
[ "\${SYNC_FAIL:-0}" != 1 ]
`)
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(path.join(home, 'uploads/app.zip'))
    const archive = archiver('zip')
    archive.on('error', reject); output.on('error', reject); output.on('close', resolve)
    archive.pipe(output)
    archive.append('services:\n  app:\n    image: fixture\n', { name: 'docker-compose.yml' })
    archive.finalize().catch(reject)
  })
  return { home, flow, sync }
}

function run(fixture, env = {}, suppliedScript = fixture.sync) {
  return spawnSync(bash, [posix(script), 'deploy', '--app', 'fixture', '--home', posix(fixture.home), '--version', '1.0.0', '--release-id', '1.0.0-new', '--project-name', 'fixture-project', '--package', 'app.zip', '--no-backup-db', '--health-timeout', '1', '--health-interval', '1', '--data-sync-script', posix(suppliedScript)], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin' + path.delimiter : ''}${process.env.PATH}`, FLOW: posix(fixture.flow), FIXTURE_HOME: posix(fixture.home), MSYS: 'winsymlinks:nativestrict', ...env },
  })
}
const flowOf = (fixture) => fs.readFileSync(fixture.flow, 'utf8').trim().split(/\r?\n/).filter(Boolean)

;(async () => {
  const first = await seed('first', false)
  let result = run(first)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(flowOf(first), ['build', 'sync', 'up'])
  assert(result.stdout.includes('__STAGE_OK__:datasync') && result.stdout.includes('__DEPLOY_OK__'))
  assert(result.stdout.indexOf('__STAGE__:datasync') < result.stdout.indexOf('__STAGE__:start'))
  assert(fs.existsSync(path.join(first.home, 'shared/data/items.txt')), '首次启动前数据目录及内容已就绪')

  const upgrade = await seed('upgrade')
  result = run(upgrade)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(flowOf(upgrade), ['build', 'sync', 'down', 'up'])
  assert(result.stdout.indexOf('__STAGE__:backup-code') < result.stdout.indexOf('__STAGE__:datasync'))

  const buildFail = await seed('build-fail')
  result = run(buildFail, { BUILD_FAIL: '1' })
  assert.equal(result.status, 1)
  assert.deepEqual(flowOf(buildFail), ['build'])
  assert.equal(fs.realpathSync(path.join(buildFail.home, 'current')), fs.realpathSync(path.join(buildFail.home, 'releases/old')))

  const syncFail = await seed('sync-fail')
  result = run(syncFail, { SYNC_FAIL: '1' })
  assert.equal(result.status, 1)
  assert.deepEqual(flowOf(syncFail), ['build', 'sync'])
  assert(result.stdout.includes('启动前数据同步失败') && !result.stdout.includes('__DEPLOY_OK__'))
  assert.equal(fs.realpathSync(path.join(syncFail.home, 'current')), fs.realpathSync(path.join(syncFail.home, 'releases/old')))

  const outside = await seed('outside')
  const foreignScript = path.join(root, 'foreign.sh'); fs.writeFileSync(foreignScript, 'exit 0\n')
  result = run(outside, {}, foreignScript)
  assert.equal(result.status, 1); assert.deepEqual(flowOf(outside), [])

  const linked = await seed('linked')
  fs.unlinkSync(linked.sync)
  fs.symlinkSync(foreignScript, linked.sync, 'file')
  result = run(linked)
  assert.equal(result.status, 1); assert(result.stdout.includes('链接')); assert.deepEqual(flowOf(linked), [])

  const hardlink = await seed('hardlink')
  fs.linkSync(hardlink.sync, path.join(root, 'hardlink.sh'))
  result = run(hardlink)
  assert.equal(result.status, 1); assert(result.stdout.includes('硬链接')); assert.deepEqual(flowOf(hardlink), [])
  console.log('PASS 启动前数据同步：首次数据就绪、备份/构建/同步/启动顺序、构建失败不执行、同步失败保留旧实例、拒绝越界及链接脚本')
})().catch((e) => { console.error(e.stack); process.exitCode = 1 }).finally(() => {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-prestart-data-')) fs.rmSync(root, { recursive: true, force: true })
})
