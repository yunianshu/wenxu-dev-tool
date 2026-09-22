/** 扩展开关与 Harness 生命周期回归；只写临时目录，进程/端口均为替身。 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const extensions = require('../electron/extensions-service')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lifecycle-selftest-'))
  try {
    extensions.setRoot(root)
    const config = path.join(root, '.codex', 'config.toml')
    fs.mkdirSync(path.dirname(config), { recursive: true })
    const headers = ['  [plugins."demo@market"]', '[ plugins . "demo@market" ] # 保留注释', "[plugins.'demo@market']"]
    for (const header of headers) {
      fs.writeFileSync(config, `model = "测试模型"\r\n${header}\r\n  enabled = true # 原状态\r\n[unrelated]\r\nvalue = 42\r\n`)
      assert.equal(extensions.listAll().platforms.find((p) => p.id === 'codex').plugins.length, 1)
      extensions.togglePlugin('codex', 'demo@market', false)
      const result = fs.readFileSync(config, 'utf8')
      assert.equal(result.match(/demo@market/g).length, 1, '不得追加重复插件表')
      assert(result.includes(header), '保留原表头及注释')
      assert(result.includes('[unrelated]\r\nvalue = 42'), '保留其它表与换行格式')
      assert.equal(extensions.parseCodexPluginSections(result)['demo@market'], false)
      extensions.togglePlugin('codex', 'demo@market', true)
      assert.equal(extensions.parseCodexPluginSections(fs.readFileSync(config, 'utf8'))['demo@market'], true)
    }
    extensions.togglePlugin('codex', 'new@market', false)
    assert.equal(extensions.parseCodexPluginSections(fs.readFileSync(config, 'utf8'))['new@market'], false)
    console.log('  ✓ 插件表头空白、单双引号与注释可逆更新，不产生重复表')

    const runtime = path.join(root, 'runtime')
    const entry = path.join(runtime, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, '')
    const procs = []
    let autoReady = true
    const ready = (proc) => proc.stdout.emit('data', 'dsh web: http://127.0.0.1:3080/?token=测试占位\n')
    const fakeSpawn = () => {
      const proc = new EventEmitter()
      Object.assign(proc, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 900000 + procs.length, exitCode: null })
      procs.push(proc)
      if (autoReady) queueMicrotask(() => ready(proc))
      return proc
    }
    const sandbox = {
      module: { exports: {} }, process: { ...process, env: { ...process.env, DSH_HOME: path.join(root, 'home'), DSH_RUNTIME_DIR: runtime }, kill: () => { throw new Error('替身进程不存在') } },
      console, setTimeout, clearTimeout, URL,
      require: (name) => {
        if (name === 'child_process') return { spawn: fakeSpawn, spawnSync: () => ({ stdout: '' }) }
        if (name === 'net') return { createServer: () => { const server = new EventEmitter(); server.close = () => {}; server.listen = () => queueMicrotask(() => server.emit('listening')); return server } }
        if (name === './harness-defaults') return { ensureDefaultSettings: () => ({ injected: [], reason: 'already-injected' }) }
        if (name === './harness-runtime') return { resolveRuntime: () => ({ dir: runtime }), ensureBundledRuntime: async () => {}, currentRuntimeVersion: () => '', hasShippedRuntime: () => true }
        if (name === 'electron') return { app: { getPath: () => root } }
        return require(name)
      },
    }
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/harness-service.js'), 'utf8'), sandbox)
    const service = sandbox.module.exports
    await service.start()
    await service.restart()
    const pid = service.status().pid
    procs[0].emit('exit', 0, null)
    procs[0].stderr.emit('data', '旧进程迟到输出')
    procs[0].emit('error', new Error('旧进程迟到错误'))
    assert.equal(service.status().status, 'running')
    assert.equal(service.status().pid, pid)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'harness.json'), 'utf8')).pid, pid)
    assert(!service.status().detail.includes('旧进程'))
    console.log('  ✓ 旧实例迟到退出、输出和错误不覆盖新状态或删除新 PID 记录')

    autoReady = false
    const pendingOld = service.restart()
    await new Promise(setImmediate)
    const oldProc = procs.at(-1)
    const pendingNew = service.restart()
    await new Promise(setImmediate)
    const newProc = procs.at(-1)
    const count = procs.length
    oldProc.emit('exit', 0, null)
    await pendingOld
    assert.equal(service.status().status, 'starting', '旧启动收尾不应把新启动改为 stopped')
    const duplicate = service.start()
    await new Promise(setImmediate)
    assert.equal(procs.length, count, '旧 Promise 收尾不应清除新启动锁')
    ready(newProc)
    await Promise.all([pendingNew, duplicate])
    assert.equal(service.status().status, 'running')
    newProc.emit('exit', 1, null)
    assert.equal(service.status().status, 'error', '当前实例真正退出仍应报错')
    assert(!fs.existsSync(path.join(root, 'harness.json')))
    service.stop()
    console.log('  ✓ 重叠启动保持幂等，当前实例退出仍正确更新状态')
  } finally {
    const resolved = path.resolve(root)
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('ai-lifecycle-selftest-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
