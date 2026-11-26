/**
 * AI 服务 —— 调用 OpenAI 兼容的 /chat/completions 接口（流式）
 * 兼容 OpenAI / DeepSeek / Moonshot(Kimi) / 通义千问 / Ollama 等提供方
 * 统一走主进程（net.fetch），规避渲染层 CORS；API Key 由主进程解析，不下发渲染层
 */
const { net } = require('electron')
const dns = require('dns')

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
/** 输出 token 上限（防止长报告溢出上下文或静默截断） */
const DEFAULT_MAX_TOKENS = 4096

/** 是否为内网/本机 IP（http 仅允许这些地址，防止向公网明文发送 Key） */
function isPrivateIp(host) {
  const h = (host || '').toLowerCase()
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h)) return true
  const parts = h.split('.').map(Number)
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 10) return true // 10.0.0.0/8
    if (parts[0] === 127) return true // 127.0.0.0/8
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true // 172.16.0.0/12
    if (parts[0] === 192 && parts[1] === 168) return true // 192.168.0.0/16
  }
  return false
}

/**
 * 域名形式的内网地址（如 ai.sysapp.prttech.com → 10.11.9.2）：
 * 解析后任一地址落在私网段即放行；解析失败视为不可信。
 */
async function hostResolvesPrivate(hostname) {
  if (!hostname || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return isPrivateIp(hostname)
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true })
    return addrs.some(({ address }) => isPrivateIp(address))
  } catch {
    return false
  }
}

/**
 * 校验接口地址：https 一律允许；http 仅限本机/内网——IP 直接判段，
 * 域名解析后含私网地址才放行（兼容公司内网网关域名）。返回去尾部斜杠的完整 base（含路径前缀）
 */
async function assertSafeBaseUrl(baseUrl) {
  let u
  try {
    u = new URL(baseUrl || DEFAULT_BASE_URL)
  } catch {
    throw new Error('接口地址格式不正确，请检查「设置 → AI 模型 → 接口地址」')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('接口地址协议不支持（仅支持 http / https）')
  }
  const hostname = u.hostname
  const ok = u.protocol === 'https:' || (u.protocol === 'http:' && (isPrivateIp(hostname) || await hostResolvesPrivate(hostname)))
  if (!ok) {
    throw new Error('接口地址仅支持 https，或 http 仅限本机/内网（localhost、10.x、172.16-31.x、192.168.x，及解析到这些网段的域名）')
  }
  // 保留路径前缀（如 /v1、/anthropic），仅去尾部斜杠，供后续拼 /chat/completions
  return u.href.replace(/\/+$/, '')
}

/**
 * 流式对话。onDelta 回调收到累计文本（幂等）；返回完整回复文本。
 * 出错时抛 Error（message 可直接展示给用户）。
 */
async function chat({ baseUrl, apiKey, model, messages, temperature = 0.7, maxTokens = DEFAULT_MAX_TOKENS, onDelta, signal }) {
  if (!apiKey) throw new Error('未配置 API Key，请先在「设置 → AI 模型」中填写')
  if (!model) throw new Error('未配置模型名称，请先在「设置 → AI 模型」中填写')
  if (!Array.isArray(messages) || !messages.length) throw new Error('消息列表为空')

  const url = `${await assertSafeBaseUrl(baseUrl)}/chat/completions`
  const resp = await net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    signal,
  })

  if (!resp.ok) {
    let detail = ''
    try {
      detail = (await resp.text()).slice(0, 400)
    } catch { /* noop */ }
    const err = new Error(`AI 接口请求失败（HTTP ${resp.status}）${detail ? `：${detail}` : ''}`)
    err.status = resp.status
    throw err
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let full = ''

  /** 解析一段 SSE 文本（data: {...} / data: [DONE]），返回是否遇到结束 */
  const parseEvent = (data) => {
    for (const line of String(data).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') return true
      try {
        const json = JSON.parse(payload)
        const delta = json.choices?.[0]?.delta?.content || ''
        if (delta) {
          full += delta
          if (onDelta) onDelta(full)
        }
      } catch { /* 忽略无法解析的帧（如 keep-alive） */ }
    }
    return false
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    // 归一化 CRLF，兼容部分服务器的 \r\n 分帧
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    const events = buffer.split('\n\n')
    buffer = events.pop()
    for (const ev of events) {
      if (parseEvent(ev)) return full
    }
  }
  // 流结束：刷新残留缓冲（部分服务关闭时无结尾空行）
  if (buffer.trim()) parseEvent(buffer)
  return full
}

