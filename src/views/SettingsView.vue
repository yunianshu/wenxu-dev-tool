<template>
  <div class="settings-page">
    <!-- 页头上提到应用顶栏（全局配置页，与项目无关） -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">设置</h1>
        <span class="topbar-context">{{ SETTING_SECTIONS.find(section => section.value === activeSection)?.label }}</span>
      </div>
    </Teleport>
    <div class="settings-nav">
      <div class="settings-sections" role="tablist" aria-label="设置分区">
        <button v-for="section in SETTING_SECTIONS" :key="section.value" type="button" role="tab" :aria-selected="activeSection === section.value" :class="{ active: activeSection === section.value }" @click="activeSection = section.value">{{ section.label }}</button>
      </div>
    </div>
    <el-alert
      v-if="state.config.ai?.keyNeedsReentry || state.config.zentao?.pwdNeedsReentry || state.config.hanprint?.pwdNeedsReentry"
      title="迁移到新桌面架构后，原 Electron 加密的凭据需要重新输入。旧密文仍保留在本机，填写新值并保存后会写入系统凭据库。"
      type="warning" :closable="false" show-icon
    />

    <!-- Git 活动源：作为工作台入口的直接落点，优先于扫描配置展示 -->
    <el-card v-show="activeSection === 'git'" shadow="never" class="card settings-repo-card">
      <template #header>
        <div class="card-header">
          <span>Git 活动源（{{ state.discoveredRepos.length }}）</span>
          <div class="header-actions">
            <span v-if="scanning" class="progress-text">{{ progressText }}</span>
            <el-button type="primary" plain :loading="scanning" @click="doScan">
              <el-icon style="margin-right: 4px"><Refresh /></el-icon>重新扫描
            </el-button>
          </div>
        </div>
      </template>
      <div class="table-wrap">
        <el-table :data="state.discoveredRepos" height="100%" size="small">
          <template #empty>
            <div class="table-empty">
              <el-icon><FolderOpened /></el-icon>
              <p>暂无活动源</p>
            </div>
          </template>
          <el-table-column label="活动源" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ row.shortName }}</template>
          </el-table-column>
          <el-table-column label="路径" min-width="260" show-overflow-tooltip>
            <template #default="{ row }">{{ row.path }}</template>
          </el-table-column>
          <el-table-column label="远程仓库" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ row.info?.remote || '-' }}</template>
          </el-table-column>
          <el-table-column label="分支" width="90">
            <template #default="{ row }">{{ row.info?.branch || '-' }}</template>
          </el-table-column>
          <el-table-column label="最近提交" min-width="190" show-overflow-tooltip>
            <template #default="{ row }">{{ row.info?.lastCommit || '-' }}</template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="!isRepoAdded(row.path)"
                text
                size="small"
                type="primary"
                :loading="isRepoConverting(row.path)"
                :disabled="isRepoConverting(row.path)"
                @click="convertRepoToProject(row)"
              >
                转换为项目
              </el-button>
              <span v-else class="repo-added-tag">已转换</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <!-- 扫描根目录 -->
    <el-card v-show="activeSection === 'git'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>Git 活动采集 · 扫描根目录</span></div>
      </template>
      <div class="root-manager">
        <div class="root-ops">
          <el-input
            v-model="newRoot"
            placeholder="输入目录路径，如 D:\AiProject，回车添加"
            clearable
            @keyup.enter="addRoot"
          />
          <el-button @click="browseRoot"><el-icon><Folder /></el-icon>浏览</el-button>
          <el-button type="primary" plain @click="addRoot">添加</el-button>
        </div>
        <div v-if="state.config.roots.length" class="root-list">
          <div class="root-list-title">已添加 {{ state.config.roots.length }} 个根目录</div>
          <el-tag
            v-for="(r, i) in state.config.roots"
            :key="r"
            closable
            type="info"
            class="root-tag"
            @close="removeRoot(i)"
          >
            <el-icon><FolderOpened /></el-icon>
            <span :title="r">{{ r }}</span>
          </el-tag>
        </div>
        <div v-else class="root-empty">尚未添加根目录，请输入路径或点击「浏览」选择文件夹</div>
      </div>
    </el-card>

    <!-- 排除目录 -->
    <el-card v-show="activeSection === 'git'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>排除目录</span></div>
      </template>
      <div class="exclude-manager">
        <div v-for="group in EXCLUDE_GROUPS" :key="group.label" class="exclude-group">
          <div class="exclude-group-label">{{ group.label }}</div>
          <div class="exclude-group-items">
            <el-checkbox
              v-for="x in group.items"
              :key="x"
              v-model="state.config.excludes"
              :value="x"
              border
              class="exclude-check"
            >{{ x }}</el-checkbox>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 本人身份 -->
    <el-card v-show="activeSection === 'identity'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>本人身份</span></div>
      </template>
      <div class="identity-manager">
        <el-tag
          v-for="(id, i) in (state.config.identities || [])"
          :key="i"
          closable
          type="success"
          class="root-tag"
          @close="removeIdentity(i)"
        >
          <el-icon><User /></el-icon>
          <span>{{ id.name || '未命名' }} &lt;{{ id.email }}&gt;</span>
        </el-tag>
        <el-input v-model="newIdName" placeholder="账号名" style="width: 130px" />
        <el-input v-model="newIdEmail" placeholder="账号邮箱" style="width: 220px" @keyup.enter="addIdentity" />
        <el-button @click="addIdentity">添加账号</el-button>
      </div>
    </el-card>

    <!-- AI 模型 -->
    <el-card v-show="activeSection === 'ai'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>AI 服务</span></div>
      </template>
      <div class="ai-manager">
        <div class="ai-form">
          <div class="ai-row">
            <span class="ai-label">服务商</span>
            <el-select v-model="provider" @change="applyPreset">
              <el-option v-for="(p, key) in AI_PRESETS" :key="key" :value="key" :label="p.label" />
            </el-select>
          </div>
          <div class="ai-row">
            <span class="ai-label">接口地址</span>
            <el-input v-model="state.config.ai.baseUrl" placeholder="http://ai.sysapp.prttech.com:18080/v1" />
          </div>
          <div class="ai-row">
            <span class="ai-label">API Key</span>
            <el-input
              v-model="apiKeyInput"
              type="password"
              show-password
              :placeholder="state.config.ai.keyConfigured ? `${state.config.ai.keyMasked}（留空保持不变，输入新 Key 替换）` : 'sk-...（未配置）'"
            />
            <el-button v-if="state.config.ai.keyConfigured" size="small" text type="danger" @click="clearKey">
              <el-icon><Delete /></el-icon>清除密钥
            </el-button>
          </div>
          <div class="ai-row">
            <span class="ai-label">模型名称</span>
            <el-select
              v-model="state.config.ai.model"
              filterable
              allow-create
              default-first-option
              :loading="loadingModels"
              placeholder="选择或输入模型名"
            >
              <el-option v-for="m in modelOptions" :key="m" :label="m" :value="m" />
            </el-select>
            <el-button size="small" :loading="loadingModels" :disabled="!canFetchModels" @click="fetchModels()">
              <el-icon style="margin-right: 3px"><Refresh /></el-icon>获取模型
            </el-button>
            <span v-if="modelOptions.length" class="ai-hint">共 {{ modelOptions.length }} 个模型</span>
          </div>
          <div class="ai-row">
            <span class="ai-label">温度</span>
            <el-slider v-model="state.config.ai.temperature" :min="0" :max="1" :step="0.1" style="width: 240px" />
            <span class="ai-hint">{{ state.config.ai.temperature }}</span>
          </div>
        </div>
        <div class="ai-actions">
          <el-button type="primary" plain @click="saveConfig">
            <el-icon style="margin-right: 4px"><Check /></el-icon>保存配置
          </el-button>
          <el-button :loading="testing" :disabled="!canTest" @click="testAi">
            <el-icon style="margin-right: 4px"><Connection /></el-icon>测试连接
          </el-button>
          <span v-if="testResult" :class="['ai-result', testResult.ok ? 'ok' : 'err']">
            {{ testResult.ok ? `连接成功：${testResult.reply}` : `连接失败：${testResult.error}` }}
          </span>
        </div>
      </div>
    </el-card>

    <!-- 一键填报（禅道工时） -->
    <el-card v-show="activeSection === 'fill'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>一键填报 · 禅道账号</span></div>
      </template>
      <div class="ai-manager">
        <div class="ai-form">
          <div class="ai-row">
            <span class="ai-label">禅道地址</span>
            <el-input v-model="state.config.zentao.baseUrl" placeholder="如 http://10.11.34.2" style="width: 320px" />
          </div>
          <div class="ai-row">
            <span class="ai-label">账号</span>
            <el-input v-model="state.config.zentao.account" placeholder="禅道登录账号" style="width: 320px" autocomplete="off" />
          </div>
          <div class="ai-row">
            <span class="ai-label">密码</span>
            <el-input
              v-model="ztPwdInput"
              type="password"
              show-password
              :placeholder="state.config.zentao.pwdConfigured ? `${state.config.zentao.pwdMasked}（留空保持不变，输入新密码替换）` : '禅道登录密码（未配置）'"
              style="width: 320px"
            />
            <el-button v-if="state.config.zentao.pwdConfigured" size="small" text type="danger" @click="clearZtPwd">
              <el-icon><Delete /></el-icon>清除密码
            </el-button>
          </div>
        </div>
        <div class="ai-actions">
          <el-button type="primary" plain @click="saveConfig">
            <el-icon style="margin-right: 4px"><Check /></el-icon>保存配置
          </el-button>
          <el-button :loading="ztTesting" :disabled="!state.config.zentao.baseUrl || !state.config.zentao.account || (!state.config.zentao.pwdConfigured && !ztPwdInput)" @click="testZentao">
            <el-icon style="margin-right: 4px"><Connection /></el-icon>测试连接
          </el-button>
          <span v-if="ztTestResult" :class="['ai-result', ztTestResult.ok ? 'ok' : 'err']">
            {{ ztTestResult.ok ? '登录成功' : `登录失败：${ztTestResult.error}` }}
          </span>
        </div>
      </div>
    </el-card>

    <!-- 一键填报 · 汉印工时账号 -->
    <el-card v-show="activeSection === 'fill'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>一键填报 · 汉印工时账号</span></div>
      </template>
      <div class="ai-manager">
        <div class="ai-form">
          <div class="ai-row">
            <span class="ai-label">平台地址</span>
            <el-input v-model="state.config.hanprint.baseUrl" placeholder="如 http://10.10.21.2:5293" style="width: 320px" />
          </div>
          <div class="ai-row">
            <span class="ai-label">所属公司</span>
            <el-select v-model="state.config.hanprint.clientId" style="width: 160px">
              <el-option value="1" label="1 · 厦门汉印" />
              <el-option value="2" label="2 · 江西外协" />
            </el-select>
          </div>
          <div class="ai-row">
            <span class="ai-label">工号</span>
            <el-input v-model="state.config.hanprint.account" placeholder="如 21290" style="width: 320px" autocomplete="off" />
          </div>
          <div class="ai-row">
            <span class="ai-label">密码</span>
            <el-input
              v-model="hpPwdInput"
              type="password"
              show-password
              :placeholder="state.config.hanprint.pwdConfigured ? `${state.config.hanprint.pwdMasked}（留空保持不变，输入新密码替换）` : '汉印平台密码（未配置）'"
              style="width: 320px"
            />
            <el-button v-if="state.config.hanprint.pwdConfigured" size="small" text type="danger" @click="clearHpPwd">
              <el-icon><Delete /></el-icon>清除密码
            </el-button>
          </div>
        </div>
        <div class="ai-actions">
          <el-button type="primary" plain @click="saveConfig">
            <el-icon style="margin-right: 4px"><Check /></el-icon>保存配置
          </el-button>
          <el-button :loading="hpTesting" :disabled="!state.config.hanprint.baseUrl || !state.config.hanprint.account || (!state.config.hanprint.pwdConfigured && !hpPwdInput)" @click="testHanprint">
            <el-icon style="margin-right: 4px"><Connection /></el-icon>测试连接
          </el-button>
          <span v-if="hpTestResult" :class="['ai-result', hpTestResult.ok ? 'ok' : 'err']">
            {{ hpTestResult.ok ? '登录成功' : `登录失败：${hpTestResult.error}` }}
          </span>
        </div>
      </div>
    </el-card>

    <!-- 一键填报 · 工时参数 -->
    <el-card v-show="activeSection === 'fill'" shadow="never" class="card">
      <template #header>
        <div class="card-header"><span>一键填报 · 工时计算参数</span></div>
      </template>
      <div class="ai-manager">
        <div class="ai-form">
          <div class="ai-row">
            <span class="ai-label">上班时间</span>
            <el-time-select v-model="state.config.zentao.workStart" start="06:00" end="21:00" step="00:15" style="width: 120px" />
          </div>
          <div class="ai-row">
            <span class="ai-label">午休时间</span>
            <el-time-select v-model="state.config.zentao.lunchStart" start="11:00" end="14:00" step="00:30" style="width: 130px" />
            <span class="ai-hint">至</span>
            <el-time-select v-model="state.config.zentao.lunchEnd" start="11:30" end="14:30" step="00:30" style="width: 130px" />
          </div>
        </div>
        <div class="ai-actions">
          <el-button type="primary" plain @click="saveConfig">
            <el-icon style="margin-right: 4px"><Check /></el-icon>保存配置
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 界面：全局外观与行为偏好（与业务无关，不随项目变化） -->
    <section v-show="activeSection === 'ui'" class="workspace-panel settings-ui">
      <div class="settings-item">
        <div class="settings-item-head">
          <strong>外观主题</strong>
          <span>立即应用到全部工作区，并自动保存。</span>
        </div>
        <el-radio-group :model-value="state.ui.theme" class="theme-options" aria-label="外观主题" @update:model-value="changeTheme">
          <el-radio-button value="light"><el-icon><Sunny /></el-icon>浅色</el-radio-button>
          <el-radio-button value="dark"><el-icon><Moon /></el-icon>黑色</el-radio-button>
        </el-radio-group>
        <p v-if="themeSaveError" class="theme-save-error" role="alert">{{ themeSaveError }} <el-button link type="primary" @click="changeTheme(state.ui.theme)">重试保存</el-button></p>
      </div>
      <div class="settings-item">
        <div class="settings-item-head">
          <strong>终端字体</strong>
          <span>统一设置终端工作台的字体与字号，改完立即生效</span>
        </div>
        <TerminalFontSettings />
      </div>

      <div class="settings-item">
        <div class="settings-item-head">
          <strong>窗口关闭行为</strong>
          <span>点击窗口右上角关闭按钮（×）时：</span>
        </div>
        <el-radio-group :model-value="closeAction" class="close-action-options" @update:model-value="saveCloseAction">
          <el-radio v-for="option in CLOSE_ACTION_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</el-radio>
        </el-radio-group>
      </div>
    </section>

    <section v-show="activeSection === 'about'" class="workspace-panel settings-about">

      <h2>Personnel PLM</h2>
      <p>项目资料、报告记录和部署配置默认保存在本机。Git、AI 与部署都是按需启用的项目能力。</p>
      <dl class="project-facts">
        <div><dt>版本</dt><dd>{{ appVersion }} <el-button link type="primary" @click="$emit('show-changelog')">查看更新日志</el-button></dd></div>
        <div><dt>平台</dt><dd>Windows / macOS / Linux</dd></div>
        <div><dt>数据方式</dt><dd>本地优先</dd></div>
      </dl>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'
