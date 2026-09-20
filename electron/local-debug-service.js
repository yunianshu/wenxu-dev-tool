/**
 * 本地调试服务 —— 运行项目根目录的 start.bat（Windows）
 *
 * 行为约定：
 * - status(dir)：探测项目根目录是否存在 start.bat
 * - run(dir)：在新控制台窗口执行 start.bat（非 detached，与 PowerShell 快捷入口
 *   同款结论：detached 会让批处理命令静默失效；GUI 进程 spawn cmd 自动分配新控制台，
 *   服务器类脚本常驻时窗口保持，脚本退出后窗口随 cmd 关闭）
 * - generate(dir)：生成 start.bat 模板（已存在则拒绝，绝不覆盖用户文件）；
 *   首两行纯 ASCII + chcp 65001，保证 UTF-8 中文注释在批处理里正常显示
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TEMPLATE = [
  '@echo off',
  'chcp 65001 >nul',
  'rem ============================================',
  'rem 本地启动脚本（由「Personnel PLM」生成）',
  'rem 请把下方示例替换为项目实际的启动命令，例如：',
  'rem   npm run dev',
  'rem   python main.py',
  'rem   dotnet run',
  'rem ============================================',
  'echo [本地调试] 这是模板 start.bat，请编辑后填入项目启动命令。',
  'pause',
  '',
].join('\r\n')

function assertDir(dir) {
  if (!dir || typeof dir !== 'string' || !dir.trim()) throw new Error('未指定目录')
  if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`)
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目录：${dir}`)
}

function batPath(dir) {
  assertDir(dir)
  return path.join(dir, 'start.bat')
}

function status(dir) {
  const p = batPath(dir)
  return { batPath: p, hasStartBat: fs.existsSync(p) }
}

function run(dir) {
  const p = batPath(dir)
  if (!fs.existsSync(p)) throw new Error('项目目录未找到 start.bat，可先生成模板')
  // cmd /c 执行批处理；不加 detached（Windows 下 detached 会使命令静默失效）
  const child = spawn('cmd.exe', ['/c', p], { cwd: dir, stdio: 'ignore' })
  child.once('error', () => { /* 异步错误不致崩溃，窗口内会自行显示 */ })
  child.unref()
  return { cwd: dir, batPath: p, child }
}

function generate(dir) {
  const p = batPath(dir)
  if (fs.existsSync(p)) throw new Error('start.bat 已存在，为避免覆盖未生成')
  fs.writeFileSync(p, TEMPLATE, 'utf8')
  return { batPath: p }
}

module.exports = { status, run, generate, batPath }
