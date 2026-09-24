/**
 * 本地调试服务自测（无框架，node scripts/local-debug-selftest.cjs 直接运行）
 *
 * 验证策略：真实执行 cmd.exe /c start.bat（批处理写入工作目录标记后退出），
 * 校验探测、生成模板、运行与防覆盖逻辑；临时目录隔离，不触碰真实项目。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const localDebugService = require('../electron/local-debug-service')

async function main() {
  let passed = 0
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-debug-test-'))

  try {
    // ── 1. 目录校验 ──
    assert.throws(() => localDebugService.status(''), /未指定目录/)
    assert.throws(() => localDebugService.status(path.join(tempDir, 'ghost')), /目录不存在/)
    assert.throws(() => localDebugService.run(tempDir), /未找到 start\.bat/, '无 start.bat 时运行应报错')
    passed += 1
    console.log('  ✓ 目录校验与无脚本运行拒绝')

    // ── 2. 生成模板 ──
    const gen = localDebugService.generate(tempDir)
    assert.ok(fs.existsSync(gen.batPath), '模板文件应存在')
    const content = fs.readFileSync(gen.batPath, 'utf8')
    assert.ok(content.includes('chcp 65001'), '模板应设置 UTF-8 代码页')
    assert.ok(content.includes('pause'), '模板应以 pause 结尾避免窗口闪退')
    assert.throws(() => localDebugService.generate(tempDir), /已存在/, '已存在时生成必须拒绝（防覆盖）')
    const st = localDebugService.status(tempDir)
    assert.strictEqual(st.hasStartBat, true, '生成后探测应为 true')
    passed += 1
    console.log('  ✓ start.bat 模板生成、防覆盖、探测正确')

    // ── 3. 真实运行：批处理写入工作目录标记后退出 ──
    // 生产入口在可见的新控制台窗口里跑（窗口可见性由 console-window-selftest 断言），
    // 这里要观察子进程退出码与工作目录，所以走不新开窗口的 inheritConsole 形态
    const marker = path.join(tempDir, 'run-marker.txt')
    fs.writeFileSync(path.join(tempDir, 'start.bat'), `@echo off\r\n(cd) > "${marker}"\r\nexit /b 0\r\n`, 'utf8')
    const run = localDebugService.run(tempDir, { inheritConsole: true })
    const code = await new Promise((resolve, reject) => {
      run.child.once('exit', (c) => resolve(c))
      run.child.once('error', reject)
      setTimeout(() => reject(new Error('start.bat 30 秒内未退出')), 30000)
    })
    assert.strictEqual(code, 0, `批处理应以 0 退出（实际 ${code}）`)
    const reported = fs.readFileSync(marker, 'utf8').trim().toLowerCase()
    // cmd 的 cd 保留 8.3 短路径形态（PowerShell 则解析为长路径），两种形态都算正确
    const longForm = fs.realpathSync.native(tempDir).toLowerCase()
    const shortForm = tempDir.toLowerCase()
    assert.ok(reported === longForm || reported === shortForm, `批处理工作目录应为项目目录（实际 ${reported}）`)
    passed += 1
    console.log('  ✓ 真实 cmd.exe 执行 start.bat 且工作目录正确')

    // ── 4. 解释器缺失必须在返回前拦下 ──
    // spawn 的 ENOENT 是异步事件，主进程那时已回 ok:true：界面会提示「已启动」而实际没有窗口
    const savedPath = process.env.PATH
    process.env.PATH = ''
    try {
      assert.throws(() => localDebugService.run(tempDir), /未找到 cmd\.exe/, 'PATH 中无解释器时应拒绝启动')
    } finally {
      process.env.PATH = savedPath
    }
    assert.ok(localDebugService.status(tempDir).hasStartBat, '探测不应受 PATH 影响')
    passed += 1
    console.log('  ✓ 解释器不在 PATH 时拒绝运行并给出明确原因')

    console.log(`\n本地调试服务自测通过（${passed} 组断言）`)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('自测失败：', err)
  process.exitCode = 1
})
