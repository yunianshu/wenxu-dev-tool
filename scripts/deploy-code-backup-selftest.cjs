/** 真实 ZIP / Bash / tar 验证旧版本代码备份及数据库备份边界。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { buildPackage } = require('../electron/deploy/packager')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-code-backup-'))
const packages = []
const posix = p => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())
const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const lib = path.join(root, 'functions.sh')
const deploy = fs.readFileSync(path.join(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
fs.writeFileSync(lib, deploy.slice(0, deploy.lastIndexOf('case "$CMD" in')))

function write(dir, name, value) {
  const file = path.join(dir, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}

async function fixture(name, rules) {
  const dir = path.join(root, name)
  const source = path.join(dir, 'source')
  const old = path.join(dir, 'legacy')
  const home = path.join(dir, 'home')
  write(source, 'app.js', '新代码')
  if (rules !== undefined) write(source, '.backupignore', rules)
  write(old, 'app.js', '旧代码')
  write(old, '.env', 'CONFIG=保留旧配置\n')
  write(old, 'data/postgres/PG_VERSION', '原始数据库目录')
  write(old, 'data/uploads/photo.txt', '保留业务文件')
  // 故意与新包规则不同：旧规则不能误伤其他业务数据。
  write(old, '.backupignore', './data/uploads\n')
  const pkg = await buildPackage({ projectDir: source, appName: path.basename(root) + '-' + name, version: '1.0.0' })
  packages.push(pkg.zipPath)
  fs.mkdirSync(path.join(home, 'uploads'), { recursive: true })
  fs.copyFileSync(pkg.zipPath, path.join(home, 'uploads/bundle.zip'))
  return { dir, old, home, archive: path.join(home, 'backups/app_check.tar.gz') }
}

function run(f, body) {
  const script = path.join(f.dir, 'check.sh')
  fs.writeFileSync(script, `source '${posix(lib)}' deploy --home '${posix(f.home)}' --package bundle.zip
OLD_RELEASE='${posix(f.old)}'
TS=check
docker() {
  if [ "$*" = 'exec database pg_dump -U app app' ]; then printf '数据库逻辑备份\\n'; else echo '不允许修改运行服务' >&2; return 99; fi
}
${body}
`)
  return spawnSync(bash, [posix(script)], { encoding: 'utf8', timeout: 15000 })
}

function entries(f) {
  const r = spawnSync(bash, ['-c', `tar -tzf '${posix(f.archive)}'`], { encoding: 'utf8', timeout: 10000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout.split(/\r?\n/)
}

function assertClean(f) {
  assert(!fs.readdirSync(path.join(f.home, 'backups')).some(n => n.startsWith('.code-backup.')), '备份临时目录应清理')
  assert.equal(fs.readFileSync(path.join(f.old, 'data/postgres/PG_VERSION'), 'utf8'), '原始数据库目录')
  assert.equal(fs.readFileSync(path.join(f.old, 'data/uploads/photo.txt'), 'utf8'), '保留业务文件')
}

async function main() {
  const excluded = await fixture('exclude', '  # 项目规则\r\n\r\n./data/postgres\r\n')
  let result = run(excluded, `BACKUP_DB=1; DB_CONTAINER=database; DB_NAME=app; DB_USER=app
backup_code || exit 1
backup_db || exit 1`)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  let files = entries(excluded)
  assert(!files.some(n => n.startsWith('./data/postgres')), '原始数据库目录应从代码归档排除')
  for (const file of ['./app.js', './.env', './data/uploads/photo.txt']) assert(files.includes(file), '必须保留：' + file)
  assert.equal(fs.readFileSync(path.join(excluded.home, 'backups/db_check.sql'), 'utf8'), '数据库逻辑备份\n')
  if (process.platform !== 'win32') assert.equal(fs.statSync(excluded.archive).mode & 0o777, 0o600, '代码归档权限应为 600')
  assertClean(excluded)

  const full = await fixture('full')
  result = run(full, 'backup_code')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  files = entries(full)
  assert(files.includes('./data/postgres/PG_VERSION'), '未声明排除规则时应完整备份')
  assert(files.includes('./data/uploads/photo.txt'), '不能沿用旧目录的过时排除规则')
  assertClean(full)

  const failed = await fixture('failed', './data/postgres\n')
  result = run(failed, `tar() { printf '不完整归档' > "$2"; echo 'tar: ./app.js: Cannot open: Permission denied' >&2; return 2; }
backup_code
echo '错误：备份失败后仍继续发布'; exit 99`)
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert(result.stdout.includes('Permission denied'), '实际 tar 错误必须进入部署日志')
  assert(!fs.existsSync(failed.archive), '失败归档不能成为正式备份')
  assertClean(failed)

  const corrupt = await fixture('corrupt')
  fs.writeFileSync(path.join(corrupt.home, 'uploads/bundle.zip'), '损坏的发布包')
  result = run(corrupt, 'backup_code')
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert(result.stdout.includes('无法读取发布包'), '规则读取错误应停止发布')
  assert(!fs.existsSync(corrupt.archive))
  assertClean(corrupt)

  result = run(full, 'BACKUP_CODE=0; PACKAGE=missing.zip; backup_code')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  console.log('PASS 真实代码备份：新包规则首次接管、配置/业务文件保留、独立数据库备份、失败详情和清理、未配置时完整备份')
}

main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => {
  for (const file of packages) {
    if (path.dirname(file) === path.join(os.tmpdir(), 'onedeploy') && path.basename(file).startsWith(path.basename(root))) fs.rmSync(file, { force: true })
  }
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-code-backup-')) fs.rmSync(root, { recursive: true, force: true })
})
