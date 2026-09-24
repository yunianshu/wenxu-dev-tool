/** 知识库自测：真实临时 Markdown、进程并发、软删除、迁移和失败恢复。 */
const assert = require('assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')
const { fork, spawnSync } = require('child_process')
const { randomUUID } = require('crypto')
const YAML = require('yaml')

function loadService(userData, filesystem = fs) {
  const filename = path.resolve(__dirname, '../electron/knowledge-service.js')
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = Module._nodeModulePaths(path.dirname(filename))
  mod.require = (id) => {
    if (id === 'electron') return { app: { getPath: (name) => { assert.equal(name, 'userData'); return userData } } }
    if (id === 'fs') return filesystem
    return Module.prototype.require.call(mod, id)
  }
  mod._compile(fs.readFileSync(filename, 'utf8'), filename)
  return mod.exports
}

function writer() {
  const [, , , userData, id, revision, label] = process.argv
  const service = loadService(userData)
  const record = service.list().records.find((item) => item.id === id)
  process.send({ ready: true })
  process.once('message', () => {
    process.send({ result: service.save({ ...record, revision: Number(revision), body: label }) }, () => process.disconnect())
  })
}

function concurrentSave(userData, record) {
  return new Promise((resolve, reject) => {
    const children = ['并发甲', '并发乙'].map((label) => fork(__filename, ['--writer', userData, record.id, String(record.revision), label], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
    const results = []
    let ready = 0
    let settled = false
    const timeout = setTimeout(() => finish(new Error('并发写入测试超时')), 10000)
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) children.forEach((child) => child.kill())
      error ? reject(error) : resolve(results)
    }
    children.forEach((child) => {
      child.on('error', finish)
      child.on('message', (message) => {
        if (message.ready && ++ready === 2) children.forEach((item) => item.send({ start: true }))
        if (message.result) {
          results.push(message.result)
          if (results.length === 2) finish()
        }
      })
      child.on('exit', (code) => { if (code && !settled) finish(new Error(`并发子进程异常退出：${code}`)) })
    })
  })
}

