<template>
  <div class="settings-page extensions-page">
    <!-- 页头上提到应用顶栏（与项目无关的全局管理页） -->
    <Teleport v-if="topbarReady" to="#app-topbar-slot">
      <div class="topbar-page">
        <h1 class="topbar-page-title">扩展管理</h1>
      </div>
    </Teleport>

    <!-- 一级：扩展项卡片，按 技能 / 插件 分区 -->
    <template v-if="!selected">
      <div class="ext-section">
        <div class="ext-section-head">
          <div class="ext-section-title">
            <el-icon><MagicStick /></el-icon>
            <span>技能 Skills</span>
            <span class="ext-section-sub">四平台共 {{ skillSummary.total }} 项 · 启用 {{ skillSummary.enabled }}</span>
          </div>
        </div>
        <div class="ext-grid">
          <div v-for="c in skillCards" :key="c.key" class="ext-card" @click="openCard(c)">
            <div class="ext-card-top">
              <el-tag size="small" :type="c.installed ? 'success' : 'info'" effect="plain">{{ c.platformName }}</el-tag>
              <el-icon class="ext-card-icon"><component :is="c.icon" /></el-icon>
            </div>
            <div class="ext-card-title">{{ c.title }}</div>
            <template v-if="c.installed">
              <div class="ext-card-count">启用 {{ c.enabled }} / {{ c.total }}</div>
              <el-progress
                :percentage="c.total ? Math.round((c.enabled / c.total) * 100) : 0"
                :stroke-width="6"
                :show-text="false"
                class="ext-card-progress"
              />
            </template>
            <div class="ext-card-note" :class="{ 'ext-card-note-warn': !c.installed }">{{ c.note }}</div>
          </div>
        </div>
      </div>

      <div class="ext-section">
        <div class="ext-section-head">
          <div class="ext-section-title">
            <el-icon><Box /></el-icon>
            <span>插件 Plugins</span>
            <span class="ext-section-sub">四平台共 {{ pluginSummary.total }} 项 · 启用 {{ pluginSummary.enabled }}</span>
          </div>
        </div>
        <div class="ext-grid">
          <div v-for="c in pluginCards" :key="c.key" class="ext-card" @click="openCard(c)">
            <div class="ext-card-top">
              <el-tag size="small" :type="c.installed ? 'success' : 'info'" effect="plain">{{ c.platformName }}</el-tag>
              <el-icon class="ext-card-icon"><component :is="c.icon" /></el-icon>
            </div>
            <div class="ext-card-title">{{ c.title }}</div>
            <template v-if="c.supported && c.installed">
              <div class="ext-card-count">启用 {{ c.enabled }} / {{ c.total }}</div>
              <el-progress
                :percentage="c.total ? Math.round((c.enabled / c.total) * 100) : 0"
                :stroke-width="6"
                :show-text="false"
                class="ext-card-progress"
              />
            </template>
            <div class="ext-card-note" :class="{ 'ext-card-note-warn': !c.installed || !c.supported }">{{ c.note }}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- 二级：子项卡片 -->
    <template v-else>
      <div class="extensions-toolbar">
        <div class="ext-detail-head">
          <el-button class="ext-back" @click="backToOverview">
            <el-icon style="margin-right: 4px"><Back /></el-icon>返回
          </el-button>
          <div>
            <div class="ext-detail-title">{{ currentPlatform?.name }} · {{ typeTitle }}</div>
            <div class="ext-detail-sub">
              共 {{ rows.length }} 项<template v-if="currentPlatform?.installed"> · 启用 {{ enabledCount }}</template>
              <template v-else> · 未检测到平台目录</template>
            </div>
          </div>
        </div>
        <div class="header-actions">
          <el-button plain @click="openPlatformDir">
            <el-icon style="margin-right: 4px"><FolderOpened /></el-icon>打开目录
          </el-button>
          <el-button type="primary" plain :loading="loading" @click="loadExtensions">
            <el-icon style="margin-right: 4px"><Refresh /></el-icon>刷新
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="currentPlatform && !currentPlatform.installed"
        type="warning"
        :closable="false"
        show-icon
        class="card"
      >
        未检测到 {{ currentPlatform.name }} 的配置目录（{{ currentPlatform.dir }}），可能尚未安装该平台。
      </el-alert>
      <el-alert
        v-if="currentPlatform && currentPlatform.error"
        type="error"
        :closable="false"
        show-icon
        class="card"
      >
        读取 {{ currentPlatform.name }} 扩展失败：{{ currentPlatform.error }}
      </el-alert>
      <el-alert
        v-else-if="selected.type === 'plugins' && currentPlatform && !currentPlatform.pluginsSupported"
        type="info"
        :closable="false"
        show-icon
        class="card"
      >
        {{ currentPlatform.pluginNote }}
      </el-alert>

      <!-- 技能子项卡片 -->
      <div v-if="selected.type === 'skills'" class="ext-grid ext-items">
        <div v-for="row in rows" :key="row.name" class="ext-item">
          <div class="ext-item-head">
            <div class="ext-item-name">
              <span class="skill-name" :title="row.name">{{ row.name }}</span>
              <el-tooltip v-if="row.linkTarget" :content="`链接目标：${row.linkTarget}`" placement="top">
                <el-tag size="small" effect="plain">链接</el-tag>
              </el-tooltip>
              <el-tag v-if="row.linkBroken" type="danger" size="small" effect="plain">链接失效</el-tag>
              <el-tag v-if="!row.hasSkillMd && !row.linkBroken" type="danger" size="small" effect="plain">缺 SKILL.md</el-tag>
            </div>
            <el-switch
              :model-value="row.enabled"
              :loading="row.busy"
              :disabled="!row.hasSkillMd && !row.linkBroken"
              @change="toggleSkill(row, $event)"
            />
          </div>
          <div class="ext-item-desc" :title="row.description">{{ row.description || '（无描述）' }}</div>
          <div class="ext-item-foot">
            <el-button text size="small" type="primary" :disabled="!row.hasSkillMd" @click="showSkillDoc(row)">查看</el-button>
            <el-button text size="small" @click="openPath(row.dir)">打开目录</el-button>
          </div>
        </div>
        <div v-if="!rows.length" class="ext-empty">
          <el-icon><MagicStick /></el-icon>
          <p>未发现任何技能目录</p>
        </div>
      </div>

      <!-- 插件子项卡片 -->
      <div v-else class="ext-grid ext-items">
        <div v-for="row in rows" :key="row.id" class="ext-item">
          <div class="ext-item-head">
            <div class="ext-item-name">
              <span class="skill-name" :title="row.name">{{ row.name }}</span>
              <el-tag v-if="row.marketplace" size="small" effect="plain" type="info">{{ row.marketplace }}</el-tag>
            </div>
            <el-switch :model-value="row.enabled" :loading="row.busy" @change="togglePlugin(row, $event)" />
          </div>
          <div class="ext-item-desc">
            <span v-if="row.version" class="ext-item-meta">v{{ row.version }}</span>
            <span v-if="row.installedAt" class="ext-item-meta">安装于 {{ formatTime(row.installedAt) }}</span>
            <span v-if="!row.version && !row.installedAt" class="ext-item-meta">（无版本信息）</span>
          </div>
          <div class="ext-item-foot">
            <el-button text size="small" :disabled="!row.installPath" @click="openPath(row.installPath)">打开目录</el-button>
          </div>
        </div>
        <div v-if="!rows.length" class="ext-empty">
          <el-icon><Box /></el-icon>
          <p>未发现已安装的插件</p>
        </div>
      </div>
    </template>

    <!-- SKILL.md 预览 -->
    <el-drawer v-model="docVisible" :title="docTitle" size="46%">
      <pre class="skill-doc">{{ docContent }}</pre>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../store'
