/**
 * 终端字符宽度表 —— 与 Windows conhost（ConPTY）的格子模型逐格对齐
 *
 * 背景：Windows 上程序的输出先进 conhost 的屏幕缓冲，再由 conhost 重绘成 VT 序列发给终端。
 * 每个字符占几格由 conhost 决定，之后它发出的定位 / 擦除 / 右移序列的坐标全部建立在
 * 自己的格子上，提示符里的硬件光标列也是它定的。xterm.js 默认的宽度表是 2012 年的
 * Unicode 6，把 emoji 一律当成 1 格，而 conhost 按现代规则算 2 格 —— 两边一差，
 * emoji 之后的内容在 xterm 里整体左移一格：TUI（kimi 等）画的光标块、右边框全部错位。
 *
 * conhost 的模型（Windows build 26300 实测：全部 110 万码点逐个探测，另测 emoji 序列）：
 * - 每个码点占 1 格或 2 格，没有任何零宽字符：组合音标、变体选择符（FE0F）、ZWJ
 *   都各占一格，所以「❤️」是 2 格、「☕️」是 3 格、「e + U+0301」是 2 格；
 * - 2 格 = 东亚宽度 W/F ∪ emoji（conhost 自带的 Unicode 数据约 15.0，之后新增的 emoji 它还判窄），
 *   即下方 CONHOST_WIDE。
 * xterm 默认表会把组合音标 / 变体选择符当零宽并入前一格，同样让后续内容左移，
 * 所以这里不做并入，一律各占一格。
 * 较旧 / 较新的 Windows 版本 conhost 数据版本不同，差异只会落在较新的 emoji 上。
 *
 * TUI 自己按现代字素规则排版，国旗、肤色、ZWJ 这类多码点 emoji 与 conhost 天然对不上；
 * 那部分在所有 ConPTY 终端（含 Windows Terminal）里都一样，终端侧无解。
 *
 * CONHOST_WIDE 由 scripts/terminal-unicode-probe.cjs 实测生成；Windows 更新宽度表后重跑即可。
 */

/** 占 2 格的码点区段（闭区间，升序且互不相交）。导出仅供探针脚本与自测校验 */
export const CONHOST_WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5], [0x2ff0, 0x2ffb], [0x3000, 0x303e], [0x3041, 0x3096], [0x3099, 0x30ff],
  [0x3105, 0x312f], [0x3131, 0x318e], [0x3190, 0x31e3], [0x31f0, 0x321e], [0x3220, 0x3247], [0x3250, 0x4dbf],
  [0x4e00, 0xa48c], [0xa490, 0xa4c6], [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19],
  [0xfe30, 0xfe52], [0xfe54, 0xfe66], [0xfe68, 0xfe6b], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1], [0x17000, 0x187f7], [0x18800, 0x18cd5], [0x18d00, 0x18d08], [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb], [0x1affd, 0x1affe], [0x1b000, 0x1b122], [0x1b132, 0x1b132], [0x1b150, 0x1b152],
  [0x1b155, 0x1b155], [0x1b164, 0x1b167], [0x1b170, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f1e6, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248],
  [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa88], [0x1fa90, 0x1fabd],
  [0x1fabf, 0x1fac5], [0x1face, 0x1fadb], [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8], [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
]

function isWide(codepoint) {
  let lo = 0
  let hi = CONHOST_WIDE.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = CONHOST_WIDE[mid]
    if (codepoint < start) hi = mid - 1
    else if (codepoint > end) lo = mid + 1
    else return true
  }
  return false
}

/** xterm.js 的 unicode 版本 provider（IUnicodeVersionProvider），版本名 conhost */
export const conhostUnicode = {
  version: 'conhost',

  wcwidth(codepoint) {
    // 控制字符不占格（由解析器当作控制功能处理，不会落进缓冲），与 xterm 默认表一致
    if (codepoint < 32 || (codepoint >= 0x7f && codepoint <= 0x9f)) return 0
    return isWide(codepoint) ? 2 : 1
  },

  /**
   * xterm 的字符属性编码：(宽度 & 3) << 1 | 是否并入前一格。
   * 并入规则沿用 xterm 自带 provider 的写法，只有零宽的控制字符可能触发。
   */
  charProperties(codepoint, preceding) {
    let width = this.wcwidth(codepoint)
    let shouldJoin = width === 0 && preceding !== 0
    if (shouldJoin) {
      const oldWidth = (preceding >> 1) & 0x3
      if (oldWidth === 0) shouldJoin = false
      else if (oldWidth > width) width = oldWidth
    }
    return ((width & 0x3) << 1) | (shouldJoin ? 1 : 0)
  },
}

/** 只有 Windows 的终端会话经 conhost 排版；其它平台程序直接输出，沿用 xterm 默认表 */
export function isConhostTerminal() {
  const hint = (typeof navigator !== 'undefined' && (navigator.userAgentData?.platform || navigator.platform)) || ''
  return /win/i.test(hint)
}

/** 给终端实例换上与 conhost 对齐的宽度表（非 Windows 环境不做任何事） */
export function applyTerminalUnicode(term) {
  if (!term || !isConhostTerminal()) return false
  term.unicode.register(conhostUnicode)
  term.unicode.activeVersion = conhostUnicode.version
  return true
}
