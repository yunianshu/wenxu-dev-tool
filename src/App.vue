<template>
  <div
    class="app-shell"
    :class="{
      'is-immersive': state.ui.fullscreen,
      'is-sidebar-collapsed': state.ui.sidebarCollapsed,
      'is-sidebar-animatable': sidebarAnimatable,
    }"
  >
    <AppSidebar
      v-if="!state.ui.fullscreen"
      v-model="view"
      :collapsed="state.ui.sidebarCollapsed"
      @toggle-collapse="toggleSidebar"
      @show-changelog="changelogVisible = true"
    />
    <section class="shell-main">
      <!-- 顶栏不再占一块「当前项目」：页头都上提到这里，需要项目的页面
           把项目下拉挂在标题旁（工作台 / 部署），见各视图的 Teleport -->
      <AppTopbar
        v-if="!state.ui.fullscreen"
        :projects="state.projects.items"
        :current-id="state.projects.currentId"
        hide-project-switcher
        @select-project="selectProject"
      />
      <main class="content-area" :class="{ 'content-area--flush': view === 'harness' || view === 'terminal' }">
        <transition name="view-fade" mode="out-in">
          <DashboardView v-if="view === 'dashboard'" key="dashboard" @navigate="navigate" @create-project="openProjectEditor()" />
          <ProjectsView v-else-if="view === 'projects'" key="projects" @navigate="navigate" @create-project="openProjectEditor()" @edit-project="openProjectEditor" />
          <ChatView v-else-if="view === 'chat'" key="chat" @navigate="navigate" />
          <TerminalWorkbenchView v-else-if="view === 'terminal'" key="terminal" />
          <HarnessView v-else-if="view === 'harness'" key="harness" />
          <ReportView v-else-if="view === 'report'" key="report" @navigate="navigate" />
          <FillReportView v-else-if="view === 'fillreport'" key="fillreport" @navigate="navigate" />
          <DeployView v-else-if="view === 'deploy'" key="deploy" @navigate="navigate" />
          <ExtensionsView v-else-if="view === 'extensions'" key="extensions" />
          <SettingsView v-else key="settings" :initial-section="settingsSection" @show-changelog="changelogVisible = true" />
        </transition>
      </main>
    </section>

    <ChangelogDialog v-model="changelogVisible" />
    <ProjectEditor v-model:visible="editorVisible" :project="editingProject" :saving="editorSaving" @saved="saveEditorProject" />
  </div>
</template>

<script setup>
import { ref, h, nextTick, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox, ElNotification, ElCheckbox } from 'element-plus'
import AppSidebar from './components/AppSidebar.vue'
import ChangelogDialog from './components/ChangelogDialog.vue'
import AppTopbar from './components/AppTopbar.vue'
import ProjectEditor from './components/ProjectEditor.vue'
import DashboardView from './views/DashboardView.vue'
import ProjectsView from './views/ProjectsView.vue'
import ChatView from './views/ChatView.vue'
import TerminalWorkbenchView from './views/TerminalWorkbenchView.vue'
import HarnessView from './views/HarnessView.vue'
import ReportView from './views/ReportView.vue'
import FillReportView from './views/FillReportView.vue'
import DeployView from './views/DeployView.vue'
import ExtensionsView from './views/ExtensionsView.vue'
import SettingsView from './views/SettingsView.vue'
import { state } from './store'
import { useProjects } from './composables/useProjects'
import { toPlain } from './utils/ipc'
import { shortPath } from './utils/path'

const view = ref('dashboard')
const changelogVisible = ref(false)
const settingsSection = ref('ai')
const editorVisible = ref(false)
const editorSaving = ref(false)
const editingProject = ref(null)
const { loadProjects, selectProject, saveProject } = useProjects()

