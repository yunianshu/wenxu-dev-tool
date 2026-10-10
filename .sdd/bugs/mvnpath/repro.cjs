// 隔离复现：模拟桌面应用启动时尚未继承 Maven 配置。
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const electronPath = require.resolve('electron')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mvn-path-repro-')))
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => root }, safeStorage: { isEncryptionAvailable: () => false } },
}
try {
  const { localShellEnv } = require('../../../electron/deploy/deploy-service')
  const env = { ...process.env }
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') || 'Path'
  env[key] = String(env[key] || '').split(';').filter((dir) => !/maven/i.test(dir)).join(';')
  for (const name of Object.keys(env)) if (/^(MAVEN_HOME|M2_HOME)$/i.test(name)) delete env[name]
  const result = spawnSync('bash -c "uname -s; mvn -version"', {
    shell: true, env: localShellEnv(env), encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  console.log(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2))
  process.exitCode = result.status === 0 ? 0 : 1
} finally {
  if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('mvn-path-repro-')) throw new Error('复现目录越界')
  fs.rmSync(root, { recursive: true, force: true })
}
