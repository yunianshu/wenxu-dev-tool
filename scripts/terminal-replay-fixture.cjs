/**
 * 终端回放夹具：模拟 TUI 的「隐藏硬件光标 + 自绘光标 + 海量输出」
 *
 * 做法与 Claude Code 一致（真实抓包）：启动先发 ESC[?25l 隐藏硬件光标并开 bracketed paste，
 * 然后持续输出（长会话里 spinner + 流式正文轻松超过会话缓冲上限），最后把硬件光标
 * 停在右下角、在屏上留下一个自绘的反色光标块。终端若保持「隐藏」状态，右下角不该出现光标。
 *
 * 用法（在应用终端里执行）：node scripts/terminal-replay-fixture.cjs [--stay]
 *   --stay  输出完不退出（保持前台 TUI 的状态：硬件光标持续隐藏），由调用方结束会话
 */
const E = '\x1b'
const out = (s) => process.stdout.write(s)
const stay = process.argv.includes('--stay')

// 与 TUI 相同的模式设置：隐藏硬件光标、bracketed paste、竖线光标样式
out(`${E}[?25l${E}[?2004h${E}[6 q`)
// 超过会话缓冲上限（256KB）的输出，把开头的模式设置挤出缓冲。
// 每行内容都不同，conhost 无法用 REP（重复字符）序列压缩
let seed = 7919
for (let i = 0; i < 3600; i += 1) {
  let line = ''
  while (line.length < 90) {
    seed = (seed * 48271) % 2147483647
    line += seed.toString(36)
  }
  out(`${line.slice(0, 90)}\n`)
}
// 硬件光标停在最后一行最后一格；自绘光标是反色空格
const rows = process.stdout.rows || 24
const cols = process.stdout.columns || 80
out(`${E}[2J${E}[1;1H${E}[7m REPLAY-PARKED ${E}[27m${E}[${rows};1H${' '.repeat(Math.max(1, cols - 1))}`)
if (stay) setInterval(() => {}, 1000)
else setTimeout(() => process.exit(0), 300)
