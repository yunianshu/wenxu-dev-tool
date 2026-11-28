/** 部署目录门禁：服务器上的部署目录建不出来（环境选成了别的服务器而项目地址还是原服务器的、目录不属于
 *  登录账号）时，在上传部署脚本前中止并说明卡在哪一级目录，而不是拖到上传时报一句 No such file
 *  （PlmInsight 1.2.62：默认环境被换到另一台服务器，/home/hprt 归 root，发布只剩「No such file」）。 */
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto')
const { spawnSync } = require('child_process')
const { Writable } = require('stream')
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'deploy-remote-dir-'))
const posix = (p) => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {
  app: { getPath: () => path.join(root, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false },
} }
const projects = require('../electron/deploy/deploy-projects')
const service = require('../electron/deploy/deploy-service')

const ssh = require('../electron/deploy/ssh-service')
const remote = new Map()
let probeAnswer = null // 服务器对目录探测的回报；null = 把探测命令交给真实 bash 执行
let scriptRuns = 0
ssh.connect = async () => ({ sftp: (cb) => cb(null, { end() {}, createWriteStream(file, options) {
  assert.equal(options.mode, 0o600)
  const chunks = []
  return new Writable({ write(chunk, _, done) { chunks.push(chunk); done() }, final(done) { remote.set(file, Buffer.concat(chunks)); done() } })
} }) })
ssh.close = () => {}
ssh.mkdirp = async () => {}
ssh.upload = async (_, local, target) => { remote.set(target, fs.readFileSync(local)) }
ssh.exec = async (_, command, onLine) => {
  if (command.includes('__DIR_BAD__')) {
    return { code: 0, stdout: probeAnswer === null ? spawnSync(bash, ['-c', command], { encoding: 'utf8' }).stdout : probeAnswer }
  }
  if (command.startsWith('sha256sum')) {
    const file = command.match(/^sha256sum '([^']+)'/)[1]
    assert(remote.has(file), `校验的文件必须已上传: ${file}`)
    return { code: 0, stdout: crypto.createHash('sha256').update(remote.get(file)).digest('hex') }
  }
  if (command.includes('/deploy.sh') && command.startsWith('bash ')) {
    scriptRuns += 1
    const output = '__STAGE__:build\n__STAGE__:start\n__STAGE__:health\n__DEPLOY_OK__:1.0.0\n'
    onLine?.(output)
    return { code: 0, stdout: output }
  }
  return { code: 0, stdout: '', stderr: '' }
}

function seedProject(name, { remotePath, host = 'app.example.invalid', username = 'root' }) {
  const localDir = path.join(root, name)
  fs.mkdirSync(localDir, { recursive: true })
  fs.writeFileSync(path.join(localDir, 'docker-compose.yml'), 'services:\n  app:\n    image: demo:latest\n    build: .\n')
  fs.writeFileSync(path.join(localDir, 'package.json'), `${JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2)}\n`)
  const project = projects.defaultProject()
  project.configMode = 'manual'
  project.deployMode = 'docker'
  project.name = name
  project.localPath = localDir
  project.version = { strategy: 'manual', manual: '1.0.0' }
  Object.assign(project.targets[0], {
    server: { host, port: 22, username, authType: 'password', keyPath: '', secret: '', passphrase: '' },
    remotePath,
    health: { strategy: 'manual', enabled: false, url: '', timeout: 90, interval: 3 },
    db: { strategy: 'manual', enabled: false, type: 'postgres', container: '', name: '', user: '' },
  })
  assert(projects.save(project).ok)
  return project.id
}
const targetOf = (id) => projects.list().find((p) => p.id === id).targets[0]
const guidance = '；请核对该环境选择的部署服务器与项目地址'

