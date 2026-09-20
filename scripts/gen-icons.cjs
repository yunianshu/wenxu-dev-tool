/**
 * 从 build/icon-source.png 生成应用图标资产（build/icon.png + build/icon.ico）。
 *
 * 源图约定：不透明白底、居中的圆角方形图标（如设计稿导出图）。
 * 本脚本负责把它们转成与应用一致的资产：
 *   1. 探测非白内容包围盒，裁出图标本体；
 *   2. 从四边泛洪，标出圆角之外的白色区域（图标内部的白色卡片与之不连通，不受影响）；
 *   3. 把圆角之外的颜色向外扩散若干层——否则降采样时边缘会混入白色，形成白边；
 *   4. 面积平均降采样，alpha 取内容遮罩覆盖率，得到干净的透明圆角边缘。
 *
 * 用法：npm run gen:icons
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'build', 'icon-source.png')
const OUT_PNG = path.join(ROOT, 'build', 'icon.png')
const OUT_ICO = path.join(ROOT, 'build', 'icon.ico')

/** 主图标画布边长 */
const CANVAS = 1024
/** 内容占画布的比例，与原图标一致（944/1024），保证任务栏/安装器中的视觉大小不变 */
const CONTENT_RATIO = 944 / 1024
/** ICO 档位，顺序与 electron-builder 产物一致（降序） */
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]
/** 圆角外颜色扩散层数：降采样最多取到边界外 2~3 像素，8 层留足余量 */
const BLEED_LAYERS = 8
/** 外围白色判定阈值 */
const WHITE = 238

function decode(file) {
  const img = nativeImage.createFromPath(file)
  const { width: w, height: h } = img.getSize()
  if (!w || !h) throw new Error(`无法解码图标源图：${file}`)
  return { w, h, buf: Buffer.from(img.toBitmap()) } // BGRA
}

function isWhite(buf, w, x, y) {
  const o = (y * w + x) * 4
  return buf[o] > WHITE && buf[o + 1] > WHITE && buf[o + 2] > WHITE
}

/** 非白内容包围盒。圆角矩形的首尾行仍是内容行，包围盒不会被圆角削掉 */
function contentBox({ w, h, buf }) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (isWhite(buf, w, x, y)) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('源图中未找到非白内容')
  const size = Math.min(x1 - x0 + 1, y1 - y0 + 1)
  // 取居中的正方形，避免宽高不等时拉伸
  return { x0: x0 + Math.floor((x1 - x0 + 1 - size) / 2), y0: y0 + Math.floor((y1 - y0 + 1 - size) / 2), size }
}

