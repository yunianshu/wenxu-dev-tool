<template>
  <div class="page terminal-page">
    <!-- 标题栏投递到应用顶栏：该页与「当前项目」无关，顶栏原本闲置；
         投递后既省下一条标题栏的高度给终端，也让顶栏承载真实操作。
         沉浸全屏时顶栏整体不存在（v-if），所以用 v-if 而不是 disabled。 -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page terminal-topbar-page">
        <div class="terminal-topbar-identity">
          <span class="terminal-topbar-mark" aria-hidden="true">›_</span>
          <h1 class="topbar-page-title">终端工作台</h1>
          <span class="terminal-pane-total">{{ panes.length }} 个窗格</span>
        </div>
        <div class="terminal-toolbar">
          <el-dropdown trigger="click" popper-class="terminal-menu-popper" :disabled="!canAddPane" @command="addPane">
            <el-button class="terminal-add-button" type="primary" :disabled="!canAddPane" :title="panes.length >= MAX_PANES ? `最多同时开 ${MAX_PANES} 个窗格` : ''">
              <el-icon><Plus /></el-icon>新建终端
              <el-icon class="el-icon--right"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="p in addableProjects" :key="p.id" :command="p.id">
                  {{ p.name }}
                  <span v-if="openPaneCount[p.id]" class="pane-count">已开 {{ openPaneCount[p.id] }}</span>
                </el-dropdown-item>
                <el-dropdown-item v-if="!addableProjects.length" disabled>没有可添加的项目（需先关联本地目录）</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>

          <!-- 分屏方式：图标化（方框 + 分割线示意怎么切格子），文字挪到 hover 提示。
               五个文字分段并排会横向吃掉一大片，而这里表达的本来就适合图形化。
               窗格多于一屏格子时行数会自动往下加，比例由 track 数对齐（见 layout） -->
          <span class="terminal-toolbar-divider" aria-hidden="true" />
          <span class="terminal-toolbar-label">布局</span>
          <el-radio-group v-model="gridMode" class="terminal-layout-control">
            <el-tooltip
              v-for="opt in GRID_OPTIONS"
              :key="opt.value"
              :content="opt.label"
              placement="bottom"
              :show-after="200"
            >
              <el-radio-button :value="opt.value" :aria-label="opt.label">
                <svg class="grid-icon" viewBox="0 0 16 16" aria-hidden="true">
                  <rect
                    v-for="(cell, i) in opt.cells"
                    :key="i"
                    :x="cell[0]"
                    :y="cell[1]"
                    :width="cell[2]"
                    :height="cell[3]"
                    rx="1.5"
                  />
                </svg>
              </el-radio-button>
            </el-tooltip>
          </el-radio-group>

          <span class="terminal-toolbar-divider" aria-hidden="true" />
          <el-button class="terminal-quiet-button" @click="fontSettingsVisible = true">字体</el-button>
          <el-button v-if="panes.length" class="terminal-quiet-button" @click="closeAll">关闭全部</el-button>
        </div>
      </div>
    </Teleport>

    <el-dialog v-model="fontSettingsVisible" title="终端字体" width="460px" class="terminal-font-dialog">
      <TerminalFontSettings />
    </el-dialog>

    <p v-if="!state.projects.items.length" class="terminal-hint">
      还没有项目：先到「项目」页创建项目并关联本地目录，再回到这里分屏开终端。
    </p>

    <div v-else-if="!panes.length" class="terminal-empty">
      <p>从右上角「新建终端」选择项目，最多四个同屏。</p>
      <p class="terminal-empty-sub">同一个项目可以开多个窗格（例如一个跑 dev server、一个敲 git），上次的布局会自动记住。</p>
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
        :font-size="state.ui.terminalFontSize"
        :font-family="state.ui.terminalFontFamily"
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
 * 终端工作台 —— 多窗格平铺（一窗格 = 一个绑定了项目目录的会话，同一项目可开多个）
 *
 * 窗格列表存在 store 里（跨视图保留）：切页只卸载视图，pty 会话留在主进程，
 * 窗格身份（paneId）与它一一对应，必须活得一样久，切回来才认得回自己的会话。
 *
 * 布局持久化：窗格顺序 / 窗格标识 / 绑定的项目 / shell 选择 / 分屏方式与列宽行高比例
 * 全部写入 userData/terminal-layout.json，下次启动自动恢复同样排布。
 * 进程本身不跨应用重启（pty 随应用退出结束），恢复时按项目目录重新拉起会话。
 */
