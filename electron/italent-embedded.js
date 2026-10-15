const http = require('node:http')
const { randomUUID } = require('node:crypto')
const { italentPage } = require('./italent-page')

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
  }

  async ensureServer() {
    if (this.server) return
    const server = http.createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/leave-callback') { response.writeHead(404); response.end(); return }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { body += chunk; if (body.length > MAX_BODY) request.destroy() })
      request.on('end', () => {
        response.setHeader('Access-Control-Allow-Origin', String(request.headers.origin || '*'))
        response.writeHead(204)
        response.end()
        let payload
        try { payload = JSON.parse(body) } catch { return }
        const waiter = this.pending.get(payload.id)
        if (!waiter) return
        this.pending.delete(payload.id)
        clearTimeout(waiter.timer)
        waiter.resolve(payload)
      })
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    // 回调端口只服务于存活的待回传请求，不阻止后台进程退出。
    server.unref()
    this.server = server
    this.port = server.address().port
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
    server?.close()
  }

  buildCode(id, action, options) {
    const callback = JSON.stringify(`http://127.0.0.1:${this.port}/leave-callback`)
    const report = `function(r){try{fetch(${callback},{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify({id:${JSON.stringify(id)},success:r.success,data:r.data,message:r.message,submissionState:r.submissionState})})}catch(e){}}`
    // 与旧 Kimi 桥接相同的错误口径：正文截断、隐藏请求地址、区分未提交与未知。
    const body = `const report=${report};try{const data=await (${italentPage.toString()})(${JSON.stringify(action)},${JSON.stringify(options || {})});report({success:true,data})}catch(e){report({success:false,message:String(e&&e.message||'北森操作失败').replace(/https?:\\/\\/\\S+/g,'[请求地址已隐藏]').slice(0,300),submissionState:e&&e.submissionState==='notSubmitted'?'notSubmitted':'unknown'})}`
    return `(async()=>{${body}})();0`
  }

  async evaluate(action, options) {
    await this.ensureServer()
    const id = randomUUID()
    const payload = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error('北森页面执行超时，请确认北森窗口仍打开且已登录'))
      }, this.timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.host.call('leave-eval', { label: this.label, code: this.buildCode(id, action, options) }).catch((error) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        const message = String(error?.message || error)
        reject(new Error(/北森窗口未打开/.test(message) ? '请先点击「连接北森」打开北森窗口' : `北森页面执行失败：${message}`))
      })
    })
    if (payload.success !== true) {
      const error = new Error(payload.message || '北森业务数据无法识别')
      if (payload.submissionState === 'notSubmitted') error.submissionState = 'notSubmitted'
      throw error
    }
    return payload.data
  }

  async connect() {
    await this.ensureServer()
    // 窗口刚创建时页面可能仍在加载或跳转登录，重试几次探到稳定来源即可，不强制已登录。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this.pause(1000)
      try {
        const probe = await this.evaluate('probe', {})
        return { connected: true, origin: probe.origin || '' }
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
    throw new Error('未能探测北森页面，请重新点击连接北森')
  }

  read(options) { return this.evaluate('read', options) }
  prepare(options) { return this.evaluate('prepare', options) }
  apply(options) { return this.evaluate('apply', options) }
}

module.exports = { ItalentEmbedded, LABEL }
