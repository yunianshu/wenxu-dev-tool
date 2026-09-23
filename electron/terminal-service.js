/**
 * 终端服务 —— 在指定目录打开系统终端（Windows 为 PowerShell）
 *
 * 各平台行为：
 * - Windows: 在目标目录启动独立 PowerShell 窗口（detached，随主进程退出不受影响）
 * - macOS:   open -a Terminal <dir>
 * - Linux:   依次在 PATH 中探测 x-terminal-emulator / gnome-terminal / konsole /
 *            xfce4-terminal，找到第一个可用者即以对应参数启动
 */
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

/** 在 PATH 中同步探测可执行文件（Linux 无递归 PATH 搜索时使用） */
function findOnPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        fs.accessSync(full, fs.constants.X_OK)
        return full
      } catch { /* 继续探测 */ }
    }
  }
  return null
}

/**
 * 在 dir 打开终端窗口。
 * opts（测试专用）：noExit=false 时不加 -NoExit；extraArgs 追加参数；
 * 返回 { cwd, child }，child 供自测等待退出，渲染层不感知。
 */
function openTerminal(dir, opts = {}) {
  if (!dir || typeof dir !== 'string' || !dir.trim()) throw new Error('未指定目录')
  if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`)
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目录：${dir}`)

  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs : []
  let cmd, args, spawnOpts
  if (process.platform === 'win32') {
    // 注意：Windows 下 detached:true 会使 powershell -Command 静默失效（exit 0 但不执行）；
    // GUI 进程 spawn 控制台程序本身就会分配新控制台窗口，-NoExit 保持常驻，
    // 子进程默认不随 Electron 退出被杀
    cmd = 'powershell.exe'
    args = opts.noExit === false ? extraArgs : ['-NoExit', ...extraArgs]
    spawnOpts = { cwd: dir, stdio: 'ignore' }
  } else if (process.platform === 'darwin') {
    cmd = 'open'
    args = ['-a', 'Terminal', dir]
    spawnOpts = { detached: true, stdio: 'ignore' }
  } else {
    const candidates = [
      ['x-terminal-emulator', ['--working-directory', dir]],
      ['gnome-terminal', [`--working-directory=${dir}`]],
      ['konsole', ['--workdir', dir]],
      ['xfce4-terminal', ['--working-directory', dir]],
    ]
    const found = candidates.find(([c]) => findOnPath(c))
    if (!found) throw new Error('未找到可用的终端程序')
    ;[cmd, args] = found
    spawnOpts = { detached: true, stdio: 'ignore' }
  }

  // spawn 的失败（ENOENT/EACCES）是异步事件，主进程早已返回 ok：界面会提示「已打开终端」
  // 却看不到任何窗口。解释器不在 PATH 时在这里同步拦下，更罕见的情形至少留下日志。
  if (!findOnPath(cmd.replace(/\.exe$/i, ''))) {
    throw new Error(`未找到 ${cmd}（系统 PATH 异常或被杀毒软件拦截），无法打开终端`)
  }
  const child = spawn(cmd, args, spawnOpts)
  child.once('error', (err) => console.error('[terminal] 打开终端失败：', err.message))
  child.unref()
  return { cwd: dir, child }
}

module.exports = { openTerminal, findOnPath }
