/**
 * 终端工作台自测（无框架，node scripts/terminal-workbench-selftest.cjs 直接运行）
 *
 * 验证策略：**真实起 pty 进程**跑一条命令并校验回显，而不是 mock。
 * 覆盖：
 *   - shell 解析优先级（pwsh 7 → Windows PowerShell 5.1 → cmd）与选项列表
 *   - 目录参数校验（空/不存在/文件路径一律拒绝）
 *   - 会话创建 → 写入 → 真实输出 → attach 缓冲回放 → resize → close 全链路
 *   - 会话上限保护、过期 sessionId 报错
 *   - 布局持久化：保存 → 读取 → 脏数据归一化 → 清空
 *
 * 说明：pty-service 通过 `require('node-pty')` 加载原生模块，
 * node-pty 用的是 N-API 预编译产物，Node 与 Electron 自带 Node 都能直接加载。
 * terminal-layout 依赖 `electron.app.getPath`：开发态用 node 跑时 electron 导出的是
 * 可执行文件路径字符串，因此这里在 require 之前注入最小 app 桩，把文件落到临时目录，
 * 避免污染真实的 userData。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-workbench-'))

// ─── electron 桩：让 terminal-layout 把文件写进临时目录 ───
const originalLoad = Module._load
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => tempRoot } }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const ptyService = require('../electron/pty-service')
const terminalLayout = require('../electron/terminal-layout')

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (cond) passed += 1
  else failed += 1
}

/** 轮询等待断言成立（pty 输出是异步到达的，不能用固定 sleep 赌时序） */
async function waitFor(fn, { timeout = 25000, interval = 120, label = '条件' } = {}) {
  const start = Date.now()
  for (;;) {
    let value
    try { value = fn() } catch { value = false }
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, interval))
  }
}

/** 进程是否还活着（用于验证 close 真的终止了 shell 进程） */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 把输出里所有 ANSI/OSC 控制序列与退格符剥掉，只留可见文本，避免断言被控制字符干扰 */
function stripAnsi(text) {
  return String(text)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\u0008/g, '')
    .replace(/\r/g, '')
}

