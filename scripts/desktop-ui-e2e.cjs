/** 桌面 v2 视觉验收：运行真实 Vue 页面，IPC 使用明确的隔离数据，不连接业务平台。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'output', 'desktop-v2-review')

function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE)
  try { return require('playwright-core') } catch { /* 可复用本机 CLI 的依赖，无需修改产品依赖 */ }
  const cache = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx')
  for (const entry of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const file = path.join(cache, entry, 'node_modules', 'playwright-core')
    if (fs.existsSync(file)) return require(file)
  }
  throw new Error('请安装 Playwright CLI，或设置 PLAYWRIGHT_MODULE 指向 playwright-core')
}

function installFixture({ projects, reports, deployments, knowledgeRecords }) {
  const events = new Map()
  window.__uiEmitDeployDone = async record => Promise.all([...(events.get('onDeployDone') || [])].map(fn => fn({ record })))
  const eventNames = new Set(['onWinFullscreen', 'onWinMaximized', 'onWinAskClose', 'onHarnessUpdate', 'onScanProgress', 'onScanRepoFound', 'onScanDone', 'onCollectProgress', 'onDeployStatus', 'onDeployLog', 'onDeployStage', 'onDeployProgress', 'onDeployDone', 'onDeployHistoryUpdated', 'onHarnessStatus', 'onTerminalData', 'onTerminalCwd', 'onTerminalExit', 'onTerminalClosed', 'onAiDelta'])
  const knowledgeKey = 'desktop-ui-test-knowledge'
  if (!localStorage.getItem(knowledgeKey)) localStorage.setItem(knowledgeKey, JSON.stringify(knowledgeRecords))
  const readKnowledge = () => JSON.parse(localStorage.getItem(knowledgeKey))
  const writeKnowledge = records => localStorage.setItem(knowledgeKey, JSON.stringify(records))
  const copy = value => structuredClone(value)
  window.__uiAiRequests = []
  const saveKnowledge = payload => {
    const records = readKnowledge()
    const index = records.findIndex(row => row.id === payload.id)
    const previous = index < 0 ? null : records[index]
    if (previous && payload.revision !== previous.revision) return { ok: false, error: '记录版本冲突' }
    const now = Date.now()
    const record = { title: '未命名记录', body: '', type: 'idea', status: 'inbox', projectId: '', projectName: '', tags: [], sourceIds: [], deletedAt: null, ...copy(payload), id: previous?.id || 'ui-record-' + now + '-' + records.length, revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || now, updatedAt: now }
    if (index < 0) records.unshift(record)
    else records[index] = record
    writeKnowledge(records)
    return { ok: true, record: copy(record) }
  }
  const lifecycleKnowledge = (id, revision, restore) => {
    const record = readKnowledge().find(row => row.id === id)
    if (!record) return { ok: false, error: '记录不存在' }
    return saveKnowledge({ ...record, revision, deletedAt: restore ? null : Date.now() })
  }
  const prefs = () => JSON.parse(localStorage.getItem('ui-test-prefs') || '{"theme":"light","sidebarCollapsed":false,"terminalFontSize":13,"terminalFontFamily":""}')
  const repos = projects.filter(p => p.localPath).map(p => p.localPath)
  const terminalSessions = new Map()
  window.__uiCalls = []
  window.__uiUnknown = []
  const config = {
    roots: ['D:/Projects'], excludes: ['node_modules', '.git'], identities: [{ name: '开发者', email: 'developer@example.invalid' }],
    ai: { baseUrl: 'https://ai.example.invalid/v1', model: 'team-model', keyConfigured: true, keyMasked: '已配置', temperature: 0.7 },
    zentao: { baseUrl: 'https://zentao.example.invalid', account: 'developer', pwdConfigured: true, workStart: '08:30', lunchStart: '12:00', lunchEnd: '13:00' },
    hanprint: { baseUrl: 'https://work.example.invalid', account: 'developer', pwdConfigured: true },
    harness: { port: 3080, autoStart: false, fullscreen: false }, closeAction: 'ask',
  }
  const skills = ['daily-report', 'git-commit', 'project-diagrams', 'project-packager', 'repo-cleanup', 'sample-linked-skill'].map((name, index) => ({ name, description: ['按 Git 提交生成工作日报', '检查差异并生成规范提交', '依据仓库维护技术图表', '构建与校验发布产物', '清理证据明确的可再生文件', '链接目标不可用'][index], enabled: index < 3, hasSkillMd: index !== 5, linkBroken: index === 5, linkTarget: index === 5 ? 'D:/missing-skill' : '', dir: 'D:/skills/' + name }))
  const platforms = ['Claude Code', 'Codex', 'Kimi CLI', 'ZCode'].map((name, index) => ({ id: ['claude', 'codex', 'kimi', 'zcode'][index], name, installed: true, dir: 'D:/extensions/' + name, pluginsSupported: index !== 2, pluginNote: '该平台暂不支持插件', skills: structuredClone(skills), plugins: [{ id: 'workspace', name: 'Workspace tools', enabled: true, version: '1.0.0', installPath: 'D:/plugins/workspace' }] }))
  const api = {
    knowledgeList: () => ({ ok: true, records: readKnowledge(), directory: 'D:/isolated-ui-fixture/knowledge', warnings: [] }),
    knowledgeSave: saveKnowledge,
    knowledgeTrash: (id, revision) => lifecycleKnowledge(id, revision, false),
    knowledgeRestore: (id, revision) => lifecycleKnowledge(id, revision, true),
    knowledgeDelete: (id, revision, contentHash) => {
      const records = readKnowledge()
      const record = records.find(row => row.id === id)
      if (!record?.deletedAt || record.revision !== revision || record.contentHash !== contentHash) return { ok: false, error: '记录状态或版本已改变' }
      writeKnowledge(records.filter(row => row.id !== id))
      return { ok: true, id }
    },
    knowledgeImport: payload => saveKnowledge({ title: payload.fileName.replace(/\.(md|markdown)$/i, ''), body: payload.content, type: 'idea', status: 'inbox' }),
    knowledgeExport: id => { const record = readKnowledge().find(row => row.id === id); return record ? { ok: true, fileName: record.title + '.md', content: '# ' + record.title + '\n\n' + record.body } : { ok: false, error: '记录不存在' } },
    aiChat: (messages, options) => {
      window.__uiAiRequests.push(copy({ messages, options }))
      const failure = window.__uiAnalysisFailures?.shift()
      if (failure === 'service') return { ok: false, error: '隔离模型暂时不可用' }
      if (failure === 'length') return { ok: true, text: '{"modules":[', finishReason: 'length' }
      const reply = JSON.stringify({
        modules: [{
          title: '共用表单校验', summary: '抽取字段校验规则，保留每个项目独立的表单布局。',
          nextStep: '从两个表单各挑一个必填项抽出校验函数。', validation: '两个表单用同一组输入产生一致提示。',
          sources: ['P1', 'P2'], evidence: { P1: '复用表单校验规则', P2: '复用表单校验规则' },
        }],
        directions: [{
          title: '用原型验证表单提示', summary: '把用户想法转化为两个表单的对照实验。',
          nextStep: '准备一组合法和非法的输入样例。', validation: '逐项核对错误提示能否定位字段。',
          sources: ['P1', 'P2', 'R1'],
        }], note: '',
      })
      return { ok: true, text: '整理结果如下。\n```json\n' + reply + '\n```', finishReason: 'stop' }
    },
    recentCommits: (paths, limit) => paths.map(repo => ({ repo, commits: Array.from({ length: Math.min(12, limit) }, (_, i) => ({
      hash: 'a' + String(i).padStart(9, '0'), date: new Date(Date.UTC(2026, 9, 20 - i)).toISOString(), subject: i === 0 ? '复用表单校验规则' : '提交样例第' + (i + 1) + '条',
      authorName: '隔离作者', authorEmail: 'committer@example.invalid',
    })) })),
    projectsList: () => copy(projects),
    deployProjectsSave: payload => {
      const index = projects.findIndex(project => project.id === payload.id)
      if (index < 0) return { ok: false, error: '隔离项目不存在' }
      projects[index] = copy(payload)
      return { ok: true, id: payload.id }
    },
    deployRollback: () => ({ ok: false, record: { status: 'failed', message: '隔离回滚健康检查失败，已恢复原服务' } }),
    configLoad: () => config, configSave: value => Object.assign(config, value),
    uiPrefsLoad: prefs, uiPrefsSave: value => { localStorage.setItem('ui-test-prefs', JSON.stringify(value)); return { ok: true, prefs: value } },
    getIdentity: () => config.identities[0], winIsFullScreen: () => false, winIsMaximized: () => false,
    appUiReady: () => {}, harnessUpdateStatus: () => ({}), reposSnapshot: () => repos, warmup: () => repos,
    collectCommits: () => projects.slice(0, 3).flatMap((p, index) => Array.from({ length: 4 - index }, (_, n) => ({ hash: `b${index}d${n}9ea`, subject: ['优化项目工作区布局', '完善界面主题与交互状态', '修复报告范围显示', '更新开发文档'][n], message: '改进桌面工作区', author: '开发者', email: 'developer@example.invalid', date: new Date().toISOString(), repo: p.localPath, shortName: p.name }))),
    listHistory: () => reports, readHistory: id => ({ ...reports.find(row => row.id === id), content: '# 活动报告\n\n完成项目列表、主题和桌面工作区的调整。' }),
    deployHistoryList: () => { if (window.__overviewFailHistory) throw new Error("隔离读取失败"); return deployments }, deployServersList: () => [{ id: 'server-test', name: '测试服务器', host: '192.0.2.10', port: 22, username: 'deploy', authType: 'password', secretConfigured: true }],
    deployDetectVersion: () => ({ version: '1.4.98', source: 'package.json' }), deployReleases: () => ({ ok: true, current: '1.4.97', releases: ['1.4.97', '1.4.96'] }),
    debugStatus: () => ({ hasStartBat: true, running: false }), fillBindings: () => ({ [projects[0].id]: { taskId: 1042, taskName: '工作区界面优化' } }), fillLog: () => ({ ok: true, entries: [] }),
    fillPlan: payload => {
      const selectedIds = payload.selectedIds || [projects[0].id, projects[1].id]
      const dayProjects = projects.slice(0, 3).map((project, index) => ({ projectId: project.id, projectName: project.name, selected: selectedIds.includes(project.id), taskId: index < 2 ? 1042 + index : null, taskName: ['工作区界面优化', '文档规范更新'][index] || '', commitCount: 4 - index, hours: index === 0 ? 5 : 3, work: '完成工作区布局、主题与交互状态调整。\n保留现有业务流程，验证窗口适配。' }))
      const planned = dayProjects.filter(project => project.selected)
      return { ok: true, date: payload.date, rangeStart: payload.startTime || '08:30', rangeEnd: payload.endTime || '17:30', crossDay: false, commitCount: 9, selectedIds, dayProjects, planned, tasks: planned.filter(project => project.taskId).map(project => ({ taskId: project.taskId, taskName: project.taskName, consumed: project.hours, taskLeft: 12, left: 12 - project.hours, rows: [] })), hpItems: [{ ProjectName: '桌面工具', TaskName: '开发与验证', Percent: 100, TaskId: 1 }], hpExisting: [], ztTasks: [{ id: 1042, name: '工作区界面优化', status: 'doing', project: '项目工作台', left: 12 }], unmatched: planned.filter(project => !project.taskId) }
    },
    repoInfo: repo => ({ branch: 'main', remote: 'https://example.invalid/team/' + repo.split('/').pop(), lastCommit: '完善项目工作区' }),
    extensionsList: () => ({ platforms }), extensionsReadSkill: (id, name) => ({ ok: true, hasSkillMd: true, content: '# ' + name + '\n\n这是用于隔离界面验证的本地技能内容。' }),
    harnessStatus: () => ({ status: 'stopped', installed: false }),
    terminalShellOptions: () => ({ options: [{ id: 'powershell', name: 'PowerShell', label: 'PowerShell' }] }),
    terminalLayoutGet: () => ({ layout: { gridMode: '2x2', columnWidths: [0.5, 0.5], rowHeights: [0.5, 0.5], panes: projects.slice(0, 2).map((p, index) => ({ paneId: 'test-pane-' + index, projectId: p.id, shellId: 'powershell' })) } }),
    terminalLayoutSave: () => ({ ok: true }), terminalList: () => window.__overviewFailTerminal ? { ok: false, error: '隔离终端读取失败', sessions: [] } : { ok: true, sessions: [...terminalSessions.values()] },
    terminalCreate: payload => { const session = { ...payload, id: payload.paneId || 'test-session', cwd: payload.cwd, shell: 'PowerShell', shellName: 'PowerShell' }; terminalSessions.set(session.id, session); setTimeout(() => { for (const fn of events.get('onTerminalData') || []) fn({ id: session.id, sessionId: session.id, data: '\x1b[32m✓\x1b[0m 项目工作区已就绪\r\nPS ' + payload.cwd + '> ' }) }, 100); return { ok: true, session, replay: '' } },
    terminalAttach: id => ({ ok: true, session: terminalSessions.get(id), replay: 'PS D:/Projects> ' }), terminalResize: () => ({ ok: true }),
    aiModels: () => ({ ok: true, models: ['team-model'] }),
    openPath: () => ({ ok: true }), copyText: () => ({ ok: true }), saveReport: () => ({ ok: true, saved: true, filePath: 'D:/isolated-ui-fixture/export.md' }),
  }
  window.gitReport = new Proxy(api, { get(target, name) {
    if (eventNames.has(name)) return fn => { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); return () => events.get(name).delete(fn) }
    if (!(name in target)) return async () => { window.__uiUnknown.push(String(name)); throw new Error('未配置的测试 IPC：' + String(name)) }
    return async (...args) => { window.__uiCalls.push(String(name)); return target[name](...args) }
  } })
}