import { useProjects } from '../composables/useProjects'
import { toPlain } from '../utils/ipc'
import { shortPath, pathKey } from '../utils/path'
import TerminalFontSettings from '../components/TerminalFontSettings.vue'
import { applyTheme } from '../utils/ui-prefs'
defineEmits(['show-changelog'])

const topbarReady = useTopbarReady()
const themeSaveError = ref('')
let themeSaveRequest = 0

async function changeTheme(value) {
  const request = ++themeSaveRequest
  themeSaveError.value = ''
  try { await applyTheme(value) }
  catch (error) {
    if (request === themeSaveRequest) themeSaveError.value = `主题已应用，但保存失败：${error.message || error}`
  }
}

const props = defineProps({
  initialSection: {
    type: String,
    default: 'ai',
    validator: (value) => ['ai', 'git', 'identity', 'fill', 'ui', 'about'].includes(value),
  },
})
const { loadProjects } = useProjects()

/** 由 vite define 从 package.json 注入（见 vite.config.js） */
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '—'

// ---------- 窗口关闭行为（主进程 close 拦截读取同一 closeAction 配置） ----------
const CLOSE_ACTION_OPTIONS = [
  { label: '每次询问', value: 'ask' },
  { label: '最小化到托盘', value: 'minimize' },
  { label: '直接退出', value: 'quit' },
]
const closeAction = computed(() =>
  (['ask', 'minimize', 'quit'].includes(state.config.closeAction) ? state.config.closeAction : 'ask'))