/** 首帧已绘制：连续两次 requestAnimationFrame 之后，浏览器已完成第一次绘制。
 *  窗口被遮挡/锁屏时 rAF 会被 Chromium 节流，因此加一个上限兜底，
 *  保证后台任务最多晚 1.5 秒启动（主进程侧还有 did-finish-load 兜底）。 */
function afterFirstPaint() {
  return Promise.race([
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])
}

/** 侧栏折叠动画开关：从磁盘恢复收起状态时不能播一次滑出动画（见 restoreSidebarPref） */
const sidebarAnimatable = ref(false)
/** 用户是否已手动开合过侧栏：用于压过迟到的偏好读取（见 restoreSidebarPref） */
let sidebarTouched = false

/** 侧栏收起状态（外观偏好）：按上次退出时的状态恢复。
 *  恢复过程本身不加动画（见 sidebarAnimatable），避免每次启动都看到侧栏滑一次 */
async function restoreSidebarPref() {
  let saved = null
  try {
    saved = await window.gitReport.uiPrefsLoad?.()
  } catch { /* 主进程未就绪：保持默认展开 */ }
  // 主进程繁忙时这个回包可能晚于用户点击：用户已经点过就以用户为准，
  // 否则会把刚切换的状态倒回磁盘上的旧值（侧栏自己弹回去）
  if (!sidebarTouched) state.ui.sidebarCollapsed = saved?.sidebarCollapsed === true
  await nextTick()
  sidebarAnimatable.value = true
}

/** 侧栏收起/展开：外观偏好即时生效并落盘，下次启动按收起状态恢复 */
function toggleSidebar() {
  sidebarTouched = true
  state.ui.sidebarCollapsed = !state.ui.sidebarCollapsed
  // 落盘失败不阻断交互（下次启动回落到展开态），仅记录，不打扰用户
  window.gitReport?.uiPrefsSave?.({ sidebarCollapsed: state.ui.sidebarCollapsed })
    ?.catch((error) => console.error('侧栏偏好保存失败', error))
}

/** 将页面导航意图集中映射；活动源列表复用设置页的 Git 活动分区。 */
function navigate(target) {
  if (target === 'activity-sources') {
    settingsSection.value = 'git'
    view.value = 'settings'
    return
  }
  if (target === 'fill-settings') {
    settingsSection.value = 'fill'
    view.value = 'settings'
    return
  }
  view.value = target
}

function openProjectEditor(project = null) {
  editingProject.value = project ? JSON.parse(JSON.stringify(project)) : null
  editorVisible.value = true
}

/** 全屏只属于 Harness 视图：任何原因切走后立即恢复应用外壳（侧栏被隐藏时用户无法自行切走） */
watch(view, (next) => {
  if (next !== 'harness' && state.ui.fullscreen) window.gitReport.winSetFullScreen(false).catch(() => {})
})

async function saveEditorProject(project) {
  editorSaving.value = true
  try {
    await saveProject(project)
    editorVisible.value = false
    view.value = 'projects'
    ElMessage.success(project.id ? '项目已更新' : '项目已创建')
  } catch (error) {
    ElMessage.error(error?.message || '保存项目失败')
  } finally {
    editorSaving.value = false
  }
}

/** 关闭询问（主进程 close 拦截后广播触发）：默认按钮=最小化到托盘（不杀死程序），
 *  「退出程序」彻底关闭，右上角 × / ESC 取消保留窗口；勾选「记住」后按选择落盘不再询问 */