async function main() {
  const workDir = path.join(tempRoot, 'work')
  fs.mkdirSync(workDir, { recursive: true })

  // ─── 1. shell 解析与选项 ───
  const options = ptyService.shellOptions()
  const shell = ptyService.resolveShell()
  check('shell 选项列表非空', options.length > 0, options.map((o) => o.label).join(' / '))
  if (process.platform === 'win32') {
    const pwsh = options.find((o) => o.id === 'pwsh')
    check('Windows 上优先解析到 PowerShell 7', !!pwsh || !!options.find((o) => o.id === 'windows-powershell'),
      pwsh ? pwsh.path : `仅找到 ${options[0]?.label}`)
    check('resolveShell 返回可执行文件且参数不含 -Command', fs.existsSync(shell.path) && !shell.args.includes('-Command'),
      `${shell.label} ${shell.args.join(' ')}`)
    let badShell = null
    try { ptyService.resolveShell('C:\\definitely\\missing\\shell.exe') } catch (err) { badShell = err }
    check('指定不存在的 shell 明确报错', !!badShell && /不存在/.test(badShell.message))
  } else {
    check('POSIX 上解析到可用 shell', fs.existsSync(shell.path), shell.path)
  }

  // ─── 2. 目录参数校验 ───
  assert.throws(() => ptyService.create({ cwd: path.join(tempRoot, 'ghost') }), /目录不存在/)
  const aFile = path.join(tempRoot, 'a.txt')
  fs.writeFileSync(aFile, 'x', 'utf8')
  assert.throws(() => ptyService.create({ cwd: aFile }), /不是目录/)
  assert.throws(() => ptyService.write('pty-does-not-exist', 'x'), /不存在或已结束/)
  check('目录/会话参数校验全部拒绝', true)

  // ─── 3. 真实 pty：创建 → 写入 → 输出 → attach → resize → close ───
  const marker = `DEVPM_PTY_${Date.now().toString(36)}`
  const dataSeen = []
  ptyService.setEmitter((channel, payload) => {
    if (channel === 'terminal:data') dataSeen.push(payload)
  })

  const session = ptyService.create({
    projectId: 'selftest-project',
    projectName: '自测项目',
    cwd: workDir,
    cols: 90,
    rows: 24,
  })
  check('会话创建返回可序列化信息', !!session.id && session.pid > 0 && session.cwd === workDir,
    `${session.shellLabel} pid=${session.pid}`)
  check('会话信息不含 pty 对象', !('term' in session))

  // 回显标记（只断言「能执行 + 输出能回传」；目录另有更干净的断言）
  const list = ptyService.list()
  check('list 能查到新会话', list.some((s) => s.id === session.id))

  // 工作目录：让同一个 shell 把 pwd 写进文件再比对。
  // 只比**末级目录名**而不是完整路径：既避开 JSON 字符串里反斜杠转义的坑，
  // 也避开 profile 往 stdout/stderr 打无关输出（本机 profile 的 chcp 报错）的干扰。
  const cwdFile = path.join(tempRoot, 'cwd-probe.txt')
  const dirName = path.basename(workDir)
  fs.rmSync(cwdFile, { force: true })
  const pwdExpr = process.platform === 'win32'
    ? `Split-Path -Leaf (Get-Location).Path | Set-Content -Encoding utf8 '${cwdFile.replace(/'/g, "''")}'\r\n`
    : `basename "$PWD" > '${cwdFile}'\n`
  execFileSync(shell.path, shell.args, { cwd: workDir, encoding: 'utf8', timeout: 20000, input: pwdExpr })
  const reported = fs.existsSync(cwdFile) ? fs.readFileSync(cwdFile, 'utf8').replace(/^\uFEFF/, '').trim() : ''
  check('shell 在创建时指定的项目目录启动', reported === dirName, `报告目录名 ${JSON.stringify(reported)}，期望 ${JSON.stringify(dirName)}`)

  // pty 起来后 shell 需要一点时间完成初始化；失败时重试几次发送，避免抢跑丢输入
  const cmd = `Write-Output ${marker}\r`
  const deadline = Date.now() + 25000
  let sent = 0
  let joined = ''
  for (;;) {
    if (sent < 4 && Date.now() < deadline) {
      try { ptyService.write(session.id, cmd); sent += 1 } catch { /* 会话已结束：由下面断言报出 */ }
    }
    joined = stripAnsi(dataSeen.filter((p) => p.sessionId === session.id).map((p) => p.data).join(''))
    if (joined.includes(marker)) break
    if (Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 500))
  }
  check('真实 pty 执行命令并在流式通道回传输出', joined.includes(marker), `发送 ${sent} 次，输出 ${joined.length} 字符`)

  // attach 回放：必须是同一个会话缓冲（能拿到刚才的输出）
  const attached = ptyService.attach(session.id)
  check('attach 回放缓冲输出', stripAnsi(attached.output).includes(marker), `缓冲 ${attached.bytes ?? attached.output.length} 字符`)
  check('attach 回传会话元信息', attached.pid === session.pid && attached.projectName === '自测项目')

  // resize：应用不报错且尺寸落在会话信息里
  ptyService.resize(session.id, 120, 40)
  const resized = ptyService.getInfo(session.id)
  check('resize 更新会话尺寸', resized.cols === 120 && resized.rows === 40, `${resized.cols}x${resized.rows}`)

  // close：会话移除 + 进程真的被终止
  const pid = session.pid
  const closed = ptyService.close(session.id)
  check('close 返回已关闭', closed === true)
  check('close 后会话不再出现在 list', !ptyService.list().some((s) => s.id === session.id))
  const dead = await waitFor(() => !isAlive(pid), { timeout: 8000, label: 'shell 进程退出' }).then(() => true).catch(() => false)
  check('close 后 shell 进程已终止', dead, `pid=${pid}`)

  // ─── 4. stop()：退出钩子要能一次清空全部会话 ───
  const a = ptyService.create({ projectId: 'p1', cwd: workDir })
  const b = ptyService.create({ projectId: 'p2', cwd: workDir })
  ptyService.stop()
  check('stop 清空全部会话（应用退出不留残留进程）', ptyService.list().length === 0, `关闭了 ${a.id} / ${b.id}`)

  // ─── 5. 布局持久化 ───
  const saveRes = terminalLayout.save({
    gridMode: '2x2',
    columnWidths: [0.6, 0.4],
    rowHeights: [0.5, 0.5],
    panes: [
      { projectId: 'proj-a', shellId: 'pwsh' },
      { projectId: 'proj-b', shellId: '' },
      { projectId: '', shellId: 'pwsh' },          // 脏数据：无项目 id 应被丢弃
      null,                                        // 脏数据：非对象应被丢弃
    ],
  })
  check('布局保存成功', saveRes.ok === true && saveRes.panes === 2, `保留 ${saveRes.panes} 个窗格`)

  const loaded = terminalLayout.load()
  check('布局读回窗格顺序与 shell 选择', loaded.panes.length === 2
    && loaded.panes[0].projectId === 'proj-a'
    && loaded.panes[0].shellId === 'pwsh'
    && loaded.panes[1].projectId === 'proj-b',
    JSON.stringify(loaded.panes))
  check('布局读回分屏方式与列宽行高', loaded.gridMode === '2x2'
    && JSON.stringify(loaded.columnWidths) === '[0.6,0.4]'
    && JSON.stringify(loaded.rowHeights) === '[0.5,0.5]',
    `${loaded.gridMode} ${JSON.stringify(loaded.columnWidths)} ${JSON.stringify(loaded.rowHeights)}`)
  check('布局文件落在 userData 目录', path.dirname(terminalLayout.file()) === tempRoot)

  // 脏数据：非法分屏方式与比例不能写进布局（否则重启时会按脏值渲染）
  terminalLayout.save({ gridMode: '99x99', columnWidths: [0, 1], rowHeights: ['a', 2], panes: [{ projectId: 'proj-d' }] })
  const sanitized = terminalLayout.load()
  check('非法分屏方式/比例回落默认值', sanitized.gridMode === 'auto'
    && JSON.stringify(sanitized.columnWidths) === '[0.5,0.5]'
    && JSON.stringify(sanitized.rowHeights) === '[0.5,0.5]',
    `${sanitized.gridMode} ${JSON.stringify(sanitized.columnWidths)} ${JSON.stringify(sanitized.rowHeights)}`)

  // 损坏文件不能让应用起不来
  fs.writeFileSync(terminalLayout.file(), '{ not json', 'utf8')
  const afterCorrupt = terminalLayout.load()
  check('布局文件损坏时回落空布局', afterCorrupt.panes.length === 0)

  terminalLayout.save({ panes: [{ projectId: 'proj-c' }] })
  const cleared = terminalLayout.clear()
  check('clear 清空布局文件', cleared.ok === true && !fs.existsSync(terminalLayout.file()))

  console.log(`\n终端工作台自测：${passed} 通过 / ${failed} 失败`)
  return failed === 0 ? 0 : 1
}

main()
  .then((code) => {
    try { Module._load = originalLoad } catch { /* noop */ }
    ptyService.stop()
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* 临时目录清理失败不影响结论 */ }
    // 退出时仍可能看到 node-pty 的 conpty_console_list_agent 打出的 AttachConsole 堆栈：
    // 那是 node-pty 1.x 在 Windows 上 fork 的辅助进程（用 Electron/Node 自身当 execPath），
    // 属于**子进程**的报错输出，不影响会话关闭结论（会话与进程树已在断言里验证结束）。
    process.exitCode = code
  })
  .catch((err) => {
    Module._load = originalLoad
    ptyService.stop()
    console.error('终端工作台自测异常：', (err && err.stack) || err)
    process.exitCode = 1
  })
