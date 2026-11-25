<template>
  <section class="idea-globe" aria-label="想法地球">
    <div ref="stage" class="idea-globe-stage">
      <header class="idea-globe-toolbar">
        <div class="idea-globe-heading"><strong>想法地球</strong><div><span>{{ records.length - moduleCount }} 个想法</span><small v-if="moduleCount"> · {{ moduleCount }} 个基础模块</small></div></div>
        <div class="idea-globe-actions">
          <button type="button" :aria-pressed="autoRotate" :aria-label="autoRotate ? '暂停旋转' : '自动旋转'" :title="autoRotate ? '暂停旋转' : '自动旋转'" @click="autoRotate = !autoRotate">
            <el-icon><component :is="autoRotate ? VideoPause : VideoPlay" /></el-icon><span>{{ autoRotate ? '暂停旋转' : '自动旋转' }}</span>
          </button>
          <button type="button" aria-label="重置视角" title="重置视角" @click="resetView"><el-icon><RefreshLeft /></el-icon><span>重置视角</span></button>
        </div>
      </header>
      <canvas ref="canvas" class="idea-globe-canvas" tabindex="0"
        :aria-label="`想法地球，${records.length} 条记录。拖动或方向键旋转，加减键或滚轮缩放，点击光点或名称打开记录，回车打开最靠近正面的记录。`"
        @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp"
        @pointercancel="onPointerCancel" @pointerleave="onPointerLeave" @wheel.prevent="onWheel" @keydown="onKeydown" />
      <div v-if="loading" class="idea-globe-message">正在读取想法…</div>
      <div v-else-if="!records.length" class="idea-globe-message">在上方记下第一个想法，就能点亮地球。</div>
      <div v-if="hoveredRecord" class="idea-globe-tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
        <strong>{{ hoveredRecord.title }}</strong><span>{{ kindLabels[globeRecordKind(hoveredRecord)] }} · {{ hoveredRecord.projectName || hoveredRecord.sourceProjects?.map(p => p.name).join('、') || '未关联项目' }}</span>
      </div>
      <footer class="idea-globe-footer">
        <div v-if="records.length" class="globe-legend" aria-label="图例">
          <span v-for="kind in visibleKinds" :key="kind"><i :class="'mark-' + kind"></i>{{ kindLabels[kind] }}</span>
          <span v-if="hasLinks"><i class="mark-link"></i>来源关联</span>
        </div>
        <div class="idea-globe-hint">拖动旋转 · 滚轮缩放 · 点击查看</div>
      </footer>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { RefreshLeft, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import { globeRecordKind } from '../../utils/knowledge'
import { drawGlobeSurface } from './globe-surface'

const props = defineProps({
  records: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
  highlightId: { type: String, default: '' },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['select'])
const stage = ref(null)
const canvas = ref(null)
const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)')
const autoRotate = ref(!motionPreference?.matches)
const hoveredId = ref('')
const tooltip = ref({ x: 0, y: 0 })
const hoveredRecord = computed(() => props.records.find(row => row.id === hoveredId.value))

// ID 决定球面位置；记录排序、编辑或重新打开页面都不会让已有想法跳位。
function hash(value) {
  let result = 2166136261
  for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  // 混合末位，避免连续编号或相似 ID 的记录堆在同一个经纬度。
  result = Math.imul(result ^ (result >>> 16), 0x85ebca6b)
  result = Math.imul(result ^ (result >>> 13), 0xc2b2ae35)
  return (result ^ (result >>> 16)) >>> 0
}
function pointFor(id) {
  const latitude = Math.acos(1 - 2 * ((hash(id) + 0.5) / 4294967296))
  const longitude = 2 * Math.PI * ((hash(`${id}:longitude`) + 0.5) / 4294967296)
  return { x: Math.sin(latitude) * Math.cos(longitude), y: Math.cos(latitude), z: Math.sin(latitude) * Math.sin(longitude) }
}
const kindLabels = { idea: '想法', module: '基础模块', direction: '行动建议' }
const nodes = computed(() => props.records.map(record => ({
  record, point: pointFor(record.id), kind: globeRecordKind(record), title: record.title, links: [...(record.sourceIds || [])],
})))
const moduleCount = computed(() => nodes.value.filter(node => node.kind === 'module').length)
const visibleKinds = computed(() => Object.keys(kindLabels).filter(kind => nodes.value.some(node => node.kind === kind)))
const hasLinks = computed(() => {
  const ids = new Set(nodes.value.map(node => node.record.id))
  return nodes.value.some(node => node.links.some(id => id !== node.record.id && ids.has(id)))
})

const defaultYaw = -75 * Math.PI / 180
const defaultPitch = 20 * Math.PI / 180
let width = 0, height = 0, ratio = 1, zoom = 1, yaw = defaultYaw, pitch = defaultPitch
let frameId = 0, lastFrame = 0, resizeObserver, themeObserver, drag = null, focusTarget = null
let hitNodes = [], hitLabels = []
let dark = false, palette = {}
function readPalette() {
  const style = getComputedStyle(stage.value)
  dark = document.documentElement.dataset.theme === 'dark'
  for (const key of ['idea', 'module', 'direction', 'label', 'ink', 'border', 'arc']) palette[key] = style.getPropertyValue('--globe-' + key).trim()
  requestDraw()
}
function resize() {
  if (!stage.value || !canvas.value) return
  const box = stage.value.getBoundingClientRect()
  width = box.width; height = box.height
  ratio = Math.min(window.devicePixelRatio || 1, 2)
  canvas.value.width = Math.max(1, Math.round(width * ratio))
  canvas.value.height = Math.max(1, Math.round(height * ratio))
  canvas.value.style.width = `${width}px`
  canvas.value.style.height = `${height}px`
  requestDraw()
}
// 正交投影让地表、经纬网、来源线和命中区域在缩放时始终对齐。
function camera(radius, cx, cy, longitude = yaw, latitude = pitch) {
  const cosYaw = Math.cos(longitude), sinYaw = Math.sin(longitude), cosPitch = Math.cos(latitude), sinPitch = Math.sin(latitude)
  return point => {
    const x = point.x * cosYaw + point.z * sinYaw
    const z = -point.x * sinYaw + point.z * cosYaw
    return { x: cx + x * radius, y: cy - (point.y * cosPitch - z * sinPitch) * radius, z: point.y * sinPitch + z * cosPitch }
  }
}

function drawLink(ctx, node, source, project) {
  const start = node.point, end = source.point
  const angle = Math.acos(Math.max(-1, Math.min(1, start.x * end.x + start.y * end.y + start.z * end.z)))
  const sine = Math.sin(angle)
  if (sine < 0.00001) return
  const steps = Math.max(3, Math.ceil(angle * 18))
  ctx.beginPath()
  let connected = false
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const a = Math.sin(angle * (1 - t)) / sine, b = Math.sin(angle * t) / sine
    const p = project({ x: a * start.x + b * end.x, y: a * start.y + b * end.y, z: a * start.z + b * end.z })
    if (p.z < 0.015) { connected = false; continue }
    if (connected) ctx.lineTo(p.x, p.y)
    else ctx.moveTo(p.x, p.y)
    connected = true
  }
  ctx.stroke()
}