/** 部分兼容网关不支持 JSON 模式，只有明确拒绝该参数时才退回提示词约束。 */
function rejectsJsonFormat(status, detail) {
  if (status !== 400 && status !== 422) return false
  const format = /response[_ ]format|json[_ ]object/i
  const unsupported = /unsupported|not supported|does(?: not|n't) support|not available|unknown (?:parameter|argument|field)|unrecognized|unexpected (?:parameter|argument|field|keyword)|extra[_ ]forbidden|extra inputs are not permitted|不支持|未知参数/i
  let data
  try { data = JSON.parse(detail) } catch { return format.test(detail) && unsupported.test(detail) }
  const errors = Array.isArray(data?.detail) ? data.detail : [data?.error || data?.detail || data]
  return errors.some(error => {
    if (typeof error === 'string') return format.test(error) && unsupported.test(error)
    const field = error?.param || (Array.isArray(error?.loc) && error.loc.join('.'))
    const message = [error?.message, error?.msg, error?.type, error?.code].filter(Boolean).join(' ')
    return format.test(field || message) && unsupported.test(message)
  })
}

/**
 * 非流式对话（结构化输出场景用，如 AI 部署方案要一份 JSON）。
 * 与 chat() 的差别：
 *   - 不开 stream：推理型模型（返回 reasoning_content）在流式下正文内容可能与推理内容
 *     交错，甚至被推理 token 吃光预算而只剩空正文；非流式由服务端一次性给出最终 content
 *   - 返回 finishReason 与 reasoning，便于调用方判断「被长度截断 / 只有推理没有正文」
 *   - reasoningEffort：部分网关支持（'none' 关闭思考）时传入，避免推理过程吃掉输出预算；
 *     不支持的网关会返回 4xx，由调用方决定是否去掉该参数重试
 * 出错时抛 Error（message 可直接展示给用户）。
 * @returns {Promise<{text: string, finishReason: string, reasoning: string, model: string}>}
 */
async function complete({ baseUrl, apiKey, model, messages, temperature = 0, maxTokens = DEFAULT_MAX_TOKENS, reasoningEffort, responseFormat, signal }) {
  if (!apiKey) throw new Error('未配置 API Key，请先在「设置 → AI 模型」中填写')
  if (!model) throw new Error('未配置模型名称，请先在「设置 → AI 模型」中填写')
  if (!Array.isArray(messages) || !messages.length) throw new Error('消息列表为空')

  const url = `${await assertSafeBaseUrl(baseUrl)}/chat/completions`
  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false }
  if (reasoningEffort) body.reasoning_effort = reasoningEffort
  if (responseFormat === 'json') body.response_format = { type: 'json_object' }
  const send = async () => {
    const resp = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (resp.ok) return resp
    const detail = await resp.text().catch(() => '')
    const error = new Error(`AI 接口请求失败（HTTP ${resp.status}）${detail ? `：${detail.slice(0, 400)}` : ''}`)
    error.status = resp.status
    error.jsonFormatUnsupported = body.response_format && rejectsJsonFormat(resp.status, detail)
    throw error
  }
  let resp
  try {
    resp = await send()
  } catch (error) {
    if (signal?.aborted || !error.jsonFormatUnsupported) throw error
    delete body.response_format
    resp = await send()
  }
  let json
  try {
    json = await resp.json()
  } catch {
    throw new Error('AI 接口返回的不是有效 JSON')
  }
  const choice = (json.choices && json.choices[0]) || {}
  const msg = choice.message || {}
  const text = Array.isArray(msg.content)
    ? msg.content.filter(part => (part?.type === 'text' || part?.type === 'output_text') && typeof part.text === 'string').map(part => part.text).join('')
    : typeof msg.content === 'string' ? msg.content : ''
  return {
    text,
    finishReason: String(choice.finish_reason || ''),
    reasoning: String(msg.reasoning_content || msg.reasoning || ''),
    model: String(json.model || model),
  }
}

/** 测试连接：极简请求验证 baseUrl / apiKey / model 可用性 */
async function test({ baseUrl, apiKey, model }) {  const text = await chat({
    baseUrl,
    apiKey,
    model,
    messages: [{ role: 'user', content: '你好，请只回复两个字：成功' }],
    temperature: 0,
    maxTokens: 16,
  })
  return { ok: true, reply: (text || '').trim() || '(空回复)' }
}

/** 获取可用模型列表（OpenAI 兼容 /models） */
async function listModels({ baseUrl, apiKey }) {
  if (!apiKey) throw new Error('未配置 API Key，请先填写后再获取模型列表')
  const url = `${await assertSafeBaseUrl(baseUrl)}/models`
  const resp = await net.fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!resp.ok) {
    let detail = ''
    try {
      detail = (await resp.text()).slice(0, 300)
    } catch { /* noop */ }
    const err = new Error(`获取模型列表失败（HTTP ${resp.status}）${detail ? `：${detail}` : ''}`)
    err.status = resp.status
    throw err
  }
  let json
  try {
    json = await resp.json()
  } catch {
    throw new Error('获取模型列表失败：响应不是有效 JSON')
  }
  const models = (json.data || []).map((m) => m && m.id).filter(Boolean)
  if (!models.length) throw new Error('该接口未返回可用模型（data 为空）')
  return models
}

module.exports = { chat, complete, test, listModels, DEFAULT_BASE_URL, DEFAULT_MAX_TOKENS }
