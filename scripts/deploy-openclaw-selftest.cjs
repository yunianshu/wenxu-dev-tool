/** 实际文件与发布 ZIP 验证；Docker 边界由独立 shell 夹具覆盖。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-openclaw-'))
const electron = require.resolve('electron')
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
  app: { getPath: () => path.join(root, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false },
} }
const { prepareOpenClaw, normalizeOpenClaw, PREFIX } = require('../electron/deploy/openclaw-sync')
const projects = require('../electron/deploy/deploy-projects')
const { buildDeployArgs, STAGES } = require('../electron/deploy/deploy-service')
const packager = require('../electron/deploy/packager')
let checks = 0
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`) }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

;(async () => {
  const projectDir = path.join(root, 'project')
  write(path.join(projectDir, 'docker-compose.yml'), 'services: {}\n')
  write(path.join(projectDir, 'openclaw/plugin/package.json'), JSON.stringify({ version: '1.2.3', files: ['dist', 'openclaw.plugin.json'], openclaw: { extensions: ['./dist/index.mjs'] } }))
  write(path.join(projectDir, 'openclaw/plugin/openclaw.plugin.json'), JSON.stringify({ id: 'sample-plugin', version: '1.2.3' }))
  write(path.join(projectDir, 'openclaw/plugin/dist/index.mjs'), 'export default {register(){}}\n')
  write(path.join(projectDir, 'openclaw/plugin/.env'), 'PRIVATE_FIXTURE=never-copy')
  write(path.join(projectDir, 'openclaw/plugin/dev-only.txt'), '开发辅助文件不属于发布包')
  write(path.join(projectDir, 'openclaw/plugin/node_modules/host-only/index.js'), '本机依赖不发布')
  write(path.join(projectDir, 'openclaw/skill/SKILL.md'), '---\nname: sample-skill\ndescription: 测试技能\n---\n技能正文\n')
  write(path.join(projectDir, 'openclaw/skill/references/schema.md'), '接口说明\n')
  const config = { enabled: true, container: 'openclaw-fixture', pluginDir: 'openclaw/plugin', skillDir: 'openclaw/skill' }
  const project = { name: '隔离发布', localPath: projectDir, configMode: 'manual', deployMode: 'docker', targets: [{ id: 'prod', name: '生产', server: { host: 'claw.example.invalid' }, openclaw: config }] }
  let prepared
  check('旧配置默认关闭；环境保存和重读保持配置；跨项目复制不带同步设置', () => {
    assert.equal(normalizeOpenClaw().enabled, false)
    assert.equal(prepareOpenClaw(project, {}), null)
    const result = projects.save(project)
    assert.equal(result.ok, true)
    const saved = projects.list().find(p => p.id === result.id)
    assert.deepEqual(saved.targets[0].openclaw, normalizeOpenClaw(config))
    const other = projects.save({ name: '其他项目', localPath: projectDir })
    assert.equal(projects.copyConfig({ fromProjectId: result.id, toProjectId: other.id }).copiedTargets, 1)
    assert.equal(projects.list().find(p => p.id === other.id).targets.every(t => !t.openclaw.enabled), true)
    prepared = prepareOpenClaw(saved, saved.targets[0])
  })
  check('来源包含构建入口与 Skill，排除凭证和本机依赖，关闭不产生覆盖文件', () => {
    assert.equal(prepared.manifest.resources.length, 2)
    assert(prepared.files.some(f => f.path === `${PREFIX}/plugin/dist/index.mjs`))
    assert(prepared.files.some(f => f.path === `${PREFIX}/skill/SKILL.md`))
    assert(!prepared.files.some(f => /\.env|node_modules/.test(f.path)))
    assert(!prepared.files.some(f => /dev-only/.test(f.path)))
    assert(prepared.files.find(f => f.path === `${PREFIX}/sync.sh`).content.includes("CONTAINER='openclaw-fixture'"))
    write(path.join(projectDir, '.deployignore'), '!**/node_modules/**\n')
    assert(!prepareOpenClaw(project, { openclaw: config }).files.some(f => f.path.includes('/node_modules/')))
    fs.unlinkSync(path.join(projectDir, '.deployignore'))
  })
  check('拒绝目录越界、非法容器与容器根路径，以及未构建和被忽略的必要文件', () => {
    for (const change of [{ pluginDir: '../project' }, { pluginDir: projectDir }, { container: 'bad;touch /tmp/x' }, { home: '/root' }, { workspace: '/tmp/../etc' }]) {
      assert.throws(() => prepareOpenClaw(project, { openclaw: { ...config, ...change } }))
    }
    assert.throws(() => prepareOpenClaw({ ...project, deployMode: 'script' }, { openclaw: config }), /Docker/)
    const entry = path.join(projectDir, 'openclaw/plugin/dist/index.mjs')
    fs.renameSync(entry, entry + '.saved')
    assert.throws(() => prepareOpenClaw(project, { openclaw: config }), /构建入口/)
    fs.renameSync(entry + '.saved', entry)
    write(path.join(projectDir, '.deployignore'), '/openclaw/plugin/dist/\n')
    assert.throws(() => prepareOpenClaw(project, { openclaw: config }), /忽略/)
    fs.unlinkSync(path.join(projectDir, '.deployignore'))
    fs.symlinkSync(path.join(projectDir, 'openclaw/plugin'), path.join(projectDir, 'linked-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => prepareOpenClaw(project, { openclaw: { ...config, pluginDir: 'linked-plugin' } }), /符号链接/)
  })
  check('只为开启的环境传递同步参数，独立进度阶段存在', () => {
    const base = { ...project, composeFile: 'docker-compose.yml' }
    assert(buildDeployArgs(base, { remotePath: '/srv/fixture', openclaw: config }, { fileName: 'app.zip', sha256: 'abc' }, '1.0').includes('--openclaw-sync'))
    assert(!buildDeployArgs(base, { remotePath: '/srv/fixture' }, { fileName: 'app.zip', sha256: 'abc' }, '1.0').includes('--openclaw-sync'))
    assert(STAGES.some(s => s.id === 'openclaw'))
  })
  const pkg = await packager.buildPackage({ projectDir, appName: path.basename(root), version: '1.0', includeBuild: true, files: prepared.files })
  const unpacked = path.join(root, 'unpacked')
  fs.mkdirSync(unpacked)
  if (process.platform === 'win32') execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${pkg.zipPath.replaceAll("'", "''")}' -DestinationPath '${unpacked.replaceAll("'", "''")}'`], { windowsHide: true })
  else execFileSync('unzip', ['-q', pkg.zipPath, '-d', unpacked])
  const manifestFile = path.join(unpacked, PREFIX, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile))
  const home = path.join(root, 'container', '.openclaw')
  manifest.home = home; manifest.workspace = path.join(home, 'workspace')
  write(manifestFile, JSON.stringify(manifest))
  const { synchronize } = await import(pathToFileURL(path.join(unpacked, PREFIX, 'worker.mjs')).href)
  const dest = path.join(home, 'extensions/sample-plugin/dist/index.mjs')
  write(dest, '旧插件\n')
  write(path.join(home, 'extensions/sample-plugin/user-extra.txt'), '用户文件保持原样')
  check('真实 ZIP 中的工作程序更新插件及两份 Skill，并核验全部内容', () => {
    const applied = synchronize('apply', manifestFile, 'fixture-1', false)
    assert(applied.changed > 0)
    assert.equal(fs.readFileSync(dest, 'utf8'), 'export default {register(){}}\n')
    assert.equal(fs.readFileSync(path.join(home, 'plugin-skills/sample-skill/SKILL.md'), 'utf8'), fs.readFileSync(path.join(home, 'workspace/skills/sample-skill/SKILL.md'), 'utf8'))
    assert.equal(fs.readFileSync(path.join(home, 'extensions/sample-plugin/user-extra.txt'), 'utf8'), '用户文件保持原样')
    assert.deepEqual(synchronize('verify', manifestFile, 'fixture-1', false), { verifiedFiles: 7 })
  })
  check('并发同步拒绝，不恢复其他事务；哈希篡改被识别', () => {
    assert.throws(() => synchronize('apply', manifestFile, 'fixture-2', false), /另一个/)
    assert.throws(() => synchronize('restore', manifestFile, 'fixture-2', false), /其他/)
    write(dest, '篡改')
    assert.throws(() => synchronize('verify', manifestFile, 'fixture-1', false), /校验失败/)
  })
  check('失败恢复旧文件，删除此次新建文件，保留用户其他文件并释放锁', () => {
    const restored = synchronize('restore', manifestFile, 'fixture-1', false)
    assert(restored.restored > 0)
    assert.equal(fs.readFileSync(dest, 'utf8'), '旧插件\n')
    assert(!fs.existsSync(path.join(home, 'workspace/skills/sample-skill')))
    assert(fs.existsSync(path.join(home, 'extensions/sample-plugin/user-extra.txt')))
  })
  check('内容一致时返回零改动；提交保留恢复记录并解锁；来源篡改与目标符号链接拒绝', () => {
    synchronize('apply', manifestFile, 'fixture-3', false)
    synchronize('commit', manifestFile, 'fixture-3', false)
    assert.equal(synchronize('apply', manifestFile, 'fixture-4', false).changed, 0)
    synchronize('commit', manifestFile, 'fixture-4', false)
    const source = path.join(unpacked, PREFIX, 'plugin/dist/index.mjs')
    const original = fs.readFileSync(source)
    write(source, '被更改的来源')
    assert.throws(() => synchronize('apply', manifestFile, 'fixture-5', false), /来源文件校验/)
    write(source, original)
    fs.unlinkSync(dest)
    fs.symlinkSync(path.join(root, 'missing-secret'), dest, 'file')
    assert.throws(() => synchronize('apply', manifestFile, 'fixture-6', false), /符号链接/)
    fs.unlinkSync(dest)
  })
  check('运行时核验拒绝旧版本、加载诊断、不可见技能，并保留可恢复快照', () => {
    const runtime = (plugin = {}, skill = {}, diagnostics = []) => (_cli, args) => ({ status: 0, stdout: JSON.stringify(args[0] === 'plugins'
      ? { plugin: { status: 'loaded', version: '1.2.3', ...plugin }, diagnostics }
      : { eligible: true, modelVisible: true, disabled: false, filePath: path.join(home, 'workspace/skills/sample-skill/SKILL.md'), ...skill }) })
    for (const [id, run] of [['old', runtime({ version: '1.2.2' })], ['diagnostic', runtime({}, {}, [{ level: 'error' }])], ['hidden', runtime({}, { modelVisible: false })]]) {
      assert.throws(() => synchronize('apply', manifestFile, `runtime-${id}`, true, run), /加载状态|Skill/)
      synchronize('restore', manifestFile, `runtime-${id}`, false)
      assert(!fs.existsSync(dest), '运行核验失败后可恢复到操作前文件状态')
    }
    synchronize('apply', manifestFile, 'runtime-good', true, runtime())
    synchronize('commit', manifestFile, 'runtime-good', true, runtime())
  })
  fs.unlinkSync(pkg.zipPath)
  console.log(`OpenClaw 同步专项：${checks} 项通过`)
})().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(() => {
  const absolute = path.resolve(root)
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()))
  assert(path.basename(absolute).startsWith('deploy-openclaw-'))
  fs.rmSync(absolute, { recursive: true, force: true })
})