import { useTopbarReady } from '../composables/useTopbarReady'

const loading = ref(false)
const platforms = ref([])
const topbarReady = useTopbarReady()
const selected = ref(null) // null=一级总览；{ platformId, type: 'skills'|'plugins' }
const docVisible = ref(false)
const docTitle = ref('')
const docContent = ref('')

const currentPlatform = computed(() => platforms.value.find((p) => p.id === selected.value?.platformId) || null)
const rows = computed(() => {
  if (!selected.value || !currentPlatform.value) return []
  return selected.value.type === 'skills' ? currentPlatform.value.skills : currentPlatform.value.plugins
})
const enabledCount = computed(() => rows.value.filter((r) => r.enabled).length)
const typeTitle = computed(() => (selected.value?.type === 'skills' ? '技能 Skills' : '插件 Plugins'))

/** 一级卡片：按类型分区，每个区块内为各平台的卡片 */
function makeCard(p, type) {
  const isSkill = type === 'skills'
  return {
    key: `${p.id}:${type}`,
    platformId: p.id,
    type,
    platformName: p.name,
    title: isSkill ? '技能 Skills' : '插件 Plugins',
    icon: isSkill ? 'MagicStick' : 'Box',
    installed: p.installed,
    supported: isSkill || p.pluginsSupported,
    enabled: (isSkill ? p.skills : p.plugins).filter((x) => x.enabled).length,
    total: (isSkill ? p.skills : p.plugins).length,
    note: isSkill
      ? (p.installed ? '目录迁移启停 · 链接技能级联源平台' : '未检测到平台目录')
      : (!p.pluginsSupported ? '该平台暂无插件体系' : !p.installed ? '未检测到平台目录' : '开关写入平台自身配置'),
  }
}

