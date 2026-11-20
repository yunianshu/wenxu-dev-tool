/** 运行实际 Vue setup/watch 和配置存储，仅替换 IPC、确认框及系统加密边界。 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { parse, compileScript } = require('@vue/compiler-sfc')
const { transformSync } = require('esbuild')
const vue = require('vue')

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const settle = () => new Promise(setImmediate)

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-state-selftest-'))
  const modules = new Map()
  const events = new Map()
  const apps = []
  const errors = []
  let confirmation = deferred()
  const originalWindow = global.window
  const originalRaf = global.requestAnimationFrame
  const element = {
    ElMessage: { error: (message) => errors.push(message), success() {}, warning() {}, info() {} },
    ElMessageBox: { confirm: () => confirmation.promise, alert: async () => {} },
    ElNotification() {}, ElCheckbox: {},
  }
  const electron = {
    app: { getPath: () => root },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(`测试密文:${text}`), decryptString: (buffer) => buffer.toString().replace(/^测试密文:/, '') },
  }
  function load(relative) {
    const filename = path.resolve(__dirname, '..', relative)
    if (modules.has(filename)) return modules.get(filename).exports
    const mod = new Module(filename, module)
    modules.set(filename, mod)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(path.dirname(filename))
    mod.require = (id) => {
      if (id === 'element-plus') return element
      if (id === 'electron') return electron
      if (id === '@element-plus/icons-vue') return {}
      if (id.endsWith('.vue')) return {}
      if (id.startsWith('.')) {
        let file = path.resolve(path.dirname(filename), id)
        if (!path.extname(file)) file += '.js'
        return load(path.relative(path.resolve(__dirname, '..'), file))
      }
      return Module.prototype.require.call(mod, id)
    }
    let source = fs.readFileSync(filename, 'utf8')
    if (filename.endsWith('.vue')) {
      const { descriptor, errors: parseErrors } = parse(source, { filename })
      assert.equal(parseErrors.length, 0)
      source = compileScript(descriptor, { id: filename }).content
    }
    mod._compile(transformSync(source, { format: 'cjs', target: 'node20' }).code, filename)
    return mod.exports
  }
  const renderer = vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
  function mount(file, props = {}) {
    let setup
    const emits = []
    const component = load(file).default
    const app = renderer.createApp({ setup() {
      setup = component.setup(props, { expose() {}, emit: (...args) => emits.push(args) })
      return () => null
    } })
    app.mount({})
    apps.push(app)
    return { setup, emits, unmount: () => { app.unmount(); apps.splice(apps.indexOf(app), 1) } }
  }
  const subscribe = (name) => (fn) => {
    if (!events.has(name)) events.set(name, new Set())
    events.get(name).add(fn)
    return () => events.get(name).delete(fn)
  }
  const notify = async (name, payload) => Promise.all([...(events.get(name) || [])].map((fn) => fn(payload)))
  const store = load('electron/store.js')
  const { state, beginDeployRun, deployOnlineVersion, setDeployOnlineVersion } = load('src/store.js')
  const { emptyProject, emptyTarget } = load('src/components/deploy/deploy-form.js')
  const projects = ['A', 'B'].map((id) => ({ ...emptyProject(), id, name: `项目 ${id}`, localPath: `/project/${id}`, deployMode: 'docker', version: { strategy: 'manual', manual: '1.0.0' }, targets: ['test', 'production'].map((tid) => ({ ...emptyTarget(), id: tid, name: tid, server: { host: 'example.invalid' }, remotePath: `/apps/${id}/${tid}` })) }))
  const api = {
    projectsList: async () => projects,
    debugStatus: async () => ({ hasStartBat: false }),
    deployHistoryList: async () => [],
    deployServersList: async () => [],
    deployDetectVersion: async () => ({ version: '1.0.0' }),
    configLoad: async () => store.load(),
    configSave: async (payload) => store.save(payload),
    aiModels: async () => ({ ok: true, models: ['测试模型'] }),
    getIdentity: async () => ({ name: '', email: '' }),
    winIsFullScreen: async () => false,
    uiPrefsLoad: async () => ({}),
    harnessUpdateStatus: async () => ({}),
    reposSnapshot: async () => [], warmup: async () => [],
    appUiReady() {},
  }
  for (const name of ['onScanProgress', 'onScanRepoFound', 'onScanDone', 'onCollectProgress', 'onDeployStatus', 'onDeployLog', 'onDeployStage', 'onDeployProgress', 'onDeployDone', 'onWinFullscreen', 'onWinAskClose', 'onHarnessUpdate']) api[name] = subscribe(name)
  global.window = { gitReport: api }
  global.requestAnimationFrame = (fn) => queueMicrotask(fn)
  try {
    const projectApi = load('src/composables/useProjects.js').useProjects()
    state.projects.items = projects
    state.projects.currentId = 'A'
    let pendingList = deferred()
    let listCalls = 0
    api.projectsList = () => { listCalls += 1; return pendingList.promise }
    const loadA = projectApi.loadProjects()
    const loadAgain = projectApi.loadProjects()
    assert.equal(loadA, loadAgain, '并发加载共享同一个等待结果')
    projectApi.selectProject('B')
    pendingList.resolve(projects)
    await Promise.all([loadA, loadAgain])
    assert.equal(listCalls, 1)
    assert.equal(state.projects.currentId, 'B', '请求发起后切换项目不能被旧选择覆盖')
    assert.equal(state.deploy.currentProjectId, 'B')
    api.projectsList = async () => projects
    const projectView = mount('src/views/ProjectsView.vue')
    projectView.setup.openInWorkbench()
    assert.equal(state.terminal.pendingFocusProjectId, 'B')
    assert.deepEqual(projectView.emits.find((event) => event[0] === 'navigate'), ['navigate', 'terminal'])
    projectView.unmount()
    console.log('  ✓ 项目加载共享等待并保留最新选择，项目页正常跳转终端工作台')

    // 记住上次选中的项目：偏好里的 ID 还在列表里就按它恢复，已删除才回落第一个
    const savedSelections = []
    api.uiPrefsSave = async (payload) => { savedSelections.push(payload); return { ok: true, prefs: payload } }
    api.uiPrefsLoad = async () => ({ lastProjectId: 'B' })
    state.projects.currentId = ''
    state.ui.lastProjectId = ''
    await projectApi.loadProjects()
    assert.equal(state.projects.currentId, 'B', '启动时应恢复上次选中的项目')
    assert.equal(savedSelections.length, 0, '选中未变化不应重复落盘')
    api.projectsList = async () => [projects[0]]
    await projectApi.loadProjects()
    assert.equal(state.projects.currentId, 'A', '记住的项目已删除时回落到第一个项目')
    assert.equal(savedSelections.at(-1)?.lastProjectId, 'A', '回落结果应写回偏好')
    api.projectsList = async () => projects
    projectApi.selectProject('B')
    assert.equal(savedSelections.at(-1)?.lastProjectId, 'B', '切换项目应立即写回偏好')
    api.uiPrefsLoad = async () => ({})
    console.log('  ✓ 项目选中按上次偏好恢复，删除后回落，切换即时落盘')

    const releaseCalls = []
    const rollbackCalls = []
    api.deployReleases = (...args) => { const pending = deferred(); releaseCalls.push({ args, ...pending }); return pending.promise }
    api.deployRollback = async (projectId, targetId, version, requestId) => {
      rollbackCalls.push({ projectId, targetId, version, requestId })
      return { ok: true, record: { type: 'rollback', projectId, targetId, version, status: 'success' } }
    }
    const panelProps = vue.reactive({ form: { ...projects[0] }, activeTarget: projects[0].targets[0], activeTargetId: 'test', publishVersion: '1.0.0', dirty: false })
    const panel = mount('src/components/deploy/DeployRunPanel.vue', panelProps)
    const query = () => { const pending = panel.setup.queryReleases(); return { done: pending, request: releaseCalls.at(-1) } }
    let request = query()
    panelProps.form.id = 'B'
    request.request.resolve({ ok: true, current: 'A-旧版本', releases: ['A-旧版本'] })
    await request.done
    assert.equal(deployOnlineVersion('A', 'test'), '')
    assert.equal(panel.setup.releases.value.length, 0)
    request = query()
    panelProps.activeTargetId = 'production'
    request.request.resolve({ ok: true, current: 'test-旧版本', releases: ['test-旧版本'] })
    await request.done
    assert.equal(deployOnlineVersion('B', 'test'), '')
    request = query()
    panelProps.form.id = 'A'
    panelProps.form.id = 'B'
    request.request.resolve({ ok: true, current: 'ABA-旧版本', releases: ['ABA-旧版本'] })
    await request.done
    assert.equal(deployOnlineVersion('B', 'production'), '', '同轮同步 B→A→B 也必须作废旧请求')
    const older = query()
    const newer = query()
    newer.request.resolve({ ok: true, current: '2.0.0', releases: ['2.0.0'] })
    await newer.done
    older.request.resolve({ ok: true, current: '1.0.0', releases: ['1.0.0'] })
    await older.done
    assert.equal(deployOnlineVersion('B', 'production'), '2.0.0')
    assert.deepEqual([...panel.setup.releases.value], ['2.0.0'])
    confirmation = deferred()
    const canceledRollback = panel.setup.doRollback('1.0.0')
    panelProps.form.id = 'A'
    confirmation.resolve()
    await canceledRollback
    assert.equal(rollbackCalls.length, 0, '确认期间切换项目不得回滚')
    confirmation = deferred()
    const validRollback = panel.setup.doRollback('1.1.0')
    confirmation.resolve()
    await validRollback
    const { requestId, ...rollbackCall } = rollbackCalls[0]
    assert.ok(requestId)
    assert.deepEqual(rollbackCall, { projectId: 'A', targetId: 'production', version: '1.1.0' })
    assert.equal(deployOnlineVersion('A', 'production'), '1.1.0')
    const unmountedQuery = query()
    panel.unmount()
    unmountedQuery.request.resolve({ ok: true, current: '卸载后迟到版本', releases: [] })
    await unmountedQuery.done
    assert.equal(deployOnlineVersion('A', 'production'), '1.1.0')
    console.log('  ✓ 发布查询隔离项目、目标、ABA和请求先后，回滚绑定确认时的目标')

    state.config = store.load()
    const settings = mount('src/views/SettingsView.vue', vue.reactive({ initialSection: 'ai' }))
    const credentials = [
      { section: 'ai', field: 'apiKey', input: settings.setup.apiKeyInput, flag: 'clearKey', read: store.getApiKey, value: '测试 AI 密钥' },
      { section: 'zentao', field: 'password', input: settings.setup.ztPwdInput, flag: 'clearPwd', read: store.getZentaoPwd, value: '测试禅道密码' },
      { section: 'hanprint', field: 'password', input: settings.setup.hpPwdInput, flag: 'clearPwd', read: store.getHanprintPwd, value: '测试汉印密码' },
    ]
    for (const item of credentials) item.input.value = item.value
    await settings.setup.saveConfig()
    for (const item of credentials) {
      assert.equal(item.read(), item.value)
      assert.equal(item.input.value, '')
      assert(!Object.hasOwn(state.config[item.section], item.field), '共享配置不得保留明文')
      assert(await settings.setup.saveClearConfig(item.section, item.flag))
      assert.equal(item.read(), '', `${item.section} 保存后应能清除`)
    }
    for (const item of credentials) {
      const payload = store.load()
      payload[item.section][item.field] = '旧明文测试占位'
      payload[item.section][item.flag] = true
      assert(store.save(payload))
      assert.equal(item.read(), '', '清除标志应优先于载荷中的旧明文')
    }
    api.configSave = async () => ({ ok: false, error: '模拟磁盘写入失败' })
    for (const item of credentials) item.input.value = `待重试${item.value}`
    await settings.setup.saveConfig()
    for (const item of credentials) assert.equal(item.input.value, `待重试${item.value}`)
    assert(errors.some((message) => message.includes('模拟磁盘写入失败')))
    api.configSave = async (payload) => store.save(payload)
    settings.unmount()
    console.log('  ✓ 三种凭据真实临时存储可保存再清除，清除优先且保存失败保留输入')

    state.projects.currentId = 'A'
    state.config = store.load()
    const shell = mount('src/App.vue')
    await settle()
    assert.equal(events.get('onDeployDone')?.size, 1, '应用应完成全局事件接线')
    const deployView = mount('src/views/DeployView.vue')
    await settle()
    assert.equal(deployView.setup.form.id, 'A')
    const overview = mount('src/components/deploy/DeployActiveReleases.vue')
    assert.equal(overview.setup.tasks.value.length, 0)
    const targetId = deployView.setup.activeTargetId.value
    const publishPanel = mount('src/components/deploy/DeployRunPanel.vue', vue.reactive({
      form: deployView.setup.form, activeTarget: deployView.setup.activeTarget,
      activeTargetId: deployView.setup.activeTargetId, publishVersion: '1.0.0', dirty: false,
    }))
    const publishRequests = new Map()
    api.deployRun = (projectId, tid, requestId, releasePlan) => {
      const task = { ...deferred(), projectId, targetId: tid, requestId, releasePlan, runId: `run-${projectId}` }
      publishRequests.set(projectId, task)
      return task.promise
    }
    const start = async (projectId, queued = false) => {
      confirmation = deferred()
      const finished = publishPanel.setup.publish()
      confirmation.resolve()
      await settle()
      const task = publishRequests.get(projectId)
      assert.ok(task?.requestId, '应通过所选项目调用发布入口')
      const { requestId, targetId, runId } = task
      const event = { projectId, requestId, targetId, runId }
      await notify('onDeployStatus', { ...event, queued, type: 'deploy', targetName: targetId, startedAt: Date.now() })
      await notify('onDeployLog', { ...event, text: `日志 ${projectId}` })
      await notify('onDeployStage', { ...event, stage: 'upload', status: 'running' })
      await notify('onDeployProgress', { ...event, kind: 'upload', percent: projectId === 'A' ? 50 : 20 })
      return { event, task, finished }
    }
    const complete = async (event, version, status = 'success') => {
      const record = { ...event, id: event.runId, type: 'deploy', projectName: event.projectId, version, durationMs: 1, status }
      await notify('onDeployDone', { ...event, record })
      return record
    }
    const a = await start('A')
    await notify('onDeployStage', { ...a.event, stage: 'check', status: 'success' })
    await notify('onDeployStage', { ...a.event, stage: 'package', status: 'skipped' })
    assert.equal(publishPanel.setup.run.value.logs[0].text, '日志 A')
    assert.equal(publishPanel.setup.run.value.uploadPercent, 50)
    const cancelCalls = []
    api.deployCancel = async (...args) => { cancelCalls.push(args); return { ok: true } }
    confirmation = deferred()
    const cancel = publishPanel.setup.cancelRun()
    projectApi.selectProject('B')
    await settle()
    confirmation.resolve()
    await cancel
    assert.deepEqual(cancelCalls, [['A', 'run-A']], '切换项目后取消仍绑定确认时的任务')
    assert.equal(publishPanel.setup.canPublish.value, true)
    const b = await start('B', true)
    assert.equal(publishPanel.setup.runTitle.value, '排队中')
    assert.equal(publishPanel.setup.run.value.logs[0].text, '日志 B')
    const [active, queued] = overview.setup.tasks.value
    assert.equal(active.name, '项目 A', '切换到 B 后仍可查看 A')
    assert.equal(active.run.targetName, a.event.targetId)
    assert.equal(active.progress.activeStage.label, '上传文件')
    assert.equal(active.progress.detail, '已上传 50%')
    assert.equal(active.progress.doneCount, 2)
    assert.equal(queued.name, '项目 B')
    assert.equal(overview.setup.queuedCount.value, 1)
    const aRecord = await complete(a.event, '3.0.0')
    assert.deepEqual(overview.setup.tasks.value.map(({ projectId }) => projectId), ['B'], '结束的任务自动移出列表')
    await notify('onDeployStatus', { ...b.event, queued: false, targetName: b.event.targetId, startedAt: Date.now() })
    await notify('onDeployProgress', { ...b.event, kind: 'upload', percent: 65 })
    assert.equal(overview.setup.queuedCount.value, 0)
    assert.equal(overview.setup.tasks.value[0].progress.detail, '已上传 65%')
    assert.equal(publishPanel.setup.run.value.running, true, '后台项目完成不得解除当前项目排队或执行态')
    assert.equal(publishPanel.setup.run.value.uploadPercent, 65)
    assert.equal(deployOnlineVersion('A', targetId), '3.0.0')
    assert.equal(deployOnlineVersion('B', b.event.targetId), '')
    a.task.resolve({ ok: true, record: aRecord })
    await a.finished
    projectApi.selectProject('A')
    await settle()
    assert.equal(publishPanel.setup.run.value.logs[0].text, '日志 A', '切回项目保留对应日志')
    assert.equal(publishPanel.setup.run.value.running, false)
    const retry = beginDeployRun('A', 'deploy', targetId)
    await notify('onDeployDone', { ...a.event, record: aRecord })
    assert.equal(retry.running, true, '上一轮的完成通知不得结束新任务')
    state.deploy.runs.delete('A')
    b.task.resolve({ ok: false, record: await complete(b.event, '1.0.0', 'canceled') })
    await b.finished
    assert.equal(overview.setup.tasks.value.length, 0)
    overview.unmount()
    console.log('  ✓ 部署页跨项目同步发布与排队、阶段和上传进度，结束后移出列表')

    publishRequests.clear()
    // 清除前一组模拟数据产生的草稿，从已保存配置开始。
    delete state.deploy.configDrafts.A
    delete state.deploy.configDrafts.B
    const running = beginDeployRun('A', 'deploy', 'production')
    const addProps = vue.reactive({
      modelValue: true,
      currentProjectId: 'A', currentTargetId: 'production', currentDirty: false,
    })
    const add = mount('src/components/deploy/DeployAddPublish.vue', addProps)
    assert.equal(add.setup.canSubmit.value, false, '未选择项目不能发布')
    assert.equal(add.setup.projectOptions.value.find((option) => option.id === 'A').disabled, true, '运行中的项目不可重复提交')
    add.setup.projectId.value = 'A'
    assert.equal(add.setup.canSubmit.value, false)
    add.setup.projectId.value = 'B'
    assert.equal(publishRequests.size, 0, '选择项目时不得提交')
    add.setup.targetId.value = 'production'
    add.setup.versionOverride.value = '../invalid'
    add.setup.submit()
    assert.equal(publishRequests.size, 0, '版本不合法时继续停留在弹窗')
    add.setup.versionOverride.value = '2.3.4'
    assert.equal(add.setup.canSubmit.value, true, add.setup.issue.value)
    add.setup.submit()
    add.setup.submit()
    assert.deepEqual([...publishRequests.keys()], ['B'], '一次只提交一个项目，重复点击不会提交第二次')
    assert.equal(publishRequests.get('B').targetId, 'production')
    assert.equal(publishRequests.get('B').releasePlan.versionOverride, '2.3.4')
    assert.equal(running.running, true, '增加发布时已有任务应继续运行')
    assert.equal(state.projects.currentId, 'A', '提交其他项目后保留页面当前项目')
    assert.deepEqual(add.emits, [['update:modelValue', false]])
    addProps.modelValue = false
    await settle()
    addProps.modelValue = true
    await settle()
    assert.equal(add.setup.projectId.value, '', '重新打开弹窗从空选项开始')
    assert.equal(add.setup.versionOverride.value, '', '重新打开弹窗清空上次输入的版本')
    assert.equal(add.setup.projectOptions.value.find((option) => option.id === 'B').disabled, true, '刚提交的项目不可重复添加')
    publishRequests.get('B').resolve({ ok: false })
    state.deploy.runs.delete('A')
    await settle()
    add.setup.projectId.value = 'A'
    assert.equal(add.setup.targetId.value, 'production', '当前项目带入页面当前环境')
    add.setup.submit()
    assert.equal(publishRequests.get('A').releasePlan.versionOverride, '')
    assert.equal(publishRequests.get('A').releasePlan.expectedVersion, '1.0.0')
    publishRequests.get('A').resolve({ ok: false })
    await settle()
    add.unmount()
    publishPanel.unmount()
    console.log('  ✓ 发布隔离进度与取消，增加发布一次提交一个项目并保留已有任务')

    // 页面加载后磁盘配置可能被外部修复；切换版本不得用旧表单覆盖准备命令。
    const deployProjects = load('electron/deploy/deploy-projects.js')
    const previousList = api.projectsList
    const previousSave = api.deployProjectsSave
    const versionSaves = []
    try {
      assert(deployProjects.save({ ...projects[0], configMode: 'manual' }).ok)
      api.projectsList = async () => deployProjects.list()
      api.deployProjectsSave = async (payload) => {
        versionSaves.push(structuredClone(payload))
        return deployProjects.save(payload)
      }
      delete state.deploy.configDrafts.A
      await deployView.setup.loadProjects()
      deployView.setup.activeTargetId.value = 'production'
      assert.equal(deployView.setup.form.docker.prepareCommand, '')
      assert.equal(deployView.setup.dirty.value, false, '复现起点为已保存且无草稿的旧页面')
      const fresh = deployProjects.list().find((project) => project.id === 'A')
      fresh.docker = { requireReleaseEvidence: true, prepareCommand: 'node scripts/release/prepare.cjs --version {version}', prepareTimeoutSec: 1200 }
      fresh.composeFile = 'compose.production.yml'
      fresh.targets[0].health.url = 'http://127.0.0.1:9000/health'
      fresh.targets[0].dataSync.importSecret = '测试导入凭据'
      const sharedServer = deployProjects.listServers().find((server) => server.id === fresh.targets[0].serverId)
      assert(deployProjects.saveServer({ ...sharedServer, secret: '测试服务器凭据' }).ok)
      assert(deployProjects.save(fresh).ok)
      const readRaw = () => JSON.parse(fs.readFileSync(path.join(root, 'deploy-projects.json'), 'utf8')).projects.find((project) => project.id === 'A')
      const beforeVersion = readRaw()
      const serversBeforeVersion = JSON.parse(fs.readFileSync(path.join(root, 'deploy-projects.json'), 'utf8')).servers
      await deployView.setup.onNewVersion('1.1.63')
      const afterVersion = readRaw()
      assert.equal(afterVersion.docker.prepareCommand, fresh.docker.prepareCommand, '新版本操作必须保留磁盘上的准备命令，不能由旧表单清空')
      assert.equal(afterVersion.version.manual, '1.1.63')
      assert.equal(afterVersion.version.strategy, 'manual')
      const withoutVersion = (project) => {
        const copy = structuredClone(project)
        delete copy.version
        delete copy.updatedAt
        return copy
      }
      assert.deepEqual(withoutVersion(afterVersion), withoutVersion(beforeVersion), '切换版本必须完整保留部署参数和存储凭据')
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'deploy-projects.json'), 'utf8')).servers, serversBeforeVersion, '共享服务器密文必须原样保留')
      assert.equal(deployProjects.getCredentials('A', 'test').password, '测试服务器凭据')
      assert.equal(deployProjects.getDataSyncCredentials('A', 'test'), '测试导入凭据')
      assert.deepEqual(Object.keys(versionSaves[0]).sort(), ['id', 'version'], '版本操作只提交项目标识和版本')
      assert.equal(deployView.setup.form.docker.prepareCommand, fresh.docker.prepareCommand, '保存后页面必须回填最新准备命令')
      assert.equal(deployView.setup.activeTargetId.value, 'production', '切换版本保留当前环境')

      const oldVersion = deployView.setup.form.version.manual
      deployView.setup.form.name = '尚未保存的项目名称'
      await deployView.setup.onNewVersion('1.1.64')
      assert.equal(versionSaves.length, 1, '有未保存编辑时不能通过版本操作隐式保存整份配置')
      assert.equal(deployView.setup.form.name, '尚未保存的项目名称', '未保存编辑必须保留')
      deployView.setup.form.name = afterVersion.name
      api.deployProjectsSave = async () => ({ ok: false, error: '模拟版本保存失败' })
      await deployView.setup.onNewVersion('1.1.64')
      assert.equal(deployView.setup.form.version.manual, oldVersion, '保存失败不能把页面版本提前切换')
      assert(errors.includes('模拟版本保存失败'))
      assert.equal(deployProjects.save({ id: 'A', version: { strategy: 'manual', manual: '../bad' } }).ok, false, '非法版本必须在写入前拒绝')
      assert.equal(deployProjects.save({ id: 'missing-project', version: { strategy: 'manual', manual: '1.1.64' } }).ok, false, '版本操作不能新建缺少配置的项目')
      assert.equal(readRaw().version.manual, '1.1.63')
    } finally {
      api.projectsList = previousList
      if (previousSave) api.deployProjectsSave = previousSave
      else delete api.deployProjectsSave
      delete state.deploy.configDrafts.A
      await deployView.setup.loadProjects()
    }
    console.log('  ✓ 真实旧表单切换版本只更新版本，保留最新准备命令、配置、凭据和环境，失败保留原版本')

    // 本段验证「自动发布模式」换服务器清探测：新项目默认极简配置（quick 保留用户填写的
    // 项目地址），显式切回完整配置 + 自动发布以保持既有语义
    deployView.setup.form.configMode = 'manual'
    deployView.setup.form.deployMode = 'auto'
    const serverTarget = deployView.setup.form.targets[0]
    Object.assign(serverTarget, { serverId: 'shared', server: { host: 'old.example.invalid', port: 22, username: 'root' }, remotePath: '/old/app', autoSudo: true, autoDb: { enabled: true }, autoHealth: { enabled: true } })
    const manualHealth = JSON.stringify(serverTarget.health)
    const drawer = mount('src/components/deploy/DeployConfigDrawer.vue', { form: deployView.setup.form, modelValue: true, activeTargetId: serverTarget.id, servers: [], projects: [] })
    drawer.setup.rebaseline()
    deployView.setup.configDrawerRef.value = drawer.setup
    api.deployServersList = async () => [{ id: 'shared', host: 'new.example.invalid', port: 22, username: 'deployer' }]
    await deployView.setup.onServersChanged()
    assert.equal(serverTarget.remotePath, '')
    assert(!serverTarget.autoDb && !serverTarget.autoHealth && !serverTarget.autoSudo)
    drawer.setup.cancelEdit()
    const restoredTarget = deployView.setup.form.targets[0]
    assert.equal(restoredTarget.server.host, 'new.example.invalid')
    assert.equal(restoredTarget.remotePath, '')
    assert(!restoredTarget.autoDb && !restoredTarget.autoHealth && !restoredTarget.autoSudo, '取消抽屉不能复活旧服务器探测结果')
    assert.equal(JSON.stringify(restoredTarget.health), manualHealth)
    drawer.unmount()
    console.log('  ✓ 修改共享服务器同步清除表单与取消快照中的旧探测，保留手动项目策略')
    const pendingRefresh = deferred()
    api.projectsList = () => pendingRefresh.promise
    const late = beginDeployRun('A', 'deploy', targetId)
    const oldCompletion = complete({ projectId: 'A', targetId, runId: 'late-A', requestId: late.requestId }, '旧页面迟到版本')
    await Promise.resolve()
    deployView.unmount()
    state.projects.currentId = 'B'
    setDeployOnlineVersion('B', targetId, '新页面版本')
    pendingRefresh.resolve(projects)
    await oldCompletion
    assert.equal(deployOnlineVersion('B', targetId), '新页面版本', '已卸载部署页面的完成刷新不能污染新页面')
    shell.unmount()
    console.log('  ✓ 发布完成按项目和目标保留线上版本，卸载页面不影响其他项目')
  } finally {
    for (const app of apps) app.unmount()
    global.window = originalWindow
    global.requestAnimationFrame = originalRaf
    const resolved = path.resolve(root)
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('ui-state-selftest-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
