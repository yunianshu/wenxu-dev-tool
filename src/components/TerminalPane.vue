<template>
  <div class="term-pane" :class="{ 'is-focused': focused, 'is-dead': pane.exited }" @mousedown="emit('focus')">
    <header class="term-pane-head">
      <span class="term-dot" :class="statusClass" />
      <div class="term-pane-title">
        <strong>{{ pane.projectName || '未命名项目' }}</strong>
        <small :title="pane.cwd">{{ shortCwd }}</small>
      </div>
      <div class="term-pane-actions">
        <el-dropdown v-if="shellOptions.length > 1" trigger="click" size="small" @command="restartWith">
          <button type="button" class="term-mini" :title="`当前：${pane.shellLabel || '自动'}`">
            {{ pane.shellLabel || '自动' }}<el-icon><ArrowDown /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="opt in shellOptions" :key="opt.id" :command="opt.id">
                {{ opt.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <button type="button" class="term-mini" title="重新打开该项目的会话" @click="restart">
          <el-icon><Refresh /></el-icon>
        </button>
        <button type="button" class="term-mini" title="关闭这个窗格" @click="emit('close')">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </header>
    <div ref="hostRef" class="term-host">
      <div ref="fitHostRef" class="term-fit" />
    </div>
    <div v-if="error" class="term-overlay">
      <p>{{ error }}</p>
      <button type="button" class="term-retry" @click="restart">重试</button>
    </div>
    <div v-else-if="pane.exited" class="term-overlay">
      <p>会话已结束{{ pane.exitCode === null ? '' : `（退出码 ${pane.exitCode}）` }}</p>
      <button type="button" class="term-retry" @click="restart">重新打开</button>
    </div>
  </div>
</template>

<script setup>
/**
 * 终端窗格 —— 一个项目一个 xterm 视图
 *
 * 生命周期要点：
 * - 视图只订阅自己 sessionId 的数据；切页时本组件卸载（pty 会话留在主进程），
 *   切回来重新挂载 → attach 取回缓冲输出 → 画面恢复
 * - 会话创建/附加在挂载时自动完成；退出后提供「重新打开」而不是自动重启，
 *   避免 dev server 崩溃后无限重启
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ArrowDown, Close, Refresh } from '@element-plus/icons-vue'
import '@xterm/xterm/css/xterm.css'
import { shortPath } from '../utils/path'

const props = defineProps({
  pane: { type: Object, required: true },        // { projectId, projectName, cwd, shellId, sessionId, shellLabel, exited, exitCode }
  focused: { type: Boolean, default: false },
  shellOptions: { type: Array, default: () => [] },
})
const emit = defineEmits(['focus', 'close', 'session', 'update:shell'])

const hostRef = ref(null)
const fitHostRef = ref(null)
const error = ref('')
const shortCwd = computed(() => shortPath(props.pane.cwd || ''))
const statusClass = computed(() => {
  if (error.value) return 'is-error'
  if (props.pane.exited) return 'is-dead'
  return 'is-live'
})

let term = null
let fitAddon = null
let observer = null
let disposers = []
let fitTimer = null
/** attach 回放到达前先清屏，避免「实时数据 + 缓冲快照」重复显示 */
let pendingReplay = false

function reportSession(patch) {
  emit('session', { paneId: props.pane.paneId, ...patch })
}

/** 终端选区复制：xterm 不内置剪贴板行为，宿主要自己把选区写进系统剪贴板 */
function copySelection() {
  const text = term?.getSelection?.() || ''
  if (!text) return
  window.gitReport.copyText(text).catch(() => {})
}

/** 终端粘贴：应用移除了菜单栏，Electron 无菜单时浏览器不会派发原生 paste 事件，
 *  Ctrl+V 放行只会被 xterm 翻成 0x16 发给 pty（表现为粘贴毫无反应）。
 *  这里自己读系统剪贴板喂给 term.paste —— 它与原生 paste 走同一链路，
 *  会按程序请求的 bracketed paste mode 包裹 200~/201~（kimi 等 TUI 依赖此语义） */
async function pasteFromClipboard() {
  try {
    const text = await window.gitReport.readText()
    if (text && !props.pane.exited) term?.paste(text)
  } catch { /* 剪贴板读取失败保持静默，不打断终端 */ }
}

/**
 * 复制/粘贴键约定（对齐 Windows Terminal）：
 * - Ctrl/Cmd+C 有选区 → 复制；无选区 → 照常发 ^C 中断进程
 * - Ctrl+Insert、Ctrl/Cmd+Shift+C → 无论有没有选区都执行复制
 * - Ctrl/Cmd+V、Shift+Insert → 粘贴（无菜单 Electron 不派发原生 paste，必须拦截自绘）
 */
function handleTermKey(ev) {
  if (!ev || ev.type !== 'keydown') return true
  const ctrl = ev.ctrlKey || ev.metaKey
  // 拦截的键要显式 preventDefault：customKeyEventHandler 返回 false 只是让 xterm
  // 短路（不会 preventDefault），放行默认动作会让 Chromium 再触发一次原生
  // paste/copy（粘贴发两份、空剪贴板也发空 bracketed 包裹都源于此）
  if (ev.code === 'KeyV' && ctrl && !ev.shiftKey && !ev.altKey) {
    ev.preventDefault()
    pasteFromClipboard()
    return false
  }
  if (ev.code === 'Insert' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
    ev.preventDefault()
    pasteFromClipboard()
    return false
  }
  if (ev.code === 'KeyC' && ctrl && !ev.altKey) {
    if (ev.shiftKey || term?.hasSelection()) {
      copySelection()
      return false
    }
  }
  if (ev.code === 'Insert' && ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
    copySelection()
    return false
  }
  return true
}

/** 尺寸适配（防抖：拖动分屏/窗口缩放会连续触发） */
function scheduleFit() {
  if (fitTimer) clearTimeout(fitTimer)
  fitTimer = setTimeout(() => {
    fitTimer = null
    if (!fitAddon || !term || !hostRef.value || !hostRef.value.clientWidth) return
    try { fitAddon.fit() } catch { /* 尺寸过小等场景忽略 */ }
    const sid = props.pane.sessionId
    if (sid) window.gitReport.terminalResize(sid, term.cols, term.rows).catch(() => {})
  }, 60)
}

async function ensureSession() {
  const pane = props.pane
  if (pane.sessionId || !pane.cwd) return
  error.value = ''
  try {
    // 先按当前视图尺寸 fit 再建会话：term 刚 open 时是默认 80×24，
    // 用默认尺寸创建的 pty 要等防抖 fit 才会纠正，而那次 fit 的 resize
    // 上报可能早于 sessionId 落位被丢掉（见下方 watch），pty 就停在 80×24，
    // TUI 按旧列宽重绘全部错位（新加窗格显示乱的主因）
    try { fitAddon?.fit() } catch { /* 视图尚未就绪时按默认尺寸创建 */ }
    // 先 attach 已有会话：应用切页前留下的会话要复用，而不是另开一个进程
    const existing = await window.gitReport.terminalList()
    const hit = (existing?.sessions || []).find(
      (s) => !s.exited && s.projectId === pane.projectId && s.cwd === pane.cwd,
    )
    if (hit) {
      pendingReplay = true
      const res = await window.gitReport.terminalAttach(hit.id)
      if (!res?.ok) throw new Error(res?.error || '恢复会话失败')
      term.reset()
      term.write(res.output || '')
      pendingReplay = false
      reportSession({ sessionId: hit.id, shellLabel: hit.shellLabel, pid: hit.pid, exited: false, exitCode: null })
      term.focus()
      return
    }
    const res = await window.gitReport.terminalCreate({
      projectId: pane.projectId,
      projectName: pane.projectName,
      cwd: pane.cwd,
      cols: term.cols,
      rows: term.rows,
      shellId: pane.shellId,
    })
    if (!res?.ok) throw new Error(res?.error || '创建终端会话失败')
    reportSession({
      sessionId: res.session.id,
      shellLabel: res.session.shellLabel,
      pid: res.session.pid,
      exited: false,
      exitCode: null,
    })
    term.focus()
  } catch (err) {
    error.value = (err && err.message) || String(err)
  }
}

/** 重新打开：关闭旧会话并按当前 shell 选择新建 */
async function restart() {
  const sid = props.pane.sessionId
  if (sid) await window.gitReport.terminalClose(sid).catch(() => {})
  reportSession({ sessionId: '', exited: false, exitCode: null })
  error.value = ''
  if (term) term.reset()
  await ensureSession()
}

/** 切换 shell：先记住选择（布局要落盘），再重开会话 */
function restartWith(shellId) {
  emit('update:shell', { paneId: props.pane.paneId, shellId })
  restart()
}

onMounted(async () => {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Consolas, "Cascadia Mono", "Sarasa Mono SC", Menlo, monospace',
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#12161d',
      foreground: '#d7dde8',
      cursor: '#7dd3a0',
      selectionBackground: '#2d3a4d',
    },
  })
  fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.attachCustomKeyEventHandler(handleTermKey)
  // 挂在内层适配层上：FitAddon 按父元素 computed 尺寸算行列，直接挂带 padding
  // 的 .term-host 会把 padding 算进可用空间，导致最右几列、最下一行被裁掉
  term.open(fitHostRef.value)
  scheduleFit()

  // 键盘输入原样透传（含 Ctrl+C 等控制字符）；会话不存在时静默丢弃
  term.onData((data) => {
    const sid = props.pane.sessionId
    if (!sid) return
    window.gitReport.terminalWrite(sid, data).catch(() => {})
  })

  const offData = window.gitReport.onTerminalData((payload) => {
    if (!payload || payload.sessionId !== props.pane.sessionId) return
    if (pendingReplay) { term.reset(); pendingReplay = false }
    term.write(payload.data || '')
  })
  const offExit = window.gitReport.onTerminalExit((payload) => {
    if (!payload || payload.sessionId !== props.pane.sessionId) return
    reportSession({ exited: true, exitCode: payload.exitCode })
  })
  const offClosed = window.gitReport.onTerminalClosed((payload) => {
    if (!payload || payload.sessionId !== props.pane.sessionId) return
    reportSession({ sessionId: '', exited: true, exitCode: null })
  })
  disposers = [offData, offExit, offClosed]

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => scheduleFit())
    observer.observe(hostRef.value)
  }
  await nextTick()
  await ensureSession()
})