/** 立即保存关闭行为（独立于各节底部的「保存配置」按钮，改动即生效） */
async function saveCloseAction(value) {
  state.config.closeAction = value
  try {
    const r = await window.gitReport.configSave(toPlain(state.config))
    if (r && r.ok === false) ElMessage.error(r.error || '关闭行为保存失败')
    else ElMessage.success('关闭行为已保存')
  } catch (e) {
    ElMessage.error(`关闭行为保存失败：${(e && e.message) || e}`)
  }
}

const SETTING_SECTIONS = [
  { label: 'AI 服务', value: 'ai' },
  { label: 'Git 活动', value: 'git' },
  { label: '个人身份', value: 'identity' },
  { label: '一键填报', value: 'fill' },
  { label: '界面', value: 'ui' },
  { label: '应用信息', value: 'about' },
]
const activeSection = ref(props.initialSection)

const EXCLUDE_GROUPS = [
  { label: '依赖与构建缓存', items: ['node_modules', '.cache', 'fvm_cache', '.gradle', 'Pods'] },
  { label: 'SDK / 运行时', items: ['FlutterSDK', 'android-sdk', 'androidsdk', 'jdk'] },
  { label: 'IDE / 系统', items: ['.idea', '__MACOSX', 'Program Files'] },
]

const newRoot = ref('')
const scanning = ref(false)
const progressText = ref('')
const convertingRepoKeys = ref([])
const newIdName = ref('')
const newIdEmail = ref('')

