/** 真实临时项目验证部署证据边界；不需要 AI、SSH 或项目工具链。 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { collectEvidence, readEvidence } = require('../electron/deploy/project-evidence')

const started = Date.now()
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-evidence-'))
let passed = 0
const write = (root, rel, content) => {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const project = (name) => {
  const localPath = path.join(temporaryRoot, name)
  fs.mkdirSync(localPath, { recursive: true })
  return { localPath }
}
const test = (name, run) => { run(); passed++; console.log('  ✓ ' + name) }

try {
  test('深层多模块提供构建清单、启动入口、运行配置与锁文件索引', () => {
    const one = project('multi-module')
    const samples = {
      'README.md': '本项目由前端、服务与后台 Worker 组成。',
      'apps/front/package.json': JSON.stringify({ engines: { node: '>=22' }, scripts: { build: 'vite build', start: 'node custom-entry.cjs' } }),
      'apps/front/package-lock.json': '{}',
      'apps/front/vite.config.ts': 'export default { base: "/" }',
      'apps/front/custom-entry.cjs': 'require("http").createServer(() => {}).listen(8080)',
      'apps/backend/pom.xml': '<project><properties><java.version>21</java.version></properties></project>',
      'apps/backend/src/main/resources/application.yaml': 'server:\n  port: 8090\n',
      'apps/backend/src/main/java/AppApplication.java': 'class AppApplication { public static void main(String[] args) {} }',
      'workers/pipeline/service/pyproject.toml': '[project]\nname="jobs"\nrequires-python=">=3.12"\n',
      'workers/pipeline/service/uv.lock': 'version = 1',
      'workers/pipeline/service/src/jobs/__main__.py': 'from .worker import run\nrun()',
      'services/processor/cmd/worker/main.go': 'package main\nfunc main() {}',
      'services/processor/go.mod': 'module worker\ngo 1.24',
      'services/processor/go.sum': 'module-checksum',
      'services/rust/Cargo.toml': '[package]\nname="collector"\nversion="0.1.0"',
      'services/rust/src/main.rs': 'fn main() {}',
      'services/rust/Cargo.lock': 'version = 4',
      'services/php/composer.json': '{"require":{"php":"^8.3"}}',
      'services/php/public/index.php': '<?php echo "hello";',
      'services/ruby/Gemfile': 'source "https://rubygems.org"\ngem "rack"',
      'services/ruby/config.ru': 'run App',
      'services/dotnet/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>',
      'services/dotnet/Api/Program.cs': 'var app = WebApplication.CreateBuilder(args).Build(); app.Run();',
      'services/dotnet/Api/appsettings.json': '{"Urls":"http://0.0.0.0:8080"}',
      'a/b/c/d/e/f/package.json': '{"name":"depth-six"}',
      'a/b/c/d/e/f/g/package.json': '{"name":"too-deep"}',
      'node_modules/ignored/package.json': '{}',
      '.vscode/settings.json': '{"private":"editor-only"}',
      'services/java/target/classes/application.yml': 'generated: true',
    }
    for (const [rel, content] of Object.entries(samples)) write(one.localPath, rel, content)
    const info = collectEvidence(one)
    const stacks = new Map(info.stack.map((item) => [item.file, item.kind]))
    assert.strictEqual(stacks.get('workers/pipeline/service/pyproject.toml'), 'python')
    assert.strictEqual(stacks.get('a/b/c/d/e/f/package.json'), 'node')
    assert.strictEqual(stacks.get('services/dotnet/Api/Api.csproj'), 'dotnet')
    assert(!stacks.has('a/b/c/d/e/f/g/package.json'))
    assert.deepStrictEqual(new Set(info.stack.map((item) => item.kind)), new Set(['node', 'java', 'python', 'go', 'rust', 'php', 'ruby', 'dotnet']))
    for (const rel of [
      'apps/backend/src/main/resources/application.yaml', 'apps/backend/src/main/java/AppApplication.java',
      'workers/pipeline/service/src/jobs/__main__.py', 'services/processor/cmd/worker/main.go',
      'services/rust/src/main.rs', 'services/php/public/index.php', 'services/ruby/config.ru', 'services/dotnet/Api/Program.cs',
    ]) assert(info.files.some((item) => item.path === rel), `初始证据缺少 ${rel}`)
    assert(info.availableFiles.includes('apps/front/custom-entry.cjs'))
    assert(info.lockFiles.includes('workers/pipeline/service/uv.lock'))
    assert(info.lockFiles.includes('services/processor/go.sum'))
    assert(!info.availableFiles.some((rel) => /node_modules|\.vscode|\/target\//.test(rel)))
    assert.strictEqual(readEvidence(one, ['apps/front/custom-entry.cjs'])[0].content, samples['apps/front/custom-entry.cjs'])
    assert.strictEqual(info.truncated, true, '超出遍历深度应明确标记')
  })

  test('任意名称的 env_file、secret、config 与 included Compose 运行文件不进入 AI', () => {
    const one = project('runtime-config')
    one.composeFile = 'deploy/services.production.yaml'
    const marker = 'RUNTIME_CONTENT_MUST_NEVER_ENTER_AI'
    write(one.localPath, 'README.md', marker)
    write(one.localPath, 'app/main.py', 'print("app")')
    write(one.localPath, 'app/pyproject.toml', '[project]\nname="app"')
    write(one.localPath, 'deploy/services.production.yaml', `services:\n  app:\n    image: python:3.12\n    env_file:\n      - ../README.md\n      - path: ../settings/application.yaml\n        required: false\n      - \${EXTRA_ENV:-../settings/default.txt}\nconfigs:\n  runtime:\n    file: ../app/config.py\n  inline:\n    content: ${marker}\nsecrets:\n  arbitrary:\n    file: ../settings/database.json\ninclude:\n  - other.yaml\n`)
    write(one.localPath, 'deploy/other.yaml', 'services:\n  worker:\n    image: python:3.12\n    env_file: ../settings/worker.properties\n')
    for (const rel of ['settings/application.yaml', 'settings/default.txt', 'app/config.py', 'settings/database.json', 'settings/worker.properties']) write(one.localPath, rel, marker)
    const info = collectEvidence(one)
    assert(!JSON.stringify(info).includes(marker), '已声明运行配置及 inline config 正文不能发给 AI')
    assert(info.files.some((item) => item.path === one.composeFile))
    assert(info.files.some((item) => item.path === 'deploy/other.yaml'))
    for (const rel of ['README.md', 'settings/application.yaml', 'settings/default.txt', 'app/config.py', 'settings/database.json', 'settings/worker.properties']) {
      assert(!info.availableFiles.includes(rel))
      assert(info.runtimeEnvFiles.includes(process.platform === 'win32' ? rel.toLowerCase() : rel))
      assert(readEvidence(one, [rel])[0].error, `不得按需读回运行文件 ${rel}`)
    }
  })

  test('未解析的运行配置变量按安全侧处理，不能通过补读猜测凭据文件', () => {
    const one = project('dynamic-runtime')
    write(one.localPath, 'compose.yaml', 'services:\n  app:\n    image: nginx:alpine\n    env_file: ${APP_RUNTIME_FILE}\n')
    write(one.localPath, 'README.md', 'DYNAMIC_RUNTIME_CONTENT_MUST_NEVER_ENTER_AI')
    write(one.localPath, 'package.json', '{}')
    const info = collectEvidence(one)
    assert(!info.files.some((item) => item.path === 'README.md'))
    assert(info.files.some((item) => item.path === 'compose.yaml'))
    assert(readEvidence(one, ['README.md'])[0].error)
    assert.strictEqual(info.truncated, true)
  })

  test('环境样例与内联应用凭据脱敏，真实凭据文件拒绝读取', () => {
    const one = project('credentials')
    write(one.localPath, '.env.example', 'APP_PORT=8080\nPASSWORD=SECRET_LITERAL_VALUE\nCUSTOM_VALUE=UNKNOWN_LITERAL_VALUE\nAPI_URL=https://user:pass@host/path\nSAFE_REF=${OTHER_ENV}\n')
    write(one.localPath, 'config.py', 'DB_PASSWORD = "SECRET_LITERAL_VALUE"\nENCRYPTION_KEY = "ANOTHER_SECRET_VALUE"\nPORT = 8080')
    for (const rel of ['.env', '.env.production', 'secrets.json', 'deploy/client-secret.json', 'id_rsa', 'certificate.pem', 'package.json.bak-20261010']) write(one.localPath, rel, 'SECRET_LITERAL_VALUE')
    let injectedCalls = 0
    const redact = (text) => { injectedCalls++; return text.replace('8080', '8081') }
    const info = collectEvidence(one, { redact })
    const content = JSON.stringify(info.files)
    assert(!content.includes('SECRET_LITERAL_VALUE'))
    assert(!content.includes('UNKNOWN_LITERAL_VALUE'))
    assert(!content.includes('ANOTHER_SECRET_VALUE'))
    assert(!content.includes('user:pass'))
    assert(content.includes('8081'))
    assert(content.includes('${OTHER_ENV}'))
    assert(injectedCalls >= 2)
    for (const rel of ['.env', '.env.production', 'secrets.json', 'deploy/client-secret.json', 'id_rsa', 'certificate.pem', 'package.json.bak-20261010']) {
      assert(!info.availableFiles.includes(rel))
      assert(readEvidence(one, [rel])[0].error)
    }
  })

  test('拒绝绝对路径、目录越界、二进制、链接和 junction，包含补读阶段', () => {
    const one = project('boundaries')
    const outside = path.join(temporaryRoot, 'outside')
    fs.mkdirSync(outside)
    write(outside, 'private.py', 'OUTSIDE_CONTENT_MUST_NEVER_ENTER_AI')
    write(one.localPath, 'package.json', '{}')
    write(one.localPath, 'binary.txt', Buffer.from([0, 1, 2, 3, 4]))
    write(one.localPath, 'invalid-utf8.js', Buffer.from([0xff, 0xfe, 0xa4]))
    fs.symlinkSync(outside, path.join(one.localPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    fs.symlinkSync(path.join(outside, 'private.py'), path.join(one.localPath, 'main.py'), 'file')
    const info = collectEvidence(one, { local: { stack: [{ file: 'linked/private.py', kind: 'python', label: 'Injected' }] } })
    assert(!JSON.stringify(info).includes('OUTSIDE_CONTENT'))
    assert(!info.stack.some((item) => item.label === 'Injected'))
    assert(!info.availableFiles.some((rel) => rel.startsWith('linked/')))
    for (const rel of ['../outside/private.py', path.join(outside, 'private.py'), '/tmp/private.py', 'C:/private.py', 'C:private.py', 'linked/private.py', 'main.py', 'binary.txt', 'invalid-utf8.js', 'package.json:stream', 'a\\private.py']) assert(readEvidence(one, [rel])[0].error, `不得读取 ${rel}`)
  })

  test('同步目录从扫描、旧体检、索引和补读同时排除，内容不会被读取', () => {
    const one = project('excluded-data')
    const marker = 'BUSINESS_DATA_MUST_NEVER_BE_READ'
    write(one.localPath, 'data/catalog/README.md', marker)
    write(one.localPath, 'data/catalog/package.json', marker)
    write(one.localPath, 'data/catalog/compose.yaml', 'unparseable: [')
    write(one.localPath, 'app/main.py', 'print("code")')
    write(one.localPath, 'app/pyproject.toml', '[project]\nname="code"')
    const exclude = (rel) => rel === 'data/catalog' || rel.startsWith('data/catalog/')
    const local = { stack: [{ file: 'data/catalog/package.json', kind: 'node', label: 'Injected' }], compose: { files: [{ path: 'data/catalog/compose.yaml' }] }, fileContents: [{ path: 'README.md', content: marker }] }
    const nativeOpen = fs.openSync
    const nativeOpendir = fs.opendirSync
    fs.openSync = (file, ...args) => {
      assert(!String(file).replace(/\\/g, '/').includes('/data/catalog/'), '不得读取同步目录内容')
      return nativeOpen(file, ...args)
    }
    fs.opendirSync = (file, ...args) => {
      assert(!String(file).replace(/\\/g, '/').endsWith('/data/catalog'), '不得遍历同步目录')
      return nativeOpendir(file, ...args)
    }
    try {
      const info = collectEvidence(one, { local, exclude })
      assert(!JSON.stringify(info).includes(marker))
      assert(!info.availableFiles.some((rel) => rel.startsWith('data/catalog/')))
      assert(!info.stack.some((item) => item.kind === 'node'))
      assert(info.files.some((item) => item.path === 'app/main.py'))
      const extra = readEvidence(one, ['data/catalog/README.md', 'data/catalog/package.json', 'app/main.py'], { local, exclude })
      assert(extra[0].error && extra[1].error)
      assert.strictEqual(extra[2].content, 'print("code")')
    } finally { fs.openSync = nativeOpen; fs.opendirSync = nativeOpendir }
  })

  test('单文件、总内容与补读自定义预算严格按 UTF-8 字节限制', () => {
    const one = project('limits')
    for (let i = 0; i < 8; i++) write(one.localPath, `modules/mod${i}/package.json`, JSON.stringify({ description: '中文描述'.repeat(5000), name: `mod${i}` }))
    const info = collectEvidence(one)
    assert(info.truncated)
    assert(info.files.every((file) => Buffer.byteLength(file.content) <= 12000))
    assert(info.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= 60000)
    assert(info.files.every((file) => !file.content.includes('\ufffd')), '截断不能产生损坏的多字节字符')
    const extra = readEvidence(one, ['modules/mod0/package.json', 'modules/mod1/package.json'], { maxTotal: 1001 })
    assert(extra.reduce((sum, file) => sum + Buffer.byteLength(file.content || ''), 0) <= 1001)
    assert(extra[1].error)
  })

  test('大目录的文件索引有独立总量上限，截断后仍允许安全的精确补读', () => {
    const one = project('large-index')
    for (let i = 0; i < 700; i++) write(one.localPath, `sources/application-handler-${String(i).padStart(4, '0')}-long-name.js`, 'module.exports = {}')
    const info = collectEvidence(one)
    assert(info.truncated)
    assert(info.availableFiles.length < 700)
    assert(info.availableFiles.reduce((sum, rel) => sum + Buffer.byteLength(rel) + 4, 0) <= 24000)
    const requested = 'sources/application-handler-0699-long-name.js'
    assert(!info.availableFiles.includes(requested))
    assert.strictEqual(readEvidence(one, [requested])[0].content, 'module.exports = {}')
  })

  console.log(`全部通过：部署项目证据 ${passed} 项，耗时 ${((Date.now() - started) / 1000).toFixed(2)} 秒`)
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot)
  assert(resolvedTemporaryRoot.startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true })
}
