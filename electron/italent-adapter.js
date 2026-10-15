const { ItalentBrowser } = require('./italent-browser')
const { ItalentEmbedded } = require('./italent-embedded')

/**
 * 自适应北森适配器：优先借用已登录北森的浏览器（Kimi 桥，需扩展本地连接），
 * 连不上扩展时退回应用内嵌窗口登录。选定后本进程内保持不变，避免中途换会话。
 * PLM_LEAVE_ADAPTER=embedded 可强制内嵌模式（冒烟/诊断用）。
 */
class ItalentAdapter {
  constructor({ browser = new ItalentBrowser(), embedded, forceEmbedded = process.env.PLM_LEAVE_ADAPTER === 'embedded' } = {}) {
    if (!embedded) throw new Error('自适应适配器需要内嵌适配器实例')
    this.browser = browser
    this.embedded = embedded
    this.forceEmbedded = forceEmbedded
    this.mode = forceEmbedded ? 'embedded' : null
  }

  async pick() {
    if (!this.mode) {
      try {
        await this.browser.connect()
        this.mode = 'browser'
      } catch {
        this.mode = 'embedded'
      }
    }
    return this.mode === 'browser' ? this.browser : this.embedded
  }

  async connect() {
    const adapter = await this.pick()
    const result = await adapter.connect()
    return { ...result, mode: this.mode }
  }

  read(options) { return this.pick().then((adapter) => adapter.read(options)) }
  prepare(options) { return this.pick().then((adapter) => adapter.prepare(options)) }
  apply(options) { return this.pick().then((adapter) => adapter.apply(options)) }
}

module.exports = { ItalentAdapter }
