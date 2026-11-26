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
  const bodies = []
  const replies = []
  const net = { fetch: async (_url, options) => {
    bodies.push(JSON.parse(options.body))
    assert(replies.length, '不应产生额外的模型请求')
    const reply = replies.shift()
    return typeof reply === 'function' ? reply(options) : reply
  } }
  const aiModule = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/ai-service.js'), 'utf8'), {
    module: aiModule, require: id => id === 'electron' ? { net } : require(id), URL,
  })
  const listeners = new Set()
  const sender = { send: (_channel, payload) => { for (const fn of listeners) fn(payload) } }
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('  const aiControllers = new WeakMap()')
  const end = source.indexOf("  ipcMain.handle('ai:test'", start)
  assert(start >= 0 && end > start, '应加载实际 AI IPC 处理段')
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, AbortController, Map, WeakMap,
    store: { load: () => ({ ai: { model: '测试模型' } }), getApiKey: () => '测试占位' },
    aiService: { complete: aiModule.exports.complete, chat: (input) => new Promise((resolve, reject) => {
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

  const generate = () => api.aiChat([{ role: 'user', content: '请返回 JSON' }], { requestId: 'insights', responseFormat: 'json' })
  const completion = (content, reason) => Response.json({ choices: [{
    message: { reasoning_content: '独立的推理内容', content }, finish_reason: reason,
  }] })
  replies.push(completion([{ type: 'text', text: '{"ok":' }, { type: 'reasoning', text: '推理片段' }, { type: 'text', text: 'true}' }], 'stop'))
  const result = await generate()
  assert.deepEqual(Object.keys(result).sort(), ['finishReason', 'ok', 'text'])
  assert.equal(result.text, '{"ok":true}')
  assert.equal(result.finishReason, 'stop')
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' })
  assert.equal(bodies[0].stream, false)
  assert.equal(bodies[0].temperature, 0)
  assert.equal(bodies[0].max_tokens, 8192)
  console.log('  ✓ 结构化请求启用 JSON 输出，仅返回正文和终止原因')

  for (const [status, error] of [
    [400, { error: { message: "Unsupported parameter: 'response_format'" } }],
    [422, { detail: [{ loc: ['body', 'response_format'], msg: 'Extra inputs are not permitted' }] }],
  ]) {
    replies.push(Response.json(error, { status }), completion('{"modules":[', 'length'))
    const fallback = await generate()
    assert.equal(fallback.finishReason, 'length')
    const { response_format, ...params } = bodies.at(-2)
    assert.deepEqual(response_format, { type: 'json_object' })
    assert.deepEqual(bodies.at(-1), params)
  }
  for (const [status, message, param] of [
    [429, 'rate limit'],
    [400, "Unsupported parameter: 'temperature'"],
    [400, 'response_format requires the word json in the prompt'],
    [422, 'Unsupported parameter in this request with response_format', 'temperature'],
  ]) {
    const before = bodies.length
    replies.push(Response.json({ error: { message, param } }, { status }))
    const failure = await generate()
    assert.equal(failure.ok, false)
    assert(failure.error.includes(message))
    assert.equal(bodies.length, before + 1)
  }
  console.log('  ✓ 不兼容网关仅在明确拒绝格式参数时回退一次，保留截断标记')

  let notifyStarted
  const started = new Promise(resolve => { notifyStarted = resolve })
  replies.push(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason))
    notifyStarted()
  }))
  const pending = generate()
  await started
  await api.aiStop('insights')
  assert.equal((await pending).aborted, true)
  console.log('  ✓ 结构化请求沿用现有取消入口')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
