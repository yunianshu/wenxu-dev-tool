/**
 * 语义化版本比较（只做比较，不做范围匹配）
 *
 * 用途单一：判断 registry 上的最新版本是否比本地已装版本新。
 * 需要正确处理预发布版本（dsh 目前只发 alpha/rc）：
 *   1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2
 *   < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
 * 规则（semver 2.0.0 §11）：数字标识符按数值比较、字母数字按字典序比较、
 * 数字小于非数字、前缀相同则标识符少的更小；构建元数据（+xxx）不参与比较。
 */

/** 解析版本号；非法返回 null。支持 `v` 前缀 */
function parseVersion(version) {
  const text = String(version || '').trim().replace(/^v/, '')
  const matched = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!matched) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    pre: matched[4] ? matched[4].split('.') : [],
  }
}

/** 版本号是否合法（比较前先校验，避免拿 dist-tag 里的脏值做判断） */
function isValidVersion(version) {
  return parseVersion(version) !== null
}

/** 预发布标识符序列比较（双方均为已解析的 pre 数组） */
function comparePre(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1   // 有预发布 < 无预发布（正式版更新）
  if (!b.length) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined) return -1  // 前缀相同：标识符少的更小
    if (right === undefined) return 1
    const leftNum = /^\d+$/.test(left)
    const rightNum = /^\d+$/.test(right)
    if (leftNum && rightNum) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    if (leftNum !== rightNum) return leftNum ? -1 : 1  // 数字 < 字母数字
    if (left !== right) return left > right ? 1 : -1
  }
  return 0
}

/** 比较两个版本：a>b 返回 1，a<b 返回 -1，相等返回 0；任一非法抛错 */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new Error(`无法比较的版本号：${a} / ${b}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  return comparePre(left.pre, right.pre)
}

/** target 是否比 base 新（任一非法返回 false，宁可漏报也不误报） */
function isNewer(target, base) {
  if (!isValidVersion(target) || !isValidVersion(base)) return false
  return compareVersions(target, base) > 0
}

module.exports = { parseVersion, isValidVersion, compareVersions, isNewer }
