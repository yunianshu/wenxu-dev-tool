<template>
  <el-drawer
    :model-value="modelValue"
    title="部署设置"
    size="600px"
    class="deploy-config-drawer"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="deploy-config-scroll">
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>基本信息</span>
            <el-button text size="small" type="primary" @click="openCopyDialog"><el-icon><CopyDocument /></el-icon>从其他项目复制</el-button>
          </div>
        </template>
        <div class="f-row">
          <span class="f-label">项目名称</span>
          <el-input v-model="form.name" placeholder="如 myapp" style="flex: 1" />
        </div>
        <div class="f-row">
          <span class="f-label">本地目录</span>
          <el-input v-model="form.localPath" placeholder="D:\projects\myapp" style="flex: 1" />
          <el-button @click="browseLocal"><el-icon><Folder /></el-icon></el-button>
        </div>
        <div class="f-row">
          <span class="f-label">部署形态</span>
          <el-radio-group v-model="form.deployMode" size="small">
            <el-radio-button value="auto">自动发布</el-radio-button>
            <el-radio-button value="docker">Docker Compose</el-radio-button>
            <el-radio-button value="script">脚本部署</el-radio-button>
          </el-radio-group>
        </div>
        <el-alert v-if="form.deployMode === 'auto'" title="自动识别项目并在服务器构建，缺少部署文件时使用已配置 AI；无需配置打包命令和目录。" type="info" :closable="false" />
        <div v-if="form.deployMode === 'auto'" class="f-row">
          <span class="f-label">服务端口</span><el-input-number v-model="form.autoDeploy.port" :min="0" :max="65535" /><span class="f-mini">0 为该项目自动分配</span>
        </div>
        <div v-if="form.deployMode === 'docker'" class="f-row">
          <span class="f-label">Compose</span>
          <el-input v-model="form.composeFile" placeholder="docker-compose.yml（支持 compose.yaml 等常见命名自动回退）" style="flex: 1" />
        </div>
        <template v-else-if="form.deployMode === 'script'">
          <div class="f-row">
            <span class="f-label">产物目录</span>
            <el-input v-model="form.scriptMode.artifactDir" placeholder="release" style="width: 200px" />
            <span class="f-mini">相对项目根，存放 tar.gz / zip 发布包</span>
          </div>
          <div class="f-row">
            <span class="f-label">升级脚本</span>
            <el-input v-model="form.scriptMode.upgradeScript" placeholder="upgrade.sh" style="width: 200px" />
            <span class="f-mini">发布包顶层目录内的升级入口</span>
          </div>
          <div class="f-row">
            <span class="f-label">打包命令</span>
            <el-input v-model="form.scriptMode.packageCommand" placeholder="bash package.sh（留空不自动打包）" style="flex: 1; font-family: monospace" />
            <el-input-number v-model="form.scriptMode.packageTimeoutSec" :min="30" :max="3600" controls-position="right" style="width: 110px" />
            <span class="f-mini">秒超时</span>
          </div>
          <div class="f-row check-row">
            <el-checkbox v-model="form.scriptMode.autoBumpVersion">打包前自动同步项目版本号</el-checkbox>
            <el-checkbox v-model="form.scriptMode.autoReleaseNotes">缺失发布说明时自动生成初稿</el-checkbox>
          </div>
                    <div class="f-row check-row">
            <el-checkbox v-model="form.scriptMode.bootstrapJava">缺 Java 17 时自动安装</el-checkbox>
            <el-checkbox v-model="form.scriptMode.bootstrapPgdump">缺 pg_dump 时自动安装</el-checkbox>
          </div>
                            </template>
        <div class="f-row">
          <span class="f-label">版本号</span>
          <el-radio-group v-model="form.version.strategy" size="small">
            <el-radio-button value="auto">自动识别</el-radio-button>
            <el-radio-button value="manual">手动指定</el-radio-button>
          </el-radio-group>
          <el-input
            v-if="form.version.strategy === 'manual'"
            v-model="form.version.manual"
            placeholder="如 1.2.3"
            style="width: 140px"
          />
          <el-tag v-else-if="detected.version" type="success" effect="plain" size="small">
            {{ detected.version }}（{{ detected.source }}）
          </el-tag>
          <el-tag v-else type="info" effect="plain" size="small">未识别到版本号</el-tag>
        </div>
              </el-card>

      <!-- 部署目标（多环境） -->
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header">
            <span>部署目标（多环境）</span>
            <span class="target-ops">
              <el-button text size="small" type="primary" @click="addTarget"><el-icon><Plus /></el-icon>新增环境</el-button>
              <el-button text size="small" :disabled="!activeTarget" @click="renameTarget">重命名</el-button>
              <el-button text size="small" type="danger" :disabled="form.targets.length <= 1" @click="removeTarget">删除</el-button>
            </span>
          </div>
        </template>
        <div class="target-row">
          <el-select :model-value="activeTargetId" style="width: 220px" placeholder="选择部署目标" @update:model-value="emit('update:activeTargetId', $event)">
            <el-option v-for="t in form.targets" :key="t.id" :value="t.id" :label="t.name || '未命名环境'" />
          </el-select>
          <span v-if="activeTarget" class="target-host mono">
            {{ activeTarget.server.host || '未配置主机' }} → {{ activeTarget.remotePath || '未配置部署目录' }}
          </span>
        </div>
              </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header"><span>服务器（当前目标）</span></div>
        </template>
        <template v-if="activeTarget">
          <div class="f-row">
            <span class="f-label">部署服务器</span>
            <el-select :model-value="activeTarget.serverId" placeholder="选择服务器" clearable style="flex: 1" @change="selectServer">
              <el-option v-for="server in servers" :key="server.id" :value="server.id" :label="`${server.name} · ${server.host}`" />
            </el-select>
            <el-button @click="emit('manage-servers')">服务器管理</el-button>
          </div>
          <p class="f-mini selected-server" :data-host="activeTarget.server.host">{{ activeTarget.server.host ? `${activeTarget.server.username}@${activeTarget.server.host}:${activeTarget.server.port}（登录信息统一在服务器管理维护）` : '请先添加或选择服务器' }}</p>
          <div class="f-row">
            <span class="f-label">部署目录</span>
            <el-input v-model="activeTarget.remotePath" :readonly="form.deployMode === 'auto'" :placeholder="form.deployMode === 'auto' ? '发布时为此项目分配独立安装目录' : '/opt/apps/myapp'" style="flex: 1" />
          </div>
        </template>
              </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header"><span>数据库备份（当前目标）</span></div>
        </template>
        <template v-if="activeTarget">
          <div class="f-row check-row">
            <el-checkbox v-model="activeTarget.db.enabled">发布前备份数据库</el-checkbox>
          </div>
          <div class="f-row">
            <el-select v-model="activeTarget.db.type" style="width: 130px" :disabled="!activeTarget.db.enabled">
              <el-option value="postgres" label="PostgreSQL" />
              <el-option value="mysql" label="MySQL" />
            </el-select>
            <el-input v-model="activeTarget.db.container" placeholder="数据库容器名" style="width: 160px" :disabled="!activeTarget.db.enabled" />
            <el-input v-model="activeTarget.db.name" placeholder="库名" style="width: 140px" :disabled="!activeTarget.db.enabled" />
            <el-input v-model="activeTarget.db.user" placeholder="用户(可选)" style="width: 130px" :disabled="!activeTarget.db.enabled" />
          </div>
        </template>
              </el-card>

      <el-card shadow="never" class="card">
        <template #header><div class="card-header"><span>部署选项</span></div></template>
        <div class="f-row check-row">
          <el-checkbox v-model="form.deploy.backupCode">发布前备份代码</el-checkbox>
          <el-checkbox v-model="form.deploy.autoRollback">失败自动回滚</el-checkbox>
          <el-checkbox v-model="form.deploy.deleteUploadAfterSuccess">成功后删除上传包</el-checkbox>
        </div>
        <div class="f-row">
          <span class="f-label">保留数量</span>
          <span class="f-mini">最近</span>
          <el-input-number v-model="form.deploy.keepReleases" :min="1" :max="50" controls-position="right" style="width: 90px" />
          <span class="f-mini">个版本 /</span>
          <el-input-number v-model="form.deploy.keepBackups" :min="1" :max="50" controls-position="right" style="width: 90px" />
          <span class="f-mini">份备份</span>
        </div>
              </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header"><span>健康检查（当前目标）</span></div>
        </template>
        <template v-if="activeTarget">
          <div class="f-row check-row">
            <el-checkbox v-model="activeTarget.health.enabled">启用 HTTP 健康检查</el-checkbox>
          </div>
          <div class="f-row">
            <span class="f-label">检查地址</span>
            <el-input
              v-model="activeTarget.health.url"
              placeholder="http://127.0.0.1:8080/actuator/health"
              style="flex: 1"
              :disabled="!activeTarget.health.enabled"
            />
          </div>
          <div class="f-row">
            <span class="f-label">超时/间隔</span>
            <el-input-number v-model="activeTarget.health.timeout" :min="10" :max="600" controls-position="right" style="width: 100px" :disabled="!activeTarget.health.enabled" />
            <span class="f-mini">秒内，每</span>
            <el-input-number v-model="activeTarget.health.interval" :min="1" :max="30" controls-position="right" style="width: 90px" :disabled="!activeTarget.health.enabled" />
            <span class="f-mini">秒探测一次</span>
          </div>
        </template>
              </el-card>

      <el-card shadow="never" class="card">
        <template #header>
          <div class="card-header"><span>数据同步（当前目标）</span></div>
        </template>
        <template v-if="activeTarget">
          <div class="f-row check-row">
            <el-checkbox v-model="activeTarget.dataSync.enabled">发布成功后同步本地数据</el-checkbox>
          </div>
          <div class="f-row">
            <span class="f-label">本地数据目录</span>
            <el-input
              v-model="activeTarget.dataSync.localDir"
              placeholder="data"
              style="width: 220px"
              :disabled="!activeTarget.dataSync.enabled"
            />
            <span class="f-mini">相对项目根</span>
          </div>
          <div class="f-row">
            <span class="f-label">服务器目标目录</span>
            <el-input
              v-model="activeTarget.dataSync.remoteDir"
              placeholder="shared/data"
              style="width: 220px"
              :disabled="!activeTarget.dataSync.enabled"
            />
            <span class="f-mini">相对部署目录</span>
          </div>
          <div class="f-row check-row" style="margin-top: 6px">
            <el-checkbox v-model="importEnabled" :disabled="!activeTarget.dataSync.enabled">同步后执行导入命令</el-checkbox>
          </div>
          <template v-if="importEnabled">
            <div class="f-row">
              <span class="f-label">导入命令</span>
              <el-input
                v-model="activeTarget.dataSync.importCommand"
                type="textarea"
                :rows="3"
                placeholder="bash {dataDir}/../deployer/import-products.sh {dataDir}"
                style="flex: 1; font-family: monospace"
              />
            </div>
            <div class="f-row">
              <span class="f-label">应用账号</span>
              <el-input v-model="activeTarget.dataSync.importUser" placeholder="应用登录用户名" style="width: 180px" />
              <!-- 直绑 dataSync.importSecret（与 SSH 密码同一模式）：留空＝保持已保存凭据，输入新值＝保存时替换。
                   不可用「闭包变量 + 可写 computed」做输入缓冲：getter 无响应式依赖，缓存永不失效，
                   el-input 每次输入后会把输入框同步回旧值，表现为无法输入且只落盘最后一个字符 -->
              <el-input
                v-model="activeTarget.dataSync.importSecret"
                type="password"
                show-password
                :placeholder="activeTarget.dataSync.importSecretConfigured ? `${activeTarget.dataSync.importSecretMasked || '••••••'}（留空保持，输入新值替换）` : '应用登录密码'"
                style="width: 220px"
                @update:model-value="activeTarget.dataSync.clearImportSecret = false"
              />
            </div>
          </template>
        </template>
              </el-card>
    </div>
    <template #footer>
      <div class="drawer-footer">
        <el-button @click="cancelEdit">取消</el-button>
        <el-button type="primary" :disabled="!form.name" @click="emit('save')"><el-icon><Check /></el-icon>保存部署设置</el-button>
      </div>
    </template>

    <!-- 从其他项目复制部署配置 -->
    <el-dialog v-model="copyDialogVisible" title="从其他项目复制部署配置" width="480px" append-to-body>
      <el-alert type="warning" :closable="false" show-icon class="copy-alert">
        仅复制服务器选择，登录信息由服务器管理统一维护，部署目录、版本、数据库和构建参数由当前项目独立配置。
        现有环境保留。当前未保存的修改将丢弃。
      </el-alert>
      <div class="f-row">
        <span class="f-label">源项目</span>
        <el-select v-model="copyFromId" placeholder="选择要复制配置的项目" style="flex: 1">
          <el-option
            v-for="p in copyableProjects"
            :key="p.id"
            :value="p.id"
            :label="`${p.name}（${(p.targets || []).length} 个环境）`"
          />
        </el-select>
      </div>
      <template #footer>
        <el-button @click="copyDialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!copyFromId" @click="confirmCopy">复制配置</el-button>
      </template>
    </el-dialog>
  </el-drawer>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { emptyTarget } from './deploy-form'

