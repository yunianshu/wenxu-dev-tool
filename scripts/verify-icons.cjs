/**
 * 校验分发图标资产（build/icon.png / build/icon.ico）是否合格：
 *   1. 主图标尺寸、四角透明、中心不透明；
 *   2. 圆角过渡带无白色渗入（源图白底若未清理，深色任务栏上会露出白边）；
 *   3. ICO 各档位可解码、尺寸正确、四角透明。
 * 同时输出预览图到 output/icon-preview/ 供肉眼复核。
 *
 * 用法：npm run verify:icons
 */
const { app, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PNG = path.join(ROOT, 'build', 'icon.png')
const ICO = path.join(ROOT, 'build', 'icon.ico')
const PREVIEW = path.join(ROOT, 'output', 'icon-preview')
const CANVAS = 1024
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]
/** 过渡带允许比内侧实色像素白出的最大幅度。白底残留会造成 +150 以上的跃升 */
const MAX_EDGE_WHITENESS = 60

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

function decode(file) {
  const img = nativeImage.createFromPath(file)
  const { width: w, height: h } = img.getSize()
  return { w, h, buf: Buffer.from(img.toBitmap()) }
}

function decodeRaw(buf) {
  const img = nativeImage.createFromBuffer(buf)
  const { width: w, height: h } = img.getSize()
  return { w, h, buf: Buffer.from(img.toBitmap()) }
}

const px = (img, x, y) => {
  const o = (y * img.w + x) * 4
  return { r: img.buf[o + 2], g: img.buf[o + 1], b: img.buf[o], a: img.buf[o + 3] }
}

function readIcoEntries() {
  const buf = fs.readFileSync(ICO)
  const entries = []
  for (let i = 0; i < buf.readUInt16LE(4); i += 1) {
    const o = 6 + i * 16
    const off = buf.readUInt32LE(o + 12)
    entries.push({ size: buf[o] || 256, img: decodeRaw(buf.slice(off, off + buf.readUInt32LE(o + 8))) })
  }
  return entries
}

/** 图标贴合深灰底，用于肉眼检查白边与透明边缘 */
function preview(img, zoom) {
  const w = img.w * zoom
  const h = img.h * zoom
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const s = ((y / zoom | 0) * img.w + (x / zoom | 0)) * 4
      const d = (y * w + x) * 4
      const a = img.buf[s + 3] / 255
      out[d] = Math.round(img.buf[s] * a + 30 * (1 - a))
      out[d + 1] = Math.round(img.buf[s + 1] * a + 30 * (1 - a))
      out[d + 2] = Math.round(img.buf[s + 2] * a + 30 * (1 - a))
      out[d + 3] = 255
    }
  }
  return { w, h, buf: out }
}

function savePreview(img, name) {
  fs.mkdirSync(PREVIEW, { recursive: true })
  fs.writeFileSync(
    path.join(PREVIEW, name),
    nativeImage.createFromBuffer(img.buf, { width: img.w, height: img.h }).toPNG()
  )
}

app.whenReady().then(() => {
  console.log('主图标 build/icon.png')
  if (!fs.existsSync(PNG)) {
    check(false, 'icon.png 存在', PNG)
  } else {
    const main = decode(PNG)
    check(main.w === CANVAS && main.h === CANVAS, '尺寸为 1024x1024', `实得 ${main.w}x${main.h}`)
    // 四角取画布 0.5% 处的内缩点，避开边缘抗锯齿
    const inset = Math.round(CANVAS * 0.005)
    const corners = [
      ['左上', inset, inset], ['右上', main.w - 1 - inset, inset],
      ['左下', inset, main.h - 1 - inset], ['右下', main.w - 1 - inset, main.h - 1 - inset],
    ]
    for (const [label, x, y] of corners) {
      const c = px(main, x, y)
      check(c.a === 0, `${label}角完全透明`, `alpha=${c.a}`)
    }
    const center = px(main, main.w >> 1, main.h >> 1)
    check(center.a === 255, '中心不透明', `alpha=${center.a}`)

    // 圆角过渡带白度：与紧邻的内侧实色像素比对。
    // 直接取绝对白度会被浅色区域（如浅青渐变）误判，只有过渡带明显比内侧更白才是白底残留。
    let worst = 0
    let worstAt = ''
    let transition = 0
    const minChannel = (c) => Math.min(c.r, c.g, c.b)
    for (let t = 0; t < main.w; t += 1) {
      const c = px(main, t, t)
      if (c.a === 0 || c.a === 255) continue
      transition += 1
      let ref = null
      for (let u = t + 1; u < main.w; u += 1) {
        const r = px(main, u, u)
        if (r.a === 255) { ref = r; break }
      }
      if (!ref) continue
      const delta = minChannel(c) - minChannel(ref)
      if (delta > worst) { worst = delta; worstAt = `(${t},${t})` }
    }
    check(transition > 0, '存在抗锯齿过渡带', `${transition} px`)
    check(worst < MAX_EDGE_WHITENESS, '过渡带无白色渗入', `较内侧最白 +${worst} @ ${worstAt}（阈值 +${MAX_EDGE_WHITENESS}）`)
    savePreview(preview(main, 1), 'icon-1024-on-dark.png')
  }

  console.log('\nWindows 图标 build/icon.ico')
  if (!fs.existsSync(ICO)) {
    check(false, 'icon.ico 存在', ICO)
  } else {
    const entries = readIcoEntries()
    check(entries.length === ICO_SIZES.length, `含 ${ICO_SIZES.length} 个档位`, `实得 ${entries.length}`)
    for (const size of ICO_SIZES) {
      const e = entries.find((x) => x.size === size)
      if (!e) { check(false, `${size}x${size} 档存在`); continue }
      const okSize = e.img.w === size && e.img.h === size
      const c = px(e.img, 0, 0)
      check(okSize && c.a === 0, `${size}x${size} 档有效`, `解码 ${e.img.w}x${e.img.h}，左上 alpha=${c.a}`)
    }
    const zooms = { 48: 8, 32: 8, 24: 8, 16: 12 }
    for (const [size, zoom] of Object.entries(zooms)) {
      const e = entries.find((x) => x.size === Number(size))
      if (e) savePreview(preview(e.img, zoom), `ico-${size}-zoom${zoom}.png`)
    }
    console.log(`\n小尺寸预览（放大）已输出到 ${path.relative(ROOT, PREVIEW)}`)
  }

  if (failures.length) {
    console.error(`\n校验未通过：${failures.length} 项失败`)
    setTimeout(() => app.exit(1), 50)
    return
  }
  console.log('\n全部校验通过')
  setTimeout(() => app.exit(0), 50)
}).catch((e) => { console.error(e); app.exit(1) })
