const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')

const PATTERNS = ['%/v1/sso/italent/auth%', '%/v2/sso/sign%']

/** Chrome / Edge / Brave 的默认与多用户配置都可能记录企微签名直登 URL。 */
function discoverHistoryPaths() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const roots = [
    ['Google', 'Chrome', 'User Data'],
    ['Microsoft', 'Edge', 'User Data'],
    ['BraveSoftware', 'Brave-Browser', 'User Data'],
  ]
  const result = []
  for (const root of roots) {
    const userData = path.join(local, ...root)
    let entries = []
    try { entries = fs.readdirSync(userData, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory() || (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name))) continue
      const file = path.join(userData, entry.name, 'History')
      try { if (fs.statSync(file).isFile()) result.push(file) } catch { /* 配置目录里没有 History */ }
    }
  }
  return result
}

/**
 * Chromium 历史签名 SSO 捕获：企业微信打开北森链接时会让默认浏览器记录一条
 * 带签名的 italent 直登 URL（约 11.5 秒落盘）。捕获后交给内嵌窗口重放登入。
 * 同时读取 Chrome / Edge / Brave 的多个 Profile；只读 History 文件副本，不写浏览器数据。
 */
class ChromeSSOWatcher {
  constructor({ historyPath, historyPaths, intervalMs = 2000, maxAgeMs = 180000, timeoutMs = 600000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    this.historyPaths = historyPaths || (historyPath ? [historyPath] : discoverHistoryPaths())
    this.intervalMs = intervalMs
    this.maxAgeMs = maxAgeMs
    this.timeoutMs = timeoutMs
    this.pause = pause
    this.running = false
    this.seen = null
  }

  readSnapshot(tmpFile, historyPath = this.historyPaths[0]) {
    fs.copyFileSync(historyPath, tmpFile)
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
    const seen = new Map()
    for (const file of this.historyPaths) {
      if (!fs.existsSync(file)) continue
      try { for (const row of this.readSnapshot(tmpFile, file)) seen.set(row.url, true) } catch { /* 单个配置读取失败不影响其他浏览器 */ }
    }
    return seen
  }

  /** 监听直至捕获新鲜签名 URL、超时或 stop()。返回 { url } 或 null。 */
  async wait(onCapture) {
    if (this.running) return null
    this.running = true
    const tmpFile = path.join(os.tmpdir(), `plm-leave-sso-${process.pid}.db`)
    const startedAt = Date.now() / 1000
    const seen = this.baseline(tmpFile)
    this.seen = seen
    const historyMtimes = this.historyMtimes()
    try {
      while (this.running && (this.timeoutMs <= 0 || Date.now() / 1000 - startedAt < this.timeoutMs / 1000)) {
        await this.pause(this.intervalMs)
        if (!this.running) break
        // 某个 History 文件变化时才复制并查询；多个浏览器/配置逐个看。
        for (const file of this.historyPaths) {
          const mtime = this.historyMtime(file)
          if (mtime === historyMtimes.get(file)) continue
          historyMtimes.set(file, mtime)
          let rows
          try { rows = this.readSnapshot(tmpFile, file) } catch { continue }
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
      }
    } finally {
      try { fs.unlinkSync(tmpFile) } catch { /* 临时副本清理失败可忽略 */ }
      this.running = false
    }
    return null
  }

  historyMtime(file = this.historyPaths[0]) {
    try { return fs.statSync(file).mtimeMs } catch { return 0 }
  }

  historyMtimes() {
    return new Map(this.historyPaths.map((file) => [file, this.historyMtime(file)]))
  }

  stop() { this.running = false }
}

module.exports = { ChromeSSOWatcher, discoverHistoryPaths }