const props = defineProps({
  /** 抽屉开关（v-model） */
  modelValue: { type: Boolean, default: false },
  /** 部署表单（响应式对象，字段由本组件直接编辑） */
  form: { type: Object, required: true },
  /** 当前编辑的部署目标 id（v-model:active-target-id） */
  activeTargetId: { type: String, default: '' },
  /** 自动识别的版本号 { version, source } */
  detected: { type: Object, default: () => ({ version: '', source: '' }) },
  /** 部署项目列表（复制配置时的源项目候选） */
  projects: { type: Array, default: () => [] },
  servers: { type: Array, default: () => [] },
})
const emit = defineEmits(['update:modelValue', 'update:activeTargetId', 'save', 'reset-conn', 'copy-config', 'manage-servers'])

/** 当前编辑的部署目标（响应式：切换目标后服务器/健康检查卡随之切换） */
const activeTarget = computed(() => {
  const t = props.form.targets.find((x) => x.id === props.activeTargetId)
  return t || props.form.targets[0] || null
})

function selectServer(id) {
  const t = activeTarget.value
  if (!t) return
  t.serverId = id || ''
  t.server = { ...(props.servers.find((s) => s.id === id) || emptyTarget().server) }
  delete t.server.projects
  if (props.form.deployMode === 'auto') { t.remotePath = ''; delete t.autoSudo }
  emit('reset-conn')
}

