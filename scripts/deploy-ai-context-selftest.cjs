/** 运行真实 Vue setup/watch 与异步操作；只替换 IPC 和确认框，不依赖浏览器或服务器。 */
const assert = require('assert')
const fs = require('fs')
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

async function main() {
  const filename = path.resolve(__dirname, '../src/components/deploy/DeployAiAssistant.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'))
  const compiled = compileScript(descriptor, { id: 'deploy-ai-context-test' })
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  let confirmation = deferred()
  const errors = []
  mod.require = (id) => {
    if (id === 'element-plus') return {
      ElMessage: { error: (v) => errors.push(v), success() {}, warning() {} },
      ElMessageBox: { confirm: () => confirmation.promise },
    }
    if (id === '../../utils/ipc') {
      const helper = new Module(path.resolve(path.dirname(filename), '../../utils/ipc.js'), module)
      helper._compile(transformSync(fs.readFileSync(helper.id, 'utf8'), { format: 'cjs' }).code, helper.id)
      return helper.exports
    }
    return Module.prototype.require.call(mod, id)
  }
  mod._compile(transformSync(compiled.content, { format: 'cjs' }).code, filename)
  const props = vue.reactive({ modelValue: true, form: { id: 'A', localPath: '/project/A' }, activeTargetId: 'test' })
  const emits = []
  const calls = []
  let diagnostic = deferred()
  let generation = deferred()
  let batchGeneration = deferred()
  let writeResponse = deferred()
  global.window = { gitReport: {
    deployAiDiagnose: (...args) => { calls.push(['diagnose', ...args]); return diagnostic.promise },
    deployAiGenerateFile: (...args) => { calls.push(['generate', ...args]); return generation.promise },
    deployAiGenerateFiles: (...args) => { calls.push(['generateAll', ...args]); return batchGeneration.promise },
    deployAiApply: async (...args) => { calls.push(['apply', ...args]); return { ok: true } },
    deployAiWriteFiles: (...args) => { calls.push(['write', ...args]); return writeResponse.promise },
  } }
  // 使用自定义 Vue renderer 创建真实组件实例，包含销毁生命周期。
  let state
  const component = { setup() {
    state = mod.exports.default.setup(props, { expose() {}, emit: (...args) => emits.push(args) })
    return () => null
  } }
  const renderer = vue.createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {},
  })
  const app = renderer.createApp(component)
  app.mount({})
  const response = {
    ok: true,
    local: {
      root: '/project', exists: true, entryCount: 0, entries: [], stack: [],
      deployFiles: { present: [], missing: [] }, compose: { files: [] }, releaseScripts: {},
      version: { version: '', source: '' }, envExamples: [], dataCandidates: [], sensitive: [],
      artifactDirs: [], risks: [], fileContents: [],
    },
    remote: { ok: true },
    plan: { deployMode: 'docker', files: [], missingFiles: [{ path: 'Dockerfile' }], blockers: ['缺 Dockerfile'], readyToDeploy: false },
  }
  const validFiles = [{ path: 'Dockerfile', action: 'create', content: 'FROM node:22\nCMD ["node", "server.js"]\n', purpose: '构建服务' }]
  const validValidation = { ok: true, errors: [], warnings: ['尚未进行真实构建'] }
  const count = (name) => calls.filter((call) => call[0] === name).length
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  try {
    const oldDiagnostic = diagnostic
    const oldRun = state.run()
    props.form.id = 'B'
    diagnostic = deferred()
    const newRun = state.run()
    // 两轮使用独立 Promise，旧回包不能改变新轮次状态。
    oldDiagnostic.resolve(response)
    await oldRun
    assert.strictEqual(state.result.value, null)
    assert.strictEqual(state.running.value, true, '旧请求结束不得停止新请求的加载状态')
    diagnostic.resolve(response)
    await newRun
    assert.strictEqual(state.result.value.plan.deployMode, 'docker')
    assert.deepStrictEqual(calls.filter((c) => c[0] === 'diagnose').map((c) => c[1]), ['A', 'B'])

    props.activeTargetId = 'production'
    assert.strictEqual(state.result.value, null, '切换环境必须清空方案')
    diagnostic = deferred()
    const lateRun = state.run()
    props.form.id = 'C'
    diagnostic.resolve(response)
    await lateRun
    assert.strictEqual(state.result.value, null, '旧诊断回包不得进入新项目')

    state.result.value = response
    const pendingApply = state.apply()
    props.activeTargetId = 'test'
    confirmation.resolve()
    await pendingApply
    assert.ok(!calls.some((c) => c[0] === 'apply'), '确认框打开后切环境不得套用')

    confirmation = deferred()
    state.result.value = response
    state.selectedFiles.value = [{ path: 'start.sh', content: 'echo test' }]
    const pendingWrite = state.writeSelected()
    props.form.id = 'D'
    confirmation.resolve()
    await pendingWrite
    assert.ok(!calls.some((c) => c[0] === 'write'), '确认框打开后切项目不得写文件')

    const row = { path: 'start.sh', content: '' }
    state.result.value = response
    const pendingGenerate = state.generateOne(row)
    props.modelValue = false
    generation.resolve({ ok: true, content: 'echo stale' })
    await pendingGenerate
    assert.strictEqual(row.content, '', '关闭后迟到的文件内容必须丢弃')
    assert.strictEqual(state.previewVisible.value, false)

    props.modelValue = true
    state.result.value = response
    confirmation = deferred()
    const validApply = state.apply()
    confirmation.resolve()
    await validApply
    assert.deepStrictEqual(calls.find((c) => c[0] === 'apply').slice(1, 3), ['D', 'test'], '正常套用应绑定当前项目和环境')
    assert.ok(emits.some((e) => e[0] === 'applied'))
    assert.deepStrictEqual(errors, [])

    // 批量生成的迟到响应不能污染已切换目录的新体检，也不能停止新操作的加载状态。
    state.result.value = JSON.parse(JSON.stringify(response))
    const oldBatch = state.generateAll()
    assert.strictEqual(state.generatingAll.value, true)
    props.form.localPath = '/project/D-new'
    diagnostic = deferred()
    const runAfterPathChange = state.run()
    batchGeneration.resolve({ ok: true, files: validFiles, validation: validValidation })
    await oldBatch
    assert.strictEqual(state.result.value, null, '旧目录批量结果不得写入新目录的方案')
    assert.strictEqual(state.running.value, true, '旧批量请求不能结束新体检状态')
    diagnostic.resolve(JSON.parse(JSON.stringify(response)))
    await runAfterPathChange

    // 整套生成期间拒绝其他生成、写入、体检和套用，包括确认框尚未打开的操作。
    batchGeneration = deferred()
    const batch = state.generateAll()
    const countsBeforeBusy = calls.length
    await Promise.all([state.generateAll(), state.generateOne(row), state.run(), state.writeAll(), state.apply()])
    assert.strictEqual(calls.length, countsBeforeBusy, '生成中不能并发其他部署操作')
    const batchCall = calls.filter((call) => call[0] === 'generateAll').at(-1)
    assert.strictEqual(vue.isProxy(batchCall[3]), false, '批量方案必须转成普通对象跨 IPC')
    assert.deepStrictEqual(batchCall.slice(1, 3), ['D', 'test'])
    batchGeneration.resolve({ ok: true, files: validFiles, validation: validValidation })
    await batch
    assert.deepStrictEqual(JSON.parse(JSON.stringify(state.result.value.plan.files)), validFiles)
    assert.strictEqual(state.generationValidation.value.ok, true)
    assert.strictEqual(state.generatingAll.value, false)

    // 新一轮生成失败或截断时，不把先前成功内容误当成本轮可写文件。
    batchGeneration = deferred()
    const invalidBatch = state.generateAll()
    batchGeneration.resolve({ ok: false, files: [{ path: 'Dockerfile', content: 'invalid' }], validation: { ok: false, errors: ['引用的入口不存在'], warnings: [] }, error: '校验未通过' })
    await invalidBatch
    assert.strictEqual(state.result.value.plan.files[0].content, '')
    assert.strictEqual(state.writableFiles.value.length, 0, '生成失败不能留下旧轮次的可写内容')
    assert.strictEqual(state.generationValidation.value.ok, false)
    batchGeneration = deferred()
    const truncatedBatch = state.generateAll()
    batchGeneration.resolve({ ok: true, truncated: true, files: [{ path: 'Dockerfile', content: 'FROM' }], validation: validValidation })
    await truncatedBatch
    assert.strictEqual(state.result.value.plan.files[0].content, '')
    assert.strictEqual(state.generationValidation.value.ok, false, '截断不能显示静态校验成功')
    assert.strictEqual(state.generationStatus.value.type, 'error')
    batchGeneration = deferred()
    const regeneratedBatch = state.generateAll()
    batchGeneration.resolve({ ok: true, files: JSON.parse(JSON.stringify(validFiles)), validation: validValidation })
    await regeneratedBatch
    assert.strictEqual(state.writableFiles.value.length, 1, '重新生成完整内容后恢复可写状态')

    // 单文件生成携带当前方案和其他文件；截断与校验错误同样不能写入。
    state.previewVisible.value = false
    const newRow = { path: 'start.sh', action: 'create', purpose: '启动服务', content: '' }
    state.result.value.plan.files.push(newRow)
    generation = deferred()
    const truncatedOne = state.generateOne(newRow)
    generation.resolve({ ok: true, content: 'echo cut', truncated: true, validation: validValidation })
    await truncatedOne
    assert.strictEqual(newRow.content, '')
    assert.strictEqual(state.previewVisible.value, false)
    generation = deferred()
    const invalidOne = state.generateOne(newRow)
    generation.resolve({ ok: true, content: 'echo invalid', validation: { ok: false, errors: ['脚本不完整'], warnings: [] } })
    await invalidOne
    assert.strictEqual(newRow.content, '')
    generation = deferred()
    const validOne = state.generateOne(newRow)
    const oneCall = calls.filter((call) => call[0] === 'generate').at(-1)
    assert.strictEqual(vue.isProxy(oneCall[3].plan), false)
    assert.strictEqual(vue.isProxy(oneCall[3].siblings), false)
    assert.strictEqual(oneCall[3].siblings.length, 2)
    assert.strictEqual(oneCall[3].plan.deployMode, 'docker')
    generation.resolve({ ok: true, content: '#!/bin/sh\nnode server.js\n', validation: validValidation })
    await validOne
    assert.strictEqual(newRow.content, '#!/bin/sh\nnode server.js\n')
    assert.strictEqual(state.previewVisible.value, true)

    // 确认框、写入和写入后的体检占用同一个操作状态；IPC 绑定当前目标与普通方案。
    confirmation = deferred()
    diagnostic = deferred()
    writeResponse = deferred()
    const writeAll = state.writeAll()
    assert.strictEqual(state.writing.value, true)
    const writesBeforeConfirm = count('write')
    const beforeWriteBusy = calls.length
    await Promise.all([state.writeAll(), state.writeSelected(), state.run(), state.generateAll(), state.generateOne(newRow), state.apply()])
    assert.strictEqual(calls.length, beforeWriteBusy, '写入确认期间不能并发部署操作')
    confirmation.resolve()
    await flush()
    assert.strictEqual(count('write'), writesBeforeConfirm + 1)
    const writeCall = calls.filter((call) => call[0] === 'write').at(-1)
    assert.strictEqual(writeCall[1], 'D')
    assert.strictEqual(writeCall[3].targetId, 'test')
    assert.strictEqual(vue.isProxy(writeCall[3].plan), false)
    assert.strictEqual(writeCall[2].length, 2)
    const diagnosesBeforeRefresh = count('diagnose')
    writeResponse.resolve({ ok: true, results: [
      { path: 'Dockerfile', action: 'updated', backup: 'Dockerfile.bak-123' },
      { path: 'start.sh', action: 'created' },
    ] })
    await flush()
    assert.strictEqual(count('diagnose'), diagnosesBeforeRefresh + 1, '写入成功必须重新体检')
    assert.strictEqual(state.writing.value, true, '重新体检完成前应保持写入状态')
    assert.strictEqual(state.written.value[0].backup, 'Dockerfile.bak-123')
    const refreshed = { ...response, plan: { ...response.plan, readyToDeploy: true, blockers: [], missingFiles: [], files: [] } }
    diagnostic.resolve(refreshed)
    await writeAll
    assert.strictEqual(state.result.value.plan.missingFiles.length, 0)
    assert.strictEqual(state.result.value.plan.blockers.length, 0)
    assert.strictEqual(state.written.value.length, 2, '重新体检不得清空写入与备份结果')
    assert.strictEqual(state.writing.value, false)
    assert.strictEqual(state.refreshError.value, '')
    state.result.value.plan.files = JSON.parse(JSON.stringify(validFiles))
    assert.strictEqual(state.writableFiles.value.length, 0, '已写入的相同内容无需重复写入')
    state.result.value.plan.files[0].content += '# 新的部署调整\n'
    assert.strictEqual(state.writableFiles.value.length, 1, '同路径重新生成不同内容后可以再次写入')

    // 写入成功但重新体检失败时，不宣称具备部署条件，也不能套用旧方案。
    state.result.value = { ...response, plan: { ...response.plan, files: [{ path: 'upgrade.sh', content: '#!/bin/sh\necho upgrade\n' }] } }
    confirmation = deferred()
    diagnostic = deferred()
    writeResponse = deferred()
    const writeWithFailedRefresh = state.writeAll()
    confirmation.resolve()
    await flush()
    writeResponse.resolve({ ok: true, results: [{ path: 'upgrade.sh', action: 'created' }] })
    await flush()
    diagnostic.resolve({ ok: false, error: '目录暂时不可读' })
    await writeWithFailedRefresh
    assert.match(state.refreshError.value, /文件已写入，但重新体检失败/)
    assert.strictEqual(state.written.value.length, 3)
    const appliesBeforeFailedRefresh = count('apply')
    await state.apply()
    assert.strictEqual(count('apply'), appliesBeforeFailedRefresh, '重体检失败不能套用旧条件')

    state.result.value = { ...response, plan: { ...response.plan, files: [{ path: '.dockerignore', content: 'node_modules\n' }] } }
    confirmation = deferred()
    diagnostic = deferred()
    writeResponse = deferred()
    const writeWithRemoteFailure = state.writeAll()
    confirmation.resolve()
    await flush()
    writeResponse.resolve({ ok: true, results: [{ path: '.dockerignore', action: 'created' }] })
    await flush()
    diagnostic.resolve({ ...refreshed, remote: { ok: false, error: '服务器连接失败' } })
    await writeWithRemoteFailure
    assert.match(state.refreshError.value, /服务器连接失败/)
    assert.strictEqual(state.result.value.plan.missingFiles.length, 0, '服务器体检失败仍应展示本地文件的最新体检结果')

    // 部分写入失败必须保留阻塞，即使随后体检把旧计划误判为可部署，也不能套用。
    state.result.value = { ...response, plan: { ...response.plan, readyToDeploy: true, files: [
      { path: 'Dockerfile.worker', content: 'FROM node:22\n' },
      { path: '.deployignore', content: 'node_modules\n' },
    ] } }
    confirmation = deferred()
    diagnostic = deferred()
    writeResponse = deferred()
    const writePartial = state.writeAll()
    confirmation.resolve()
    await flush()
    writeResponse.resolve({ ok: true, results: [
      { path: 'Dockerfile.worker', action: 'created' },
      { path: '.deployignore', action: 'failed', error: '文件被占用' },
    ] })
    await flush()
    diagnostic.resolve(refreshed)
    await writePartial
    assert.match(state.writeError.value, /\.deployignore.*文件被占用/)
    assert.strictEqual(state.result.value.plan.readyToDeploy, true, '夹具保留旧计划可部署状态以验证额外阻塞')
    assert.strictEqual(state.deploymentBlocked.value, true, '部分失败不能被重体检的成功覆盖')
    const applyBeforePartial = count('apply')
    await state.apply()
    assert.strictEqual(count('apply'), applyBeforePartial, '存在写入失败时不得套用旧方案')
    assert.strictEqual(state.generationStatus.value.type, 'warning')

    // 新体检清除上一轮的校验状态，批量结果在关闭后也必须丢弃。
    diagnostic = deferred()
    const freshRun = state.run()
    assert.strictEqual(state.refreshError.value, '')
    assert.strictEqual(state.writeError.value, '')
    assert.strictEqual(state.generationValidation.value, null)
    assert.strictEqual(state.written.value.length, 0)
    diagnostic.resolve(JSON.parse(JSON.stringify(response)))
    await freshRun
    batchGeneration = deferred()
    const lateRemotePathBatch = state.generateAll()
    props.form.remotePath = '/opt/new-service'
    batchGeneration.resolve({ ok: true, files: validFiles, validation: validValidation })
    await lateRemotePathBatch
    assert.strictEqual(state.result.value, null, '修改服务器部署目录必须丢弃旧生成结果')

    // 已写入后的迟到体检不得进入另一个目标，也不能携带之前的备份记录。
    state.result.value = { ...response, plan: { ...response.plan, files: JSON.parse(JSON.stringify(validFiles)) } }
    confirmation = deferred()
    diagnostic = deferred()
    writeResponse = deferred()
    const lateWriteRefresh = state.writeAll()
    confirmation.resolve()
    await flush()
    writeResponse.resolve({ ok: true, results: [{ path: 'Dockerfile', action: 'updated', backup: 'Dockerfile.bak-old-target' }] })
    await flush()
    props.activeTargetId = 'production'
    diagnostic.resolve(refreshed)
    await lateWriteRefresh
    assert.strictEqual(state.result.value, null, '旧目标的写入后体检不得进入新目标')
    assert.strictEqual(state.written.value.length, 0, '旧目标的写入历史不得带到新目标')
    assert.strictEqual(state.writing.value, false)
    state.result.value = JSON.parse(JSON.stringify(response))
    batchGeneration = deferred()
    const lateClosedBatch = state.generateAll()
    props.modelValue = false
    batchGeneration.resolve({ ok: true, files: validFiles, validation: validValidation })
    await lateClosedBatch
    assert.strictEqual(state.result.value, null)
    assert.strictEqual(state.generationStatus.value, null)
    assert.strictEqual(state.generatingAll.value, false)
  } finally {
    app.unmount()
    delete global.window
  }
  console.log('全部通过：AI 部署助手上下文隔离、整套生成、并发保护、截断阻断及写入后重新体检')
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