// ---------- AI 模型配置 ----------
const AI_PRESETS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { label: 'Kimi（Moonshot）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  ollama: { label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
  custom: { label: '自定义', baseUrl: '', model: '' },
}
const provider = ref('custom')
const testing = ref(false)
const testResult = ref(null)
/** API Key 输入框（不直接绑定 state.config.ai.apiKey —— 明文 Key 只存主进程） */
const apiKeyInput = ref('')
/** 可用模型列表（从接口 /models 拉取） */
const modelOptions = ref([])
const loadingModels = ref(false)

function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '••••••'
  return `••••••${key.slice(-4)}`
}

function applyPreset(key) {
  const p = AI_PRESETS[key]
  if (p && key !== 'custom') {
    state.config.ai.baseUrl = p.baseUrl
    state.config.ai.model = p.model
  }
  // 切换预设后拉取该接口的可用模型列表（填充下拉）
  fetchModels(false)
}

/** 拉取可用模型列表；showSuccess=false 时静默（启动自动加载场景） */
async function fetchModels(showSuccess = true) {
  if (!state.config.ai.baseUrl || loadingModels.value) return
  loadingModels.value = true
  try {
    const r = await window.gitReport.aiModels(toPlain({
      baseUrl: state.config.ai.baseUrl,
      apiKey: apiKeyInput.value || '',
    }))
    if (r?.ok && r.models?.length) {
      modelOptions.value = r.models
      // 仅在未选择模型时自动挑第一个：用户自定义/服务端未列出的模型名不能被静默覆盖
      if (!state.config.ai.model) {
        state.config.ai.model = r.models[0]
      }
      if (showSuccess) ElMessage.success(`获取到 ${r.models.length} 个模型`)
    } else if (showSuccess) {
      ElMessage.error(`获取模型失败：${r?.error || '列表为空'}`)
    }
  } catch (e) {
    if (showSuccess) ElMessage.error(`获取模型失败：${(e && e.message) || e}`)
  } finally {
    loadingModels.value = false
  }
}

