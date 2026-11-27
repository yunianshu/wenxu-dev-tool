/**
 * SSH/SFTP 服务 —— 基于 ssh2，对应方案 §27 的 SftpUploader + SshExecutor：
 *   - 密码 / 私钥两种认证
 *   - exec 命令并实时回传 stdout / stderr / 退出码
 *   - SFTP 上传（进度回调）+ 服务器端 SHA256 校验
 * 连接生命周期由调用方管理：connect() → 多次 exec/upload → close()。
 */
const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')

/** 连接服务器。config: { host, port, username, authType, password, keyPath, passphrase, readyTimeout } */
function connect(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let settled = false
    const finish = (fn) => (v) => { if (!settled) { settled = true; fn(v) } }
    /** 连接断开（close/error/end 任一）时拒绝所有登记中的操作（exec/upload 可能悬挂数分钟） */
    const dropWaiters = new Set()
    const notifyDropped = (msg) => {
      for (const fn of dropWaiters) {
        try { fn(new Error(msg)) } catch { /* noop */ }
      }
      dropWaiters.clear()
    }
    conn.__dropWaiters = dropWaiters

    conn.on('ready', () => finish(resolve)(conn))
    conn.on('error', (e) => {
      let msg = (e && e.message) || String(e)
      if (/Timed out while waiting for handshake/.test(msg)) {
        msg += '（连接超时：请确认 SSH 端口正确、服务器防火墙/安全组已放行当前电脑 IP。'
          + '若 FinalShell 等工具可连而本工具超时，常见原因是服务器只放行了其他机器的 IP，'
          + '或 FinalShell 配置了跳板机/代理，或其连接端口并非 22）'
      }
      notifyDropped(`SSH 连接错误：${msg}`)
      finish(reject)(new Error(msg))
    })
    conn.on('end', () => {
      notifyDropped('SSH 连接已断开')
      finish(reject)(new Error('SSH 连接已断开'))
    })
    // 网络异常断开只触发 close（不触发 error/end）：不监听会让进行中的操作永远不落定，
    // 表现为发布卡死、界面 running 永久挂起
    conn.on('close', () => {
      notifyDropped('SSH 连接已被服务器或网络关闭')
      finish(reject)(new Error('SSH 连接已被服务器或网络关闭'))
    })

    const cfg = {
      host: config.host,
      port: Number(config.port) || 22,
      username: config.username || 'root',
      readyTimeout: config.readyTimeout || 20000,
      keepaliveInterval: 10000,
      tryKeyboard: true, // 服务器仅启用 keyboard-interactive 认证时也能用密码登录
    }
    if ((config.authType || 'password') === 'key') {
      if (!config.keyPath || !fs.existsSync(config.keyPath)) {
        return finish(reject)(new Error(`私钥文件不存在: ${config.keyPath}`))
      }
      try {
        cfg.privateKey = fs.readFileSync(config.keyPath)
      } catch (e) {
        return finish(reject)(new Error(`读取私钥失败: ${e.message}`))
      }
      if (config.passphrase) cfg.passphrase = config.passphrase
    } else {
      cfg.password = config.password || ''
    }
    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, cb) => {
      cb(prompts.map(() => cfg.password || ''))
    })
    conn.connect(cfg)
  })
}

/** 安全关闭连接（幂等） */
function close(conn) {
  if (!conn) return
  try { conn.end() } catch { /* 已断开则忽略 */ }
}

/** 把 exec 阶段的底层错误转成可操作的提示 */
function enhanceExecError(e) {
  const msg = (e && e.message) || String(e)
  if (/Channel open failure|open failed/i.test(msg)) {
    return new Error(
      msg + ' —— 服务器拒绝了命令执行通道：该账号很可能被限制为仅 SFTP（sshd 配置了 '
      + 'ForceCommand internal-sftp）或没有 shell 权限。请检查服务器 /etc/ssh/sshd_config '
      + '中该用户的 Match 配置，或改用有 shell 执行权限的账号',
    )
  }
  return e
}