function drawMarker(ctx, node, active) {
  const { x, y, kind } = node
  const size = (active ? 6.8 : 4.5) * (0.84 + 0.16 * node.z)
  ctx.fillStyle = palette[kind]
  ctx.strokeStyle = '#11383f'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  if (kind === 'module') {
    ctx.moveTo(x, y - size * 1.4); ctx.lineTo(x + size * 1.4, y); ctx.lineTo(x, y + size * 1.4); ctx.lineTo(x - size * 1.4, y); ctx.closePath()
  } else if (kind === 'direction') {
    ctx.moveTo(x, y - size * 1.4); ctx.lineTo(x + size * 1.25, y + size); ctx.lineTo(x - size * 1.25, y + size); ctx.closePath()
  } else ctx.arc(x, y, size, 0, Math.PI * 2)
  ctx.fill(); ctx.stroke()
  if (active) {
    ctx.strokeStyle = palette[kind]
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.arc(x, y, size + 5, 0, Math.PI * 2); ctx.stroke()
  }
}

function overlaps(a, b) {
  return a.x < b.x + b.w + 3 && a.x + a.w + 3 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y
}

function drawLabels(ctx, front) {
  const limit = width < 440 ? 4 : 8
  const activeId = hoveredId.value || props.selectedId || props.highlightId
  const sorted = [...front].sort((a, b) => Number(b.record.id === activeId) - Number(a.record.id === activeId) || b.z - a.z)
  const obstacles = front.map(node => ({ x: node.x - 5, y: node.y - 5, w: 10, h: 10 }))
  ctx.font = '500 12px "Segoe UI", "Microsoft YaHei", sans-serif'
  ctx.textBaseline = 'middle'
  for (const node of sorted) {
    if (hitLabels.length >= limit) break
    const active = node.record.id === activeId
    if (!active && node.z < 0.12) continue
    const letters = Array.from(node.title || '未命名记录')
    const maxChars = width < 460 ? 8 : 12
    const title = letters.slice(0, maxChars).join('') + (letters.length > maxChars ? '…' : '')
    const w = Math.ceil(ctx.measureText(title).width) + 16, h = 24
    const outward = node.x >= width * 0.5 ? 1 : -1
    let placed = false
    for (const side of [outward, -outward]) {
      for (const offset of [-17, 19, -42, 42]) {
        const near = node.x + side * (active ? 26 : 19)
        const box = { x: side > 0 ? near : near - w, y: node.y + offset - h / 2, w, h, node }
        if (box.x < 7 || box.x + w > width - 7 || box.y < 60 || box.y + h > height - 42) continue
        if (obstacles.some(other => overlaps(box, other)) || hitLabels.some(other => overlaps(box, other))) continue
        const mid = box.y + h / 2
        ctx.strokeStyle = active ? palette[node.kind] : palette.arc
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(node.x + side * 5, node.y); ctx.lineTo(near - side * 5, mid); ctx.lineTo(near, mid); ctx.stroke()
        ctx.beginPath(); ctx.roundRect(box.x, box.y, w, h, 5)
        ctx.fillStyle = palette.label; ctx.fill(); ctx.strokeStyle = active ? palette[node.kind] : palette.border; ctx.stroke()
        ctx.fillStyle = palette.ink; ctx.fillText(title, box.x + 8, mid + 0.5)
        hitLabels.push(box); placed = true; break
      }
      if (placed) break
    }
  }
}
function draw() {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx || !width || !height) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const radius = Math.max(25, Math.min(width * 0.36, (height - 96) * 0.47, 330)) * zoom
  const cx = width * 0.5, cy = height * 0.49
  const project = camera(radius, cx, cy)
  // 球下的柔影提供深度，旋转时光源留在画面左上方。
  ctx.save()
  ctx.translate(cx, cy + radius + 12); ctx.scale(1, 0.085)
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, radius * 0.8)
  shadow.addColorStop(0, dark ? 'rgba(0,5,14,.65)' : 'rgba(38,85,80,.19)'); shadow.addColorStop(1, 'transparent')
  ctx.fillStyle = shadow; ctx.fillRect(-radius, -radius, radius * 2, radius * 2)
  ctx.restore()
  drawGlobeSurface(ctx, { radius, cx, cy, project, dark })

  const projected = nodes.value.map(node => ({ ...node, ...project(node.point) }))
  const byId = new Map(projected.map(node => [node.record.id, node]))
  const activeId = hoveredId.value || props.selectedId || props.highlightId
  ctx.save()
  for (const node of projected) {
    for (const id of node.links) {
      const source = byId.get(id)
      if (!source || id === node.record.id || (source.z < 0 && node.z < 0)) continue
      const active = activeId && (id === activeId || node.record.id === activeId)
      ctx.strokeStyle = active ? palette[node.kind] : palette.arc
      ctx.lineWidth = active ? 1.8 : 1.2
      ctx.globalAlpha = active ? 0.96 : 0.68
      drawLink(ctx, node, source, project)
    }
  }
  ctx.restore()
  hitNodes = projected.filter(node => node.z > 0.015).sort((a, b) => a.z - b.z)
  hitLabels = []
  drawLabels(ctx, hitNodes)
  for (const node of hitNodes) drawMarker(ctx, node, node.record.id === activeId)
  const hovered = byId.get(hoveredId.value)
  if (hovered?.z > 0.015) tooltip.value = {
    x: Math.max(8, Math.min(width - 216, hovered.x + 14)), y: Math.max(64, Math.min(height - 92, hovered.y + 24)),
  }
  else if (hoveredId.value) hoveredId.value = ''
}
function deltaAngle(target, current) { return Math.atan2(Math.sin(target - current), Math.cos(target - current)) }
function focus(id) {
  const node = nodes.value.find(item => item.record.id === id)
  if (!node) return
  const { x, y, z } = node.point
  focusTarget = { yaw: Math.atan2(-x, z), pitch: Math.atan2(y, Math.hypot(x, z)) }
  if (motionPreference?.matches) { yaw = focusTarget.yaw; pitch = focusTarget.pitch; focusTarget = null }
  requestDraw()
}
function requestDraw() {
  if (!frameId && canvas.value && !document.hidden) frameId = requestAnimationFrame(tick)
}
function tick(time) {
  frameId = 0
  if (document.hidden) { lastFrame = 0; return }
  // 转动限制在每秒约 30 帧；静止时只在内容、视角或尺寸有变化时重画。
  if (lastFrame && time - lastFrame < 30) { requestDraw(); return }
  const elapsed = lastFrame ? Math.min(48, time - lastFrame) : 16
  lastFrame = time
  const rotating = autoRotate.value && !drag && !hoveredId.value
  if (focusTarget) {
    yaw += deltaAngle(focusTarget.yaw, yaw) * Math.min(1, elapsed * 0.012)
    pitch += (focusTarget.pitch - pitch) * Math.min(1, elapsed * 0.012)
    if (Math.abs(deltaAngle(focusTarget.yaw, yaw)) < 0.003 && Math.abs(focusTarget.pitch - pitch) < 0.003) focusTarget = null
  } else if (rotating) yaw += elapsed * 0.000068
  draw()
  if (focusTarget || (autoRotate.value && !drag && !hoveredId.value)) requestDraw()
  else lastFrame = 0
}
function hitTest(event) {
  const box = canvas.value.getBoundingClientRect()
  const x = event.clientX - box.left, y = event.clientY - box.top
  const marker = [...hitNodes].reverse().find(node => Math.hypot(node.x - x, node.y - y) < 10)
  if (marker) return marker
  return hitLabels.find(box => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h)?.node
}
function onPointerDown(event) {
  if (event.button !== 0) return
  drag = { x: event.clientX, y: event.clientY, yaw, pitch, moved: false }
  focusTarget = null
  canvas.value.setPointerCapture(event.pointerId)
  canvas.value.style.cursor = 'grabbing'
}
function onPointerMove(event) {
  if (drag) {
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y
    if (Math.hypot(dx, dy) > 4) drag.moved = true
    if (drag.moved) { yaw = drag.yaw + dx * 0.006; pitch = Math.max(-1.48, Math.min(1.48, drag.pitch + dy * 0.006)); autoRotate.value = false; hoveredId.value = ''; requestDraw() }
    return
  }
  const hit = hitTest(event)
  const nextId = hit?.record.id || ''
  if (hoveredId.value !== nextId) { hoveredId.value = nextId; requestDraw() }
  canvas.value.style.cursor = hit ? 'pointer' : 'grab'
}
function onPointerUp(event) {
  if (!drag) return
  const clicked = !drag.moved ? hitTest(event) : null
  drag = null
  canvas.value.style.cursor = 'grab'
  if (clicked) { autoRotate.value = false; emit('select', clicked.record); focus(clicked.record.id) }
  requestDraw()
}
function onPointerCancel() { drag = null; if (canvas.value) canvas.value.style.cursor = 'grab'; requestDraw() }
function onPointerLeave() { if (!drag) { hoveredId.value = ''; requestDraw() } }
function onWheel(event) { zoom = Math.max(0.72, Math.min(1.5, zoom * (event.deltaY > 0 ? 0.92 : 1.08))); requestDraw() }
function onKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', '+', '-', 'Enter'].includes(event.key)) return
  event.preventDefault()
  autoRotate.value = false
  focusTarget = null
  if (event.key === 'Enter') { const node = hitNodes.at(-1); if (node) { emit('select', node.record); focus(node.record.id) } }
  else if (event.key === 'Home') resetView()
  else if (event.key === '+') zoom = Math.min(1.5, zoom * 1.1)
  else if (event.key === '-') zoom = Math.max(0.72, zoom / 1.1)
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') yaw += event.key === 'ArrowLeft' ? -0.18 : 0.18
  else pitch = Math.max(-1.48, Math.min(1.48, pitch + (event.key === 'ArrowUp' ? -0.18 : 0.18)))
  requestDraw()
}
function resetView() {
  focusTarget = null; hoveredId.value = ''; yaw = defaultYaw; pitch = defaultPitch; zoom = 1
  // 从有限的候选视角挑出能读到较多记录和来源的半球，保留各条记录的固定球面位置。
  const sample = nodes.value.slice(0, 180)
  if (sample.length === 1) focus(sample[0].record.id)
  else if (sample.length) {
    let best = -1
    const landViews = [[75, 20], [20, 18], [100, 30], [-85, 25], [-65, -16], [32, -15], [135, -14], [-102, 45]]
    for (const [lon, lat] of landViews) {
      const longitude = -lon * Math.PI / 180, latitude = lat * Math.PI / 180
      const project = camera(1, 0, 0, longitude, latitude)
      const readable = new Set()
      let score = 0
      for (const node of sample) {
        const depth = project(node.point).z
        if (depth < 0.22) continue
        readable.add(node.record.id)
        score += 1 + depth * 0.5
      }
      for (const node of sample) if (readable.has(node.record.id) && node.links.some(id => readable.has(id))) score += 0.65
      if (score > best) { best = score; yaw = longitude; pitch = latitude }
    }
    if (best === 0) focus(sample[0].record.id)
  }
  requestDraw()
}