const canFetchModels = computed(() => !!(state.config.ai.baseUrl && (state.config.ai.keyConfigured || apiKeyInput.value)))

/** 保存全部配置；AI 密钥：输入了新 Key 则替换，留空则主进程保留既有；禅道密码同规则 */
async function saveConfig() {
  const secrets = [
    { section: 'ai', field: 'apiKey', input: apiKeyInput, configured: 'keyConfigured', masked: 'keyMasked', reentry: 'keyNeedsReentry' },
    { section: 'zentao', field: 'password', input: ztPwdInput, configured: 'pwdConfigured', masked: 'pwdMasked', reentry: 'pwdNeedsReentry' },
    { section: 'hanprint', field: 'password', input: hpPwdInput, configured: 'pwdConfigured', masked: 'pwdMasked', reentry: 'pwdNeedsReentry' },
  ]
  // 明文只放入本次 IPC 载荷，不能留在共享配置中被其他保存/清除操作重发。
  for (const item of secrets) {
    state.config[item.section] ||= {}
    delete state.config[item.section][item.field]
    item.value = item.input.value
  }
  const payload = toPlain(state.config)
  for (const item of secrets) {
    if (item.value) payload[item.section][item.field] = item.value
  }
  try {
    const r = await window.gitReport.configSave(payload)
    if (r === false || r?.ok === false) throw new Error(r?.error || '配置保存失败')
    for (const item of secrets) {
      if (!item.value) continue
      state.config[item.section][item.configured] = true
      state.config[item.section][item.masked] = maskKey(item.value)
      state.config[item.section][item.reentry] = false
      // 保存期间新输入的内容保留；失败时同样保留输入，便于重试。
      if (item.input.value === item.value) item.input.value = ''
    }
  } catch (e) {
    ElMessage.error(`配置保存失败：${(e && e.message) || e}`)
  }
}