;(async () => {
  // ── 服务器回报目录建不出来（默认环境被换到另一台服务器，项目地址还是原服务器的）→ 上传部署脚本前中止 ──
  const home = '/home/hprt/docker/openclaw-wgl/plminsight'
  const a = seedProject('dir-mismatch', { remotePath: home, host: 'aiproject.example.invalid', username: 'wanggl' })
  probeAnswer = `__DIR_BAD__ ${home}/uploads|/home/hprt/docker|root|rw\n__DIR_BAD__ ${home}/deployer|/home/hprt/docker|root|rw\n`
  let record = await service.run(a, targetOf(a).id)
  assert.equal(record.status, 'failed')
  assert.equal(record.stages.upload.status, 'failed', '目录未就位即失败，不进入服务器端部署')
  assert.equal(record.message, `部署目录不可用：wanggl@aiproject.example.invalid 无法创建 ${home}/uploads（上级目录 /home/hprt/docker 归属 root，当前账号不可写）${guidance}`)
  assert.equal(scriptRuns, 0, '部署脚本不得在服务器上执行')
  assert.equal(remote.size, 0, '部署脚本与发布包都不得上传')

  probeAnswer = `__DIR_BAD__ ${home}/deployer|/home/hprt/docker|root|rw\n`
  record = await service.rollback(a, '1.0.0', targetOf(a).id)
  assert.equal(record.status, 'failed')
  assert.equal(record.message, `部署目录不可用：wanggl@aiproject.example.invalid 无法创建 ${home}/deployer（上级目录 /home/hprt/docker 归属 root，当前账号不可写）${guidance}`)
  assert.equal(remote.size, 0, '回滚同样不上传部署脚本')

  // 目录已存在但登录账号不可写 / 上级可写却没建成：如实区分，不笼统说「不可写」
  const b = seedProject('dir-readonly', { remotePath: '/opt/apps/b' })
  probeAnswer = '__DIR_BAD__ /opt/apps/b/deployer|/opt/apps/b/deployer|hprt|rw\n'
  record = await service.run(b, targetOf(b).id)
  assert.equal(record.status, 'failed')
  assert.equal(record.message, `部署目录不可用：root@app.example.invalid 对 /opt/apps/b/deployer 没有写权限（归属 hprt）${guidance}`)
  const c = seedProject('dir-not-made', { remotePath: '/opt/apps/c' })
  probeAnswer = '__DIR_BAD__ /opt/apps/c/uploads|/opt/apps|root|w\n'
  record = await service.run(c, targetOf(c).id)
  assert.equal(record.status, 'failed')
  assert.equal(record.message, `部署目录不可用：root@app.example.invalid 无法创建 /opt/apps/c/uploads（上级目录 /opt/apps 可写，归属 root，但目录未能创建）${guidance}`)
  assert.equal(scriptRuns, 0)

  // ── 探测命令交给真实 bash：可用目录不回报、发布照常；建不出来时指出最近的现存上级 ──
  probeAnswer = null
  const okHome = path.join(root, 'ok-home')
  fs.mkdirSync(path.join(okHome, 'uploads'), { recursive: true })
  fs.mkdirSync(path.join(okHome, 'deployer'), { recursive: true })
  const d = seedProject('dir-ok', { remotePath: posix(okHome) })
  record = await service.run(d, targetOf(d).id)
  assert.equal(record.status, 'success', record.message)
  assert(remote.has(`${posix(okHome)}/deployer/deploy.sh`), '目录可用时部署脚本照常上传')
  assert.equal(scriptRuns, 1)

  const parent = path.join(root, 'parent')
  fs.mkdirSync(parent)
  const absentHome = `${posix(parent)}/absent-home`
  const e = seedProject('dir-absent', { remotePath: absentHome })
  record = await service.run(e, targetOf(e).id)
  assert.equal(record.status, 'failed')
  assert(record.message.startsWith(`部署目录不可用：root@app.example.invalid 无法创建 ${absentHome}/uploads（上级目录 ${posix(parent)} `), record.message)
  assert(record.message.endsWith(guidance), record.message)
  assert.equal(scriptRuns, 1, '目录建不出来时不再执行部署脚本')

  console.log('PASS 部署目录门禁：目录建不出来或不可写时在上传部署脚本前中止并指出账号、目录与卡住的上级；可用时发布照常；回滚同样受门禁保护')
})().catch((e) => { console.error(e.stack); process.exitCode = 1 }).finally(() => {
  // os.tmpdir() 可能是 8.3 短名（ADMINI~1），与 realpath 出来的长路径字面不相等，比对要统一成长路径
  if (path.dirname(root) === fs.realpathSync.native(os.tmpdir()) && path.basename(root).startsWith('deploy-remote-dir-')) fs.rmSync(root, { recursive: true, force: true })
})
