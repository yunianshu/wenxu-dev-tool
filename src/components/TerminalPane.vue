<template>
  <div class="term-pane" :class="{ 'is-focused': focused, 'is-dead': pane.exited }" @mousedown="emit('focus')">
    <header class="term-pane-head">
      <span class="term-dot" :class="statusClass" />
      <div class="term-pane-title">
        <strong>{{ pane.projectName || '未命名项目' }}</strong>
        <small :title="displayCwd">{{ shortCwd }}</small>
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
 * 终端窗格 —— 一个窗格一个 xterm 视图
 *
 * 生命周期要点：
 * - 视图只订阅自己 sessionId 的数据；切页时本组件卸载（pty 会话留在主进程），
 *   切回来重新挂载 → attach 取回缓冲输出 → 画面恢复
 * - 会话按 paneId 归属：同一个项目可以开多个窗格，各自认回自己的 pty
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
  pane: { type: Object, required: true },        // { projectId, projectName, cwd, sessionCwd?, shellId, sessionId, shellLabel, exited, exitCode }
  focused: { type: Boolean, default: false },
  shellOptions: { type: Array, default: () => [] },
  /** 终端字号（px），纯外观偏好，由 ui-prefs.json 持久化，在终端工作台工具栏调整 */
  fontSize: { type: Number, default: 13 },
})
const emit = defineEmits(['focus', 'close', 'session', 'update:shell'])

const hostRef = ref(null)
const fitHostRef = ref(null)
const error = ref('')
// 会话的实时目录：shell 里 cd 后由主进程经 OSC 7 / OSC 9;9 上报（sessionCwd），
// 没上报过就回落到窗格绑定的项目目录（pane.cwd）。两者分开存：pane.cwd 是窗格
// 归属（项目目录改了要重开会话），不能被 cd 改写，否则挂载期的「目录变化→重开」
// watch 会误判成项目目录变更把会话关掉
const displayCwd = computed(() => props.pane.sessionCwd || props.pane.cwd || '')
const shortCwd = computed(() => shortPath(displayCwd.value))
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

// ─── 输出合并批写（防 TUI 帧被拆碎渲染） ───
// ConPTY 会把 TUI（codex 等 ratatui 应用）的一帧重绘拆成多个小包送来，实测帧内
// 间隔 p50=14ms / p90=34ms / 最长 78ms。逐包 write 会让 xterm 在包与包之间把
// 「帧中间的过渡态」真实画出来：codex 每帧多次 hide/show 光标，部分包以
// 「光标停在跳板位置（如行首左边缘）+ 显示」结尾，要等 3~80ms 后的下一个包
// 才落回输入框——被渲染出来就是用户看到的「光标漂移闪烁」（codex 上游
// #9081/#21828 每帧翻转可见性放大了它，Windows Terminal 同样受影响）。
// 这里把输出攒起来批写：TUI 帧滚动合并，一帧只解析/渲染一次，光标只呈现帧末
// 的合法状态（输入框插入点，与 Windows Terminal 的观感一致）。窗口按节奏自适应：
// 距上一帧 ≤300ms 是机器连发（spinner/流式重绘，帧距实测 12~80ms），用 120ms
// 滚动窗口把帧内撕裂全部吸收；孤立帧是人的打字回显（codex 输入框每键一帧），
// 只合并 25ms，回显手感不变。普通日志/回显不含可见性序列，12ms 快速刷。
const FLUSH_IDLE_MS = 12
const TUI_BURST_GAP_MS = 300
const TUI_BURST_HOLD_MS = 120
const TUI_LONE_HOLD_MS = 25
const FLUSH_HOLD_CAP_MS = 250
const FLUSH_MAX_BYTES = 256 * 1024
/** TUI 帧成分：光标可见性翻转 / 同步输出开关 / DECSCUSR。同步块若被当成普通
 *  内容走 12ms 快速通道，会在帧内提前切批，把「光标停在跳板位」的 A 块单独
 *  渲染出来（实测 38.9% 样本闪跳），必须与可见性序列同等待遇 */
