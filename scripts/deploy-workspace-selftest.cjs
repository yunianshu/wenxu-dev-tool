/**
 * 打包工作区自测（脚本部署形态）
 *
 * 覆盖的真实故障：WSL 里 `ln -s` 建的链接在 DrvFs 上是 LX_SYMLINK 重解析点，
 * Windows 的 lstat 对它返回 EACCES；打包前复制项目时撞上就会中断整次发布。
 *   - 这类条目必须跳过而不是让复制失败（含子目录里的单个链接）
 *   - Linux 布局的虚拟环境（pyvenv.cfg + bin/，无 Scripts/）整体不复制，Windows 布局保留
 *   - 版本库/本地私有目录/旧产物包不进工作区；产物目录按配置生效
 *   - ZIP 打包的越界检查同样不能被这类链接打断，而指向项目外的链接必须继续拦下
 *
 * 本机没有 WSL 时跳过故障形态相关断言并明确标注，其余断言照常执行。
 * 用法：node scripts/deploy-workspace-selftest.cjs
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { copyProject, shouldSkipDir, isLinuxVenv } = require('../electron/deploy/build-workspace')
const { buildPackage } = require('../electron/deploy/packager')

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-test-')))
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const wslPath = (p) => '/mnt/' + path.resolve(p).replace(/^([A-Za-z]):\\/, (m, d) => d.toLowerCase() + '/').replace(/\\/g, '/')

/** 用 WSL 建一个 Linux 符号链接；返回 true 表示确实造出了 Windows 侧读不了的形态 */
function makeUnreadableLink(linkPath, target = 'python3') {
  try {
    execFileSync('wsl.exe', ['-e', 'bash', '-c', `ln -sfn ${shq(target)} ${shq(wslPath(linkPath))}`], { stdio: 'pipe' })
  } catch {
    return false
  }
  try {
    fs.lstatSync(linkPath)
    return false // 本机 DrvFs 把链接存成了 Windows 原生形态，不是故障形态
  } catch (e) {
    return e.code === 'EACCES'
  }
}