async function verifyKnowledgeSuggestions(page, navigate) {
  const sourceTitle = '希望两个项目的表单能用同一套错误提示'
  const recordsInBrowser = () => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')))
  const tabs = page.locator('.knowledge-tabs')
  await navigate('工作台')
  await page.getByRole('button', { name: '记录与复盘', exact: true }).click()
  const projectContext = page.locator('.knowledge-context')
  assert.match(await projectContext.innerText(), /Personnel PLM/)
  await projectContext.getByRole('button', { name: '记录项目想法' }).click()
  await page.getByRole('textbox', { name: '快速记录' }).fill(sourceTitle)
  await page.getByRole('button', { name: '保存快速记录' }).click()
  await page.waitForFunction(title => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.title === title), sourceTitle)
  const original = (await recordsInBrowser()).find(row => row.title === sourceTitle)
  assert.equal(original.projectId, 'project-0')
  await tabs.getByRole('button', { name: '模块与灵感' }).click()

  async function choose(label, names) {
    const control = page.getByRole('combobox', { name: label, exact: true })
    await page.locator('.el-select__wrapper').filter({ has: control }).click()
    for (const name of names) {
      const option = page.getByRole('option', { name: new RegExp(name) })
      if (await option.getAttribute('aria-selected') !== 'true') await option.click()
    }
    await control.press('Escape')
  }
  const projectNames = ['Personnel PLM', '组件文档站', '内部 API 服务', '交付脚本']
  const recordTitles = [sourceTitle, '用知识记录积累开发经验']
  await choose('选择对比项目', projectNames)
  await choose('选择知识记录', recordTitles)
  assert.equal((await page.evaluate(() => window.__uiAiRequests)).length, 0, '打开页面、保存想法和选择材料均不发起请求')
  const generate = page.getByRole('button', { name: '生成建议', exact: true })
  await page.evaluate(() => { window.__uiAnalysisFailures = ['service'] })
  await generate.click()
  await page.getByRole('alert').filter({ hasText: '隔离模型暂时不可用' }).waitFor()
  assert.equal((await recordsInBrowser()).find(row => row.id === original.id).revision, original.revision, '请求失败保留已选想法')
  await page.evaluate(() => { window.__uiAnalysisFailures = ['length', 'length'] })
  await generate.click()
  await page.getByRole('alert').filter({ hasText: '截断' }).waitFor()
  assert.equal(await page.locator('.insight-card').count(), 0, '截断的回复不能生成建议卡片')
  await page.evaluate(() => { window.__uiAnalysisFailures = ['length'] })
  await generate.click()
  const moduleTitle = '共用表单校验'
  const directionTitle = '用原型验证表单提示'
  const moduleCard = page.locator('article').filter({ hasText: moduleTitle })
  const directionCard = page.locator('article').filter({ hasText: directionTitle })
  await moduleCard.getByRole('button', { name: '保存到知识库' }).waitFor()
  const requests = await page.evaluate(() => window.__uiAiRequests)
  assert.equal(requests.length, 5, '服务失败直接提示，截断仅自动重试一次')
  assert(requests.every(request => request.options.responseFormat === 'json'), '首次与重试均请求结构化回复')
  const ids = requests.map(request => request.options.requestId)
  assert.equal(new Set(ids).size, 3, '每次点击具有独立请求 ID')
  assert.equal(ids[1], ids[2], '同一轮截断重试可用同一请求 ID 取消')
  assert.equal(ids[3], ids[4])
  const materials = requests[0].messages.find(message => message.role === 'user').content
  assert.deepEqual(JSON.parse(materials).map(row => row.label), [...projectNames, ...recordTitles])
  for (const request of requests) assert(request.messages.some(message => message.content === materials), '重试沿用全部所选材料')
  const prompt = requests.at(-1).messages.map(message => message.content).join('\n')
  for (const material of [...projectNames, ...recordTitles, '前端组件与交互规范', '项目资料、Git 活动与部署的统一工作区', 'Vue', '保留项目目录与既有工作流程', '复用表单校验规则']) {
    assert(prompt.includes(material), '请求应包含所选资料：' + material)
  }
  for (const omitted of ['实验项目', '排查自动保存中的旧响应', '提交样例第9条', 'committer@example.invalid', '192.0.2.10', 'D:/Projects/']) {
    assert(!prompt.includes(omitted), '请求应排除未选材料或额外的本机数据：' + omitted)
  }
  assert(!(await recordsInBrowser()).some(row => row.title === moduleTitle || row.title === directionTitle), '生成结果只作为预览')
  await moduleCard.getByRole('button', { name: '保存到知识库' }).click()
  await directionCard.getByRole('button', { name: '保存到知识库' }).click()
  await page.waitForFunction(title => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.title === title), directionTitle)
  const rows = await recordsInBrowser()
  const method = rows.find(row => row.title === moduleTitle)
  const idea = rows.find(row => row.title === directionTitle)
  assert.equal(method.type, 'method')
  assert.equal(method.status, 'organized')
  assert.equal(idea.type, 'idea')
  assert.equal(idea.status, 'draft')
  assert.deepEqual(method.sourceProjects, [{ id: 'project-0', name: 'Personnel PLM' }, { id: 'project-1', name: '组件文档站' }])
  assert.deepEqual(idea.sourceIds, [original.id])
  assert.deepEqual(rows.find(row => row.id === original.id), original, '采纳建议保留原始想法和修订号')
  for (const name of ['Personnel PLM', '组件文档站']) assert(method.body.includes(name), '共性模块保留来源项目：' + name)
  await tabs.getByRole('button', { name: '全部记录' }).click()
  const projectFilter = page.getByRole('combobox', { name: '筛选关联项目' })
  for (const name of ['Personnel PLM', '组件文档站']) {
    await page.locator('.el-select__wrapper').filter({ has: projectFilter }).click()
    await page.getByRole('option', { name, exact: true }).click()
    await page.locator('.knowledge-record-title').filter({ hasText: moduleTitle }).waitFor()
  }
  await page.locator('.knowledge-record-title').filter({ hasText: directionTitle }).click()
  await page.getByRole('region', { name: '来源记录' }).getByRole('button', { name: new RegExp(sourceTitle) }).click()
  assert.equal(await page.getByRole('textbox', { name: '记录标题' }).inputValue(), sourceTitle, '重新打开采纳的建议可回到来源原文')
  assert.equal((await page.evaluate(() => window.__uiAiRequests)).length, requests.length, '回看记录不重新调用模型')
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true })
  const factory = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(ROOT, 'src/components/deploy/deploy-form.js'), 'utf8')).toString('base64'))
  const names = ['Personnel PLM', '组件文档站', '内部 API 服务', '交付脚本', '实验项目', '归档项目']
  const projects = names.map((name, index) => ({ ...factory.emptyProject(), id: 'project-' + index, name, description: ['项目资料、Git 活动与部署的统一工作区', '前端组件与交互规范', '业务接口与后台服务', '自动化构建和交付工具', '探索新的开发流程', '历史项目资料'][index], localPath: 'D:/Projects/' + ['personnel-plm', 'design-system', 'api-service', 'release-tools', 'sandbox', 'archive'][index], status: index === 4 ? 'paused' : index === 5 ? 'archived' : 'active', tags: ['桌面工具', 'Vue'], notes: '保留项目目录与既有工作流程。', deployMode: 'docker', version: { strategy: 'manual', manual: '1.4.98' }, targets: [{ ...factory.emptyTarget(), id: 'test', name: '测试环境', serverId: 'server-test', server: { ...factory.emptyTarget().server, host: '192.0.2.10', port: 22, username: 'deploy', secretConfigured: true }, remotePath: '/opt/apps/personnel-plm' }] }))
  const reports = Array.from({ length: 18 }, (_, index) => ({ id: 'report-' + index, title: (index % 3 ? '工作日报' : '工作周报') + ' · 2026-09-' + String(23 - index).padStart(2, '0'), createdAt: '2026-09-' + String(23 - index).padStart(2, '0') + ' 18:30:00', period: index % 3 ? 'daily' : 'weekly', dateRange: '2026-09-23', commitCount: 12 + index, projectCount: 3, projectId: '' }))
  const deployments = Array.from({ length: 4 }, (_, index) => ({ id: 'deploy-' + index, projectId: projects[0].id, projectName: projects[0].name, targetId: 'test', targetName: '测试环境', version: '1.4.' + (97 - index), type: 'deploy', status: index === 2 ? 'failed' : 'success', startedAt: Date.now() - index * 86400000, finishedAt: Date.now() - index * 86400000 + 42000, durationMs: 42000, summary: '部署完成', server: '192.0.2.10' }))
  const knowledgeRecords = [
    ['idea', 'inbox', '用知识记录积累开发经验', '先快速记录，再按来源整理可复用方法。', 0],
    ['problem', 'inbox', '排查自动保存中的旧响应', '保存过程中输入新内容，旧请求返回后必须保留新草稿。', 0],
    ['decision', 'organized', '保持知识记录与项目解耦', '项目用于关联上下文，记录可以独立存在。', 0],
    ['method', 'organized', '代码评审检查步骤', '先检查目标和证据，再验证行为与边界。', 1],
    ['principle', 'organized', '先验证适用条件再推广', '区分事实、假设与待验证问题。', null],
    ['ai', 'draft', '限定 AI 的来源范围', '只发送所选记录，不默认包含整个知识库。', 0],
    ['idea', 'draft', '个人工作复盘提纲', '记录结果、原因与下一次可执行的调整。', null],
  ].map(([type, status, title, body, projectIndex], index) => ({ id: 'knowledge-' + index, type, status, title, body, projectId: projectIndex === null ? '' : projects[projectIndex].id, projectName: projectIndex === null ? '' : projects[projectIndex].name, tags: ['知识实践', type === 'ai' ? 'AI' : '工作方法'], sourceIds: [], deletedAt: null, revision: 1, createdAt: Date.now() - (7 - index) * 3600000, updatedAt: Date.now() - index * 3600000 }))
  if (process.argv.includes('--globe-only')) {
    const titles = ['提取通用的审批记录', '合并重复的权限判断', '整理表单校验规则', '对比两个项目的导出流程', '记录用户遇到的第一个问题', '给重试流程补上反馈', '复用离线草稿能力', '按角色查看审批时间']
    for (const [i, title] of titles.entries()) {
      const module = i === 2 || i === 6
      const derived = module || i === 5 || i === 7
      knowledgeRecords.push({ ...knowledgeRecords[0], id: 'idea-' + title, title, body: title,
        type: module ? 'method' : 'idea', status: module ? 'organized' : derived ? 'draft' : 'inbox',
        tags: [module ? '基础模块' : derived ? '行动建议' : '工作方法'], sourceIds: derived ? ['idea-' + titles[i < 6 ? 0 : 3]] : [],
        sourceProjects: derived ? projects.slice(0, 2).map(({ id, name }) => ({ id, name })) : [],
      })
    }
  }
  // 测试过程中不接受开发热替换，避免并行编辑重置正在验证的工作区。
  const viteRunner = `
    import http from 'node:http'
    import { createServer } from 'vite'
    const server = http.createServer()
    const vite = await createServer({ root: process.cwd(), server: { middlewareMode: true, watch: null, hmr: { server } } })
    server.on('request', vite.middlewares)
    server.listen(0, '127.0.0.1', () => console.log('桌面验收服务端口=' + server.address().port))
  `
  const server = spawn(process.execPath, ['--input-type=module', '-e', viteRunner], { cwd: ROOT, windowsHide: true, stdio: 'pipe' })
  let serverLog = ''
  server.stdout.on('data', chunk => { serverLog += chunk })
  server.stderr.on('data', chunk => { serverLog += chunk })
  let browser
  let page
  const errors = []
  const checks = []
  const externalRequests = []
  const unknown = []
  const interactions = []
  try {
    let origin = ''
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) throw new Error(serverLog)
      const port = serverLog.match(/桌面验收服务端口=(\d+)/)?.[1]
      if (port) { origin = 'http://127.0.0.1:' + port; break }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!origin) throw new Error('隔离 Vite 服务未就绪：' + serverLog)
    browser = await playwright().chromium.launch({ channel: 'msedge', headless: true })
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    page.setDefaultTimeout(12000)
    await page.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
      externalRequests.push(route.request().url())
      await route.abort('blockedbyclient')
    })
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if ((message.type() === 'error' && !message.text().includes('favicon')) || /Failed to resolve component|Unhandled error/.test(message.text())) errors.push(message.text()) })
    await page.addInitScript(installFixture, { projects, reports, deployments, knowledgeRecords })
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.locator('.work-overview').waitFor()
    const navigate = async name => { await page.locator('.app-menu .el-menu-item').filter({ has: page.locator('span', { hasText: new RegExp('^' + name + '$') }) }).click(); await page.waitForTimeout(250) }
    const capture = async (name, theme, width, height) => {
      await page.waitForTimeout(150)
      await page.waitForFunction(() => [...document.querySelectorAll('.el-loading-mask')].every(element => getComputedStyle(element).display === 'none' || element.getBoundingClientRect().height === 0))
      // 操作反馈消失后截图，避免短暂 Toast 遮挡完整工具栏。
      await page.waitForFunction(() => !document.querySelector('.el-message'))
      const layout = await page.evaluate(() => {
        const box = selector => { const element = document.querySelector(selector); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
        return { titlebar: box('.app-titlebar'), sidebar: box('.app-sidebar'), topbar: box('.app-topbar'), status: box('.app-statusbar'), knowledge: box('.knowledge-workbench'), documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, theme: document.documentElement.dataset.theme, overflowing: [...document.querySelectorAll('.topbar-slot, .app-menu, .content-area')].filter(el => el.scrollWidth > el.clientWidth + 2).map(el => el.className) }
      })
      assert.equal(layout.titlebar.height, 40, '窗口标题栏40px')
      assert.equal(layout.sidebar.width, 208, '侧栏208px')
      assert.equal(layout.topbar.height, 64, '页面工具栏64px')
      assert.equal(layout.status.height, 24, '状态栏24px')
      assert.equal(layout.status.bottom, height, '状态栏必须完整显示')
      assert.equal(layout.theme, theme)
      assert.equal(layout.documentWidth, width, '窗口不得出现横向溢出')
      assert.deepEqual(layout.overflowing, [], name + ' 不得横向溢出')
      if (layout.knowledge) {
        assert(layout.knowledge.right <= width + 1, '知识工作台右边界完整')
        assert(layout.knowledge.bottom <= height - 24 + 1, '知识工作台位于状态栏之上')
      }
      checks.push({ name, theme, width, height, layout })
      await page.screenshot({ path: path.join(OUTPUT, `${theme}-${width}-${name}.png`), fullPage: false })
    }
    if (process.argv.includes('--globe-only')) {
      await navigate('知识库')
      await page.locator('.knowledge-tabs').getByRole('button', { name: '想法地球' }).click()
      const canvas = page.locator('.idea-globe-canvas')
      await canvas.waitFor()
      assert.equal(await page.locator('.idea-globe-heading span').innerText(), '8 个想法')
      assert.match(await page.locator('.idea-globe-heading').innerText(), /2 个基础模块/)
      assert.match(await page.getByLabel('图例').innerText(), /来源关联/)
      const nextPaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      for (const [theme, width, height] of [['light', 1440, 900], ['dark', 1440, 900], ['light', 1080, 720]]) {
        await page.setViewportSize({ width, height })
        await page.evaluate(async value => (await import('/src/utils/ui-prefs.js')).applyTheme(value), theme)
        await nextPaint()
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, '地球页面不产生横向溢出')
        const file = path.join(OUTPUT, 'globe-' + theme + '-' + width + '.png')
        await page.screenshot({ path: file })
        console.log('想法地球截图 ' + file)
      }
      const box = await canvas.boundingBox()
      const x = box.x + box.width * 0.5, y = box.y + box.height * 0.49
      const pixels = () => canvas.evaluate(el => el.toDataURL())
      await page.mouse.move(x, y)
      await nextPaint()
      const beforeDrag = await pixels()
      await page.mouse.down()
      await page.mouse.move(x + 90, y + 30, { steps: 8 })
      await page.mouse.up()
      await nextPaint()
      const afterDrag = await pixels()
      assert(beforeDrag !== afterDrag, '拖动应改变球面投影')
      assert.equal(await page.locator('.knowledge-editor').count(), 0, '拖动不误选想法')
      await page.mouse.wheel(0, -180)
      await nextPaint()
      assert(afterDrag !== await pixels(), '滚轮应改变显示比例')
      const title = '把两套审批的提示合起来'
      await page.getByRole('textbox', { name: '快速记录' }).fill(title)
      await page.getByRole('button', { name: '保存快速记录' }).click()
      // 新想法会转到视野中心，移到光点时通过真实提示确认再打开。
      await page.waitForFunction(title => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.title === title), title)
      const tooltip = page.locator('.idea-globe-tooltip').filter({ hasText: title })
      let target
      for (let attempt = 0; attempt < 20 && !target; attempt++) {
        await nextPaint()
        for (const level of [0.49, 0.5, 0.47, 0.52]) {
          const point = { x, y: box.y + box.height * level }
          await page.mouse.move(point.x, point.y)
          if (await tooltip.isVisible()) { target = point; break }
        }
      }
      assert(target, '新想法转至视野中心且光点提示显示对应标题')
      await page.mouse.click(target.x, target.y)
      const detail = page.getByRole('textbox', { name: '记录标题' })
      await detail.waitFor()
      assert.equal(await detail.inputValue(), title, '光点应打开对应原文')
      await page.locator('.el-message').waitFor({ state: 'detached' })
      await nextPaint()
      await page.screenshot({ path: path.join(OUTPUT, 'globe-detail-1080.png') })
      await page.getByRole('button', { name: '关闭记录详情' }).click()
      await page.locator('.knowledge-editor').waitFor({ state: 'detached' })
      await canvas.waitFor()
      const tabs = page.locator('.knowledge-tabs')
      await tabs.getByRole('button', { name: '全部记录' }).click()
      await page.locator('.knowledge-record-title').filter({ hasText: '整理表单校验规则' }).click()
      await tabs.getByRole('button', { name: '想法地球' }).click()
      assert.equal(await detail.inputValue(), '整理表单校验规则', '切回地球应保留基础模块的详情')
      const tagSelect = page.getByRole('combobox', { name: '记录标签' })
      await page.locator('.el-select__wrapper').filter({ has: tagSelect }).click()
      await page.getByRole('option', { name: '基础模块', exact: true }).click()
      await tagSelect.press('Escape')
      await page.locator('.knowledge-editor').waitFor({ state: 'detached' })
      assert.match(await page.locator('.idea-globe-heading').innerText(), /1 个基础模块/, '去除基础模块分类后离开地球')
      assert.deepEqual(errors, [])
      assert.deepEqual(externalRequests, [])
      console.log('通过：想法地球拖动、缩放、点选、关闭详情、明暗主题与窄屏。')
      return
    }
    if (process.argv.includes('--knowledge-only')) {
      await verifyKnowledgeSuggestions(page, navigate)
      assert.deepEqual(await page.evaluate(() => window.__uiUnknown), [], '知识库验收的 IPC 均应有隔离实现')
      assert.deepEqual(errors, [], '知识库验收不能出现运行时错误')
      assert.deepEqual(externalRequests, [], '隔离验收不能访问外部服务')
      console.log('通过：四个项目与两条想法生成建议，截断重试与错误提示、逐条采纳、按项目筛选及来源回看。')
      return
    }
    await page.getByRole('button', { name: '记录与复盘', exact: true }).click()
    await page.locator('.knowledge-context').waitFor()
    assert.equal(await page.locator('.knowledge-context').getByRole('button', { name: '记录项目想法' }).count(), 1, '项目记录保留快捷创建入口')
    await page.locator('.knowledge-context').getByRole('button', { name: '记录项目想法' }).click()
    await page.getByRole('textbox', { name: '快速记录', exact: true }).fill('项目上下文验证想法')
    await page.getByRole('button', { name: '保存快速记录', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.title === '项目上下文验证想法' && row.projectId === 'project-0'))
    await navigate('项目')
    await page.locator('.project-detail-panel').waitFor()
    assert.equal(await page.locator('.project-detail-panel .work-status').count(), 1, '项目概览展示工作状态')
    await navigate('工作台')
    await page.getByRole('button', { name: '查看发布', exact: true }).click()
    await page.locator('.deploy-page').waitFor()
    assert.equal(await page.evaluate(async () => (await import('/src/store.js')).state.projects.currentId), 'project-0', '发布沿用当前项目')
    await navigate('工作台')
    await page.getByRole('button', { name: '继续终端工作', exact: true }).click()
    await page.locator('.terminal-page').waitFor()
    await page.waitForFunction(async () => (await window.gitReport.terminalList()).sessions.some(row => row.projectId === 'project-0'))
    assert.equal(await page.getByRole('button', { name: '返回项目', exact: true }).count(), 0, '终端工作台不显示返回项目')
    await navigate('工作台')
    await page.waitForFunction(() => !document.querySelector('.work-overview .el-alert'))
    assert((await page.locator('.work-status').innerText()).includes('1 个运行中'), '真实终端返回结构正确展示运行会话')
    await page.evaluate(() => { window.__overviewFailTerminal = true })
    await navigate('项目')
    await navigate('工作台')
    await page.getByText('终端状态读取失败', { exact: true }).waitFor()
    await page.evaluate(() => { window.__overviewFailTerminal = false })
    await page.locator('.work-overview .el-alert').getByRole('button', { name: '重试' }).click()
    await page.waitForFunction(() => !document.querySelector('.work-overview .el-alert'))
    await page.evaluate(() => { window.__overviewFailHistory = true })
    await navigate('项目')
    await navigate('工作台')
    await page.getByText('发布历史读取失败', { exact: true }).waitFor()
    await page.evaluate(() => { window.__overviewFailHistory = false })
    await page.locator('.work-overview .el-alert').getByRole('button', { name: '重试' }).click()
    await page.waitForFunction(() => !document.querySelector('.work-overview .el-alert'))
    await page.evaluate(async () => { const { state } = await import('/src/store.js'); window.__overviewProjects = [...state.projects.items]; state.projects.items = []; state.projects.currentId = '' })
    await page.getByRole('button', { name: '创建第一个项目', exact: true }).waitFor()
    await page.evaluate(async () => { const { state } = await import('/src/store.js'); state.projects.items = window.__overviewProjects; state.projects.currentId = 'project-0' })
    if (process.argv.includes('--overview-only')) { console.log('通过：项目工作台默认首页、项目记录归属、发布与终端上下文、项目概览、读取失败重试和空态'); return }
    const deployFlowOnly = process.argv.includes('--deploy-flow-only')
    if (!deployFlowOnly) {
    const pages = [['工作台', 'overview'], ['知识库', 'knowledge'], ['项目', 'projects'], ['DeepSeek Harness', 'harness'], ['终端工作台', 'terminal'], ['一键填报', 'fillreport'], ['部署', 'deploy'], ['扩展管理', 'extensions'], ['设置', 'settings']]
    for (const theme of ['light', 'dark']) {
      await navigate('设置')
      await page.getByRole('tab', { name: '界面', exact: true }).click()
      await page.locator('.theme-options .el-radio-button').filter({ hasText: theme === 'dark' ? '黑色' : '浅色' }).click()
      for (const [width, height] of [[1440, 900], [1280, 720]]) {
        await page.setViewportSize({ width, height })
        for (const [label, name] of pages) {
          await navigate(label)
          if (name === 'settings') {
            for (const section of ['AI 服务', 'Git 活动', '个人身份', '一键填报', '界面', '应用信息']) {
              await page.getByRole('tab', { name: section, exact: true }).click()
              await capture('settings-' + section, theme, width, height)
            }
          } else {
            if (name === 'knowledge') await page.locator('.knowledge-tabs').getByRole('button', { name: '全部记录', exact: true }).click()
            await capture(name, theme, width, height)
            if (name === 'knowledge') {
              await page.locator('.knowledge-record-title').filter({ hasText: '用知识记录积累开发经验' }).click()
              await page.locator('.knowledge-editor').waitFor()
              await capture('knowledge-editor', theme, width, height)
              await page.getByRole('button', { name: '关闭记录详情', exact: true }).click()
            }
            if (name === 'fillreport') {
              await page.getByRole('button', { name: /生成报告|重新生成/ }).click()
              await page.locator('.fill-summary').waitFor()
              await capture('fillreport-generated', theme, width, height)
            }
          }
        }
      }
    }
    for (const [width, height] of [[1920, 1080], [2560, 1440]]) {
      await page.setViewportSize({ width, height })
      for (const [label, name] of [['知识库', 'knowledge'], ['项目', 'projects'], ['终端工作台', 'terminal'], ['部署', 'deploy']]) { await navigate(label); await capture(name, 'dark', width, height) }
    }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await navigate('部署')
    await page.evaluate(async () => {
      const { state } = await import('/src/store.js')
      state.deploy.startedAt = Date.now() - 12500
      state.deploy.finishedAt = 0
      state.deploy.stages = { check: { status: 'success', durationMs: 300 }, package: { status: 'running', durationMs: 0 } }
      state.deploy.packageCount = 42
      state.deploy.running = true
    })
    await page.locator('.run-live').waitFor()
    assert.equal(await page.locator('.run-live-copy strong').textContent(), '项目打包', '发布运行态显示当前阶段')
    assert.equal(await page.locator('.run-live-copy').textContent().then(text => text.includes('已处理 42 个文件')), true, '发布运行态显示真实阶段进度')
    assert.equal(await page.locator('.stages').count(), 0, '运行中以加载动画代替阶段列表')
    if (!deployFlowOnly) await capture('deploy-running', 'dark', 1440, 900)
    await page.evaluate(async () => { const { state } = await import('/src/store.js'); state.deploy.running = false; state.deploy.finishedAt = Date.now() })
    await page.locator('.stages').waitFor()
    interactions.push('发布运行态加载动画与完成后阶段明细')
    await page.evaluate(async () => { const { selectProject } = (await import('/src/composables/useProjects.js')).useProjects(); selectProject('project-0') })
    await page.getByRole('button', { name: '部署设置', exact: true }).click()
    const drawer = page.locator('.deploy-config-drawer')
    const deploymentName = drawer.locator('.f-row .el-input__inner').first()
    await deploymentName.fill('未保存部署草稿')
    await page.keyboard.press('Escape')
    await page.locator('.topbar-project-select').click()
    await page.getByRole('option', { name: projects[1].name, exact: true }).click()
    await page.locator('.topbar-project-select').click()
    await page.getByRole('option', { name: projects[0].name, exact: true }).click()
    await page.getByRole('button', { name: '部署设置', exact: true }).click()
    assert.equal(await deploymentName.inputValue(), '未保存部署草稿', '切换项目保留部署草稿')
    await page.evaluate(async () => {
      const { state } = await import('/src/store.js')
      state.deploy.running = true
    })
    assert.equal(await deploymentName.evaluate(input => !!input.closest('[inert]')), true, '已打开设置在任务运行中不可编辑')
    assert.equal(await drawer.getByRole('button', { name: '保存部署设置', exact: true }).isDisabled(), true, '任务运行中禁止保存')
    assert.equal(await page.getByRole('button', { name: 'AI 部署助手', exact: true }).isDisabled(), true, '任务运行中禁止套用其他方案')
    await page.evaluate(() => window.__uiEmitDeployDone({ projectId: 'project-0', projectName: '隔离项目', status: 'canceled', type: 'deploy' }))
    assert.equal(await deploymentName.inputValue(), '未保存部署草稿', '完成事件重载不覆盖未保存设置')
    await page.keyboard.press('Escape')
    await navigate('项目')
    await navigate('部署')
    await page.getByRole('button', { name: '部署设置', exact: true }).click()
    assert.equal(await deploymentName.inputValue(), '未保存部署草稿', '离开部署页后返回仍保留草稿')
    await drawer.getByRole('button', { name: '保存部署设置', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.deploy-page .bar .el-tag--warning'))
    await page.getByRole('button', { name: '部署设置', exact: true }).click()
    assert.equal(await deploymentName.inputValue(), '未保存部署草稿', '保存后使用落盘配置')
    await deploymentName.fill('应取消的临时修改')
    await drawer.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '部署设置', exact: true }).click()
    assert.equal(await deploymentName.inputValue(), '未保存部署草稿', '取消恢复打开时的配置')
    // 恢复本段夹具，避免保存名称影响后续其他页面的固定项目测试。
    await deploymentName.fill(projects[0].name)
    await drawer.getByRole('button', { name: '保存部署设置', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.deploy-page .bar .el-tag--warning'))
    await page.getByRole('button', { name: /线上 / }).click()
    await page.locator('.rollback-select').click()
    await page.getByRole('option', { name: '1.4.96', exact: true }).click()
    await page.getByRole('button', { name: '回滚到此版本', exact: true }).click()
    await page.getByRole('dialog', { name: '确认回滚', exact: true }).getByRole('button', { name: '回滚', exact: true }).click()
    await page.getByText('隔离回滚健康检查失败，已恢复原服务', { exact: true }).waitFor()
    interactions.push('部署草稿跨项目和导航保留、运行期间禁用配置、完成事件保护及回滚错误提示')
    if (deployFlowOnly) {
      assert.deepEqual(await page.evaluate(() => window.__uiUnknown), [], '部署检查不能出现未建模 IPC')
      assert.deepEqual(errors, [], '部署检查不能出现运行时错误')
      console.log('通过：真实界面部署草稿、运行期保护、完成刷新、保存和失败回滚提示')
      return
    }
    await navigate('知识库')
    await page.locator('.knowledge-tabs').getByRole('button', { name: '想法地球', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '新建想法', exact: true }).count(), 0, '想法只从地球输入框创建');
    assert.equal(await page.getByRole('button', { name: /查看全部记录/ }).count(), 0, '全部记录只通过页签进入');
    const ideaCount = await page.locator('.idea-globe-heading span').textContent()
    await page.getByRole('textbox', { name: '快速记录', exact: true }).fill('快速记录的验证想法')
    await page.getByRole('button', { name: '保存快速记录', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.title === '快速记录的验证想法' && row.type === 'idea' && row.status === 'inbox'))
    assert.equal(await page.locator('.idea-globe-heading span').textContent(), `${Number.parseInt(ideaCount, 10) + 1} 个想法`, '新想法立即进入地球图谱')
    assert.equal(await page.locator('.knowledge-editor').count(), 0, '快速记录后留在地球视图')
    await capture('knowledge-globe', 'dark', 1440, 900)
    const globe = await page.locator('.idea-globe-canvas').boundingBox()
    await page.mouse.click(globe.x + globe.width / 2, globe.y + globe.height * 0.49)
    await page.locator('.knowledge-editor').waitFor()
    assert.equal(await page.getByRole('textbox', { name: '记录标题', exact: true }).inputValue(), '快速记录的验证想法', '点击地球节点打开原有记录详情')
    await page.getByRole('button', { name: '关闭记录详情', exact: true }).click()
    await page.locator('.knowledge-tabs').getByRole('button', { name: '全部记录', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '新建第一条记录', exact: true }).count(), 0, '列表不增加第二个创建入口');
    await page.locator('.knowledge-record-title').filter({ hasText: '快速记录的验证想法' }).click()
    await page.locator('.knowledge-editor').waitFor()
    await page.getByRole('textbox', { name: '记录标题', exact: true }).fill('测试 · 自动保存知识记录')
    await page.getByRole('textbox', { name: '记录正文', exact: true }).fill('自动保存正文。\n\n## 验证结论\n切页与重载后仍保留最新输入。')
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.title === '测试 · 自动保存知识记录' && row.body.includes('切页与重载后仍保留最新输入。') && row.revision > 1))
    const savedId = await page.evaluate(() => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).find(row => row.title === '测试 · 自动保存知识记录').id)
    await navigate('项目')
    await navigate('知识库')
    assert((await page.getByRole('textbox', { name: '记录正文', exact: true }).inputValue()).includes('切页与重载后仍保留最新输入。'), '切页保留同一共享记录')
    unknown.push(...await page.evaluate(() => window.__uiUnknown))
    await page.reload()
    await page.locator('.work-overview').waitFor()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', '主题在重载后恢复')
    await navigate('知识库')
    await page.locator('.knowledge-tabs').getByRole('button', { name: '全部记录', exact: true }).click()
    await page.locator('.knowledge-record-title').filter({ hasText: '测试 · 自动保存知识记录' }).click()
    assert((await page.getByRole('textbox', { name: '记录正文', exact: true }).inputValue()).includes('切页与重载后仍保留最新输入。'), '重载后从持久夹具读取已保存正文')
    interactions.push('知识快速记录、自动保存、切页返回及重载持久化')

    await page.getByRole('button', { name: '记录更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '移至回收站', exact: true }).click()
    await page.waitForFunction(id => !!JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).find(row => row.id === id)?.deletedAt, savedId)
    await page.locator('.knowledge-tabs').getByRole('button', { name: '回收站', exact: true }).click()
    await page.locator('.knowledge-record-title').filter({ hasText: '测试 · 自动保存知识记录' }).click()
    await page.locator('.trash-notice').waitFor()
    assert(await page.getByRole('textbox', { name: '记录标题', exact: true }).getAttribute('readonly') !== null, '回收站记录只读')
    await capture('knowledge-trash', 'dark', 1440, 900)
    await page.getByRole('button', { name: '恢复记录', exact: true }).click()
    await page.waitForFunction(id => !JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).find(row => row.id === id)?.deletedAt, savedId)
    await page.locator('.knowledge-tabs').getByRole('button', { name: '全部记录', exact: true }).click()
    assert.equal(await page.locator('.knowledge-record-title').filter({ hasText: '测试 · 自动保存知识记录' }).count(), 1, '恢复后记录重新进入正常列表')
    interactions.push('知识软删除、回收站只读与恢复')

    await page.locator('.knowledge-record-title').filter({ hasText: '测试 · 自动保存知识记录' }).click()
    await page.getByRole('button', { name: '记录更多操作', exact: true }).click()
    assert.equal(await page.getByRole('menuitem', { name: '永久删除', exact: true }).count(), 0, '正常记录没有永久删除入口')
    await page.getByRole('menuitem', { name: '移至回收站', exact: true }).click()
    await page.waitForFunction(id => !!JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).find(row => row.id === id)?.deletedAt, savedId)
    await page.locator('.knowledge-tabs').getByRole('button', { name: '回收站', exact: true }).click()
    await page.locator('.knowledge-record-title').filter({ hasText: '测试 · 自动保存知识记录' }).click()
    await page.getByRole('button', { name: '记录更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '永久删除', exact: true }).click()
    const purgeDialog = page.getByRole('dialog', { name: '永久删除记录' })
    assert((await purgeDialog.innerText()).includes('无法恢复'))
    await purgeDialog.getByRole('button', { name: '取消', exact: true }).click()
    assert(await page.evaluate(id => JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.id === id), savedId), '取消删除保留原记录')
    await page.getByRole('button', { name: '记录更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '永久删除', exact: true }).click()
    await purgeDialog.getByRole('button', { name: '永久删除', exact: true }).click()
    await page.waitForFunction(id => !JSON.parse(localStorage.getItem('desktop-ui-test-knowledge')).some(row => row.id === id), savedId)
    assert.equal(await page.locator('.knowledge-editor').count(), 0)
    await page.locator('.knowledge-tabs').getByRole('button', { name: '全部记录', exact: true }).click()
    assert.equal(await page.locator('.knowledge-record-title').filter({ hasText: '测试 · 自动保存知识记录' }).count(), 0)
    interactions.push('回收站永久删除确认、取消与成功清理')

    await page.getByRole('textbox', { name: '搜索知识记录', exact: true }).fill('旧响应')
    assert.equal(await page.locator('.knowledge-table .el-table__body tr').count(), 1, '搜索知识标题、正文与标签产生真实筛选')
    await page.getByRole('textbox', { name: '搜索知识记录', exact: true }).fill('')
    assert.equal(await page.getByRole('button', { name: '分析想法', exact: true }).count(), 0, '记录列表不重复提供建议生成入口');
    assert.equal(await page.getByRole('button', { name: '整理所选', exact: true }).count(), 0, '工作台不再提供批量整理');
    assert.equal(await page.locator('.knowledge-table .el-checkbox').count(), 0, '列表移除无用途的批量选择');
    assert.equal(await page.locator('.knowledge-tabs button').count(), 4, '地球、模块与灵感、全部记录和回收站各有一个页签');
    assert.equal((await page.evaluate(() => window.__uiAiRequests)).length, 0, '想法记录不发起 AI 请求');
    await verifyKnowledgeSuggestions(page, navigate)
    interactions.push('普通记录离线保存，主动生成跨项目模块与行动建议、逐条采纳并回看来源')

    await navigate('项目')
    await page.getByRole('option', { name: /Personnel PLM/ }).click()
    assert.equal(await page.locator('.project-capabilities').count(), 0, '项目页签与侧栏不再重复成能力卡片');
    assert.equal(await page.getByRole('button', { name: '新建项目', exact: true }).count(), 1, '项目创建只保留页头入口');
    assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 1, '项目编辑只保留详情页头入口');
    await page.getByRole('tab', { name: '知识记录', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: /记录项目经验|在 AI 工作台查看/ }).count(), 0, '项目知识页不再重复创建或跳转列表');
    await page.getByText('保持知识记录与项目解耦', { exact: true }).click()
    await page.locator('.knowledge-workbench').waitFor()
    assert.equal(await page.getByRole('textbox', { name: '记录标题', exact: true }).inputValue(), '保持知识记录与项目解耦', '项目记录入口打开同一共享知识记录')
    await capture('knowledge-from-project', 'dark', 1440, 900)
    interactions.push('项目记录标签打开共享知识记录')

    await navigate('项目')
    await page.getByRole('textbox', { name: '搜索项目' }).fill('API')
    assert.equal(await page.getByRole('option', { name: /内部 API/ }).count(), 1, '项目搜索保留真实匹配项')
    assert.equal(await page.locator('.project-list-item').count(), 1)
    await page.getByRole('textbox', { name: '搜索项目' }).fill('')
    await page.getByRole('button', { name: '新建项目', exact: true }).click()
    await page.locator('.el-dialog').last().waitFor()
    assert(await page.locator('.el-dialog').getByRole('button', { name: /创建项目/ }).isDisabled(), '空名称不可创建项目')
    await page.screenshot({ path: path.join(OUTPUT, 'dark-project-dialog.png') })
    await page.keyboard.press('Escape')
    await navigate('一键填报')
    await page.getByRole('button', { name: /生成报告|重新生成/ }).click()
    await page.locator('.fill-summary').waitFor()
    const firstProject = page.locator('.prow').filter({ hasText: 'Personnel PLM' })
    await firstProject.locator('.pcheck').click()
    await page.waitForFunction(() => document.querySelector('.summary-total strong')?.textContent.includes('3.00'))
    await firstProject.locator('.pcheck').click()
    await page.waitForFunction(() => document.querySelector('.summary-total strong')?.textContent.includes('8.00'))
    const unboundProject = page.locator('.prow').filter({ hasText: '内部 API 服务' })
    await unboundProject.locator('.pcheck').click()
    await page.waitForFunction(() => document.querySelector('.binding-warning'))
    assert(await page.getByRole('button', { name: '预览提交', exact: true }).isDisabled(), '未绑定项目阻止预览')
    assert(await page.getByRole('button', { name: '一键提交', exact: true }).isDisabled(), '未绑定项目阻止写入')
    await page.getByRole('button', { name: '定位未绑定' }).click()
    await page.getByRole('textbox', { name: '搜索禅道任务' }).fill('1042')
    assert.equal(await page.locator('.bind-task').count(), 1, '绑定抽屉搜索真实任务')
    await page.screenshot({ path: path.join(OUTPUT, 'dark-fill-bind-drawer.png') })
    await page.keyboard.press('Escape')
    await navigate('扩展管理')
    assert.equal(await page.locator('.ext-selection-bar, .ext-context-menu').count(), 0, '扩展统一使用行操作菜单');
    await page.getByRole('textbox', { name: '搜索扩展' }).fill('git-commit')
    assert.equal(await page.locator('.ext-table-wrap .el-table__body tr').count(), 1, '扩展搜索必须真正过滤')
    await page.getByRole('button', { name: '操作 git-commit', exact: true }).click()
    await page.getByRole('menuitem', { name: '查看 SKILL.md', exact: true }).click()
    await page.locator('.skill-doc').waitFor()
    assert((await page.locator('.skill-doc').innerText()).includes('git-commit'))
    await page.keyboard.press('Escape')
    unknown.push(...await page.evaluate(() => window.__uiUnknown))
    await page.reload()
    await page.locator('.work-overview').waitFor()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', '主题在重载后恢复')
    unknown.push(...await page.evaluate(() => window.__uiUnknown))
    assert.deepEqual(unknown, [], '所有测试 IPC 都应明确建模')
    assert.deepEqual(errors, [], '页面不能发生运行时错误')
    assert.deepEqual(externalRequests, [], '测试不能访问外部服务')
    fs.writeFileSync(path.join(OUTPUT, 'verification.json'), JSON.stringify({ timestamp: new Date().toISOString(), checks, interactions, errors, unknown, externalRequests, screenshots: checks.length + 2 }, null, 2))
    console.log(`通过：${checks.length} 个页面/主题/尺寸检查，想法地球与记录保存、项目与扩展交互、填报门禁和主题重载；截图：${OUTPUT}`)
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(OUTPUT, 'failure.png') }).catch(() => {})
      unknown.push(...await page.evaluate(() => window.__uiUnknown || []).catch(() => []))
    }
    fs.writeFileSync(path.join(OUTPUT, 'verification.json'), JSON.stringify({ timestamp: new Date().toISOString(), failure: error.message, checks, interactions, errors, unknown, externalRequests }, null, 2))
    throw error
  } finally {
    if (browser) await browser.close().catch(() => {})
    server.kill()
    if (errors.length) console.error(JSON.stringify(errors, null, 2))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