// ─── 数据同步导入钩子：开关代理（写入 dataSync.importMode）───
const importEnabled = computed({
  get: () => activeTarget.value?.dataSync?.importMode === 'command',
  set: (v) => {
    if (activeTarget.value?.dataSync) activeTarget.value.dataSync.importMode = v ? 'command' : 'none'
  },
})

// ─── 取消回滚：抽屉直接编辑父级 form，取消必须恢复打开时的快照，否则修改残留（脏标记挂着、发布被禁用）───
let openSnapshot = null
watch(() => props.modelValue, (open) => {
  if (open) openSnapshot = JSON.parse(JSON.stringify(props.form))
})
function cancelEdit() {
  if (openSnapshot) {
    // 整体替换数组与逐键覆盖标量：保持 form 引用不变（父级依赖同一响应式对象）
    const restored = JSON.parse(JSON.stringify(openSnapshot))
    Object.keys(props.form).forEach((key) => delete props.form[key])
    Object.assign(props.form, restored)
  }
  emit('update:modelValue', false)
}

/**
 * 重置取消快照为当前表单。父级在「已落盘」的操作（如从其他项目复制）之后调用：
 * 这些改动已写入磁盘、不可撤销，若用户随后点「取消」把界面回滚到改动前，
 * 就会出现「磁盘已变、界面没变」的假象（并且后续发布会用回滚后的旧配置）。
 */
