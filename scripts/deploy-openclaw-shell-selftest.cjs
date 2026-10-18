/** 真正运行 Bash 发布控制：Docker 为隔离替身，容器内工作程序执行真实文件更新与恢复。 */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { spawnSync, execFileSync } = require('node:child_process')
const { prepareOpenClaw, PREFIX } = require('../electron/deploy/openclaw-sync')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-shell-'))
const posix = p => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
function write(file, data, mode) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode }) }
const bin = path.join(root, 'bin'), runner = path.join(root, 'runner.cjs')
write(runner, `const fs=require('fs'),path=require('path'),{pathToFileURL}=require('url');
;(async()=>{const [action,payload,tx]=process.argv.slice(2);fs.appendFileSync(process.env.CLAW_FLOW,action+'\\n');
const manifest=JSON.parse(fs.readFileSync(payload));const worker=await import(pathToFileURL(path.join(path.dirname(payload),'worker.mjs')));
const run=(_cli,args)=>({status:0,stdout:JSON.stringify(args[0]==='plugins'?{plugin:{status:process.env.CLAW_FAIL==='1'&&action==='verify'?'error':'loaded',version:'2.0.0'},diagnostics:[]}:{eligible:true,modelVisible:true,disabled:false,filePath:path.join(manifest.workspace,'skills/fixture-skill/SKILL.md')})});
console.log(JSON.stringify(worker.synchronize(action,payload,tx,true,run)));})().catch(e=>{console.error(e.message);process.exitCode=1});
`)
write(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -eu
case "$1" in
  compose)
    [ "$2" = version ] && exit 0
    case "$4" in
      config) [ "\${5:-}" = --services ] && echo app; exit 0 ;;
      build|down|up) echo "$4" >> "$CLAW_FLOW" ;;
      ps) echo app-fixture ;;
    esac ;;
  inspect)
    [ "\${CLAW_MISSING:-0}" != 1 ] || exit 2
    if [[ "$3" == *Health* && "$3" == *Running* ]]; then echo 'true healthy'
    elif [[ "$3" == *Health* ]]; then echo healthy; else echo true; fi ;;
  restart) printf 'restart\\n' >> "$CLAW_FLOW" ;;
  cp) mkdir -p "$CLAW_STAGE"; cp -R "\${2%/.}/." "$CLAW_STAGE/" ;;
  exec)
    shift; [ "$1" = --user ] && shift 2; shift
    if [ "$1" = sh ]; then
      if [[ "$3" == *'command -v node'* ]]; then printf '/fixture/node\\n'; else mkdir -p "$CLAW_STAGE"; fi
    elif [ "$1" = rm ]; then :
    else shift 2; ACTION="$1"; shift 2; "$CLAW_NODE" "$CLAW_RUNNER" "$ACTION" "$CLAW_MANIFEST" "$1"; fi ;;
  *) exit 21 ;;