/** 清除已存密钥/密码类配置；成功才更新本地展示状态（失败时磁盘仍保留原值） */
async function saveClearConfig(section, flag) {
  const payload = toPlain(state.config)
  delete payload.ai?.apiKey
  delete payload.zentao?.password
  delete payload.hanprint?.password
  payload[section][flag] = true
  let ok = true
  let error = ''
  try {
    const r = await window.gitReport.configSave(payload)
    if (r === false || r?.ok === false) { ok = false; error = r?.error || '操作失败' }
  } catch (e) {
    ok = false
    error = (e && e.message) || String(e)
  }
  if (ok) delete state.config[section][section === 'ai' ? 'apiKey' : 'password']
  if (!ok) ElMessage.error(`清除失败（${error}），配置未修改`)
  return ok
}

async function clearKey() {
  try {
    await ElMessageBox.confirm('确定清除已保存的 API Key 吗？', '清除密钥', { type: 'warning' })
  } catch {
    return
  }
  if (!(await saveClearConfig('ai', 'clearKey'))) return
  state.config.ai.keyConfigured = false
  state.config.ai.keyMasked = ''
  apiKeyInput.value = ''
  testResult.value = null
}

const canTest = computed(() => !!(state.config.ai.model && (state.config.ai.keyConfigured || apiKeyInput.value)))

// ---------- 一键填报（禅道）配置 ----------
/** 禅道密码输入框（明文密码只存主进程，与 AI Key 同约定） */
const ztPwdInput = ref('')
const ztTesting = ref(false)
const ztTestResult = ref(null)

async function testZentao() {
  ztTesting.value = true
  ztTestResult.value = null
  try {
    const r = await window.gitReport.fillTestLogin(toPlain({
      baseUrl: state.config.zentao.baseUrl,
      account: state.config.zentao.account,
      password: ztPwdInput.value || '', // 空则主进程使用已保存密码
    }))
    ztTestResult.value = r
    if (r?.ok) ElMessage.success('禅道登录成功')
    else ElMessage.error(`禅道登录失败：${r?.error || '未知错误'}`)
  } catch (e) {
    ztTestResult.value = { ok: false, error: (e && e.message) || String(e) }
    ElMessage.error(`禅道登录失败：${ztTestResult.value.error}`)
  } finally {
    ztTesting.value = false
  }
}

async function clearZtPwd() {
  try {
    await ElMessageBox.confirm('确定清除已保存的禅道密码吗？', '清除密码', { type: 'warning' })
  } catch {
    return
  }
  if (!(await saveClearConfig('zentao', 'clearPwd'))) return
  state.config.zentao.pwdConfigured = false
  state.config.zentao.pwdMasked = ''
  ztPwdInput.value = ''
  ztTestResult.value = null
}

// ---------- 一键填报（汉印）配置 ----------
const hpPwdInput = ref('')
const hpTesting = ref(false)
const hpTestResult = ref(null)