function rebaseline() {
  openSnapshot = JSON.parse(JSON.stringify(props.form))
}
function refreshServerSnapshot(servers) {
  for (const target of openSnapshot?.targets || []) {
    const server = servers.find((s) => s.id === target.serverId)
    if (server) { target.server = { ...server }; delete target.server.projects }
  }
}
defineExpose({ rebaseline, refreshServerSnapshot })

// ─── 部署目标（多环境）管理 ───
async function addTarget() {
  const t = emptyTarget()
  // 取第一个未被占用的环境编号：length+1 在删除过中间环境后会与现存环境重名
  const used = new Set(props.form.targets.map((x) => x.name))
  let n = props.form.targets.length + 1
  while (used.has(`环境 ${n}`)) n += 1
  t.name = `环境 ${n}`
  props.form.targets.push(t)
  emit('update:activeTargetId', t.id)
  emit('reset-conn')
  ElMessage.success(`已添加「${t.name}」，填写服务器信息后记得保存配置`)
}

async function renameTarget() {
  const t = activeTarget.value
  if (!t) return
  try {
    const { value } = await ElMessageBox.prompt('环境名称（如：测试 / 生产）', '重命名目标', {
      inputValue: t.name, confirmButtonText: '确定', cancelButtonText: '取消',
      inputPattern: /\S+/, inputErrorMessage: '名称不能为空',
    })
    t.name = value.trim()
  } catch { /* 取消 */ }
}