let closeAsking = false
function showCloseAsk() {
  if (closeAsking) return // 主进程已防重入，渲染层再兜一层
  closeAsking = true
  const remember = ref(false)
  ElMessageBox.confirm(
    // message 用渲染函数：ElCheckbox 的勾选状态（remember ref）变化时弹窗内容同步重渲染
    () => h('div', { class: 'close-ask' }, [
      h('p', { class: 'close-ask-text' },
        '最小化后程序会继续在后台运行（包括内置 Harness 服务），可随时从系统托盘图标重新打开窗口或彻底退出。'),
      h(ElCheckbox, {
        modelValue: remember.value,
        'onUpdate:modelValue': (v) => { remember.value = v },
      }, () => '记住我的选择，下次不再询问'),
    ]),
    '关闭「开发项目管理」',
    {
      type: 'warning',
      confirmButtonText: '最小化到托盘',
      cancelButtonText: '退出程序',
      distinguishCancelAndClose: true, // 「退出程序」按钮=cancel，×/ESC=close（取消）
      closeOnClickModal: false,
      autofocus: true, // 焦点落在「最小化到托盘」，回车即默认动作
    },
  ).then(() => window.gitReport.winCloseConfirm?.({ action: 'minimize', remember: remember.value }))
    .catch((act) => {
      // cancel=退出程序；close（×/ESC）= 取消，窗口保留
      if (act === 'cancel') window.gitReport.winCloseConfirm?.({ action: 'quit', remember: remember.value })
    })
    .finally(() => { closeAsking = false })
}

