/**
 * dsh-win32-process 的 CREATE_NO_WINDOW 补丁（构建期与运行时热更新共用同一份实现）
 *
 * 为什么需要：dsh 的 Windows Job 子进程路径用 CreateProcessW 创建目标进程（pwsh 等）
 * 时不带 CREATE_NO_WINDOW，而内置运行时以 ELECTRON_RUN_AS_NODE 跑 dsh——进程链上
 * 没有任何控制台，Windows 只能为每个控制台程序新分配一个，默认终端（Windows Terminal）
 * 就会弹窗：Harness 会话每执行一次命令弹一个空白终端窗口。
 *
 * 补丁给三处创建标志位补上 CREATE_NO_WINDOW(0x08000000)：
 *   - 普通目标 CreateProcessW：   1028（SUSPENDED|UNICODE_ENV）→ 134218756
 *   - 受限令牌 Job：              4（SUSPENDED）→ 134217732
 *   - 受限令牌探测（管道版）：    0 → 134217728
 *
 * 期望字面量必须恰好命中 1 次，否则抛错：dsh 升级若改了这三处代码，构建（或热更新）
 * 会直接失败而不是静默出一个带弹窗问题的版本。
 */
const fs = require('fs')
const path = require('path')

/**
 * 补丁号：补丁内容变化时递增。写进随包版本标记与热更新标记，
 * 值不同会触发客户端重新解包/拒绝复用旧树。
 */
const WIN32_NO_WINDOW_PATCH = 1

/** 补丁后文件中必然出现的字面量（用于判断是否已打过补丁） */
const PATCH_MARKER = '134218756'

/** dsh-win32-process 相对运行时目录的路径（运行时目录 → dsh/node_modules/...） */
const RELATIVE_FILE = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js']

const REPLACEMENTS = [
  ['null, null, 1, 1028, environment', 'null, null, 1, 134218756, environment'],
  ['createRestrictedProcess(api, options, commandLine, 4, startupInfo, processInfo)',
    'createRestrictedProcess(api, options, commandLine, 134217732, startupInfo, processInfo)'],
  ['options.args), 0, startupInfo, processInfo) === 0', 'options.args), 134217728, startupInfo, processInfo) === 0'],
]

/**
 * 给一个 dsh-win32-process 的 index.js 打补丁（幂等）
 * @returns {{ patched: boolean, reason?: string }}
 */
function patchFile(file) {
  if (!fs.existsSync(file)) throw new Error(`未找到 dsh-win32-process 的入口文件：${file}`)
  const source = fs.readFileSync(file, 'utf8')
  if (source.includes(PATCH_MARKER)) return { patched: false, reason: 'already' }
  let patched = source
  for (const [from, to] of REPLACEMENTS) {
    const count = patched.split(from).length - 1
    if (count !== 1) {
      throw new Error(`dsh-win32-process 补丁点期望出现 1 次实际 ${count} 次：「${from}」——dsh 版本可能已变化，请核对进程创建标志`)
    }
    patched = patched.replace(from, to)
  }
  fs.writeFileSync(file, patched)
  return { patched: true }
}

/** 运行时目录（含 dsh/）→ 打补丁；非 Windows 无需补丁，直接返回 skipped */
function patchRuntime(runtimeDir) {
  if (process.platform !== 'win32') return { patched: false, reason: 'not-win32' }
  return patchFile(path.join(runtimeDir, ...RELATIVE_FILE))
}

/** 运行时目录内的 dsh-win32-process 是否已带补丁（文件缺失返回 false） */
function isRuntimePatched(runtimeDir) {
  try {
    return fs.readFileSync(path.join(runtimeDir, ...RELATIVE_FILE), 'utf8').includes(PATCH_MARKER)
  } catch {
    return false
  }
}

module.exports = {
  WIN32_NO_WINDOW_PATCH,
  patchFile,
  patchRuntime,
  isRuntimePatched,
  RELATIVE_FILE,
}
