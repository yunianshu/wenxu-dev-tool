/** 仅修改图标外轮廓的 alpha，内部色彩保持源图原样。 */
const CORNER_RATIO = 0.16

function roundCorners(nativeImage, source) {
  const { width, height } = source.getSize()
  const bitmap = source.toBitmap()
  const radius = width * CORNER_RATIO
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = Math.max(radius - x - 0.5, 0, x + 0.5 - (width - radius))
      const dy = Math.max(radius - y - 0.5, 0, y + 0.5 - (height - radius))
      if (!dx && !dy) continue
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - Math.hypot(dx, dy)))
      const alpha = (y * width + x) * 4 + 3
      bitmap[alpha] = Math.round(bitmap[alpha] * coverage)
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height })
}

module.exports = { roundCorners }
