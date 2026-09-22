/** 项目会话与真实 IPC 处理段回归：网络替身，覆盖并发、切换、停止和迟到响应。 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { buildSync } = require('esbuild')

async function main() {
  const bundle = buildSync({ entryPoints: [path.join(__dirname, '../src/composables/useProjectChat.js')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vue'] })
  const context = { module: { exports: {} }, require, Date, Map, Promise, console }
  vm.runInNewContext(bundle.outputFiles[0].text, context)
  const { createProjectChat, buildChatMessages } = context.module.exports
  const handlers = new Map()
  const calls = []
  const listeners = new Set()
  const sender = { send: (_channel, payload) => { for (const fn of listeners) fn(payload) } }
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('  const aiControllers = new WeakMap()')
  const end = source.indexOf("  ipcMain.handle('ai:test'", start)
  assert(start >= 0 && end > start, '应加载实际 AI IPC 处理段')
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, AbortController, Map, WeakMap,
    store: { load: () => ({ ai: { model: '测试模型' } }), getApiKey: () => '测试占位' },
    aiService: { chat: (input) => new Promise((resolve, reject) => {
      calls.push({ ...input, resolve })
      input.signal.addEventListener('abort', () => reject(Object.assign(new Error('已停止'), { name: 'AbortError' })))
    }) },
  })
  const api = {
    onAiDelta: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    aiChat: (messages, opts) => handlers.get('ai:chat')({ sender }, { messages, opts }),
    aiStop: (id) => handlers.get('ai:stop')({ sender }, id),
  }
  const chat = createProjectChat(api)
  const a = chat.session('A')
  a.draft = 'A 的草稿'
  const first = chat.send('A', 'A_ONLY', '项目 A', {})
  calls[0].onDelta('A 生成中')
  assert.equal(a.messages[1].content, 'A 生成中')
  calls[0].resolve('A 已完成')
  await first
  assert.equal(a.messages[1].content, 'A 已完成')

  const b = chat.session('B')
  assert.equal(b.messages.length, 0)
  assert.equal(b.draft, '')
  const second = chat.send('B', '请总结当前项目', '项目 B', {})
  assert(!calls[1].messages.some((m) => /A_ONLY|A 已完成/.test(m.content)), 'B 请求不得携带 A 历史')
  assert(calls[1].messages.some((m) => m.content === '项目 B'))
  assert.equal(chat.session('A'), a, '切回时复用原会话和草稿')
  assert.equal(a.draft, 'A 的草稿')
  console.log('  ✓ 项目历史、请求上下文与草稿隔离，切回恢复原会话')

  const third = chat.send('A', '继续 A', '项目 A', {})
  calls[1].onDelta('B 增量')
  calls[2].onDelta('A 新增量')
  assert.equal(b.messages[1].content, 'B 增量')
  assert.equal(a.messages[3].content, 'A 新增量')
  await chat.stop('B')
  await second
  assert(calls[1].signal.aborted)
  assert(!calls[2].signal.aborted, '停止 B 不得中断 A')
  calls[1].onDelta('B 迟到增量')
  assert.equal(b.messages[1].content, 'B 增量')
  assert.equal(b.streaming, false)
  assert.equal(a.streaming, true)
  console.log('  ✓ 后台流持续归属原项目，停止仅作用于指定请求')

  chat.clear('A')
  const fourth = chat.send('A', '新会话', '项目 A', {})
  calls[2].onDelta('旧请求迟到增量')
  calls[2].resolve('旧请求迟到完成')
  await third
  assert.equal(a.messages.length, 2)
  assert.equal(a.messages[0].content, '新会话')
  assert.equal(a.messages[1].content, '')
  assert.equal(a.streaming, true, '旧请求收尾不得清空新请求运行状态')
  calls[3].resolve('新请求完成')
  await fourth
  assert.equal(a.messages[1].content, '新请求完成')
  assert.equal(b.messages[1].content, 'B 增量', '清空 A 不得修改 B')
  console.log('  ✓ 清空立即作废旧请求，迟到事件与收尾不污染新对话')

  const legacyEvents = []
  const off = api.onAiDelta((payload) => legacyEvents.push(payload))
  const legacy = api.aiChat([{ role: 'user', content: '旧调用' }], {})
  calls[4].onDelta('兼容增量')
  assert.equal(legacyEvents.at(-1), '兼容增量')
  calls[4].resolve('兼容完成')
  await legacy
  off()
  const messages = buildChatMessages([{ role: 'user', content: '长'.repeat(30000) }], '项目上下文')
  assert(messages.reduce((sum, m) => sum + m.content.length, 0) <= 20001)
  chat.dispose()
  assert.equal(listeners.size, 0)
  console.log('  ✓ 旧 IPC 调用保持兼容，消息预算和订阅释放有效')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
