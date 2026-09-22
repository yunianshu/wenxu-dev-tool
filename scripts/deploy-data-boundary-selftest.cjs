/** 真实 ZIP 与 Bash 验证同服务器项目数据隔离，不连接远端或运行 Docker。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const packager = require('../electron/deploy/packager')
const dataSync = require('../electron/deploy/data-sync')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-data-boundary-'))
const posix = (value) => path.resolve(value).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, letter) => '/' + letter.toLowerCase())
const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const linkDirectory = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
function execute(command) { return spawnSync(bash, ['-c', command], { encoding: 'utf8', timeout: 15000 }) }
function success(result) { assert.strictEqual(result.status, 0, result.stdout + result.stderr) }
function rejected(result) { assert.notStrictEqual(result.status, 0, '链接路径必须在写入前被拒绝'); assert.match(result.stderr, /数据同步目录检查失败/) }
const createdPackages = []
async function main() {
  const localA = path.join(root, 'local-a'), localB = path.join(root, 'local-b')
  for (const [directory, owner] of [[localA, 'A'], [localB, 'B']]) {
    fs.mkdirSync(path.join(directory, 'data', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'data', 'payload.txt'), owner)
    fs.writeFileSync(path.join(directory, 'data', 'nested', 'value.txt'), owner)
  }
  for (const remoteDir of ['/srv/project-b/data', '../b', 'a/../b', 'C:/outside', '\\server\\data', './data']) {
    assert.strictEqual(dataSync.validateDataSync({ localPath: localA }, { localDir: 'data', remoteDir }).ok, false)
  }
  await assert.rejects(() => packager.buildDataPackage({ projectDir: localA, dataDir: '../local-b/data' }), /必须在项目目录内/)
  linkDirectory(path.join(localB, 'data'), path.join(localA, 'borrowed'))
  await assert.rejects(() => packager.buildDataPackage({ projectDir: localA, dataDir: 'borrowed' }), /链接|联接/)
  linkDirectory(path.join(localB, 'data'), path.join(localA, 'data', 'borrowed'))
  await assert.rejects(() => packager.buildDataPackage({ projectDir: localA, dataDir: 'data' }), /链接|联接/)
  fs.unlinkSync(path.join(localA, 'data', 'borrowed'))
  console.log('  ✓ 本地越界、根目录联接、子目录联接和远端绝对路径全部被拒绝')

  const serverA = path.join(root, 'server', 'project-a'), serverB = path.join(root, 'server', 'project-b')
  const zipFor = async (local, remote) => {
    const pack = await packager.buildDataPackage({ projectDir: local, dataDir: 'data', appName: 'app', version: '1.0.0' })
    createdPackages.push(pack.zipPath)
    fs.mkdirSync(path.join(remote, 'uploads'), { recursive: true })
    const destination = path.join(remote, 'uploads', pack.fileName)
    fs.copyFileSync(pack.zipPath, destination)
    return destination
  }
  const zipA = await zipFor(localA, serverA), zipB = await zipFor(localB, serverB)
  for (const [remote, zip] of [[serverA, zipA], [serverB, zipB]]) {
    success(execute(dataSync.buildDataSyncPreflightCommand(posix(remote), 'shared/data')))
    success(execute(dataSync.buildDataSyncCommand(posix(zip), posix(path.join(remote, 'shared/data')), posix(remote))))
  }
  assert.strictEqual(fs.readFileSync(path.join(serverA, 'shared/data/payload.txt'), 'utf8'), 'A')
  assert.strictEqual(fs.readFileSync(path.join(serverB, 'shared/data/payload.txt'), 'utf8'), 'B')
  assert.throws(() => dataSync.buildDataSyncCommand(posix(zipA), posix(path.join(serverB, 'shared/data')), posix(serverA)), /当前项目安装目录/)
  console.log('  ✓ 同一服务器目录中的 A/B 项目各自真实解压，跨项目目标直接拒绝')

  const guardedZip = await zipFor(localA, serverA)
  const nested = path.join(serverA, 'shared/data/nested')
  fs.renameSync(nested, path.join(serverA, 'shared/data/nested-original'))
  linkDirectory(path.join(serverB, 'shared/data/nested'), nested)
  rejected(execute(dataSync.buildDataSyncCommand(posix(guardedZip), posix(path.join(serverA, 'shared/data')), posix(serverA))))
  assert.strictEqual(fs.readFileSync(path.join(serverB, 'shared/data/nested/value.txt'), 'utf8'), 'B')
  fs.unlinkSync(nested)
  const targetFile = path.join(serverA, 'shared/data/payload.txt')
  fs.unlinkSync(targetFile)
  fs.symlinkSync(path.join(serverB, 'shared/data/payload.txt'), targetFile, 'file')
  rejected(execute(dataSync.buildDataSyncPreflightCommand(posix(serverA), 'shared/data')))
  assert.strictEqual(fs.readFileSync(path.join(serverB, 'shared/data/payload.txt'), 'utf8'), 'B')
  fs.unlinkSync(targetFile)
  fs.linkSync(path.join(serverB, 'shared/data/payload.txt'), targetFile)
  rejected(execute(dataSync.buildDataSyncPreflightCommand(posix(serverA), 'shared/data')))
  fs.unlinkSync(targetFile)
  console.log('  ✓ 目标内已有子目录联接、文件符号链接和硬链接均不能改写 B 项目')

  const alias = path.join(root, 'server', 'project-alias')
  fs.mkdirSync(alias)
  linkDirectory(path.join(serverB, 'uploads'), path.join(alias, 'uploads'))
  rejected(execute(dataSync.buildDataSyncPreflightCommand(posix(alias), 'shared/data')))
  const innerAlias = path.join(serverA, 'shared/data/inner-link')
  linkDirectory(path.join(serverA, 'shared/data/nested-original'), innerAlias)
  rejected(execute(dataSync.buildDataSyncPreflightCommand(posix(serverA), 'shared/data')))
  console.log('  ✓ 上传目录越界链接在上传前拒绝；同项目内部链接也明确拒绝')
  console.log('\n数据目录隔离回归通过（真实 ZIP/Bash；未连接正式服务器）')
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const zip of createdPackages) if (path.dirname(zip) === path.join(os.tmpdir(), 'onedeploy')) fs.unlinkSync(zip)
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-data-boundary-')) fs.rmSync(root, { recursive: true, force: true })
})