const skillCards = computed(() => platforms.value.map((p) => makeCard(p, 'skills')))
const pluginCards = computed(() => platforms.value.map((p) => makeCard(p, 'plugins')))
const skillSummary = computed(() => ({
  total: skillCards.value.reduce((n, c) => n + c.total, 0),
  enabled: skillCards.value.reduce((n, c) => n + c.enabled, 0),
}))
const pluginSummary = computed(() => ({
  total: pluginCards.value.reduce((n, c) => n + c.total, 0),
  enabled: pluginCards.value.reduce((n, c) => n + c.enabled, 0),
}))

function openCard(card) {
  selected.value = { platformId: card.platformId, type: card.type }
}

function backToOverview() {
  selected.value = null
}

async function loadExtensions() {
  loading.value = true
  try {
    const result = await window.gitReport.extensionsList()
    // 整表替换并补齐本地交互字段；selected 仅存 id，刷新后自动对回同一详情页
    platforms.value = (result?.platforms || []).map((p) => ({
      ...p,
      skills: p.skills.map((s) => ({ ...s, busy: false })),
      plugins: p.plugins.map((x) => ({ ...x, busy: false })),
    }))
  } catch (error) {
    ElMessage.error(error?.message || '读取扩展列表失败')
  } finally {
    loading.value = false
  }
}

async function toggleSkill(row, enable) {
  row.busy = true
  try {
    const r = await window.gitReport.extensionsToggleSkill(selected.value.platformId, row.name, enable)
    if (!r?.ok) throw new Error(r?.error || '操作失败')
    await loadExtensions()
    ElMessage.success(`技能「${row.name}」已${enable ? '启用' : '禁用'}`)
  } catch (error) {
    ElMessage.error(error?.message || `技能「${row.name}」${enable ? '启用' : '禁用'}失败`)
  } finally {
    row.busy = false
  }
}

async function togglePlugin(row, enable) {
  row.busy = true
  try {
    const r = await window.gitReport.extensionsTogglePlugin(selected.value.platformId, row.id, enable)
    if (!r?.ok) throw new Error(r?.error || '操作失败')
    await loadExtensions()
    ElMessage.success(`插件「${row.name}」已${enable ? '启用' : '禁用'}`)
  } catch (error) {
    ElMessage.error(error?.message || `插件「${row.name}」${enable ? '启用' : '禁用'}失败`)
  } finally {
    row.busy = false
  }
}