async function main() {
  const startedAt = Date.now()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-selftest-'))
  const userData = path.join(root, 'userdata')
  const dir = path.join(userData, 'knowledge')
  let groups = 0
  function passed(message) { groups += 1; console.log(`  ✓ ${message}`) }
  try {
    let service = loadService(userData)
    assert.deepEqual(service.list(), { ok: true, records: [], directory: dir, warnings: [] })
    const body = '# 第一份记录\n\n想法：让经验可以被检索。\n\n```yaml\na: b\n```\n'
    const input = { title: '知识沉淀', body, type: 'experience', status: 'organized', tags: ['桌面', '桌面', ' AI '], projectId: '', projectName: '', sourceIds: [], unknown: '不保存' }
    const first = service.save(input)
    assert.equal(first.ok, true)
    assert.match(first.record.id, /^[0-9a-f-]{36}$/)
    assert.equal(first.record.revision, 1)
    assert.equal(first.record.deletedAt, null)
    assert.deepEqual(first.record.tags, ['桌面', 'AI'])
    assert.equal(Object.hasOwn(first.record, 'unknown'), false)
    const file = path.join(dir, `${first.record.id}.md`)
    assert.match(fs.readFileSync(file, 'utf8'), /^---\nschemaVersion: 1\n/)
    service = loadService(userData)
    assert.deepEqual(service.list().records, [first.record], '重新加载必须读取真实文件且保留完整正文')
    assert.match(first.record.contentHash, /^[0-9a-f]{64}$/)
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^contentHash:/m, '文件指纹不能写入 Markdown 元信息')
    passed('首次建立目录、独立 Markdown 写入和重启读取')

    assert.equal(service.save({ ...first.record, revision: undefined }).code, 'REVISION_CONFLICT')
    const edit = service.save({ ...first.record, body: '更新后的正文', createdAt: 1, updatedAt: 1 })
    assert.equal(edit.ok, true)
    assert.equal(edit.record.revision, 2)
    assert.equal(edit.record.createdAt, first.record.createdAt)
    assert.equal(loadService(userData).save({ ...first.record, body: '旧编辑器内容' }).code, 'REVISION_CONFLICT')
    assert.equal(service.list().records[0].body, edit.record.body)
    const parallel = await concurrentSave(userData, edit.record)
    assert.equal(parallel.filter((result) => result.ok).length, 1, '两个真实进程基于同一版本只能一个成功')
    assert(['REVISION_CONFLICT', 'RECORD_BUSY'].includes(parallel.find((result) => !result.ok).code))
    assert.equal(service.save(edit.record).code, 'REVISION_CONFLICT', '冲突后重试旧版本仍不能覆盖')
    let current = service.list().records.find((record) => record.id === first.record.id)
    assert.equal(current.revision, 3)
    assert(['并发甲', '并发乙'].includes(current.body))
    passed('缺失版本、过期编辑及两个真实进程并发写入保护')

    const removed = service.trash(current.id, current.revision)
    assert.equal(removed.ok, true)
    assert.equal(removed.record.revision, current.revision + 1)
    assert(removed.record.deletedAt > 0)
    assert(fs.existsSync(file), '软删除必须保留原文件')
    assert.equal(loadService(userData).list().records[0].deletedAt, removed.record.deletedAt)
    assert.equal(service.save({ ...removed.record, body: '迟到保存' }).code, 'RECORD_DELETED')
    assert.equal(service.restore(current.id, current.revision).code, 'REVISION_CONFLICT')
    const restored = service.restore(current.id, removed.record.revision)
    assert.equal(restored.ok, true)
    assert.equal(restored.record.deletedAt, null)
    assert.equal(restored.record.body, current.body)
    assert.equal(service.trash(current.id).ok, true, '省略版本的生命周期接口仍受串行写锁保护')
    assert.equal(service.restore(current.id).ok, true)
    current = service.list().records[0]
    passed('回收站持久化、旧保存不能复活、恢复及可选版本契约')

    const outside = path.join(root, 'outside.md')
    fs.writeFileSync(outside, '不得改写', 'utf8')
    const unsafeIds = ['../outside', '..\\outside', outside, 'C:\\outside', '/outside', 'CON', '', null, {}, [], `${current.id}/../x`, `${current.id}\u0000`]
    for (const id of unsafeIds) {
      for (const operation of ['trash', 'restore', 'exportMarkdown']) assert.equal(service[operation](id).code, 'INVALID_ID')
      if (id !== '' && id !== null) assert.equal(service.save({ ...input, id, revision: 1 }).code, 'INVALID_ID')
    }
    assert.equal(service.save({ ...input, id: randomUUID(), revision: 1 }).code, 'NOT_FOUND', '指定不存在的 ID 不得偷偷新建')
    assert.equal(fs.readFileSync(outside, 'utf8'), '不得改写')
    const linkedUserData = path.join(root, 'linked-userdata')
    const externalDir = path.join(root, 'external')
    fs.mkdirSync(linkedUserData)
    fs.mkdirSync(externalDir)
    fs.symlinkSync(externalDir, path.join(linkedUserData, 'knowledge'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.equal(loadService(linkedUserData).save(input).code, 'UNSAFE_PATH')
    assert.equal(fs.readdirSync(externalDir).length, 0)
    passed('路径穿越、非法 ID、目录链接与未知记录隔离')

    const exact = service.save({ title: '512KB 边界', body: 'x'.repeat(512 * 1024) })
    assert.equal(exact.ok, true)
    assert.equal(loadService(userData).list().records.find((record) => record.id === exact.record.id).body.length, 512 * 1024)
    assert.equal(service.save({ title: '超限', body: '中'.repeat(Math.ceil(512 * 1024 / 3)) }).code, 'INVALID_RECORD')
    assert.equal(service.save({ title: '元信息过长', sourceIds: Array.from({ length: 100 }, (_, index) => `${index}${'中'.repeat(250)}`) }).code, 'INVALID_RECORD', '不能写入下一次重启无法读取的超长元信息')
    for (const patch of [{ title: '' }, { title: [] }, { body: {} }, { type: 'todo' }, { status: 'done' }, { tags: '标签' }, { tags: [1] }, { sourceIds: {} }, { projectId: {} }]) {
      assert.equal(service.save({ ...input, ...patch }).code, 'INVALID_RECORD')
    }
    for (const type of ['idea', 'problem', 'decision', 'experience', 'method', 'sop', 'principle', 'ai']) assert.equal(service.save({ title: type, type }).ok, true)
    passed('正文按 UTF-8 字节限制、类型状态及结构字段校验')

    const exported = service.exportMarkdown(current.id)
    assert.equal(exported.ok, true)
    const imported = service.importMarkdown({ fileName: exported.fileName, content: exported.content })
    assert.equal(imported.ok, true)
    assert.notEqual(imported.record.id, current.id)
    for (const key of ['title', 'body', 'type', 'status', 'tags', 'projectId', 'projectName', 'sourceIds']) assert.deepEqual(imported.record[key], current[key])
    assert.equal(imported.record.revision, 1)
    assert.equal(imported.record.deletedAt, null)
    const plain = service.importMarkdown({ fileName: '../../普通记录.md', content: '# 从正文取标题\n\n导入内容' })
    assert.equal(plain.record.title, '从正文取标题')
    assert.equal(plain.record.status, 'inbox')
    assert.equal(service.importMarkdown({ fileName: 'C:\\目录\\空白笔记.md', content: '' }).record.title, '空白笔记')
    const external = { ...current, id: '../../outside', path: outside, fileName: outside, revision: 900, deletedAt: Date.now(), title: '外部元信息', status: 'draft' }
    delete external.body
    const malicious = service.importMarkdown({ content: `---\n${YAML.stringify(external)}---\n外部正文` })
    assert.equal(malicious.ok, true)
    assert.notEqual(malicious.record.id, current.id)
    assert.equal(malicious.record.revision, 1)
    assert.equal(malicious.record.deletedAt, null)
    assert.equal(Object.hasOwn(malicious.record, 'path'), false)
    assert.equal(fs.readFileSync(outside, 'utf8'), '不得改写')
    const reserved = service.save({ title: 'CON', body: '' })
    assert.match(service.exportMarkdown(reserved.record.id).fileName, /^记录-/)
    const separators = service.save({ title: '../目录\\测试:*?<>|', body: '' })
    assert.doesNotMatch(service.exportMarkdown(separators.record.id).fileName, /[/\\:*?<>|]/)
    passed('Markdown 无损往返、普通文件导入、外部身份忽略与安全导出文件名')

    const badId = randomUUID()
    const badFile = path.join(dir, `${badId}.md`)
    const badContent = '---\nid: [未闭合\n---\n必须保留的原文'
    fs.writeFileSync(badFile, badContent, 'utf8')
    fs.writeFileSync(path.join(dir, '不规范文件名.md'), '# 外部手工放入文件', 'utf8')
    const listed = service.list()
    assert.equal(listed.ok, true)
    assert.equal(listed.warnings.length, 2)
    assert(listed.records.some((record) => record.id === current.id))
    assert.equal(service.save({ ...input, id: badId, revision: 1 }).code, 'CORRUPT_RECORD')
    assert.equal(service.trash(badId).code, 'CORRUPT_RECORD')
    assert.equal(service.exportMarkdown(badId).code, 'CORRUPT_RECORD')
    assert.equal(fs.readFileSync(badFile, 'utf8'), badContent, '读坏文件不能被空内容或新记录覆盖')
    assert.equal(service.importMarkdown({ content: '---\ntitle: 一\ntitle: 二\n---\n正文' }).code, 'CORRUPT_RECORD')
    assert.equal(service.importMarkdown({ content: '---\na: &a [x]\ntags: *a\n---\n正文' }).code, 'CORRUPT_RECORD')
    assert.equal(service.importMarkdown({ content: '---\ntitle: !未知 标题\n---\n正文' }).code, 'CORRUPT_RECORD')
    passed('坏文件逐项警告、有效记录可读、原文保护和恶意 YAML 拒绝')

    current = service.list().records.find((record) => record.id === current.id)
    const beforeFailure = fs.readFileSync(file, 'utf8')
    const failedFs = Object.create(fs)
    failedFs.renameSync = () => { const error = new Error('模拟原子替换失败'); error.code = 'EACCES'; throw error }
    const failed = loadService(userData, failedFs).save({ ...current, body: '不应覆盖' })
    assert.equal(failed.ok, false)
    assert.equal(fs.readFileSync(file, 'utf8'), beforeFailure)
    assert.equal(fs.readdirSync(dir).some((name) => /\.(tmp|lock)$/.test(name)), false)
    assert.equal(service.save({ ...current, body: '磁盘恢复后保存成功' }).ok, true)
    const failedLockFs = Object.create(fs)
    failedLockFs.writeFileSync = (fd, ...args) => {
      if (typeof fd === 'number') { const error = new Error('模拟磁盘已满'); error.code = 'ENOSPC'; throw error }
      return fs.writeFileSync(fd, ...args)
    }
    assert.equal(loadService(userData, failedLockFs).save({ title: '失败的新记录' }).ok, false)
    assert.equal(fs.readdirSync(dir).some((name) => /\.lock$/.test(name)), false, '创建锁后写入失败不得遗留阻塞锁')
    passed('原子替换失败保留原文件、锁写入失败清理及同版本可重试')

    current = service.list().records.find((record) => record.id === current.id)
    const lockPath = path.join(dir, `.${current.id}.lock`)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: '当前活动进程' }))
    assert.equal(service.save(current).code, 'RECORD_BUSY')
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, '当前活动进程')
    fs.unlinkSync(lockPath)
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    assert.equal(exited.status, 0)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: Number(exited.stdout), token: '已退出进程' }))
    assert.equal(service.save(current).ok, true)
    assert.equal(fs.existsSync(lockPath), false)
    passed('活动进程锁不被删除，已退出进程的锁可恢复')

    const externalBase = service.save({ title: '外部编辑保护', body: '原始内容' }).record
    const externalPath = path.join(dir, `${externalBase.id}.md`)
    const rawBeforeExternal = fs.readFileSync(externalPath, 'utf8')
    const externalContent = rawBeforeExternal.replace('原始内容', '外部编辑器保存的正文')
    fs.writeFileSync(externalPath, externalContent, 'utf8')
    const externalRead = loadService(userData).list().records.find(record => record.id === externalBase.id)
    assert.equal(externalRead.revision, externalBase.revision, '外部编辑器不必自动更新应用版本号')
    assert.notEqual(externalRead.contentHash, externalBase.contentHash)
    assert.equal(service.save({ ...externalBase, body: '旧草稿不得覆盖' }).code, 'REVISION_CONFLICT')
    assert.equal(fs.readFileSync(externalPath, 'utf8'), externalContent)
    const externalResolved = service.save({ ...externalRead, body: '核对外部修改后再保存' })
    assert.equal(externalResolved.ok, true)
    assert.notEqual(externalResolved.record.contentHash, externalRead.contentHash)
    assert.deepEqual(loadService(userData).list().records.find(record => record.id === externalBase.id), externalResolved.record)
    const { contentHash: _legacyHash, ...legacyPayload } = externalResolved.record
    assert.equal(service.save({ ...legacyPayload, body: '兼容未携带指纹的既有调用' }).ok, true)
    passed('外部编辑未变 revision 仍通过瞬时文件指纹检出，旧接口保持兼容')

    console.log(`知识库自测通过：${groups} 组，耗时 ${((Date.now() - startedAt) / 1000).toFixed(2)} 秒。`)
  } finally {
    // 仅清理本脚本创建且位于系统临时目录下的唯一测试目录。
    const resolved = path.resolve(root)
    const tempRoot = path.resolve(os.tmpdir())
    assert(path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith('knowledge-selftest-'))
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--writer') writer()
else main().catch((error) => { console.error(error); process.exitCode = 1 })
