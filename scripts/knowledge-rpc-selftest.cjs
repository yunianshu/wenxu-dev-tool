/** 隔离真实 Node 后台，通过 Electron preload 与 Tauri bridge 验证知识 RPC。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { transformSync } = require('esbuild')

const projectRoot = path.resolve(__dirname, '..')
const methods = ['knowledgeList', 'knowledgeSave', 'knowledgeTrash', 'knowledgeRestore', 'knowledgeImport', 'knowledgeExport']
const channels = ['knowledge:list', 'knowledge:save', 'knowledge:trash', 'knowledge:restore', 'knowledge:import', 'knowledge:export']

async function startBackend(userData) {
  // 当前主进程读 PROJECT_MANAGER_USER_DATA；同时设置 PLM 名称以兼容宿主后续统一。
  const child = spawn(process.execPath, [path.join(projectRoot, 'backend/entry.cjs')], {
    cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PLM_USER_DATA_DIR: userData, PROJECT_MANAGER_USER_DATA: userData, PLM_NODE_BACKEND: '1', SMOKE_EXIT_MS: '', SMOKE_EVAL: '', SMOKE_GUEST_KEY: '' },
  })
  let sequence = 0
  let stderr = ''
  let stopped = false
  const waiting = new Map()
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const startupTimer = setTimeout(() => readyReject(new Error(`后台启动超时：${stderr.slice(-1200)}`)), 12000)
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000) })
  child.on('error', error => { readyReject(error); for (const pending of waiting.values()) pending.reject(error) })
  child.on('exit', (code, signal) => {
    if (stopped) return
    const error = new Error(`后台意外退出（${code ?? signal}）：${stderr.slice(-1200)}`)
    readyReject(error)
    for (const pending of waiting.values()) pending.reject(error)
  })
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  lines.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { readyReject(new Error('后台 stdout 出现非协议输出')); return }
    if (message.type === 'ready') readyResolve(message)
    else if (message.type === 'response') {
      const pending = waiting.get(message.id)
      if (!pending) return
      waiting.delete(message.id)
      clearTimeout(pending.timer)
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result)
    } else if (message.type === 'host-call') {
      child.stdin.write(`${JSON.stringify({ type: 'host-response', id: message.id, error: '知识 RPC 自测不执行桌面或网络外部动作' })}\n`)
    }
  })
  const rpc = (channel, args) => new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`RPC 超时：${channel}`)) }, 8000)
    waiting.set(id, { resolve, reject, timer })
    child.stdin.write(`${JSON.stringify({ type: 'request', id, channel, args })}\n`)
  })
  async function stop() {
    if (stopped) return
    stopped = true
    for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('测试后台已关闭')) }
    waiting.clear()
    if (child.exitCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill(), 2500)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`)
      })
    }
    lines.close()
  }
  try {
    const message = await ready
    for (const channel of channels) assert(message.channels.includes(channel), `真实主进程未注册 ${channel}`)
  } catch (error) { await stop(); throw error }
  finally { clearTimeout(startupTimer) }
  return { rpc, stop }
}

function electronApi(rpc) {
  let api
  const context = { console, process: { platform: process.platform }, require: id => {
    assert.equal(id, 'electron')
    return { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'gitReport'); api = value } }, ipcRenderer: { invoke: rpc, on() {}, removeListener() {} } }
  } }
  vm.runInNewContext(fs.readFileSync(path.join(projectRoot, 'electron/preload.js'), 'utf8'), context)
  return api
}

function tauriApi(rpc) {
  const window = {}
  const context = { window, console, module: { exports: {} }, require: id => {
    if (id === '@tauri-apps/api/core') return { invoke: (command, payload) => { assert.equal(command, 'backend_call'); return rpc(payload.channel, payload.args) } }
    if (id === '@tauri-apps/api/event') return { listen: async () => () => {} }
    if (id === '@tauri-apps/plugin-dialog') return { open() { throw new Error('测试不得打开对话框') }, save() { throw new Error('测试不得打开对话框') } }
    if (id === '@tauri-apps/plugin-clipboard-manager') return { readText() { throw new Error('测试不得读取系统剪贴板') }, writeText() { throw new Error('测试不得写系统剪贴板') } }
    if (id === '@tauri-apps/plugin-opener') return { openUrl() { throw new Error('测试不得打开外部链接') }, revealItemInDir() { throw new Error('测试不得打开系统目录') } }
    throw new Error(`未预期的 bridge 依赖：${id}`)
  } }
  const source = fs.readFileSync(path.join(projectRoot, 'src/tauri-bridge.generated.js'), 'utf8')
  vm.runInNewContext(transformSync(source, { format: 'cjs', target: 'node20' }).code, context)
  return window.gitReport
}

async function exercise(api, label, userData) {
  for (const method of methods) assert.equal(typeof api[method], 'function', `${label} 缺少 ${method}`)
  const listed = await api.knowledgeList()
  assert.equal(listed.ok, true)
  assert.equal(path.resolve(listed.directory), path.join(userData, 'knowledge'), 'RPC 必须实际使用隔离目录')
  const created = await api.knowledgeSave({ title: `${label} 真实 RPC`, body: '初始正文', type: 'experience', status: 'inbox', tags: ['测试'], projectId: '', projectName: '', sourceIds: [] })
  assert.equal(created.ok, true)
  assert.match(created.record.contentHash, /^[0-9a-f]{64}$/)
  const updated = await api.knowledgeSave({ ...created.record, body: '通过实际 bridge 更新' })
  assert.equal(updated.ok, true)
  assert.equal(updated.record.revision, 2)
  assert.equal((await api.knowledgeSave({ ...created.record, body: '过期内容' })).code, 'REVISION_CONFLICT')
  const trashed = await api.knowledgeTrash(updated.record.id, updated.record.revision)
  assert.equal(trashed.ok, true)
  assert(trashed.record.deletedAt > 0)
  assert(fs.existsSync(path.join(userData, 'knowledge', `${trashed.record.id}.md`)))
  const restored = await api.knowledgeRestore(trashed.record.id, trashed.record.revision)
  assert.equal(restored.ok, true)
  assert.equal(restored.record.deletedAt, null)
  const exported = await api.knowledgeExport(restored.record.id)
  assert.equal(exported.ok, true)
  assert.match(exported.content, /^---\n/)
  assert.doesNotMatch(exported.content, /^contentHash:/m)
  const imported = await api.knowledgeImport({ fileName: exported.fileName, content: exported.content })
  assert.equal(imported.ok, true)
  assert.notEqual(imported.record.id, restored.record.id)
  assert.equal(imported.record.body, restored.record.body)
  assert.equal(imported.record.revision, 1)
  assert.equal((await api.knowledgeExport('../escape')).code, 'INVALID_ID')
  console.log(`  ✓ ${label} 实际 API → 主进程 RPC → 文件增改、版本冲突、回收站、恢复、导入导出`)
  return { record: restored.record, imported: imported.record }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-rpc-selftest-'))
  const userData = path.join(root, 'userdata')
  fs.mkdirSync(userData)
  const config = JSON.stringify({ roots: [], harness: { autoStart: false } })
  fs.writeFileSync(path.join(userData, 'config.json'), config, 'utf8')
  let backend
  try {
    backend = await startBackend(userData)
    const electron = electronApi(backend.rpc), tauri = tauriApi(backend.rpc)
    const first = await exercise(electron, 'Electron preload', userData)
    const second = await exercise(tauri, 'Tauri bridge', userData)
    const parallel = await Promise.all([
      electron.knowledgeSave({ ...first.record, body: 'Electron 并发编辑' }),
      tauri.knowledgeSave({ ...first.record, body: 'Tauri 并发编辑' }),
    ])
    assert.equal(parallel.filter(result => result.ok).length, 1)
    assert.equal(parallel.find(result => !result.ok).code, 'REVISION_CONFLICT')
    const file = path.join(userData, 'knowledge', `${second.record.id}.md`)
    const external = fs.readFileSync(file, 'utf8').replace('通过实际 bridge 更新', '外部编辑器更新正文')
    fs.writeFileSync(file, external, 'utf8')
    assert.equal((await tauri.knowledgeSave({ ...second.record, body: '不得覆盖外部修改' })).code, 'REVISION_CONFLICT')
    assert.equal(fs.readFileSync(file, 'utf8'), external)
    assert.equal((await tauri.knowledgeTrash(second.imported.id, second.imported.revision)).ok, true)
    console.log('  ✓ 跨 bridge 并发 revision 校验与外部 Markdown 指纹保护')
    await backend.stop(); backend = undefined
    backend = await startBackend(userData)
    const restarted = await electronApi(backend.rpc).knowledgeList()
    assert.equal(restarted.ok, true)
    assert.equal(restarted.records.length, 4)
    assert.equal(restarted.records.find(record => record.id === second.record.id).body, '外部编辑器更新正文')
    assert(restarted.records.find(record => record.id === second.imported.id).deletedAt > 0)
    assert.equal(restarted.warnings.length, 0)
    assert.equal(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'), config, '知识操作不得改写应用配置')
    console.log('  ✓ 真实后台重启读取及回收站持久化，配置文件保持不变')
    console.log('知识 RPC 自测通过：全部操作位于临时用户目录，未连接 AI 或远端服务。')
  } finally {
    await backend?.stop()
    const resolved = fs.realpathSync(root)
    const temporary = fs.realpathSync(os.tmpdir())
    assert(path.dirname(resolved) === temporary && path.basename(resolved).startsWith('knowledge-rpc-selftest-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
