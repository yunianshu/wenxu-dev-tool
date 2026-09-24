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
          首次接入部署前的体检：校验项目是否具备部署条件 → 结合 AI 生成缺失的部署文件 → 判断是否需要同步数据。
          结论可一键套用到部署配置；生成文件仅限部署相关文件，且覆盖前自动备份原文件。
        </template>
      </el-alert>

      <div class="ops">
        <el-button type="primary" :loading="running" :disabled="!projectId" @click="run">
          {{ running ? '体检中…' : (result ? '重新体检' : '开始体检') }}
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
            <el-tag size="small" :type="local.ok ? 'success' : 'danger'" effect="plain">
              {{ local.ok ? '目录可读' : '目录不可用' }}
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
            <el-tag v-for="f in result.planMissingFiles" :key="f.path" size="small" type="danger" effect="plain" class="tag">
              缺 {{ f.path }}
            </el-tag>
            <span v-if="!result.local.deployFiles.present.length && !result.planMissingFiles.length" class="dim">无</span>
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
            <el-tag size="small" :type="result.plan.readyToDeploy ? 'success' : 'danger'" effect="plain">
              {{ result.plan.readyToDeploy ? '具备部署条件' : `暂不具备部署条件（${result.plan.blockers.length} 项）` }}
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
                {{ result.plan.deployMode === 'script' ? '脚本部署（发布包 + upgrade.sh）' : 'Docker 编排' }}
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
        <el-card v-if="result.plan.files.length || written.length" shadow="never" class="card sec">
          <template #header><div class="card-header"><span>④ 生成 / 改写部署文件</span>
            <el-button text size="small" type="primary" :disabled="!selectedFiles.length || !projectId" @click="writeSelected">
              写入所选（{{ selectedFiles.length }}）
            </el-button>
          </div></template>
          <el-table :data="result.plan.files" size="small" @selection-change="(rows) => (selectedFiles = rows)">
            <el-table-column type="selection" width="42" :selectable="(row) => !!row.content && !writtenPaths.has(row.path)" />
            <el-table-column prop="path" label="文件" min-width="220">
              <template #default="{ row }">
                <span class="mono">{{ row.path }}</span>
                <el-tag size="small" class="tag" :type="row.action === 'update' ? 'warning' : 'success'" effect="plain">
                  {{ row.action === 'update' ? '改写' : '新建' }}
                </el-tag>
                <el-tag v-if="writtenPaths.has(row.path)" size="small" type="info" effect="plain" class="tag">已写入</el-tag>
                <el-tag v-else-if="!row.content" size="small" type="info" effect="plain" class="tag">待生成</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="purpose" label="用途 / 问题" min-width="220" show-overflow-tooltip />
            <el-table-column label="操作" width="150">
              <template #default="{ row }">
                <el-button v-if="row.content" text size="small" type="primary" @click="preview(row)">预览</el-button>
                <el-button
                  v-else text size="small" type="primary" :loading="generatingPath === row.path"
                  @click="generateOne(row)"
                >生成内容</el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-alert v-if="written.length" class="mt8" type="success" :closable="false">
            <template #title>
              已写入：<span v-for="(w, i) in written" :key="w.path">{{ i ? '、' : '' }}{{ w.path }}（{{ w.action === 'updated' ? '覆盖，已备份 ' + w.backup : '新建' }}）</span>
            </template>
          </el-alert>
        </el-card>
      </template>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" :disabled="!result || !projectId" @click="apply">套用到部署配置</el-button>
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
const running = ref(false)
const stepText = ref('')
const result = ref(null)
const written = ref([])
const selectedFiles = ref([])
const previewVisible = ref(false)
const previewFile = ref(null)
const generatingPath = ref('')
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

watch(() => [props.modelValue, props.form.id, props.form.localPath, props.activeTargetId], () => {
  revision += 1
  result.value = null
  written.value = []
  selectedFiles.value = []
  previewVisible.value = false
  previewFile.value = null
  running.value = false
  generatingPath.value = ''
  stepText.value = ''
}, { flush: 'sync' })
onUnmounted(() => { revision += 1 })

function fmtSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function run() {
  if (!projectId.value) return ElMessage.warning('请先保存项目')
  revision += 1
  const context = captureContext()
  running.value = true
  written.value = []
  selectedFiles.value = []
  result.value = null
  try {
    stepText.value = '正在体检本地项目、校验服务器并生成部署方案…'
    const d = await window.gitReport.deployAiDiagnose(context.projectId, context.targetId)
    if (!isCurrent(context)) return
    if (!d.ok) throw new Error(d.error)
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

function preview(row) {
  previewFile.value = row
  previewVisible.value = true
}

/** 单独生成某个部署文件的内容（脚本类文件走纯文本输出，避免 JSON 转义与截断） */
async function generateOne(row) {
  const context = captureContext()
  generatingPath.value = row.path
  try {
    const r = await window.gitReport.deployAiGenerateFile(context.projectId, context.targetId, {
      path: row.path, action: row.action, purpose: row.purpose,
    })
    if (!isCurrent(context)) return
    if (!r || !r.ok) {
      ElMessage.error((r && r.error) || '生成失败')
      return
    }
    row.content = r.content
    if (r.truncated) ElMessage.warning(`${row.path} 可能被长度上限截断，请预览确认后再写入`)
    preview(row)
  } catch (e) {
    if (!isCurrent(context)) return
    ElMessage.error(e.message || String(e))
  } finally {
    if (isCurrent(context)) generatingPath.value = ''
  }
}

async function writeSelected() {
  const context = captureContext()
  const files = selectedFiles.value.map((f) => ({ path: f.path, content: f.content, action: f.action }))
  if (!files.length) return
  try {
    await ElMessageBox.confirm(
      `将写入 ${files.length} 个文件到本地项目目录；已存在的文件会先备份为 *.bak-<时间戳>。是否继续？`,
      '生成部署文件',
      { type: 'warning' },
    )
  } catch { return }
  if (!isCurrent(context)) return
  let res
  try {
    res = await window.gitReport.deployAiWriteFiles(context.projectId, files)
  } catch (e) {
    if (isCurrent(context)) ElMessage.error(e.message || String(e))
    return
  }
  if (!isCurrent(context)) return
  if (!res.ok) return ElMessage.error(res.error || '写入失败')
  const ok = (res.results || []).filter((x) => x.action === 'created' || x.action === 'updated')
  const bad = (res.results || []).filter((x) => x.action !== 'created' && x.action !== 'updated')
  written.value = [...written.value, ...ok]
  if (ok.length) ElMessage.success(`已写入 ${ok.length} 个文件`)
  for (const b of bad) ElMessage.error(`${b.path}：${b.error}`)
}

async function apply() {
  const context = captureContext()
  const plan = result.value && result.value.plan
  if (!plan) return
  try {
    await ElMessageBox.confirm(
      `将把「${plan.deployMode === 'script' ? '脚本部署' : 'Docker 编排'}」形态、脚本模式、版本策略、健康检查、数据库备份与数据同步结论写入该项目的部署配置（不会改动服务器地址与凭据）。是否继续？`,
      '套用部署方案',
      { type: 'warning' },
    )
  } catch { return }
  // 必须转成普通对象再传：result 是 Vue 的 ref，result.plan 是响应式代理，
  // 而代理无法跨 contextBridge（preload 里的 toPlain 根本收不到），ipcRenderer.invoke
  // 会直接抛「An object could not be cloned.」——表现为点确定毫无反应
  if (!isCurrent(context)) return
  const payload = toPlain(plan)
  if (payload === plan) return ElMessage.error('方案内容无法序列化，请重新体检后再套用')
  try {
    const r = await window.gitReport.deployAiApply(context.projectId, context.targetId, payload)
    if (!isCurrent(context)) return
    if (!r || !r.ok) return ElMessage.error((r && r.error) || '套用失败')
  } catch (e) {
    if (!isCurrent(context)) return
    return ElMessage.error(`套用失败：${(e && e.message) || String(e)}`)
  }
  ElMessage.success('部署方案已写入配置')
  emit('applied')
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
