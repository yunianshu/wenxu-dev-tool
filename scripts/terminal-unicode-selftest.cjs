/**
 * 终端字符宽度表自测：src/utils/terminal-unicode.js 必须与 Windows conhost 的格子模型一致。
 *
 * 验收标准来自 conhost 的实测模型（Windows build 26300，全码点探针 + 序列探针，见
 * scripts/terminal-unicode-probe.cjs），不按实现反推：
 *   U1 每个码点占 1 格或 2 格，没有零宽字符：组合音标 / 变体选择符 / ZWJ 各占一格且不并入前一格
 *   U2 东亚宽度 W/F 与 emoji 占 2 格，含默认表当成 1 格的全部 emoji 与「⬛⬜◽◾」
 *   U3 严谨符号、制表符、歧义宽度字符仍是 1 格；conhost 判窄的 CJK 区段空隙也是 1 格
 *   U4 charProperties 的编码与 xterm 自带 provider 一致（宽度 << 1 | 并入位）
 *   U5 只在 Windows 上给终端换表；重复调用不产生重复版本
 *   U6 宽度表文本就是生成器的规范输出（生成器的两类缺陷回归：行间漏逗号、单码点区段缺右端）
 */
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { transformSync } = require('esbuild')

function loadSource(relative) {
  const filename = path.resolve(__dirname, '..', relative)
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod._compile(transformSync(fs.readFileSync(filename, 'utf8'), { format: 'cjs', target: 'node20' }).code, filename)
  return mod.exports
}

/** 逐码点求和即序列宽度：表里没有零宽字符，不存在并入 */
const width = (mod, ...codepoints) => codepoints.reduce((sum, cp) => sum + mod.conhostUnicode.wcwidth(cp), 0)

