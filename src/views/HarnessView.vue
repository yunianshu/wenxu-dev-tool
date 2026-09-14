<template>
  <div class="page harness-page" :class="{ 'is-immersive': immersive }">
    <PageHeader
      v-if="!immersive"
      title="DeepSeek Harness"
      description="内置的 DeepSeek 智能体工作台：打开软件自动开启本地服务，关闭软件时一并关闭。"
    >
      <template #actions>
        <span :class="['harness-pill', `is-${snapshot.status}`]">{{ statusLabel }}</span>
        <el-button v-if="running" @click="openExternal"><el-icon><TopRight /></el-icon>浏览器打开</el-button>
        <el-button v-if="running" @click="reload"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button v-if="running" :loading="busy" @click="restart"><el-icon><RefreshRight /></el-icon>重启服务</el-button>
        <el-button v-else-if="installed" type="primary" :loading="busy" @click="start">
          <el-icon><VideoPlay /></el-icon>启动服务
        </el-button>
        <el-button v-if="running" @click="enterFullscreen"><el-icon><FullScreen /></el-icon>全屏</el-button>
        <el-button @click="settingsVisible = true"><el-icon><Setting /></el-icon>服务设置</el-button>
      </template>
    </PageHeader>

    <div class="harness-shell">
      <div class="harness-stage">
        <!-- 运行中：内嵌 dsh web 界面 -->
        <webview
          v-if="running"
          ref="webviewRef"
          class="harness-frame"
          :src="webviewUrl"
          partition="persist:harness"
          allowpopups
          @did-fail-load="onFailLoad"
          @did-navigate="onNavigated"
          @did-navigate-in-page="onNavigated"
        />

        <!-- 加载失败浮层：运行中 snapshot.error 不占位展示（占位层只在非 running 渲染），
             不加浮层用户只能看到空白页面，无从得知失败原因与重试入口 -->
        <div v-if="running && loadFailed" class="harness-loadfail">
          <el-icon class="harness-loadfail-icon"><WarningFilled /></el-icon>
          <p>{{ loadFailText }}</p>
          <div class="harness-loadfail-actions">
            <el-button size="small" @click="reload">重试加载</el-button>
            <el-button size="small" type="primary" :loading="busy" @click="restart">重启服务</el-button>
          </div>
        </div>

        <!-- 启动中 -->
        <div v-if="starting" class="harness-placeholder">
          <el-icon class="harness-placeholder-icon is-spin"><Loading /></el-icon>
          <h3>{{ startingTitle }}</h3>
          <p>{{ startingHint }}</p>
        </div>

        <!-- 出错 / 未安装 -->
        <div v-if="!running && !starting" class="harness-placeholder">
          <el-icon class="harness-placeholder-icon"><WarningFilled /></el-icon>
          <h3>{{ installed ? (snapshot.status === 'error' ? 'Harness 服务启动失败' : 'Harness 服务未运行') : '未检测到 DeepSeek Harness' }}</h3>
          <p v-if="snapshot.error" class="harness-error">{{ snapshot.error }}</p>
          <p v-else-if="!installed">
            请先在本机安装 dsh CLI，然后点击「启动服务」：
            <code>npm i -g @deepseek-ai/dsh</code>
          </p>
          <pre v-if="snapshot.status === 'error' && snapshot.detail" class="harness-detail">{{ snapshot.detail }}</pre>
          <div class="harness-placeholder-actions">
            <el-button v-if="installed" type="primary" :loading="busy" @click="start">
              <el-icon><VideoPlay /></el-icon>启动服务
            </el-button>
            <el-button v-else @click="openInstallDocs">查看安装说明</el-button>
          </div>
        </div>

        <!-- 全屏时唯一的退出入口：webview 之上的悬浮条（Esc 亦可，含 dsh 页面内按 Esc） -->
        <div v-if="immersive" class="harness-immersive-bar">
          <span :class="['harness-dot', `is-${snapshot.status}`]" />
          <span class="harness-immersive-label">{{ statusLabel }}</span>
          <el-button size="small" @click="exitFullscreen">
            <el-icon><Close /></el-icon>退出全屏
          </el-button>
        </div>
      </div>

      <!-- 服务信息条：让「端口已自动开启」可见 -->
      <footer v-if="running && !immersive" class="harness-footer">
        <span class="harness-dot" />
        <span>服务运行中</span>
        <span v-if="runtimeLabel" class="harness-meta">{{ runtimeLabel }}</span>
        <span class="harness-meta">{{ snapshot.displayUrl }}</span>
        <span class="harness-meta">PID {{ snapshot.pid }}</span>
        <span v-if="snapshot.startedAt" class="harness-meta">启动于 {{ startedAtText }}</span>
      </footer>
    </div>

    <!-- 服务设置：端口与是否随应用自动启动 -->
    <el-dialog v-model="settingsVisible" title="Harness 服务设置" width="460px" append-to-body>
      <el-form label-width="110px">
        <el-form-item label="监听端口">
          <el-input-number v-model="portInput" :min="1024" :max="65535" :step="1" controls-position="right" />
          <div class="harness-hint">端口被占用时会自动改用系统分配的空闲端口。</div>
        </el-form-item>
        <el-form-item label="自动启动">
          <el-switch v-model="autoStartInput" />
          <div class="harness-hint">开启后，每次打开本应用都会自动拉起 Harness 服务。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button v-if="running" text type="danger" :loading="busy" @click="stop">停止服务</el-button>
        <el-button @click="settingsVisible = false">取消</el-button>
        <el-button type="primary" @click="saveSettings">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Close, FullScreen } from '@element-plus/icons-vue'