/**
 * 执行命令。onLine(chunkText, stream) 每收到一段输出回调一次（仅供日志流式展示，
 * chunk 边界可能切断多字节字符，展示用途可接受；完整结果以返回值的 stdout/stderr 为准）。
 * stdout/stderr 先按 Buffer 累积、结束时一次性按 UTF-8 解码——大数据量（如 psql 导出
 * 数十 MB 含中文/多字节文本）时逐 chunk toString 会把跨界多字节字符损坏成替换符。
 * 连接中途断开时立即拒绝（发布脚本可运行数分钟，不能等到超时）。
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function exec(conn, command, onLine) {
  return new Promise((resolve, reject) => {
    const dropWaiters = conn.__dropWaiters
    const onDrop = (e) => reject(e)
    const off = () => { if (dropWaiters) dropWaiters.delete(onDrop) }
    if (dropWaiters) dropWaiters.add(onDrop)
    conn.exec(command, (err, stream) => {
      if (err) { off(); return reject(enhanceExecError(err)) }
      const outBufs = []
      const errBufs = []
      stream.on('data', (d) => {
        outBufs.push(d)
        if (onLine) onLine(d.toString('utf8'), 'stdout')
      })
      stream.stderr.on('data', (d) => {
        errBufs.push(d)
        if (onLine) onLine(d.toString('utf8'), 'stderr')
      })
      stream.on('error', (e) => { off(); reject(e) })
      stream.on('close', (code) => {
        off()
        resolve({
          code: code || 0,
          stdout: Buffer.concat(outBufs).toString('utf8'),
          stderr: Buffer.concat(errBufs).toString('utf8'),
        })
      })
    })
  })
}

/**
 * 执行命令并把 stdout 流式写入本地文件（环境同步经本机中转发布包或数据库导出）。
 * stdout 是二进制数据，不转字符串；stderr 累积后返回；带背压，大文件不占内存。
 * onProgress(receivedBytes) 持续回调；断连立即拒绝。
 * @returns {Promise<{code: number, stderr: string, bytes: number}>}
 */
function execToFile(conn, command, localPath, onProgress) {
  return new Promise((resolve, reject) => {
    const dropWaiters = conn.__dropWaiters
    const onDrop = (e) => reject(e)
    const off = () => { if (dropWaiters) dropWaiters.delete(onDrop) }
    if (dropWaiters) dropWaiters.add(onDrop)
    const output = fs.createWriteStream(localPath)
    let settled = false
    const finish = (fn) => (v) => {
      if (settled) return
      settled = true
      off()
      output.destroy()
      fn(v)
    }
    output.on('error', finish(reject))
    conn.exec(command, (err, stream) => {
      if (err) return finish(reject)(enhanceExecError(err))
      const errBufs = []
      let bytes = 0
      stream.stderr.on('data', (d) => errBufs.push(d))
      stream.on('data', (d) => { bytes += d.length; if (onProgress) onProgress(bytes) })
      stream.on('error', finish(reject))
      // 等本地文件落盘后再落定，调用方可立即读取或计算校验和
      stream.on('close', (code) => output.end(() => finish(resolve)({
        code: code || 0, stderr: Buffer.concat(errBufs).toString('utf8'), bytes,
      })))
      stream.pipe(output)
    })
  })
}

/**
 * SFTP 上传文件。onProgress(uploadedBytes, totalBytes) 持续回调；断连立即拒绝。
 * @returns {Promise<{remotePath: string}>}
 */
function upload(conn, localPath, remotePath, onProgress) {
  return new Promise((resolve, reject) => {
    const dropWaiters = conn.__dropWaiters
    const onDrop = (e) => reject(e)
    const off = () => { if (dropWaiters) dropWaiters.delete(onDrop) }
    if (dropWaiters) dropWaiters.add(onDrop)
    conn.sftp((err, sftp) => {
      if (err) { off(); return reject(err) }
      sftp.fastPut(localPath, remotePath, {
        step: (transferred, chunk, total) => { if (onProgress) onProgress(transferred, total) },
      }, (e2) => {
        off()
        sftp.end() // 及时释放通道：sshd MaxSessions 较低的机器开多了会被拒
        e2 ? reject(e2) : resolve({ remotePath })
      })
    })
  })
}

/** 在服务器上递归创建目录（mkdir -p 语义，逐段创建避免依赖 shell；共用一条 SFTP 通道） */
function mkdirp(conn, remoteDir) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      const dirs = String(remoteDir).split('/').filter(Boolean)
      let cur = String(remoteDir).startsWith('/') ? '' : '.'
      const step = () => {
        if (!dirs.length) {
          sftp.end()
          return resolve()
        }
        cur = `${cur}/${dirs.shift()}`
        sftp.mkdir(cur, () => step()) // 已存在时 mkdir 报错，静默忽略
      }
      step()
    })
  })
}

/** 规范化远端路径（POSIX 风格） */
function remoteJoin(...parts) {
  const joined = parts.filter(Boolean).join('/')
  return joined.replace(/\/{2,}/g, '/')
}

module.exports = { connect, close, exec, execToFile, upload, mkdirp, remoteJoin }
