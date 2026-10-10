/** 部署静态校验回归：只使用临时项目，不构建、不连接服务器、不执行生成脚本。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { validateDeploymentFiles } = require('../electron/deploy/deployment-validator')

const started = Date.now()
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plm-deploy-validation-'))
let count = 0
const project = (name) => {
  const localPath = path.join(fixtureRoot, name)
  fs.mkdirSync(localPath)
  return { localPath }
}
const put = (p, rel, content = '') => {
  const file = path.join(p.localPath, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const generated = (rel, content, extra = {}) => ({ path: rel, content, ...extra })
const docker = (composeFile = 'compose.yaml') => ({ deployMode: 'docker', composeFile })
const script = (extra = {}) => ({ deployMode: 'script', scriptMode: {}, version: { strategy: 'manual', manual: '1.2.3' }, ...extra })
const check = (label, run) => { run(); count++; process.stdout.write(`通过：${label}\n`) }
const rejects = (result, pattern) => {
  assert.strictEqual(result.ok, false, JSON.stringify(result))
  assert(result.errors.some((item) => pattern.test(item)), JSON.stringify(result))
}

try {
  const p = project('virtual')
  put(p, 'server/app.js', 'console.log("服务入口")\n')
  const virtual = [
    generated('compose.yaml', 'services:\n  app:\n    build:\n      context: .\n      dockerfile: deploy/Dockerfile.server\n    env_file:\n      - .env.example\n'),
    generated('deploy/Dockerfile.server', '# syntax=docker/dockerfile:1\nFROM node:22\nRUN --mount=type=cache,target=/root/.npm true\nCOPY ["server/app.js", "/app/"]\n'),
    generated('.env.example', 'API_KEY=your-api-key-here\nDB_PASSWORD=\n'),
  ]
  check('生成文件通过虚拟覆盖相互引用，支持 nested Dockerfile 与继承入口', () => {
    const result = validateDeploymentFiles(p, docker(), virtual)
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert.strictEqual(fs.existsSync(path.join(p.localPath, 'compose.yaml')), false, '校验不得写入生成文件')
  })
  check('磁盘已有文件能被虚拟修正覆盖', () => {
    put(p, 'compose.yaml', 'broken: [')
    assert.strictEqual(validateDeploymentFiles(p, docker(), virtual).ok, true)
  })
  check('无完整计划时允许分步生成单个 Compose', () => {
    assert.strictEqual(validateDeploymentFiles(p, {}, [generated('compose.yaml', 'services:\n  app:\n    build: missing-yet\n')]).ok, true)
  })
  check('无完整计划时仍校验 YAML 与 Dockerfile 自身', () => {
    rejects(validateDeploymentFiles(p, {}, [generated('compose.yaml', 'services: [')]), /YAML/)
    rejects(validateDeploymentFiles(p, {}, [generated('Dockerfile.prod', 'RUN true\n')]), /FROM/)
  })
  check('拒绝重复、空、非白名单、越界与过大生成内容', () => {
    rejects(validateDeploymentFiles(p, {}, [generated('VERSION', '1.0.0'), generated('VERSION', '2.0.0')]), /重复/)
    rejects(validateDeploymentFiles(p, {}, [generated('start.sh', '')]), /为空/)
    rejects(validateDeploymentFiles(p, {}, [generated('server/app.js', 'throw 1')]), /白名单/)
    rejects(validateDeploymentFiles(p, {}, [generated('../Dockerfile', 'FROM busybox')]), /不安全/)
    rejects(validateDeploymentFiles(p, {}, [generated('.dockerignore', 'a'.repeat(400 * 1024 + 1))]), /400 KiB/)
    rejects(validateDeploymentFiles(p, {}, [generated('.dockerignore', 'node_modules'), generated('.dockerignore/Dockerfile', 'FROM busybox')]), /父目录已被文件占用/)
  })
  check('拒绝截断、代码围栏与未完成占位内容', () => {
    rejects(validateDeploymentFiles(p, {}, [generated('start.sh', '#!/bin/bash\ntrue\n', { truncated: true })]), /截断/)
    rejects(validateDeploymentFiles(p, {}, [generated('start.sh', '#!/bin/bash\n# 其余保持不变\n')]), /占位/)
    rejects(validateDeploymentFiles(p, {}, [generated('Dockerfile', '```dockerfile\nFROM busybox\n```')]), /占位/)
  })
  check('坏 YAML、空服务与无镜像服务被拦截', () => {
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services: [')]), /YAML/)
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services: {}')]), /非空 services/)
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    command: sleep 60\n')]), /image 或 build/)
    rejects(validateDeploymentFiles(p, {}, [generated('compose.yaml', 'services:\n  app:\n    image: busybox\n    image: alpine\n')]), /YAML/)
  })
  check('COPY 缺失本地源被拦截，动态、多阶段、远端源不误判', () => {
    const config = generated('compose.yaml', 'services:\n  app:\n    build: .\n')
    rejects(validateDeploymentFiles(p, docker(), [config, generated('Dockerfile', 'FROM busybox\nCOPY missing.jar /app/\n')]), /构建源不存在/)
    const result = validateDeploymentFiles(p, docker(), [config, generated('Dockerfile', 'FROM busybox AS base\nCOPY --from=base /bin/sh /sh\nCOPY *.jar /app/\nARG SOURCE\nCOPY $SOURCE /app/\nADD https://example.invalid/archive.tar /app/\n')])
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert(result.warnings.some((item) => /实际构建/.test(item)))
  })
  check('Dockerfile heredoc 内容不被误识别成 COPY 指令', () => {
    const result = validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    build: .\n'), generated('Dockerfile', 'FROM busybox\nRUN <<EOF\nCOPY missing.jar /example\nEOF\n')])
    assert.strictEqual(result.ok, true, JSON.stringify(result))
  })
  check('build context 必须是目录，嵌套 Compose 按其位置解释相对路径', () => {
    put(p, 'plain-file', 'x')
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    build: plain-file\n')]), /context 目录不存在/)
    const result = validateDeploymentFiles(p, docker('ops/compose.prod.yaml'), [generated('ops/compose.prod.yaml', 'services:\n  app:\n    build:\n      context: ..\n      dockerfile: deploy/Dockerfile.prod\n'), generated('deploy/Dockerfile.prod', 'FROM node:22\nCOPY server /app/\n')])
    assert.strictEqual(result.ok, true, JSON.stringify(result))
  })
  check('不存在的本地上下文拒绝，远端上下文给出明确限制', () => {
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    build: absent-dir\n')]), /context 目录不存在/)
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    build: ../outside\n')]), /不安全/)
    const result = validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    build: https://example.invalid/project.git\n')])
    assert.strictEqual(result.ok, true)
    assert(result.warnings.some((item) => /远端构建上下文/.test(item)))
  })
  check('必需 env_file 缺失拒绝，可选缺失和动态路径保留', () => {
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    image: busybox\n    env_file: .env.production\n')]), /必需的 env_file/)
    const result = validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    image: busybox\n    env_file:\n      - path: absent.env\n        required: false\n      - ${PLM_VALIDATION_ENV_FILE}\n')])
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert(result.warnings.some((item) => /变量路径/.test(item)))
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    image: busybox\n    env_file: /etc/production.env\n')]), /env_file 必须位于项目内/)
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    image: busybox\n    env_file:\n      - path: server\n        required: false\n')]), /env_file 不是文件/)
  })
  check('缺少外部变量只告知配置，默认值和已配置密钥不误报', () => {
    const secret = 'private-value-do-not-print'
    put(p, '.env', `PLM_VALIDATION_PRESENT_KEY=${secret}\n`)
    const result = validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    image: busybox\n    environment:\n      API_KEY: ${PLM_VALIDATION_PRESENT_KEY}\n      OTHER_KEY: ${PLM_VALIDATION_MISSING_KEY:?请提供}\n      DEFAULT_KEY: ${PLM_VALIDATION_DEFAULT_KEY:-default}\n')])
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert(result.warnings.some((item) => item.includes('PLM_VALIDATION_MISSING_KEY')))
    assert(!result.warnings.some((item) => item.includes('PLM_VALIDATION_PRESENT_KEY') || item.includes('PLM_VALIDATION_DEFAULT_KEY')))
    assert(!JSON.stringify(result).includes(secret))
  })
  check('自动部署内部凭据声明避免误报外部必填配置', () => {
    const content = 'services:\n  app:\n    image: busybox\n    environment:\n      DB_PASSWORD: ${DB_PASSWORD}\n      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}\n      API_KEY: ${PLM_VALIDATION_MISSING_API_KEY}\nx-onedeploy:\n  generatedEnv:\n    - name: DB_PASSWORD\n      kind: hex\n    - name: APP_ENCRYPTION_KEY\n      kind: base64\n  healthPath: /api/health?ready=1\n'
    const result = validateDeploymentFiles(p, { ...docker(), executionMode: 'auto' }, [generated('compose.yaml', content)])
    assert.strictEqual(result.ok, true, JSON.stringify(result))
    assert(!result.warnings.some((item) => /DB_PASSWORD|APP_ENCRYPTION_KEY/.test(item)), JSON.stringify(result))
    assert(result.warnings.some((item) => item.includes('PLM_VALIDATION_MISSING_API_KEY')), JSON.stringify(result))
    const manual = validateDeploymentFiles(p, docker(), [generated('compose.yaml', content)])
    assert(manual.warnings.some((item) => item.includes('DB_PASSWORD')))
  })
  check('内部凭据元数据拒绝无效结构、类型、名字、重复与口令值', () => {
    const prefix = 'services:\n  app:\n    image: busybox\nx-onedeploy:\n'
    const invalid = [
      '  generatedEnv: {}\n',
      '  generatedEnv:\n    - DB_PASSWORD\n',
      '  generatedEnv:\n    - name: OUTSIDE_API_KEY\n      kind: hex\n',
      '  generatedEnv:\n    - name: DB_PASSWORD\n      kind: uuid\n',
      '  generatedEnv:\n    - name: DB_PASSWORD\n      kind: hex\n    - name: DB_PASSWORD\n      kind: base64\n',
      '  generatedEnv:\n    - name: DB_PASSWORD\n      kind: hex\n      value: fixture-private-value\n',
    ]
    for (const metadata of invalid) {
      const result = validateDeploymentFiles(p, { ...docker(), executionMode: 'auto' }, [generated('compose.yaml', prefix + metadata)])
      rejects(result, /generatedEnv|内部凭据声明/)
      assert(!JSON.stringify(result).includes('fixture-private-value'))
    }
    const manual = validateDeploymentFiles(p, docker(), [generated('compose.yaml', prefix + invalid[0])])
    assert.strictEqual(manual.ok, true, '非自动执行器不解释此扩展元数据')
  })
  check('自动部署 healthPath 元数据接受安全路径并拒绝非路径与命令字符', () => {
    const prefix = 'services:\n  app:\n    image: busybox\nx-onedeploy:\n'
    for (const value of ['health', 'https://example.invalid/health', '/health;touch /tmp/file', '/health\\nnext']) {
      rejects(validateDeploymentFiles(p, { ...docker(), executionMode: 'auto' }, [generated('compose.yaml', prefix + `  healthPath: ${JSON.stringify(value)}\n`)]), /healthPath/)
    }
    assert.strictEqual(validateDeploymentFiles(p, { ...docker(), executionMode: 'auto' }, [generated('compose.yaml', prefix + '  healthPath: /\n')]).ok, true)
  })
  check('拒绝生成凭据字面量，允许样例占位、空值及环境变量引用', () => {
    const result = validateDeploymentFiles(p, {}, [generated('compose.yaml', 'services:\n  app:\n    image: busybox\n    environment:\n      API_KEY: actual-private-key\n')])
    rejects(result, /凭据字面量/)
    assert(!JSON.stringify(result).includes('actual-private-key'))
    assert.strictEqual(validateDeploymentFiles(p, {}, [generated('.env.example', 'API_KEY=your-api-key-here\nDB_PASSWORD=changeme\nSESSION_SECRET=\n')]).ok, true)
    assert.strictEqual(validateDeploymentFiles(p, {}, [generated('start.sh', '#!/bin/bash\n: "${API_TOKEN:?请配置}"\n')]).ok, true)
  })
  check('秘密变量的非空默认值被拒绝，空默认值和必填引用允许', () => {
    for (const value of ['${PASSWORD:-private-default-do-not-print}', '${PASSWORD-private-default-do-not-print}', '${API_KEY:+private-default-do-not-print}']) {
      const result = validateDeploymentFiles(p, {}, [generated('compose.yaml', `services:\n  app:\n    image: busybox\n    environment:\n      DB_PASSWORD: ${value}\n`)])
      rejects(result, /凭据字面量/)
      assert(!JSON.stringify(result).includes('private-default-do-not-print'))
    }
    for (const value of ['${PASSWORD}', '$PASSWORD', '${PASSWORD:-}', '${PASSWORD:?请提供}', '${PASSWORD:?Please provide password}']) {
      assert.strictEqual(validateDeploymentFiles(p, {}, [generated('compose.yaml', `services:\n  app:\n    image: busybox\n    environment:\n      DB_PASSWORD: ${value}\n`)]).ok, true)
    }
    rejects(validateDeploymentFiles(p, {}, [generated('start.sh', '#!/bin/bash\n: "${API_TOKEN:-private-default-do-not-print}"\n')]), /凭据字面量/)
    rejects(validateDeploymentFiles(p, {}, [generated('Dockerfile', 'FROM busybox\nENV NODE_ENV=production API_KEY=private-default-do-not-print\n')]), /凭据字面量/)
    rejects(validateDeploymentFiles(p, {}, [generated('start.sh', '#!/bin/bash\ncurl -H "Authorization: Bearer ${AUTH:-private-default-do-not-print}" example.invalid\n')]), /凭据字面量/)
    assert.strictEqual(validateDeploymentFiles(p, {}, [generated('.env.example', 'API_KEY=${API_KEY:-your-api-key-here}\n')]).ok, true)
    assert.strictEqual(validateDeploymentFiles(p, {}, [generated('Dockerfile', 'FROM python:3.13\nRUN pip install tokenizers --no-cache-dir\n')]).ok, true)
  })
  check('加密、签名、服务密钥与凭据字段遵循统一保护边界', () => {
    for (const name of ['APP_ENCRYPTION_KEY', 'SIGNING_KEY', 'SERVICE_KEY', 'PWD', 'AUTH_CREDENTIAL', 'clientEncryptionKey', 'clientServiceKey']) {
      const result = validateDeploymentFiles(p, {}, [generated('Dockerfile', `FROM busybox\nENV ${name}=fixture-private-value\n`)])
      rejects(result, /凭据字面量/)
      assert(!JSON.stringify(result).includes('fixture-private-value'))
      assert.strictEqual(validateDeploymentFiles(p, {}, [generated('Dockerfile', `FROM busybox\nENV ${name}=\${${name}}\n`)]).ok, true)
    }
    for (const name of ['CONNECTION_STRING', 'DSN']) {
      rejects(validateDeploymentFiles(p, {}, [generated('Dockerfile', `FROM busybox\nENV ${name}=postgresql://user:fixture-private-value@db/example\n`)]), /凭据字面量/)
      assert.strictEqual(validateDeploymentFiles(p, {}, [generated('Dockerfile', `FROM busybox\nENV ${name}=sqlite:///data/example.db\n`)]).ok, true)
      assert.strictEqual(validateDeploymentFiles(p, {}, [generated('Dockerfile', `FROM busybox\nENV ${name}=postgresql://user@db/example\n`)]).ok, true)
    }
  })
  check('保留已有 Compose 的宿主能力和外部卷，不改写资源', () => {
    const content = 'services:\n  app:\n    image: busybox\n    privileged: true\n    network_mode: host\n    volumes:\n      - existing:/data\nvolumes:\n  existing:\n    external: true\n'
    const result = validateDeploymentFiles(p, docker(), [generated('compose.yaml', content)])
    assert.strictEqual(result.ok, true, JSON.stringify(result))
  })
  const scripts = project('scripts')
  const scriptFiles = [generated('upgrade.sh', '#!/bin/bash\ntrue\n'), generated('start.sh', '#!/bin/bash\ntrue\n'), generated('package.sh', '#!/bin/bash\ntrue\n'), generated('VERSION', '1.2.3\n')]
  check('脚本契约、虚拟 VERSION 与手动版本可验证', () => {
    assert.strictEqual(validateDeploymentFiles(scripts, script({ version: { strategy: 'auto' } }), scriptFiles).ok, true)
    assert.strictEqual(validateDeploymentFiles(scripts, script({ scriptMode: { packageCommand: 'npm run release' } }), scriptFiles.slice(0, 2)).ok, true)
    assert.strictEqual(validateDeploymentFiles(scripts, script({ version: { strategy: 'auto' }, checks: { detectedVersion: '2.0.1' } }), scriptFiles.slice(0, 3)).ok, true)
  })
  check('缺失脚本入口、构建入口与版本会阻止成组验收', () => {
    rejects(validateDeploymentFiles(scripts, script(), [scriptFiles[0]]), /start.sh/)
    rejects(validateDeploymentFiles(scripts, script(), scriptFiles.slice(0, 2)), /package.sh/)
    rejects(validateDeploymentFiles(scripts, script({ version: { strategy: 'auto' } }), scriptFiles.slice(0, 3)), /尚无可用版本号/)
    rejects(validateDeploymentFiles(scripts, script(), [...scriptFiles.slice(0, 3), generated('VERSION', 'invalid version')]), /版本号格式/)
  })
  check('版本格式兼容现有日期版本、前缀版本与最大长度边界', () => {
    for (const value of ['2026-10-10', 'release_2026.10.10', 'v1.0.0', 'a'.repeat(64)]) assert.strictEqual(validateDeploymentFiles(scripts, {}, [generated('VERSION', value)]).ok, true)
    rejects(validateDeploymentFiles(scripts, {}, [generated('VERSION', 'a'.repeat(65))]), /版本号格式/)
  })
  check('Bash -n 拦截坏语法且从不执行生成命令', () => {
    const sentinel = path.join(scripts.localPath, 'must-not-exist')
    const escaped = sentinel.replace(/\\/g, '/')
    const valid = validateDeploymentFiles(scripts, {}, [generated('start.sh', `#!/bin/bash\ntouch '${escaped}'\n`)])
    assert.strictEqual(valid.ok, true)
    assert.strictEqual(fs.existsSync(sentinel), false)
    const invalid = validateDeploymentFiles(scripts, {}, [generated('start.sh', '#!/bin/bash\nif true; then\n  echo "private-value-do-not-print"\n')])
    rejects(invalid, /Bash 语法/)
    assert(!JSON.stringify(invalid).includes('private-value-do-not-print'))
  })
  check('工具缺失被写实标记为未校验，不能伪称语法检查通过', () => {
    const names = ['PATH', 'Path', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    try {
      for (const name of names) process.env[name] = path.join(fixtureRoot, 'missing-tools')
      const result = validateDeploymentFiles(scripts, {}, [generated('start.sh', '#!/bin/bash\ntrue\n')])
      assert.strictEqual(result.ok, true)
      assert(result.warnings.some((item) => /未找到 Bash.*未完成/.test(item)), JSON.stringify(result))
    } finally {
      for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]
    }
  })
  check('注入路径检查器和白名单检查器仍保持安全边界', () => {
    let resolves = 0
    let writable = 0
    const result = validateDeploymentFiles(p, {}, [generated('Dockerfile.prod', 'FROM busybox\n')], {
      resolveFile: (root, rel) => { resolves++; return path.join(root, rel) },
      assertWritable: (rel) => { writable++; return { ok: rel === 'Dockerfile.prod', rel } },
    })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(resolves, 1)
    assert.strictEqual(writable, 1)
    rejects(validateDeploymentFiles(p, {}, [generated('Dockerfile', 'FROM busybox')], { resolveFile: () => path.join(fixtureRoot, 'outside') }), /不安全/)
  })
  check('链接或 junction 下的部署文件和构建源均被拒绝', () => {
    const outside = path.join(fixtureRoot, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'Dockerfile'), 'FROM busybox\n')
    fs.symlinkSync(outside, path.join(p.localPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    rejects(validateDeploymentFiles(p, {}, [generated('linked/Dockerfile', 'FROM busybox')]), /不安全/)
    rejects(validateDeploymentFiles(p, docker(), [generated('compose.yaml', 'services:\n  app:\n    build: .\n'), generated('Dockerfile', 'FROM busybox\nCOPY linked /app/\n')]), /不安全/)
  })
  process.stdout.write(`部署静态校验回归通过：${count} 项，耗时 ${((Date.now() - started) / 1000).toFixed(2)} 秒\n`)
} finally {
  const tempBase = fs.realpathSync(os.tmpdir())
  const actual = fs.realpathSync(fixtureRoot)
  const relative = path.relative(tempBase, actual)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('临时测试目录越出系统临时目录，拒绝清理')
  fs.rmSync(actual, { recursive: true, force: true })
}