import PageHeader from '../components/PageHeader.vue'
import { state } from '../store'
import { toPlain } from '../utils/ipc'

const snapshot = ref({
  status: 'stopped', port: 0, pid: 0, url: '', displayUrl: '',
  error: '', detail: '', installed: true, startedAt: 0,
})
const busy = ref(false)
const webviewRef = ref(null)
const settingsVisible = ref(false)
const portInput = ref(3080)
const autoStartInput = ref(true)
/** webview 加载失败浮层（仅 running 状态；非 running 由占位层展示 snapshot.error） */
const loadFailed = ref(false)
const loadFailText = ref('')

const running = computed(() => snapshot.value.status === 'running' && !!snapshot.value.url)
const starting = computed(() => snapshot.value.status === 'starting')
/** 沉浸全屏：窗口全屏 + 隐藏应用外壳（侧栏/顶栏）与页头/底栏，webview 铺满整屏 */
const immersive = computed(() => state.ui.fullscreen === true)
/** 首次使用/升级后：内置运行时以单文件归档随包分发，启动前先解包（约 1 分钟） */
const extracting = computed(() => starting.value && snapshot.value.stage === 'extract')
const startingTitle = computed(() => (extracting.value ? '正在解包内置 DeepSeek Harness 运行时…' : '正在启动 DeepSeek Harness…'))
const startingHint = computed(() => (extracting.value
  ? '首次启动（或升级换版本后）需要把内置运行时解包到用户目录，约 1 分钟，请稍候。'
  : '首次启动需要加载插件与前端资源，通常 10～30 秒，请稍候。'))
const installed = computed(() => snapshot.value.installed !== false)
/** webview 首次导航必须带 token：直接开根地址会因缺 cookie 返回 401 */
const webviewUrl = computed(() => snapshot.value.url)
const startedAtText = computed(() => {
  const ts = Number(snapshot.value.startedAt || 0)
  return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''
})
const STATUS_TEXT = { stopped: '未运行', starting: '启动中', running: '运行中', error: '异常' }
const statusLabel = computed(() => STATUS_TEXT[snapshot.value.status] || '未运行')
/** 运行时来源：内置（随安装包分发，目标机器无需装 dsh/Node）/ 本机安装 / PATH */
const RUNTIME_TEXT = { bundled: '内置运行时', system: '本机安装', path: 'PATH' }
const runtimeLabel = computed(() => RUNTIME_TEXT[snapshot.value.runtime] || '')

let unsubscribe = null

function apply(payload) {
  if (!payload || typeof payload !== 'object') return
  snapshot.value = { ...snapshot.value, ...payload }
}

async function refresh() {
  try {
    apply(await window.gitReport.harnessStatus())
  } catch { /* 主进程尚未就绪 */ }
}