const TUI_FRAME_RE = /\x1b\[\?(?:25[hl]|2026[hl])|\x1b\[\d* q/
let pendingChunks = []
let pendingBytes = 0
let flushAt = 0
let flushTimer = null
let holdStart = 0
let lastTuiChunkAt = 0

function flushPendingOutput() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  flushAt = 0
  if (!pendingChunks.length || !term) return
  const batch = pendingChunks.join('')
  pendingChunks = []
  pendingBytes = 0
  if (pendingReplay) { term.reset(); pendingReplay = false }
  term.write(batch)
}

/** 丢弃未渲染的输出：会话重开/换绑时调用，避免旧会话的残尾印到新画面上 */
function discardPendingOutput() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
  flushAt = 0
  pendingChunks = []
  pendingBytes = 0
}

function queueOutput(data) {
  if (!data || !term) return
  // 帧边界：新的同步输出块 = 上一帧已完整发出，先刷出上一批（批尾 = 上一帧的
  // 帧末状态 = 光标落位），当前帧从空批开始攒。若按纯时间上限切批，切分点会
  // 锁相落在「帧间过渡态」（光标停在跳板位）之后，批尾 junk 被照常渲染——
  // 实测 8Hz 帧流下 100% 的批次都以 junk 块收尾，时间上限必须让位于帧边界。
  // 边界可能不在 chunk 头部：ConPTY 实测会把「上一帧落位块 + 下一帧 2026h」
  // 合并成一个 chunk 送达，所以在 chunk 内部找边界切开，界前归上一帧
  if (pendingChunks.length) {
    const idx = data.indexOf('\x1b[?2026h')
    if (idx > 0) {
      pendingChunks.push(data.slice(0, idx))
      pendingBytes += idx
      flushPendingOutput()
      data = data.slice(idx)
    } else if (idx === 0) {
      flushPendingOutput()
    }
  }
  const now = Date.now()
  if (!pendingChunks.length) holdStart = now
  pendingChunks.push(data)
  pendingBytes += data.length
  // 日志洪水不等合并窗口，立即落给 xterm（上限只可能被无渲染的极端场景触发）
  if (pendingBytes >= FLUSH_MAX_BYTES) { flushPendingOutput(); return }
  // 含 TUI 帧成分（可见性翻转/同步块/DECSCUSR）→ 整帧重绘的一部分：burst 节奏
  // 下延长合并窗口等帧的后续块到齐；持续帧流最多推到 holdStart+CAP，保证画面
  // 总会跟上。帧的收尾由上面的帧边界 junction 保证（批尾 = 帧末落位）
  if (TUI_FRAME_RE.test(data)) {
    const burst = lastTuiChunkAt && now - lastTuiChunkAt <= TUI_BURST_GAP_MS
    flushAt = Math.min(Math.max(flushAt, now + (burst ? TUI_BURST_HOLD_MS : TUI_LONE_HOLD_MS)), holdStart + FLUSH_HOLD_CAP_MS)
    lastTuiChunkAt = now
  } else {
    flushAt = flushAt || now + FLUSH_IDLE_MS
  }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushPendingOutput, Math.max(1, flushAt - Date.now()))
}

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
 * - Ctrl/Cmd+V、Ctrl+Shift+V、Shift+Insert → 粘贴（无菜单 Electron 不派发原生 paste，必须拦截自绘）
 * - Ctrl+Enter、Shift+Enter → 发 LF 换行（见下）
 */
