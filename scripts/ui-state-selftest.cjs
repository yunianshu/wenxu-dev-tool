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
  const { state } = load('src/store.js')
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
  for (const name of ['onScanProgress', 'onScanRepoFound', 'onScanDone', 'onCollectProgress', 'onDeployLog', 'onDeployStage', 'onDeployProgress', 'onDeployDone', 'onWinFullscreen', 'onWinAskClose', 'onHarnessUpdate']) api[name] = subscribe(name)
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

    const releaseCalls = []
    const rollbackCalls = []
    api.deployReleases = (...args) => { const pending = deferred(); releaseCalls.push({ args, ...pending }); return pending.promise }
    api.deployRollback = async (...args) => { rollbackCalls.push(args); return { ok: true } }
    const panelProps = vue.reactive({ form: { ...projects[0] }, activeTarget: projects[0].targets[0], activeTargetId: 'test', publishVersion: '1.0.0', dirty: false })
    const panel = mount('src/components/deploy/DeployRunPanel.vue', panelProps)
    const query = () => { const pending = panel.setup.queryReleases(); return { done: pending, request: releaseCalls.at(-1) } }
    let request = query()
    panelProps.form.id = 'B'
    request.request.resolve({ ok: true, current: 'A-旧版本', releases: ['A-旧版本'] })
    await request.done
    assert.equal(state.deploy.currentVersion, '')
    assert.equal(panel.setup.releases.value.length, 0)
    request = query()
    panelProps.activeTargetId = 'production'
    request.request.resolve({ ok: true, current: 'test-旧版本', releases: ['test-旧版本'] })
    await request.done
    assert.equal(state.deploy.currentVersion, '')
    request = query()
    panelProps.form.id = 'A'
    panelProps.form.id = 'B'
    request.request.resolve({ ok: true, current: 'ABA-旧版本', releases: ['ABA-旧版本'] })
    await request.done
    assert.equal(state.deploy.currentVersion, '', '同轮同步 B→A→B 也必须作废旧请求')
    const older = query()
    const newer = query()
    newer.request.resolve({ ok: true, current: '2.0.0', releases: ['2.0.0'] })
    await newer.done
    older.request.resolve({ ok: true, current: '1.0.0', releases: ['1.0.0'] })
    await older.done
    assert.equal(state.deploy.currentVersion, '2.0.0')
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
    assert.deepEqual(rollbackCalls[0], ['A', 'production', '1.1.0'])
    assert.equal(state.deploy.currentVersion, '1.1.0')
    const unmountedQuery = query()
    panel.unmount()
    unmountedQuery.request.resolve({ ok: true, current: '卸载后迟到版本', releases: [] })
    await unmountedQuery.done
    assert.equal(state.deploy.currentVersion, '1.1.0')
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
    state.deploy.currentVersion = '当前选择版本'
    state.deploy.running = true
    await notify('onDeployDone', { record: { type: 'deploy', projectId: 'B', targetId: 'test', version: '后台项目版本', status: 'success' } })
    assert.equal(state.deploy.running, false)
    assert(state.deploy.finishedAt > 0)
    assert.equal(state.deploy.currentVersion, '当前选择版本', '全局完成事件不能修改当前项目线上版本')
    const deployView = mount('src/views/DeployView.vue')
    await settle()
    assert.equal(deployView.setup.form.id, 'A')
    const targetId = deployView.setup.activeTargetId.value
    const done = (projectId, tid, version) => notify('onDeployDone', { record: { type: 'deploy', projectId, targetId: tid, projectName: projectId, version, durationMs: 1, status: 'success' } })
    state.deploy.currentVersion = '保持当前版本'
    await done('B', targetId, '其它项目版本')
    assert.equal(state.deploy.currentVersion, '保持当前版本')
    await done('A', targetId === 'test' ? 'production' : 'test', '其它环境版本')
    assert.equal(state.deploy.currentVersion, '保持当前版本')
    await done('A', targetId, '3.0.0')
    assert.equal(state.deploy.currentVersion, '3.0.0')
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
    const oldCompletion = done('A', targetId, '旧页面迟到版本')
    await Promise.resolve()
    deployView.unmount()
    state.projects.currentId = 'B'
    state.deploy.currentVersion = '新页面版本'
    pendingRefresh.resolve(projects)
    await oldCompletion
    assert.equal(state.deploy.currentVersion, '新页面版本', '已卸载部署页面的完成刷新不能污染新页面')
    shell.unmount()
    console.log('  ✓ 全局发布完成只收尾运行，部署页仅更新匹配项目和目标的线上版本')
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