async function showSkillDoc(row) {
  try {
    const r = await window.gitReport.extensionsReadSkill(selected.value.platformId, row.name)
    if (!r?.ok) throw new Error(r?.error || '读取失败')
    docTitle.value = `${row.name} · SKILL.md`
    docContent.value = r.hasSkillMd ? r.content : '（该技能目录缺少 SKILL.md）'
    docVisible.value = true
  } catch (error) {
    ElMessage.error(error?.message || '读取技能文档失败')
  }
}

function openPlatformDir() {
  if (currentPlatform.value) openPath(currentPlatform.value.dir)
}

async function openPath(p) {
  if (!p) return
  try {
    const r = await window.gitReport.openPath(p)
    if (r && r.ok === false) ElMessage.warning(`路径不存在：${p}`)
  } catch {
    ElMessage.warning(`路径不存在：${p}`)
  }
}

function formatTime(value) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('zh-CN', { hour12: false })
}

onMounted(loadExtensions)
</script>

<style scoped>
/* 一级/二级共用卡片网格：卡片行左右 32px 内边距，与分区带同一节奏 */
.ext-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
  padding: 16px 32px 20px;
}
.ext-items { grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); }

/* 一级分区：分区带（顶部细线 + 标题行，底部收尾线） */
.ext-section { border-top: 1px solid var(--line); }
.ext-section:last-child { border-bottom: 1px solid var(--line); }
.ext-section-head {
  padding: 14px 32px;
  border-bottom: 1px solid var(--line);
}
.ext-section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--brand-text);
}
.ext-section-title .el-icon { font-size: 17px; color: var(--brand-text-sub); }
.ext-section-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--brand-text-sub);
  margin-left: 4px;
}

/* 一级扩展项卡片 */
.ext-card {
  background: #ffffff;
  border: 1px solid var(--brand-card-border);
  border-radius: 10px;
  padding: 16px 18px;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(20, 30, 50, .04);
  transition: box-shadow .18s ease, transform .18s ease;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ext-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(20, 30, 50, .10);
}
.ext-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ext-card-icon { font-size: 20px; color: var(--brand-text-sub); }
.ext-card-title { font-size: 16px; font-weight: 600; color: var(--brand-text); }
.ext-card-count { font-size: 13px; color: var(--brand-text-sub); }
.ext-card-progress { width: 100%; }
.ext-card-note {
  font-size: 12px;
  color: var(--brand-text-sub);
  margin-top: auto;
  padding-top: 10px;
}
.ext-card-note-warn { color: #b8860b; }

/* 二级详情头 */
.extensions-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  gap: 12px;
  flex-wrap: wrap;
  padding: 16px 32px 14px;
}
.ext-detail-head { display: flex; align-items: center; gap: 12px; }
.ext-detail-title { font-size: 16px; font-weight: 600; color: var(--brand-text); }
.ext-detail-sub { font-size: 12px; color: var(--brand-text-sub); margin-top: 2px; }
/* 二级提示条：作为分区带，左右留白与卡片行一致 */
.extensions-page .el-alert.card { padding: 12px 32px; }

/* 二级子项卡片 */
.ext-item {
  background: #ffffff;
  border: 1px solid var(--brand-card-border);
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: 0 1px 2px rgba(20, 30, 50, .04);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ext-item-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.ext-item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.skill-name {
  font-weight: 500;
  color: var(--brand-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}
.ext-item-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--brand-text-sub);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 38px;
}
.ext-item-meta { margin-right: 12px; }
.ext-item-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  border-top: 1px solid #f2f4f7;
  padding-top: 6px;
}
.ext-item-foot .el-button + .el-button { margin-left: 0; }

/* 空状态 */
.ext-empty {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--brand-text-sub);
  padding: 48px 0;
}
.ext-empty .el-icon { font-size: 34px; }
.ext-empty p { margin: 0; font-size: 13px; }

/* SKILL.md 预览 */
.skill-doc {
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  font-family: inherit;
  background: #f7f8fa;
  border-radius: 8px;
  min-height: 100%;
}
</style>
