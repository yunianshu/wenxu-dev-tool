/** 数据库自动识别及真实 Bash 备份流程；Docker/数据库客户端仅用本地替身，不接生产。 */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const { spawnSync } = require('child_process')
const { stringify } = require('yaml')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-auto-db-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => root } } }
const auto = require('../electron/deploy/auto-deploy')
const posix = (p) => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'

try {
  const recipe = (services) => ({ compose: stringify({ services }) })
  for (const [image, type] of [['postgres:16', 'postgres'], ['docker.io/library/postgres:18', 'postgres'], ['postgres:16@sha256:' + 'a'.repeat(64), 'postgres'], ['mysql:8.4', 'mysql'], ['mariadb:11', 'mysql']]) {
    const result = auto.databaseFor(recipe({ app: { image: 'myapp:1' }, database: { image } }))
    assert.equal(result.enabled, true); assert.equal(result.service, 'database'); assert.equal(result.type, type)
    assert.equal(result.name, ''); assert.equal(result.user, '')
  }
  assert.equal(auto.databaseFor(recipe({ db: { image: 'postgres:16' }, other: { image: 'mysql:8' } })).enabled, false)
  assert.equal(auto.databaseFor(recipe({ db: { image: 'custom-postgres:1' } })).enabled, false)
  assert.equal(auto.databaseFor(recipe({ db: { image: 'postgres:16', build: '.' } })).enabled, false)
  assert.equal(auto.databaseFor(recipe({ api: { image: 'node:22' } })).enabled, false)

  const source = fs.readFileSync(path.resolve(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
  const lib = path.join(root, 'functions.sh')
  fs.writeFileSync(lib, source.slice(0, source.lastIndexOf('case "$CMD" in')))
  fs.mkdirSync(path.join(root, 'bin'))
  for (const command of ['pg_dump', 'mysqldump', 'mariadb-dump']) {
    fs.writeFileSync(path.join(root, 'bin', command), '#!/usr/bin/env bash\n[ "${DUMP_FAIL:-0}" != 1 ] || exit 4\nprintf "dump=%s\\n" "$(basename "$0")"\nprintf "arg=%s\\n" "$@"\n[ "${PGPASSWORD:-${MYSQL_PWD:-}}" = fixture-password ] || exit 5\n', { mode: 0o755 })
  }
  fs.writeFileSync(path.join(root, 'password'), 'fixture-password')
  const script = path.join(root, 'check.sh')
  fs.writeFileSync(script, `source '${posix(lib)}' deploy --home '${posix(root)}/app' --project-name app-test --db-service database --db-type postgres --backup-db
export PATH='${posix(path.join(root, 'bin'))}':"$PATH"
mkdir -p "$RELEASES/old"
docker() {
  if [ "$1" = compose ]; then
    [ "$PWD" = "$RELEASES/old" ] || return 61
    [ "$6" = database ] || return 62
    [ "\${MISSING:-0}" != 1 ] && echo old-database-container
    [ "\${MULTIPLE:-0}" = 1 ] && echo other-container
    return 0
  fi
  [ "$1" = exec ] && [ "$2" = -i ] && [ "$3" = old-database-container ] || return 63
  shift 3
  ( export POSTGRES_USER=project_user POSTGRES_DB=project_db POSTGRES_PASSWORD_FILE='${posix(path.join(root, 'password'))}'
    export MARIADB_DATABASE="\${MYSQL_DB:-project_mysql}" MARIADB_USER=project_mysql_user MARIADB_PASSWORD=fixture-password
    if [ "\${NO_DATABASE:-0}" = 1 ]; then unset MARIADB_DATABASE; fi
    "$@"
  )
}
OLD_RELEASE=""
backup_db || exit 10
[ ! -d "$BACKUPS" ] || exit 11
OLD_RELEASE="$RELEASES/old"
TS=postgres
backup_db || exit 12
grep -q 'arg=--username=project_user' "$BACKUPS/db_postgres.sql" || exit 13
grep -q 'arg=project_db' "$BACKUPS/db_postgres.sql" || exit 14
DB_TYPE=mysql; TS=mysql
backup_db || exit 15
grep -q 'arg=--user=project_mysql_user' "$BACKUPS/db_mysql.sql" || exit 16
grep -q 'arg=project_mysql' "$BACKUPS/db_mysql.sql" || exit 17
TS=missing
if (MISSING=1; backup_db); then exit 18; fi
[ ! -f "$BACKUPS/db_missing.sql" ] || exit 19
TS=multiple
if (MULTIPLE=1; backup_db); then exit 20; fi
TS=no_database
if (NO_DATABASE=1; backup_db); then exit 21; fi
[ ! -f "$BACKUPS/db_no_database.sql" ] || exit 22
TS=failed
if (export DUMP_FAIL=1; backup_db); then exit 23; fi
[ ! -f "$BACKUPS/db_failed.sql" ] || exit 24
echo 'PASS 自动备份：首次跳过、旧版本服务定位、容器内凭据、PG/MySQL、失败保留运行版本'
`)
  const result = spawnSync(bash, [posix(script)], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert(!result.stdout.includes('fixture-password') && !result.stderr.includes('fixture-password'))
  assert(!result.stdout.includes('project_user') && !result.stdout.includes('project_mysql_user'), '数据库配置值不进入操作日志')
  console.log(result.stdout.trim())
  console.log('PASS 数据库方案：唯一明确数据库自动识别，多数据库与未知镜像保留手动配置')
} finally {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-auto-db-')) fs.rmSync(root, { recursive: true, force: true })
}
