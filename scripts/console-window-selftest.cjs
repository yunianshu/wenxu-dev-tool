/**
 * 外部终端可见性自测：断言「外部 PowerShell」与「本地调试 start.bat」在**没有可见控制台的进程**里
 * 被调用时，仍然开出可见的新控制台窗口。
 *
 * 为什么要有这个自测：Tauri 侧后台 Node 由 GUI 主进程以 CREATE_NO_WINDOW 启动（有隐藏控制台但没窗口），
 * 直接 spawn 的控制台程序会继承那个隐藏控制台，窗口永远不出现——用户看到的就是「点了没反应」。
 * 现场由 PowerShell 的 ProcessStartInfo.CreateNoWindow 复现（它就是这个标志的等价入口），
 * 探针进程先自证「我确实没有可见控制台」，再调用生产入口，由被启动的程序自己报告控制台窗口是否可见。
 * 注意不能用 node 的 windowsHide 代替：那是「完全没有控制台」，cmd 的 start 在里面也会失败，
 * 与运行现场不是一回事。
 *
 * 副作用：会短暂弹出 1~2 个控制台窗口，报告写完即自行退出（report.ps1 末尾 exit）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// 报告脚本只用 ASCII：无 BOM 的 .ps1 会被 Windows PowerShell 当作 ANSI 读，中文会破坏解析。
// 这里是文件内容（不是命令行），C# 里的双引号直接写，不要用命令行那套 \" 转义
const REPORT_PS1 = [
  'param([string]$Marker)',
  'try {',
  "  Add-Type -Namespace K -Name C -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();' -ErrorAction Stop",
  "  Add-Type -Namespace U -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);' -ErrorAction Stop",
  '  $h = [K.C]::GetConsoleWindow()',
  "  if ($h -eq [IntPtr]::Zero) { $state = 'nohandle' } elseif ([U.W]::IsWindowVisible($h)) { $state = 'visible' } else { $state = 'hidden' }",
  '} catch { $state = "error: $($_.Exception.Message)" }',
  'Set-Content -LiteralPath $Marker -Value $state -Encoding ascii',
  'exit 0',
  '',
].join('\r\n').replace(/\\"/g, '"')

/** 以 CreateNoWindow 启动探针（复现 Tauri 后台进程的现场） */
const LAUNCH_HIDDEN_PS1 = [
  'param([string]$Probe, [string]$LogDir)',
  '$psi = New-Object System.Diagnostics.ProcessStartInfo',
  "$psi.FileName = 'node.exe'",
  '$psi.Arguments = "`"$Probe`" `"$LogDir`""',
  "$psi.WorkingDirectory = '" + ROOT.replace(/'/g, "''") + "'",
  '$psi.UseShellExecute = $false',
  '$psi.CreateNoWindow = $true',
  '$p = [System.Diagnostics.Process]::Start($psi)',
  '$p.WaitForExit(120000) | Out-Null',
  'if (-not $p.HasExited) { $p.Kill() }',
  'exit 0',
  '',
].join('\r\n')

/** 探针：在无可见控制台的进程里调用生产入口（该进程由 LAUNCH_HIDDEN_PS1 以 CreateNoWindow 启动）。
 *  三个窗口的状态都在探针内等待到位再退出：直接 spawn 的子进程与探针共用同一个隐藏控制台，
 *  探针一退，那个控制台连同子进程就没了（新开窗口的两个不受影响，但统一等齐更稳）。 */
const PROBE_CJS = `
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const terminalService = require(${JSON.stringify(path.join(ROOT, 'electron', 'terminal-service.js'))})
const localDebug = require(${JSON.stringify(path.join(ROOT, 'electron', 'local-debug-service.js'))})
const [dir] = process.argv.slice(2)
const reportPs1 = path.join(dir, 'report.ps1')
const baselineMarker = path.join(dir, 'baseline-console.txt')
const terminalMarker = path.join(dir, 'terminal-console.txt')
const debugMarker = path.join(dir, 'debug-console.txt')
const logFile = path.join(dir, 'probe.log')
const log = (line) => fs.appendFileSync(logFile, line + '\\n')
const waitFor = (file, timeoutMs) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  return 'timeout'
}
log('probe started（本进程无可见控制台）')
// 复现条件自证：本进程直接 spawn 时，子进程应报告「没有控制台窗口」
spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', reportPs1, baselineMarker], { cwd: dir, stdio: 'ignore' })
log('baseline=' + waitFor(baselineMarker, 30000))
// 两个入口各自兜住异常：一个入口坏掉时，另一个仍要给出可见性结论（便于定位）
try {
  const terminal = terminalService.openTerminal(dir, {
    extraArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', reportPs1, terminalMarker],
  })
  log('openTerminal pid=' + (terminal.child && terminal.child.pid))
} catch (error) {
  log('openTerminal ERROR ' + error.message)
}
try {
  const debug = localDebug.run(dir)
  log('localDebug.run pid=' + (debug.child && debug.child.pid))
} catch (error) {
  log('localDebug.run ERROR ' + error.message)
}
log('terminal=' + waitFor(terminalMarker, 30000))
log('debug=' + waitFor(debugMarker, 30000))
process.exit(0)
`

function waitForMarker(file, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
    sleep(500)
  }
  return '（未收到自报）'
}

