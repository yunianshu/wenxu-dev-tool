/**
 * 从选定的完整方形源图生成 PNG 与多尺寸 ICO。
 * 保留背景和完整构图，只做尺寸转换，不去底、不裁切、不补边。
 * 用法：npm run gen:icons
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon-source.png')
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]

/** 打包 ICO：全部条目使用 PNG 压缩（Vista+ 支持，与 electron-builder 产物一致） */
function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((e, i) => {
    const o = i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(e.png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += e.png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}


app.whenReady().then(() => {
  const source = nativeImage.createFromPath(SRC)
  const { width, height } = source.getSize()
  if (!width || width !== height) throw new Error('图标源图必须是可解码的正方形')
  const resize = (size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG()
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), resize(1024))
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, png: resize(size) }))))
  console.log(`已保留完整 ${width}×${height} 源图，生成 1024×1024 PNG 及 ${ICO_SIZES.join('/')} ICO`)
  app.exit(0)
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
