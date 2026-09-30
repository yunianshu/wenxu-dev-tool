/** 隔离验证多配置迁移、编辑、切换及凭据隔离，不访问用户配置。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const storePath = path.resolve(__dirname, '../electron/store.js')
const realRequire = createRequire(storePath)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-ai-profiles-'))
async function main() {
try {
  for (const nodeBackend of [false, true]) {
    const secrets = new Map()
    let available = true
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(storePath, 'utf8'), {
      module, exports: module.exports, Buffer, console,
      process: { env: { PLM_NODE_BACKEND: nodeBackend ? '1' : '0' }, platform: process.platform },
      require(id) {
        if (id === 'electron') return {
          app: { getPath: () => dir },
          safeStorage: {
            isEncryptionAvailable: () => available,
            encryptString: value => Buffer.from(`加密:${value}`),
            decryptString: value => value.toString().slice(3),
          },
        }
        if (id === '@napi-rs/keyring') return { Entry: class {
          constructor(service, id) { this.id = id }
          setPassword(value) { secrets.set(this.id, value) }
          getPassword() { return secrets.get(this.id) }
          deletePassword() { secrets.delete(this.id) }
        } }
        if (id === './legacy-safe-storage') return { migrateLegacyConfig() {} }
        return realRequire(id)
      },
    }, { filename: storePath })
    const store = module.exports
    const configPath = path.join(dir, 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({ ai: { baseUrl: 'https://legacy.invalid/v1', model: 'old', apiKey: 'legacy-secret' } }))
    let cfg = store.load()
    assert.equal(cfg.ai.activeProfileId, 'default')
    assert.equal(cfg.ai.name, '默认配置')
    assert.equal(cfg.ai.profiles.length, 1)
    assert.equal(JSON.stringify(cfg).includes('legacy-secret'), false)
    assert.equal(store.save(cfg), true)
    assert.equal(store.getApiKey(), 'legacy-secret')
    const second = { id: 'second', name: '第二配置', baseUrl: 'https://second.invalid/v1', model: 'second-model', temperature: 0.2 }
    cfg.ai = { ...second, profiles: [...cfg.ai.profiles, second], activeProfileId: second.id }
    assert.equal(store.save(cfg), true)
    assert.equal(store.getApiKey(), '')
    assert.equal(store.getApiKey('missing'), '')
    assert.equal(store.getApiKey('default'), 'legacy-secret')
    cfg = store.load()
    cfg.ai.apiKey = 'second-secret'
    assert.equal(store.save(cfg), true)
    assert.equal(store.getApiKey(), 'second-secret')
    cfg = store.load()
    assert.equal(JSON.stringify(cfg).includes('second-secret'), false)
    cfg.ai.model = 'edited-model'
    cfg.ai.name = '已修改名称'
    assert.equal(store.save(cfg), true)
    assert.equal(store.load().ai.model, 'edited-model')
    assert.equal(store.getApiKey(), 'second-secret')
    cfg = store.load()
    cfg.ai = { ...cfg.ai.profiles[0], profiles: cfg.ai.profiles, activeProfileId: 'default' }
    assert.equal(store.save(cfg), true)
    assert.equal(store.load().ai.model, 'old')
    assert.equal(store.getApiKey(), 'legacy-secret')
    cfg.ai.clearKey = true
    assert.equal(store.save(cfg), true)
    assert.equal(store.getApiKey(), '')
    assert.equal(store.getApiKey('second'), 'second-secret')
    cfg = store.load()
    cfg.ai = { ...cfg.ai.profiles[1], profiles: cfg.ai.profiles, activeProfileId: 'second' }
    assert.equal(store.save(cfg), true)
    assert.equal(store.load().ai.name, '已修改名称')
    assert.equal(store.getApiKey(), 'second-secret')
    if (!nodeBackend) {
      available = false
      cfg = store.load()
      assert.equal(cfg.ai.keyConfigured, false)
      assert.equal(store.save(cfg), true)
      available = true
      assert.equal(store.getApiKey(), 'second-secret')
    }
    cfg = store.load()
    cfg.ai.profiles.push({ ...cfg.ai.profiles[0] })
    assert.equal(store.save(cfg), false)
    assert.equal(store.getApiKey(), 'second-secret')
    // 执行设置页真实脚本，通过真实存储验证新增、切换与保存失败恢复。
    const state = { config: store.load(), scan: {}, discoveredRepos: [] }
    const plain = value => JSON.parse(JSON.stringify(value))
    let failSave = false
    let rejectProfileId = ''
    const script = fs.readFileSync(path.resolve(__dirname, '../src/views/SettingsView.vue'), 'utf8')
      .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm, '')
    const sandbox = {
      state, console, crypto: require('node:crypto'), setTimeout, clearTimeout,
      ref: value => ({ value }), computed: get => ({ get value() { return get() } }),
      onMounted() {}, onBeforeUnmount() {}, defineEmits() {},
      defineProps: () => ({ initialSection: 'ai' }),
      useTopbarReady() {}, useProjects: () => ({ loadProjects() {} }), toPlain: plain,
      ElMessage: { error() {}, success() {} }, ElMessageBox: { confirm: async () => true },
      window: { gitReport: { configSave: payload => failSave || payload.ai.activeProfileId === rejectProfileId ? false : store.save(payload), configLoad: () => store.load() } },
    }
    vm.createContext(sandbox)
    vm.runInContext(script + '\n globalThis.ui = { addAiProfile, switchAiProfile, saveConfig, apiKeyInput, clearKey, modelOptions, testResult, fetchModels };', sandbox)
    const ui = sandbox.ui
    state.config.ai.model = '界面修改模型'
    ui.apiKeyInput.value = '界面独立密钥'
    await ui.switchAiProfile('default')
    assert.equal(state.config.ai.activeProfileId, 'default')
    assert.equal(store.getApiKey('second'), '界面独立密钥')
    assert.equal(store.load().ai.profiles[1].model, '界面修改模型')
    await ui.addAiProfile()
    const addedId = state.config.ai.activeProfileId
    assert.equal(state.config.ai.profiles.length, 3)
    assert.equal(store.getApiKey(), '')
    state.config.ai.name = '界面新增配置'
    state.config.ai.baseUrl = 'https://ui.invalid/v1'
    state.config.ai.model = 'ui-model'
    ui.apiKeyInput.value = 'new-profile-secret'
    assert.equal(await ui.saveConfig(), true)
    assert.equal(store.getApiKey(), 'new-profile-secret')
    failSave = true
    ui.apiKeyInput.value = '失败时保留输入'
    await ui.switchAiProfile('second')
    assert.equal(state.config.ai.activeProfileId, addedId)
    assert.equal(ui.apiKeyInput.value, '失败时保留输入')
    failSave = false
    ui.apiKeyInput.value = ''
    rejectProfileId = 'second'
    await ui.switchAiProfile('second')
    assert.equal(state.config.ai.activeProfileId, addedId)
    assert.equal(store.load().ai.activeProfileId, addedId)
    rejectProfileId = ''
    await ui.clearKey()
    assert.equal(store.getApiKey(), '')
    assert.equal(store.getApiKey('second'), '界面独立密钥')
    await ui.switchAiProfile('second')
    assert.equal(store.load().ai.model, '界面修改模型')
    let resolveModels
    sandbox.window.gitReport.aiModels = () => new Promise(resolve => { resolveModels = resolve })
    const pendingModels = ui.fetchModels()
    await ui.switchAiProfile(addedId)
    resolveModels({ ok: true, models: ['过期模型'] })
    await pendingModels
    assert.equal(ui.modelOptions.value.length, 0)
    assert.equal(state.config.ai.model, 'ui-model')
    console.log(`${nodeBackend ? 'keyring' : 'safeStorage'} 多配置隔离验证通过`)
  }
} finally {
  const resolved = fs.realpathSync(dir)
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('plm-ai-profiles-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}
}
main().catch(error => { console.error(error); process.exitCode = 1 })
