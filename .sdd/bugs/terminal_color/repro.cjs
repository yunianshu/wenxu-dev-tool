/** 受控颜色探针：只记录固定诊断字段与 SGR 摘要，不落盘用户环境或 profile 输出。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const pty = require('node-pty')
const service = require('../../../electron/pty-service')

const ROOT = path.resolve(__dirname, '../../..')
const DIAG = '__DEVPM_COLOR_DIAG__'
const COLOR = '__DEVPM_GREEN_OUTPUT__'
const command = [
  '$d=@{version=[string]$PSVersionTable.PSVersion;psreadline=[bool](Get-Module PSReadLine);vt=$Host.UI.SupportsVirtualTerminal;rendering=[string]$PSStyle.OutputRendering;encoding=[Console]::OutputEncoding.WebName}',
  `[Console]::WriteLine('${DIAG}'+($d|ConvertTo-Json -Compress))`,
  `Write-Host '${COLOR}' -ForegroundColor Green`,
  'exit',
].join(';') + '\r'

function stripControls(value) {
  return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

function probe(shell, mode, noColor) {
  const args = mode === 'encoded'
    ? ['-NoProfile', ...service.resolveShell(shell.path).args]
    : ['-NoProfile', '-NoLogo']
  const env = { ...process.env, TERM: 'xterm-256color' }
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'NO_COLOR') delete env[key]
  if (noColor) env.NO_COLOR = '1'

  return new Promise((resolve, reject) => {
    const term = pty.spawn(shell.path, args, {
      name: 'xterm-256color', cols: 160, rows: 40, cwd: ROOT, env, useConpty: true,
    })
    let output = ''
    let sent = false
    let sendTimer
    const timeout = setTimeout(() => {
      clearTimeout(sendTimer)
      try { term.kill() } catch { /* 探针超时后保留原始错误。 */ }
      reject(new Error(`${shell.id}/${mode}/NO_COLOR=${noColor}: 等待超时`))
    }, 15000)

    term.onData((chunk) => {
      output += chunk
      if (!sent && /PS [^\r\n]*>/.test(stripControls(output))) {
        sent = true
        sendTimer = setTimeout(() => term.write(command), 100)
      }
    })
    term.onExit(() => {
      clearTimeout(timeout)
      clearTimeout(sendTimer)
      try {
        const start = output.lastIndexOf(`${DIAG}{`)
        assert.ok(start >= 0, '未收到诊断结果')
        const tail = output.slice(start)
        const match = stripControls(tail).match(new RegExp(`${DIAG}(\\{[^\\r\\n]+\\})`))
        assert.ok(match, '诊断结果格式不完整')
        const diagnostics = JSON.parse(match[1])
        const markerIndex = tail.indexOf(COLOR)
        assert.ok(markerIndex >= 0, '未收到固定颜色标记')
        const prefix = tail.slice(0, markerIndex)
        const sgr = prefix.match(/\x1b\[[0-9;]*m/g) || []
        const foregroundSgr = sgr.filter((value) => /\[(?:3[0-7]|9[0-7]|38;[25];)/.test(value))
        resolve({ shell: shell.id, mode, noColor, diagnostics, foregroundSgr,
          hasGreen: foregroundSgr.some((value) => /\[(?:32|92|38;5;10)m/.test(value)) })
      } catch (error) { reject(error) }
    })
  })
}

async function main() {
  assert.equal(process.platform, 'win32', '此探针验证 Windows ConPTY')
  const startedAt = new Date().toISOString()
  const shells = service.shellOptions().filter((item) => ['pwsh', 'windows-powershell'].includes(item.id))
  const results = []
  for (const shell of shells) {
    const modes = shell.id === 'pwsh' ? ['interactive', 'encoded'] : ['encoded']
    for (const mode of modes) for (const noColor of [true, false]) {
      const result = await probe(shell, mode, noColor)
      results.push(result)
      console.log(JSON.stringify(result))
    }
  }
  const report = { startedAt, endedAt: new Date().toISOString(),
    controlledInput: { profile: false, term: 'xterm-256color', noColor: '仅对照 NO_COLOR=1 与移除变量' }, results }
  fs.writeFileSync(path.join(__dirname, 'repro-before.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  const modern = results.filter((item) => item.shell === 'pwsh')
  assert.equal(modern.length, 4, '需要 PowerShell 7 的两种启动方式对照')
  for (const result of modern) {
    assert.equal(result.diagnostics.psreadline, true, 'PSReadLine 应正常加载')
    assert.equal(result.diagnostics.vt, true, 'ConPTY 应支持 VT')
    assert.equal(result.diagnostics.rendering, result.noColor ? 'PlainText' : 'Host')
    assert.equal(result.hasGreen, !result.noColor)
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error.message); process.exit(1) })