async function testHanprint() {
  hpTesting.value = true
  hpTestResult.value = null
  try {
    const r = await window.gitReport.fillHpTest(toPlain({
      baseUrl: state.config.hanprint.baseUrl,
      clientId: state.config.hanprint.clientId,
      account: state.config.hanprint.account,
      password: hpPwdInput.value || '',
    }))
    hpTestResult.value = r
    if (r?.ok) ElMessage.success('汉印平台登录成功')
    else ElMessage.error(`汉印登录失败：${r?.error || '未知错误'}`)
  } catch (e) {
    hpTestResult.value = { ok: false, error: (e && e.message) || String(e) }
    ElMessage.error(`汉印登录失败：${hpTestResult.value.error}`)
  } finally {
    hpTesting.value = false
  }
}

async function clearHpPwd() {
  try {
    await ElMessageBox.confirm('确定清除已保存的汉印密码吗？', '清除密码', { type: 'warning' })
  } catch {
    return
  }
  if (!(await saveClearConfig('hanprint', 'clearPwd'))) return
  state.config.hanprint.pwdConfigured = false
  state.config.hanprint.pwdMasked = ''
  hpPwdInput.value = ''
  hpTestResult.value = null
}

async function testAi() {
  testing.value = true
  testResult.value = null
  try {
    const r = await window.gitReport.aiTest(toPlain({
      baseUrl: state.config.ai.baseUrl,
      apiKey: apiKeyInput.value || '', // 空则主进程使用已存 Key
      model: state.config.ai.model,
    }))
    testResult.value = r
    if (r?.ok) ElMessage.success('连接成功')
    else ElMessage.error(`连接失败：${r?.error || '未知错误'}`)
  } catch (e) {
    testResult.value = { ok: false, error: (e && e.message) || String(e) }
    ElMessage.error(`连接失败：${testResult.value.error}`)
  } finally {
    testing.value = false
  }
}

// 流式扫描事件
let unsubProgress = null
let unsubRepoFound = null
let unsubScanDone = null

// 仓库信息并发加载池
const INFO_CONCURRENCY = 6
let infoQueue = []
let infoWorkers = []
// 已入队路径：同一仓库在被多次发现（App.vue 与本页都监听同一事件）时只补一次详情
const infoQueued = new Set()
// worker 代际：重扫/卸载时递增，旧代循环检测到失配后立即退出
// （否则旧 worker 在扫描期间不会退出，多次重扫后按 6 递增无限累积）
let infoEpoch = 0