onMounted(async () => {
  // 外壳已进文档：此后各视图投递页头到顶栏插槽才能找到目标（初始视图挂载时还在文档外）
  state.ui.shellMounted = true
  // 沉浸全屏：窗口全屏状态由主进程维护，渲染层只跟随（F11/Esc 等外部改变同样同步）
  window.gitReport.onWinFullscreen((value) => { state.ui.fullscreen = !!value })
  try { state.ui.fullscreen = !!(await window.gitReport.winIsFullScreen()) } catch { /* 主进程未就绪 */ }
  // 关闭询问：主进程 close 拦截后广播，这里弹与项目 UI 一致的询问框，结果回传执行
  window.gitReport.onWinAskClose?.(showCloseAsk)

  // 侧栏偏好不阻塞启动（与项目加载无关），独立恢复
  restoreSidebarPref()

  // 内置 Harness 更新：状态与安装进度由主进程广播（安装可达分钟级）；
  // 首次发现某个新版本时（notify）提示一次，点提示直接进 Harness 页更新
  window.gitReport.onHarnessUpdate?.((payload) => {
    if (!payload || typeof payload !== 'object') return
    Object.assign(state.harnessUpdate, payload)
    if (payload.notify && payload.latest) {
      ElNotification({
        title: `DeepSeek Harness 有新版本 ${payload.latest}`,
        message: `当前 ${payload.current}，点此进入 Harness 页更新`,
        type: 'info',
        duration: 10000,
        onClick: () => { view.value = 'harness' },
      })
    }
  })
  window.gitReport.harnessUpdateStatus?.()
    .then((status) => { if (status && typeof status === 'object') Object.assign(state.harnessUpdate, status) })
    .catch(() => { /* 主进程尚未就绪 */ })

  await loadProjects()
  try {
    const cfg = await window.gitReport.configLoad()
    if (cfg) {
      let migrated = false
      // 兼容旧版单身份配置。
      if (cfg.myIdentity && (cfg.myIdentity.name || cfg.myIdentity.email) && (!cfg.identities || !cfg.identities.length)) {
        cfg.identities = [cfg.myIdentity]
        migrated = true
      }
      if (!cfg.identities || !cfg.identities.length) {
        const identity = await window.gitReport.getIdentity()
        if (identity.name || identity.email) { cfg.identities = [identity]; migrated = true }
      }
      delete cfg.myIdentity
      if (!Array.isArray(cfg.identities)) cfg.identities = []
      // 仅迁移实际改动了配置时才写盘：每次启动都整份重写属无谓 I/O
      if (migrated) await window.gitReport.configSave(toPlain(cfg))
      state.config = { ...state.config, ...cfg }
    }

    // ─── Git 扫描全局接线：预热与手动扫描的事件都实时反映到工作台 ───
    const pathKey = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()
    /** 用权威仓库路径列表同步发现列表（保留已加载的 info，避免详情重复请求）。
     *  空数组同样生效：根目录被删掉后列表要跟着收缩，否则报告/填报仍会查询已移除的仓库 */
    const syncDiscoveredRepos = (paths) => {
      if (!Array.isArray(paths)) return
      const known = new Map(state.discoveredRepos.map((row) => [pathKey(row.path), row]))
      state.discoveredRepos = paths.map((path) => known.get(pathKey(path)) || { path, shortName: shortPath(path), info: null })
    }
    window.gitReport.onScanProgress((progress) => {
      state.report.scanProgress = progress
      state.scan.scanning = true
      if (progress && progress.scanned) state.scan.scanned = progress.scanned
    })
    window.gitReport.onScanRepoFound((repoPath) => {
      // 发现即入列（按路径去重；设置页手动扫描同样监听，两边互不重复）
      if (!repoPath || state.discoveredRepos.some((repo) => pathKey(repo.path) === pathKey(repoPath))) return
      state.discoveredRepos.push({ path: repoPath, shortName: shortPath(repoPath), info: null })
    })
    window.gitReport.onScanDone(() => {
      state.scan.scanning = false
    })
    let warmupActive = false
    window.gitReport.onCollectProgress((progress) => {
      state.report.collectProgress = progress
      // 仅启动预热的收集才计入工作台进度（报告页生成报告的收集不属于预热）
      if (warmupActive && progress && progress.total) {
        state.scan.collecting = true
        state.scan.collectDone = progress.done || 0
        state.scan.collectTotal = progress.total
      }
    })
    window.gitReport.onDeployLog((log) => {
      state.deploy.logs.push(log)
      if (state.deploy.logs.length > 2000) state.deploy.logs.splice(0, state.deploy.logs.length - 2000)
    })
    window.gitReport.onDeployStage((stage) => {
      const st = state.deploy.stages[stage.stage]
      if (!st) return
      st.status = stage.status
      // 阶段耗时只在结束时由主进程下发（running 事件为 0），用于 chips 上的时间标注
      if (stage.durationMs) st.durationMs = stage.durationMs
    })
    window.gitReport.onDeployProgress((progress) => {
      if (progress.kind === 'package') state.deploy.packageCount = progress.count || 0
      if (progress.kind === 'upload') state.deploy.uploadPercent = progress.percent || 0
      if (progress.kind === 'datasync') state.deploy.datasyncPercent = progress.percent || 0
    })
    window.gitReport.onDeployDone((result) => {
      state.deploy.running = false
      state.deploy.finishedAt = Date.now()
      // 仅发布成功才更新线上版本（回滚/数据恢复的 version 字段不是版本号）
      if (result?.record?.type === 'deploy' && result?.record?.status === 'success') {
        state.deploy.currentVersion = result.record.version
      }
    })

    warmupActive = true
    // 预热（仓库扫描 + 今日提交预收集）推迟到首帧绘制之后再发起：扫描与「每个仓库一个
    // git 子进程」都会占用主进程（Windows 建进程是同步阻塞调用线程的），在首帧前发起会
    // 拖慢「打开 → 主页可见」。首帧就绪后先通知主进程启动后台任务，再取快照与预热结果。
    await afterFirstPaint()
    window.gitReport.appUiReady?.()
    // 预热早于本组件挂载启动时，接线前广播的发现事件已丢失：先用快照补齐，
    // 否则收集期间的「Git 活动源」数量会小于「正在加载今日活动 x/y」的总数
    window.gitReport.reposSnapshot().then(syncDiscoveredRepos).catch(() => {})
    window.gitReport.warmup().then((repos) => {
      warmupActive = false
      state.scan.collecting = false
      // 预热结果为权威列表：按路径合并（保留已有项的 info，补齐事件流可能漏掉的）
      syncDiscoveredRepos(repos)
    }).catch(() => {
      warmupActive = false
      state.scan.collecting = false
    })
  } catch (error) {
    console.error('初始化应用失败', error)
  }
})
</script>
