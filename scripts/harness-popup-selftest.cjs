/**
 * Harness 会话弹窗自测（Windows）
 *
 * 现象：内置 DeepSeek Harness 会话运行期间，每次执行命令都会弹出一个空白的
 * PowerShell/Windows Terminal 窗口，断开会话后不再弹。
 *
 * 根因：内置运行时用 Electron 自带 Node 跑 dsh（ELECTRON_RUN_AS_NODE，GUI 子系统、
 * 无控制台），dsh 的 Windows Job 子进程路径（dsh-win32-process）用 CreateProcessW
 * 创建目标进程（pwsh 等）时未带 CREATE_NO_WINDOW——父进程链上没有可继承的控制台，
 * Windows 就为每个控制台程序新分配一个控制台，默认终端（Windows Terminal）弹窗。
 *
 * 验证策略（真实依赖，不用 Mock）：
 *   1. 内层进程使用 Electron Node 模式或随包 Node（均无可见控制台）；
 *   2. 调用 dsh 真实的 @deepseek-ai/dsh-subprocess-local（LocalSubprocessRuntime.spawn），
 *      走真实 Windows Job 路径（runner 进程 + CreateProcessW），spawn 真实 pwsh；
 *   3. 用 koffi（dsh 依赖树自带）EnumWindows 枚举可见终端类窗口
 *      （CASCADIA_HOSTING_WINDOW_CLASS / ConsoleWindowClass），对比 spawn 前后的增量；
 *   4. 断言命令真实执行（退出码 0 + stdout 标记文本），保证「不弹窗」不是靠
 *      「没跑命令」实现的假阴性。
 *
 * 用法：
 *   node scripts/harness-popup-selftest.cjs                     # 期望：不弹窗（修复后）
 *   node scripts/harness-popup-selftest.cjs --expect popup      # 期望：弹窗（复现根因）
 *   node scripts/harness-popup-selftest.cjs --runtime <dir>     # 指定 dsh 运行时目录
 *   node scripts/harness-popup-selftest.cjs --node <node.exe>    # 验证 Tauri 随包 Node 路径
 *                                                               #（默认 build/harness-runtime/dsh）
 * 仅 Windows 可跑；非 Windows 平台跳过。
 */
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const EXPECT = argValue('expect', 'clean') // clean | popup
const RUNTIME_DIR = path.resolve(argValue('runtime', path.join(ROOT, 'build', 'harness-runtime', 'dsh')))
const NODE_EXE = argValue('node', '')

/** 内层脚本：以生产方式（electron-as-node、无控制台）跑 dsh 真实子进程服务 */
const INNER = `
import { pathToFileURL } from 'node:url'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const RUNTIME_DIR = process.env.POPUP_RUNTIME_DIR
const runtimeP = (p) => path.join(RUNTIME_DIR, 'node_modules', p)

const { default: LocalSubprocessRuntime } = await import(pathToFileURL(
  runtimeP(path.join('@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'))).href)
const koffi = createRequire(import.meta.url)(runtimeP('koffi'))

// --- 窗口枚举（只观察，不干预） ---
const user32 = koffi.load('user32.dll')
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(void *hwnd, intptr_t lParam)')
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lparam)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)')
const GetClassNameA = user32.func('int __stdcall GetClassNameA(void *hwnd, char *buf, int max)')
const CONSOLE_CLASSES = ['CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass']
const classBuf = Buffer.alloc(64)
function consoleWindows() {
  const found = []
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return true
    if (GetClassNameA(hwnd, classBuf, classBuf.length) <= 0) return true
    const name = classBuf.toString('latin1').replace(/\\0.*$/, '')
    if (CONSOLE_CLASSES.includes(name)) found.push(String(hwnd))
    return true
  }, koffi.pointer(EnumWindowsProc))
  try { EnumWindows(cb, 0) } finally { koffi.unregister(cb) }
  return found
}

// --- dsh 解析 pwsh 的同一优先级：PowerShell 7 → PATH → Windows PowerShell 5.1 ---
function resolvePwsh() {
  const candidates = []
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'))
  for (const entry of (process.env.PATH || '').split(';')) {
    const t = entry.trim().replace(/^"|"$/g, '')
    if (t) candidates.push(path.join(t, 'pwsh.exe'))
  }
  candidates.push(path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const c of candidates) { try { if (statSync(c).isFile()) return c } catch {} }
  throw new Error('未找到 pwsh/powershell')
}

// --- 最小 cordis ctx stub（Service 需要 reflect.provide 与 effect） ---
let disposer = null
const ctx = {
  reflect: { provide() {} },
  effect(fn) { disposer = fn(); return () => {} },
  logger: { warn() {}, info() {}, debug() {} },
}

const MARKER = 'POPUP-PROBE-OK'
const result = { ok: false }
try {
  const runtime = new LocalSubprocessRuntime(ctx)
  result.mode = runtime.selectContainmentMode('ordinary')
  const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-popup-'))
  const baseline = new Set(consoleWindows())
  const handle = runtime.spawn({
    argv: [resolvePwsh(), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Start-Sleep -Seconds 4; Write-Output ' + MARKER],
    cwd,
    graceMs: 8000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1048576 }, stderr: { maxBytes: 65536 } },
  })
  result.pid = handle.pid
  result.maxNewWindows = 0
  for (const delay of [1200, 2400, 3400]) {
    await new Promise((r) => setTimeout(r, delay))
    const now = consoleWindows().filter((h) => !baseline.has(h))
    result.maxNewWindows = Math.max(result.maxNewWindows, now.length)
  }
  const outcome = await handle.done
  result.exitCode = outcome.exitCode
  result.signal = outcome.signal
  result.stdout = handle.collected.stdout ? handle.collected.stdout.finalize().text : ''
  result.markerSeen = result.stdout.includes(MARKER)
  result.ok = true
} catch (error) {
  result.error = String((error && error.stack) || error)
}
try { await disposer?.() } catch {}
console.log(JSON.stringify(result))
process.exit(result.ok ? 0 : 1)
`

