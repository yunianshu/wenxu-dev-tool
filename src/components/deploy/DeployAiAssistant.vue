<template>
  <el-dialog
    :model-value="modelValue"
    title="AI 部署助手"
    width="920px"
    top="4vh"
    :close-on-click-modal="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="ai-deploy">
      <el-alert type="info" :closable="false">
        <template #title>
          新项目接入：体检 → 根据构建与启动代码生成部署文件 → 静态校验 → 预览并写入 → 套用配置 → 发布。
          静态校验不代表已经构建成功或真实运行；发布时仍需验证构建与服务健康。覆盖部署文件前自动备份原文件。
        </template>
      </el-alert>

      <div class="ops">
        <el-button type="primary" :loading="running" :disabled="!projectId || busy" @click="run">
          {{ running ? '体检中…' : (result ? '重新体检' : '开始体检') }}
        </el-button>
        <el-button v-if="result" type="primary" plain :loading="generatingAll" :disabled="busy || local.exists !== true" @click="generateAll">
          {{ generatingAll ? '生成部署文件中…' : '一键生成部署文件' }}
        </el-button>
        <el-tag v-if="stepText" type="info" effect="plain">{{ stepText }}</el-tag>
        <span v-if="!projectId" class="warn-text">请先保存项目，再执行体检</span>
        <div class="spacer" />
        <el-tag v-if="result" :type="result.plan.source === 'ai' ? 'success' : 'warning'" effect="plain">
          结论来源：{{ result.plan.source === 'ai' ? `AI（${result.ai.model}）` : '确定性规则' }}
        </el-tag>
      </div>
      <div v-if="result && !result.ai.used && result.ai.error" class="ai-warn">
        AI 未参与本轮结论：{{ result.ai.error }}（已给出确定性规则结论）
      </div>

      <template v-if="result">
        <!-- ① 本地体检 -->
        <el-card shadow="never" class="card sec">
          <template #header><div class="card-header"><span>① 项目体检（本地）</span>
            <el-tag size="small" :type="local.exists === true ? 'success' : 'danger'" effect="plain">
              {{ local.exists === true ? '目录可读' : '目录不可用' }}
            </el-tag>
          </div></template>
          <el-descriptions :column="2" size="small" border>
            <el-descriptions-item label="项目目录">
              <span class="mono">{{ result.local.root || '（未配置）' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="技术栈">
              <el-tag v-for="s in result.local.stack" :key="s.file" size="small" class="tag" effect="plain">{{ s.label }}</el-tag>
              <span v-if="!result.local.stack.length" class="dim">未识别</span>
            </el-descriptions-item>
            <el-descriptions-item label="版本来源">
              <span v-if="result.local.version.version" class="mono">{{ result.local.version.version }}</span>
              <span v-else class="dim">未识别（需手动填写版本号）</span>
            </el-descriptions-item>
            <el-descriptions-item label="发布产物目录">
              <span v-if="result.local.artifactDirs.length" class="mono">{{ result.local.artifactDirs.map((a) => a.path).join('、') }}</span>
              <span v-else class="dim">未发现已有发布包</span>
            </el-descriptions-item>
          </el-descriptions>

          <div class="block-title">部署文件</div>
          <div class="tags">
            <el-tag v-for="f in result.local.deployFiles.present" :key="f.rel" size="small" type="success" effect="plain" class="tag">
              {{ f.rel }}
            </el-tag>
            <el-tag v-for="f in planMissingFiles" :key="f.path" size="small" type="danger" effect="plain" class="tag">
              缺 {{ f.path }}
            </el-tag>
            <span v-if="!result.local.deployFiles.present.length && !planMissingFiles.length" class="dim">无</span>
          </div>

          <template v-if="result.local.dataCandidates.length">
            <div class="block-title">数据目录候选（升级时必须保留）</div>
            <el-table :data="result.local.dataCandidates" size="small" max-height="180">
              <el-table-column prop="path" label="目录" min-width="180">
                <template #default="{ row }"><span class="mono">{{ row.path }}</span></template>
              </el-table-column>
              <el-table-column label="规模" width="150">
                <template #default="{ row }">{{ row.files }} 项 / {{ fmtSize(row.sizeBytes) }}</template>
              </el-table-column>
              <el-table-column label="编排挂载" width="100">
                <template #default="{ row }">
                  <el-tag v-if="row.mounted" size="small" type="warning" effect="plain">容器挂载</el-tag>
                  <span v-else class="dim">—</span>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </el-card>

        <!-- ② 服务器体检 -->
        <el-card shadow="never" class="card sec">
          <template #header><div class="card-header"><span>② 部署条件校验（服务器）</span>
            <el-tag size="small" :type="remoteReady ? 'success' : 'danger'" effect="plain">
              {{ remoteReady ? '满足部署条件' : '存在阻塞项' }}
            </el-tag>
          </div></template>
          <template v-if="result.remote.ok">
            <el-descriptions :column="2" size="small" border>
              <el-descriptions-item label="服务器">
                <span class="mono">{{ result.remote.os }} · {{ result.remote.user }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="Docker">
                <span class="mono">{{ result.remote.docker || '未安装' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="Compose">
                <span class="mono">{{ result.remote.compose || '未安装' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="根分区可用">
                <span class="mono">{{ result.remote.disk || '未知' }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="部署目录">
                <span class="mono">{{ result.remote.path || '（未配置）' }}</span>
                <el-tag size="small" class="tag" :type="result.remote.pathExists ? 'warning' : 'success'" effect="plain">
                  {{ result.remote.pathExists ? '已存在内容' : '不存在（首次部署将创建）' }}
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="受管部署记录">
                <span v-if="result.remote.managed && result.remote.managed.current" class="mono">
                  CURRENT = {{ result.remote.managed.current }}（历史 {{ result.remote.managed.releases.length }} 个版本）
                </span>
                <span v-else class="dim">无（首次接入本工具部署）</span>
              </el-descriptions-item>
            </el-descriptions>
            <div class="block-title">工具链</div>
            <div class="tags">
              <el-tag
                v-for="(v, k) in result.remote.tools" :key="k" size="small" effect="plain" class="tag"
                :type="v ? 'success' : (['docker', 'unzip', 'tar', 'sha256sum', 'curl'].includes(String(k)) ? 'danger' : 'info')"
              >{{ k }}: {{ v ? '可用' : '缺失' }}</el-tag>
            </div>
            <template v-if="result.remote.pathEntries.length">
              <div class="block-title">部署目录现有内容（前 {{ Math.min(result.remote.pathEntries.length, 12) }} 项）</div>
              <div class="tags">
                <el-tag v-for="e in result.remote.pathEntries.slice(0, 12)" :key="e" size="small" type="info" effect="plain" class="tag mono">{{ e }}</el-tag>
              </div>
            </template>
            <template v-if="relatedContainers.length">
              <div class="block-title">同项目容器</div>
              <div class="tags">
                <el-tag v-for="c in relatedContainers" :key="c.name" size="small" effect="plain" class="tag"
                  :type="/Up .*healthy|Up \(healthy\)/.test(c.status) ? 'success' : 'info'">
                  {{ c.name }} · {{ c.status }}
                </el-tag>
              </div>
            </template>
          </template>
          <el-alert v-else type="error" :closable="false" :title="`服务器体检失败：${result.remote.error}`" />
        </el-card>

        <!-- ②.5 已有部署校验 -->
        <el-card v-if="result.plan.existing && result.plan.existing.checked" shadow="never" class="card sec">
          <template #header><div class="card-header"><span>② 已有部署校验</span>
            <el-tag size="small" :type="existingTag.type" effect="plain">{{ existingTag.text }}</el-tag>
          </div></template>
          <el-descriptions :column="1" size="small" border>
            <el-descriptions-item label="判定依据">
              <ul class="plain-list">
                <li v-for="(e, i) in result.plan.existing.evidence || []" :key="i">{{ e }}</li>
                <li v-if="!(result.plan.existing.evidence || []).length" class="dim">未发现同名容器 / 数据卷 / Compose 项目 / 部署目录内容</li>
              </ul>
            </el-descriptions-item>
            <el-descriptions-item v-if="result.plan.existing.aiSummary" label="AI 判断">
              {{ result.plan.existing.aiSummary }}
            </el-descriptions-item>
            <el-descriptions-item v-if="(result.plan.existing.mustPreserve || []).length" label="必须原样保留">
              <ul class="plain-list">
                <li v-for="(m, i) in result.plan.existing.mustPreserve" :key="i">{{ m }}</li>
              </ul>
            </el-descriptions-item>
            <el-descriptions-item v-if="(result.plan.migrationPlan || []).length" label="接管步骤">
              <ol class="plain-list">
                <li v-for="(m, i) in result.plan.migrationPlan" :key="i">{{ m }}</li>
              </ol>
            </el-descriptions-item>
          </el-descriptions>
        </el-card>

        <!-- ③ AI 方案 -->
        <el-card shadow="never" class="card sec">
          <template #header><div class="card-header"><span>③ 部署方案</span>
            <el-tag size="small" :type="deploymentBlocked ? 'warning' : (result.plan.readyToDeploy ? 'success' : 'danger')" effect="plain">
              {{ writeError ? '部署文件未全部写入' : (refreshError ? '写入后的部署条件尚未确认' : (result.plan.readyToDeploy ? '具备部署条件' : `暂不具备部署条件（${result.plan.blockers.length} 项）`)) }}
            </el-tag>
          </div></template>
          <el-alert v-if="!result.plan.readyToDeploy" type="warning" :closable="false" class="mb8">
            <template #title>
              <div>发布前必须先处理：</div>
              <ul class="plain-list">
                <li v-for="(b, i) in result.plan.blockers" :key="i">{{ b }}</li>
              </ul>
            </template>
          </el-alert>
          <el-descriptions :column="2" size="small" border>
            <el-descriptions-item label="方案结论" :span="2">{{ result.plan.summary }}</el-descriptions-item>
            <el-descriptions-item label="部署形态">
              <el-tag size="small" :type="result.plan.deployMode === 'script' ? 'warning' : 'primary'" effect="plain">
                {{ result.plan.deployMode === 'script' ? '脚本部署（发布包 + upgrade.sh）' : deployModeLabel(result.plan) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="版本策略">
              {{ result.plan.version.strategy === 'manual' ? `手动 ${result.plan.version.manual || '（未填）'}` : '自动识别项目版本文件' }}
            </el-descriptions-item>
            <el-descriptions-item label="打包命令">
              <span class="mono">{{ result.plan.scriptMode.packageCommand || '—' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="产物目录 / 升级脚本">
              <span class="mono">{{ result.plan.scriptMode.artifactDir }} / {{ result.plan.scriptMode.upgradeScript }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="健康检查">
              <span class="mono">{{ result.plan.health.enabled ? result.plan.health.url : '未配置（按容器存活判断）' }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="数据库备份">
              <span v-if="result.plan.db.enabled" class="mono">
                {{ result.plan.db.type }} · {{ result.plan.db.container }} / {{ result.plan.db.name }}
              </span>
              <span v-else class="dim">不备份（未识别到数据库或信息不全）</span>
            </el-descriptions-item>
            <el-descriptions-item label="形态理由" :span="2">{{ result.plan.deployModeReason }}</el-descriptions-item>
          </el-descriptions>

          <div class="block-title">数据同步结论</div>
          <el-alert :type="result.plan.dataSync.needed ? 'warning' : 'success'" :closable="false" show-icon>
            <template #title>
              {{ result.plan.dataSync.needed
                ? '需要把本地数据推送到服务器'
                : (result.plan.dataSync.mode === 'share' ? '不需要推送本地数据（只需跨版本共享）' : '不需要从本地向服务器同步数据') }}：{{ result.plan.dataSync.reason }}
            </template>
          </el-alert>
          <el-table v-if="result.plan.dataSync.items.length" :data="result.plan.dataSync.items" size="small" class="mt8">
            <el-table-column prop="localDir" label="本地目录" min-width="140">
              <template #default="{ row }"><span class="mono">{{ row.localDir }}</span></template>
            </el-table-column>
            <el-table-column prop="remoteDir" label="服务器去向" min-width="140">
              <template #default="{ row }"><span class="mono">{{ row.remoteDir }}</span></template>
            </el-table-column>
            <el-table-column label="性质" width="110">
              <template #default="{ row }">
                <el-tag size="small" effect="plain" :type="row.kind === 'share' ? 'info' : 'warning'">
                  {{ row.kind === 'share' ? '跨版本共享' : (['upload', 'upload?'].includes(row.kind) ? '待确认推送' : '用途待确认') }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="note" label="说明" min-width="200" show-overflow-tooltip />
          </el-table>

          <template v-if="result.plan.prerequisites.length">
            <div class="block-title">首次部署前置条件</div>
            <ul class="plain-list">
              <li v-for="(p, i) in result.plan.prerequisites" :key="i">
                <b>{{ p.item }}</b> —— {{ p.why }}；<span class="dim">{{ p.how }}</span>
              </li>
            </ul>
          </template>
          <template v-if="result.plan.risks.length">
            <div class="block-title">风险与注意事项</div>
            <ul class="plain-list">
              <li v-for="(r, i) in result.plan.risks" :key="i">{{ r }}</li>
            </ul>
          </template>
        </el-card>

        <!-- ④ 生成部署文件 -->
        <el-card shadow="never" class="card sec">
          <template #header><div class="card-header"><span>④ 生成 / 改写部署文件</span>
            <div>
              <el-button text size="small" type="primary" :loading="writing" :disabled="busy || !selectedFiles.length || !projectId" @click="writeSelected">
                写入所选（{{ selectedFiles.length }}）
              </el-button>
              <el-button text size="small" type="primary" :disabled="busy || !writableFiles.length || !projectId" @click="writeAll">
                写入全部（{{ writableFiles.length }}）
              </el-button>
            </div>
          </div></template>
          <el-alert v-if="generationStatus" class="mb8" :type="generationStatus.type" :closable="false" :title="generationStatus.text" />
          <el-alert v-if="generationValidation" class="mb8" :type="generationValidation.ok ? 'success' : 'error'" :closable="false">
            <template #title>
              <div>{{ generationValidation.ok ? '静态校验通过，仍需实际构建与发布验证' : '静态校验未通过，本次返回的文件不可写入' }}</div>
              <ul v-if="generationValidation.errors.length || generationValidation.warnings.length" class="plain-list">
                <li v-for="(error, i) in generationValidation.errors" :key="`error-${i}`">{{ error }}</li>
                <li v-for="(warning, i) in generationValidation.warnings" :key="`warning-${i}`">注意：{{ warning }}</li>
              </ul>
            </template>
          </el-alert>
          <el-alert v-if="refreshError" class="mb8" type="error" :closable="false" :title="refreshError" />
          <el-alert v-if="writeError" class="mb8" type="error" :closable="false" :title="writeError" />
          <el-table :data="result.plan.files" size="small" @selection-change="(rows) => (selectedFiles = rows)">
            <el-table-column type="selection" width="42" :selectable="(row) => !busy && isWritable(row)" />
            <el-table-column prop="path" label="文件" min-width="220">
              <template #default="{ row }">
                <span class="mono">{{ row.path }}</span>
                <el-tag size="small" class="tag" :type="row.action === 'update' ? 'warning' : 'success'" effect="plain">
                  {{ row.action === 'update' ? '改写' : '新建' }}
                </el-tag>
                <el-tag v-if="isWritten(row)" size="small" type="info" effect="plain" class="tag">已写入</el-tag>
                <el-tag v-else-if="!row.content" size="small" type="info" effect="plain" class="tag">待生成</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="purpose" label="用途 / 问题" min-width="220" show-overflow-tooltip />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button v-if="row.content" text size="small" type="primary" @click="preview(row)">预览</el-button>
                <el-button
                  v-else text size="small" type="primary" :loading="generatingPath === row.path"
                  :disabled="busy"
                  @click="generateOne(row)"
                >生成内容</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-alert v-if="written.length" class="mt8" type="success" :closable="false">
            <template #title>
              已写入：<span v-for="(w, i) in written" :key="`${w.path}-${i}`">{{ i ? '、' : '' }}{{ w.path }}（{{ w.action === 'updated' ? '覆盖，已备份 ' + w.backup : '新建' }}）</span>
            </template>
          </el-alert>
        </el-card>
      </template>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :loading="applying" :disabled="!result || !projectId || busy || deploymentBlocked" @click="apply">套用到部署配置</el-button>
    </template>

    <el-dialog v-model="previewVisible" :title="previewFile?.path || '文件预览'" width="780px" top="6vh" append-to-body>
      <pre class="file-preview">{{ previewFile?.content || '' }}</pre>
    </el-dialog>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { toPlain } from '../../utils/ipc'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  form: { type: Object, required: true },
  activeTargetId: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'applied'])

const projectId = computed(() => props.form.id || '')
const activeTarget = computed(() => props.form.targets?.find((target) => target.id === props.activeTargetId)
  || props.form.targets?.[0] || props.form)
const running = ref(false)
const stepText = ref('')
const result = ref(null)
const written = ref([])
const writtenContents = ref({})
const selectedFiles = ref([])
const previewVisible = ref(false)
const previewFile = ref(null)
const generatingPath = ref('')
const generatingAll = ref(false)
const writing = ref(false)
const applying = ref(false)
const generationStatus = ref(null)
const generationValidation = ref(null)
const refreshError = ref('')
const writeFailures = ref({})
const writeError = computed(() => {
  const failures = Object.entries(writeFailures.value)
  return failures.length ? `部署文件写入失败：${failures.map(([file, error]) => `${file}（${error}）`).join('、')}。请处理后重新写入或重新体检，当前方案不能套用。` : ''
})
const deploymentBlocked = computed(() => !!refreshError.value || !!writeError.value)
const busy = computed(() => running.value || generatingAll.value || !!generatingPath.value || writing.value || applying.value)
let revision = 0
const captureContext = () => ({ revision, projectId: projectId.value, targetId: props.activeTargetId })
const isCurrent = (context) => props.modelValue && context.revision === revision
  && context.projectId === projectId.value && context.targetId === props.activeTargetId

/** 已有部署判定的标签样式（managed/legacy/content/empty/none/unknown） */
const existingTag = computed(() => {
  const kind = (result.value && result.value.plan && result.value.plan.existing && result.value.plan.existing.kind) || 'unknown'
  return {
    managed: { type: 'success', text: '已由本工具部署（可直接发新版本）' },
    legacy: { type: 'danger', text: '已存在旧部署（首次发布需先接管）' },
    content: { type: 'warning', text: '部署目录已有内容（需确认迁移）' },
    empty: { type: 'info', text: '部署目录为空（可全新部署）' },
    none: { type: 'success', text: '服务器上尚无该服务（全新部署）' },
    unknown: { type: 'info', text: '未完成校验' },
  }[kind] || { type: 'info', text: kind }
})

const writtenPaths = computed(() => new Set(written.value.map((w) => w.path)))
const isWritten = (row) => writtenPaths.value.has(row.path) && writtenContents.value[row.path] === row.content
const isWritable = (row) => typeof row.content === 'string' && !!row.content.trim() && !row.truncated && row.validation?.ok !== false && !isWritten(row)
const writableFiles = computed(() => (result.value?.plan?.files || []).filter(isWritable))
const local = computed(() => (result.value && result.value.local) || {})
const remoteReady = computed(() => {
  const r = result.value && result.value.remote
  if (!r || !r.ok) return false
  const t = r.tools || {}
  const need = ['docker', 'unzip', 'tar', 'sha256sum']
  return need.every((k) => t[k] !== false)
})
/** 与当前项目名相关的容器（同名或同前缀），用于识别服务器上的既有部署 */
const relatedContainers = computed(() => {
  const r = result.value && result.value.remote
  if (!r || !r.ok) return []
  const key = String(props.form.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!key) return []
  return (r.containers || []).filter((c) => String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(key)).slice(0, 8)
})

/** 缺失的部署文件清单（方案产出） */
const planMissingFiles = computed(() => (result.value && result.value.plan && result.value.plan.missingFiles) || [])

watch(() => [props.modelValue, props.form.id, props.form.localPath, props.activeTargetId,
  activeTarget.value.remotePath, activeTarget.value.serverId, activeTarget.value.server?.host,
  activeTarget.value.server?.port, activeTarget.value.server?.username], () => {
  revision += 1
  result.value = null
  written.value = []
  writtenContents.value = {}
  selectedFiles.value = []
  previewVisible.value = false
  previewFile.value = null
  running.value = false
  generatingPath.value = ''
  generatingAll.value = false
  writing.value = false
  applying.value = false
  generationStatus.value = null
  generationValidation.value = null
  refreshError.value = ''
  writeFailures.value = {}
  stepText.value = ''
}, { flush: 'sync' })
onUnmounted(() => { revision += 1 })

function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function deployModeLabel(plan) {
  return plan.deployMode === 'script' ? '脚本部署' : (plan.executionMode === 'auto' ? '自动 Compose 发布' : 'Docker 编排')
}

async function run() {
  if (busy.value) return
  if (!projectId.value) return ElMessage.warning('请先保存项目')
  revision += 1
  const context = captureContext()
  running.value = true
  written.value = []
  writtenContents.value = {}
  selectedFiles.value = []
  result.value = null
  generationStatus.value = null
  generationValidation.value = null
  refreshError.value = ''
  writeFailures.value = {}
  previewVisible.value = false
  previewFile.value = null
  try {
    stepText.value = '正在体检本地项目、校验服务器并生成部署方案…'
    const d = await window.gitReport.deployAiDiagnose(context.projectId, context.targetId)
    if (!isCurrent(context)) return
    if (!d || !d.ok) throw new Error(d?.error || '体检失败')
    result.value = d
    stepText.value = ''
  } catch (e) {
    if (!isCurrent(context)) return
    ElMessage.error(e.message || String(e))
    stepText.value = ''
  } finally {
    if (isCurrent(context)) running.value = false
  }
}

function setValidation(validation) {
  generationValidation.value = validation ? {
    ok: validation.ok === true,
    errors: Array.isArray(validation.errors) ? validation.errors : [],
    warnings: Array.isArray(validation.warnings) ? validation.warnings : [],
  } : null
}

function failGeneration(error, validation) {
  setValidation(validation?.ok === false ? validation : { ok: false, errors: [error], warnings: validation?.warnings || [] })
  generationStatus.value = { type: 'error', text: error }
  ElMessage.error(error)
}

/** 整套文件共用部署方案与项目证据，校验通过后才替换预览内容。 */
async function generateAll() {
  if (busy.value || !projectId.value || !result.value?.plan || local.value.exists !== true) return
  const context = captureContext()
  const plan = toPlain(result.value.plan)
  // 新一轮生成只展示本轮结果，避免失败后把旧内容误当成本轮可写文件。
  result.value.plan.files = result.value.plan.files.map((file) => ({ ...file, content: '', validation: undefined, truncated: false }))
  selectedFiles.value = []
  previewVisible.value = false
  previewFile.value = null
  generatingAll.value = true
  generationValidation.value = null
  generationStatus.value = { type: 'info', text: '正在根据构建与启动代码生成整套部署文件，并检查文件之间的引用…' }
  try {
    const r = await window.gitReport.deployAiGenerateFiles(context.projectId, context.targetId, plan)
    if (!isCurrent(context)) return
    setValidation(r?.validation)
    if (!r?.ok || r.truncated || r.validation?.ok !== true || !Array.isArray(r.files) || !r.files.length
      || r.files.some((file) => !file.path || typeof file.content !== 'string' || !file.content.trim() || file.truncated || file.validation?.ok === false)) {
      const error = r?.error || (r?.truncated ? '生成内容被截断，请重新生成' : '生成文件未通过静态校验，请处理问题后重新生成')
      failGeneration(error, r?.validation)
      return
    }
    result.value.plan.files = r.files
    selectedFiles.value = []
    previewVisible.value = false
    previewFile.value = null
    generationStatus.value = { type: 'success', text: `已生成 ${r.files.length} 个部署文件，请预览后写入，再套用配置并发布。` }
  } catch (e) {
    if (!isCurrent(context)) return
    failGeneration(e.message || String(e))
  } finally {
    if (isCurrent(context)) generatingAll.value = false
  }
}

function preview(row) {
  previewFile.value = row
  previewVisible.value = true
}

/** 单独生成某个部署文件的内容（脚本类文件走纯文本输出，避免 JSON 转义与截断） */
async function generateOne(row) {
  if (busy.value || !projectId.value || !result.value?.plan) return
  const context = captureContext()
  const plan = toPlain(result.value.plan)
  const siblings = toPlain(result.value.plan.files)
  row.content = ''
  row.validation = undefined
  row.truncated = false
  selectedFiles.value = []
  previewVisible.value = false
  previewFile.value = null
  generatingPath.value = row.path
  generationValidation.value = null
  generationStatus.value = { type: 'info', text: `正在根据当前部署方案生成 ${row.path}…` }
  try {
    const r = await window.gitReport.deployAiGenerateFile(context.projectId, context.targetId, {
      path: row.path, action: row.action, purpose: row.purpose,
      plan, siblings,
    })
    if (!isCurrent(context)) return
    setValidation(r?.validation)
    if (!r?.ok || r.truncated || r.validation?.ok !== true || typeof r.content !== 'string' || !r.content.trim()) {
      const error = r?.error || (r?.truncated ? `${row.path} 生成内容被截断，请重新生成` : '生成失败或静态校验未通过')
      failGeneration(error, r?.validation)
      return
    }
    row.content = r.content
    row.validation = r.validation
    generationStatus.value = { type: 'success', text: `${row.path} 已生成，请预览后写入；仍需实际构建与发布验证。` }
    preview(row)
  } catch (e) {
    if (!isCurrent(context)) return
    failGeneration(e.message || String(e))
  } finally {
    if (isCurrent(context)) generatingPath.value = ''
  }
}

async function writeSelected() {
  await writeFiles(selectedFiles.value)
}

async function writeAll() {
  await writeFiles(writableFiles.value)
}

async function writeFiles(rows) {
  if (busy.value || !projectId.value || !result.value?.plan) return
  const context = captureContext()
  const files = rows.filter(isWritable).map((f) => ({ path: f.path, content: f.content, action: f.action }))
  const plan = toPlain(result.value.plan)
  if (!files.length) return
  writing.value = true
  try {
    try {
      await ElMessageBox.confirm(
        `将写入 ${files.length} 个文件到本地项目目录；已存在的文件会先备份为 *.bak-<时间戳>。是否继续？`,
        '生成部署文件',
        { type: 'warning' },
      )
    } catch { return }
    if (!isCurrent(context)) return
    const res = await window.gitReport.deployAiWriteFiles(context.projectId, files, { targetId: context.targetId, plan })
    if (!isCurrent(context)) return
    if (res?.validation) setValidation(res.validation)
    const results = Array.isArray(res?.results) ? res.results : []
    const ok = results.filter((x) => files.some((file) => file.path === x.path) && (x.action === 'created' || x.action === 'updated'))
    const bad = files.filter((file) => !ok.some((item) => item.path === file.path)).map((file) => ({
      path: file.path, error: results.find((item) => item.path === file.path)?.error || res?.error || '未返回写入成功结果',
    }))
    written.value = [...written.value, ...ok]
    for (const file of ok) {
      const source = files.find((candidate) => candidate.path === file.path)
      if (source) writtenContents.value[file.path] = source.content
      delete writeFailures.value[file.path]
    }
    selectedFiles.value = []
    for (const b of bad) {
      writeFailures.value[b.path] = b.error
      ElMessage.error(`${b.path}：${b.error}`)
    }
    if (!ok.length) return
    ElMessage.success(`已写入 ${ok.length} 个文件，正在重新体检`)
    refreshError.value = ''
    stepText.value = '文件已写入，正在重新体检部署条件…'
    try {
      const d = await window.gitReport.deployAiDiagnose(context.projectId, context.targetId)
      if (!isCurrent(context)) return
      if (!d?.ok || !d.plan) throw new Error(d?.error || '部署条件体检未完成')
      result.value = d
      previewVisible.value = false
      previewFile.value = null
      if (d.local?.exists !== true || d.remote?.ok === false) {
        throw new Error(d.local?.risks?.[0] || d.remote?.error || '部署条件体检未完成')
      }
      generationStatus.value = writeError.value
        ? { type: 'warning', text: '已写入的文件已重新体检，仍有文件写入失败；请处理后再套用配置。' }
        : { type: 'success', text: '部署文件已写入并重新体检，请查看最新阻塞项；处理完成后套用配置并发布。' }
    } catch (e) {
      if (!isCurrent(context)) return
      refreshError.value = `文件已写入，但重新体检失败：${e.message || String(e)}。请重新体检后再套用，当前部署条件尚未确认。`
      ElMessage.error(refreshError.value)
    }
  } catch (e) {
    if (isCurrent(context)) {
      for (const file of files) writeFailures.value[file.path] = e.message || String(e)
      ElMessage.error(e.message || String(e))
    }
  } finally {
    if (isCurrent(context)) {
      writing.value = false
      stepText.value = ''
    }
  }
}

async function apply() {
  if (busy.value || !projectId.value || deploymentBlocked.value) return
  const context = captureContext()
  const plan = result.value && result.value.plan
  if (!plan) return
  applying.value = true
  try {
    try {
      await ElMessageBox.confirm(
        `将把「${deployModeLabel(plan)}」形态、脚本模式、版本策略、健康检查、数据库备份与数据同步结论写入该项目的部署配置（不会改动服务器地址与凭据）。是否继续？`,
        '套用部署方案',
        { type: 'warning' },
      )
    } catch { return }
    // Vue 响应式代理无法跨 contextBridge，先转换成普通对象再调用 IPC。
    if (!isCurrent(context)) return
    const payload = toPlain(plan)
    if (payload === plan) return ElMessage.error('方案内容无法序列化，请重新体检后再套用')
    const r = await window.gitReport.deployAiApply(context.projectId, context.targetId, payload)
    if (!isCurrent(context)) return
    if (!r || !r.ok) return ElMessage.error((r && r.error) || '套用失败')
    ElMessage.success('部署方案已写入配置，可回到部署面板执行发布')
    emit('applied')
  } catch (e) {
    if (!isCurrent(context)) return
    return ElMessage.error(`套用失败：${(e && e.message) || String(e)}`)
  } finally {
    if (isCurrent(context)) applying.value = false
  }
}
</script>

<style scoped>
.ai-deploy { display: flex; flex-direction: column; gap: 12px; max-height: 74vh; overflow: auto; padding-right: 4px; }
/* flex 子项默认 flex-shrink: 1：内容超过 74vh 时浏览器会先压缩各区块，
   把说明与卡片压成一条（这里要的是整体滚动）。逐个 pin 住，不参与压缩。 */
.ai-deploy > * { flex-shrink: 0; }
/* 操作栏吸顶：往下滚看结论时，「重新体检」与「结论来源」始终可见。
   背景取对话框底色，否则滚动时下层内容会透出来。 */
.ops {
  display: flex;
  align-items: center;
  gap: 12px;
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 0;
  background: var(--surface);
}
.ops .spacer { flex: 1; }
.warn-text { color: var(--el-color-warning); font-size: 12px; }
.ai-warn { font-size: 12px; color: var(--el-color-warning); }
.sec { border: 1px solid var(--el-border-color-lighter); }
.block-title { margin: 12px 0 8px; font-size: 12px; font-weight: 600; color: var(--brand-text-sub); }
.tag { margin: 0 8px 4px 0; }
.dim { color: var(--brand-text-sub); font-size: 12px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.mt8 { margin-top: 8px; }
.mb8 { margin-bottom: 8px; }
.plain-list { margin: 4px 0 0; padding-left: 18px; font-size: 12px; line-height: 1.8; }
.file-preview { max-height: 60vh; overflow: auto; background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 6px; font-size: 12px; }
</style>