function handleTermKey(ev) {
  if (!ev || ev.type !== 'keydown') return true
  const ctrl = ev.ctrlKey || ev.metaKey
  // 拦截的键要显式 preventDefault：customKeyEventHandler 返回 false 只是让 xterm
  // 短路（不会 preventDefault），放行默认动作会让 Chromium 再触发一次原生
  // paste/copy（粘贴发两份、空剪贴板也发空 bracketed 包裹都源于此）
  if (ev.code === 'KeyV' && ctrl && !ev.altKey) {
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
  // Ctrl+Enter / Shift+Enter 换行：xterm 的 Enter 分支只区分 altKey，这两组
  // 修饰回车也被翻成 \r，TUI（claude 等）收到 \r 只会提交消息而不是换行。
  // 改发 LF（\n）——即 Claude Code 官方 Ctrl+J 的换行序列，任何 TUI 无需配置；
  // Alt+Enter 不拦，xterm 自带发 ESC+CR，同为 claude 认可的换行键。
  // isComposing 排除中文输入法选词回车（keyCode 229）
  if (ev.code === 'Enter' && !ev.altKey && !ev.metaKey && (ev.ctrlKey || ev.shiftKey) && !ev.isComposing && ev.keyCode !== 229) {
    ev.preventDefault()
    if (!props.pane.exited) term?.input('\n')
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

/** 字号变化：改 xterm 选项后重新适配，scheduleFit 会把新的行列数同步给 pty */
watch(() => props.fontSize, (size) => {
  if (!term || !size) return
  term.options.fontSize = size
  scheduleFit()
})

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
    // 先 attach 已有会话：应用切页前留下的会话要复用，而不是另开一个进程。
    // 只认本窗格自己的会话（paneId 唯一）——一个项目可以开多个窗格，
    // 若按「项目 + 目录」匹配，第二个窗格会 attach 到第一个的 pty，两个视图互串。
    // 也不能拿目录当匹配条件：会话可能被用户 cd 到别的目录（cwd 跟随 shell 实时变），
    // 按目录匹配会把好好活着的会话误判成孤儿关掉
    const existing = await window.gitReport.terminalList()
    const mine = (existing?.sessions || []).filter((s) => s.paneId && s.paneId === pane.paneId)
    const hit = mine.find((s) => !s.exited)
    // 本窗格名下其余的只能是已退出未清走的残留，顺手清掉
    for (const stale of mine) {
      if (stale.id !== hit?.id) await window.gitReport.terminalClose(stale.id).catch(() => {})
    }
    if (hit) {
      pendingReplay = true
      const res = await window.gitReport.terminalAttach(hit.id)
      if (!res?.ok) throw new Error(res?.error || '恢复会话失败')
      term.reset()
      term.write(res.output || '')
      pendingReplay = false
      // sessionCwd 取会话当前目录：切页期间用户 cd 过的话，标题直接跟上
      reportSession({ sessionId: hit.id, sessionCwd: hit.cwd, shellLabel: hit.shellLabel, pid: hit.pid, exited: false, exitCode: null })
      term.focus()
      return
    }
    const res = await window.gitReport.terminalCreate({
      paneId: pane.paneId,
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
      sessionCwd: res.session.cwd,
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
  reportSession({ sessionId: '', sessionCwd: '', exited: false, exitCode: null })
  error.value = ''
  discardPendingOutput()
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
    fontSize: props.fontSize,
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
    queueOutput(payload.data || '')
  })
  const offExit = window.gitReport.onTerminalExit((payload) => {
    if (!payload || payload.sessionId !== props.pane.sessionId) return
    reportSession({ exited: true, exitCode: payload.exitCode })
  })
  const offClosed = window.gitReport.onTerminalClosed((payload) => {
    if (!payload || payload.sessionId !== props.pane.sessionId) return
    reportSession({ sessionId: '', exited: true, exitCode: null })
  })
  // shell 里 cd → 主进程从输出流解出新目录 → 标题栏路径实时跟上
  const offCwd = window.gitReport.onTerminalCwd((payload) => {
    if (!payload || payload.sessionId !== props.pane.sessionId) return
    if (payload.cwd && payload.cwd !== props.pane.sessionCwd) reportSession({ sessionCwd: payload.cwd })
  })
  disposers = [offData, offExit, offClosed, offCwd]

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

/** 窗格换了项目/目录（项目页改了本地目录）：旧会话作废，按新项目重开。
 *  只盯 pane.cwd（窗格归属）；shell 里 cd 走的是 sessionCwd，不会触发这里 */
watch(() => props.pane.cwd, async (next, prev) => {
  if (!term || !prev || next === prev) return
  const sid = props.pane.sessionId
  if (sid) await window.gitReport.terminalClose(sid).catch(() => {})
  reportSession({ sessionId: '', sessionCwd: '', exited: false, exitCode: null })
  discardPendingOutput()
  term.reset()
  await ensureSession()
})

onBeforeUnmount(() => {
  // 只销毁视图，不关闭会话：切页后 CLI 继续在后台跑
  if (fitTimer) clearTimeout(fitTimer)
  discardPendingOutput()
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
