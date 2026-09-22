/** 上传前校验脚本发布包的布局，避免把契约错误拖到生产服务器。 */
const fs = require('fs')
const tar = require('tar')

function zipEntries(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const tail = Buffer.alloc(Math.min(size, 65557))
    fs.readSync(fd, tail, 0, tail.length, size - tail.length)
    let end = tail.length - 22
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--
    if (end < 0) throw new Error('ZIP 目录损坏')
    const length = tail.readUInt32LE(end + 12)
    const offset = tail.readUInt32LE(end + 16)
    if (length > 16 * 1024 * 1024 || offset + length > size) throw new Error('ZIP 目录过大或使用 ZIP64，请改用 tar.gz 发布包')
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, offset)
    const entries = []
    for (let i = 0; i < buf.length;) {
      if (i + 46 > buf.length || buf.readUInt32LE(i) !== 0x02014b50) throw new Error('ZIP 条目损坏')
      const nameLength = buf.readUInt16LE(i + 28)
      const next = i + 46 + nameLength + buf.readUInt16LE(i + 30) + buf.readUInt16LE(i + 32)
      if (next > buf.length) throw new Error('ZIP 条目被截断')
      const mode = buf.readUInt32LE(i + 38) >>> 16
      if ((mode & 0xf000) === 0xa000) throw new Error('脚本发布包不支持符号链接')
      entries.push(buf.toString('utf8', i + 46, i + 46 + nameLength))
      i = next
    }
    return entries
  } finally { fs.closeSync(fd) }
}

async function validateArtifact(file, upgradeScript = 'upgrade.sh') {
  const entries = []
  if (/\.zip$/i.test(file)) entries.push(...zipEntries(file))
  else await tar.t({ file, onentry: (entry) => {
    entries.push(entry.path)
    if (!['File', 'Directory', 'ExtendedHeader', 'GlobalExtendedHeader'].includes(entry.type)) entries.push('../unsafe-link')
  } })
  const clean = entries.map((p) => p.replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean)
  if (!clean.length || clean.some((p) => p.startsWith('/') || p.includes('\\') || p.includes(':') || p.split('/').includes('..'))) throw new Error('发布包包含越界路径或不支持的链接')
  const roots = [...new Set(clean.map((p) => p.split('/')[0]))]
  if (roots.length !== 1 || !clean.some((p) => p.startsWith(roots[0] + '/'))) throw new Error('发布包必须只含一个顶层目录')
  for (const script of [upgradeScript, 'start.sh']) if (!clean.includes(`${roots[0]}/${script}`)) throw new Error(`发布包缺少 ${script}；可切换为自动发布`)
  return { root: roots[0] }
}

module.exports = { validateArtifact }