/** 写文件并补齐父目录 */
function put(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

const exists = (p) => fs.existsSync(p)
const dirHas = (dir, name) => exists(path.join(dir, name))

// ── 项目 A：WSL 形态（venv 是 Linux 布局，子目录里还有读不了的链接） ──
const projA = path.join(tmpRoot, 'proj-a')
put(path.join(projA, 'src', 'app.py'), 'print(1)')
put(path.join(projA, 'src', 'keep.txt'), 'keep')
put(path.join(projA, '.venv', 'pyvenv.cfg'), 'home = /usr/bin')
put(path.join(projA, '.venv', 'lib', 'site.py'), 'site')
put(path.join(projA, '.git', 'config'), 'gitconfig')
put(path.join(projA, '.local', 'secret.txt'), 'secret')
put(path.join(projA, 'release', 'app-0.9.0.zip'), 'old')
const linkInSrc = path.join(projA, 'src', 'wsl-link')
const linkInVenv = path.join(projA, '.venv', 'bin', 'python')
fs.mkdirSync(path.dirname(linkInVenv), { recursive: true })
const hasWslLink = makeUnreadableLink(linkInSrc) & makeUnreadableLink(linkInVenv)

// ── 项目 B：Windows 布局 venv + 自定义产物目录 ──
const projB = path.join(tmpRoot, 'proj-b')
put(path.join(projB, 'app', 'main.py'), 'main')
put(path.join(projB, '.venv', 'pyvenv.cfg'), 'home = C:/Python312')
put(path.join(projB, '.venv', 'Scripts', 'python.exe'), 'exe')
put(path.join(projB, 'artifacts', 'app-1.0.0.tar.gz'), 'tar')
put(path.join(projB, 'artifacts', 'notes.txt'), 'notes')

;(async () => {
  console.log(hasWslLink ? '故障形态：已用 WSL 造出 Windows 读不了的链接' : '故障形态：本机无 WSL，跳过真实链接断言')

  // ── 1. 回归对照：原有的复制方式遇到这类链接会直接中断 ──
  if (hasWslLink) {
    const dest = path.join(tmpRoot, 'raw-copy')
    fs.mkdirSync(dest)
    let code = null
    try {
      await fs.promises.cp(projA, dest, {
        recursive: true,
        dereference: false,
        filter: (source) => {
          const rel = path.relative(projA, source)
          return !rel || !/^(?:\.git|\.local|release|releases)$/.test(rel.split(path.sep)[0])
        },
      })
    } catch (e) {
      code = e.code
    }
    assert.strictEqual(code, 'EACCES', '原有复制方式应当因 WSL 链接报 EACCES（证明测试确实命中故障形态）')
    fs.rmSync(dest, { recursive: true, force: true })
    console.log('  ✓ 回归对照：旧复制方式确实抛 EACCES')
  }

  // ── 2. copyProject 跳过读不了的条目，其余内容照常复制 ──
  const wsA = path.join(tmpRoot, 'ws-a')
  const copied = await copyProject(projA, wsA)
  assert.ok(exists(path.join(wsA, 'src', 'app.py')), '普通源码文件应当复制')
  assert.ok(exists(path.join(wsA, 'src', 'keep.txt')), '同目录其它文件不受链接影响')
  assert.ok(!exists(linkInSrc.replace(projA, wsA)), '子目录里读不了的链接必须跳过')
  assert.ok(!dirHas(wsA, '.venv'), 'Linux 布局的虚拟环境不应复制')
  assert.ok(!dirHas(wsA, '.git'), '.git 不应复制')
  assert.ok(!dirHas(wsA, '.local'), '.local 不应复制')
  assert.ok(!dirHas(wsA, 'release'), '旧产物目录不应复制')
  if (hasWslLink) {
    assert.deepStrictEqual(copied.skipped, [path.join('src', 'wsl-link')], '被跳过的条目应当如实报告')
  }
  console.log('  ✓ copyProject：跳过读不了的条目与 Linux venv，保留源码')

  // ── 3. Windows 布局 venv 保留；产物目录按配置排除 ──
  const wsB = path.join(tmpRoot, 'ws-b')
  await copyProject(projB, wsB, { artifactDir: 'artifacts' })
  assert.ok(exists(path.join(wsB, '.venv', 'Scripts', 'python.exe')), 'Windows 布局的 venv 应当保留')
  assert.ok(exists(path.join(wsB, 'app', 'main.py')), '源码应当复制')
  assert.ok(!exists(path.join(wsB, 'artifacts', 'app-1.0.0.tar.gz')), '旧发布包不应复制')
  assert.ok(exists(path.join(wsB, 'artifacts', 'notes.txt')), '产物目录里的非产物文件应当保留')
  console.log('  ✓ Windows 布局 venv 保留，产物包按配置排除')

  // ── 4. 判定函数本身 ──
  assert.strictEqual(isLinuxVenv(path.join(projA, '.venv')), true, 'bin/ 布局应判定为 Linux venv')
  assert.strictEqual(isLinuxVenv(path.join(projB, '.venv')), false, 'Scripts/ 布局不应判定为 Linux venv')
  assert.strictEqual(shouldSkipDir(path.join('deep', 'release'), path.join(projA, 'deep', 'release')), false, '顶层规则不应误伤深层同名目录')
  assert.strictEqual(shouldSkipDir('release', path.join(projA, 'release')), true, '顶层 release 应跳过')
  console.log('  ✓ 目录判定：顶层规则不误伤深层同名目录')

  // ── 5. ZIP 打包：越界检查不被读不了的链接打断，但越界链接仍要拦下 ──
  if (hasWslLink) {
    const pack = await buildPackage({ projectDir: projA, appName: 'wstest', version: '1.0.0', safeRoot: true })
    const out = path.join(tmpRoot, 'unzipped')
    fs.mkdirSync(out, { recursive: true })
    execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe'), ['-xf', pack.zipPath, '-C', out])
    const names = []
    const walk = (d, p) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rp = p ? `${p}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(d, e.name), rp)
        else names.push(rp)
      }
    }
    walk(out, '')
    assert.ok(names.includes('src/app.py'), 'ZIP 应包含源码')
    assert.ok(!names.some((n) => n.includes('wsl-link')), '读不了的链接不应进包')
    assert.ok(!names.some((n) => n.startsWith('.venv/')), '虚拟环境不应进包')
    fs.rmSync(out, { recursive: true, force: true })
    fs.rmSync(path.dirname(pack.zipPath), { recursive: true, force: true })
    console.log('  ✓ ZIP 打包：safeRoot 检查跳过读不了的链接而非中断')

    const projC = path.join(tmpRoot, 'proj-c')
    put(path.join(projC, 'src', 'app.py'), 'x')
    fs.symlinkSync(tmpRoot, path.join(projC, 'src', 'outside'), 'junction')
    let message = null
    try {
      await buildPackage({ projectDir: projC, appName: 'wstest', version: '1.0.0', safeRoot: true })
    } catch (e) {
      message = e.message
    }
    assert.ok(message && message.includes('越出项目目录'), `指向项目外的链接必须拦下，实际: ${message}`)
    console.log('  ✓ ZIP 打包：指向项目外的链接仍被拦截')
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log('打包工作区验证：全部通过')
})().catch((e) => {
  console.error(e.message)
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
  process.exit(1)
})
