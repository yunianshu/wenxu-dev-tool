const http = require('node:http')
const { randomUUID, randomBytes, timingSafeEqual } = require('node:crypto')
const { italentPage } = require('./italent-page')
const { bookmarkletStart, bookmarkletLoop } = require('./italent-bridge')

const LABEL = 'leave-italent'
const MAX_BODY = 20 * 1024 * 1024

/**
 * 内嵌北森页适配器：脚本由桌面宿主注入独立 Webview 窗口执行，
 * 异步结果由页面 POST 回本机回调（eval 拿不到返回值；北森页面无 CSP，localhost 可达）。
 * host 由 backend/electron-compat.cjs 提供，经 Rust 的 eval_in_webview 命令注入。
 */
class ItalentEmbedded {
  constructor({ host, label = LABEL, timeout = 45000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    if (!host?.call) throw new Error('内嵌北森适配器需要桌面宿主的调用通道')
    this.host = host
    this.label = label
    this.timeout = timeout
    this.pause = pause
    this.server = null
    this.port = 0
    this.pending = new Map()
    this.jobs = []
    this.lastPoll = 0
    this.callbackToken = randomBytes(32).toString('hex')
    this.starting = null
    this.polls = new Set()
  }

  async ensureServer() {
    if (this.server) return
    if (this.starting) return this.starting
    this.starting = this.startServer()
    try { await this.starting } finally { this.starting = null }
  }

  async startServer() {
    const configuration = this.loadConfig?.()
    if (configuration) this.pairToken = configuration.token
    const server = http.createServer((request, response) => {
      let url
      try { url = new URL(request.url || '/', 'http://127.0.0.1') }
      catch { response.writeHead(400); response.end(); return }
      const bridgePath = this.pairToken && ['/bridge.js', '/bridge/next'].includes(url.pathname)
      const callback = url.pathname === '/leave-callback'
      if (!bridgePath && !callback) { response.writeHead(404); response.end(); return }
      if (request.headers.host !== `127.0.0.1:${this.port}` || !this.allowedOrigin(request.headers.origin)) { response.writeHead(403); response.end(); return }
      this.setCors(request, response)
      const method = callback ? 'POST' : 'GET'
      if (request.method === 'OPTIONS') {
        const headers = String(request.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean)
        if (request.headers['access-control-request-method'] !== method || headers.some(name => !['content-type', 'authorization'].includes(name))) { response.writeHead(403); response.end(); return }
        response.writeHead(204); response.end(); return
      }
      if (request.method !== method) { response.writeHead(405); response.end(); return }
      const token = url.pathname === '/bridge.js' ? this.pairToken : this.client ? this.client.token : this.callbackToken
      if (!this.authorized(request, token) || (this.pairToken && url.pathname !== '/bridge.js' && !this.client)) { response.writeHead(401); response.end(); return }
      if (url.pathname === '/bridge.js') return this.serveBridgeScript(request, response)
      if (url.pathname === '/bridge/next') return this.serveBridgeNext(request, response)
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk; if (body.length > MAX_BODY) request.destroy() })
      request.on('end', () => {
        let payload
        try { payload = JSON.parse(body) } catch { response.writeHead(400); response.end(); return }
        if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') { response.writeHead(400); response.end(); return }
        const waiter = this.pending.get(payload.id)
        if (!waiter || waiter.token !== token) { response.writeHead(409); response.end(); return }
        this.pending.delete(payload.id)
        clearTimeout(waiter.timer)
        response.writeHead(204)
        response.end()
        waiter.resolve(payload)
      })
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise((resolve, reject) => {
      server.once('error', () => reject(new Error('北森本机连接端口不可用或已被占用，请关闭重复应用后重试，或使用「连接北森」登录')))
      server.listen(configuration?.port || 0, '127.0.0.1', resolve)
    })
    // 回调端口只服务于存活的待回传请求，不阻止后台进程退出。
    server.unref()
    this.server = server
    this.port = server.address().port
  }

  setCors(request, response) {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin)
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    // 兼容旧版预检；新版浏览器仍由用户授予本地网络访问权限。
    response.setHeader('Access-Control-Allow-Private-Network', 'true')
    response.setHeader('Access-Control-Max-Age', '600')
    response.setHeader('Vary', 'Origin')
    response.setHeader('Cache-Control', 'no-store')
  }

  allowedOrigin(origin) {
    if (this.pairToken) return origin === 'https://cloud.italent.cn'
    try {
      const url = new URL(origin)
      return url.origin === origin && url.protocol === 'https:' && !url.port && (url.hostname === 'italent.cn' || url.hostname.endsWith('.italent.cn'))
    } catch { return false }
  }

