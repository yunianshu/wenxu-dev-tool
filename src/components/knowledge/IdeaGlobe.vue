<template>
  <section class="idea-globe" aria-label="想法地球">
    <header class="idea-globe-toolbar">
      <div class="idea-globe-heading"><strong>想法地球</strong><span>{{ records.length }} 个想法</span></div>
      <div class="idea-globe-actions">
        <button type="button" :aria-pressed="autoRotate" @click="autoRotate = !autoRotate">{{ autoRotate ? '暂停旋转' : '自动旋转' }}</button>
        <button type="button" @click="resetView">重置视角</button>
      </div>
    </header>
    <div ref="stage" class="idea-globe-stage">
      <canvas ref="canvas" class="idea-globe-canvas" tabindex="0"
        :aria-label="`想法地球，${records.length} 个想法。拖动或方向键旋转，滚轮缩放，点击节点打开记录。`"
        @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp"
        @pointercancel="onPointerCancel" @pointerleave="onPointerLeave" @wheel.prevent="onWheel" @keydown="onKeydown" />
      <div v-if="loading" class="idea-globe-message">正在读取想法…</div>
      <div v-else-if="!records.length" class="idea-globe-message"><strong>从第一个想法开始</strong><span>写下想法后，它会立即出现在地球上。</span></div>
      <div v-if="hoveredRecord" class="idea-globe-tooltip" :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }">
        <strong>{{ hoveredRecord.title }}</strong><span>{{ hoveredRecord.status === 'inbox' ? '待整理' : '想法' }} · 点击查看</span>
      </div>
      <div class="idea-globe-hint">拖动旋转　·　滚轮缩放　·　点击想法查看</div>
    </div>
    <footer class="idea-globe-footer"><span>每个光点对应一条本地想法记录</span><button type="button" @click="$emit('browse')">查看全部记录 <span aria-hidden="true">→</span></button></footer>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  records: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
  highlightId: { type: String, default: '' },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['select', 'browse'])
