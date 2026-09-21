/**
 * 发布更新内容自测：真实 Git 仓库采集 + 通俗中文整理 + 历史记录写回。
 * 用法：node scripts/deploy-release-notes-selftest.cjs
 *
 * 覆盖：
 *   1. 提交标题整理（去掉 feat/fix 前缀、编号引用、方括号标签）
 *   2. AI 输出清洗：混进英文的整条丢弃，版本号不算英文
 *   3. 真实 git 仓库：按最近标签/上次发布提交号确定采集范围；非仓库安全降级
 *   4. 打标签（含同名标签不覆盖）
 *   5. summarizeRecord：AI 正常 → 写回 ai 来源；AI 报错/只说英文 → 退回本地整理
 * 说明：AI 接口属外部系统，此处用桩替代（不 Mock 的是真实 git 与真实历史读写）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'))

// ── 先给 electron / store / ai-service 打好桩，再加载被测模块 ──
const Module = require('module')
function stubModule(absPath, exports) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports }
}
const electronPath = require.resolve('electron')
stubModule(electronPath, {
  app: { getPath: () => path.join(tmpRoot, 'userdata') },
  safeStorage: { isEncryptionAvailable: () => false },
})

const aiStub = { complete: null }
stubModule(require.resolve(path.join(root, 'electron', 'ai-service')), aiStub)
// 真实 store（只预置一份配置）：AI 配置走真实读取路径，不额外打桩，避免桩缺少加解密方法
fs.mkdirSync(path.join(tmpRoot, 'userdata'), { recursive: true })
fs.writeFileSync(path.join(tmpRoot, 'userdata', 'config.json'), JSON.stringify({
  ai: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'stub-key', model: 'stub-model' },
}), 'utf8')

const notes = require(path.join(root, 'electron', 'deploy', 'release-notes'))
const history = require(path.join(root, 'electron', 'deploy', 'history'))

// ── 1. 提交标题整理 ──
assert.strictEqual(notes.cleanSubject('feat(订单): 新增批量导出'), '新增批量导出')
assert.strictEqual(notes.cleanSubject('fix：修复金额算错的问题 (#12)'), '修复金额算错的问题')
assert.strictEqual(notes.cleanSubject('[前端] 调整登录按钮位置'), '调整登录按钮位置')
assert.strictEqual(notes.cleanSubject('chore: 整理代码'), '整理代码')
assert.strictEqual(notes.cleanSubject('普通标题原样保留'), '普通标题原样保留')

// ── 2. AI 输出清洗 ──
const sanitized = notes.sanitizePlainChinese([
  '· 修好了登录按钮点不动的问题',
  '· 新增 API 接口',
  '版本号 v1.4.48 已发布',
  '· 导出表格速度更快了',
].join('\n'))
assert.ok(sanitized.text.includes('修好了登录按钮点不动的问题'), '应保留纯中文条目')
assert.ok(sanitized.text.includes('导出表格速度更快了'), '应保留纯中文条目')
assert.ok(!sanitized.text.includes('API'), '混进英文的条目必须丢弃')
assert.strictEqual(sanitized.dropped.length, 1, '应记录被丢弃的条目')
assert.strictEqual(notes.hasLatin('版本 v1.4.48 已发布'), false, '版本号不算英文')
assert.strictEqual(notes.hasLatin('修复 MySQL 连接'), true, '英文单词应被识别')

// ── 3. 本地整理：去重 + 中文说明 ──
const localText = notes.localSummary([
  { subject: 'feat: 新增登录页' },
  { subject: 'feat: 新增登录页' },
  { subject: 'fix: 修复导出报错 (#7)' },
])
assert.ok(localText.includes('这次发布共更新了 2 处内容'), `本地整理条数不对：${localText}`)
assert.ok(localText.includes('· 新增登录页') && localText.includes('· 修复导出报错'), `本地整理内容不对：${localText}`)
assert.ok(!localText.includes('feat'), '本地整理必须去掉英文前缀')

// ── 4. 标签名生成 ──
assert.strictEqual(notes.defaultTagName('1.4.48'), 'v1.4.48')
assert.strictEqual(notes.defaultTagName('v1.4.48'), 'v1.4.48')
assert.strictEqual(notes.defaultTagName(''), '')
assert.strictEqual(notes.defaultTagName('1.2.3/../x'), '')

// ── 5. 真实 Git 仓库采集 ──
const repo = path.join(tmpRoot, 'repo')
fs.mkdirSync(repo, { recursive: true })
const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git(['init', '-q'])
git(['config', 'user.email', 'selftest@example.com'])
git(['config', 'user.name', 'selftest'])
git(['config', 'commit.gpgsign', 'false'])

function commit(message, file, content) {
  fs.writeFileSync(path.join(repo, file), `${content}\n${Date.now()}\n`, 'utf8')
  git(['add', '-A'])
  git(['commit', '-q', '-m', message])
  return git(['rev-parse', 'HEAD']).trim()
}

const shaA = commit('feat：新增登录页', 'a.txt', 'a')
git(['tag', 'v1.0.0', shaA])
const shaB = commit('fix(订单): 修复金额算错的问题 (#12)', 'b.txt', 'b')
const shaC = commit('chore: 整理代码', 'c.txt', 'c')
const head = git(['rev-parse', 'HEAD']).trim()
assert.strictEqual(head, shaC)

;(async () => {
  // 无起点 → 以最近标签为起点，只收标签之后的提交（新→旧）
  const auto = await notes.collect(repo)
  assert.strictEqual(auto.ok, true, `采集应成功：${auto.error}`)
  assert.strictEqual(auto.head, head)
  assert.strictEqual(auto.commits.length, 2, `应采集标签之后的 2 条提交，实际 ${auto.commits.length}`)
  assert.strictEqual(auto.commits[0].hash, shaC, '最新提交应排在最前')
  assert.ok(auto.anchorLabel.includes('v1.0.0'), `起点说明应包含标签：${auto.anchorLabel}`)
  assert.ok(auto.commits[0].subject.includes('整理代码'), '提交标题应完整读取（含中文）')

  // 有起点（上次发布的提交号）→ 只收起点之后的提交
  const ranged = await notes.collect(repo, { anchor: { value: shaB, kind: 'commit', label: '上次发布 1.0.1 之后' } })
  assert.strictEqual(ranged.commits.length, 1, '应只采集上次发布之后的 1 条提交')
  assert.strictEqual(ranged.commits[0].hash, shaC)

  // 起点就是 HEAD → 没有新提交
  const none = await notes.collect(repo, { anchor: { value: head, kind: 'commit', label: 'x' } })
  assert.strictEqual(none.commits.length, 0, '起点为 HEAD 时应没有提交')

  // 起点已不存在（改过历史）→ 安全退回最近提交，不抛错
  const ghost = await notes.collect(repo, { anchor: { value: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', kind: 'commit', label: 'x' } })
  assert.strictEqual(ghost.ok, true, '起点失效时不应失败')
  assert.ok(ghost.commits.length >= 1, '起点失效时应退回最近提交')
  assert.ok(ghost.note, '起点失效时应给出说明')

  // 非 Git 仓库 → 如实返回失败，不抛错
  const plain = path.join(tmpRoot, 'plain')
  fs.mkdirSync(plain, { recursive: true })
  const notRepo = await notes.collect(plain)
  assert.strictEqual(notRepo.ok, false)
  assert.ok(notRepo.error.includes('不是 Git 仓库'), `非仓库应给出原因：${notRepo.error}`)

  // 不存在的目录同样安全降级
  const missing = await notes.collect(path.join(tmpRoot, 'not-exists'))
  assert.strictEqual(missing.ok, false)

  // ── 6. 起点选择：取最近一次成功发布 ──
  const anchor = notes.anchorFromRecords([
    { projectId: 'p1', type: 'deploy', status: 'failed', finishedAt: 9, gitHead: 'bad', version: '9.9.9' },
    { projectId: 'p1', type: 'deploy', status: 'success', finishedAt: 5, gitHead: shaB, version: '1.0.1' },
    { projectId: 'p1', type: 'db-restore', status: 'success', finishedAt: 8, gitHead: shaC },
    { projectId: 'p2', type: 'deploy', status: 'success', finishedAt: 100, gitHead: shaC },
  ], 'p1')
  assert.strictEqual(anchor.value, shaB, '应取 p1 最近一次成功发布的提交号')
  assert.ok(anchor.label.includes('1.0.1'))
  assert.strictEqual(notes.anchorFromRecords([], 'p1'), null)

  // ── 7. 打标签 ──
  const tagged = await notes.createTag(repo, 'v1.0.1', shaC)
  assert.strictEqual(tagged.ok, true, `打标签应成功：${tagged.error}`)
  assert.strictEqual(tagged.existed, false)
  assert.ok(git(['tag', '--list']).includes('v1.0.1'), '标签应真实写入仓库')
  const again = await notes.createTag(repo, 'v1.0.1', shaC)
  assert.strictEqual(again.existed, true, '同名标签不应重复创建')
  const conflict = await notes.createTag(repo, 'v1.0.1', shaB)
  assert.strictEqual(conflict.ok, false, '同名标签指向其他提交必须报冲突')
  assert.strictEqual(git(['rev-parse', 'v1.0.1']).trim(), shaC, '冲突不得移动原标签')
  git(['-c', 'tag.gpgsign=false', 'tag', '-a', 'v-annotated', '-m', '测试附注标签', shaC])
  assert.strictEqual((await notes.createTag(repo, 'v-annotated', shaC)).existed, true)
  git(['tag', '-d', 'v-annotated'])
  assert.strictEqual(notes.anchorFromRecords([
    { projectId: 'p1', targetId: 'prod', type: 'deploy', status: 'success', finishedAt: 1, gitHead: shaA },
    { projectId: 'p1', targetId: 'test', type: 'deploy', status: 'success', finishedAt: 2, gitHead: shaC },
  ], 'p1', 'prod').value, shaA, '不同环境的发布起点必须隔离')
  const badName = await notes.createTag(repo, 'v1.0.1; rm -rf /', shaC)
  assert.strictEqual(badName.ok, false, '非法标签名应被拒绝')

  // 打了新标签后，采集起点自动变成它
  const afterTag = await notes.collect(repo)
  assert.ok(afterTag.anchorLabel.includes('v1.0.1'), `新标签应成为起点：${afterTag.anchorLabel}`)
  assert.strictEqual(afterTag.commits.length, 0, '新标签就在 HEAD 上，应没有新提交')

  // ── 8. 采集结果落历史记录字段 ──
  const captured = await notes.captureFor({ localPath: repo }, { version: '1.0.2', anchor: { value: shaB, kind: 'commit', label: '上次发布 1.0.1 之后' } })
  assert.strictEqual(captured.ok, true, `采集写历史应成功：${captured.error}`)
  assert.strictEqual(captured.fields.gitHead, head)
  assert.strictEqual(captured.fields.gitCommits.length, 1)
  assert.ok(captured.fields.changeSummary.includes('整理代码'), '落库前应先带一份本地整理的说明')
  assert.strictEqual(captured.fields.changeSummarySource, 'local')

  // ── 9. summarizeRecord：AI 写回 / 降级 ──
  function addRecord(id, changes) {
    history.add({
      id, projectId: 'p1', projectName: '测试项目', type: 'deploy', version: '1.0.2',
      status: 'success', startedAt: Date.now(), finishedAt: Date.now(), durationMs: 1,
      gitHead: head, gitTag: '', gitAnchor: '上次发布 1.0.1 之后',
      gitCommits: changes, message: '', logFile: '',
    })
  }

  const recAi = 'rec-ai'
  addRecord(recAi, [{ hash: shaC, date: '2026-09-11', subject: 'chore: 整理代码' }])
  aiStub.complete = async () => ({ text: '· 界面上的按钮位置调整了\n· 修好了导出时报错的问题', model: 'stub-model' })
  const aiRes = await notes.summarizeRecord(recAi, { refresh: true })
  assert.strictEqual(aiRes.ok, true)
  assert.strictEqual(aiRes.source, 'ai', `AI 可用时应写回 AI 结果：${aiRes.error}`)
  assert.strictEqual(notes.hasLatin(aiRes.summary), false, `AI 说明里不允许出现英文：${aiRes.summary}`)
  assert.strictEqual(history.get(recAi).changeSummarySource, 'ai', 'AI 结果应落盘')

  const recRetry = 'rec-retry'
  addRecord(recRetry, [{ hash: shaC, date: '2026-09-11', subject: 'chore: 整理代码' }])
  let call = 0
  aiStub.complete = async () => {
    call += 1
    return { text: call === 1 ? '· 修复了 API 的问题' : '· 修好了数据导入的问题', model: 'stub-model' }
  }
  const retryRes = await notes.summarizeRecord(recRetry, { refresh: true })
  assert.strictEqual(retryRes.source, 'ai', '首次混入英文应重试一次')
  assert.strictEqual(retryRes.summary, '· 修好了数据导入的问题')
  assert.strictEqual(call, 2, '应恰好重试一次')

  const recLocal = 'rec-local'
  addRecord(recLocal, [{ hash: shaC, date: '2026-09-11', subject: 'chore: 整理代码' }])
  aiStub.complete = async () => { throw new Error('网络不通') }
  const localRes = await notes.summarizeRecord(recLocal, { refresh: true })
  assert.strictEqual(localRes.ok, true, 'AI 失败也要给出可展示的说明')
  assert.strictEqual(localRes.source, 'local')
  assert.ok(localRes.summary.includes('整理代码'), `应退回本地整理：${localRes.summary}`)
  assert.ok(localRes.error.includes('网络不通'), '应如实说明 AI 失败原因')
  assert.strictEqual(history.get(recLocal).changeSummarySource, 'local')

  const recEnglishOnly = 'rec-english'
  addRecord(recEnglishOnly, [{ hash: shaC, date: '2026-09-11', subject: 'chore: 整理代码' }])
  aiStub.complete = async () => ({ text: '· Fixed the API bug', model: 'stub-model' })
  const englishRes = await notes.summarizeRecord(recEnglishOnly, { refresh: true })
  assert.strictEqual(englishRes.source, 'local', '只说英文时必须退回本地整理')
  assert.strictEqual(notes.hasLatin(englishRes.summary), false, `本地整理不应带英文前缀：${englishRes.summary}`)

  const emptyRes = await notes.summarizeRecord('rec-not-exists', { refresh: true })
  assert.strictEqual(emptyRes.ok, false)
  assert.ok(emptyRes.error.includes('不存在'))

  // 记录不存在 / 无提交时也不能抛错
  const recNoCommits = 'rec-no-commits'
  addRecord(recNoCommits, [])
  const noCommitRes = await notes.summarizeRecord(recNoCommits, { refresh: true })
  assert.strictEqual(noCommitRes.ok, false)

  // ── 10. 发布流程集成：真实调用 deploy-service.run，确认发布时就采集提交并落历史 ──
  // 故意把远程部署目录留空 → 本地检查必然失败，不会尝试任何网络连接；
  // 采集发生在本地检查之前，因此失败的发布同样带有「更新内容」。
  const projectsSvc = require(path.join(root, 'electron', 'deploy', 'deploy-projects'))
  const deployService = require(path.join(root, 'electron', 'deploy', 'deploy-service'))
  // 标签 v1.0.1 就在当前 HEAD 上，先做一次新提交，保证这次发布确实有内容可采集
  const shaD = commit('feat: 新增发布说明', 'd.txt')
  const saved = projectsSvc.save({
    id: 'p-run', name: '采集集成项目', localPath: repo,
    version: { strategy: 'manual', manual: '1.0.2' },
    composeFile: 'docker-compose.yml',
    targets: [{
      id: 'p-run_t1', name: '测试环境',
      server: { host: '127.0.0.1', port: 22, username: 'root', authType: 'password', keyPath: '' },
      remotePath: '', // 必须为空：让本地检查直接失败，避免真的去连服务器
      health: { enabled: false, url: '', timeout: 90, interval: 3 },
      dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
      db: { enabled: false, type: 'postgres', container: '', name: '', user: '' },
    }],
  })
  const runId = saved.id || 'p-run'
  const rec = await deployService.run(runId, 'p-run_t1')
  assert.strictEqual(rec.status, 'failed', `远程目录为空时发布应失败：${rec.status}`)
  assert.strictEqual(rec.gitHead, shaD, `发布记录应带上本次提交号：${rec.gitHead}`)
  assert.ok(rec.gitCommits.length >= 1, '发布记录应带上采集到的提交')
  assert.ok(rec.changeSummary.includes('新增发布说明'), `发布记录应带上本地整理说明：${rec.changeSummary}`)
  assert.ok(String(rec.gitAnchor).includes('v1.0.1') && String(rec.gitAnchor).includes('之后'), `应说明采集范围：${rec.gitAnchor}`)
  const persisted = history.get(rec.id)
  assert.ok(persisted && persisted.gitCommits.length >= 1, '采集结果应真实落盘到发布历史')
  assert.strictEqual(git(['tag', '--list', 'v1.0.2']).trim(), '', '失败发布不得生成标签')

  // 真实编排与 Git；仅替换打包和远程传输，避免连接真实服务器。
  const ssh = require(path.join(root, 'electron/deploy/ssh-service'))
  const packager = require(path.join(root, 'electron/deploy/packager'))
  const { EventEmitter } = require('events')
  ssh.connect = async () => ({ sftp: (cb) => cb(null, {
    end() {}, createWriteStream() {
      const stream = new EventEmitter()
      stream.end = () => setImmediate(() => stream.emit('close'))
      return stream
    },
  }) })
  ssh.close = () => {}
  ssh.mkdirp = async () => {}
  ssh.upload = async () => {}
  let outcome = 'success'
  ssh.exec = async (_conn, cmd, onData) => {
    if (cmd.startsWith('bash ')) {
      if (outcome === 'rollback') onData('__STAGE__:rollback\n')
      if (outcome === 'canceled') deployService.cancel()
      onData('__DEPLOY_OK__:测试发布完成\n')
      return { code: 0, stdout: '' }
    }
    return { code: 0, stdout: cmd.startsWith('sha256sum ') ? 'test-sha' : '' }
  }
  packager.buildPackage = async () => ({ fileName: 'test.zip', zipPath: path.join(tmpRoot, 'test.zip'), sizeBytes: 1, fileCount: 1, sha256: 'test-sha', keepLocal: true })
  fs.writeFileSync(path.join(repo, 'docker-compose.yml'), 'services: {}\n')
  const project = projectsSvc.list().find(p => p.id === runId)
  project.targets[0].remotePath = '/test/app'
  projectsSvc.save(project)
  const success = await deployService.run(runId, 'p-run_t1')
  assert.strictEqual(success.status, 'success', success.message)
  assert.strictEqual(success.gitTag, 'v1.0.2')
  assert.strictEqual(git(['rev-parse', 'v1.0.2']).trim(), shaD)
  assert.strictEqual(history.get(success.id).gitTag, 'v1.0.2', '自动标签应落历史')

  const shaE = commit('fix: 修复第二版问题', 'e.txt', 'e')
  project.version.manual = '1.0.3'
  projectsSvc.save(project)
  const next = await deployService.run(runId, 'p-run_t1')
  assert.strictEqual(next.gitTag, 'v1.0.3')
  assert.deepStrictEqual(next.gitCommits.map(c => c.hash), [shaE], '第二次仅包含两版本间提交')
  assert.ok(next.gitAnchor.includes('v1.0.2'))

  project.version.manual = '1.0.4'
  projectsSvc.save(project)
  for (const state of ['rollback', 'canceled']) {
    outcome = state
    await deployService.run(runId, 'p-run_t1')
    assert.strictEqual(git(['tag', '--list', 'v1.0.4']).trim(), '', `${state} 不得打标签`)
  }
  outcome = 'success'
  project.version.manual = '1.0.2'
  projectsSvc.save(project)
  const collision = await deployService.run(runId, 'p-run_t1')
  assert.strictEqual(collision.status, 'success', '标签冲突不应把已完成部署标为失败')
  assert.ok(collision.gitTagError.includes('其他提交'), '标签冲突应记录具体原因')
  assert.strictEqual(git(['rev-parse', 'v1.0.2']).trim(), shaD)

  for (let i = 0; i < 61; i++) git(['commit', '--allow-empty', '-q', '-m', `fix: 批次修改${i}`])
  const fullRange = await notes.collect(repo, { anchor: { value: shaE, kind: 'commit', label: '上版之后' } })
  assert.strictEqual(fullRange.commits.length, 61, '版本间提交不能截断为60条')

  // ── 发布说明文件：约定探测 + 缺失自动生成初稿（Vantage package.sh「缺文件即中止」契约） ──
  assert.deepStrictEqual(notes.parseNotesFileName('release-notes-0.1.12.md'), { vPrefixed: false, version: '0.1.12' })
  assert.deepStrictEqual(notes.parseNotesFileName('release-notes-v2.0.0.md'), { vPrefixed: true, version: '2.0.0' })
  assert.strictEqual(notes.parseNotesFileName('CHANGELOG.md'), null)
  assert.strictEqual(notes.parseNotesFileName('release-notes-.md'), null)

  // 约定探测：docs/ 优先，其次项目根；全带 v 前缀则沿用；一个都没有视为无约定
  const dirDocs = path.join(tmpRoot, 'notes-docs')
  fs.mkdirSync(path.join(dirDocs, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dirDocs, 'docs', 'release-notes-1.0.0.md'), '# 旧版\n')
  let conv = notes.detectNotesConvention(dirDocs)
  assert.strictEqual(conv.relDir, 'docs')
  assert.strictEqual(conv.vPrefixed, false)
  const dirRoot = path.join(tmpRoot, 'notes-root')
  fs.mkdirSync(dirRoot, { recursive: true })
  fs.writeFileSync(path.join(dirRoot, 'release-notes-v9.9.0.md'), '# 根目录约定\n')
  conv = notes.detectNotesConvention(dirRoot)
  assert.strictEqual(conv.relDir, '')
  assert.strictEqual(conv.vPrefixed, true, '既有文件全带 v 前缀时生成也应带 v')
  assert.strictEqual(notes.detectNotesConvention(path.join(tmpRoot, 'notes-none')), null, '无任何发布说明文件 → 无约定')

  // 缺失 → 生成初稿：标题/生成说明/改动范围/清洗后的提交清单；再次调用幂等不覆盖
  const commits = [
    { hash: 'a', date: '2026-09-21', subject: 'feat(web): 落库提示一键切换真正生效' },
    { hash: 'b', date: '2026-09-21', subject: 'fix: 统计周期新增近半年/近一年/全部' },
  ]
  let gen = notes.ensureNotesFile(dirDocs, '2.0.0', {
    appName: '演示系统', anchorLabel: '上次发布 1.9.0 之后', commits, generatedAt: '2026-09-21 13:30',
  })
  assert.ok(gen.wrote, `应生成: ${JSON.stringify(gen)}`)
  assert.strictEqual(gen.file, 'docs/release-notes-2.0.0.md')
  const genPath = path.join(dirDocs, 'docs', 'release-notes-2.0.0.md')
  const genText = fs.readFileSync(genPath, 'utf8')
  assert.ok(genText.startsWith('# 演示系统 2.0.0 发布说明\n'), `标题应含应用名与版本: ${genText}`)
  assert.ok(genText.includes('> 本文件由 project-tool 于 2026-09-21 13:30 自动生成初稿，可人工润色后随代码提交。'))
  assert.ok(genText.includes('改动范围：上次发布 1.9.0 之后，共收录 2 条提交。'))
  assert.ok(genText.includes('- 落库提示一键切换真正生效'), '提交标题应去掉约定式前缀')
  assert.ok(genText.includes('- 统计周期新增近半年/近一年/全部'))
  assert.ok(genText.includes('## 本次更新内容'))
  assert.ok(!genText.includes('feat') && !genText.includes('fix'), '英文前缀不得残留')
  const genText2 = genText
  gen = notes.ensureNotesFile(dirDocs, '2.0.0', { appName: '演示系统', commits, generatedAt: 'x' })
  assert.ok(!gen.wrote, '同版本说明已存在 → 不得重新生成')
  assert.strictEqual(fs.readFileSync(genPath, 'utf8'), genText2, '既有内容必须原样保留')

  // v 前缀约定沿用；无提交记录时留「待补充」而不是空清单
  gen = notes.ensureNotesFile(dirRoot, '10.0.0', { appName: '根目录系统', commits: [], generatedAt: '2026-09-21 13:31' })
  assert.ok(gen.wrote && gen.file === 'release-notes-v10.0.0.md', `应沿用 v 前缀: ${JSON.stringify(gen)}`)
  const noCommitText = fs.readFileSync(path.join(dirRoot, 'release-notes-v10.0.0.md'), 'utf8')
  assert.ok(noCommitText.includes('（待补充）') && noCommitText.includes('请人工补写'), '无提交时应明确留待人工补写')

  // 版本号非法 → 报错而不写文件；无约定 → 明确返回 convention:false 且零改动
  gen = notes.ensureNotesFile(dirDocs, '../evil', { appName: 'x', commits: [] })
  assert.ok(gen.convention && !gen.wrote && gen.error, '非法版本号应返回错误')
  assert.strictEqual(fs.readdirSync(path.join(dirDocs, 'docs')).length, 2, '非法请求不得落任何文件')
  gen = notes.ensureNotesFile(path.join(tmpRoot, 'notes-none'), '3.0.0', { appName: 'x', commits: [] })
  assert.deepStrictEqual(gen, { convention: false, wrote: false, file: '', error: '' }, '无约定项目零打扰')

  console.log('发布更新内容自测全部通过')
})().then(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}).catch((e) => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.error(e)
  process.exit(1)
})