  authorized(request, token) {
    const expected = Buffer.from(`Bearer ${token || ''}`)
    const actual = Buffer.from(String(request.headers.authorization || ''))
    return !!token && expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  /** 书签桥注入脚本：在已登录北森的页面里长轮询任务并执行，结果走 /leave-callback 回传。 */
  serveBridgeScript(request, response) {
    if (this.pending.size) { response.writeHead(409); response.end(); return }
    this.client = { id: randomUUID(), token: randomBytes(32).toString('hex') }
    this.lastPoll = 0
    for (const poll of this.polls) poll.finish(409)
    const script = `(${bookmarkletLoop.toString()})(${JSON.stringify(`http://127.0.0.1:${this.port}`)},${JSON.stringify(this.pairToken)},${JSON.stringify(this.client.token)},${bookmarkletStart.toString()})`
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    response.writeHead(200)
    response.end(script)
  }

  serveBridgeNext(request, response) {
    const client = this.client
    this.lastPoll = Date.now()
    const deadline = Date.now() + 20000
    const poll = { finish: (status, data) => {
      clearInterval(timer)
      this.polls.delete(poll)
      if (response.destroyed || response.writableEnded) return
      response.writeHead(status)
      response.end(data === undefined ? undefined : JSON.stringify(data))
    } }
    const timer = setInterval(() => {
      if (this.client !== client) { poll.finish(401); return }
      const job = this.jobs.find((item) => !item.served)
      if (job) {
        job.served = true
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        poll.finish(200, { code: job.code })
      } else if (Date.now() >= deadline) {
        poll.finish(204)
      }
    }, 100)
    timer.unref?.()
    this.polls.add(poll)
    response.once('close', () => {
      clearInterval(timer)
      this.polls.delete(poll)
      if (this.client === client && !response.writableEnded && !this.polls.size) this.lastPoll = 0
    })
  }

  /** 书签是否已连接（20 秒长轮询周期内有过拉取）。 */
  attached() {
    return !!this.server && !!this.client && Date.now() - this.lastPoll < 45000
  }

  /** 书签地址：拖到浏览器书签栏，在已登录北森的标签页点击。 */
  href() {
    return `javascript:void((${bookmarkletStart.toString()})(${JSON.stringify(`http://127.0.0.1:${this.port}`)},${JSON.stringify(this.pairToken)}))`
  }

  close() {
    const server = this.server
    this.server = null
    this.port = 0
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('内嵌北森适配器已关闭'))
    }
    this.pending.clear()
    for (const poll of this.polls) poll.finish(503)
    this.client = null
    this.lastPoll = 0
    this.jobs = []
    return new Promise(resolve => {
      if (!server) { resolve(); return }
      server.close(() => resolve())
      server.closeIdleConnections?.()
    })
  }

  buildCode(id, action, options) {
    const callback = JSON.stringify(`http://127.0.0.1:${this.port}/leave-callback`)
    const report = `function(r){try{fetch(${callback},{method:'POST',credentials:'omit',headers:{'Content-Type':'text/plain',Authorization:${JSON.stringify(`Bearer ${this.client?.token || this.callbackToken}`)}},body:JSON.stringify({id:${JSON.stringify(id)},success:r.success,data:r.data,message:r.message,submissionState:r.submissionState})}).catch(()=>{})}catch(e){}}`
    // 与旧 Kimi 桥接相同的错误口径：正文截断、隐藏请求地址、区分未提交与未知。
    const body = `const report=${report};try{const data=await (${italentPage.toString()})(${JSON.stringify(action)},${JSON.stringify(options || {})});report({success:true,data})}catch(e){report({success:false,message:String(e&&e.message||'北森操作失败').replace(/https?:\\/\\/\\S+/g,'[请求地址已隐藏]').slice(0,300),submissionState:e&&e.submissionState==='notSubmitted'?'notSubmitted':'unknown'})}`
    return `(async()=>{${body}})();0`
  }

  waitCallback(id, timeoutMessage) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(timeoutMessage))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer, token: this.client?.token || this.callbackToken })
    })
  }

  async evaluate(action, options) {
    await this.ensureServer()
    const id = randomUUID()
    const waiting = this.waitCallback(id, '北森页面执行超时，请确认窗口仍打开且已登录；若提示本地网络访问，请允许后重试')
    this.host.call('leave-eval', { label: this.label, code: this.buildCode(id, action, options) }).catch((error) => {
      const waiter = this.pending.get(id)
      if (!waiter) return
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.reject(new Error(/北森窗口未打开/.test(String(error?.message || error)) ? '请先点击「连接北森」打开北森窗口' : `北森页面执行失败：${error?.message || error}`))
    })
    return this.unwrap(await waiting)
  }

  unwrap(payload) {
    if (payload.success !== true) {
      const error = new Error(payload.message || '北森业务数据无法识别')
      if (payload.submissionState === 'notSubmitted') error.submissionState = 'notSubmitted'
      throw error
    }
    return payload.data
  }

  async connect() {
    await this.ensureServer()
    // 窗口刚创建时页面可能仍在加载或跳转登录，重试几次探到稳定来源即可；
    // 登录是否有效由 probe 内的一次已认证请求核实，未登录不视为失败。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this.pause(1000)
      try {
        const probe = await this.evaluate('probe', {})
        return { connected: true, origin: probe.origin || '', loggedIn: probe.loggedIn === true }
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
    throw new Error('未能探测北森页面，请重新点击连接北森')
  }

  read(options) { return this.evaluate('read', options) }
  prepare(options) { return this.evaluate('prepare', options) }
  apply(options) { return this.evaluate('apply', options) }

  /** 用捕获的签名直登 URL 导航内嵌窗口；登录结果由 probe 轮询确认。 */
  async seed(url) {
    await this.ensureServer()
    await this.host.call('leave-eval', { label: this.label, code: `location.href=${JSON.stringify(url)}` })
  }

  /**
   * 捕获后自动登入：跳签名 URL 建立门户会话（cloud 作用域的签名则直接登入 cloud）；
   * 门户落地后自动点「我的假勤」让门户完成向 cloud.italent.cn 的会话迁移，
   * 最后回到考勤页，由 probe 轮询核实。用户全程无操作。
   */
  async seedAndTransfer(url, landingUrl) {
    await this.ensureServer()
    await this.host.call('leave-eval', { label: this.label, code: `location.href=${JSON.stringify(url)}` })
    await this.pause(5000)
    const clickTile = `(function(){var w=['\u6211\u7684\u5047\u52e4','\u5047\u52e4','\u8003\u52e4'];var n=document.querySelectorAll('a,div,span,li');for(var i=0;i<w.length;i++){for(var j=0;j<n.length;j++){var e=n[j];if(!e.children.length&&e.textContent.trim()===w[i]&&e.offsetParent!==null){e.click();return w[i]}}}return ''})()`
    for (let attempt = 0; attempt < 8; attempt++) {
      let probe = null
      try { probe = await this.evaluate('probe', {}) } catch { /* 页面仍在加载或跳转 */ }
      if (probe?.origin === 'https://www.italent.cn') {
        await this.host.call('leave-eval', { label: this.label, code: clickTile })
        await this.pause(7000)
        await this.host.call('leave-eval', { label: this.label, code: `location.href=${JSON.stringify(landingUrl)}` })
        return
      }
      if (probe?.origin === 'https://cloud.italent.cn') {
        await this.host.call('leave-eval', { label: this.label, code: `location.href=${JSON.stringify(landingUrl)}` })
        return
      }
      await this.pause(2500)
    }
  }
}

