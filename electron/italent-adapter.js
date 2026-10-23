const { ItalentBrowser } = require('./italent-browser')
const { ItalentEmbedded, ItalentBookmarklet } = require('./italent-embedded')

/**
 * 北森通道链（默认不走 Kimi，无扩展与账号依赖）：
 * 优先书签桥（用户在已登录北森的标签页点击书签）；
 * 否则应用内嵌登录窗口（含企微捕获登录，登录核实后自动隐藏）。
 * PLM_LEAVE_ADAPTER=browser|embedded 可强制指定通道（browser 为 Kimi 桥逃生门）。
 */
class ItalentAdapter {
  constructor({ browser = new ItalentBrowser(), bookmarklet = new ItalentBookmarklet(), embedded, forced = process.env.PLM_LEAVE_ADAPTER || '' } = {}) {
    if (!embedded) throw new Error('通道链需要内嵌适配器实例')
    this.browser = browser
    this.bookmarklet = bookmarklet
    this.embedded = embedded
    this.forced = forced
    this.prepared = new Map()
  }

  async tryBookmarklet() {
    if (this.forced !== '') return false
    try {
      await this.bookmarklet.ensureServer()
      if (!this.bookmarklet.attached()) return false
      const probe = await this.bookmarklet.evaluate('probe', {})
      return probe?.loggedIn === true
    } catch { return false }
  }

  async pick() {
    if (this.forced === 'browser') return this.browser
    if (this.forced === 'embedded') return this.embedded
    if (await this.tryBookmarklet()) return this.bookmarklet
    return this.embedded
  }

  async connect(input = {}) {
    let bookmarklet = ''
    let bookmarkletError = ''
    try { await this.bookmarklet.ensureServer(); bookmarklet = this.bookmarklet.href() }
    catch { bookmarkletError = '浏览器书签的本机端口或系统凭据库不可用，请关闭重复应用后重试；也可使用「连接北森」登录' }
    if (input.mode === 'bookmarklet') {
      if (!bookmarklet) throw new Error(bookmarkletError)
      return { connected: true, mode: 'bookmarklet', loggedIn: await this.tryBookmarklet(), bookmarklet }
    }
    if (this.forced === 'browser') {
      const result = await this.browser.connect()
      return { ...result, mode: 'browser', loggedIn: true, bookmarklet }
    }
    if (await this.tryBookmarklet()) return { connected: true, mode: 'bookmarklet', loggedIn: true, bookmarklet }
    try {
      const probe = await this.embedded.connect()
      return { ...probe, mode: 'embedded', bookmarklet, bookmarkletError }
    } catch (error) {
      // 内嵌探测失败（窗口未开等）不视为连接失败：前端据此弹登录窗口或引导书签。
      return { connected: true, mode: 'embedded', origin: '', loggedIn: false, error: error.message, bookmarklet, bookmarkletError }
    }
  }

  read(options) { return this.pick().then((adapter) => adapter.read(options)) }
  async prepare(options) {
    const adapter = await this.pick()
    const result = await adapter.prepare(options)
    for (const [key, saved] of this.prepared) if (Date.now() - saved.at > 10 * 60 * 1000) this.prepared.delete(key)
    this.prepared.set(result.key, { adapter, session: adapter.client?.id, at: Date.now() })
    return result
  }

  apply(options) {
    const saved = this.prepared.get(options.key)
    this.prepared.delete(options.key)
    if (!saved || saved.session !== saved.adapter.client?.id || Date.now() - saved.at > 10 * 60 * 1000) {
      const error = new Error('北森连接已变化或表单已失效，请重新生成并确认方案')
      error.submissionState = 'notSubmitted'
      throw error
    }
    return saved.adapter.apply(options)
  }
}

module.exports = { ItalentAdapter }
