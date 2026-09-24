/**
 * 控制台程序的新窗口启动器（Windows）
 *
 * 为什么需要它：Tauri 侧的后台 Node 由 GUI 主进程以 CREATE_NO_WINDOW 启动，自身没有可见控制台；
 * 子控制台程序默认继承这个隐藏控制台，于是窗口永远不出现——用户看到的就是「点了没反应」
 * （Electron 时代主进程是纯 GUI 进程、没有控制台，子进程会新建可见控制台，所以那时是好的）。
 * `cmd /c start` 用 CREATE_NEW_CONSOLE 起进程，与父进程的控制台状态无关。
 *
 * 两点别踩：
 * - 不要改用 detached：Windows 下 detached 会让命令静默失效（退出码 0 但什么都没执行）；
 * - start 会把第一个加引号的参数当成窗口标题，必须留一个空标题占位。
 *
 * 返回 { child }：默认形态下 child 是立即退出的 cmd.exe 包装进程，只说明「命令已发出」；
 * 自测需要真实子进程的退出码与工作目录时用 inheritConsole: true（不新开窗口，直接 spawn）。
 */
const { spawn } = require('child_process')

function spawnInNewConsole(command, args, { cwd, inheritConsole = false } = {}) {
  if (inheritConsole) return { child: spawn(command, args, { cwd, stdio: 'ignore' }) }
  const child = spawn('cmd.exe', ['/c', 'start', '', '/D', cwd, command, ...args], { cwd, stdio: 'ignore', windowsHide: false })
  return { child }
}

module.exports = { spawnInNewConsole }
