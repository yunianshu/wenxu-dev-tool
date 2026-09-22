/** 真实 Bash 验证自动环境复用、项目名隔离与全部容器健康要求；不运行真实 Docker。 */
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os')
const { spawnSync } = require('child_process')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-auto-shell-'))
const posix = p => path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase())
const bash = process.platform === 'win32' && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
try {
  const deploy = fs.readFileSync(path.resolve('electron/deploy/scripts/deploy.sh'), 'utf8').replace(/\r\n/g, '\n')
  const lib = path.join(root, 'functions.sh')
  fs.writeFileSync(lib, deploy.slice(0, deploy.lastIndexOf('case "$CMD" in')))
  const test = path.join(root, 'check.sh')
  fs.writeFileSync(test, `source '${posix(lib)}' deploy --project-name app-isolated --release-id 1.0.0-new
[ "$COMPOSE_PROJECT_NAME" = app-isolated ] || exit 8
[ "$RELEASE_ID" = 1.0.0-new ] || exit 9
HEALTH_TIMEOUT=1; HEALTH_INTERVAL=1; BROKEN=1
docker() {
  if [ "$1" = compose ]; then
    case "$4" in config) printf 'app\\ndb\\n';; ps) printf 'app-id\\ndb-id\\n';; esac
  elif [ "$1" = inspect ]; then
    if [[ "$3" == *Running* ]]; then
      if [ "$4" = app-id ] && [ "$BROKEN" = 1 ]; then echo false; else echo true; fi
    else echo healthy; fi
  fi
}
if health_docker '${posix(root)}'; then echo '错误：只有数据库正常也被判成功'; exit 10; fi
BROKEN=0
health_docker '${posix(root)}' || exit 11
echo '全部容器健康检查通过，单容器失败正确拦截'
`)
  const result = spawnSync(bash, [posix(test)], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const prepare = path.join(root, 'prepare.sh')
  fs.writeFileSync(prepare, fs.readFileSync('electron/deploy/scripts/prepare.sh', 'utf8').replace(/\r\n/g, '\n'))
  const reuse = spawnSync(bash, ['-c', `uname(){ echo Linux; }; docker(){ return 0; }; unzip(){ return 0; }; export -f uname docker unzip; bash '${posix(prepare)}'`], { encoding: 'utf8', timeout: 10000 })
  assert.equal(reuse.status, 0, reuse.stdout + reuse.stderr)
  assert(reuse.stdout.includes('运行环境已就绪'))
  console.log('PASS 真实 Bash：已有环境复用、稳定项目名、独立版本目录、全部服务健康检查')
} finally {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('deploy-auto-shell-')) fs.rmSync(root, { recursive: true, force: true })
}
