const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')

const PATTERNS = ['%/v1/sso/italent/auth%', '%/v2/sso/sign%']

/**
 * Chrome 历史签名 SSO 捕获：企业微信打开北森链接时会让默认浏览器记录一条
 * 带签名的 italent 直登 URL（约 11.5 秒落盘）。捕获后交给内嵌窗口重放登入。
 * 只读 History 文件副本，不写浏览器数据。
 */
class ChromeSSOWatcher {
  constructor({ historyPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data', 'Default', 'History'), intervalMs = 2000, maxAgeMs = 180000, timeoutMs = 600000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.historyPath = historyPath
    this.intervalMs = intervalMs
    this.maxAgeMs = maxAgeMs
    this.timeoutMs = timeoutMs
    this.pause = pause
    this.running = false
    this.seen = null
  }

  readSnapshot(tmpFile) {
    fs.copyFileSync(this.historyPath, tmpFile)
    const db = new DatabaseSync(tmpFile, { readOnly: true })
    try {
      // Chrome 微秒时间戳超出 JS 安全整数，在 SQL 内换算成 Unix 秒。
      const rows = db.prepare('SELECT url, last_visit_time / 1000000 - 11644473600 AS at FROM urls WHERE url LIKE ? OR url LIKE ?').all(...PATTERNS)
      return rows.map((row) => ({ url: row.url, at: row.at }))
    } finally {
      db.close()
    }
  }

  baseline(tmpFile) {
    if (!fs.existsSync(this.historyPath)) return new Map()
    try { return new Map(this.readSnapshot(tmpFile).map((row) => [row.url, true])) }
    catch { return new Map() }
  }

  /** 监听直至捕获新鲜签名 URL、超时或 stop()。返回 { url } 或 null。 */
  async wait(onCapture) {
    if (this.running) return null
    this.running = true
    const tmpFile = path.join(os.tmpdir(), `plm-leave-sso-${process.pid}.db`)
    const startedAt = Date.now() / 1000
    const seen = this.baseline(tmpFile)
    this.seen = seen
    try {
      while (this.running && Date.now() / 1000 - startedAt < this.timeoutMs / 1000) {
        await this.pause(this.intervalMs)
        if (!this.running) break
        let rows
        try { rows = this.readSnapshot(tmpFile) } catch { continue }
        for (const row of rows) {
          if (seen.has(row.url)) continue
          seen.set(row.url, true)
          if (row.at >= startedAt - this.maxAgeMs / 1000) {
            this.running = false
            const result = { url: row.url }
            if (onCapture) onCapture(result)
            return result
          }
        }
      }
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* 临时副本清理失败可忽略 */ }
      this.running = false
    }
    return null
  }

  stop() { this.running = false }
}

module.exports = { ChromeSSOWatcher }