/** 从四边泛洪标记圆角之外的白色区域：1 = 在图标之外 */
function outsideMask(src, box) {
  const { w, buf } = src
  const { x0, y0, size: S } = box
  const outside = new Uint8Array(S * S)
  const stack = []
  const push = (lx, ly) => {
    const i = ly * S + lx
    if (outside[i]) return
    if (!isWhite(buf, w, x0 + lx, y0 + ly)) return
    outside[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < S; x += 1) { push(x, 0); push(x, S - 1) }
  for (let y = 0; y < S; y += 1) { push(0, y); push(S - 1, y) }
  while (stack.length) {
    const i = stack.pop()
    const lx = i % S
    const ly = (i / S) | 0
    if (lx > 0) push(lx - 1, ly)
    if (lx < S - 1) push(lx + 1, ly)
    if (ly > 0) push(lx, ly - 1)
    if (ly < S - 1) push(lx, ly + 1)
  }
  return outside
}

/** 把圆角外的颜色向外扩散，消除降采样时的白色渗入 */
function bleedColors(src, box, outside) {
  const { w, buf } = src
  const { x0, y0, size: S } = box
  const color = new Float32Array(S * S * 3)
  const known = new Uint8Array(S * S)
  const pending = []
  for (let i = 0; i < S * S; i += 1) {
    const lx = i % S
    const ly = (i / S) | 0
    const o = ((y0 + ly) * w + (x0 + lx)) * 4
    if (outside[i]) { pending.push(i); continue }
    color[i * 3] = buf[o + 2]
    color[i * 3 + 1] = buf[o + 1]
    color[i * 3 + 2] = buf[o]
    known[i] = 1
  }
  let frontier = pending
  for (let layer = 0; layer < BLEED_LAYERS && frontier.length; layer += 1) {
    const next = []
    const ready = []
    for (const i of frontier) {
      const lx = i % S
      const ly = (i / S) | 0
      let r = 0; let g = 0; let b = 0; let n = 0
      for (const [nx, ny] of [[lx - 1, ly], [lx + 1, ly], [lx, ly - 1], [lx, ly + 1]]) {
        if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue
        const j = ny * S + nx
        if (!known[j]) continue
        r += color[j * 3]; g += color[j * 3 + 1]; b += color[j * 3 + 2]; n += 1
      }
      if (n) ready.push([i, r / n, g / n, b / n])
      else next.push(i)
    }
    for (const [i, r, g, b] of ready) {
      color[i * 3] = r; color[i * 3 + 1] = g; color[i * 3 + 2] = b; known[i] = 1
    }
    frontier = next
  }
  return color
}

/** 按目标尺寸做面积平均降采样；alpha 取内容遮罩覆盖率，得到抗锯齿的透明边缘 */
function renderSize(T, size, color, outside) {
  const content = T * CONTENT_RATIO
  const pad = (T - content) / 2
  const scale = size / content
  const out = Buffer.alloc(T * T * 4)
  for (let ty = 0; ty < T; ty += 1) {
    const yA = (ty - pad) * scale
    const yB = (ty + 1 - pad) * scale
    if (yB <= 0 || yA >= size) continue
    const cy0 = Math.max(0, yA)
    const cy1 = Math.min(size, yB)
    for (let tx = 0; tx < T; tx += 1) {
      const xA = (tx - pad) * scale
      const xB = (tx + 1 - pad) * scale
      if (xB <= 0 || xA >= size) continue
      const cx0 = Math.max(0, xA)
      const cx1 = Math.min(size, xB)
      let sr = 0; let sg = 0; let sb = 0; let wsum = 0; let inside = 0
      for (let y = Math.floor(cy0); y < Math.ceil(cy1); y += 1) {
        const wy = Math.min(y + 1, cy1) - Math.max(y, cy0)
        if (wy <= 0) continue
        for (let x = Math.floor(cx0); x < Math.ceil(cx1); x += 1) {
          const wx = Math.min(x + 1, cx1) - Math.max(x, cx0)
          if (wx <= 0) continue
          const wt = wx * wy
          const i = y * size + x
          sr += color[i * 3] * wt
          sg += color[i * 3 + 1] * wt
          sb += color[i * 3 + 2] * wt
          wsum += wt
          if (!outside[i]) inside += wt
        }
      }
      if (wsum <= 0) continue
      const o = (ty * T + tx) * 4
      const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
      out[o] = clamp(sb / wsum)
      out[o + 1] = clamp(sg / wsum)
      out[o + 2] = clamp(sr / wsum)
      out[o + 3] = clamp((inside / wsum) * 255)
    }
  }
  return out
}

function toPng(bgra, T) {
  const img = nativeImage.createFromBuffer(bgra, { width: T, height: T })
  const png = img.toPNG()
  if (!png.length) throw new Error(`图标编码失败：${T}x${T}`)
  return png
}

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
  const src = decode(SRC)
  const box = contentBox(src)
  console.log(`源图 ${src.w}x${src.h}，内容 ${box.size}x${box.size} @ (${box.x0},${box.y0})`)

  const outside = outsideMask(src, box)
  let holes = 0
  for (let i = 0; i < outside.length; i += 1) if (outside[i]) holes += 1
  const ratio = ((holes / (box.size * box.size)) * 100).toFixed(1)
  console.log(`圆角外区域：${holes} px（占内容 ${ratio}%，预期为圆角四角，约 3~9%）`)

  const color = bleedColors(src, box, outside)
  const png = toPng(renderSize(CANVAS, box.size, color, outside), CANVAS)
  fs.writeFileSync(OUT_PNG, png)
  console.log(`已写出 ${path.relative(ROOT, OUT_PNG)}（${CANVAS}x${CANVAS}，${png.length} 字节）`)

  const entries = ICO_SIZES.map((size) => ({ size, png: toPng(renderSize(size, box.size, color, outside), size) }))
  const ico = buildIco(entries)
  fs.writeFileSync(OUT_ICO, ico)
  console.log(`已写出 ${path.relative(ROOT, OUT_ICO)}（${ICO_SIZES.join('/')}，${ico.length} 字节）`)

  setTimeout(() => app.exit(0), 50)
}).catch((err) => {
  console.error(err)
  app.exit(1)
})
