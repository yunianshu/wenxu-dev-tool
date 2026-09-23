/**
 * git 代理进程自测（无框架，node scripts/git-client-selftest.cjs 直接运行）
 * 覆盖：工作进程在「调用让出期间」退出时，调用必须立即失败，不能永久悬挂。
 * 背景：call() 里 await ensureChild() 会让出微任务，工作进程恰好在这段窗口退出时，
 * handleExit 已清空 pending 并把 child 置空，随后的投递将无处可去——
 * 若不就地失败，该 Promise 既不 resolve 也不 reject，渲染层会永远停在「正在收集」。
 * 用假的 utilityProcess（不真正 fork 进程）精确构造该时序。
 */
const assert = require('assert')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')

let passed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ✓ ${name}`) })
    .catch((err) => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1 })
}

// ── electron 打桩：utilityProcess.fork 返回可编程的假子进程 ──
const forks = []
class FakeChild extends EventEmitter {
  constructor() {
    super()
    this.posted = []
    this.stdout = null
    this.stderr = null
    this.autoReply = []
  }
  postMessage(message) {
    this.posted.push(message)
    // 与 git-worker.js 的应答协议一致：{ id, ok, result }
    for (const reply of this.autoReply) setImmediate(() => this.emit('message', { id: message.id, ok: true, result: reply }))
  }
  kill() { this.exitCode = 0 }
}
const stubExports = {
  app: { getPath: () => path.join(os.tmpdir(), 'plm-git-client-stub'), getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => false },
  utilityProcess: { fork: () => { const child = new FakeChild(); forks.push(child); return child } },
  webContents: { fromId: () => null },
  ipcMain: { handle() {}, on() {} },
}
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stubExports }

const gitClient = require('../electron/git-client')

const withTimeout = (promise, ms, label) => Promise.race([
  promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: error.message })),
  new Promise((resolve) => setTimeout(() => resolve({ timedOut: true, label }), ms)),
])

async function main() {
  // ── 1. 正常路径：就绪握手 + 应答 ──
  await test('工作进程就绪后调用正常返回', async () => {
    const pending = gitClient.scanReposCached(['C:/x'], [])
    const child = forks[0]
    child.autoReply = [['C:/x/repo']]
    child.emit('spawn')
    child.emit('message', { event: 'ready' })
    const result = await withTimeout(pending, 3000, '正常调用')
    assert.strictEqual(result.timedOut, undefined, '正常调用不应超时')
    assert.strictEqual(result.ok, true, `应成功（实际 ${result.error}）`)
    assert.deepStrictEqual(result.value, ['C:/x/repo'])
    assert.deepStrictEqual(child.posted.map((m) => m.cmd), ['scan'])
  })

  // ── 2. 让出期间退出：必须立即失败 ──
  // 工作进程仍活着（spawnTask 已就绪），调用挂在 await ensureChild() 的微任务上；
  // 此时进程退出会把 child 清空，恢复执行后的投递无处可去
  await test('工作进程在调用让出期间退出 → 立即失败而非永久悬挂', async () => {
    const child = forks[forks.length - 1]
    const pending = gitClient.collectCommits(['C:/x/repo'], {})
    child.emit('exit', 1) // 同步触发：调用恢复时 child 已为 null
    const result = await withTimeout(pending, 4000, '让出期间退出的调用')
    assert.strictEqual(result.timedOut, undefined, '调用悬挂了：既不 resolve 也不 reject')
    assert.strictEqual(result.ok, false, '应拒绝并给出原因')
    assert.match(result.error, /git 工作进程/, `错误信息应指向工作进程（实际 ${result.error}）`)
  })

  // ── 3. 退出后再次调用：能重新拉起工作进程 ──
  await test('崩溃后重新调用可拉起新的工作进程', async () => {
    const before = forks.length
    const pending = gitClient.getRepoInfo('C:/x/repo')
    assert.strictEqual(forks.length, before + 1, '应重新 fork 一个工作进程')
    const child = forks[forks.length - 1]
    child.autoReply = [{ remote: 'origin', branch: 'main', lastCommit: 'init' }]
    child.emit('spawn')
    child.emit('message', { event: 'ready' })
    const result = await withTimeout(pending, 3000, '崩溃后重试')
    assert.strictEqual(result.ok, true, `应成功（实际 ${result.error || '超时'}）`)
    assert.strictEqual(result.value.branch, 'main')
  })

  // ── 4. 在途调用随进程退出统一失败（原有语义保持不变） ──
  await test('在途调用在工作进程退出时统一失败', async () => {
    const child = forks[forks.length - 1]
    child.posted.length = 0
    const pending = gitClient.scanReposCached(['C:/y'], [])
    child.autoReply = [] // 不回包，保持「在途」
    await new Promise((resolve) => setImmediate(resolve)) // 让 post 真正发出
    child.emit('spawn')
    child.emit('message', { event: 'ready' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(child.posted.length, 1, '调用应已投递')
    child.emit('exit', 2)
    const result = await withTimeout(pending, 3000, '在途调用')
    assert.strictEqual(result.ok, false, '应拒绝')
    assert.match(result.error, /已退出（code=2）/, `应带上退出码（实际 ${result.error}）`)
  })

  console.log(`\n git 代理自测通过（${passed} 组断言）`)
}

main().catch((err) => { console.error('自测失败：', err); process.exitCode = 1 })