/** 缺详情且未入队时排入详情队列（row 必须是响应式代理，写 info 才会触发刷新） */
function enqueueInfo(row, key) {
  if (!row || row.info || infoQueued.has(key)) return
  infoQueued.add(key)
  infoQueue.push(row)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

onMounted(() => {
  // 排除目录为空是用户的显式选择（主进程默认值在配置缺字段时已由 store 补齐），不能当作首次启动重置
  unsubProgress = window.gitReport.onScanProgress((p) => {
    progressText.value = `扫描中… 已处理 ${p.scanned} 个目录`
  })
  unsubRepoFound = window.gitReport.onScanRepoFound((repoPath) => {
    if (!scanning.value) return
    const key = pathKey(repoPath)
    const existing = state.discoveredRepos.find((repo) => pathKey(repo.path) === key)
    if (existing) {
      // 同一事件在 App.vue 也有处理器（负责权威列表），两者顺序不确定：
      // 行已存在时仍要补进详情队列，否则远程地址/分支/最近提交三列长期为空
      enqueueInfo(existing, key)
      return
    }
    state.discoveredRepos.push({ path: repoPath, shortName: shortPath(repoPath), info: null })
    // 通过数组读回响应式代理：直接写本地原始对象不会触发依赖，表格不会刷新
    const row = state.discoveredRepos[state.discoveredRepos.length - 1]
    enqueueInfo(row, key)
  })
  unsubScanDone = window.gitReport.onScanDone(() => {
    scanning.value = false
    progressText.value = ''
  })
  // 启动预热已发现的仓库没有详情，进入列表时补充加载远程地址、分支和最近提交。
  infoQueue = state.discoveredRepos.filter((row) => !row.info)
  for (const row of infoQueue) infoQueued.add(pathKey(row.path))
  if (infoQueue.length) ensureInfoWorkers()
  // 已配置 AI 接口时静默拉取模型列表，填充下拉
  if (state.config.ai?.keyConfigured && state.config.ai?.baseUrl) {
    fetchModels(false)
  }
})
onBeforeUnmount(() => {
  infoEpoch += 1 // 让仍在轮询的 worker 退出
  if (unsubProgress) unsubProgress()
  if (unsubRepoFound) unsubRepoFound()
  if (unsubScanDone) unsubScanDone()
})

function ensureInfoWorkers() {
  const epoch = infoEpoch
  while (infoWorkers.length < INFO_CONCURRENCY) {
    const worker = (async () => {
      for (;;) {
        if (epoch !== infoEpoch) return // 已被新一轮扫描/卸载取代
        const row = infoQueue.shift()
        if (!row) {
          if (!scanning.value) return
          await sleep(80)
          continue
        }
        try {
          row.info = await window.gitReport.repoInfo(row.path)
        } catch {
          row.info = { remote: '-', branch: '-', lastCommit: '-' }
        }
        if (epoch !== infoEpoch) return // await 期间被取代，不再消费新队列
      }
    })()
    infoWorkers.push(worker)
  }
}

async function browseRoot() {
  const dir = await window.gitReport.pickDirectory()
  addRootPath(dir)
}
function addRoot() {
  const v = newRoot.value.trim()
  addRootPath(v)
  newRoot.value = ''
}
/** 归一化判重（尾随分隔符/大小写差异视为同一目录），避免重复扫描同一根目录 */
function addRootPath(v) {
  if (!v) return
  const key = pathKey(v)
  if (state.config.roots.some((r) => pathKey(r) === key)) {
    if (v === newRoot.value.trim()) ElMessage.info('该根目录已添加')
    return
  }
  state.config.roots.push(v)
  saveConfig()
  doScan() // 添加根目录后立即扫描并列出仓库
}

/** 该仓库是否已加入工作区项目（按 localPath 匹配） */
function isRepoAdded(repoPath) {
  const key = pathKey(repoPath)
  return state.projects.items.some((p) => pathKey(p.localPath) === key)
}
function isRepoConverting(repoPath) {
  return convertingRepoKeys.value.includes(pathKey(repoPath))
}
/** 将单个活动源显式转换为项目；路径锁避免快速点击重复创建。 */
async function convertRepoToProject(row) {
  const key = pathKey(row.path)
  if (!key || isRepoAdded(row.path) || convertingRepoKeys.value.includes(key)) return
  const name = String(row.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || row.shortName || '未命名项目'
  convertingRepoKeys.value.push(key)
  try {
    // 保存前再次检查，避免列表状态变化期间重复创建同目录项目。
    if (isRepoAdded(row.path)) return
    const r = await window.gitReport.projectsSave(toPlain({ name, localPath: row.path }))
    if (!r?.ok) throw new Error(r?.error || '保存失败')
    await loadProjects()
    ElMessage.success(`已将活动源「${name}」转换为项目`)
  } catch (e) {
    ElMessage.error(e?.message || '转换项目失败')
  } finally {
    convertingRepoKeys.value = convertingRepoKeys.value.filter((item) => item !== key)
  }
}
function removeRoot(i) {
  state.config.roots.splice(i, 1)
  saveConfig()
}

/** 本人身份（多账号）管理 */
function addIdentity() {
  const name = newIdName.value.trim()
  const email = newIdEmail.value.trim()
  if (!name && !email) return
  if (!state.config.identities) state.config.identities = []
  if (!state.config.identities.some((i) => i.name === name && i.email === email)) {
    state.config.identities.push({ name, email })
  }
  saveConfig()
  newIdName.value = ''
  newIdEmail.value = ''
}
function removeIdentity(i) {
  state.config.identities.splice(i, 1)
  saveConfig()
}

async function doScan() {
  if (!state.config.roots.length) {
    ElMessage.warning('请先添加至少一个扫描根目录')
    return
  }
  infoEpoch += 1 // 旧 worker 立即失效，避免重复扫描累积轮询循环
  state.discoveredRepos.length = 0
  infoQueue = []
  infoQueued.clear()
  infoWorkers = []
  scanning.value = true
  progressText.value = '开始扫描…'
  ensureInfoWorkers()
  try {
    // force=true：绕过主进程扫描缓存强制重扫（事件流式展示 + 更新缓存）
    await window.gitReport.scanRepos(toPlain(state.config.roots), toPlain(state.config.excludes), true)
  } catch (e) {
    console.error('扫描失败', e)
    scanning.value = false
  }
}
</script>