const stage = ref(null)
const canvas = ref(null)
const autoRotate = ref(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
const hoveredId = ref('')
const tooltip = ref({ x: 0, y: 0 })
const hoveredRecord = computed(() => props.records.find(row => row.id === hoveredId.value))

// ID 决定球面位置；记录排序、编辑或重新打开页面都不会让已有想法跳位。
function hash(value) {
  let result = 2166136261
  for (const char of String(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return result >>> 0
}
function pointFor(id) {
  const latitude = Math.acos(1 - 2 * ((hash(id) + 0.5) / 4294967296))
  const longitude = 2 * Math.PI * ((hash(`${id}:longitude`) + 0.5) / 4294967296)
  return { x: Math.sin(latitude) * Math.cos(longitude), y: Math.cos(latitude), z: Math.sin(latitude) * Math.sin(longitude) }
}
const nodes = computed(() => props.records.map(record => ({ record, point: pointFor(record.id) })))

let width = 0, height = 0, ratio = 1, zoom = 1, yaw = 0.35, pitch = -0.18
let frameId = 0, lastFrame = 0, dirty = true, resizeObserver, themeObserver, drag = null, focusTarget = null
let hitNodes = []
let palette = {}
function readPalette() {
  const style = getComputedStyle(stage.value)
  palette = {
    text: style.getPropertyValue('--brand-text').trim(),
    muted: style.getPropertyValue('--text-muted').trim(),
    line: style.getPropertyValue('--line-strong').trim(),
    accent: style.getPropertyValue('--accent-strong').trim(),
    surface: style.getPropertyValue('--surface').trim(),
  }
  dirty = true
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
  dirty = true
}
function rotate(point) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
  const x = point.x * cy + point.z * sy
  const z = -point.x * sy + point.z * cy
  return { x, y: point.y * cp - z * sp, z: point.y * sp + z * cp }
}
function project(point, radius, cx, cy) {
  const rotated = rotate(point)
  const depth = 2.9 / (2.9 - rotated.z * 0.45)
  return { x: cx + rotated.x * radius * depth, y: cy - rotated.y * radius * depth, z: rotated.z, depth }
}
function drawCurve(ctx, makePoint, radius, cx, cy) {
  for (const front of [false, true]) {
    ctx.beginPath()
    let started = false
    for (let step = 0; step <= 100; step++) {
      const value = step / 100 * Math.PI * 2
      const pos = project(makePoint(value), radius, cx, cy)
      const visible = (pos.z >= 0) === front
      if (!visible) { started = false; continue }
      if (!started) ctx.moveTo(pos.x, pos.y)
      else ctx.lineTo(pos.x, pos.y)
      started = true
    }
    ctx.globalAlpha = front ? 0.38 : 0.14
    ctx.stroke()
  }
}
function draw() {
  const el = canvas.value
  if (!el || !width || !height) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const radius = Math.max(80, Math.min(width * 0.39, height * 0.37, 280) * zoom)
  const cx = width * 0.5, cy = height * 0.49
  const edge = radius * 1.14

  const glow = ctx.createRadialGradient(cx - edge * 0.28, cy - edge * 0.3, 0, cx, cy, edge)
  glow.addColorStop(0, palette.accent + '18')
  glow.addColorStop(0.65, palette.accent + '08')
  glow.addColorStop(1, palette.accent + '02')
  ctx.fillStyle = glow
  ctx.beginPath(); ctx.arc(cx, cy, edge, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = palette.line
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, cy, edge, 0, Math.PI * 2); ctx.stroke()
  ctx.globalAlpha = 1

  ctx.strokeStyle = palette.line
  ctx.lineWidth = 1
  for (const latitude of [-60, -30, 0, 30, 60]) {
    const angle = latitude * Math.PI / 180
    drawCurve(ctx, t => ({ x: Math.cos(angle) * Math.cos(t), y: Math.sin(angle), z: Math.cos(angle) * Math.sin(t) }), radius, cx, cy)
  }
  for (let index = 0; index < 12; index++) {
    const longitude = index * Math.PI / 6
    drawCurve(ctx, t => ({ x: Math.cos(t) * Math.cos(longitude), y: Math.sin(t), z: Math.cos(t) * Math.sin(longitude) }), radius, cx, cy)
  }
  ctx.globalAlpha = 1

  const projected = nodes.value.map(node => ({ ...node, ...project(node.point, radius, cx, cy) }))
  const byId = new Map(projected.map(node => [node.record.id, node]))
  ctx.strokeStyle = palette.accent
  ctx.lineWidth = 1
  for (const node of projected) for (const sourceId of node.record.sourceIds || []) {
    const source = byId.get(sourceId)
    if (!source || node.z < -0.15 || source.z < -0.15) continue
    ctx.globalAlpha = 0.22
    ctx.beginPath(); ctx.moveTo(node.x, node.y); ctx.lineTo(source.x, source.y); ctx.stroke()
  }
  ctx.globalAlpha = 1
  hitNodes = []
  for (const node of projected.sort((a, b) => a.z - b.z)) {
    const selected = node.record.id === props.selectedId
    const hovered = node.record.id === hoveredId.value
    const focused = node.record.id === props.highlightId
    const size = selected || focused ? 6 : hovered ? 5 : 3.5
    ctx.globalAlpha = node.z < 0 ? 0.27 : 0.6 + node.z * 0.4
    ctx.fillStyle = palette.accent
    ctx.beginPath(); ctx.arc(node.x, node.y, size * node.depth, 0, Math.PI * 2); ctx.fill()
    if (selected || hovered || focused) {
      ctx.globalAlpha = node.z < 0 ? 0.25 : 0.75
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(node.x, node.y, (size + 5) * node.depth, 0, Math.PI * 2); ctx.stroke()
    }
    if (node.z > -0.08) hitNodes.push(node)
  }
  ctx.globalAlpha = 1

  // 只标注可见半球中少量记录，避免密集时文字遮挡球体。
  const occupied = []
  const labels = projected.filter(node => node.z > 0.18)
    .sort((a, b) => Number(b.record.id === props.selectedId || b.record.id === hoveredId.value || b.record.id === props.highlightId) - Number(a.record.id === props.selectedId || a.record.id === hoveredId.value || a.record.id === props.highlightId) || b.z - a.z)
    .slice(0, 16)
  ctx.font = '12px Inter, "Segoe UI", "Microsoft YaHei", sans-serif'
  for (const node of labels) {
    const title = [...(node.record.title || '未命名想法')].slice(0, 12).join('')
    const label = title.length < [...(node.record.title || '')].length ? `${title}…` : title
    const textWidth = ctx.measureText(label).width
    const x = node.x + 10, y = node.y - 8
    const box = { left: x - 2, right: x + textWidth + 2, top: y - 12, bottom: y + 3 }
    if (box.right > width - 8 || box.left < 8 || box.top < 8 || box.bottom > height - 8) continue
    if (occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue
    occupied.push(box)
    ctx.fillStyle = node.record.id === props.selectedId || node.record.id === hoveredId.value || node.record.id === props.highlightId ? palette.text : palette.muted
    ctx.globalAlpha = node.record.id === props.selectedId ? 1 : 0.88
    ctx.fillText(label, x, y)
  }
  ctx.globalAlpha = 1
  const hovered = byId.get(hoveredId.value)
  if (hovered && hovered.z > -0.08) tooltip.value = { x: Math.min(width - 210, Math.max(12, hovered.x + 16)), y: Math.min(height - 70, Math.max(12, hovered.y + 12)) }
  else if (hoveredId.value) hoveredId.value = ''
}
function deltaAngle(target, current) { return Math.atan2(Math.sin(target - current), Math.cos(target - current)) }
function focus(id) {
  const node = nodes.value.find(item => item.record.id === id)
  if (!node) return
  const { x, y, z } = node.point
  focusTarget = { yaw: Math.atan2(-x, z), pitch: Math.atan2(y, Math.hypot(x, z)) }
  dirty = true
}
function tick(time) {
  const elapsed = lastFrame ? Math.min(48, time - lastFrame) : 16
  lastFrame = time
  if (!document.hidden) {
    if (focusTarget) {
      yaw += deltaAngle(focusTarget.yaw, yaw) * Math.min(1, elapsed * 0.012)
      pitch += (focusTarget.pitch - pitch) * Math.min(1, elapsed * 0.012)
      if (Math.abs(deltaAngle(focusTarget.yaw, yaw)) < 0.003 && Math.abs(focusTarget.pitch - pitch) < 0.003) focusTarget = null
      dirty = true
    } else if (autoRotate.value && !drag) { yaw += elapsed * 0.00012; dirty = true }
    if (dirty) { draw(); dirty = false }
  }
  frameId = requestAnimationFrame(tick)
}
function hitTest(event) {
  const box = canvas.value.getBoundingClientRect()
  const x = event.clientX - box.left, y = event.clientY - box.top
  return [...hitNodes].reverse().find(node => Math.hypot(node.x - x, node.y - y) < Math.max(10, 8 * node.depth))
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
    if (drag.moved) { yaw = drag.yaw + dx * 0.006; pitch = Math.max(-1.25, Math.min(1.25, drag.pitch + dy * 0.006)); autoRotate.value = false; dirty = true }
    return
  }
  const hit = hitTest(event)
  hoveredId.value = hit?.record.id || ''
  canvas.value.style.cursor = hit ? 'pointer' : 'grab'
  dirty = true
}
function onPointerUp(event) {
  if (!drag) return
  const clicked = !drag.moved ? hitTest(event) : null
  drag = null
  canvas.value.style.cursor = 'grab'
  if (clicked) { emit('select', clicked.record); focus(clicked.record.id) }
  dirty = true
}
function onPointerCancel() { drag = null; if (canvas.value) canvas.value.style.cursor = 'grab' }
function onPointerLeave() { if (!drag) { hoveredId.value = ''; dirty = true } }
function onWheel(event) { zoom = Math.max(0.72, Math.min(1.5, zoom * (event.deltaY > 0 ? 0.92 : 1.08))); dirty = true }
function onKeydown(event) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', '+', '-'].includes(event.key)) return
  event.preventDefault()
  autoRotate.value = false
  if (event.key === 'Home') resetView()
  else if (event.key === '+') zoom = Math.min(1.5, zoom * 1.1)
  else if (event.key === '-') zoom = Math.max(0.72, zoom / 1.1)
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') yaw += event.key === 'ArrowLeft' ? -0.18 : 0.18
  else pitch = Math.max(-1.25, Math.min(1.25, pitch + (event.key === 'ArrowUp' ? -0.18 : 0.18)))
  dirty = true
}
function resetView() { focusTarget = null; yaw = 0.35; pitch = -0.18; zoom = 1; dirty = true }

watch(() => props.records.map(row => `${row.id}:${row.title}:${row.status}`).join('|'), () => { dirty = true })
watch(() => props.selectedId, id => { if (id) focus(id); dirty = true })
watch(() => props.highlightId, async id => { await nextTick(); if (id) focus(id); dirty = true })
watch(autoRotate, () => { dirty = true })
onMounted(() => {
  readPalette(); resize()
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(stage.value)
  themeObserver = new MutationObserver(readPalette)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  frameId = requestAnimationFrame(tick)
})
onBeforeUnmount(() => { cancelAnimationFrame(frameId); resizeObserver?.disconnect(); themeObserver?.disconnect() })
</script>

<style scoped>
.idea-globe { display: flex; flex: 1; min-width: 0; min-height: 0; flex-direction: column; background: var(--surface); }
.idea-globe-toolbar { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; gap: 16px; height: 48px; padding: 0 24px; border-bottom: 1px solid var(--line-soft); }
.idea-globe-heading { display: flex; align-items: baseline; gap: 12px; }
.idea-globe-heading strong { color: var(--brand-text); font-size: 14px; font-weight: 600; }
.idea-globe-heading span, .idea-globe-actions button { color: var(--text-muted); font-size: 12px; }
.idea-globe-actions { display: flex; align-items: center; gap: 8px; }
.idea-globe-actions button, .idea-globe-footer button { border: 0; border-radius: 4px; background: transparent; padding: 6px 8px; cursor: pointer; }
.idea-globe-actions button:hover, .idea-globe-footer button:hover { color: var(--brand-text); background: var(--surface-subtle); }
.idea-globe-actions button:focus-visible, .idea-globe-footer button:focus-visible { outline: 2px solid var(--accent-strong); }
.idea-globe-stage { position: relative; flex: 1; min-height: 320px; overflow: hidden; background: var(--surface); }
.idea-globe-canvas { display: block; width: 100%; height: 100%; cursor: grab; outline: none; touch-action: none; }
.idea-globe-canvas:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: -4px; }
.idea-globe-message { position: absolute; left: 50%; top: 49%; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; width: 260px; padding: 16px; transform: translate(-50%, -50%); background: var(--surface); color: var(--text-muted); text-align: center; font-size: 13px; pointer-events: none; }
.idea-globe-message strong { color: var(--brand-text); font-size: 14px; }
.idea-globe-tooltip { position: absolute; z-index: 2; display: flex; flex-direction: column; gap: 4px; max-width: 200px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); box-shadow: var(--shadow-float); pointer-events: none; }
.idea-globe-tooltip strong { overflow: hidden; color: var(--brand-text); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.idea-globe-tooltip span { color: var(--text-muted); font-size: 11px; }
.idea-globe-hint { position: absolute; left: 24px; bottom: 16px; color: var(--text-muted); font-size: 11px; pointer-events: none; }
.idea-globe-footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; padding: 0 16px 0 24px; border-top: 1px solid var(--line); color: var(--text-muted); font-size: 11px; }
.idea-globe-footer button { color: var(--accent-strong); font-size: 12px; }
@media (max-width: 900px) { .idea-globe-toolbar { padding: 0 16px; }.idea-globe-hint { left: 16px; }.idea-globe-footer { padding-left: 16px; } }
</style>
