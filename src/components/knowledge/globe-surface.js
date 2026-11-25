import { landMask } from './globe-land.js'

const radians = Math.PI / 180
const fullCircle = 2 * Math.PI
const palettes = {
  light: {
    ocean: ['#44858b', '#2b6974', '#194c5a', '#0c3445'],
    land: ['#3a6b73', '#46848a', '#549495', '#68a7a5', '#83b8b2', '#9ac8bd', '#b1d5c9'],
    grid: 'rgba(181, 230, 222, .19)',
    rim: 'rgba(193, 235, 219, .64)',
  },
  dark: {
    ocean: ['#315b73', '#244760', '#16334c', '#0a1d34'],
    land: ['#294c68', '#345f77', '#3f7586', '#518c97', '#65a1a7', '#83b4b4', '#a2c7bd'],
    grid: 'rgba(146, 203, 217, .17)',
    rim: 'rgba(173, 219, 224, .56)',
  },
}

function sphericalPoint(latitude, longitude) {
  const lat = latitude * radians
  const lon = longitude * radians
  return { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.cos(lon) }
}

function readLandPoints() {
  const bytes = atob(landMask)
  const points = []
  let bit = 0
  // 纬圈间距 1.5°，每圈采样数随纬度余弦递减；相邻纬圈错开半格。
  for (let row = 0; row < 120; row++) {
    const lat = -90 + (row + 0.5) * 1.5
    const columns = Math.round(240 * Math.cos(lat * radians))
    const stagger = row % 2 ? 0.75 : 0.25
    for (let col = 0; col < columns; col++, bit++) {
      if (bytes.charCodeAt(bit >> 3) & (1 << (bit & 7))) {
        points.push(sphericalPoint(lat, -180 + 360 * (col + stagger) / columns))
      }
    }
  }
  return points
}

function graticule() {
  const lines = []
  for (let lat = -60; lat <= 60; lat += 30) {
    lines.push(Array.from({ length: 121 }, (_, i) => sphericalPoint(lat, -180 + i * 3)))
  }
  for (let lon = -180; lon < 180; lon += 30) {
    lines.push(Array.from({ length: 61 }, (_, i) => sphericalPoint(-90 + i * 3, lon)))
  }
  return lines
}

const landPoints = readLandPoints()
const gridLines = graticule()

/** 经纬网、陆地点和业务节点共用调用方的正交投影，单位球正面深度为正。 */
export function drawGlobeSurface(ctx, { radius, cx, cy, project, dark }) {
  if (radius <= 0) return
  const palette = dark ? palettes.dark : palettes.light
  const ocean = ctx.createRadialGradient(cx - radius * 0.37, cy - radius * 0.44, 0, cx, cy, radius * 1.06)
  const stops = [0, 0.43, 0.79, 1]
  palette.ocean.forEach((color, i) => ocean.addColorStop(stops[i], color))
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, fullCircle)
  ctx.fillStyle = ocean
  ctx.fill()
  ctx.clip()

  ctx.beginPath()
  for (const line of gridLines) {
    let drawing = false
    for (const point of line) {
      const { x, y, z } = project(point)
      if (z > 0) {
        if (drawing) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      }
      drawing = z > 0
    }
  }
  ctx.strokeStyle = palette.grid
  ctx.lineWidth = Math.max(0.55, radius * 0.003)
  ctx.stroke()

  const dots = palette.land.map(() => new Path2D())
  const dotRadius = Math.max(0.55, radius * 0.0068)
  for (const point of landPoints) {
    const { x, y, z } = project(point)
    if (z <= 0) continue
    const lighting = 0.70 * z - (0.43 * (x - cx) + 0.57 * (y - cy)) / radius
    const shade = Math.round((lighting + 1) * 0.5 * (dots.length - 1))
    const r = dotRadius * (0.28 + 0.72 * Math.sqrt(z))
    const path = dots[shade]
    path.moveTo(x + r, y)
    path.arc(x, y, r, 0, fullCircle)
  }
  dots.forEach((path, i) => {
    ctx.fillStyle = palette.land[i]
    ctx.fill(path)
  })

  const rim = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius)
  rim.addColorStop(0, palette.rim)
  rim.addColorStop(0.58, 'rgba(140, 201, 207, .20)')
  rim.addColorStop(1, 'rgba(101, 161, 178, .06)')
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, fullCircle)
  ctx.strokeStyle = rim
  ctx.lineWidth = Math.max(1.2, radius * 0.008)
  ctx.stroke()
  ctx.restore()
}