/** sessionId 落位后必补一次尺寸上报：挂载期间的 fit 可能早于会话创建/附加（当时
 *  sid 为空，terminalResize 被丢掉），pty 会停在创建时的默认尺寸，之后若视图尺寸
 *  不再变化就永远没人补报 —— TUI 按旧列宽重绘全部错位（新加窗格显示乱的主因） */
watch(() => props.pane.sessionId, (sid) => {
  if (sid) scheduleFit()
})

/** 窗格换了项目/目录：旧会话作废，按新项目重开 */
watch(() => props.pane.cwd, async (next, prev) => {
  if (!term || !prev || next === prev) return
  const sid = props.pane.sessionId
  if (sid) await window.gitReport.terminalClose(sid).catch(() => {})
  reportSession({ sessionId: '', exited: false, exitCode: null })
  term.reset()
  await ensureSession()
})

onBeforeUnmount(() => {
  // 只销毁视图，不关闭会话：切页后 CLI 继续在后台跑
  if (fitTimer) clearTimeout(fitTimer)
  observer?.disconnect()
  for (const off of disposers) { try { off() } catch { /* noop */ } }
  try { term?.dispose() } catch { /* noop */ }
  term = null
})
</script>

<style scoped>
/* 窗格：深色终端区 + 浅色标题条，与应用的浅色外壳形成明确分区 */
.term-pane {
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  background: #12161d;
}

