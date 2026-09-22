/** 数据库管理编排：真实 Bash/临时文件，Docker、sudo 和 PostgreSQL 工具均为替身。 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { spawnSync } = require('child_process')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-db-restore-'))
const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash'
const shellPath = (value) => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
const quote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => false } } }
const automatic = require('../electron/deploy/auto-deploy')
const home = path.join(root, 'remote')
const backupName = 'db_20260922.sql'
const backupDir = path.join(home, 'backups')
const bin = path.join(root, 'bin')
const trace = path.join(root, 'commands.bin')
const passwordFile = path.join(root, 'password')
const password = '仅用于隔离测试的密码'
fs.mkdirSync(backupDir, { recursive: true })
fs.mkdirSync(bin)
fs.writeFileSync(path.join(backupDir, backupName), '-- 隔离测试 SQL；替身不执行数据库操作\n')
fs.writeFileSync(passwordFile, password)
fs.writeFileSync(path.join(bin, 'pg_dump'), '#!/bin/sh\n[ "${PGPASSWORD:-}" = "$EXPECTED_TEST_PASSWORD" ] || exit 21\n[ "${FAIL_DUMP:-}" != "1" ] || exit 22\nprintf "%s\\n" "-- 模拟保底备份"\n', { mode: 0o755 })
fs.writeFileSync(path.join(bin, 'psql'), '#!/bin/sh\n[ "${PGPASSWORD:-}" = "$EXPECTED_TEST_PASSWORD" ] || exit 21\nprintf "%s\\0" __PSQL__ "$@" __END__ >> "$MOCK_TRACE"\ncat >/dev/null\n', { mode: 0o755 })
const id = 'a'.repeat(64)
let project, commands, closed, connections, logRows, recordRows, ids, env
function reset() {
  commands = []; closed = 0; connections = 0; logRows = []; recordRows = []; ids = id
  fs.writeFileSync(trace, '')
  env = { POSTGRES_USER: '', POSTGRES_DB: '', POSTGRES_USER_FILE: '', POSTGRES_DB_FILE: '', POSTGRES_PASSWORD: '', POSTGRES_PASSWORD_FILE: shellPath(passwordFile), PGPASSWORD: '', FAIL_DUMP: '' }
  project = { id: 'fixture-project', name: '隔离项目', deployMode: 'auto', productionTargetId: 'prod', targets: [{ id: 'prod', name: '正式环境', server: { host: 'example.invalid', port: 22 }, remotePath: shellPath(home), autoSudo: true, db: { strategy: 'auto' }, autoDb: { enabled: true, type: 'postgres', service: 'db', name: '', user: '' } }] }
}
const wrapper = [
  `export PATH=${quote(shellPath(bin))}:"$PATH"`,
  'sudo() { if [ "$1" = "-n" ]; then shift; fi; "$@"; }',
  'docker() { case "$1" in ps) printf "%s\\n" "$MOCK_DB_IDS";; exec) shift; if [ "$1" = "-i" ]; then shift; fi; shift; "$@";; inspect) printf "fixture-manual\\n";; restart) printf "模拟重启完成\\n";; *) return 98;; esac; }',
  'export -f sudo docker',
].join('\n')
const ssh = {
  connect: async () => { connections++; return {} }, close: (conn) => { if (conn) closed++ },
  remoteJoin: (...parts) => path.posix.join(...parts),
  exec: async (_conn, command, onLine) => {
    commands.push(command)
    const result = spawnSync(bash, ['-c', `${wrapper}\n${command}`], { encoding: 'utf8', timeout: 10000, windowsHide: true,
      env: { ...process.env, ...env, MOCK_DB_IDS: ids, MOCK_TRACE: shellPath(trace), EXPECTED_TEST_PASSWORD: password } })
    if (result.error) throw result.error
    if (result.stdout && onLine) onLine(result.stdout, 'stdout')
    if (result.stderr && onLine) onLine(result.stderr, 'stderr')
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  },
}
const filename = path.resolve(__dirname, '../electron/deploy/deploy-service.js')
const mod = new Module(filename, module)
mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename))
mod.require = (name) => {
  if (name === './ssh-service') return ssh
  if (name === './deploy-projects') return { list: () => [project], getCredentials: () => ({}) }
  if (name === './history') return { writeLog: (_id, text) => { logRows.push(text); return '隔离日志' }, add: (record) => recordRows.push(record) }
  return Module.prototype.require.call(mod, name)
}
mod._compile(fs.readFileSync(filename, 'utf8'), filename)
const service = mod.exports
const restore = () => service.restoreDbBackup(project.id, 'prod', backupName)
const psqlArgs = () => fs.readFileSync(trace, 'utf8').split('__PSQL__\0').slice(1).map((row) => row.split('\0').filter((value) => value && value !== '__END__'))

async function main() {
  reset()
  const mysql = project.targets[0]
  mysql.autoDb.type = 'mysql'
  const listed = await service.listDbBackups(project.id, 'prod')
  assert(listed.backups.some((row) => row.fileName === backupName), 'MySQL 也可查看备份')
  assert.equal(closed, connections)
  await assert.rejects(restore, /MySQL.*仅支持 PostgreSQL/)
  assert.equal(closed, connections)
  assert.equal(service.isBusy(), false)
  assert(!commands.some((command) => command.includes('docker exec')))
  console.log('  ✓ MySQL 备份可列出，恢复明确拒绝并释放 SSH/互斥')

  reset()
  const result = await restore()
  assert.equal(result.status, 'success', result.message)
  const label = automatic.identity(project, 'prod')
  assert(commands.some((command) => command.includes(`com.docker.compose.project=${label}`) && command.includes('com.docker.compose.service=db')))
  assert(commands.some((command) => command.includes('sudo -n docker')))
  assert(commands.some((command) => command.includes('sudo -n tee')))
  assert(commands.some((command) => command.includes('sudo -n cat')))
  const args = psqlArgs()
  assert.equal(args.length, 4)
  assert(args.slice(0, 3).every((row) => row[row.indexOf('-d') + 1] === 'template1'), '恢复默认 postgres 库时不能连接待删除库')
  assert(args.some((row) => row.includes('DROP DATABASE "postgres" WITH (FORCE);')))
  assert.equal(closed, connections)
  assert(!JSON.stringify({ commands, logRows, recordRows }).includes(password), '密码不得离开容器命令的环境或进入日志')
  console.log('  ✓ 自动 PostgreSQL 按项目标签定位，默认值、容器内密码文件和 sudo 文件权限贯通')

  reset()
  const user = 'owner-"role'
  const name = "order-'\"data"
  fs.writeFileSync(path.join(root, 'user'), user)
  fs.writeFileSync(path.join(root, 'database'), name)
  env.POSTGRES_USER_FILE = shellPath(path.join(root, 'user'))
  env.POSTGRES_DB_FILE = shellPath(path.join(root, 'database'))
  const custom = await restore()
  assert.equal(custom.status, 'success', custom.message)
  const customArgs = psqlArgs()
  assert(customArgs.every((row) => row[row.indexOf('-U') + 1] === user))
  assert(customArgs.some((row) => row.includes(`DROP DATABASE "${name.replace(/"/g, '""')}" WITH (FORCE);`)))
  assert(customArgs.some((row) => row.includes(`CREATE DATABASE "${name.replace(/"/g, '""')}" OWNER "${user.replace(/"/g, '""')}";`)))
  assert(customArgs[0].find((value) => value.includes('pg_terminate_backend')).includes("datname=E'order-''\"data'"))
  console.log('  ✓ 库名/用户从 *_FILE 读取，Shell 参数与 SQL 标识符的特殊字符安全往返')

  reset()
  project.targets[0].db = { strategy: 'manual', enabled: true, type: 'postgres', container: 'manual-db', name: 'manual-data', user: 'manual-role' }
  const manual = await restore()
  assert.equal(manual.status, 'success', manual.message)
  assert(psqlArgs().some((row) => row.includes('DROP DATABASE "manual-data" WITH (FORCE);')))
  assert(!commands.some((command) => command.includes('com.docker.compose.service=')))
  console.log('  ✓ 手动配置保留兼容，带连字符的数据库名可正确恢复')

  for (const mode of ['off', 'invalid', 'ambiguous', 'guard-failure']) {
    reset()
    if (mode === 'off') project.targets[0].db.strategy = 'off'
    if (mode === 'invalid') project.targets[0].autoDb.service = ''
    if (mode === 'ambiguous') ids += `\n${'b'.repeat(64)}`
    if (mode === 'guard-failure') env.FAIL_DUMP = '1'
    if (mode === 'guard-failure') {
      const failed = await restore()
      assert.equal(failed.status, 'failed')
      assert.match(failed.message, /保底备份失败/)
    } else await assert.rejects(restore)
    assert.equal(closed, connections, `${mode} 失败必须释放连接`)
    assert.equal(service.isBusy(), false)
    assert.equal(psqlArgs().length, 0, `${mode} 失败不得执行破坏性 SQL`)
  }
  reset()
  project.targets[0].db.strategy = 'off'
  await assert.rejects(() => service.listDbBackups(project.id, 'prod'))
  assert.equal(closed, connections)
  console.log('  ✓ 禁用/配置无效/多数据库副本/保底失败均无恢复写入，连接及锁完整释放')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  const resolved = path.resolve(root)
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('deploy-db-restore-'))
  fs.rmSync(resolved, { recursive: true, force: true })
})