function main() {
  if (process.platform !== 'win32') {
    console.log('  （非 Windows 平台跳过：新控制台窗口是 Windows 专有行为）')
    return
  }
  // 目录名带空格：批处理路径与 /D 参数都出现空格是最容易踩的形态，现场一并盖住
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'console window selftest-'))
  const reportPs1 = path.join(tempDir, 'report.ps1')
  const launchPs1 = path.join(tempDir, 'launch-hidden.ps1')
  const probeCjs = path.join(tempDir, 'probe.cjs')
  const baselineMarker = path.join(tempDir, 'baseline-console.txt')
  const terminalMarker = path.join(tempDir, 'terminal-console.txt')
  const debugMarker = path.join(tempDir, 'debug-console.txt')

  try {
    fs.writeFileSync(reportPs1, REPORT_PS1, 'ascii')
    fs.writeFileSync(launchPs1, LAUNCH_HIDDEN_PS1, 'ascii')
    fs.writeFileSync(probeCjs, PROBE_CJS, 'utf8')
    // start.bat 在它自己那个控制台里报告状态：那就是用户看到的窗口
    fs.writeFileSync(path.join(tempDir, 'start.bat'),
      `@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "${reportPs1}" "${debugMarker}"\r\nexit /b 0\r\n`, 'ascii')

    const launched = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchPs1, probeCjs, tempDir], { timeout: 180000, encoding: 'utf8' })
    const probeLog = fs.existsSync(path.join(tempDir, 'probe.log')) ? fs.readFileSync(path.join(tempDir, 'probe.log'), 'utf8').trim() : '(无)'
    const state = (key) => {
      const line = probeLog.split('\n').find((row) => row.startsWith(`${key}=`))
      return line ? line.slice(key.length + 1).trim() : `（探针未报告 ${key}）`
    }
    assert.ok(probeLog.includes('openTerminal pid=') && probeLog.includes('localDebug.run pid='),
      `探针应在无可见控制台的进程里成功调用两个生产入口（探针日志：${probeLog}；launch stderr：${String(launched.stderr || '').slice(0, 200)}）`)
    assert.strictEqual(state('baseline'), 'nohandle', `复现条件不成立：探针本身应无可见控制台（实际 ${state('baseline')}）`)
    assert.strictEqual(state('terminal'), 'visible', `外部 PowerShell 必须拿到可见的控制台窗口（实际 ${state('terminal')}）`)
    assert.strictEqual(state('debug'), 'visible', `本地调试 start.bat 必须拿到可见的控制台窗口（实际 ${state('debug')}）`)

    console.log(`  ✓ 无可见控制台的进程里：基线 ${state('baseline')}，外部 PowerShell 与 start.bat 都开出可见窗口（${state('terminal')} / ${state('debug')}）`)
    console.log('\n外部终端可见性自测通过（3 组断言）')
  } finally {
    // 被启动的窗口/批处理可能还没完全退干净，文件短暂占用属正常：重试几次后放弃（目录在 %TEMP%）
    for (let i = 0; i < 5; i += 1) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); break } catch { sleep(1000) }
    }
  }
}

try {
  main()
} catch (err) {
  console.error('自测失败：', err)
  process.exitCode = 1
}
