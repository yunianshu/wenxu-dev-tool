<template>
  <div class="deploy-page">
    <!-- 页头上提到应用顶栏；部署目标就是项目，所以把项目下拉挂在标题旁
         （读作「部署 · 自测项目 1」），既显示当前部署哪个项目也保留了切换入口 -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <div class="topbar-title-group">
          <h1 class="topbar-page-title">部署</h1>
          <TopbarProjectSelect />
        </div>
        <el-button v-if="currentProject" @click="aiOpen = true"><el-icon><MagicStick /></el-icon>AI 部署助手</el-button>
        <el-button type="primary" @click="serverManagerOpen = true">服务器管理</el-button>
        <el-button v-if="currentProject" @click="configOpen = true"><el-icon><Setting /></el-icon>部署设置</el-button>
        <el-button v-if="currentProject" :loading="testing" :disabled="!form.id || dirty" @click="testConnection"><el-icon><Link /></el-icon>测试连接</el-button>
      </div>
    </Teleport>
    <ServerManagerDialog v-model="serverManagerOpen" :servers="servers" :busy="state.deploy.running" @changed="onServersChanged" />

    <EmptyState
      v-if="!currentProject" icon="Promotion" title="先选择一个项目"
      description="部署始终作用于明确的项目。请到「项目」页选中一个项目，或先创建项目。"
      action="前往项目" @action="$emit('navigate', 'projects')"
    />

    <template v-else>
    <!-- 当前部署目标与连接状态 -->
    <el-card shadow="never" class="card bar-card">
      <div class="bar">
        <span class="bar-label">{{ form.deployMode === 'auto' ? '自动发布' : '部署环境' }}</span>
        <el-select
          v-if="form.deployMode !== 'auto'"
          v-model="activeTargetId"
          placeholder="选择环境"
          style="width: 220px"
        >
          <el-option v-for="target in form.targets" :key="target.id" :value="target.id" :label="target.name || '未命名环境'" />
        </el-select>
        <el-select :model-value="activeTarget?.serverId || ''" placeholder="选择部署服务器" style="width: 260px" :disabled="state.deploy.running || dirty" @change="selectDeploymentServer">
          <el-option v-for="server in servers" :key="server.id" :value="server.id" :label="`${server.name} · ${server.host}`" />
        </el-select>
        <span v-if="form.deployMode === 'auto'" class="target-host mono">{{ activeTarget?.remotePath || '安装目录按项目自动分配' }}</span>
        <span v-else class="target-host mono">{{ activeTarget?.server?.host || '未配置主机' }} → {{ activeTarget?.remotePath || '未配置部署目录' }}</span>
        <div class="spacer" />
        <el-tag v-if="dirty" type="warning" effect="plain" size="small">有未保存修改</el-tag>
        <el-tag v-else-if="activeTarget?.server?.host" type="info" effect="plain" size="small">发布时自动检查</el-tag>
        <el-tag v-else type="info" effect="plain" size="small">需要配置</el-tag>
      </div>
      <el-alert v-if="connResult" :type="connResult.ok ? 'success' : 'error'" :closable="true" class="conn-alert" @close="connResult = null">
        <template #title>
          <span v-if="connResult.ok">
            连接成功 · {{ connResult.os || '未知系统' }} · Docker: {{ connResult.docker || '未安装' }} ·
            Compose: {{ connResult.compose || '未安装' }} · unzip: {{ connResult.unzip || '未安装' }} ·
            tar: {{ connResult.tar || '未安装' }} · java: {{ connResult.java || '未安装' }} ·
            根分区已用 {{ connResult.disk || '未知' }}
          </span>
          <span v-else>连接失败：{{ connResult.error }}</span>
        </template>
      </el-alert>
    </el-card>

    <el-alert v-if="form.deployMode === 'auto'" title="在服务器管理中维护一次连接，各项目选择复用。安装目录、服务端口和数据按项目隔离，点击发布后自动准备环境并构建上线。" type="info" :closable="false" />

    <DeployConfigDrawer
      ref="configDrawerRef"
      v-model="configOpen"
      v-model:active-target-id="activeTargetId"
      :form="form"
      :detected="detected"
      :projects="state.deploy.projects"
      :servers="servers"
      @manage-servers="serverManagerOpen = true"
      @save="saveProject"
      @copy-config="onCopyConfig"
      @reset-conn="connResult = null"
    />

    <DeployAiAssistant
      v-model="aiOpen"
      :form="form"
      :active-target-id="activeTargetId"
      @applied="onPlanApplied"
    />

      <div class="deploy-main-column">
        <DeployRunPanel
          ref="runPanelRef"
          :form="form"
          :active-target="activeTarget"
          :active-target-id="activeTargetId"
          :publish-version="publishVersion"
          :dirty="dirty"
          @history-changed="reloadHistory"
          @set-version="onNewVersion"
        />
        <DeployHistoryTable
          ref="historyRef"
          :project-id="form.id"
          @rollback="onHistoryRollback"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { reactive, ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { useProjects } from '../composables/useProjects'
import EmptyState from '../components/EmptyState.vue'
import TopbarProjectSelect from '../components/TopbarProjectSelect.vue'
import DeployConfigDrawer from '../components/deploy/DeployConfigDrawer.vue'
import DeployAiAssistant from '../components/deploy/DeployAiAssistant.vue'
import DeployRunPanel from '../components/deploy/DeployRunPanel.vue'
import DeployHistoryTable from '../components/deploy/DeployHistoryTable.vue'
import ServerManagerDialog from '../components/deploy/ServerManagerDialog.vue'
import { emptyTarget, emptyProject, fmtDur, refreshTargetServer } from '../components/deploy/deploy-form'

defineEmits(['navigate'])
const { currentProject, loadProjects: loadSharedProjects } = useProjects()
const topbarReady = useTopbarReady()

const form = reactive(emptyProject())
const configOpen = ref(false)
const serverManagerOpen = ref(false)
const servers = ref([])
const aiOpen = ref(false)
const configDrawerRef = ref(null)
const activeTargetId = ref('')
const detected = ref({ version: '', source: '' })
const testing = ref(false)
const connResult = ref(null)
const runPanelRef = ref(null)
const historyRef = ref(null)
let offDone = null
let detectTimer = null
let disposed = false

/** 当前编辑的部署目标（响应式：切换目标后服务器/健康检查卡随之切换） */
const activeTarget = computed(() => {
  const t = form.targets.find((x) => x.id === activeTargetId.value)
  return t || form.targets[0] || null
})

/** 当前选中项目（用于脏检查） */
const selectedRaw = computed(() => state.deploy.projects.find((p) => p.id === state.deploy.currentProjectId) || null)

/** 表单是否与已保存配置不一致（凭据字段不参与比较） */
const dirty = computed(() => {
  if (!form.id || !selectedRaw.value) return false
  // 键序无关的稳定序列化：form 由 emptyProject() 展开、selectedRaw 由主进程 normalizeProject 产出，
  // 两者字段相同但键顺序可能不同，直接 JSON.stringify 会误判为脏
  const stable = (v) => {
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    return JSON.stringify(v)
  }
  const norm = (o) => {
    const c = JSON.parse(JSON.stringify(o))
    for (const t of c.targets || []) {
      const s = t.server || {}
      for (const k of ['secret', 'passphrase', 'clearSecret', 'clearPassphrase', 'secretConfigured', 'secretMasked', 'passphraseConfigured']) delete s[k]
      // 数据同步导入凭据同规则排除：list() 脱敏后无 importSecret/clearImportSecret 键，
      // 而 fillForm 合并默认值会补回（''/false），不排除则加载后恒报脏、测试连接被禁用
      const ds = t.dataSync || {}
      for (const k of ['importSecret', 'clearImportSecret', 'importSecretConfigured', 'importSecretMasked']) delete ds[k]
    }
    return stable(c)
  }
  // 清除凭据标记是待保存的变更：不计入则用户点了「清除」也不显示「有未保存修改」，易漏保存
  const hasPendingClear = form.targets.some((t) =>
    t.server?.clearSecret || t.server?.clearPassphrase || t.dataSync?.clearImportSecret)
  return norm(form) !== norm(selectedRaw.value) || hasPendingClear
})

const publishVersion = computed(() => {
  if (form.version.strategy === 'manual' && form.version.manual) return form.version.manual
  return detected.value.version || ''
})

// ─── 数据加载 ───
async function loadProjects() {
  try {
    // 磁盘是唯一真源：复制配置、删除项目、保存都直接改 deploy-projects.json，
    // 这里必须重新拉取。曾因「state.projects.items 非空就跳过拉取」而复用改动前的缓存，
    // 表现为「复制项目配置后界面毫无变化」——环境列表与服务器卡片都停在旧数据上。
    await loadSharedProjects()
    servers.value = await window.gitReport.deployServersList()
    state.deploy.projects = state.projects.items
  } catch { state.deploy.projects = [] }
  state.deploy.currentProjectId = state.projects.currentId
  const selected = state.deploy.projects.find((project) => project.id === state.deploy.currentProjectId)
  if (selected) fillForm(selected, selected.id === form.id ? activeTargetId.value : '')
}

/** preferredTargetId：填充后尽量停留的环境（保存/换版本等流程不得把用户悄悄切到环境 1） */
function fillForm(p, preferredTargetId = '') {
  const base = emptyProject()
  const merged = { ...base, ...JSON.parse(JSON.stringify(p || {})) }
  merged.version = { ...base.version, ...(p && p.version || {}) }
  merged.deploy = { ...base.deploy, ...(p && p.deploy || {}) }
  merged.scriptMode = { ...base.scriptMode, ...(p && p.scriptMode || {}) }
  // 目标数组：至少一个；密钥输入框每次填充后清空（留空＝保持已保存的凭据）
  merged.targets = (p && Array.isArray(p.targets) && p.targets.length)
    ? p.targets.map((t) => {
        const et = emptyTarget()
        const server = { ...et.server, ...(t.server || {}) }
        server.secret = ''
        server.passphrase = ''
        server.clearSecret = false
        server.clearPassphrase = false
        const dataSync = { ...et.dataSync, ...(t.dataSync || {}) }
        dataSync.importSecret = ''
        dataSync.clearImportSecret = false
        // db 显式合并默认值：旧配置（数据库备份在项目级）或字段缺失时保证环境级结构完整，
        // 否则与主进程 normalizeProject 产出的键集不一致，dirty 会恒为真
        const db = { ...et.db, ...(t.db || {}) }
        return { ...et, ...t, server, health: { ...et.health, ...(t.health || {}) }, db, dataSync }
      })
    : base.targets
  Object.assign(form, merged)
  const want = preferredTargetId && merged.targets.some((t) => t.id === preferredTargetId)
    ? preferredTargetId
    : (merged.targets.find((t) => t.id === merged.productionTargetId) || merged.targets.find((t) => t.server?.host) || merged.targets[0]).id
  activeTargetId.value = want
  detectVersion()
}

function reloadHistory() {
  historyRef.value?.reload()
}

function onHistoryRollback(version, targetId) {
  runPanelRef.value?.doRollback(version, targetId)
}

/** 清空上一次发布运行残留的展示状态（阶段 chips / 日志 / 进度计数）。
 *  发布进行中不清理：运行进度与日志按 store 约定跨视图保留，不因切换项目丢失在途展示 */
function resetRunDisplay() {
  if (state.deploy.running) return
  state.deploy.stages = {}
  state.deploy.logs = []
  state.deploy.packageCount = 0
  state.deploy.uploadPercent = 0
  state.deploy.datasyncPercent = 0
  state.deploy.startedAt = 0
  state.deploy.finishedAt = 0
}

function onSelectProject(id) {
  const p = state.deploy.projects.find((x) => x.id === id)
  runPanelRef.value?.resetSelection()
  connResult.value = null
  state.deploy.currentVersion = ''
  resetRunDisplay()
  if (p) fillForm(p)
  else { Object.assign(form, emptyProject()); activeTargetId.value = form.targets[0].id }
  // 发布历史由 DeployHistoryTable 自行 watch projectId 刷新（同步调用会读到旧 props）
}

function newProject() {
  state.deploy.currentProjectId = ''
  Object.assign(form, emptyProject())
  activeTargetId.value = form.targets[0].id
  detected.value = { version: '', source: '' }
  runPanelRef.value?.resetSelection()
  connResult.value = null
  resetRunDisplay()
}

/** 复制服务器连接（含加密凭据），完成后选中新追加的第一个环境。 */
async function onCopyConfig(fromProjectId) {
  // 复制前已存在的环境 id：复制后据此找出新追加的环境。
  // 不能用下标（prevTargetCount）判定——抽屉里可能有尚未保存的新增环境，下标会对不上
  const knownIds = new Set(form.targets.map((t) => t.id))
  try {
    const r = await window.gitReport.deployProjectsCopyConfig({ fromProjectId, toProjectId: form.id })
    if (!r || !r.ok) return ElMessage.error((r && r.error) || '复制失败')
    // 复制改的是磁盘：loadProjects 必须重新拉取列表并回填，否则界面停在复制前
    await loadProjects()
    const p = state.deploy.projects.find((x) => x.id === form.id)
    if (p) {
      fillForm(p)
      state.deploy.currentProjectId = form.id
      const firstNew = form.targets.find((t) => !knownIds.has(t.id))
      if (firstNew) activeTargetId.value = firstNew.id
    }
    connResult.value = null
    runPanelRef.value?.resetSelection()
    state.deploy.currentVersion = ''
    // 复制已落盘不可撤销：重置抽屉的取消快照，避免用户接着点「取消」把界面回滚成复制前
    configDrawerRef.value?.rebaseline()
    ElMessage.success(`已复制 ${r.copiedTargets} 个环境的部署配置`)
  } catch (e) {
    ElMessage.error(e.message || String(e))
  }
}

/** AI 部署助手把方案写回磁盘后：重新拉取并回填表单，当前环境保持不变 */
async function onPlanApplied() {
  await loadProjects()
  const p = state.deploy.projects.find((x) => x.id === form.id)
  if (p) fillForm(p, activeTargetId.value)
  connResult.value = null
  runPanelRef.value?.resetSelection()
}

async function saveProject(successMsg = '配置已保存') {  if (!form.name) { ElMessage.warning('请填写项目名称'); return false }
  const payload = JSON.parse(JSON.stringify(form))
  if (!payload.targets.length) payload.targets = [emptyTarget()]
  // 部署目录留空时按目标随名称自动建议，用户仍可随时修改
  for (const t of payload.targets) {
    if (form.deployMode !== 'auto' && !t.remotePath && form.name) t.remotePath = `/opt/apps/${form.name}-${form.id.slice(-6)}`
  }
  const r = await window.gitReport.deployProjectsSave(payload)
  if (r && r.ok) {
    ElMessage.success(successMsg)
    await loadSharedProjects()
    await loadProjects()
    state.deploy.currentProjectId = r.id
    state.projects.currentId = r.id
    const p = state.deploy.projects.find((x) => x.id === r.id)
    if (p) {
      fillForm(p, activeTargetId.value) // 保存不切换当前选中的部署环境
    }
    configOpen.value = false
    return true
  }
  ElMessage.error('保存失败')
  return false
}

async function selectDeploymentServer(serverId) {
  const server = servers.value.find((s) => s.id === serverId)
  if (!server || !activeTarget.value) return
  const target = activeTarget.value
  if (target.serverId !== serverId && form.deployMode === 'auto') { target.remotePath = ''; delete target.autoSudo; delete target.autoHealth; delete target.autoDb }
  target.serverId = serverId
  target.server = { ...server }; delete target.server.projects
  if (form.deployMode === 'auto') { target.name = '正式环境'; form.productionTargetId = target.id }
  connResult.value = null
  state.deploy.currentVersion = ''
  await saveProject('已选择服务器，可以一键发布')
}

async function onServersChanged() {
  // 只刷新共享连接，保留部署抽屉中尚未保存的项目路径等编辑。
  servers.value = await window.gitReport.deployServersList()
  await loadSharedProjects()
  state.deploy.projects = state.projects.items
  for (const target of form.targets) {
    const server = servers.value.find((s) => s.id === target.serverId)
    if (server) refreshTargetServer(target, server, form.deployMode === 'auto')
  }
  configDrawerRef.value?.refreshServerSnapshot(servers.value)
  connResult.value = null
}

/** 发布卡「新版本」（spec R7）：切手动版本并保存，发布按钮立即生效 */
async function onNewVersion(version) {
  form.version.strategy = 'manual'
  form.version.manual = version
  const saved = await saveProject(`新版本 ${version} 已保存，可直接发布`)
  // 版本已切换＝进入新一轮发布准备，复位上一轮的阶段/日志/进度展示；
  // 否则下方发布进程状态仍停在上一次的 ✓/✗，与「即将发布新版本」的预期不符
  if (saved) resetRunDisplay()
}

async function removeProject() {
  try {
    await ElMessageBox.confirm(`确认删除项目「${form.name}」？仅删除本地配置，不影响服务器。`, '删除项目', { type: 'warning' })
  } catch { return }
  await window.gitReport.deployProjectsRemove(form.id)
  state.deploy.currentProjectId = ''
  Object.assign(form, emptyProject())
  activeTargetId.value = form.targets[0].id
  await loadProjects()
  ElMessage.success('已删除')
}

// ─── 版本识别（防抖） ───
async function detectVersion() {
  if (form.version.strategy === 'manual') return
  if (!form.localPath) { detected.value = { version: '', source: '' }; return }
  try {
    const r = await window.gitReport.deployDetectVersion({ localPath: form.localPath, version: { strategy: 'auto' } })
    detected.value = r || { version: '', source: '' }
  } catch { detected.value = { version: '', source: '' } }
}
watch(() => form.localPath, () => {
  clearTimeout(detectTimer)
  detectTimer = setTimeout(detectVersion, 400)
})

// ─── 连接测试（当前目标） ───
async function testConnection() {
  testing.value = true
  connResult.value = null
  try {
    connResult.value = await window.gitReport.deployTestConnection(form.id, activeTargetId.value)
  } catch (e) {
    connResult.value = { ok: false, error: e.message || String(e) }
  } finally {
    testing.value = false
  }
}

onMounted(() => {
  loadProjects() // 发布历史由 DeployHistoryTable 的 immediate watch 驱动首载
  // 发布完成事件：刷新历史 + 结果汇总（App.vue 已更新 running/stages）
  offDone = window.gitReport.onDeployDone(async (d) => {
    reloadHistory()
    const r = d && d.record
    if (!r) return
    if (r.projectId === form.id && form.deployMode === 'auto') {
      await loadProjects()
    }
    if (disposed) return
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
    const head = `<b>${esc(r.projectName)}</b>${r.targetName ? ` · ${esc(r.targetName)}` : ''} ${esc(r.version)} → ${esc(r.host)}`
    if (r.status === 'success') {
      if (r.type === 'deploy' && r.projectId === state.projects.currentId && r.projectId === form.id && r.targetId === activeTargetId.value) {
        state.deploy.currentVersion = r.releaseId || r.version
      }
      await ElMessageBox.alert(
        `${head}<br/>耗时 ${fmtDur(r.durationMs)}<br/><br/>✓ 发布成功${r.serviceUrl ? `<br/>访问地址：${esc(r.serviceUrl)}` : ''}`,
        '发布成功',
        { dangerouslyUseHTMLString: true, confirmButtonText: '好的' },
      )
    } else if (r.status === 'failed') {
      await ElMessageBox.alert(
        `${head}<br/>版本 ${esc(r.version)}（原版本 ${esc(r.oldVersion) || '无'}）<br/><br/>✗ 发布失败<br/>${esc(r.message) || ''}`,
        '发布失败',
        { dangerouslyUseHTMLString: true, type: 'error', confirmButtonText: '知道了' },
      )
    } else if (r.status === 'rolled_back') {
      await ElMessageBox.alert(
        `${head}<br/>版本 ${esc(r.version)} 发布失败，已自动回滚到 <b>${esc(r.oldVersion) || '旧版本'}</b>。<br/><br/>原因：${esc(r.message) || ''}`,
        '已自动回滚',
        { dangerouslyUseHTMLString: true, type: 'warning', confirmButtonText: '知道了' },
      )
    } else if (r.status === 'canceled') {
      ElMessage.info('发布已取消')
    }
  })
})

watch(() => state.projects.currentId, (projectId) => {
  if (projectId === state.deploy.currentProjectId && form.id === projectId) return
  state.deploy.currentProjectId = projectId || ''
  onSelectProject(projectId || '')
})

onUnmounted(() => {
  disposed = true
  if (offDone) offDone()
  clearTimeout(detectTimer)
})
</script>

<style scoped>
.deploy-page { display: flex; flex-direction: column; gap: 0; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bar-label { font-weight: 600; margin-right: 4px; }
.bar .spacer { flex: 1; }
.conn-alert { margin-top: 12px; }
</style>
