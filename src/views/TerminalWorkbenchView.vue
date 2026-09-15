<template>
  <div class="page terminal-page">
    <PageHeader title="终端工作台" description="一个窗格一个项目会话，多项目的 CLI 同屏并行；切到其他页面后仍在后台运行。">
      <template #actions>
        <div class="terminal-toolbar">
          <el-dropdown trigger="click" :disabled="!canAddPane" @command="addPane">
            <el-button type="primary" :disabled="!canAddPane" :title="panes.length >= MAX_PANES ? `最多同时开 ${MAX_PANES} 个窗格` : ''">
              <el-icon><Plus /></el-icon>添加窗格
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="p in addableProjects" :key="p.id" :command="p.id">{{ p.name }}</el-dropdown-item>
                <el-dropdown-item v-if="!addableProjects.length" disabled>没有可添加的项目（需先关联本地目录）</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <!-- 分屏方式：自动按窗格数排；也可手动锁定列/行。
               窗格多于一屏格子时行数会自动往下加，比例由 track 数对齐（见 layout） -->
          <el-radio-group v-model="gridMode" size="small">
            <el-radio-button value="auto">自动</el-radio-button>
            <el-radio-button value="1x2">左右</el-radio-button>
            <el-radio-button value="2x1">上下</el-radio-button>
            <el-radio-button value="2x2">四宫格</el-radio-button>
            <el-radio-button value="3x1">三宫格</el-radio-button>
          </el-radio-group>

          <el-button v-if="panes.length" size="small" @click="closeAll">全部关闭</el-button>
        </div>
      </template>
    </PageHeader>

    <p v-if="!state.projects.items.length" class="terminal-hint">
      还没有项目：先到「项目」页创建项目并关联本地目录，再回到这里分屏开终端。
    </p>

    <div v-else-if="!panes.length" class="terminal-empty">
      <p>从右上角「添加窗格」选择项目，最多四个项目同屏盯。</p>
      <p class="terminal-empty-sub">上次的布局会自动记住，下次打开软件直接恢复。</p>
    </div>

    <!-- 平铺网格：列/行之间可拖拽调整比例（比例随布局一起落盘） -->
    <div v-else ref="gridRef" class="terminal-grid" :style="gridStyle">
      <TerminalPane
        v-for="(pane, index) in panes"
        :key="pane.paneId"
        :style="cellStyle(index)"
        :pane="pane"
        :focused="index === activeIndex"
        :shell-options="shellOptions"
        @focus="activeIndex = index"
        @close="removePane(index)"
        @session="onSession"
        @update:shell="onShellChange"
      />
      <!-- 竖向分隔条：每行内相邻两列之间 -->
      <div
        v-for="sep in columnSeps"
        :key="`v-${sep.index}`"
        class="term-splitter term-splitter--v"
        :style="splitterStyle(sep.index)"
        title="拖动调整左右宽度"
        @mousedown="startColumnDrag(sep.index, $event)"
      />
      <!-- 横向分隔条：两行之间 -->
      <div
        v-for="sep in rowSeps"
        :key="`h-${sep.index}`"
        class="term-splitter term-splitter--h"
        :style="splitterStyle(sep.index, true)"
        title="拖动调整上下高度"
        @mousedown="startRowDrag(sep.index, $event)"
      />
    </div>
  </div>
</template>

<script setup>
/**
 * 终端工作台 —— 多窗格平铺（一窗格 = 一个项目会话）
 *
 * 布局持久化：窗格顺序 / 绑定的项目 / shell 选择 / 分屏方式与列宽行高比例
 * 全部写入 userData/terminal-layout.json，下次启动自动恢复同样排布。
 * 进程本身不跨应用重启（pty 随应用退出结束），恢复时按项目目录重新拉起会话。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Plus } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import TerminalPane from '../components/TerminalPane.vue'
import { state } from '../store'

/** 网格预设：列 × 行 */
const GRID_PRESETS = {
  '1x2': { cols: 2, rows: 1 },
  '2x1': { cols: 1, rows: 2 },
  '2x2': { cols: 2, rows: 2 },
  '3x1': { cols: 3, rows: 1 },
}
const MIN_SHARE = 0.15
/** 最多同屏窗格数（与文档一致）；超过这个数就不再允许添加 */
const MAX_PANES = 4

