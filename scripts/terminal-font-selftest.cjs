/** 终端字体偏好自测：真实读写临时文件，并运行渲染层的完整偏好保存入口。 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { transformSync } = require('esbuild')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-font-selftest-'))
  const userData = path.join(root, 'userdata')
  const originalWindow = global.window
  const defaults = { sidebarCollapsed: false, terminalFontSize: 13, terminalFontFamily: '' }
  function loadSource(relative, replacements, transform = false) {
    const filename = path.resolve(__dirname, '..', relative)
    const mod = new Module(filename, module)
    mod.filename = filename
    mod.paths = Module._nodeModulePaths(path.dirname(filename))
    mod.require = (id) => Object.hasOwn(replacements, id)
      ? replacements[id]
      : Module.prototype.require.call(mod, id)
    const source = fs.readFileSync(filename, 'utf8')
    mod._compile(transform ? transformSync(source, { format: 'cjs', target: 'node20' }).code : source, filename)
    return mod.exports
  }
  const reload = () => loadSource('electron/ui-prefs.js', {
    electron: { app: { getPath: (name) => { assert.equal(name, 'userData'); return userData } } },
  })
  try {
    let prefs = reload()
    assert.deepEqual(prefs.load(), defaults, '首次启动应返回兼容默认值')
    assert.equal(prefs.file(), path.join(userData, 'ui-prefs.json'))
    fs.mkdirSync(userData, { recursive: true })
    fs.writeFileSync(prefs.file(), JSON.stringify({ sidebarCollapsed: true, terminalFontSize: 17 }), 'utf8')
    assert.deepEqual(reload().load(), { ...defaults, sidebarCollapsed: true, terminalFontSize: 17 }, '旧偏好新增空字体，保留原字号和侧栏')
    fs.writeFileSync(prefs.file(), '{ 损坏的 JSON', 'utf8')
    assert.deepEqual(reload().load(), defaults, '损坏配置应回落默认值')
    console.log('  ✓ 缺失、旧版和损坏偏好兼容')

    for (const family of ['Consolas', 'Cascadia Mono', '等距更纱黑体 SC', 'JetBrains Mono-NL', '字'.repeat(100), '']) {
      const expected = { sidebarCollapsed: true, terminalFontSize: 18, terminalFontFamily: family }
      const result = prefs.save({ ...expected, terminalFontFamily: `  ${family}  `, unknown: '不应保存' })
      assert.equal(result.ok, true)
      assert.deepEqual(result.prefs, expected)
      prefs = reload()
      assert.deepEqual(prefs.load(), expected, '重新加载模块必须读到实际保存的字体')
      assert.deepEqual(JSON.parse(fs.readFileSync(prefs.file(), 'utf8')), expected, '文件只保存已知偏好键')
      assert.equal(fs.existsSync(`${prefs.file()}.tmp`), false, '原子替换成功后不应遗留临时文件')
    }
    const invalid = [undefined, null, 13, true, {}, [], 'a'.repeat(101), 'Consolas, serif', '"Consolas"', "'Consolas'", 'Consolas; color:red', 'Consolas{font:serif}', 'Consolas\\serif', '\nConsolas', 'Conso\tlas', 'Consolas\r', 'Conso\u0000las', 'Conso\u001flas', 'Conso\u007flas', 'Conso\u0085las', 'Conso\u009flas']
    for (const family of invalid) {
      const expected = { ...defaults, sidebarCollapsed: true, terminalFontSize: 18 }
      const result = prefs.save({ ...expected, terminalFontFamily: family })
      assert.equal(result.ok, true)
      assert.deepEqual(result.prefs, expected, '坏字体只降级字体字段')
      fs.writeFileSync(prefs.file(), JSON.stringify({ ...expected, terminalFontFamily: family }), 'utf8')
      assert.deepEqual(reload().load(), expected, '读取手工修改的配置也应归一化字体')
    }
    console.log('  ✓ 中英文字体、空格和长度边界可保存，坏输入在读取与保存时降级')

    const state = { ui: { sidebarCollapsed: true, terminalFontSize: 16, terminalFontFamily: 'Cascadia Mono' } }
    const writes = []
    global.window = { gitReport: { uiPrefsSave: async (payload) => {
      writes.push(payload)
      const result = prefs.save(payload)
      assert.equal(result.ok, true)
      return result
    } } }
    const ui = loadSource('src/utils/ui-prefs.js', { '../store': { state } }, true)
    for (const family of invalid) assert.equal(ui.normalizeTerminalFontFamily(family), '', '前后端应拒绝相同的坏字体')
    assert.equal(ui.normalizeTerminalFontFamily('  等距更纱黑体 SC  '), '等距更纱黑体 SC')
    assert.equal(ui.normalizeTerminalFontFamily('字'.repeat(100)), '字'.repeat(100))
    const fallback = 'Consolas, "Cascadia Mono", "Sarasa Mono SC", Menlo, monospace'
    assert.equal(ui.terminalFontStack(''), fallback, '默认字体应保留既有回退顺序')
    assert.equal(ui.terminalFontStack('等距更纱黑体 SC'), `"等距更纱黑体 SC", ${fallback}`)
    assert.equal(ui.terminalFontStack('monospace'), `monospace, ${fallback}`, 'CSS 通用字体应保留通用族语义')
    assert.equal(ui.terminalFontStack('Consolas, serif'), fallback)
    await ui.saveUiPrefs()
    assert.deepEqual(reload().load(), state.ui)
    await ui.stepTerminalFontSize(1)
    assert.deepEqual(reload().load(), { sidebarCollapsed: true, terminalFontSize: 17, terminalFontFamily: 'Cascadia Mono' }, '调字号不得覆盖字体和侧栏')
    await ui.applyTerminalFontFamily('  等距更纱黑体 SC  ')
    assert.deepEqual(reload().load(), state.ui, '换字体不得覆盖字号和侧栏')
    state.ui.sidebarCollapsed = false
    await ui.saveUiPrefs()
    assert.deepEqual(reload().load(), state.ui, '切侧栏不得覆盖字体和字号')
    await ui.resetTerminalFontSize()
    assert.deepEqual(reload().load(), { ...state.ui, terminalFontSize: 13 }, '恢复字号不得重置字体')
    await ui.applyTerminalFontFamily('')
    assert.deepEqual(reload().load(), state.ui, '恢复默认字体应落盘为空字符串')
    assert(writes.every((payload) => Object.hasOwn(payload, 'terminalFontFamily') && Object.hasOwn(payload, 'terminalFontSize') && Object.hasOwn(payload, 'sidebarCollapsed')), '每次渲染层保存都应携带完整偏好')
    console.log('  ✓ 真实渲染层保存入口保留字体、字号与侧栏，临时文件重载通过')

    ui.restoreTerminalFontPrefs({ terminalFontFamily: '  Cascadia Mono ', terminalFontSize: 18 }, ui.getTerminalFontRevision())
    assert.deepEqual(state.ui, { sidebarCollapsed: false, terminalFontSize: 18, terminalFontFamily: 'Cascadia Mono' }, '未编辑时正常恢复启动偏好')
    const pendingLoadRevision = ui.getTerminalFontRevision()
    await ui.applyTerminalFontFamily('JetBrains Mono')
    ui.restoreTerminalFontPrefs({ terminalFontFamily: '旧字体', terminalFontSize: 11 }, pendingLoadRevision)
    assert.deepEqual(state.ui, { sidebarCollapsed: false, terminalFontSize: 18, terminalFontFamily: 'JetBrains Mono' }, '迟到的初始化读取不得覆盖用户新字体')
    const pendingSizeRevision = ui.getTerminalFontRevision()
    await ui.stepTerminalFontSize(1)
    ui.restoreTerminalFontPrefs({ terminalFontFamily: '旧字体', terminalFontSize: 11 }, pendingSizeRevision)
    assert.deepEqual(state.ui, { sidebarCollapsed: false, terminalFontSize: 19, terminalFontFamily: 'JetBrains Mono' }, '迟到的初始化读取不得覆盖用户新字号')
    await ui.resetTerminalFontPreferences()
    assert.deepEqual(reload().load(), defaults, '一键恢复应同时恢复字体和字号')
    console.log('  ✓ 启动恢复保留较新的用户选择，恢复默认同时保存字体和字号')

    const save = global.window.gitReport.uiPrefsSave
    global.window.gitReport.uiPrefsSave = async () => ({ ok: false, error: '测试磁盘不可写' })
    await assert.rejects(ui.applyTerminalFontFamily('Consolas'), /测试磁盘不可写/, '保存失败应让设置组件显示错误')
    global.window.gitReport.uiPrefsSave = async () => { throw new Error('测试 IPC 中断') }
    await assert.rejects(ui.stepTerminalFontSize(1), /测试 IPC 中断/, 'IPC 拒绝应让设置组件显示错误')
    global.window.gitReport.uiPrefsSave = save
    await ui.applyTerminalFontFamily('Consolas')
    assert.equal(reload().load().terminalFontFamily, 'Consolas', '同一字体在保存失败后应能重试')
    console.log('  ✓ 保存失败可报告，同值重试成功落盘')
  } finally {
    if (originalWindow === undefined) delete global.window
    else global.window = originalWindow
    const resolved = path.resolve(root)
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('terminal-font-selftest-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