async function start() {
  if (busy.value) return
  busy.value = true
  try {
    const port = Number(state.config.harness?.port) || 3080
    apply(await window.gitReport.harnessStart({ port }))
  } catch (err) {
    ElMessage.error(err?.message || '启动 Harness 服务失败')
  } finally {
    busy.value = false
  }
}

async function restart() {
  if (busy.value) return
  busy.value = true
  try {
    const port = Number(state.config.harness?.port) || 3080
    apply(await window.gitReport.harnessRestart({ port }))
    if (snapshot.value.status === 'running') ElMessage.success('Harness 服务已重启')
  } catch (err) {
    ElMessage.error(err?.message || '重启 Harness 服务失败')
  } finally {
    busy.value = false
  }
}

async function openExternal() {
  const result = await window.gitReport.harnessOpenExternal().catch((err) => ({ ok: false, error: err?.message }))
  if (!result?.ok) ElMessage.error(result?.error || '打开浏览器失败')
}

async function openInstallDocs() {
  ElMessage.info('安装命令：npm i -g @deepseek-ai/dsh，安装后点击「启动服务」')
}

/** 手动停止服务（关闭软件时也会自动停止） */
async function stop() {
  if (busy.value) return
  busy.value = true
  try {
    apply(await window.gitReport.harnessStop())
    ElMessage.success('Harness 服务已停止')
  } catch (err) {
    ElMessage.error(err?.message || '停止 Harness 服务失败')
  } finally {
    busy.value = false
  }
}

function reload() {
  const view = webviewRef.value
  if (view && typeof view.reload === 'function') view.reload()
}

/** 全屏偏好写回配置：下次进入 Harness 视图自动铺满。用监听而非按钮回调，
 *  保证「guest 内按 Esc」「窗口全屏被外部改变」等路径同样记录用户意图 */
watch(immersive, async (value) => {
  state.config.harness = { ...(state.config.harness || {}), fullscreen: !!value }
  try {
    const r = await window.gitReport.configSave(toPlain(state.config))
    if (r && r.ok === false) ElMessage.error(r.error || '全屏偏好保存失败')
  } catch { /* 主进程未就绪时静默 */ }
})

async function setFullscreen(flag) {
  try {
    state.ui.fullscreen = !!(await window.gitReport.winSetFullScreen(flag))
  } catch (err) {
    ElMessage.error(err?.message || '切换全屏失败')
  }
}

function enterFullscreen() { return setFullscreen(true) }
function exitFullscreen() { return setFullscreen(false) }

/** 焦点在宿主页时（未点进 dsh 页面）按 Esc 退出；guest 内的 Esc 由主进程监听 */
function onKeydown(event) {
  if (event.key === 'Escape' && immersive.value) exitFullscreen()
}

function onFailLoad(event) {
  // -3 为主动取消（切换地址时常见），不算故障
  if (event && event.errorCode === -3) return
  if (event && event.errorCode) {
    loadFailed.value = true
    loadFailText.value = `页面加载失败（${event.errorCode} ${event.errorDescription || ''}）`.trim()
  }
}

/** 导航成功即撤下失败浮层（reload / 服务重启 / token 刷新后自动恢复） */
function onNavigated() {
  loadFailed.value = false
}

async function saveSettings() {
  const port = Math.min(65535, Math.max(1024, Number(portInput.value) || 3080))
  state.config.harness = { ...(state.config.harness || {}), port, autoStart: !!autoStartInput.value }
  try {
    const r = await window.gitReport.configSave(toPlain(state.config))
    if (r && r.ok === false) {
      ElMessage.error(r.error || '保存失败')
      return
    }
  } catch (e) {
    ElMessage.error(`保存失败：${(e && e.message) || e}`)
    return
  }
  settingsVisible.value = false
  ElMessage.success('已保存，重启服务后生效')
}