esac
`, 0o755)

function fixture(name) {
  const base = path.join(root, name), source = path.join(base, 'project')
  write(path.join(source, 'plugin/package.json'), JSON.stringify({ version: '2.0.0', openclaw: { extensions: ['./index.mjs'] } }))
  write(path.join(source, 'plugin/openclaw.plugin.json'), JSON.stringify({ id: 'fixture-plugin', version: '2.0.0' }))
  write(path.join(source, 'plugin/index.mjs'), '新版代码')
  write(path.join(source, 'skill/SKILL.md'), '---\nname: fixture-skill\n---\n新版技能')
  const payload = prepareOpenClaw({ localPath: source, deployMode: 'docker' }, { openclaw: { enabled: true, container: 'fixture', pluginDir: 'plugin', skillDir: 'skill' } })
  for (const file of payload.files) write(path.join(source, file.path), file.content)
  const manifestFile = path.join(source, PREFIX, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile))
  manifest.home = path.join(base, 'container/.openclaw'); manifest.workspace = path.join(manifest.home, 'workspace')
  write(manifestFile, JSON.stringify(manifest))
  const destination = path.join(manifest.home, 'extensions/fixture-plugin/index.mjs')
  write(destination, '旧版代码')
  const stage = path.join(base, 'stage'), flow = path.join(base, 'flow')
  write(flow, '')
  return { source, stage, flow, destination }
}
function run(f, tx, extra = {}) {
  return spawnSync(bash, [posix(path.join(f.source, PREFIX, 'sync.sh')), tx], { encoding: 'utf8', timeout: 25000, env: {
    ...process.env, PATH: `${bin}${path.delimiter}${process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin' + path.delimiter : ''}${process.env.PATH}`,
    CLAW_FLOW: f.flow, CLAW_STAGE: posix(f.stage), CLAW_NODE: process.execPath.replace(/\\/g, '/'), CLAW_RUNNER: runner.replace(/\\/g, '/'),
    CLAW_MANIFEST: path.join(f.stage, 'manifest.json').replace(/\\/g, '/'), MSYS2_ARG_CONV_EXCL: '', ...extra,
  } })
}
try {
  const success = fixture('success')
  let result = run(success, 'shell-1')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(fs.readFileSync(success.destination, 'utf8'), '新版代码')
  assert.deepEqual(fs.readFileSync(success.flow, 'utf8').trim().split('\n'), ['apply', 'restart', 'verify', 'commit'])
  write(success.flow, '')
  result = run(success, 'shell-2')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert(!fs.readFileSync(success.flow, 'utf8').includes('restart'), '内容未变化不能重启容器')

  const broken = fixture('broken')
  result = run(broken, 'shell-broken', { CLAW_FAIL: '1' })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.equal(fs.readFileSync(broken.destination, 'utf8'), '旧版代码', result.stdout + result.stderr)
  assert.deepEqual(fs.readFileSync(broken.flow, 'utf8').trim().split('\n'), ['apply', 'restart', 'verify', 'restore', 'restart'])
  assert(!fs.existsSync(path.join(path.dirname(broken.destination), 'package.json')), '回退时清除此轮新建文件')

  const missing = fixture('missing')
  result = run(missing, 'shell-missing', { CLAW_MISSING: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(fs.readFileSync(missing.destination, 'utf8'), '旧版代码')
  assert.equal(fs.readFileSync(missing.flow, 'utf8'), '')

  // 运行服务器真实同步入口，验证开启、禁用、缺产物和失败都使用正确协议。
  const deploy = fs.readFileSync(path.resolve(__dirname, '../electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
  const library = path.join(root, 'deploy-functions.sh')
  write(library, deploy.slice(0, deploy.lastIndexOf('case "$CMD" in')))
  const script = path.join(root, 'entry.sh')
  write(script, `source '${posix(library)}' deploy --openclaw-sync
sync_openclaw '${posix(path.join(root, 'absent'))}' && exit 5
OPENCLAW_SYNC=0
sync_openclaw '${posix(path.join(root, 'absent'))}' || exit 6
`)
  result = spawnSync(bash, [posix(script)], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert(result.stdout.includes('__STAGE_SKIP__:openclaw'))
  assert(!result.stdout.includes('__STAGE_OK__:openclaw'))

  const fullScript = path.join(root, 'deploy.sh'); write(fullScript, deploy)
  function fullFixture(name) {
    const home = path.join(root, name), source = path.join(home, 'source'), flow = path.join(home, 'flow')
    write(path.join(home, 'releases/old/docker-compose.yml'), 'services: {}\n')
    write(path.join(source, 'docker-compose.yml'), 'services: {}\n')
    write(path.join(source, PREFIX, 'sync.sh'), '#!/usr/bin/env bash\necho sync >> "$CLAW_FLOW"\n[ "${CLAW_FLOW_FAIL:-0}" != 1 ]\n')
    fs.mkdirSync(path.join(home, 'uploads'), { recursive: true }); write(flow, '')
    fs.symlinkSync(path.join(home, 'releases/old'), path.join(home, 'current'), process.platform === 'win32' ? 'junction' : 'dir')
    execFileSync(process.execPath, ['-e', `const fs=require('fs'),archive=require('archiver')('zip');const out=fs.createWriteStream(process.argv[2]);archive.on('error',e=>{throw e});archive.pipe(out);archive.directory(process.argv[1],false);archive.finalize();`, source, path.join(home, 'uploads/app.zip')])
    return { home, flow }
  }
  function fullRun(f, command = 'deploy', extra = {}) {
    const args = [posix(fullScript), command, '--app', 'fixture', '--home', posix(f.home), '--version', command === 'deploy' ? 'new' : 'old', '--compose', 'docker-compose.yml', '--no-backup-code', '--no-backup-db', '--health-timeout', '1', '--health-interval', '1', '--openclaw-sync']
    if (command === 'deploy') args.push('--package', 'app.zip')
    return spawnSync(bash, args, { encoding: 'utf8', timeout: 20000, env: { ...process.env,
      PATH: `${bin}${path.delimiter}${process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin' + path.delimiter : ''}${process.env.PATH}`,
      CLAW_FLOW: posix(f.flow), MSYS: 'winsymlinks:nativestrict', ...extra } })
  }
  const deployed = fullFixture('full-success')
  result = fullRun(deployed)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(fs.readFileSync(deployed.flow, 'utf8').trim().split('\n'), ['build', 'down', 'up', 'sync'])
  assert(result.stdout.indexOf('__STAGE__:health') < result.stdout.indexOf('__STAGE__:openclaw'))
  assert(result.stdout.indexOf('__STAGE_OK__:openclaw') < result.stdout.indexOf('__DEPLOY_OK__'))
  assert.equal(fs.realpathSync(path.join(deployed.home, 'current')), fs.realpathSync(path.join(deployed.home, 'releases/new')))
  write(deployed.flow, '')
  result = fullRun(deployed, 'rollback')
  assert.equal(result.status, 1)
  assert(result.stdout.includes('缺少 OpenClaw 同步产物'))
  assert.equal(fs.readFileSync(deployed.flow, 'utf8'), '', '无法同步的旧版在停服务前拒绝')
  write(path.join(deployed.home, 'releases/old', PREFIX, 'sync.sh'), '#!/usr/bin/env bash\necho sync >> "$CLAW_FLOW"\n')
  result = fullRun(deployed, 'rollback')
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(fs.readFileSync(deployed.flow, 'utf8').trim().split('\n'), ['down', 'up', 'sync'])

  const failed = fullFixture('full-failed')
  result = fullRun(failed, 'deploy', { CLAW_FLOW_FAIL: '1' })
  assert.equal(result.status, 1)
  assert(result.stdout.includes('OpenClaw 插件或 Skill 同步失败') && result.stdout.includes('已自动回滚到 old'))
  assert(!result.stdout.includes('__DEPLOY_OK__'))
  assert.equal(fs.realpathSync(path.join(failed.home, 'current')), fs.realpathSync(path.join(failed.home, 'releases/old')))
  console.log('PASS OpenClaw 真实 Bash：文件更新、按需重启、运行核验失败恢复、缺容器不改文件、禁用与失败协议')
  console.log('PASS 完整服务器发布与回滚：应用健康后同步、同步后报告成功、同步失败回滚应用、旧版产物守卫')
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert(path.basename(root).startsWith('claw-shell-'))
  fs.rmSync(root, { recursive: true, force: true })
}
