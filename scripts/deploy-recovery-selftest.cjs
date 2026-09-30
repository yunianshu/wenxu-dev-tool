/** 真实 Bash 和临时目录验证取消、失败恢复；服务命令全部使用替身。 */
const assert = require('assert/strict')
const fs = require('fs'), path = require('path'), os = require('os')
const { spawnSync } = require('child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-recovery-'))
const posix = value => path.resolve(value).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase())
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const source = fs.readFileSync(path.resolve('electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
const lib = path.join(root, 'functions.sh')
fs.writeFileSync(lib, source.slice(0, source.lastIndexOf('case "$CMD" in')))
let count = 0
function check(name, mode, failure, restored = true) {
  const home = path.join(root, name)
  for (const sub of ['releases/stable', 'releases/target', 'backups']) fs.mkdirSync(path.join(home, sub), { recursive: true })
  // Windows 文件名不区分大小写；每个夹具只建立当前形态使用的指针。
  fs.writeFileSync(path.join(home, mode === 'script' ? 'CURRENT' : 'current'), mode === 'script' ? 'stable\n' : posix(path.join(home, 'releases/stable')) + '\n')
  for (const version of ['stable', 'target']) {
    fs.writeFileSync(path.join(home, 'releases', version, 'start.sh'), `echo '${version}-start' >> "$INSTALL_ROOT/trace"\n${version === 'target' && failure === 'start' || version === 'stable' && !restored ? 'exit 1' : 'exit 0'}\n`)
    fs.writeFileSync(path.join(home, 'releases', version, 'stop.sh'), `echo '${version}-stop' >> "$INSTALL_ROOT/trace"\n`)
  }
  const wrapper = `source '${posix(lib)}' rollback --home '${posix(home)}' --mode ${mode} --version target --health-url http://fixture.invalid --health-timeout 1 --health-interval 1
# 指针和服务工具是替身，其余执行项目真实恢复函数。
readlink() { cat "$APP_HOME/current"; }
link_current() { printf '%s\\n' "$1" > "$APP_HOME/current"; }
docker() {
  local release="$(basename "$PWD")"
  echo "$release-$4" >> "$APP_HOME/trace"
  if [ "$4" = up ] && { { [ "$release" = target ] && [ '${failure}' = start ]; } || { [ "$release" = stable ] && [ '${restored}' = false ]; }; }; then return 1; fi
  return 0
}
health_docker() { [ "$(basename "$1")" = stable ] && [ '${restored}' = true ]; }
health_http() {
  if [ "$MODE" = script ]; then [ "$(get_current)" = stable ] && [ '${restored}' = true ];
  else health_docker "$(readlink -f "$CURRENT")"; fi
}
${failure.startsWith('signal') ? `OLD_CURRENT_NAME=stable; OLD_RELEASE="$RELEASES/stable"; NEW_RELEASE="$RELEASES/target";
${failure === 'signal-before-pointer' ? '' : mode === 'script' ? 'set_current target;' : 'link_current "$RELEASES/target";'}
${failure === 'signal-off' ? 'AUTO_ROLLBACK=0;' : ''}
kill -TERM $$` : mode === 'script' ? 'do_rollback_cmd_script' : 'do_rollback_cmd'}
`
  const file = path.join(home, 'check.sh')
  fs.writeFileSync(file, wrapper)
  const result = spawnSync(bash, [posix(file)], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const trace = fs.existsSync(path.join(home, 'trace')) ? fs.readFileSync(path.join(home, 'trace'), 'utf8') : ''
  const pointer = fs.readFileSync(path.join(home, mode === 'script' ? 'CURRENT' : 'current'), 'utf8').trim().split('/').pop()
  if (failure === 'signal-off') {
    assert.equal(pointer, 'target')
    assert.equal(trace, '')
    assert.match(result.stdout, /自动回滚未启用/)
  } else {
    assert.equal(pointer, 'stable', `${name}\n${result.stdout}\n${result.stderr}\n${trace}`)
    assert.match(trace, mode === 'script' ? /target-stop[\s\S]*stable-start/ : /target-down[\s\S]*stable-up/)
    assert.match(result.stdout, restored ? /已自动回滚到 stable/ : /恢复.*失败/)
    if (!restored) assert.doesNotMatch(result.stdout, /已自动回滚到/)
    if (mode === 'script') assert.doesNotMatch(trace, /target-down|stable-up/)
  }
  assert.doesNotMatch(result.stdout, /__DEPLOY_OK__/)
  assert.equal(fs.existsSync(path.join(home, '.deploy.lock')), false)
  count++
}
try {
  for (const mode of ['script', 'docker']) {
    check(mode + '-start', mode, 'start')
    check(mode + '-health', mode, 'health')
    check(mode + '-signal', mode, 'signal')
    check(mode + '-restore-failed', mode, 'health', false)
  }
  check('script-before-pointer', 'script', 'signal-before-pointer')
  check('script-no-auto', 'script', 'signal-off')
  console.log(`通过：${count} 组取消、启动失败、健康失败和恢复失败真实 Bash 检查`)
} finally {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-recovery-')) fs.rmSync(root, { recursive: true, force: true })
}