async function main() {
  const mod = loadSource('src/utils/terminal-unicode.js')
  const { CONHOST_WIDE, conhostUnicode, applyTerminalUnicode, isConhostTerminal } = mod
  const w = (cp) => conhostUnicode.wcwidth(cp)

  // 表结构：闭区间、升序、不相交、都在码点范围内
  CONHOST_WIDE.forEach(([start, end], i) => {
    assert.ok(Number.isInteger(start) && Number.isInteger(end) && start <= end, `第 ${i} 段不是合法闭区间`)
    assert.ok(start >= 0 && end <= 0x10ffff, `第 ${i} 段超出码点范围`)
    if (i) assert.ok(CONHOST_WIDE[i - 1][1] < start, `第 ${i} 段与上一段重叠或未排序`)
  })

  console.log('\n[U1] 没有零宽字符：组合音标 / 变体选择符 / ZWJ 各占一格，且不并入前一格')
  const cell = conhostUnicode.charProperties(0x41, 0)
  for (const cp of [0x0300, 0x0301, 0x094d, 0x0e31, 0x20d0, 0x200b, 0x200c, 0x200d, 0x2060, 0xfe00, 0xfe0f, 0xfeff, 0x1ab0, 0xe0020, 0xe0100]) {
    assert.equal(w(cp), 1, `U+${cp.toString(16)} 应占 1 格`)
    assert.equal(conhostUnicode.charProperties(cp, cell) & 1, 0, `U+${cp.toString(16)} 不应并入前一格`)
  }
  assert.equal(width(mod, 0x65, 0x0301), 2, 'e + 组合 acute 应为 2 格')
  assert.equal(width(mod, 0x2764, 0xfe0f), 2, '❤️（❤ + VS16）应为 2 格')
  assert.equal(width(mod, 0x2615, 0xfe0f), 3, '☕️（☕ + VS16）应为 3 格')
  assert.equal(width(mod, 0x41, 0x200d, 0x42), 3, 'A ZWJ B 应为 3 格')
  console.log('  PASS  组合音标、变体选择符、ZWJ 各占一格')

  console.log('\n[U2] emoji 与东亚宽字符占 2 格')
  // 含 Unicode 15 新增的 🛜🩷🪭（官方 unicode11 表还把它们当 1 格）
  const emoji = [0x1f604, 0x1f4c1, 0x1f50d, 0x1f680, 0x1f44d, 0x1f9d1, 0x1f6dc, 0x1fa7c, 0x1faad, 0x1fae5, 0x1fabf,
    0x2705, 0x274c, 0x2b50, 0x2728, 0x26a1, 0x2614, 0x2615, 0x231a, 0x23f0, 0x26f3, 0x2693, 0x2b1b, 0x2b1c, 0x25fd, 0x25fe,
    0x1f3fb, 0x1f1e7]
  for (const cp of emoji) assert.equal(w(cp), 2, `U+${cp.toString(16)} 应占 2 格`)
  for (const cp of [0x4e2d, 0x6587, 0xff0c, 0x3002, 0xff45, 0xff21, 0xff11, 0xac00, 0x3042, 0x30a2, 0x3105, 0x3099, 0x302a]) {
    assert.equal(w(cp), 2, `U+${cp.toString(16)} 应占 2 格`)
  }
  assert.equal(width(mod, 0x61, 0x1f604, 0x62), 4, 'a😄b 应为 4 格')
  assert.equal(width(mod, 0x4e2d, 0x6587, 0x6d4b, 0x8bd5), 8, '中文测试应为 8 格')
  console.log(`  PASS  ${emoji.length} 个 emoji、CJK / 全角 / 谚文 / 假名均为 2 格`)

  console.log('\n[U3] 控制字符不占格；ASCII、严谨符号、制表符、歧义宽度保持 1 格')
  for (const cp of [0x00, 0x09, 0x1b, 0x1f, 0x7f, 0x9b, 0x9f]) assert.equal(w(cp), 0, `U+${cp.toString(16)} 应为 0`)
  for (const cp of [0x20, 0x41, 0x7e, 0xa0, 0xe9, 0x2014, 0x2026, 0x2500, 0x2502, 0x256d, 0x256e, 0x2192, 0xb1,
    0x2713, 0x2717, 0x2726, 0x26a0, 0x23fa, 0x23bf, 0x2699, 0x2714, 0x2139, 0x25cf, 0x25cb]) {
    assert.equal(w(cp), 1, `U+${cp.toString(16)} 应占 1 格`)
  }
  // conhost 判窄的区段边界与 CJK 区段空隙（xterm 默认表把这些当 2 格）
  for (const cp of [0x1160, 0x303f, 0xff61, 0xa48d, 0xd7a4, 0x2fffe, 0x3fffe, 0x2e9a, 0x3040, 0x3097, 0x3130, 0x4dc0, 0x4dff, 0xfe67, 0xff00]) {
    assert.equal(w(cp), 1, `U+${cp.toString(16)} 应占 1 格`)
  }
  for (const cp of [0x115f, 0x303e, 0xff60, 0xa48c, 0xd7a3, 0x2fffd, 0x3fffd, 0x2e9b, 0x3096, 0x312f, 0x4dbf, 0xfe66, 0xff01]) {
    assert.equal(w(cp), 2, `U+${cp.toString(16)} 应占 2 格`)
  }
  console.log('  PASS  边界与空隙均与 conhost 一致')

  console.log('\n[U4] charProperties 编码与 xterm 自带 provider 一致')
  assert.equal(conhostUnicode.charProperties(0x41, 0) >> 1, 1)
  assert.equal(conhostUnicode.charProperties(0x1f604, cell) >> 1, 2)
  assert.equal(conhostUnicode.charProperties(0x1f604, cell) & 1, 0)
  // 零宽的控制字符跟在普通字符后：并入前一格并沿用其宽度（xterm 默认 provider 的行为）
  assert.equal(conhostUnicode.charProperties(0x9b, cell), (1 << 1) | 1)
  assert.equal(conhostUnicode.charProperties(0x9b, 0), 0)
  assert.equal(conhostUnicode.version, 'conhost')
  console.log('  PASS  可打印字符不并入，控制字符并入规则与默认 provider 相同')

  console.log('\n[U5] 只在 Windows 上换表，重复调用不产生重复版本')
  // Node 的 navigator 是带 setter 的访问器属性，但直接赋值不会替换对象，必须 defineProperty
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', {
    value, writable: true, configurable: true, enumerable: navigatorDescriptor.enumerable,
  })
  try {
    const makeTerm = () => {
      const registry = { 6: { version: '6', wcwidth: () => 1, charProperties: () => 2 } }
      return {
        registry,
        unicode: {
          register(provider) { registry[provider.version] = provider },
          get versions() { return Object.keys(registry) },
          activeVersion: '6',
        },
      }
    }
    setNavigator({ userAgentData: { platform: 'Windows' }, platform: 'Win32' })
    assert.equal(isConhostTerminal(), true)
    const term = makeTerm()
    assert.equal(applyTerminalUnicode(term), true)
    assert.equal(term.unicode.activeVersion, 'conhost')
    assert.equal(term.unicode.versions.join(','), '6,conhost')
    assert.equal(term.registry.conhost.wcwidth(0x1f604), 2)
    assert.equal(applyTerminalUnicode(term), true)
    assert.deepEqual(term.unicode.versions, ['6', 'conhost'], '重复换表不应新增版本')
    assert.equal(applyTerminalUnicode(null), false)

    setNavigator({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' })
    assert.equal(isConhostTerminal(), false)
    const macTerm = makeTerm()
    assert.equal(applyTerminalUnicode(macTerm), false)
    assert.equal(macTerm.unicode.activeVersion, '6')
    assert.deepEqual(macTerm.unicode.versions, ['6'])
    // 没有 userAgentData 时退回 navigator.platform
    setNavigator({ platform: 'Linux x86_64' })
    assert.equal(isConhostTerminal(), false)
    console.log('  PASS  Windows 生效、其它平台不动、重复调用幂等')
  } finally {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
    assert.equal(typeof globalThis.navigator.platform, 'string', '应还原全局 navigator')
  }

  console.log('\n[U6] 宽度表文本是生成器的规范输出')
  const { toRanges, formatRanges } = require('./terminal-unicode-probe.cjs')
  const sample = [[0x1100, 0x115f], [0x231a, 0x231b], [0x23f0, 0x23f0], [0x20000, 0x2fffd]]
  const formatted = formatRanges(sample)
  assert.deepEqual(Function(`return [${formatted}]`)(), sample, '生成器输出应能原样解析回同一组区段')
  assert.ok(!formatted.includes('\n'), '短表应保持单行')
  const longSample = Array.from({ length: 40 }, (_, i) => [0x1f300 + i * 4, 0x1f300 + i * 4 + 1])
  const longFormatted = formatRanges(longSample)
  assert.ok(longFormatted.includes(',\n'), '多行区段之间必须有逗号（漏了会被当成下标访问）')
  assert.deepEqual(Function(`return [${longFormatted}]`)(), longSample, '多行输出应能原样解析回同一组区段')
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'utils', 'terminal-unicode.js'), 'utf8')
  const block = /export const CONHOST_WIDE = \[\n([\s\S]*?)\n\]/.exec(source)
  assert.ok(block, '源文件里找不到 CONHOST_WIDE')
  assert.equal(block[1], formatRanges(CONHOST_WIDE), '表文本应与生成器输出逐字一致')
  assert.deepEqual(toRanges({ 1: 2, 2: 2, 3: 1, 5: 2, 9: 1 }), [[1, 2], [5, 5]])
  console.log('  PASS  行间逗号、单码点区段右端、表文本规范形式')
}

main().then(() => {
  console.log('\nterminal-unicode-selftest 通过')
}, (err) => {
  console.error('\nterminal-unicode-selftest 失败：', err && err.message)
  process.exitCode = 1
})