import { computed, nextTick, onBeforeMount, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Plus } from '@element-plus/icons-vue'
import TerminalPane from '../components/TerminalPane.vue'
import TerminalFontSettings from '../components/TerminalFontSettings.vue'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'

/** 网格预设：列 × 行 */
const GRID_PRESETS = {
  '1x2': { cols: 2, rows: 1 },
  '2x1': { cols: 1, rows: 2 },
  '2x2': { cols: 2, rows: 2 },
  '3x1': { cols: 3, rows: 1 },
}
const MIN_SHARE = 0.15

/** 分屏方式选项：图标用实心块直接画格子（cells 为 [x, y, w, h]），
 *  描边线条在 16px 下会被亚像素冲淡，实心块无论多小都清晰 */
const GRID_OPTIONS = [
  // 自动：单块满格，示意「一个容器、布局自行决定」
  { value: 'auto', label: '自动', cells: [[0, 0, 16, 16]] },
  { value: '1x2', label: '左右', cells: [[0, 0, 7, 16], [9, 0, 7, 16]] },
  { value: '2x1', label: '上下', cells: [[0, 0, 16, 7], [0, 9, 16, 7]] },
  { value: '2x2', label: '四宫格', cells: [[0, 0, 7, 7], [9, 0, 7, 7], [0, 9, 7, 7], [9, 9, 7, 7]] },
  { value: '3x1', label: '三宫格', cells: [[0, 0, 4, 16], [6, 0, 4, 16], [12, 0, 4, 16]] },
]
/** 最多同屏窗格数（与文档一致）；超过这个数就不再允许添加 */
const MAX_PANES = 4

/** 窗格运行期字段的初值（不落盘）：会话 id / shell 展示名 / 退出状态 / 会话实时目录。
 *  切页回来时要靠它把窗格恢复成「尚未认领会话」的状态，才会重新 attach 自己的会话；
 *  sessionCwd 清空后标题回落到项目目录，attach 成功再取会话的当前目录 */
const IDLE_PANE = { sessionId: '', shellLabel: '', pid: 0, exited: false, exitCode: null, sessionCwd: '' }

/** 窗格列表存在 store 里（跨视图保留）：切页只卸载视图，会话在主进程常驻，
 *  窗格身份必须活得和会话一样久，否则切回来认不回自己的会话 */
const panes = computed({
  get: () => state.terminal.panes,
  set: (list) => { state.terminal.panes = list },
})
const gridMode = ref('auto')
const fontSettingsVisible = ref(false)
const shellOptions = ref([])
const activeIndex = ref(0)
const columnWidths = ref([0.5, 0.5])
const rowHeights = ref([0.5, 0.5])
const gridRef = ref(null)
/** 顶栏是否在位（沉浸全屏时整个顶栏被卸载，此时不投递标题栏） */
const topbarReady = useTopbarReady()

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

/** 可添加的项目：只要关联了本地目录就能开窗格。
 *  同一个项目允许重复添加（一个项目开多个终端盯不同命令），所以不再排除已开的项目 */
const addableProjects = computed(() => state.projects.items.filter((p) => p.localPath))

/** 各项目已开的窗格数：下拉里标出来，让「已开过也还能再加一个」一眼可见 */
const openPaneCount = computed(() => {
  const counts = {}
  for (const pane of panes.value) counts[pane.projectId] = (counts[pane.projectId] || 0) + 1
  return counts
})

/** 磁盘布局读取完成前不许新建：恢复会整体替换 panes，期间新建的窗格会被顶掉，
 *  而恢复若被跳过（panes 非空），紧接着的防抖落盘会把磁盘布局永久覆盖成这一个窗格 */
const restoreDone = ref(false)

/** 还能不能再加：只受窗格总数限制（同一项目重复开不算重复） */
const canAddPane = computed(() => restoreDone.value && panes.value.length < MAX_PANES && addableProjects.value.length > 0)

