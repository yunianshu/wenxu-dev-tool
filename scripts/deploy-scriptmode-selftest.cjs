/**
 * 脚本部署形态编排全链路自测（无框架，node scripts/deploy-scriptmode-selftest.cjs 直接运行）
 *
 * 验证策略（同 deploy-datasync-selftest.cjs 的边界划分）：
 *   - deploy-service.run()/rollback()/listReleases() 走真实业务编排（产物解析/SHA256/上传/阶段跟踪/历史落盘）
 *   - deploy.sh 不打桩：exec 桩收到 `bash .../deploy.sh ...` 时，把远端路径改写到本地「服务器根」后
 *     经 child_process 真实执行，输出流式回放给 onLine（阶段标记解析不失真）
 *   - 仅模拟无法在本机接入的外部系统：SSH/SFTP 传输（upload 落盘到「服务器目录」）
 *   - fake 项目发布包（tar.gz + upgrade.sh/start.sh/stop.sh）模拟 Vantage 形态契约
 * 覆盖：首次发布成功 / 升级停旧切指针 / 同版本重复发布快速失败（客户端+deploy.sh 双层守卫）/
 *   升级脚本失败尽力恢复 / 手动回滚 / 版本列表 / 本地产物保留
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptmode-test-'))

// ── electron 打桩 ──
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => path.join(tmpRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } },
}

// ── 「服务器」：本地目录模拟远端安装根；REMOTE_HOME 是 deploy.sh 收到的逻辑路径 ──
const SERVER_ROOT = path.join(tmpRoot, 'server-home')
const REMOTE_HOME = '/srv/vantage'
const serverState = { uploads: path.join(SERVER_ROOT, 'uploads'), execLog: [] }
fs.mkdirSync(serverState.uploads, { recursive: true })

/** Windows 路径 → Git Bash 可用路径（D:\x → /d/x） */
function msysPath(p) {
  const w = path.resolve(p).replace(/\\/g, '/')
  return w.replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
}

/** 远端命令改写为对本地「服务器根」可执行的命令 */
function localizeCmd(command) {
  const root = msysPath(SERVER_ROOT)
  return command.split(REMOTE_HOME).join(root)
}

// ── ssh-service 打桩 ──
const realSsh = require('../electron/deploy/ssh-service')
require.cache[require.resolve('../electron/deploy/ssh-service')] = {
  id: require.resolve('../electron/deploy/ssh-service'),
  filename: require.resolve('../electron/deploy/ssh-service'),
  loaded: true,
  exports: {
    remoteJoin: realSsh.remoteJoin,
    connect: async () => ({
      stub: true,
      sftp: (cb) => cb(null, {
        // uploadTextFile 直写 deploy.sh：落到「服务器」deployer/（exec 时真实执行的就是它）
        createWriteStream: (remotePath) => {
          const rel = path.relative(REMOTE_HOME, remotePath).replaceAll('\\', '/')
          const dest = path.join(SERVER_ROOT, rel)
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          const s = fs.createWriteStream(dest)
          const origEnd = s.end.bind(s)
          s.end = (...a) => { setTimeout(() => s.emit('close'), 30); return origEnd(...a) }
          return s
        },
        end: () => {},
      }),
    }),
    close: () => {},
    mkdirp: async (_c, dir) => {
      const rel = path.relative(REMOTE_HOME, dir)
      if (rel && !rel.startsWith('..')) fs.mkdirSync(path.join(SERVER_ROOT, rel), { recursive: true })
    },
    upload: async (_conn, localPath, remotePath, onProgress) => {
      const rel = path.relative(REMOTE_HOME, remotePath).replaceAll('\\', '/')
      const dest = path.join(SERVER_ROOT, rel)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(localPath, dest)
      const size = fs.statSync(dest).size
      if (onProgress) onProgress(size, size)
      return { remotePath }
    },
    exec: async (_conn, command, onLine) => {
      serverState.execLog.push(command)
      const shaM = command.match(/sha256sum '([^']+)'/)
      if (shaM) {
        const rel = path.relative(REMOTE_HOME, shaM[1]).replaceAll('\\', '/')
        const local = path.join(SERVER_ROOT, rel)
        assert.ok(fs.existsSync(local), `上传的包应真实存在于服务器目录: ${shaM[1]}`)
        const hash = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex')
        return { code: 0, stdout: `${hash}\n`, stderr: '' }
      }
      // cat <home>/CURRENT（run 的旧版本查询）：真实读「服务器」指针文件
      const catM = command.match(/^cat '([^']*CURRENT)' /)
      if (catM) {
        const local = path.join(SERVER_ROOT, 'CURRENT')
        return { code: 0, stdout: fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : '', stderr: '' }
      }
      // deploy.sh / releases 列表 / CURRENT 指针读取 → 对本地服务器根真实执行
      const m = command.match(/bash '([^']*deploy\.sh)'/)
      if (m || /ls -1 .*releases/.test(command)) {
        const local = localizeCmd(command)
        const bashExe = process.env.SHELL ? undefined : 'bash'
        const r = spawnSync(bashExe || 'bash', ['-c', local], { encoding: 'utf8' })
        const out = `${r.stdout || ''}${r.stderr || ''}`
        // 流式回放：deploy-service 的阶段标记解析依赖 onLine 回调
        if (onLine) for (const line of out.split(/\r?\n/)) if (line) onLine(line + '\n', 'stdout')
        return { code: r.status ?? 1, stdout: out, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  },
}

const deployProjects = require('../electron/deploy/deploy-projects')
const deployService = require('../electron/deploy/deploy-service')