function main() {
  if (process.platform !== 'win32') {
    console.log('  （非 Windows 平台跳过：弹窗问题仅存在于 Windows）')
    return 0
  }
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const runnerExe = NODE_EXE ? path.resolve(NODE_EXE) : electronExe
  if (!fs.existsSync(runnerExe)) throw new Error(`未找到运行时：${runnerExe}`)
  const entry = path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js')
  if (!fs.existsSync(entry)) throw new Error(`未找到 dsh 运行时：${RUNTIME_DIR}`)

  const innerFile = path.join(os.tmpdir(), `dsh-popup-inner-${Date.now()}.mjs`)
  fs.writeFileSync(innerFile, INNER, 'utf8')

  console.log(`=== Harness 弹窗自测（期望=${EXPECT}，运行时=${RUNTIME_DIR}） ===`)
  const child = spawn(runnerExe, [innerFile], {
    env: { ...process.env, ...(NODE_EXE ? {} : { ELECTRON_RUN_AS_NODE: '1' }), POPUP_RUNTIME_DIR: RUNTIME_DIR },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => (out += d))
  child.stderr.on('data', (d) => (err += d))
  child.once('exit', (code) => {
    fs.rmSync(innerFile, { force: true })
    let r = null
    try { r = JSON.parse(out.trim().split('\n').pop()) } catch { /* 保持 null */ }
    if (!r) {
      console.log('内层进程未产出结果：')
      console.log('stdout:', out.slice(-1500))
      console.log('stderr:', err.slice(-1500))
      process.exit(1)
    }
    if (r.ok === false || r.error) {
      console.log('内层执行失败：', r.error || '(未知)')
      console.log('stderr 尾部:', err.slice(-1000))
      process.exit(1)
    }
    let failed = 0
    const assert = (name, cond, detail) => {
      if (cond) console.log(`  PASS  ${name}`)
      else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
    }
    assert('走 Windows Job 路径（本次测试的前提）', r.mode === 'windows-job', `mode=${r.mode}`)
    assert('命令真实执行（退出码 0）', r.exitCode === 0, `exitCode=${r.exitCode} signal=${r.signal}`)
    assert('stdout 捕获到标记文本', r.markerSeen === true, `stdout=${JSON.stringify(String(r.stdout).slice(0, 200))}`)
    if (EXPECT === 'popup') {
      assert('复现弹窗（运行期间出现新终端窗口）', r.maxNewWindows >= 1, `maxNewWindows=${r.maxNewWindows}`)
    } else {
      assert('无弹窗（运行期间未出现新终端窗口）', r.maxNewWindows === 0, `maxNewWindows=${r.maxNewWindows}`)
    }
    process.exit(failed ? 1 : 0)
  })
}

main()
