/**
 * script 形态打包命令的 shell 环境自测（无框架，node scripts/deploy-package-shell-selftest.cjs 直接运行）
 *
 * 背景：应用的进程 PATH 通常只有 Git\cmd（不含 bash.exe），而 System32 在 PATH 前部。
 * Windows 装了 WSL 后（System32\bash.exe），deploy-service 的打包命令 `bash package.sh`
 * 会被 cmd.exe 解析到 WSL bash——WSL 里没有 Windows 工具链（uv/maven 等，bash exec
 * 也不解析 .exe），打包即 127 退出。
 *
 * 验证策略：
 *   - findGitBashDir/localShellEnv 走真实实现（不桩 fs/path）；
 *   - 业务行为用真实子进程断言：剥掉所有 Git 目录的窄 PATH（模拟 explorer 启动的应用环境）下，
 *     spawn('bash -c "uname -s"', { shell:true, env: localShellEnv() }) 必须输出 MINGW64*；
 *     对照组（不前置 Git Bash）不允许输出 MINGW64（证明修复必要且生效差异真实存在）。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

// ── electron 打桩（deploy-service 依赖链需要）──
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => fs.mkdtempSync(path.join(require('os').tmpdir(), 'pkg-shell-')) }, safeStorage: { isEncryptionAvailable: () => false } },
}
const { findGitBashDir, localShellEnv } = require('../electron/deploy/deploy-service')

const { spawnSync } = require('child_process')

/** 模拟应用进程环境：剔除 PATH 里所有 Git 相关目录（保留 System32 等系统目录） */
function narrowEnv() {
  const env = { ...process.env }
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path'
  const kept = String(env[key] || '')
    .split(';')
    .filter((dir) => {
      const d = dir.trim().toLowerCase().replace(/[\\/]+$/, '')
      if (!d) return false
      if (d.endsWith('\\git\\cmd') || d.endsWith('\\git\\bin') || d.endsWith('\\git\\usr\\bin') || d.endsWith('\\git\\mingw64\\bin')) return false
      return true
    })
  env[key] = kept.join(';')
  return env
}

function runBashUname(env) {
  const r = spawnSync('bash -c "uname -s; command -v bash"', { shell: true, env, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}

if (process.platform !== 'win32') {
  assert.equal(findGitBashDir(), null, '非 Windows 平台 findGitBashDir 必须返回 null')
  const env = localShellEnv()
  assert.equal(env.PATH, process.env.PATH, '非 Windows 平台不得改动 PATH')
  console.log('非 Windows 平台：仅验证函数返回约束，通过')
  process.exit(0)
}

// ── findGitBashDir：本机装了 Git for Windows 时必须能定位 ──
const bashDir = findGitBashDir()
if (bashDir) {
  assert.ok(fs.existsSync(path.join(bashDir, 'bash.exe')), `定位的目录 ${bashDir} 下必须有 bash.exe`)
  console.log(`findGitBashDir → ${bashDir}`)
} else {
  console.log('本机未检出 Git for Windows，跳过依赖 Git 的真实子进程断言')
}

// ── localShellEnv：前置且不产生重复 PATH 键 ──
const shellEnv = localShellEnv()
const envKeys = Object.keys(shellEnv)
const pathKeys = envKeys.filter((k) => k.toLowerCase() === 'path')
assert.equal(pathKeys.length, 1, `环境里只能有一个 PATH 键，实际：${pathKeys.join(',')}`)
if (bashDir) {
  assert.ok(shellEnv[pathKeys[0]].startsWith(`${bashDir};`), 'Git Bash 目录必须前置到 PATH 首位')
}
// 未传入的键保持原样（不丢系统环境）
assert.ok(envKeys.length >= Object.keys(process.env).length - 1, '不得丢弃原有环境变量')

// ── 业务行为：窄 PATH（模拟应用进程）下 bash 必须命中 Git Bash ──
const narrow = narrowEnv()
const fixed = runBashUname({ ...narrow, ...localShellEnv() })
assert.equal(fixed.status, 0, `修复后 bash 应可执行且退出 0，stderr：${fixed.err}`)
assert.ok(/^MINGW64/i.test(fixed.out), `bash 必须命中 Git Bash（uname 输出 MINGW64*），实际输出：${fixed.out.trim()}`)
console.log(`修复后（localShellEnv）→ ${fixed.out.trim().split('\n').join(' | ')}`)

// ── 对照组：不前置 Git Bash 的窄 PATH 下，bash 不允许是 Git Bash（证明差异真实） ──
const hasWslBash = fs.existsSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'bash.exe'))
const control = runBashUname(narrow)
if (!hasWslBash) {
  console.log('本机无 System32\\bash.exe（WSL），对照组按「找不到 bash 或非 MINGW64」校验')
}
assert.ok(!/^MINGW64/i.test(control.out), `未修复的窄 PATH 不应命中 Git Bash，实际输出：${control.out.trim()}`)
console.log(`对照组（未前置）→ status=${control.status} out=${control.out.trim().split('\n').join(' | ') || '(空)'}：差异确认`)

console.log('deploy-package-shell-selftest 全部通过')