// ── fake 项目（Vantage 形态）：VERSION + release/ 产物目录 ──
function makeFakeArtifact(projectDir, name, behaviour) {
  const stage = path.join(projectDir, '.staging', name)
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, 'VERSION'), `${name.split('-v')[1].split('-')[0]}\n`)
  fs.writeFileSync(path.join(stage, 'upgrade.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="$INSTALL_ROOT"',
    'echo "[fake-upgrade] $(cat "$IR/CURRENT" 2>/dev/null || echo none) -> $(basename -- "$SD")"',
    'echo "[env] java=$(command -v java 2>/dev/null || echo none) pgdump=${PG_DUMP:-none}"',
    `if [ "${behaviour}" = "fail" ]; then echo "[fake-upgrade] 模拟升级失败"; exit 7; fi`,
    'mkdir -p "$IR/backups"; touch "$IR/backups/backup-$(date +%s%N).tar.gz"',
    'if [ -f "$IR/CURRENT" ]; then old="$(cat "$IR/CURRENT")"; [ -f "$IR/releases/$old/stop.sh" ] && INSTALL_ROOT="$IR" bash "$IR/releases/$old/stop.sh" || true; fi',
    'printf \'%s\\n\' "$(basename -- "$SD")" > "$IR/CURRENT"',
    'INSTALL_ROOT="$IR" bash "$SD/start.sh"',
  ].join('\n'))
  fs.writeFileSync(path.join(stage, 'start.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="${INSTALL_ROOT:-$(dirname -- "$SD")}"',
    'echo $$ > "$SD/app.pid"; touch "$SD/.started"',
  ].join('\n'))
  fs.writeFileSync(path.join(stage, 'stop.sh'), [
    '#!/usr/bin/env bash',
    'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"',
    'rm -f "$SD/.started"',
  ].join('\n'))
  const rel = path.join(projectDir, 'release')
  fs.mkdirSync(rel, { recursive: true })
  const out = path.join(rel, `${name}.tar.gz`)
  const r = spawnSync('bash', ['-c', `cd "$(dirname '${msysPath(stage)}')" && tar -czf '${msysPath(out)}' '${name}' && rm -rf '${msysPath(stage)}'`], { encoding: 'utf8' })
  assert.strictEqual(r.status, 0, `打 fake 包失败: ${r.stderr}`)
  return out
}

function seedScriptProject(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0\n')
  const saved = deployProjects.save(deployProjects.normalizeProject({
    name: '脚本部署项目', localPath: dir, deployMode: 'script',
    scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' },
    version: { strategy: 'auto', manual: '' },
    targets: [{
      id: 't1', name: '生产', remotePath: REMOTE_HOME,
      server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
      health: { enabled: false, url: '', timeout: 90, interval: 3 },
    }],
  }))
  return saved.id
}

function runDeploy(projectId) {
  // 各场景顺序复用一个模拟服务器；结束前一配置的归属，避免构造跨项目目录冲突。
  for (const p of deployProjects.list()) if (p.id !== projectId) deployProjects.remove(p.id)
  const events = { stages: [], logs: [], done: null }
  deployService.setEmitter((ch, payload) => {
    if (ch === 'deploy:stage') events.stages.push(payload)
    if (ch === 'deploy:log') events.logs.push(payload)
    if (ch === 'deploy:done') events.done = payload.record
  })
  return deployService.run(projectId, 't1').then((record) => ({ record, events }))
}