.term-pane.is-focused {
  border-color: var(--brand-accent);
  box-shadow: 0 0 0 1px rgba(14, 122, 109, .35);
}

.term-pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding: 0 8px;
  height: 34px;
  background: var(--surface);
  border-bottom: 1px solid var(--line);
}

.term-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #c9cfd6;
}

.term-dot.is-live { background: #49a878; }
.term-dot.is-dead { background: #c9a227; }
.term-dot.is-error { background: #d9534f; }

.term-pane-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.25;
}

.term-pane-title strong {
  font-size: 13px;
  color: var(--brand-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-pane-title small {
  font-size: 11px;
  color: var(--brand-text-sub);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-pane-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.term-mini {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}

.term-mini:hover {
  border-color: var(--line-strong);
  color: var(--brand-text);
}

.term-host {
  flex: 1;
  min-height: 0;
  padding: 6px 8px 8px;
  overflow: hidden;
}

/* xterm 的挂载层：无 padding，FitAddon 按它的尺寸算行列才不会被 host 的
   padding 撑大（否则画布比可视区大，最右/最下内容被裁） */
.term-fit {
  width: 100%;
  height: 100%;
}

/* xterm 自带样式：确保它撑满宿主容器 */
.term-host :deep(.xterm) {
  height: 100%;
}

.term-host :deep(.xterm-viewport) {
  background: transparent !important;
}

.term-overlay {
  position: absolute;
  inset: 34px 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  background: rgba(18, 22, 29, .88);
  color: #d7dde8;
  font-size: 13px;
  text-align: center;
}

.term-overlay p {
  margin: 0;
  line-height: 1.7;
}

.term-retry {
  height: 30px;
  padding: 0 14px;
  border: 1px solid rgba(215, 221, 232, .35);
  border-radius: var(--radius-sm);
  background: transparent;
  color: #d7dde8;
  font-size: 13px;
  cursor: pointer;
}

.term-retry:hover {
  border-color: var(--brand-accent);
  color: #fff;
}
</style>