onMounted(async () => {
  unsubscribe = window.gitReport.onHarnessStatus(apply)
  await refresh()
  // 主进程已随应用启动拉起服务；若因端口/安装问题未就绪，进入页面时再兜底启动一次
  if (!running.value && !starting.value && installed.value) start()
  portInput.value = Number(state.config.harness?.port) || 3080
  autoStartInput.value = state.config.harness?.autoStart !== false
  window.addEventListener('keydown', onKeydown)
  // 上次退出时处于全屏 → 进入本视图即恢复铺满
  if (state.config.harness?.fullscreen === true) enterFullscreen()
})

onBeforeUnmount(() => {
  if (unsubscribe) unsubscribe()
  window.removeEventListener('keydown', onKeydown)
  // 离开视图必须恢复应用外壳，否则侧栏/顶栏被隐藏后用户无法导航
  if (immersive.value) window.gitReport.winSetFullScreen(false).catch(() => {})
})
</script>

<style scoped>
.harness-page {
  height: 100%;
  max-width: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 22px 26px 24px;
}
.harness-page .page-header { margin-bottom: 14px; }
/* 沉浸全屏：去掉页面留白与卡片描边，webview 直接铺满整屏 */
.harness-page.is-immersive { padding: 0; }
.harness-page.is-immersive .harness-shell { border: 0; border-radius: 0; }

.harness-pill {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: #4a5568;
  background: #eef1f5;
}
.harness-pill.is-running { color: #1f7a55; background: #e4f4ec; }
.harness-pill.is-starting { color: #9a6b12; background: #fdf3e0; }
.harness-pill.is-error { color: #b03a3a; background: #fdeaea; }

.harness-shell {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #e6eaf0;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
}

/* webview / 占位层只占满舞台，底部信息条始终可见 */
.harness-stage {
  position: relative;
  flex: 1;
  min-height: 0;
}

.harness-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
}

.harness-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px;
  text-align: center;
}
.harness-placeholder h3 { margin: 0; color: #1b242e; font-size: 17px; }
.harness-placeholder p { max-width: 560px; margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.7; }
.harness-placeholder code { padding: 1px 6px; border-radius: 5px; background: #f2f4f7; font-family: var(--brand-mono); font-size: 12px; }
.harness-placeholder-icon { font-size: 30px; color: var(--brand-accent); }
.harness-placeholder-icon.is-spin { animation: harness-spin 1.1s linear infinite; }
@keyframes harness-spin { to { transform: rotate(360deg); } }
.harness-error { color: #b03a3a !important; }
.harness-placeholder-actions { display: flex; gap: 8px; margin-top: 6px; }

.harness-detail {
  max-width: 720px;
  max-height: 160px;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  border-radius: 8px;
  background: #f7f8fa;
  color: #55606e;
  font-family: var(--brand-mono);
  font-size: 11px;
  line-height: 1.6;
  text-align: left;
  white-space: pre-wrap;
}

.harness-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 14px;
  border-top: 1px solid #eef1f5;
  background: #fafbfc;
  color: #55606e;
  font-size: 12px;
}
.harness-dot { width: 7px; height: 7px; border-radius: 50%; background: #49a878; }
.harness-dot.is-starting { background: #d9a441; }
.harness-dot.is-error { background: #d1585a; }
.harness-meta { color: #8a94a2; font-family: var(--brand-mono); }

/* 全屏悬浮条：叠在 webview 之上（DOM 层），半透明以免遮挡 dsh 自己的界面 */
.harness-loadfail {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: #fbfcfd;
  color: #55606e;
  font-size: 13px;
  text-align: center;
  padding: 24px;
}
.harness-loadfail p { margin: 0; max-width: 520px; line-height: 1.7; }
.harness-loadfail-icon { font-size: 28px; color: #d1585a; }
.harness-loadfail-actions { display: flex; gap: 8px; margin-top: 4px; }

.harness-immersive-bar {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px 5px 12px;
  border: 1px solid rgba(0, 0, 0, .06);
  border-radius: 999px;
  background: rgba(255, 255, 255, .86);
  box-shadow: 0 6px 18px rgba(16, 24, 40, .12);
  backdrop-filter: blur(6px);
  font-size: 12px;
  color: #55606e;
  opacity: .55;
  transition: opacity .18s ease;
}
.harness-immersive-bar:hover { opacity: 1; }
.harness-immersive-label { white-space: nowrap; }

.harness-hint { margin-top: 2px; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
</style>
