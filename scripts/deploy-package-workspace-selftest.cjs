/** 真实子进程回归：构建副本选址、Java HTTP 初始化、中文日志与受限清理。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const workspace = require('../electron/deploy/build-workspace')

const testRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-workspace-test-')))
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => path.join(testRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } },
}
const service = require('../electron/deploy/deploy-service')
const logs = []
service.setEmitter((channel, payload) => { if (channel === 'deploy:log') logs.push(payload.text) })
let build

;(async () => {
  build = workspace.createBuildWorkspace()
  if (process.platform === 'win32') {
    assert.equal(build.root, fs.realpathSync(path.join(os.homedir(), '.plm-build')))
    assert.ok(!build.dir.toLowerCase().includes(`${path.sep}appdata${path.sep}`), 'Windows 构建副本必须离开 AppData')
  } else {
    assert.equal(build.root, fs.realpathSync(os.tmpdir()))
  }

  const source = path.join(testRoot, 'source')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'VERSION'), '0.2.2\n')
  await workspace.copyProject(source, build.dir)
  fs.writeFileSync(path.join(build.dir, 'VERSION'), '0.2.3\n')
  assert.equal(fs.readFileSync(path.join(source, 'VERSION'), 'utf8'), '0.2.2\n', '构建副本不污染源项目')

  // 沿用 Vantage 的套接字目录配置，在实际的新工作区内启动 HTTP 服务。
  const java = spawnSync('java', ['-version'], { windowsHide: true })
  if (java.status === 0) {
    const target = path.join(build.dir, 'server', 'target')
    fs.mkdirSync(target, { recursive: true })
    const probe = path.join(build.dir, 'LoopbackProbe.java')
    fs.writeFileSync(probe, `import java.net.*;
import com.sun.net.httpserver.HttpServer;
class LoopbackProbe {
  public static void main(String[] args) throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.start();
    System.out.println("HTTP_OK");
    server.stop(0);
  }
}`)
    const result = spawnSync('java', [`-Djdk.net.unixdomain.tmpdir=${target}`, probe], {
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    })
    assert.equal(result.status, 0, `新工作区 Java HTTP 初始化失败：${result.stderr}`)
    assert.ok(result.stdout.includes('HTTP_OK'))
    console.log('  ✓ 实际构建副本的 Java HTTP 服务初始化通过')
  } else {
    console.log('  跳过 Java HTTP 回归：本机未安装 Java，其余断言继续执行')
  }

  const fixture = path.join(build.dir, 'output.cjs')
  fs.writeFileSync(fixture, `
process.stdout.write(Buffer.from([0xe4]));
process.stderr.write(Buffer.from(process.platform === 'win32' ? [0xd6] : [0xe4]));
setTimeout(() => {
  process.stdout.write(Buffer.from([0xb8,0xad,0xe6,0x96,0x87,0xf0,0x9f,0x99,0x82,0x0d,0x0a]));
  if (process.platform === 'win32') process.stdout.write(Buffer.from([0x47,0x42,0x4b,0x3a,0x20,0xd6,0xd0,0xce,0xc4,0x0a]));
  process.stderr.write(Buffer.from(process.platform === 'win32' ? [0xd0,0xce,0xc4] : [0xb8,0xad,0xe6,0x96,0x87]));
}, 50);
`)
  const project = { localPath: build.dir, scriptMode: { packageCommand: `"${process.execPath}" output.cjs` } }
  assert.deepEqual(await service.runPackageCommand(project, source), { ok: true })
  assert.ok(logs.includes('[打包] 中文🙂'), 'UTF-8 字符跨数据块必须完整，含 CRLF')
  assert.ok(logs.includes('[打包] 中文'), 'stderr 尾行无换行也必须完整解码')
  if (process.platform === 'win32') assert.ok(logs.includes('[打包] GBK: 中文'), '同一输出流的 GBK 中文必须兼容')
  assert.ok(!logs.some((line) => line.includes('\ufffd')), '日志不应出现替换字符')
  console.log('  ✓ 真实打包进程的 UTF-8/GBK、分块与尾行日志通过')

  fs.writeFileSync(fixture, 'process.exit(7)')
  const failed = await service.runPackageCommand(project, source)
  assert.equal(failed.ok, false)
  assert.ok(failed.problem.includes('退出码 7'), '失败命令必须保留实际退出码')

  const outside = path.join(testRoot, 'onedeploy-build-abcdef')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep'), '保留')
  assert.throws(() => workspace.removeBuildWorkspace({ root: build.root, dir: outside }), /越界/)
  assert.ok(fs.existsSync(path.join(outside, 'keep')), '越界目录必须保留')
  const link = path.join(build.root, 'onedeploy-build-abcdef')
  if (!fs.existsSync(link)) {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      assert.throws(() => workspace.removeBuildWorkspace({ root: build.root, dir: link }), /符号链接/)
      assert.ok(fs.existsSync(path.join(outside, 'keep')), '链接目标必须保留')
    } finally { fs.unlinkSync(link) }
  }
  workspace.removeBuildWorkspace(build)
  assert.ok(!fs.existsSync(build.dir), '运行结束必须清理本次副本')
  workspace.removeBuildWorkspace(build)
  console.log('  ✓ 副本隔离、失败退出码及清理边界通过')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  workspace.removeBuildWorkspace(build)
  assert.equal(path.dirname(testRoot), fs.realpathSync(os.tmpdir()))
  assert.ok(path.basename(testRoot).startsWith('pkg-workspace-test-'))
  fs.rmSync(testRoot, { recursive: true, force: true })
})
