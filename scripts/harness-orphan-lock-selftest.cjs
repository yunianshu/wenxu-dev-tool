/**
 * Harness 孤儿模块锁清理自测（纯文件系统，不启动 dsh）
 *
 * 验收标准（依据故障：强杀持锁中的 dsh 后，后续每次启动都在锁等待上超时）：
 * - 无锁文件：no-op，不抛错（正常路径不受影响）
 * - 锁内 PID 已死：删除锁文件（否则 dsh 启动必然超时失败）
 * - 锁内 PID 存活：不删除（有真实持有者在工作，交回正常锁等待）
 * - 锁内容非法（空 / 非数字）：不动文件、不抛错（留给 dsh 自身的锁语义处理）
 *
 * 运行：node scripts/harness-orphan-lock-selftest.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-orphan-lock-selftest-'))
// DSH_HOME 在 homeDir() 每次调用时读取：指向临时目录隔离本机真实 ~/.dsh
process.env.DSH_HOME = tmp

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}

try {
  const svc = require('../electron/harness-service')
  const lockOf = (home) => path.join(home, 'profiles', 'node_modules.lock')
  const writeLock = (home, text) => {
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
    fs.writeFileSync(lockOf(home), text)
  }

  // ── O1 无锁文件：no-op ──
  {
    const home = path.join(tmp, 'no-lock')
    fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
    process.env.DSH_HOME = home
    let threw = false
    try { svc.clearOrphanModuleLock() } catch { threw = true }
    check('O1 无锁时 no-op 不抛错', !threw && !fs.existsSync(lockOf(home)))
  }

  // ── O2 锁内 PID 已死：删除 ──
  {
    const home = path.join(tmp, 'dead-pid')
    writeLock(home, '73476\n')
    process.env.DSH_HOME = home
    svc.clearOrphanModuleLock()
    check('O2 死 PID 的孤儿锁被删除', !fs.existsSync(lockOf(home)))
  }

  // ── O3 锁内 PID 存活：不删除 ──
  {
    const home = path.join(tmp, 'live-pid')
    writeLock(home, `${process.pid}\n`)
    process.env.DSH_HOME = home
    svc.clearOrphanModuleLock()
    check('O3 活 PID 的锁保持原样', fs.existsSync(lockOf(home)) &&
      fs.readFileSync(lockOf(home), 'utf8') === `${process.pid}\n`)
  }

  // ── O4 锁内容非法：不动文件、不抛错 ──
  {
    writeLock(path.join(tmp, 'empty'), '')
    writeLock(path.join(tmp, 'garbage'), 'not-a-pid\n')
    let threw = false
    try {
      process.env.DSH_HOME = path.join(tmp, 'empty'); svc.clearOrphanModuleLock()
      process.env.DSH_HOME = path.join(tmp, 'garbage'); svc.clearOrphanModuleLock()
    } catch { threw = true }
    check('O4 非法锁内容不动文件不抛错', !threw &&
      fs.existsSync(path.join(tmp, 'empty', 'profiles', 'node_modules.lock')) &&
      fs.existsSync(path.join(tmp, 'garbage', 'profiles', 'node_modules.lock')))
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
