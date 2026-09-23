/**
 * 临时健壮性验证：端口占用 / 未安装 / 重启 / 幂等
 * 运行：node scripts/_verify-harness-robust.cjs
 */
const net = require('net')
const fs = require('fs')
const os = require('os')
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function occupy(port) {
  return await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
  })
}

/** 轮询等待服务状态出现目标值（超时返回最后状态） */
async function waitStatus(svc, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let snap = svc.status()
  while (snap.status !== target && Date.now() < deadline) {
    await sleep(400)
    snap = svc.status()
  }
  return snap
}

;(async () => {
  // ── B1 端口占用 → 自动改用空闲端口 ──
  const blocker = await occupy(3080)
  const svc = require('../electron/harness-service')

  // ── B5 运行时优先级：内置优先于本机全局安装 ──
  const launch = svc.resolveLaunch()
  check('B5 优先使用内置运行时', launch.runtime === 'bundled', `runtime=${launch.runtime} dir=${launch.runtimeDir}`)

  const s1 = await svc.start({ port: 3080 })
  check('B1 端口被占用时自动换端口', s1.status === 'running' && s1.port !== 3080,
    `status=${s1.status} port=${s1.port} error=${s1.error}`)

  // ── B4 幂等：重复 start 复用同一进程 ──
  const s2 = await svc.start({ port: 3080 })
  check('B4 重复 start 复用同一进程', s2.pid === s1.pid && s2.status === 'running', `pid ${s1.pid} → ${s2.pid}`)

  // ── B3 重启：旧进程消失、新进程接管 ──
  const oldPid = s1.pid
  const s3 = await svc.restart({ port: 3080 })
  await sleep(1200)
  check('B3 重启后新进程接管', s3.status === 'running' && s3.pid !== oldPid, `pid ${oldPid} → ${s3.pid}`)
  check('B3b 重启后旧进程已退出', !alive(oldPid), `oldPid=${oldPid} alive=${alive(oldPid)}`)
  svc.stop()
  blocker.close()
  await sleep(500)

  // ── B6 启动中点停止：作废进行中的启动，随后仍可正常重新拉起 ──
  // （必须在 B2 前执行：B2 会把环境变量指向空目录以模拟未安装，污染后续用例）
  delete require.cache[require.resolve('../electron/harness-service')]
  const svc3 = require('../electron/harness-service')
  const inflight = svc3.start({ port: 0 })
  await sleep(1500) // 进入 starting（加载插件 / 等待服务地址）
  svc3.stop()
  const s6 = await inflight
  check('B6 启动中停止后结果为 stopped（不被就绪覆盖）', s6.status === 'stopped', `status=${s6.status}`)
  await sleep(800)
  const s7 = await svc3.start({ port: 0 })
  check('B6b 作废后可重新启动', s7.status === 'running' && s7.pid > 0, `status=${s7.status} error=${s7.error}`)
  svc3.stop()
  await sleep(500)

  // ── B7 超时翻正：超时只是等待上限，服务随后就绪时状态从 error 翻回 running ──
  // 真实场景：自启动与仓库扫描预热并发时插件加载可能超 90 秒，超时后服务
  // 实际仍在继续初始化并最终输出地址——此前该行被丢弃，状态永远卡在 error
  const p7 = await svc3.start({ port: 0, readyTimeoutMs: 1200 })
  check('B7 注入短超时后按超时返回 error', p7.status === 'error' && /启动超时/.test(p7.error),
    `status=${p7.status} error=${p7.error}`)
  const s7t = await waitStatus(svc3, 'running', 30000)
  check('B7b 迟到就绪行把状态翻正为 running', s7t.status === 'running' && !!s7t.url,
    `status=${s7t.status} url=${s7t.url ? '(有)' : '(无)'}`)
  check('B7c 翻正后进程存活且端口真实监听', alive(s7t.pid) && (await portOpen(s7t.port)),
    `pid=${s7t.pid} alive=${alive(s7t.pid)} port=${s7t.port}`)
  svc3.stop()
  await sleep(500)

  // ── B2 未安装 → 明确安装提示（屏蔽内置运行时 + 临时空环境屏蔽本机 dsh）──
  const empty = path.join(os.tmpdir(), `pm-harness-empty-${Date.now()}`)
  process.env.APPDATA = empty
  process.env.ProgramFiles = empty
  process.env.USERPROFILE = empty
  process.env.DSH_HOME = path.join(empty, '.dsh')
  process.env.DSH_RUNTIME_DIR = path.join(empty, 'runtime') // 指向空目录 = 无内置运行时
  delete process.env.DSH_CLI
  // 重新加载模块以清空内部状态
  delete require.cache[require.resolve('../electron/harness-service')]
  const svc2 = require('../electron/harness-service')
  const s4 = await svc2.start()
  check('B2 未安装时给出安装提示', s4.status === 'error' && /npm i -g @deepseek-ai\/dsh/.test(s4.error), `error=${s4.error}`)

  // ── B8 自启动失败自动重试一次（retryOnFail）──
  // 假 dsh：标记文件存在时保持沉默（触发超时），不存在时打印就绪行后驻留。
  // 目录名故意带空格：cmd /d /s /c 的命令行没按 ""<命令>" <参数…>" 构造时（或缺 windowsVerbatimArguments），
  // 只会去执行「...\pm-harness」这一段，进程立即非零退出
  const fakeDir = path.join(os.tmpdir(), `pm-harness fake-${Date.now()}`)
  fs.mkdirSync(fakeDir, { recursive: true })
  const fakeCli = path.join(fakeDir, 'fake-dsh.cmd')
  const flag = path.join(fakeDir, 'fail-flag')
  fs.writeFileSync(fakeCli, [
    '@echo off',
    'if exist "%~dp0fail-flag" (',
    '  ping -n 20 127.0.0.1 >nul',
    ') else (',
    '  echo dsh web: http://127.0.0.1:3999/?token=t',
    '  ping -n 60 127.0.0.1 >nul',
    ')',
  ].join('\r\n'), 'ascii')
  fs.writeFileSync(flag, '1', 'ascii')
  process.env.DSH_CLI = fakeCli
  const seenStatuses = []
  svc2.setEmitter((snap) => seenStatuses.push(snap.status))
  const startPromise = svc2.start({ port: 0, retryOnFail: true, readyTimeoutMs: 1000 })
  // 固定时序等第一轮短超时触发（不能轮询 error：B2 的残留 error 态会立即误命中）
  await sleep(3000)
  fs.rmSync(flag, { force: true }) // 重试间隔内移除标记 → 第二轮可就绪
  const s8 = await startPromise
  check('B8 失败后自动重试并最终就绪', s8.status === 'running' && !!s8.url,
    `status=${s8.status} error=${s8.error}`)
  check('B8b 重试链路确实经历过 error 态', seenStatuses.includes('error'),
    `seen=${[...new Set(seenStatuses)].join(',')}`)
  svc2.stop()
  await sleep(800)

  // ── B9 重试等待期内用户停止：放弃重试，无进程残留 ──
  fs.writeFileSync(flag, '1', 'ascii')
  const p9 = svc2.start({ port: 0, retryOnFail: true, readyTimeoutMs: 1000 })
  const errSnap = await waitStatus(svc2, 'error', 15000)
  const strayPid = errSnap.pid // 超时保留的现场进程
  svc2.stop()
  const s9 = await p9
  check('B9 重试等待期停止后结果为 stopped', s9.status === 'stopped', `status=${s9.status}`)
  await sleep(11000) // 跨过 8 秒重试间隔（RETRY_DELAY_MS）
  const s9b = svc2.status()
  check('B9b 停止后不再自动重试', s9b.status === 'stopped', `status=${s9b.status}`)
  check('B9c 超时现场进程已被回收', !alive(strayPid), `pid=${strayPid} alive=${alive(strayPid)}`)
  svc2.stop()

  console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
  process.exit(failed ? 1 : 0)
})()