async function removeTarget() {
  const t = activeTarget.value
  if (!t || props.form.targets.length <= 1) return
  try {
    await ElMessageBox.confirm(
      `确认删除目标「${t.name}」（${t.server.host || '未配置主机'}）？仅删除该环境的配置，不影响服务器。`,
      '删除目标', { type: 'warning' },
    )
  } catch { return }
  const i = props.form.targets.indexOf(t)
  props.form.targets.splice(i, 1)
  if (props.activeTargetId === t.id) emit('update:activeTargetId', props.form.targets[Math.max(0, i - 1)].id)
  ElMessage.success('已删除目标')
}

// ─── 从其他项目复制部署配置 ───
const copyDialogVisible = ref(false)
const copyFromId = ref('')

/** 源项目候选：排除当前项目自身 */
const copyableProjects = computed(() => props.projects.filter((p) => p.id !== props.form.id))

function openCopyDialog() {
  copyFromId.value = ''
  copyDialogVisible.value = true
}

function confirmCopy() {
  if (!copyFromId.value) return
  copyDialogVisible.value = false
  emit('copy-config', copyFromId.value)
}

async function browseLocal() {
  const dir = await window.gitReport.pickDirectory()
  if (dir) props.form.localPath = dir
}
</script>

<style scoped>
.f-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.f-row:last-child { margin-bottom: 0; }
.f-label { width: 76px; flex-shrink: 0; font-size: 13px; color: #4a5160; text-align: right; }
.f-mini { font-size: 12.5px; color: var(--brand-text-sub); }
.check-row { gap: 16px; }

.target-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.target-ops { display: inline-flex; align-items: center; gap: 2px; }
</style>
