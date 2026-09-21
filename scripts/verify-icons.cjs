/**
 * 校验完整方形图标：尺寸、像素内容与源图的一致性，以及 ICO 的目录与各档位。
 * 用法：npm run verify:icons
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const assert = require('node:assert/strict')
const ROOT = path.join(__dirname, '..')
const SIZES = [256, 128, 64, 48, 32, 24, 16]

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon-source.png'))
  const sourceSize = source.getSize()
  assert(sourceSize.width > 0 && sourceSize.width === sourceSize.height, '源图必须为正方形')
  const previewDir = path.join(ROOT, 'output', 'icon-preview')
  fs.mkdirSync(previewDir, { recursive: true })

  function checkImage(image, size, label) {
    assert.deepEqual(image.getSize(), { width: size, height: size }, label + ' 尺寸错误')
    const expected = source.resize({ width: size, height: size, quality: 'best' })
    const pixels = image.toBitmap()
    assert(pixels.equals(expected.toBitmap()), label + ' 与完整源图缩放结果不一致')
    for (let i = 3; i < pixels.length; i += 4) {
      assert.equal(pixels[i], 255, label + ' 不应出现透明或缺失像素')
    }
    fs.writeFileSync(path.join(previewDir, `icon-${size}.png`), image.toPNG())
    console.log(`通过：${label}，${size}×${size}，完整构图与不透明背景`)
  }

  checkImage(nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png')), 1024, '主图标')
  const ico = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'))
  assert.equal(ico.readUInt16LE(0), 0, 'ICO 保留字段错误')
  assert.equal(ico.readUInt16LE(2), 1, '文件不是 ICO')
  assert.equal(ico.readUInt16LE(4), SIZES.length, 'ICO 档位数量错误')
  let expectedOffset = 6 + SIZES.length * 16
  SIZES.forEach((size, i) => {
    const entry = 6 + i * 16
    assert.equal(ico[entry] || 256, size, 'ICO 宽度错误')
    assert.equal(ico[entry + 1] || 256, size, 'ICO 高度错误')
    assert.equal(ico.readUInt16LE(entry + 4), 1, 'ICO 色彩平面错误')
    assert.equal(ico.readUInt16LE(entry + 6), 32, 'ICO 位深错误')
    const length = ico.readUInt32LE(entry + 8)
    const offset = ico.readUInt32LE(entry + 12)
    assert.equal(offset, expectedOffset, 'ICO 数据偏移错误')
    assert(length > 0 && offset + length <= ico.length, 'ICO 数据越界')
    checkImage(nativeImage.createFromBuffer(ico.subarray(offset, offset + length)), size, 'ICO')
    expectedOffset += length
  })
  assert.equal(expectedOffset, ico.length, 'ICO 存在额外数据')
  console.log('全部图标校验通过，预览已保存至 output/icon-preview/')
  app.exit(0)
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
