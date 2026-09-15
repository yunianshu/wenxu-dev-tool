<template>
  <div class="page terminal-page">
    <PageHeader title="终端工作台" description="一个窗格一个项目会话，多项目的 CLI 同屏并行；切到其他页面后仍在后台运行。">
      <template #actions>
        <div class="terminal-toolbar">
          <el-dropdown trigger="click" :disabled="!addableProjects.length" @command="addPane">
            <el-button type="primary" :disabled="!addableProjects.length">
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

          <!-- 分屏方式：自动按窗格数排；也可手动锁定列/行 -->
          <el-radio-group v-model="gridMode" size="small" @change="onGridChange">
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
import { computed, nextTick, onMounted, ref, watch } from 'vue'
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

const panes = ref([])
const gridMode = ref('auto')
const shellOptions = ref([])
const activeIndex = ref(0)
const columnWidths = ref([0.5, 0.5])
const rowHeights = ref([0.5, 0.5])
const gridRef = ref(null)

/** 列数/行数：auto 时按窗格数选最接近方形的排布（1→1×1，2→1×2，3/4→2×2） */
const layout = computed(() => {
  if (gridMode.value !== 'auto' && GRID_PRESETS[gridMode.value]) return GRID_PRESETS[gridMode.value]
  const count = panes.value.length
  if (count <= 1) return { cols: 1, rows: 1 }
  if (count === 2) return { cols: 2, rows: 1 }
  return { cols: 2, rows: 2 }
})

const gridStyle = computed(() => ({
  gridTemplateColumns: columnWidths.value.slice(0, layout.value.cols).map((w) => `${w}fr`).join(' '),
  gridTemplateRows: rowHeights.value.slice(0, layout.value.rows).map((h) => `${h}fr`).join(' '),
}))

function cellStyle(index) {
  const { cols } = layout.value
  return { gridColumn: `${(index % cols) + 1}`, gridRow: `${Math.floor(index / cols) + 1}` }
}

/** 竖向分隔条：仅同一行内、且其右侧确实还有窗格时才有意义 */
const columnSeps = computed(() => {
  const { cols } = layout.value
  const list = []
  if (cols < 2) return list
  panes.value.forEach((_, index) => {
    if ((index + 1) % cols !== 0 && index < panes.value.length - 1) list.push({ index })
  })
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

/** 分隔条定位：竖向落在两列交界（跨整行），横向落在两行交界（跨整行宽） */
function splitterStyle(index, horizontal = false) {
  if (horizontal) return { gridColumn: `1 / span ${layout.value.cols}`, gridRow: `${index + 1}` }
  return { gridColumn: `${index + 2}`, gridRow: `1 / span ${layout.value.rows}` }
}

/** 可添加的项目：有关联目录且尚未出现在窗格中 */
const addableProjects = computed(() => {
  const used = new Set(panes.value.map((p) => p.projectId))
  return state.projects.items.filter((p) => p.localPath && !used.has(p.id))
})

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

function onGridChange(mode) {
  gridMode.value = mode
  const preset = GRID_PRESETS[mode]
  if (preset) {
    columnWidths.value = Array.from({ length: preset.cols }, () => 1 / preset.cols)
    rowHeights.value = Array.from({ length: preset.rows }, () => 1 / preset.rows)
  }
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
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    window.gitReport.terminalLayoutSave({
      gridMode: gridMode.value,
      columnWidths: columnWidths.value.slice(0, 2),
      rowHeights: rowHeights.value.slice(0, 2),
      panes: panes.value.map((p) => ({
        projectId: p.projectId,
        shellId: p.shellId,
        title: '',
        width: 0.5,
      })),
    }).catch(() => {})
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

/** 启动恢复：读上次布局 → 只保留项目仍存在且有本地目录的窗格 */
async function restoreLayout() {
  const res = await window.gitReport.terminalLayoutGet().catch(() => null)
  const saved = res?.layout
  if (!saved?.panes?.length) return
  const restored = []
  let missing = 0
  for (const item of saved.panes) {
    const project = state.projects.items.find((p) => p.id === item.projectId)
    if (!project?.localPath) { missing += 1; continue }
    const pane = makePane(project, item)
    // 上次的 shell 选择也要恢复（该 id 在当前机器上不存在时回落自动）
    if (item.shellId && shellOptions.value.some((o) => o.id === item.shellId)) pane.shellId = item.shellId
    restored.push(pane)
  }
  if (saved.gridMode === 'auto' || GRID_PRESETS[saved.gridMode]) gridMode.value = saved.gridMode
  if (Array.isArray(saved.columnWidths) && saved.columnWidths.length === 2) columnWidths.value = saved.columnWidths
  if (Array.isArray(saved.rowHeights) && saved.rowHeights.length === 2) rowHeights.value = saved.rowHeights
  panes.value = restored.slice(0, 4)
  // 恢复动作本身会触发 watch：这里不落盘（避免把「跳过失效窗格」的结果写回去丢信息）
  if (missing) ElMessage.warning(`上次有 ${missing} 个窗格的项目已不可用，已跳过`)
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

/* 平铺网格：1px 间隙由分隔条填充，分隔条本身可拖拽 */
.terminal-grid {
  flex: 1;
  min-height: 0;
  margin-top: 16px;
  display: grid;
  gap: 6px;
  padding-bottom: 4px;
}

/* 分隔条：落在网格间隙里，hover 时高亮提示可拖动 */
.term-splitter {
  position: relative;
  z-index: 2;
  align-self: stretch;
  justify-self: stretch;
  cursor: col-resize;
  background: transparent;
}

.term-splitter--h {
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