/**
 * 书签桥：复用内嵌适配器的回传服务，但不经桌面宿主注入脚本——
 * 用户把书签拖到浏览器书签栏，在已登录北森的标签页点击后，
 * 页面长轮询 /bridge/next 领取任务执行，结果 POST 回 /leave-callback。
 * 适用于无浏览器扩展、无北森密码的场景（会话借用自用户已登录的页面）。
 */
class ItalentBookmarklet extends ItalentEmbedded {
  constructor(options = {}) {
    super({ ...options, host: { call: async () => { throw new Error('书签桥不经桌面宿主执行') } } })
    this.pairToken = randomBytes(32).toString('hex')
    this.loadConfig = options.loadConfig
  }

  async evaluate(action, options) {
    await this.ensureServer()
    if (!this.attached()) throw new Error('书签桥未连接，请在已登录北森的考勤页面点击连接书签，并允许本地网络访问')
    const id = randomUUID()
    const job = { code: this.buildCode(id, action, options), served: false }
    this.jobs.push(job)
    try {
      return this.unwrap(await this.waitCallback(id, '书签桥未连接：请在已登录北森的标签页点击书签'))
    } finally {
      this.jobs = this.jobs.filter((item) => item !== job)
    }
  }

  async connect() {
    await this.ensureServer()
    if (!this.attached()) return { connected: true, mode: 'bookmarklet', loggedIn: false }
    const probe = await this.evaluate('probe', {})
    return { connected: true, mode: 'bookmarklet', origin: probe.origin || '', loggedIn: probe.loggedIn === true }
  }
}

module.exports = { ItalentEmbedded, ItalentBookmarklet, LABEL }