/** 窗格标识：随窗格落盘，切页/重启后据它认回自己的 pty 会话 */
function newPaneId() {
  return `pane-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function makePane(project, saved = {}) {
  return {
    // 恢复时沿用上次的 id，新增时现生成：会话归属靠它，不能每次挂载都换
    paneId: saved.paneId || newPaneId(),
    projectId: project.id,
    projectName: project.name,
    cwd: project.localPath,
    shellId: saved.shellId || '',
    ...IDLE_PANE,
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

/** 拖拽期间挂在 window 上的监听清理函数：视图卸载时也要调用，
 *  否则残留监听会继续闭包引用已卸载组件的比例数组，下次进入页面拖拽时叠加计算 */
let endDrag = null

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
    endDrag = null
  }
  endDrag = onUp
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
    endDrag = null
  }
  endDrag = onUp
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
      // 会话归属：同一项目可以开多个窗格，恢复时靠这个 id 各自认回自己的 pty
      paneId: p.paneId,
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
    // paneId 也要进 key：同一个项目的两个窗格，项目与 shell 完全相同，只靠它们区分不出变化
    () => panes.value.map((p) => `${p.paneId}:${p.projectId}:${p.shellId}`).join('|'),
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
      if (!project?.localPath) { missing += 1; continue }
      const pane = makePane(project, item)
      // 同一项目可以有多个窗格，但 paneId 必须唯一：布局被改坏出现重复 id 时，
      // 两个窗格会认回同一个 pty（输出互串），给后来者补一个新 id
      if (seen.has(pane.paneId)) pane.paneId = newPaneId()
      seen.add(pane.paneId)
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

/** 重新进入本视图：窗格对象还在 store 里（会话也在主进程活着），
 *  只需把运行期字段清回初值——每个窗格会重新 attach 自己的会话并回放缓冲
 *  （切走期间的输出都在，画面照旧连上）。
 *  必须放在 onBeforeMount：子组件的挂载钩子早于父组件的 onMounted，
 *  放到 onMounted 再清就来不及了（窗格会拿着过期的 sessionId 直接跳过 attach） */
onBeforeMount(() => {
  if (!panes.value.length) return
  pruneMissingProjects()
  for (const pane of panes.value) Object.assign(pane, IDLE_PANE)
})

onMounted(async () => {
  const opt = await window.gitReport.terminalShellOptions().catch(() => null)
  shellOptions.value = opt?.options || []
  // 首次进入才从磁盘恢复布局；切页回来直接复用内存里的窗格（id 不变才能认回会话）
  if (!panes.value.length) await restoreLayout()
  restoreDone.value = true
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
  if (endDrag) endDrag() // 拖拽中切页：摘掉 window 上的全局监听
  if (saveTimer) writeLayout()
})

/** 项目被删除时同步移除对应窗格，避免留一个死窗格（切页回来时也要再剪一次：
 *  本视图不在场时删掉的项目，没有 watcher 替它收尾） */
function pruneMissingProjects() {
  // 项目列表正在加载/尚未就绪时不能剪：此时 items 为空，会把窗格全部误删
  if (state.projects.loading) return
  const ids = new Set(state.projects.items.map((p) => p.id))
  const kept = panes.value.filter((p) => ids.has(p.projectId))
  if (kept.length === panes.value.length) return
  for (const pane of panes.value) {
    if (!ids.has(pane.projectId) && pane.sessionId) window.gitReport.terminalClose(pane.sessionId).catch(() => {})
  }
  panes.value = kept
}

watch(() => state.projects.items.map((p) => p.id).join('|'), pruneMissingProjects)

/** 切到指定项目：已有窗格则聚焦第一个，没有则新增一个
 *  （同一项目可以开多个窗格，但「从项目页切过来」的语义是定位，不再叠加新窗格） */
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
/* 与 Harness 页同样的满高布局：标题栏已投递到顶栏，这里只剩网格。
   原先的留白由 PageHeader 提供，现在自补一份（四边一致，见 --tool-page-gap） */
.terminal-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 10px;
  background: #12161d;
}

.terminal-topbar-page { gap: 18px; }
.terminal-topbar-identity { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.terminal-topbar-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: #203b39;
  color: #69d2b9;
  font: 700 17px/1 var(--brand-mono);
  letter-spacing: -.12em;
  padding-right: 3px;
}
.terminal-topbar-identity .topbar-page-title { color: #f2f5f7; font-size: 14px; }
.terminal-pane-total { color: #83909e; font-size: 12px; white-space: nowrap; }
.terminal-toolbar {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: nowrap;
}
.terminal-toolbar-divider { width: 1px; height: 18px; margin: 0 5px; background: #3b4652; }
.terminal-toolbar-label { color: #83909e; font-size: 12px; white-space: nowrap; }
.terminal-toolbar :deep(.el-button) { min-height: 32px; height: 32px; margin-left: 0; border-radius: 6px; }
.terminal-toolbar :deep(.terminal-add-button) {
  --el-button-bg-color: #167c70;
  --el-button-border-color: #167c70;
  --el-button-hover-bg-color: #209483;
  --el-button-hover-border-color: #209483;
  --el-button-active-bg-color: #11695f;
  --el-button-active-border-color: #11695f;
  padding: 0 11px;
  font-size: 12px;
  font-weight: 600;
}
.terminal-toolbar :deep(.terminal-quiet-button) {
  --el-button-bg-color: transparent;
  --el-button-border-color: transparent;
  --el-button-text-color: #b2bdca;
  --el-button-hover-bg-color: #29313b;
  --el-button-hover-border-color: #29313b;
  --el-button-hover-text-color: #fff;
  padding: 0 9px;
  font-size: 12px;
}
.terminal-toolbar :deep(.el-radio-group) {
  border: 1px solid #39434e;
  border-radius: 6px;
  overflow: hidden;
}
.terminal-toolbar :deep(.el-radio-button__inner) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  padding: 0 7px;
  outline: none;
  border: 0;
  border-radius: 0;
  background: #202731;
  color: #9ba8b6;
}
.terminal-toolbar :deep(.el-radio-button + .el-radio-button .el-radio-button__inner) {
  box-shadow: inset 1px 0 0 #39434e;
}
.terminal-toolbar :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background: #294c49;
  color: #9be5d3;
  box-shadow: none;
}
.terminal-toolbar :deep(.el-radio-button__inner:hover) {
  color: #fff;
  background: #303b46;
}
.terminal-toolbar :deep(.el-radio-button__original-radio:checked + .el-radio-button__inner:hover) {
  color: #b4f2e3;
  background: #315b55;
}
/* outline 移除后保留键盘焦点指示 */
.terminal-toolbar :deep(.el-radio-button__original-radio:focus-visible + .el-radio-button__inner) {
  outline: 2px solid #64cbb4;
  outline-offset: -2px;
}
/* 图标用实心块直接画格子：描边线条在这个尺寸下会被亚像素冲淡（横线尤其明显），
   实心块无论多小都清晰——VS Code / Windows 的分屏图标也是这个做法 */
.grid-icon { display: block; width: 16px; height: 16px; }
.grid-icon rect { fill: currentColor; }

/* 下拉里标注该项目已开的窗格数（弹层被 teleport 到 body，但本组件模板里的节点
   仍带 scope id，样式照样命中） */
.pane-count {
  margin-left: 8px;
  color: var(--brand-text-sub);
  font-size: 12px;
}

.terminal-hint,
.terminal-empty {
  margin: 8px 0 0;
  color: #a8b3c0;
  font-size: 14px;
  line-height: 1.8;
}

.terminal-empty {
  margin-top: 40px;
  text-align: center;
}

.terminal-empty-sub {
  color: #778492;
  font-size: 13px;
}

/* 平铺网格：间隙由分隔条填充，分隔条本身可拖拽。
   --splitter-hit 同时决定间隙宽度与分隔条命中区，两者必须一致：
   分隔条只有正好压在间隙上，才不会侵占两侧窗格的鼠标事件。 */
.terminal-grid {
  --splitter-hit: 6px;
  flex: 1;
  min-height: 0;
  display: grid;
  gap: var(--splitter-hit);
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