const panes = ref([])
const gridMode = ref('auto')
const shellOptions = ref([])
const activeIndex = ref(0)
const columnWidths = ref([0.5, 0.5])
const rowHeights = ref([0.5, 0.5])
const gridRef = ref(null)

/**
 * 列数/行数。
 * auto：按窗格数选最接近方形的排布（1→1×1，2→1×2，3/4→2×2，再多就往下加行）。
 * 手动：预设给出要的列数与**最小**行数，窗格多于一屏格子时必须继续加行——
 *   多出来的窗格会落到隐式 auto 轨道上，把 fr 轨道挤到只剩几像素（窗格看着「消失」）。
 */
const layout = computed(() => {
  const count = Math.max(1, panes.value.length)
  const preset = gridMode.value !== 'auto' ? GRID_PRESETS[gridMode.value] : null
  if (preset) {
    return { cols: preset.cols, rows: Math.max(preset.rows, Math.ceil(count / preset.cols)) }
  }
  if (count <= 1) return { cols: 1, rows: 1 }
  return { cols: 2, rows: Math.ceil(count / 2) }
})

/**
 * 轨道比例数组的长度必须精确等于轨道数：少一个就会出现隐式 auto 轨道，
 * 而 auto 轨道优先按内容占位、会把 fr 轨道挤没。长度对不上时直接等分。
 */
function fitShares(list, count) {
  const n = Math.max(1, count)
  if (list.length === n) return list
  return Array.from({ length: n }, () => 1 / n)
}

// 分屏维度变化（切分屏方式、增删窗格）时把比例对齐到实际轨道数
watch(
  () => `${layout.value.cols}x${layout.value.rows}`,
  () => {
    columnWidths.value = fitShares(columnWidths.value, layout.value.cols)
    rowHeights.value = fitShares(rowHeights.value, layout.value.rows)
  },
  { immediate: true },
)

const gridStyle = computed(() => ({
  gridTemplateColumns: columnWidths.value.map((w) => `${w}fr`).join(' '),
  gridTemplateRows: rowHeights.value.map((h) => `${h}fr`).join(' '),
}))

function cellStyle(index) {
  const { cols } = layout.value
  return { gridColumn: `${(index % cols) + 1}`, gridRow: `${Math.floor(index / cols) + 1}` }
}

/** 竖向分隔条：每个列交界一条（跨全部行）。
 *  按窗格索引生成会出现「同一列交界、上下两行各一条」的重叠元素，这里按列去重 */
const columnSeps = computed(() => {
  const { cols } = layout.value
  const list = []
  if (cols < 2) return list
  for (let c = 0; c < cols - 1; c += 1) {
    // 该列右侧确实还有窗格时才画（末行只剩一个窗格时不画右半段的空分隔条）
    const hasNeighbor = panes.value.some((_, i) => i % cols === c && i + 1 < panes.value.length)
    if (hasNeighbor) list.push({ index: c })
  }
  return list
})

/** 横向分隔条：仅下一行确实有窗格时才显示（窗格数不足整行时不画空分隔条） */
const rowSeps = computed(() => {
  const { cols, rows } = layout.value
  const list = []
  if (rows < 2) return list
  for (let r = 1; r < rows; r += 1) {
    if (panes.value.length > r * cols) list.push({ index: r })
  }
  return list
})

/**
 * 分隔条定位：先落在间隙左/上方的单元格里，再由 CSS 用负外边距溢到间隙上。
 * grid 没有「放在 gap 上」的写法；若直接占用相邻那一列/行，分隔条会铺满该单元格，
 * 把那个窗格（含标题栏按钮）的鼠标事件全部吞掉，只剩一个窗格能点。
 */
