const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomBytes, randomUUID } = require('node:crypto')

/** 配对凭据只通过现有系统凭据库保存，普通文件仅保留加密值或凭据引用。 */
function createBookmarkletConfig(directory, codec) {
  const file = path.join(directory, 'leave-bridge.json')
  return () => {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      const token = codec.decryptText(saved.secret)
      if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535 || !/^[a-f0-9]{64}$/.test(token) || saved.secret?.plain) throw new Error('书签配对凭据无法读取，请使用「连接北森」登录')
      return { port: saved.port, token }
    }
    const token = randomBytes(32).toString('hex')
    const secret = codec.encryptText(token)
    if (!secret || secret.plain || (!secret.keyRef && !secret.enc)) throw new Error('系统凭据库不可用，请使用「连接北森」登录；书签配对不会明文保存')
    const port = 40000 + createHash('sha256').update(path.resolve(directory)).digest().readUInt16BE(0) % 20000
    const temp = `${file}.${randomUUID()}.tmp`
    try {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(temp, JSON.stringify({ version: 1, port, secret }), { mode: 0o600 })
      fs.renameSync(temp, file)
    } catch (error) {
      if (secret.keyRef) try { codec.deleteSecret?.(secret.keyRef) } catch { /* 不覆盖原始保存错误 */ }
      throw error
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp) }
    return { port, token }
  }
}

// 以下两个函数在浏览器执行，必须保持自包含；提示不包含请求地址或配对凭据。
async function bookmarkletStart(base, token) {
  if (location.origin !== 'https://cloud.italent.cn') { alert('请打开已登录北森的「我的考勤」页面，再点击连接书签。'); return }
  try {
    const response = await fetch(base + '/bridge.js', { credentials: 'omit', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      alert(response.status === 409 ? '当前请假操作正在进行，请等待完成后重新点击书签。' : '书签配对已失效或连接被拒绝，请在应用中重新复制「浏览器书签」。')
      return
    }
    ;(0, eval)(await response.text())
  } catch {
    alert('无法连接本机应用。请确认应用已启动，并在北森页面地址栏的网站设置中允许「本地网络访问」（部分版本称本地设备或回环网络），然后重新点击书签。也可使用应用内「连接北森」登录。')
  }
}

function bookmarkletLoop(base, token, session, start) {
  const previous = window.__plmLeaveBridge
  if (previous && typeof previous.stop === 'function') previous.stop()
  const controller = { stopped: false, timer: null, aborter: null, stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.aborter?.abort()
  } }
  window.__plmLeaveBridge = controller
  async function pump() {
    if (controller.stopped) return
    controller.aborter = new AbortController()
    try {
      const response = await fetch(base + '/bridge/next', { credentials: 'omit', headers: { Authorization: 'Bearer ' + session }, signal: controller.aborter.signal })
      if (controller.stopped) return
      if (response.status === 401) {
        // 应用重启后会话凭据失效，用书签中的持久配对凭据重新建立会话。
        controller.stop()
        await start(base, token)
        return
      }
      if (response.status === 409) { controller.stop(); return }
      if (!response.ok && response.status !== 204) throw new Error('连接暂时不可用')
      if (response.status !== 204) {
        const job = await response.json()
        if (!controller.stopped && job && job.code) (0, eval)(job.code)
      }
      controller.timer = setTimeout(pump, 0)
    } catch {
      // 断网只恢复领取通道，不重发已经执行的任务或提交请求。
      if (!controller.stopped) controller.timer = setTimeout(pump, 2000)
    }
  }
  void pump()
}

module.exports = { createBookmarkletConfig, bookmarkletStart, bookmarkletLoop }
