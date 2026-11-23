/**
 * conhost 字符宽度探针：实测 Windows conhost（ConPTY）对每个码点判定的显示宽度，
 * 与 src/utils/terminal-unicode.js 的宽度表逐个比对；加 --write 则用实测结果重写该表。
 *
 * 原理：起一个与应用终端窗格同款的 ConPTY（node-pty + PowerShell 7），在里面逐批把候选码点
 * 打印到各自的行首，紧跟着发 ESC[6n 查光标列 —— 应答由 conhost 按自己的屏幕缓冲生成，
 * 「列号 − 1」就是它给这个字符的格数。应答自带行号，按行号对应，个别丢失不会错位。
 *
 * 两个必须遵守的实测事实：
 * - 子进程只能用 process.stdout.write（WriteConsoleW）。fs.writeSync(1) 走 WriteFile，
 *   conhost 会按系统代码页解码（简中 936 下「中」→「涓?」并吞掉随后的 ESC），测出来全是脏数据；
 * - 孤立的组合音标 / 变体选择符在 conhost 里也各占一格 —— 这不是探针伪影，
 *   跟在基字符后面同样占格（已用序列探针验证），所以表里没有零宽字符。
 *
 * 用法：node scripts/terminal-unicode-probe.cjs [--write]
 * 退出码：0 一致（或已重写）；1 存在差异
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { transformSync } = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const TABLE_SOURCE = path.join(ROOT, 'src', 'utils', 'terminal-unicode.js')
const BATCH = 128
const PTY_ROWS = 400

/** 在 ConPTY 子进程里执行（经 toString() 序列化后落盘运行，不能引用本文件其它作用域） */
function probeChild() {
  const fs = require('fs')
  const [, , listFile, outFile] = process.argv
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'))
  const BATCH = 128
  let buf = ''
  let waiter = null
  process.stdin.setRawMode(true)
  process.stdin.setEncoding('latin1')
  process.stdin.on('data', (d) => { buf += d; if (waiter) waiter() })
  process.stdin.resume()
  const nextCpr = (timeoutMs) => new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); waiter = null; resolve(v) }
    const timer = setTimeout(() => done(null), timeoutMs)
    const tryParse = () => {
      const m = /\x1b\[(\d+);(\d+)R/.exec(buf)
      if (m) { buf = buf.slice(m.index + m[0].length); done([Number(m[1]), Number(m[2])]) }
    }
    waiter = tryParse
    tryParse()
  })
  const main = async () => {
    const out = {}
    for (let i = 0; i < list.length; i += BATCH) {
      const slice = list.slice(i, i + BATCH)
      buf = '' // 丢弃上一批迟到的应答
      let payload = ''
      slice.forEach((cp, j) => { payload += `\x1b[${j + 1};1H\x1b[K${String.fromCodePoint(cp)}\x1b[6n` })
      process.stdout.write(payload)
      const pending = new Map(slice.map((cp, j) => [j + 1, cp]))
      const deadline = Date.now() + 3000
      while (pending.size && Date.now() < deadline) {
        const cpr = await nextCpr(Math.min(400, Math.max(1, deadline - Date.now())))
        if (cpr && pending.has(cpr[0])) {
          out[pending.get(cpr[0])] = cpr[1] - 1
          pending.delete(cpr[0])
        }
      }
    }
    fs.writeFileSync(outFile, JSON.stringify(out))
  }
  main().then(() => process.exit(0), (err) => {
    fs.writeFileSync(outFile, JSON.stringify({ error: String((err && err.stack) || err) }))
    process.exit(1)
  })
}

/** 全部可打印码点：跳过代理项与 C1 控制字符（后者会被 VT 解析器当控制功能吃掉） */
function allCodePoints() {
  const list = []
  for (let cp = 0xa0; cp < 0x110000; cp += 1) {
    if ((cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0x80 && cp <= 0x9f)) continue
    list.push(cp)
  }
  return list
}

function measureConhost() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-conhost-probe-'))
  const childFile = path.join(work, 'probe-child.cjs')
  const listFile = path.join(work, 'codepoints.json')
  const outFile = path.join(work, 'widths.json')
  fs.writeFileSync(childFile, `(${probeChild.toString()})()\n`)
  fs.writeFileSync(listFile, JSON.stringify(allCodePoints()))

  const pty = require(path.join(ROOT, 'node_modules', 'node-pty'))
  const shell = require(path.join(ROOT, 'electron', 'pty-service.js')).resolveShell()
  const quote = (p) => `'${String(p).replace(/'/g, "''")}'`
  const command = `& ${quote(process.execPath)} ${quote(childFile)} ${quote(listFile)} ${quote(outFile)}`
  const started = Date.now()
  const term = pty.spawn(shell.path, ['-NoLogo', '-NoProfile', '-Command', command], {
    name: 'xterm-256color', cols: 200, rows: PTY_ROWS, cwd: work, env: process.env, useConpty: true,
  })
  let tail = ''
  term.onData((d) => { tail = (tail + d).slice(-400) })
  const done = new Promise((resolve) => {
    term.onExit(() => resolve())
    setTimeout(() => {
      console.error(`探针超时；pty 输出尾部：${JSON.stringify(tail)}`)
      try { term.kill() } catch { /* 已退出 */ }
      resolve()
    }, 400000).unref?.()
  })
  return done.then(() => {
    if (!fs.existsSync(outFile)) throw new Error(`探针未产出结果；pty 输出尾部：${JSON.stringify(tail)}`)
    const raw = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    if (raw.error) throw new Error(`探针异常：${raw.error}`)
    console.log(`实测 ${Object.keys(raw).length} 个码点，耗时 ${Math.round((Date.now() - started) / 1000)} 秒`)
    return raw
  }).finally(() => {
    // pty 句柄会让事件循环一直挂着，子进程退出后必须显式收尾
    fs.rmSync(work, { recursive: true, force: true })
  })
}

