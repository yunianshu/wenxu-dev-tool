/**
 * 终端宽度 E2E 夹具：在终端窗格的真实 ConPTY 里模拟 kimi（pi-tui）画输入框。
 *
 * 画法与 kimi 一致：一帧 = ESC[?2026h + 若干行 + ESC[?2026l，每行「ESC[2K + 内容」，
 * 行内是「[序号] │ > 文本 + 反色空格（光标块）+ 按宽度补空格 + │ 」。
 * 第二帧只重写最后一行（模拟继续打字），走的是 conhost 的差分重绘路径。
 *
 * 宽度规则按 conhost 的实测模型写死在这里，不引用被测模块（避免测试与实现同源）：
 * 每个码点占 1 格，CJK 与 emoji 占 2 格，组合音标 / 变体选择符各占 1 格。
 * 必须用 process.stdout.write（WriteConsoleW），理由同 scripts/terminal-unicode-probe.cjs。
 *
 * 用法：由 scripts/terminal-unicode-e2e.cjs 在窗格里执行；被 require 时只导出用例。
 */
const ROWS = [
  { tag: '01', cps: [0x61, 0x62, 0x63] },
  { tag: '02', cps: [0x4e2d, 0x6587, 0x6d4b, 0x8bd5] },
  { tag: '03', cps: [0x61, 0x1f604, 0x65, 0x6d, 0x6f, 0x6a, 0x69] },
  { tag: '04', cps: [0x2705, 0x274c, 0x2b50, 0x2728] },
  { tag: '05', cps: [0x2764, 0xfe0f] },
  { tag: '06', cps: [0x65, 0x0301, 0x78] },
  { tag: '07', cps: [0x2615, 0xfe0f] },
  { tag: '08', cps: [0x4e2d, 0x1f604, 0x65, 0x0301, 0x2705] },
  { tag: '09', cps: [0x2b1b, 0x2b1c] },
]
/** 第二帧把第 09 行改成这段：conhost 只重绘变化的行，最容易暴露擦除 / 右移序列的错位 */
const RETYPE_CPS = [0x2b1b, 0x2b1c, 0x2b1b, 0x2b1c, 0x2b1b]

const WIDE = new Set([0x1f604, 0x2705, 0x274c, 0x2b50, 0x2728, 0x2615, 0x2b1b, 0x2b1c])
const cells = (cp) => (WIDE.has(cp) || (cp >= 0x4e00 && cp <= 0x9fff) ? 2 : 1)
const text = (cps) => String.fromCodePoint(...cps)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

module.exports = { ROWS, RETYPE_CPS, cells, text }

async function main() {
  const cols = process.stdout.columns
  const line = (tag, cps) => {
    const content = `[${tag}] │ > ${text(cps)}`
    const used = [...content].reduce((n, ch) => n + cells(ch.codePointAt(0)), 0) + 1 // +1 是光标块
    return `\x1b[2K${content}\x1b[7m \x1b[27m${' '.repeat(Math.max(0, cols - 2 - used))}│ `
  }

  process.stdout.write(`\x1b[?2026h\x1b[2J\x1b[H` + ROWS.map((row, i) => (i ? '\r\n' : '') + line(row.tag, row.cps)).join('') + `\x1b[?2026l`)
  await sleep(600)
  process.stdout.write(`\x1b[?2026h\x1b[${ROWS.length};1H${line('09', RETYPE_CPS)}\x1b[?2026l\x1b[?25l`)
  await sleep(1500)
}

if (require.main === module) {
  main().catch(() => process.exit(1))
}
