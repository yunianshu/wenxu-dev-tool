<template>
  <section class="insights" aria-label="模块与灵感">
    <div class="insights-content">
      <header class="insights-heading">
        <h2>模块与灵感</h2>
        <p>对比项目里反复出现的功能，或从一条想法出发，找一件值得先尝试的事。</p>
      </header>

      <form class="materials" @submit.prevent="generate">
        <div class="material-fields">
          <label><span>对比项目</span>
            <el-select v-model="projectIds" aria-label="选择对比项目" placeholder="选择两个或更多项目，查找共性" multiple filterable clearable
              :multiple-limit="MAX_INSIGHT_PROJECTS" :disabled="!!insights.requestId">
              <el-option v-for="project in state.projects.items" :key="project.id" :label="project.name" :value="project.id" />
            </el-select>
          </label>
          <label><span>想法与记录</span>
            <el-select v-model="recordIds" aria-label="选择知识记录" placeholder="选择想进一步探索的记录" multiple filterable clearable
              :multiple-limit="MAX_INSIGHT_RECORDS" :disabled="!!insights.requestId">
              <el-option v-for="row in recordOptions" :key="row.id" :label="recordLabel(row)" :value="row.id" />
            </el-select>
          </label>
        </div>
        <p class="source-hint">生成时会把所选记录和项目资料（简介、备注、标签、最近提交标题）发送给{{ modelLabel }}。</p>
        <div class="generate-actions">
          <el-button type="primary" native-type="submit" :disabled="!hasMaterials" :loading="!!insights.requestId">{{ insights.phase || '生成建议' }}</el-button>
          <el-button v-if="insights.requestId" text @click="cancel">取消</el-button>
          <span v-if="!state.projects.items.length && !recordOptions.length && !knowledge.data.loading">可以先在「想法地球」记下一条想法。</span>
        </div>
      </form>

      <div v-if="insights.error" role="alert" class="insights-error">
        <span>{{ insights.error }}</span><el-button v-if="serviceError" text @click="$emit('settings')">AI 服务设置</el-button>
      </div>
      <div v-if="insights.result" class="results" aria-label="提炼结果">
        <div class="result-caption">上次生成使用的材料：{{ insights.result.sourceLabels.join('、') }}</div>
        <p v-if="insights.result.notice" role="status" class="result-note">{{ insights.result.notice }}</p>
        <div v-for="group in groups" :key="group.key" class="result-group">
          <h3>{{ group.label }} <span>{{ group.cards.length }}</span></h3>
          <article v-for="(card, index) in group.cards" :key="index" class="insight-card">
            <h4>{{ card.title }}</h4>
            <p>{{ card.summary }}</p>
            <ul class="sources" aria-label="建议依据">
              <li v-for="source in card.sources" :key="source.key">
                <strong>{{ source.label }}</strong><span v-if="source.evidence"> · {{ source.evidence }}</span>
              </li>
            </ul>
            <dl>
              <dt>第一步</dt><dd>{{ card.nextStep }}</dd>
              <dt>如何验证</dt><dd>{{ card.validation }}</dd>
            </dl>
            <el-button v-if="savedRecord(card)" text type="primary" @click="knowledge.openRecord(savedRecord(card))">查看已保存记录</el-button>
            <el-button v-else plain size="small" :loading="card.saving" @click="save(card, group.key)">保存到知识库</el-button>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { state } from '../../store'
import { useKnowledge } from '../../composables/useKnowledge'
import { knowledgeProjects } from '../../utils/knowledge'
import { reposForProject } from '../../utils/project-context'
import { MAX_INSIGHT_PROJECTS, MAX_INSIGHT_RECORDS, buildKnowledgeInsightRequest, parseKnowledgeInsights, knowledgeInsightMarkdown } from '../../utils/knowledge-insights'

defineEmits(['settings'])
const knowledge = useKnowledge()
const { insights } = knowledge
const modelLabel = computed(() => state.config.ai?.model || '当前 AI 服务')
const projectNames = computed(() => new Map(state.projects.items.map(project => [project.id, project.name])))
const recordOptions = computed(() => knowledge.data.records.filter(row => !row.deletedAt).map(row => knowledge.data.drafts[row.id] || row))
const selectedProjects = computed(() => insights.projectIds.map(id => state.projects.items.find(project => project.id === id)).filter(Boolean))
const selectedRecords = computed(() => insights.recordIds.map(id => recordOptions.value.find(row => row.id === id)).filter(Boolean))
const projectIds = computed({ get: () => selectedProjects.value.map(row => row.id), set: ids => { insights.projectIds = ids } })
const recordIds = computed({ get: () => selectedRecords.value.map(row => row.id), set: ids => { insights.recordIds = ids } })
const hasMaterials = computed(() => selectedProjects.value.length > 0 || selectedRecords.value.length > 0)
const serviceError = computed(() => insights.error.startsWith('AI 服务'))
const groups = computed(() => [
  { key: 'modules', label: '共性基础模块', cards: insights.result?.modules || [] },
  { key: 'directions', label: '行动建议', cards: insights.result?.directions || [] },
].filter(group => group.cards.length))

function recordLabel(row) {
  const names = knowledgeProjects(row).map(project => projectNames.value.get(project.id) || project.name).filter(Boolean)
  return names.length ? row.title + ' · ' + names.join('、') : row.title
}