async function main() {
  let passed = 0
  try {
    const projDir = path.join(tmpRoot, 'proj')
    const projectId = seedScriptProject(projDir)

    // ── 1. 产物缺失：检查阶段失败，不产生任何服务器操作 ──
    serverState.execLog.length = 0
    const { record: recNoPkg } = await runDeploy(projectId)
    assert.strictEqual(recNoPkg.status, 'failed')
    assert.ok(/产物目录/.test(recNoPkg.message), `消息应提示产物缺失: ${recNoPkg.message}`)
    assert.strictEqual(recNoPkg.stages.check.status, 'failed')
    assert.strictEqual(serverState.execLog.length, 0, '产物缺失不得连接服务器')
    passed += 1
    console.log('  ✓ 产物目录为空 → 检查阶段失败且零服务器操作')

    // ── 2. 版本不匹配：拒绝发布过期产物 ──
    makeFakeArtifact(projDir, 'app-v0.9.0-001', 'success')
    const { record: recStale } = await runDeploy(projectId)
    assert.strictEqual(recStale.status, 'failed')
    assert.ok(recStale.message.includes('1.0.0'), `消息应含期望版本: ${recStale.message}`)
    assert.ok(recStale.message.includes('app-v0.9.0-001.tar.gz'), '消息应提示最新产物名')
    passed += 1
    console.log('  ✓ 产物版本不匹配 → 拒发并提示最新产物')

    // ── 3. 首次发布成功：CURRENT 切新、服务器终态与历史正确 ──
    const pkg1 = makeFakeArtifact(projDir, 'app-v1.0.0-001', 'success')
    const { record: rec1, events: ev1 } = await runDeploy(projectId)
    assert.strictEqual(rec1.status, 'success', `首次发布应成功: ${rec1.message}\n${ev1.logs.map((l) => l.text).join('\n')}`)
    assert.strictEqual(rec1.version, '1.0.0', '版本应来自 VERSION 文件')
    assert.strictEqual(rec1.oldVersion, '', '首次发布无旧版本')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-001')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-001', '.started')), '新版本 start.sh 应已执行')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'uploads', 'app-v1.0.0-001.tar.gz')), '成功后上传包应清理')
    const hist = fs.readFileSync(path.join(SERVER_ROOT, 'deploy-history.jsonl'), 'utf8')
    assert.ok(hist.includes('"status":"success"'), '服务器端历史应记录 success')
    assert.strictEqual(rec1.stages.build.status, 'skipped', '脚本模式 build 应为 skipped')
    assert.strictEqual(rec1.stages.backup.status, 'skipped', '脚本模式 backup 由项目脚本负责，应 skipped')
    assert.strictEqual(rec1.stages.start.status, 'success')
    assert.ok(fs.existsSync(pkg1), '本地产物包必须保留（keepLocal）')
    passed += 1
    console.log('  ✓ 首次发布成功：真实 deploy.sh 执行、CURRENT/start/清理/历史终态正确')

    // ── 4. 升级发布：oldVersion 正确、停旧切新 ──
    makeFakeArtifact(projDir, 'app-v1.0.0-002', 'success')
    const { record: rec2 } = await runDeploy(projectId)
    assert.strictEqual(rec2.status, 'success', `升级发布应成功: ${rec2.message}`)
    assert.strictEqual(rec2.oldVersion, 'app-v1.0.0-001', 'oldVersion 应取自 CURRENT 指针')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-001', '.started')), '旧版本应被 stop')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.started')))
    passed += 1
    console.log('  ✓ 升级发布：CURRENT 指针切换、旧版本停止、oldVersion 识别正确')

    // ── 5. 同版本重复发布：上传前快速失败，运行中的 release 目录零改动 ──
    fs.writeFileSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.sentinel'), 'keep')
    serverState.execLog.length = 0
    const { record: recDup, events: evDup } = await runDeploy(projectId)
    assert.strictEqual(recDup.status, 'failed')
    assert.ok(/线上已运行同一版本/.test(recDup.message), `消息应说明同版本拒绝: ${recDup.message}`)
    assert.strictEqual(recDup.stages.check.status, 'success')
    assert.strictEqual(recDup.stages.upload.status, 'failed', '应在上传阶段前拦截')
    assert.ok(!serverState.execLog.some((c) => /deploy\.sh.*deploy/.test(c)), '不得执行服务器部署脚本')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'uploads', 'app-v1.0.0-002.tar.gz')), '发布包不得上传')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.sentinel')), '运行中版本目录必须原样保留')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002')
    passed += 1
    console.log(`  ✓ 同版本重复发布：上传前快速失败（日志 ${evDup.logs.length} 行）、运行中 release 目录零改动`)

    // ── 6. 升级脚本失败：整单 failed、尽力恢复当前版本 ──
    makeFakeArtifact(projDir, 'app-v1.0.0-003', 'fail')
    const { record: rec3, events: ev3 } = await runDeploy(projectId)
    assert.strictEqual(rec3.status, 'failed')
    assert.ok(rec3.message.includes('升级脚本执行失败'), `消息应含升级脚本失败: ${rec3.message}`)
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002', 'CURRENT 不得切换到失败版本')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.started')), '当前版本应被幂等拉起')
    assert.ok(ev3.logs.some((l) => l.text.includes('尽力恢复')), '日志应体现尽力恢复路径')
    passed += 1
    console.log('  ✓ 升级脚本失败 → 整单 failed、尽力恢复当前版本、CURRENT 不变')

    // ── 7. listReleases（script 形态：CURRENT 指针解析） ──
    const lr = await deployService.listReleases(projectId, 't1')
    assert.ok(lr.releases.includes('app-v1.0.0-001') && lr.releases.includes('app-v1.0.0-002'))
    assert.strictEqual(lr.current, 'app-v1.0.0-002')
    passed += 1
    console.log('  ✓ listReleases：releases 列表与 CURRENT 指向解析正确')

    // ── 8. 手动回滚：CURRENT 切目标并启动，stop 当前 ──
    const rb = await deployService.rollback(projectId, 'app-v1.0.0-001', 't1')
    assert.strictEqual(rb.status, 'success', `回滚应成功: ${rb.message}`)
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-001')
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-001', '.started')), '目标版本应启动')
    assert.ok(!fs.existsSync(path.join(SERVER_ROOT, 'releases', 'app-v1.0.0-002', '.started')), '原版本应停止')
    passed += 1
    console.log('  ✓ 手动回滚：真实 rollback 子命令执行、启停与指针终态正确')

    // ── 9. 环境引导：toolbox 的 JDK/pg_dump 优先并导出给项目升级脚本 ──
    const tbJdk = path.join(SERVER_ROOT, 'shared', 'toolbox', 'jdk', 'bin')
    const tbBin = path.join(SERVER_ROOT, 'shared', 'toolbox', 'bin')
    fs.mkdirSync(tbJdk, { recursive: true })
    fs.mkdirSync(tbBin, { recursive: true })
    fs.writeFileSync(path.join(tbJdk, 'java'), '#!/usr/bin/env bash\necho "openjdk version \\"17.9.9\\" 2026-01-01" >&2\n')
    fs.writeFileSync(path.join(tbBin, 'pg_dump'), '#!/usr/bin/env bash\necho toolbox-pgdump-wrapper\n')
    fs.chmodSync(path.join(tbJdk, 'java'), 0o755)
    fs.chmodSync(path.join(tbBin, 'pg_dump'), 0o755)
    makeFakeArtifact(projDir, 'app-v1.0.0-010', 'success')
    const { record: recBoot, events: evBoot } = await runDeploy(projectId)
    assert.strictEqual(recBoot.status, 'success', `引导场景发布应成功: ${recBoot.message}\n${evBoot.logs.map((l) => l.text).join('\n')}`)
    assert.ok(evBoot.logs.some((l) => l.text.includes('使用工具箱 JDK')), '日志应提示使用工具箱 JDK')
    const envLine = evBoot.logs.find((l) => l.text.includes('[env] java='))
    assert.ok(envLine, '项目升级脚本应输出环境信息')
    assert.ok(envLine.text.includes('shared/toolbox/jdk/bin/java'), 'PATH 应导出 toolbox JDK')
    assert.ok(envLine.text.includes('shared/toolbox/bin/pg_dump'), 'PG_DUMP 应导出 toolbox 包装')
    passed += 1
    console.log('  ✓ 环境引导：toolbox JDK/pg_dump 优先并正确导出给项目脚本')

    // ── 9. 产物缺失自动打包：版本不匹配 + packageCommand → 子进程构建 → 发布成功 ──
    const proj2Dir = path.join(tmpRoot, 'proj-autopkg')
    fs.mkdirSync(path.join(proj2Dir, 'release'), { recursive: true })
    fs.writeFileSync(path.join(proj2Dir, 'VERSION'), '2.0.0\n')
    makeFakeArtifact(proj2Dir, 'app-v1.9.0-001', 'success') // 旧版本包（版本不匹配）
    // fake 打包脚本：真实 tar 出 v2.0.0 发布包（与 makeFakeArtifact 同契约），并留执行标记
    fs.writeFileSync(path.join(proj2Dir, 'mkpkg.sh'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cd -- "$(dirname -- "${BASH_SOURCE[0]}")"',
      'echo "[mkpkg] building v2.0.0 ..."',
      'touch .pkg-ran',
      'name=app-v2.0.0-011',
      'd=".staging/$name"; rm -rf -- "$d"; mkdir -p -- "$d"',
      'cat > "$d/upgrade.sh" <<\'EOS\'',
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="$INSTALL_ROOT"',
      'echo "[fake-upgrade] $(cat "$IR/CURRENT" 2>/dev/null || echo none) -> $(basename -- "$SD")"',
      'echo "[env] java=$(command -v java 2>/dev/null || echo none) pgdump=${PG_DUMP:-none}"',
      'if [ -f "$IR/CURRENT" ]; then old="$(cat "$IR/CURRENT")"; [ -f "$IR/releases/$old/stop.sh" ] && INSTALL_ROOT="$IR" bash "$IR/releases/$old/stop.sh" || true; fi',
      'printf \'%s\\n\' "$(basename -- "$SD")" > "$IR/CURRENT"',
      'INSTALL_ROOT="$IR" bash "$SD/start.sh"',
      'EOS',
      'printf "%s\\n" \'#!/usr/bin/env bash\' \'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\' \'echo $$ > "$SD/app.pid"; touch "$SD/.started"\' > "$d/start.sh"',
      'printf "%s\\n" \'#!/usr/bin/env bash\' \'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\' \'rm -f "$SD/.started"\' > "$d/stop.sh"',
      'mkdir -p release',
      '( cd -- .staging && tar -czf "../release/$name.tar.gz" "$name" )',
      'echo "[mkpkg] done"',
    ].join('\n'))
    const proj2 = deployProjects.save(deployProjects.normalizeProject({
      name: '自动打包项目', localPath: proj2Dir, deployMode: 'script',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', packageCommand: 'bash mkpkg.sh', packageTimeoutSec: 60 },
      version: { strategy: 'auto', manual: '' },
      targets: [{
        id: 't1', name: '生产', remotePath: REMOTE_HOME,
        server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
        health: { enabled: false, url: '', timeout: 90, interval: 3 },
      }],
    }))
    const { record: recAuto, events: evAuto } = await runDeploy(proj2.id)
    assert.strictEqual(recAuto.status, 'success', `自动打包发布应成功: ${recAuto.message}\n${evAuto.logs.map((l) => l.text).join('\n')}`)
    assert.strictEqual(recAuto.version, '2.0.0')
    assert.ok(!fs.existsSync(path.join(proj2Dir, '.pkg-ran')), '打包只能在隔离副本执行，不能污染源项目')
    assert.ok(evAuto.logs.some((l) => l.text.includes('[打包] [mkpkg] building')), '打包输出应流入发布日志')
    assert.ok(evAuto.logs.some((l) => l.text.includes('产物未就绪')), '检查阶段应提示产物未就绪并推迟')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v2.0.0-011', '服务器应运行自动打出的新版本')
    // 打包失败（命令退出非 0）→ 整单失败
    const proj3 = deployProjects.save(deployProjects.normalizeProject({
      name: '打包失败项目', localPath: proj2Dir, deployMode: 'script',
      scriptMode: { artifactDir: 'release', packageCommand: 'bash -c "echo boom >&2; exit 3"' },
      version: { strategy: 'manual', manual: '3.0.0' }, // 目录无 3.0.0 产物 → 触发打包 → 失败
      targets: [{
        id: 't1', name: '生产', remotePath: REMOTE_HOME,
        server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
        health: { enabled: false, url: '', timeout: 90, interval: 3 },
      }],
    }))
    const { record: recPkgFail, events: evPkgFail } = await runDeploy(proj3.id)
    assert.strictEqual(recPkgFail.status, 'failed')
    assert.ok(recPkgFail.message.includes('退出码 3'), `消息应含退出码: ${recPkgFail.message}`)
    assert.strictEqual(recPkgFail.stages.package.status, 'failed')
    assert.ok(evPkgFail.logs.some((l) => l.text.includes('[打包] boom')), '失败输出应流入日志')
    deployProjects.remove(proj2.id); deployProjects.remove(proj3.id)
    passed += 1
    console.log('  ✓ 产物缺失自动打包：真实子进程构建→发布成功；打包失败整单失败且日志可见')

    // ── 10. deploy.sh 服务端同版本守卫：解压后、删除运行中目录前直接失败 ──
    // 绕过客户端编排直接调 deploy.sh（模拟旧版客户端/手工调用），兜底保护运行中版本
    const srv2 = path.join(tmpRoot, 'server2')
    const rel2 = path.join(srv2, 'releases', 'app-v1.0.0-002')
    fs.mkdirSync(rel2, { recursive: true })
    fs.writeFileSync(path.join(rel2, '.sentinel'), 'keep')
    fs.writeFileSync(path.join(srv2, 'CURRENT'), 'app-v1.0.0-002\n')
    fs.mkdirSync(path.join(srv2, 'uploads'), { recursive: true })
    fs.copyFileSync(
      path.join(projDir, 'release', 'app-v1.0.0-002.tar.gz'),
      path.join(srv2, 'uploads', 'app-v1.0.0-002.tar.gz'))
    const shPath = path.join(tmpRoot, 'deploy-guard.sh')
    fs.writeFileSync(shPath,
      fs.readFileSync(path.join(__dirname, '..', 'electron', 'deploy', 'scripts', 'deploy.sh'), 'utf8').replace(/\r\n/g, '\n'))
    const rGuard = spawnSync('bash', [msysPath(shPath), 'deploy', '--mode', 'script',
      '--app', '守卫测试', '--home', msysPath(srv2), '--package', 'app-v1.0.0-002.tar.gz',
      '--version', '1.0.0', '--upgrade-script', 'upgrade.sh',
      '--no-bootstrap-java', '--no-bootstrap-pgdump',
      '--no-backup-code', '--no-backup-db', '--auto-rollback', '--no-health',
      '--keep-releases', '10', '--keep-backups', '10', '--keep-upload'], { encoding: 'utf8' })
    const guardOut = `${rGuard.stdout || ''}${rGuard.stderr || ''}`
    assert.notStrictEqual(rGuard.status, 0, '同版本发布应非零退出')
    assert.ok(guardOut.includes('线上已运行同一版本'), `deploy.sh 应输出同版本守卫信息: ${guardOut}`)
    assert.ok(!guardOut.includes('已解压'), '守卫应在解压完成标记前失败')
    assert.ok(fs.existsSync(path.join(rel2, '.sentinel')), '运行中版本目录必须原样保留')
    assert.strictEqual(fs.readFileSync(path.join(srv2, 'CURRENT'), 'utf8').trim(), 'app-v1.0.0-002')
    passed += 1
    console.log('  ✓ deploy.sh 同版本守卫：改动任何服务器状态前直接失败、运行目录零改动')

    // ── 11. 版本同步 bumpVersionFiles：各版本文件类型 + 不误伤其他版本号 ──
    const { detectVersion, bumpVersionFiles } = require('../electron/deploy/version-detector')
    const bumpDir = path.join(tmpRoot, 'bump-proj')
    fs.mkdirSync(path.join(bumpDir, 'server'), { recursive: true })
    fs.mkdirSync(path.join(bumpDir, 'app'), { recursive: true })
    fs.mkdirSync(path.join(bumpDir, 'node_modules', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(bumpDir, 'VERSION'), '2.0.0\n')
    fs.writeFileSync(path.join(bumpDir, 'package.json'), JSON.stringify({
      name: 'root', version: '2.0.0', dependencies: { spring: '3.5.0' },
    }, null, 2))
    fs.writeFileSync(path.join(bumpDir, 'server', 'pom.xml'), [
      '<?xml version="1.0"?>',
      '<project>',
      '  <parent>',
      '    <groupId>org.springframework.boot</groupId>',
      '    <version>3.5.0</version>',
      '  </parent>',
      '  <version>2.0.0</version>',
      '</project>',
    ].join('\n'))
    fs.writeFileSync(path.join(bumpDir, 'server', 'build.gradle'), "group = 'demo'\nversion = '2.0.0'\n")
    fs.writeFileSync(path.join(bumpDir, 'app', 'pubspec.yaml'), 'name: app\nversion: 2.0.0\n')
    fs.writeFileSync(path.join(bumpDir, 'node_modules', 'lib', 'package.json'), '{"name":"lib","version":"2.0.0"}')
    const bumped = bumpVersionFiles(bumpDir, '2.0.0', '2.0.1')
    assert.deepStrictEqual(bumped.sort(), ['VERSION', 'package.json', 'server/build.gradle', 'server/pom.xml', 'app/pubspec.yaml'].sort(), `应同步全部版本声明: ${bumped}`)
    assert.strictEqual(fs.readFileSync(path.join(bumpDir, 'VERSION'), 'utf8').trim(), '2.0.1')
    const rootPkg = JSON.parse(fs.readFileSync(path.join(bumpDir, 'package.json'), 'utf8'))
    assert.strictEqual(rootPkg.version, '2.0.1')
    assert.strictEqual(rootPkg.dependencies.spring, '3.5.0', '依赖版本不受影响')
    const pom = fs.readFileSync(path.join(bumpDir, 'server', 'pom.xml'), 'utf8')
    assert.ok(pom.includes('<version>2.0.1</version>') && !pom.includes('<version>2.0.0</version>'), 'pom 直属版本应升级')
    assert.ok(pom.includes('<parent>') && pom.includes('<version>3.5.0</version>'), 'pom parent 版本不受影响')
    assert.strictEqual(fs.readFileSync(path.join(bumpDir, 'server', 'build.gradle'), 'utf8'), "group = 'demo'\nversion = '2.0.1'\n")
    assert.ok(fs.readFileSync(path.join(bumpDir, 'app', 'pubspec.yaml'), 'utf8').includes('version: 2.0.1'), 'pubspec 版本（含 build number 整体）应升级')
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(bumpDir, 'node_modules', 'lib', 'package.json'), 'utf8')).version, '2.0.0', 'node_modules 不扫描')
    assert.deepStrictEqual(bumpVersionFiles(bumpDir, '2.0.0', '2.0.2'), [], '解析值不等于旧版本时零改动')
    assert.deepStrictEqual(bumpVersionFiles(bumpDir, '2.0.1', '2.0.1'), [], '新旧版本相同零改动')
    // Flutter 场景：仅 pubspec，版本含 build number —— 解析值含 +7 整体作为旧版本匹配并整体替换
    const flutterDir = path.join(tmpRoot, 'flutter-app')
    fs.mkdirSync(flutterDir, { recursive: true })
    fs.writeFileSync(path.join(flutterDir, 'pubspec.yaml'), 'name: fa\nversion: 3.0.0+5\n')
    assert.strictEqual(detectVersion(flutterDir).version, '3.0.0+5', 'detect 应解析出含 build number 的版本')
    assert.deepStrictEqual(bumpVersionFiles(flutterDir, '3.0.0', '3.0.1'), [], '旧版本不含 build number 时不动 pubspec')
    assert.deepStrictEqual(bumpVersionFiles(flutterDir, '3.0.0+5', '3.0.1'), ['pubspec.yaml'])
    assert.ok(fs.readFileSync(path.join(flutterDir, 'pubspec.yaml'), 'utf8').includes('version: 3.0.1'), 'pubspec 应整体替换为发布版本')
    passed += 1
    console.log('  ✓ bumpVersionFiles：五类版本文件同步、parent/依赖/node_modules 不误伤、零改动幂等')

    // ── 12. 手动版本自动同步 + 打包读项目版本：发布 5.0.1 时项目 5.0.0 联动升级 ──
    const proj4Dir = path.join(tmpRoot, 'proj-bump')
    fs.mkdirSync(path.join(proj4Dir, 'server'), { recursive: true })
    fs.writeFileSync(path.join(proj4Dir, 'VERSION'), '5.0.0\n')
    fs.writeFileSync(path.join(proj4Dir, 'server', 'pom.xml'), [
      '<?xml version="1.0"?>',
      '<project>',
      '  <parent>',
      '    <groupId>org.springframework.boot</groupId>',
      '    <version>3.5.0</version>',
      '  </parent>',
      '  <version>5.0.0</version>',
      '</project>',
    ].join('\n'))
    // fake 打包脚本：与 Vantage package.sh 同契约——读项目 VERSION 决定产物版本
    fs.writeFileSync(path.join(proj4Dir, 'mkpkg.sh'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cd -- "$(dirname -- "${BASH_SOURCE[0]}")"',
      'ver="$(tr -d \'[:space:]\' < VERSION)"',
      'name="app-v${ver}-301"',
      'echo "[mkpkg] building v${ver} ..."',
      'd=".staging/$name"; rm -rf -- "$d"; mkdir -p -- "$d"',
      'cat > "$d/upgrade.sh" <<\'EOS\'',
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="$INSTALL_ROOT"',
      'echo "[fake-upgrade] $(cat "$IR/CURRENT" 2>/dev/null || echo none) -> $(basename -- "$SD")"',
      'if [ -f "$IR/CURRENT" ]; then old="$(cat "$IR/CURRENT")"; [ -f "$IR/releases/$old/stop.sh" ] && INSTALL_ROOT="$IR" bash "$IR/releases/$old/stop.sh" || true; fi',
      'printf \'%s\\n\' "$(basename -- "$SD")" > "$IR/CURRENT"',
      'INSTALL_ROOT="$IR" bash "$SD/start.sh"',
      'EOS',
      'printf "%s\\n" \'#!/usr/bin/env bash\' \'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\' \'echo $$ > "$SD/app.pid"; touch "$SD/.started"\' > "$d/start.sh"',
      'printf "%s\\n" \'#!/usr/bin/env bash\' \'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\' \'rm -f "$SD/.started"\' > "$d/stop.sh"',
      'mkdir -p release',
      '( cd -- .staging && tar -czf "../release/$name.tar.gz" "$name" )',
      'echo "[mkpkg] done"',
    ].join('\n'))
    const mkProj = (manual, autoBump) => deployProjects.save(deployProjects.normalizeProject({
      name: `版本同步项目-${manual}`, localPath: proj4Dir, deployMode: 'script',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', packageCommand: 'bash mkpkg.sh', packageTimeoutSec: 60, autoBumpVersion: autoBump },
      version: { strategy: 'manual', manual },
      targets: [{
        id: 't1', name: '生产', remotePath: REMOTE_HOME,
        server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
        health: { enabled: false, url: '', timeout: 90, interval: 3 },
      }],
    }))
    const proj4 = mkProj('5.0.1', undefined) // autoBumpVersion 未配置 → 默认开
    const { record: recBump, events: evBump } = await runDeploy(proj4.id)
    assert.strictEqual(recBump.status, 'success', `版本同步发布应成功: ${recBump.message}\n${evBump.logs.map((l) => l.text).join('\n')}`)
    assert.strictEqual(recBump.version, '5.0.1')
    assert.strictEqual(fs.readFileSync(path.join(proj4Dir, 'VERSION'), 'utf8').trim(), '5.0.0', '源项目 VERSION 保持原值；构建副本同步版本')
    const proj4Pom = fs.readFileSync(path.join(proj4Dir, 'server', 'pom.xml'), 'utf8')
    assert.ok(proj4Pom.includes('<version>5.0.0</version>'), '源项目 pom.xml 保持原值')
    assert.ok(proj4Pom.includes('<version>3.5.0</version>'), 'pom parent 版本不受影响')
    assert.ok(evBump.logs.some((l) => l.text.includes('项目版本 5.0.0 → 5.0.1') && l.text.includes('VERSION、server/pom.xml')), '日志应说明同步了哪些文件')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v5.0.1-301', '服务器应运行同步版本后的产物')
    // 关闭自动同步：打包成功但产物版本落后 → 失败信息指出项目版本与发布版本的偏差
    const proj5 = mkProj('6.0.0', false)
    const { record: recNoBump } = await runDeploy(proj5.id)
    assert.strictEqual(recNoBump.status, 'failed')
    assert.ok(recNoBump.message.includes('打包后仍无匹配产物'), `消息应提示打包后无匹配产物: ${recNoBump.message}`)
    assert.ok(recNoBump.message.includes('项目版本文件仍为 5.0.0（VERSION），与发布版本 6.0.0 不一致'), `消息应指出版本偏差: ${recNoBump.message}`)
    deployProjects.remove(proj4.id); deployProjects.remove(proj5.id)
    passed += 1
    console.log('  ✓ 手动版本自动同步：VERSION+pom 联动升级→打包读新版本→发布成功；关闭同步时失败信息指出偏差')

    // ── 11. CURRENT 指针由本工具负责：项目升级脚本不写指针时也必须记录当前版本 ──
    // 背景：契约里 CURRENT（内容 = release 目录名）由部署工具维护。若项目脚本不写、工具也不写，
    // 首次发布后就没有「当前版本」记录：线上版本查询为空、同版本守卫失效、旧版本清理失去保护。
    const proj6Dir = path.join(tmpRoot, 'proj-noptr')
    fs.mkdirSync(path.join(proj6Dir, 'release'), { recursive: true })
    fs.writeFileSync(path.join(proj6Dir, 'VERSION'), '7.0.0\n')
    // 造一个「不写 CURRENT」的发布包（与 makeFakeArtifact 同契约，仅去掉写指针那一行）
    {
      const name = 'app-v7.0.0-401'
      const stage = path.join(proj6Dir, '.staging', name)
      fs.mkdirSync(stage, { recursive: true })
      fs.writeFileSync(path.join(stage, 'VERSION'), '7.0.0\n')
      fs.writeFileSync(path.join(stage, 'upgrade.sh'), [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="$INSTALL_ROOT"',
        'echo "[fake-upgrade-noptr] $(basename -- "$SD")（本脚本不写 CURRENT）"',
        'INSTALL_ROOT="$IR" bash "$SD/start.sh"',
      ].join('\n'))
      fs.writeFileSync(path.join(stage, 'start.sh'), '#!/usr/bin/env bash\ntouch "$(dirname -- "${BASH_SOURCE[0]}")/.started"\n')
      fs.writeFileSync(path.join(stage, 'stop.sh'), '#!/usr/bin/env bash\nrm -f "$(dirname -- "${BASH_SOURCE[0]}")/.started"\n')
      const r = spawnSync('bash', ['-c', `cd "$(dirname '${msysPath(stage)}')" && tar -czf '${msysPath(path.join(proj6Dir, 'release', name + '.tar.gz'))}' '${name}' && rm -rf '${msysPath(stage)}'`], { encoding: 'utf8' })
      assert.strictEqual(r.status, 0, `打 no-ptr 包失败: ${r.stderr}`)
    }
    fs.rmSync(path.join(SERVER_ROOT, 'CURRENT'), { force: true })
    fs.rmSync(path.join(SERVER_ROOT, 'releases'), { recursive: true, force: true })
    const proj6 = deployProjects.save(deployProjects.normalizeProject({
      name: '不写指针的项目', localPath: proj6Dir, deployMode: 'script',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh' },
      version: { strategy: 'auto', manual: '' },
      targets: [{
        id: 't1', name: '生产', remotePath: REMOTE_HOME,
        server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
        health: { enabled: false, url: '', timeout: 90, interval: 3 },
      }],
    }))
    const { record: recPtr, events: evPtr } = await runDeploy(proj6.id)
    assert.strictEqual(recPtr.status, 'success', `不写指针的项目发布应成功: ${recPtr.message}\n${evPtr.logs.map((l) => l.text).join('\n')}`)
    assert.strictEqual(
      fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v7.0.0-401',
      '项目脚本不写 CURRENT 时，工具必须在发布成功后写入当前版本目录名',
    )
    assert.ok(evPtr.logs.some((l) => l.text.includes('CURRENT -> app-v7.0.0-401')), '日志应记录指针切换')
    // 二次发布：同版本守卫依赖 CURRENT，必须能识别出「线上已运行同一版本」
    const { record: recPtr2 } = await runDeploy(proj6.id)
    assert.strictEqual(recPtr2.status, 'failed')
    assert.ok(/线上已运行同一版本/.test(recPtr2.message), `同版本守卫应依赖工具写入的 CURRENT: ${recPtr2.message}`)
    deployProjects.remove(proj6.id)
    passed += 1
    console.log('  ✓ CURRENT 指针由工具兜底写入：项目脚本不写指针时线上版本仍可识别、同版本守卫生效')

    // ── 13. 发布说明约定：打包前自动生成缺失的 docs/release-notes-<版本>.md（Vantage package.sh 契约） ──
    // 项目背景完全对应用户现场：VERSION 已到新版本、docs/ 里有旧版说明、打包脚本缺同版本说明即中止
    const writeNotesAwareMkPkg = (dir, requireNotes) => fs.writeFileSync(path.join(dir, 'mkpkg.sh'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cd -- "$(dirname -- "${BASH_SOURCE[0]}")"',
      'ver="$(tr -d \'[:space:]\' < VERSION)"',
      ...(requireNotes ? [
        'notes="docs/release-notes-${ver}.md"',
        '[ -f "$notes" ] || { echo "ERROR: 缺少发布说明 $notes（发版须随 VERSION 提供同名文件）" >&2; exit 1; }',
      ] : []),
      'name="app-v${ver}-601"',
      'echo "[mkpkg] building v${ver} ..."',
      'd=".staging/$name"; rm -rf -- "$d"; mkdir -p -- "$d"',
      '[ ! -d docs ] || cp -r docs "$d/docs"',
      'cat > "$d/upgrade.sh" <<\'EOS\'',
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; IR="$INSTALL_ROOT"',
      'echo "[fake-upgrade] $(cat "$IR/CURRENT" 2>/dev/null || echo none) -> $(basename -- "$SD")"',
      'if [ -f "$IR/CURRENT" ]; then old="$(cat "$IR/CURRENT")"; [ -f "$IR/releases/$old/stop.sh" ] && INSTALL_ROOT="$IR" bash "$IR/releases/$old/stop.sh" || true; fi',
      'printf \'%s\\n\' "$(basename -- "$SD")" > "$IR/CURRENT"',
      'INSTALL_ROOT="$IR" bash "$SD/start.sh"',
      'EOS',
      'printf "%s\\n" \'#!/usr/bin/env bash\' \'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\' \'echo $$ > "$SD/app.pid"; touch "$SD/.started"\' > "$d/start.sh"',
      'printf "%s\\n" \'#!/usr/bin/env bash\' \'SD="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\' \'rm -f "$SD/.started"\' > "$d/stop.sh"',
      'mkdir -p release',
      '( cd -- .staging && tar -czf "../release/$name.tar.gz" "$name" )',
      'echo "[mkpkg] done"',
    ].join('\n'))
    const notesTarget = () => [{
      id: 't1', name: '生产', remotePath: REMOTE_HOME,
      server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
      health: { enabled: false, url: '', timeout: 90, interval: 3 },
    }]

    // 13a. 约定存在 + 目标版本说明缺失 → 自动生成初稿 → 打包通过 → 发布成功
    const proj7Dir = path.join(tmpRoot, 'proj-notes')
    fs.mkdirSync(path.join(proj7Dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(proj7Dir, 'VERSION'), '8.0.0\n')
    const oldNotesText = '# 上一版发布说明（内容不得被改动）\n'
    fs.writeFileSync(path.join(proj7Dir, 'docs', 'release-notes-7.5.0.md'), oldNotesText)
    const git7 = (...args) => {
      const r = spawnSync('git', ['-C', proj7Dir, ...args], { encoding: 'utf8' })
      assert.strictEqual(r.status, 0, `git ${args.join(' ')} 失败: ${r.stderr}`)
    }
    git7('init'); git7('config', 'user.email', 't@example.com'); git7('config', 'user.name', 'tester')
    fs.writeFileSync(path.join(proj7Dir, 'a.txt'), 'a'); git7('add', 'a.txt')
    git7('commit', '-q', '-m', 'feat(web): 落库提示一键切换真正生效')
    fs.writeFileSync(path.join(proj7Dir, 'b.txt'), 'b'); git7('add', 'b.txt')
    git7('commit', '-q', '-m', 'fix: 统计周期新增近半年/近一年/全部')
    writeNotesAwareMkPkg(proj7Dir, true)
    const proj7 = deployProjects.save(deployProjects.normalizeProject({
      name: '发布说明项目', localPath: proj7Dir, deployMode: 'script',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', packageCommand: 'bash mkpkg.sh', packageTimeoutSec: 60 },
      version: { strategy: 'auto', manual: '' },
      targets: notesTarget(),
    }))
    const { record: recNotes, events: evNotes } = await runDeploy(proj7.id)
    assert.strictEqual(recNotes.status, 'success', `自动生成发布说明后应发布成功: ${recNotes.message}\n${evNotes.logs.map((l) => l.text).join('\n')}`)
    assert.ok(
      evNotes.logs.some((l) => l.text.includes('已生成发布说明 docs/release-notes-8.0.0.md')),
      `日志应说明生成了哪个文件: ${evNotes.logs.map((l) => l.text).join('\n')}`)
    assert.ok(!fs.existsSync(path.join(proj7Dir, 'docs', 'release-notes-8.0.0.md')), '发布说明不写源项目')
    const genNotesPath = path.join(SERVER_ROOT, 'releases', 'app-v8.0.0-601', 'docs', 'release-notes-8.0.0.md')
    assert.ok(fs.existsSync(genNotesPath), '目标版本的发布说明应真实落盘')
    const genNotesText = fs.readFileSync(genNotesPath, 'utf8')
    assert.ok(genNotesText.includes('# 发布说明项目 8.0.0 发布说明'), `标题应含应用名与版本: ${genNotesText}`)
    assert.ok(genNotesText.includes('- 落库提示一键切换真正生效'), '真实 git 提交应清洗后进入清单')
    assert.ok(genNotesText.includes('- 统计周期新增近半年/近一年/全部'))
    assert.ok(!/feat|fix/.test(genNotesText), '约定式前缀不得残留')
    assert.strictEqual(fs.readFileSync(path.join(proj7Dir, 'docs', 'release-notes-7.5.0.md'), 'utf8'), oldNotesText, '旧版说明不得被改动')
    assert.strictEqual(fs.readFileSync(path.join(SERVER_ROOT, 'CURRENT'), 'utf8').trim(), 'app-v8.0.0-601', '打包产物版本应与发布版本一致')
    // 同版本说明已存在：编排层不再生成（幂等门直接断言）
    assert.strictEqual(
      deployService.ensureReleaseNotesForPackage(
        { name: '发布说明项目', localPath: path.join(SERVER_ROOT, 'releases', 'app-v8.0.0-601'), scriptMode: {} },
        { version: '8.0.0' }, { ok: false }),
      '', '同版本说明已存在 → 无需生成，返回空')
    deployProjects.remove(proj7.id)
    passed += 1
    console.log('  ✓ 发布说明约定：打包前自动生成初稿→真实打包通过→发布成功；旧版说明零改动、同版本幂等')

    // 13b. 关闭自动生成 → 打包脚本因缺发布说明中止，整单失败且文件保持缺失
    const proj8Dir = path.join(tmpRoot, 'proj-notes-off')
    fs.mkdirSync(path.join(proj8Dir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(proj8Dir, 'VERSION'), '9.0.0\n')
    fs.writeFileSync(path.join(proj8Dir, 'docs', 'release-notes-8.9.0.md'), '# 旧版\n')
    writeNotesAwareMkPkg(proj8Dir, true)
    const proj8 = deployProjects.save(deployProjects.normalizeProject({
      name: '关闭发布说明项目', localPath: proj8Dir, deployMode: 'script',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', packageCommand: 'bash mkpkg.sh', packageTimeoutSec: 60, autoReleaseNotes: false },
      version: { strategy: 'auto', manual: '' },
      targets: notesTarget(),
    }))
    const { record: recOff, events: evOff } = await runDeploy(proj8.id)
    assert.strictEqual(recOff.status, 'failed')
    assert.strictEqual(recOff.stages.package.status, 'failed')
    assert.ok(recOff.message.includes('退出码 1'), `消息应含打包退出码: ${recOff.message}`)
    assert.ok(evOff.logs.some((l) => l.text.includes('缺少发布说明')), '打包脚本的缺文件报错应流入日志')
    assert.ok(!fs.existsSync(path.join(proj8Dir, 'docs', 'release-notes-9.0.0.md')), '关闭开关时不得生成')
    deployProjects.remove(proj8.id)
    passed += 1
    console.log('  ✓ 关闭自动生成：打包脚本缺文件报错如实上抛、文件保持缺失')

    // 13c. 无约定项目零打扰：没有 release-notes-*.md → 不生成任何文件，打包照常成功
    const proj9Dir = path.join(tmpRoot, 'proj-noconv')
    fs.mkdirSync(proj9Dir, { recursive: true })
    fs.writeFileSync(path.join(proj9Dir, 'VERSION'), '9.5.0\n')
    writeNotesAwareMkPkg(proj9Dir, false)
    const proj9 = deployProjects.save(deployProjects.normalizeProject({
      name: '无约定项目', localPath: proj9Dir, deployMode: 'script',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', packageCommand: 'bash mkpkg.sh', packageTimeoutSec: 60 },
      version: { strategy: 'auto', manual: '' },
      targets: notesTarget(),
    }))
    const { record: recConv, events: evConv } = await runDeploy(proj9.id)
    assert.strictEqual(recConv.status, 'success', `无约定项目应照常发布: ${recConv.message}\n${evConv.logs.map((l) => l.text).join('\n')}`)
    assert.ok(!fs.existsSync(path.join(proj9Dir, 'docs')), '无约定时不得创建 docs/ 或任何说明文件')
    assert.ok(!evConv.logs.some((l) => l.text.includes('发布说明')), '无约定时日志不得出现发布说明动作')
    assert.strictEqual(
      deployService.ensureReleaseNotesForPackage(
        { name: '无约定项目', localPath: proj9Dir, scriptMode: {} },
        { version: '9.5.0' }, { ok: false }),
      '', '无约定 → 零打扰')
    deployProjects.remove(proj9.id)
    passed += 1
    console.log('  ✓ 无约定项目零打扰：不建目录、不写文件、日志无动作')

    console.log(`\n脚本部署形态编排自测通过（${passed} 组断言）`)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('自测失败：', err)
  process.exitCode = 1
})