watch(nodes, (next, previous) => { if (next.length && !previous.length && !props.highlightId) resetView(); requestDraw() })
watch(() => props.selectedId, id => { if (id) focus(id); requestDraw() })
watch(() => props.highlightId, async id => { await nextTick(); if (id) focus(id); requestDraw() })
watch(autoRotate, requestDraw)
onMounted(() => {
  readPalette(); resize(); resetView()
  if (props.selectedId || props.highlightId) focus(props.selectedId || props.highlightId)
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(stage.value)
  themeObserver = new MutationObserver(readPalette)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  document.addEventListener('visibilitychange', requestDraw)
})
onBeforeUnmount(() => { cancelAnimationFrame(frameId); resizeObserver?.disconnect(); themeObserver?.disconnect(); document.removeEventListener('visibilitychange', requestDraw) })
</script>

<style scoped>
.idea-globe {
  --globe-idea: #ffd078; --globe-module: #d8b5ff; --globe-direction: #85f3d3;
  --globe-label: #f7fcf9; --globe-ink: #183b3b; --globe-border: #91b5ad; --globe-arc: #ccece4;
  --stage-ink: #244442; --stage-muted: #536f6d; --stage-edge: #c6d9d3; --stage-paper: #e9f2ed;
  --stage-center: #f6faf5; --stage-dot: #73948530; --stage-control: #f8fcf7ed;
  flex: 1; min-width: 0; min-height: 0; display: flex; padding: 12px 24px 18px;
}
html[data-theme="dark"] .idea-globe {
  --globe-idea: #ffc67d; --globe-module: #ddafff; --globe-direction: #76ecd0;
  --globe-label: #152d3a; --globe-ink: #e5f4f2; --globe-border: #577b85; --globe-arc: #a8d6dd;
  --stage-ink: #deefed; --stage-muted: #a5bcbf; --stage-edge: #2b4550; --stage-paper: #0c1923;
  --stage-center: #1b333e; --stage-dot: #83afbb25; --stage-control: #142a34ed;
}
.idea-globe-stage {
  container-type: inline-size; position: relative; flex: 1; min-height: 0; overflow: hidden;
  border: 1px solid var(--stage-edge); border-radius: 12px; color: var(--stage-ink);
  background-color: var(--stage-paper);
  background-image: radial-gradient(circle, var(--stage-dot) 0.8px, transparent 1px), radial-gradient(ellipse at 48% 42%, var(--stage-center), var(--stage-paper) 84%);
  background-size: 18px 18px, 100% 100%;
}
.idea-globe-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; cursor: grab; outline: none; touch-action: none; }
.idea-globe-canvas:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -3px; }
.idea-globe-toolbar, .idea-globe-footer { position: absolute; left: 20px; right: 20px; z-index: 1; display: flex; justify-content: space-between; gap: 12px; pointer-events: none; }
.idea-globe-toolbar { top: 17px; align-items: flex-start; }
.idea-globe-heading strong { display: block; font-size: 18px; font-weight: 650; letter-spacing: .03em; }
.idea-globe-heading div { margin-top: 3px; color: var(--stage-muted); font-size: 12px; }
.idea-globe-heading small { font-size: inherit; }
.idea-globe-actions { display: flex; align-items: center; padding: 2px; border: 1px solid var(--stage-edge); border-radius: 7px; background: var(--stage-control); pointer-events: auto; }
.idea-globe-actions button { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; border: 0; border-radius: 4px; background: transparent; color: var(--stage-ink); font: inherit; font-size: 12px; cursor: pointer; }
.idea-globe-actions .el-icon { font-size: 15px; }
.idea-globe-actions button:hover, .idea-globe-actions button[aria-pressed=true] { background: var(--stage-paper); }
.idea-globe-actions button:focus-visible { outline: 2px solid var(--accent-strong); }
.idea-globe-footer { align-items: flex-end; bottom: 15px; font-size: 11px; color: var(--stage-muted); }
.globe-legend { display: flex; flex-wrap: wrap; gap: 6px 15px; }
.globe-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.globe-legend i { display: inline-block; width: 9px; height: 9px; border: 1px solid #183a4280; }
.mark-idea { border-radius: 50%; background: var(--globe-idea); }
.mark-module { transform: rotate(45deg) scale(.9); background: var(--globe-module); }
.globe-legend .mark-direction { width: 10px; height: 10px; background: var(--globe-direction); clip-path: polygon(50% 0,100% 100%,0 100%); box-shadow: inset 0 -2px #26676285; }
.globe-legend .mark-link { width: 16px; height: 5px; border: 0; border-top: 1.5px solid var(--stage-muted); border-radius: 50%; transform: rotate(-12deg); }
.idea-globe-hint { margin-left: auto; white-space: nowrap; }
.idea-globe-message { position: absolute; z-index: 1; bottom: 38px; left: 50%; transform: translateX(-50%); width: max-content; max-width: 90%; padding: 6px 10px; border-radius: 5px; background: var(--stage-control); color: var(--stage-ink); text-align: center; font-size: 13px; pointer-events: none; }
.idea-globe-tooltip { position: absolute; z-index: 3; display: grid; gap: 4px; max-width: 202px; padding: 8px 11px; border: 1px solid var(--globe-border); border-radius: 6px; background: var(--globe-label); box-shadow: 0 4px 16px #102e3420; color: var(--globe-ink); overflow-wrap: anywhere; pointer-events: none; }
.idea-globe-tooltip strong { font-size: 13px; }
.idea-globe-tooltip span { font-size: 11px; }
@container (max-width: 580px) {
  .idea-globe-footer { flex-wrap: wrap; gap: 4px; }
  .idea-globe-hint { margin-left: 0; }
}
@container (max-width: 410px) {
  .idea-globe-toolbar, .idea-globe-footer { left: 12px; right: 12px; }
  .idea-globe-actions button span:not(.el-icon) { display: none; }
  .idea-globe-actions button { padding: 6px; }
}
@media (max-width: 1366px) { .idea-globe { padding: 10px 16px 14px; } }
</style>