async function generate() {
  if (insights.requestId || !hasMaterials.value) return
  const projects = selectedProjects.value
  const records = selectedRecords.value
  const requestId = crypto.randomUUID()
  insights.requestId = requestId
  insights.error = ''
  insights.phase = '正在读取项目资料'
  try {
    const repos = projects.map(project => reposForProject(project, state.discoveredRepos).map(repo => repo.path))
    // 两个项目覆盖同一仓库时，不能把同一批提交当成两个独立项目的依据。
    const counts = new Map()
    for (const path of repos.flat()) counts.set(path, (counts.get(path) || 0) + 1)
    const uniquePaths = [...counts.keys()].filter(path => counts.get(path) === 1)
    const commitsByProject = Object.create(null)
    const missing = []
    if (uniquePaths.length) {
      try {
        const history = await window.gitReport.recentCommits(uniquePaths, 8)
        const commitsByRepo = new Map(history.map(group => [group.repo, group.commits]))
        projects.forEach((project, i) => {
          const commits = repos[i].flatMap(path => commitsByRepo.get(path) || [])
          commitsByProject[project.id] = commits.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8).map(commit => commit.subject)
        })
      } catch { missing.push('近期提交读取失败，已使用其余所选材料。') }
    }
    if (insights.requestId !== requestId) return
    const { messages, sources } = buildKnowledgeInsightRequest({ projects, records, commitsByProject })
    for (let attempt = 0; attempt < 2; attempt++) {
      insights.phase = attempt === 0 ? '正在生成建议' : '正在重新生成精简建议'
      let response
      try { response = await window.gitReport.aiChat(messages, { requestId, responseFormat: 'json' }) }
      catch (error) { throw new Error(`AI 服务请求失败：${error?.message || error}`) }
      if (insights.requestId !== requestId || response?.aborted) return
      if (!response?.ok) throw new Error(`AI 服务请求失败：${response?.error || '请检查模型配置后重试'}`)
      if (response.finishReason === 'content_filter') throw new Error('模型服务拦截了这次回复，请调整所选材料后再试。')
      let result
      try {
        if (response.finishReason === 'length') throw new Error('模型回复达到输出上限，建议已被截断。可以减少所选材料，或换用支持更长输出的模型。')
        result = parseKnowledgeInsights(response.text, sources)
      } catch (error) {
        if (attempt === 1) throw error
        messages[0] = { ...messages[0], content: messages[0].content + '\n请重新生成一份简短的完整 JSON。modules 和 directions 各至多一项，每个说明用一句话，保留来源和引文。直接输出对象。' }
        continue
      }
      insights.result = { ...result, sourceLabels: sources.map(source => source.label), notice: [...missing, result.note].filter(Boolean).join(' ') }
      return
    }
  } catch (error) {
    if (insights.requestId === requestId) insights.error = error?.message || '生成失败，请重试'
  } finally {
    if (insights.requestId === requestId) { insights.requestId = ''; insights.phase = '' }
  }
}

function cancel() {
  const id = insights.requestId
  if (!id) return
  const callingAI = insights.phase !== '正在读取项目资料'
  insights.requestId = ''
  insights.phase = ''
  if (callingAI) window.gitReport.aiStop(id).catch(() => {})
}

function savedRecord(card) {
  return card.savedId && knowledge.record(card.savedId)
}

async function save(card, kind) {
  if (card.saving || savedRecord(card)) return
  card.saving = true
  const isModule = kind === 'modules'
  try {
    const row = await knowledge.create({
      title: card.title, body: knowledgeInsightMarkdown(card),
      type: isModule ? 'method' : 'idea', status: isModule ? 'organized' : 'draft',
      tags: [isModule ? '基础模块' : '行动建议'],
      sourceIds: card.sources.filter(source => source.kind === 'record').map(source => source.id),
      sourceProjects: card.sources.filter(source => source.kind === 'project').map(source => ({ id: source.id, name: source.label })),
    })
    card.savedId = row.id
    ElMessage.success('已保存到知识库')
  } catch (error) { ElMessage.error(error?.message || '记录保存失败，请重试') }
  finally { card.saving = false }
}
</script>

<style scoped>
.insights { flex: 1; min-width: 0; overflow: auto; color: var(--brand-text); }
.insights-content { max-width: 960px; margin: 0 auto; padding: 28px clamp(16px, 3vw, 40px) 40px; }
.insights-heading h2, .result-group h3, .insight-card h4 { margin: 0; }
.insights-heading h2 { font-size: 21px; }
.insights-heading p, .source-hint, .result-caption, .generate-actions > span { color: var(--text-muted); font-size: 13px; line-height: 1.6; }
.insights-heading p { margin: 6px 0 20px; }
.materials { padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-subtle); }
.material-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.material-fields label { min-width: 0; }
.material-fields label > span { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
.source-hint { margin: 12px 0; font-size: 12px; }
.generate-actions, .insights-error { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.generate-actions .el-button + .el-button { margin: 0; }
.insights-error, .result-note { margin: 14px 0; padding: 9px 12px; border-radius: 5px; font-size: 13px; overflow-wrap: anywhere; }
.insights-error { color: var(--danger); background: var(--danger-soft); }
.result-note { background: var(--surface-subtle); color: var(--text-muted); line-height: 1.6; }
.results { margin-top: 22px; overflow-wrap: anywhere; }
.result-caption { font-size: 12px; }
.result-group { margin-top: 20px; }
.result-group h3 { font-size: 16px; }
.result-group h3 > span { color: var(--text-muted); font-size: 12px; }
.insight-card { margin-top: 10px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 7px; font-size: 13px; line-height: 1.65; }
.insight-card h4 { font-size: 15px; }
.insight-card p { margin: 5px 0 8px; white-space: pre-line; }
.sources { padding: 4px 0 4px 12px; margin: 8px 0; border-left: 2px solid var(--line-strong); color: var(--text-muted); list-style: none; }
.sources strong { font-weight: 500; }
.insight-card dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 12px 0; }
.insight-card dt { color: var(--text-muted); }
.insight-card dd { margin: 0; white-space: pre-line; }
@media (max-width: 900px) { .material-fields { grid-template-columns: 1fr; } }
</style>