function splitterStyle(index, horizontal = false) {
  if (horizontal) return { gridColumn: `1 / span ${layout.value.cols}`, gridRow: `${index}` }
  return { gridColumn: `${(index % layout.value.cols) + 1}`, gridRow: `1 / span ${layout.value.rows}` }
}

/** 可添加的项目：有关联目录且尚未出现在窗格中 */
const addableProjects = computed(() => {
  const used = new Set(panes.value.map((p) => p.projectId))
  return state.projects.items.filter((p) => p.localPath && !used.has(p.id))
})

/** 还能不能再加：受窗格总数与可添加项目数双重限制 */
const canAddPane = computed(() => panes.value.length < MAX_PANES && addableProjects.value.length > 0)

function makePane(project, saved = {}) {
  return {
    paneId: `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    projectId: project.id,
    projectName: project.name,
    cwd: project.localPath,
    shellId: saved.shellId || '',
    // 运行期字段（不落盘）：会话 id / shell 展示名 / 退出状态
    sessionId: '',
    shellLabel: '',
    pid: 0,
    exited: false,
    exitCode: null,
  }
}

function addPane(projectId) {
  const project = state.projects.items.find((p) => p.id === projectId)
  if (!project?.localPath) {
    ElMessage.warning('该项目未关联本地目录，无法打开终端')
    return
  }
  if (panes.value.length >= MAX_PANES) {
    ElMessage.warning(`最多同时开 ${MAX_PANES} 个窗格`)
    return
  }
  panes.value.push(makePane(project))
  activeIndex.value = panes.value.length - 1
}

async function removePane(index) {
  const pane = panes.value[index]
  if (!pane) return
  if (pane.sessionId) await window.gitReport.terminalClose(pane.sessionId).catch(() => {})
  panes.value.splice(index, 1)
  activeIndex.value = Math.max(0, Math.min(activeIndex.value, panes.value.length - 1))
}

async function closeAll() {
  try {
    await ElMessageBox.confirm('会结束所有窗格里的终端进程（未保存的命令行会丢失）。', '关闭全部窗格', {
      type: 'warning',
      confirmButtonText: '全部关闭',
      cancelButtonText: '取消',
    })
  } catch {
    return // 用户取消
  }
  for (const pane of panes.value) {
    if (pane.sessionId) await window.gitReport.terminalClose(pane.sessionId).catch(() => {})
  }
  panes.value = []
  state.terminal.focusedProjectId = ''
}

/** 子组件回传会话状态（含进程退出），落到对应窗格 */
function onSession(payload) {
  const pane = panes.value.find((p) => p.paneId === payload.paneId)
  if (!pane) return
  Object.assign(pane, payload)
  if (pane.sessionId) state.terminal.focusedProjectId = pane.projectId
}

function onShellChange({ paneId, shellId }) {
  const pane = panes.value.find((p) => p.paneId === paneId)
  if (pane) pane.shellId = shellId
}

// ─── 拖拽分隔条：调整列宽 / 行高比例（比例随布局落盘） ───
/** 把位移量按比例分给相邻两列/行，各自保留最小份额（避免拖成 0 宽） */
function applyDrag(target, start, index, delta) {
  const sum = start[index] + start[index + 1]
  const value = Math.min(Math.max(start[index] + delta, MIN_SHARE), sum - MIN_SHARE)
  const next = [...start]
  next[index] = value
  next[index + 1] = sum - value
  target.value = next
}

function startColumnDrag(index, event) {
  event.preventDefault()
  const rect = gridRef.value?.getBoundingClientRect()
  if (!rect?.width) return
  const startX = event.clientX
  const start = [...columnWidths.value]
  const onMove = (e) => applyDrag(columnWidths, start, index, (e.clientX - startX) / rect.width)
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function startRowDrag(index, event) {
  event.preventDefault()
  const rect = gridRef.value?.getBoundingClientRect()
  if (!rect?.height) return
  const startY = event.clientY
  const start = [...rowHeights.value]
  const onMove = (e) => applyDrag(rowHeights, start, index - 1, (e.clientY - startY) / rect.height)
  const onUp = () => {
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ─── 布局持久化：任何结构性变化都落盘（项目、shell、分屏方式、列宽行高） ───
let saveTimer = null
/** 恢复期间抑制落盘：恢复顺带会改分屏方式/列宽，若因此写盘，
 *  会把「因项目当前不可用而跳过的窗格」覆盖成永久丢失 */
let restoring = false

function buildLayout() {
  return {
    gridMode: gridMode.value,
    // 轨道比例按实际轨道数存（「上下」4 窗格就是 4 个数），数量随分屏方式变化。
    // 必须浅拷贝成普通数组：Vue 的响应式数组是 Proxy，直接传进 contextBridge
    // 暴露的接口会在克隆阶段抛 "An object could not be cloned"（preload 的 toPlain 拦不住）
    columnWidths: [...columnWidths.value],
    rowHeights: [...rowHeights.value],
    panes: panes.value.map((p) => ({
      projectId: p.projectId,
      shellId: p.shellId,
      title: '',
      width: 0.5,
    })),
  }
}

/** 立即落盘（切页/卸载时用，绕过 400ms 防抖） */
function writeLayout() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  window.gitReport.terminalLayoutSave(buildLayout()).catch(() => {})
}

function scheduleSave() {
  if (restoring) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    window.gitReport.terminalLayoutSave(buildLayout()).catch(() => {})
  }, 400)
}

watch(
  [
    () => panes.value.map((p) => `${p.projectId}:${p.shellId}`).join('|'),
    gridMode,
    columnWidths,
    rowHeights,
  ],
  scheduleSave,
  { deep: true },
)

/**
 * 磁盘上的轨道比例是否可用：长度 1~12、每个都是 (0,1] 的正数。
 * 长度随分屏方式变化（「上下」4 窗格存 4 个），不能按固定两位校验。
 */
function isShareList(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 12
    && value.every((n) => Number.isFinite(n) && n > 0 && n <= 1)
}

/** 启动恢复：读上次布局 → 只保留项目仍存在且有本地目录的窗格 */
async function restoreLayout() {
  const res = await window.gitReport.terminalLayoutGet().catch(() => null)
  const saved = res?.layout
  if (!saved?.panes?.length) return
  restoring = true
  try {
    const restored = []
    let missing = 0
    const seen = new Set()
    for (const item of saved.panes) {
      const project = state.projects.items.find((p) => p.id === item.projectId)
      // 同一项目只恢复一个窗格：两个窗格绑同一项目会 attach 到同一个 pty，输出会互相串
      if (!project?.localPath || seen.has(item.projectId)) { missing += 1; continue }
      seen.add(item.projectId)
      const pane = makePane(project, item)
      // 上次的 shell 选择也要恢复（该 id 在当前机器上不存在时回落自动）
      if (item.shellId && shellOptions.value.some((o) => o.id === item.shellId)) pane.shellId = item.shellId
      restored.push(pane)
    }
    if (saved.gridMode === 'auto' || GRID_PRESETS[saved.gridMode]) gridMode.value = saved.gridMode
    panes.value = restored.slice(0, MAX_PANES)
    // 比例必须在窗格之后设置：此时轨道数才确定，长度匹配的值会被原样保留；
    // 反过来先设比例，会被中间态的轨道数等分覆盖，用户拖好的比例就丢了
    if (isShareList(saved.columnWidths)) columnWidths.value = saved.columnWidths
    if (isShareList(saved.rowHeights)) rowHeights.value = saved.rowHeights
    if (missing) ElMessage.warning(`上次有 ${missing} 个窗格的项目已不可用，已跳过`)
  } finally {
    // 等 watch 回调跑完再解除抑制：恢复动作本身不落盘，避免把跳过的窗格写没
    await nextTick()
    restoring = false
  }
}

onMounted(async () => {
  const opt = await window.gitReport.terminalShellOptions().catch(() => null)
  shellOptions.value = opt?.options || []
  await restoreLayout()
  await nextTick()
  activeIndex.value = 0
  // 从项目页「在终端工作台打开」跳转过来：优先聚焦该项目
  const wantId = state.terminal.pendingFocusProjectId
  state.terminal.pendingFocusProjectId = ''
  if (wantId) focusProject(wantId)
})

/** 切到其他页面会卸载本视图：立即落盘（不等 400ms 防抖）。
 *  否则「改完布局就切页、紧接着关掉应用」时，防抖里那次改动会随进程一起消失 */
onBeforeUnmount(() => {
  if (saveTimer) writeLayout()
})

/** 项目被删除时同步移除对应窗格，避免留一个死窗格 */
watch(() => state.projects.items.map((p) => p.id).join('|'), () => {
  const ids = new Set(state.projects.items.map((p) => p.id))
  const kept = panes.value.filter((p) => ids.has(p.projectId))
  if (kept.length === panes.value.length) return
  for (const pane of panes.value) {
    if (!ids.has(pane.projectId) && pane.sessionId) window.gitReport.terminalClose(pane.sessionId).catch(() => {})
  }
  panes.value = kept
})

/** 切到指定项目：已有窗格则聚焦，没有则新增一个 */
function focusProject(projectId) {
  const project = state.projects.items.find((p) => p.id === projectId)
  if (!project?.localPath) {
    ElMessage.warning('该项目未关联本地目录，无法打开终端')
    return
  }
  const index = panes.value.findIndex((p) => p.projectId === projectId)
  if (index >= 0) {
    activeIndex.value = index
    return
  }
  addPane(projectId)
}
</script>

<style scoped>
/* 与 Harness 页同样的满高布局：工具条固定，网格占满剩余高度 */
.terminal-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.terminal-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.terminal-hint,
.terminal-empty {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.8;
}

.terminal-empty {
  margin-top: 40px;
  text-align: center;
}

.terminal-empty-sub {
  color: var(--brand-text-sub);
  font-size: 13px;
}

/* 平铺网格：间隙由分隔条填充，分隔条本身可拖拽。
   --splitter-hit 同时决定间隙宽度与分隔条命中区，两者必须一致：
   分隔条只有正好压在间隙上，才不会侵占两侧窗格的鼠标事件。 */
.terminal-grid {
  --splitter-hit: 6px;
  flex: 1;
  min-height: 0;
  margin-top: 16px;
  display: grid;
  gap: var(--splitter-hit);
  padding-bottom: 4px;
  /* 兜底：万一轨道数算错，隐式轨道也等分剩余空间，
     而不是让窗格落进 auto 轨道被挤成几像素高 */
  grid-auto-rows: minmax(0, 1fr);
  grid-auto-columns: minmax(0, 1fr);
}

/* 分隔条：只占间隙那一小条，hover 时高亮提示可拖动 */
.term-splitter {
  position: relative;
  z-index: 2;
  background: transparent;
}

/* 竖向：占左侧那一列，向右溢出一个间隙宽，正好压在两列之间 */
.term-splitter--v {
  align-self: stretch;
  justify-self: end;
  width: var(--splitter-hit);
  margin-right: calc(-1 * var(--splitter-hit));
  cursor: col-resize;
}

/* 横向：占上方那一行，向下溢出一个间隙高，正好压在两行之间 */
.term-splitter--h {
  justify-self: stretch;
  align-self: end;
  height: var(--splitter-hit);
  margin-bottom: calc(-1 * var(--splitter-hit));
  cursor: row-resize;
}

.term-splitter::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  background: var(--line-strong);
  opacity: 0;
  transition: opacity .15s ease;
}

.term-splitter--v::after {
  width: 2px;
  height: 100%;
}

.term-splitter--h::after {
  width: 100%;
  height: 2px;
}

.term-splitter:hover::after {
  opacity: 1;
  background: var(--brand-accent);
}

/* 网格里的窗格自己撑满单元格 */
.terminal-grid :deep(.term-pane) {
  min-width: 0;
  min-height: 0;
}
</style>
