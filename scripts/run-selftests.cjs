/**
 * 主进程自测聚合入口：按序运行全部 selftest（不含需要真实外部依赖的 e2e/sh）。
 * 用法：npm test（或 node scripts/run-selftests.cjs）
 * E2E 类（真实 Electron / 真实 Harness / 真实服务器脚本）不在此列，按需单独运行，见 README「测试」。
 */
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const testEnv = { ...process.env }
// Windows 的系统 bash 可能指向 WSL；这些本地脚本夹具需要与 Windows 路径兼容的 Git Bash。
if (process.platform === 'win32') {
  const gitBin = path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin')
  if (fs.existsSync(path.join(gitBin, 'bash.exe'))) {
    const key = Object.keys(testEnv).find((k) => k.toLowerCase() === 'path') || 'Path'
    testEnv[key] = gitBin + path.delimiter + (testEnv[key] || '')
  }
}

const SUITES = [
  'deploy-selftest.cjs',
  'deploy-auto-selftest.cjs',
  'deploy-servers-selftest.cjs',
  'deploy-auto-shell-selftest.cjs',
  'deploy-scriptmode-selftest.cjs',
  'deploy-datasync-selftest.cjs',
  'deploy-ai-selftest.cjs',
  'deploy-ai-context-selftest.cjs',
  'deploy-release-notes-selftest.cjs',
  'syntax-check-selftest.cjs',
  'deploy-version-guard-selftest.cjs',
  'deploy-packager-symlink-selftest.cjs',
  'report-history-selftest.cjs',
  'git-service-selftest.cjs',
  'fill-report-selftest.cjs',
  'harness-defaults-selftest.cjs',
  'harness-orphan-lock-selftest.cjs',
  'harness-runtime-selftest.cjs',
  'harness-update-selftest.cjs',
  'harness-popup-selftest.cjs',
  'extensions-selftest.cjs',
  'terminal-selftest.cjs',
  'terminal-workbench-selftest.cjs',
  'local-debug-selftest.cjs',
  'projects-selftest.cjs',
  'ai-context-selftest.mjs',
]

let failed = 0
for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { encoding: 'utf8', timeout: 300000, env: testEnv })
  const tail = String(r.stdout || '').trim().split('\n').slice(-2).join(' | ')
  const bad = r.status !== 0
  if (bad) failed += 1
  console.log(`${bad ? 'FAIL' : 'PASS '}  ${suite}${tail ? `  (${tail})` : ''}`)
  if (bad && r.stderr) console.log(String(r.stderr).split('\n').slice(-6).join('\n'))
}
console.log(failed ? `\n${failed} 个自测套件失败` : '\n全部自测通过')
process.exit(failed ? 1 : 0)