/** 连续的宽码点合并成闭区间 */
function toRanges(widths) {
  const ranges = []
  for (const key of Object.keys(widths)) {
    if (widths[key] !== 2) continue
    const cp = Number(key)
    const last = ranges[ranges.length - 1]
    if (last && last[1] === cp - 1) last[1] = cp
    else ranges.push([cp, cp])
  }
  return ranges
}

function formatRanges(ranges) {
  // 单码点区段也写成 [起, 止]：isWide 按 [start, end] 解构，缺 end 会让区间右端失效
  const items = ranges.map(([a, b]) => `[0x${a.toString(16)}, 0x${b.toString(16)}]`)
  const lines = []
  let line = ''
  for (const item of items) {
    if (line && line.length + item.length + 2 > 116) { lines.push(line); line = '' }
    line += line ? `, ${item}` : item
  }
  if (line) lines.push(line)
  // 行间必须有逗号：否则 [..]\n[..] 会被当成下标访问，表悄悄坏掉
  return lines.map((l) => `  ${l}`).join(',\n')
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
const showRanges = (cps, max = 60) => {
  const out = []
  for (const cp of cps) {
    const last = out[out.length - 1]
    if (last && last[1] === cp - 1) last[1] = cp
    else out.push([cp, cp])
  }
  const text = out.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`))
  return `${cps.length} 个 / ${out.length} 段：` + (text.length > max ? `${text.slice(0, max).join(' ')} …` : text.join(' '))
}

function loadTable() {
  const mod = new Module(TABLE_SOURCE, module)
  mod.filename = TABLE_SOURCE
  mod.paths = Module._nodeModulePaths(path.dirname(TABLE_SOURCE))
  mod._compile(transformSync(fs.readFileSync(TABLE_SOURCE, 'utf8'), { format: 'cjs', target: 'node20' }).code, TABLE_SOURCE)
  return mod.exports
}

async function main() {
  const write = process.argv.includes('--write')
  const widths = await measureConhost()
  const ranges = toRanges(widths)
  const dist = { 1: 0, 2: 0 }
  for (const key of Object.keys(widths)) dist[widths[key]] = (dist[widths[key]] || 0) + 1
  console.log(`conhost 实测：宽 2 格 ${dist[2]} 个（${ranges.length} 段），窄 1 格 ${dist[1]} 个，其它 ${Object.keys(widths).length - dist[1] - dist[2]} 个`)

  if (write) {
    const source = fs.readFileSync(TABLE_SOURCE, 'utf8')
    const block = /export const CONHOST_WIDE = \[[\s\S]*?\n\]/
    if (!block.test(source)) throw new Error(`${TABLE_SOURCE} 里找不到 CONHOST_WIDE 数组`)
    fs.writeFileSync(TABLE_SOURCE, source.replace(block, () => `export const CONHOST_WIDE = [\n${formatRanges(ranges)}\n]`))
    console.log(`已重写 ${path.relative(ROOT, TABLE_SOURCE)} 的 CONHOST_WIDE（${ranges.length} 段）`)
  }

  const { conhostUnicode } = loadTable()
  const tooNarrow = []
  const tooWide = []
  const other = []
  for (const key of Object.keys(widths)) {
    const cp = Number(key)
    const measured = widths[key]
    const ours = conhostUnicode.wcwidth(cp)
    if (measured === 2 && ours !== 2) tooNarrow.push(cp)
    else if (measured === 1 && ours !== 1) tooWide.push(cp)
    else if (measured !== 1 && measured !== 2) other.push(cp)
  }
  console.log(`宽度表比对：conhost=2 而表判窄 ${tooNarrow.length} 个；conhost=1 而表判宽 ${tooWide.length} 个；实测值异常 ${other.length} 个`)
  if (tooNarrow.length) console.log(`  表判窄（会让内容左移）：${showRanges(tooNarrow)}`)
  if (tooWide.length) console.log(`  表判宽（会让内容右移）：${showRanges(tooWide)}`)
  if (other.length) console.log(`  实测值异常：${showRanges(other)}`)
  if (tooNarrow.length || tooWide.length || other.length) {
    console.log(write ? '重写后仍有差异，请检查上表' : '与实测不一致，确认后可加 --write 用实测结果重写宽度表')
    process.exitCode = 1
  } else {
    console.log('宽度表与 conhost 实测逐码点一致')
  }
}

module.exports = { allCodePoints, toRanges, formatRanges }

if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (err) => {
      console.error(err && err.message ? err.message : err)
      process.exit(1)
    },
  )
}
