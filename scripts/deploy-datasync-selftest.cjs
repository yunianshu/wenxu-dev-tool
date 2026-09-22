/**
 * 数据同步专项自测（无框架，node scripts/deploy-datasync-selftest.cjs 直接运行）
 *
 * 验证策略：
 *   - buildDataPackage：真实 ZIP → PowerShell 解压往返比对内容（非 Mock）
 *   - 配置规范化与持久化：dataSync 默认值/字段校验经 save/list 真实落盘往返
 *   - SSH 打桩的编排全链路：deploy-service.run() 走真实业务编排（打包/校验/阶段跟踪/历史），
 *     仅模拟无法在本机接入的外部系统（远程 Linux 服务器）：
 *     exec 按命令模式回放 deploy.sh 标记与退出码，upload 把文件真实落到「服务器目录」
 *   覆盖：启用+成功 / 服务器执行失败 / 未启用跳过 / 前置校验（目录越界、不存在）
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

// ── electron 打桩（store/deploy-projects 在纯 Node 下运行） ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'datasync-test-'))
const electronPath = require.resolve('electron')
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => path.join(tmpRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } },
}

// ── ssh-service 打桩：模拟远端服务器 ──
const serverState = {
  uploads: fs.mkdtempSync(path.join(tmpRoot, 'server-uploads-')), // 「服务器」uploads 目录
  execLog: [],
  /** exec 命令模式 → { code, stdout }；按注册顺序第一个命中的生效 */
  execScripts: [],
}
const realSsh = require('../electron/deploy/ssh-service')
require.cache[require.resolve('../electron/deploy/ssh-service')] = {
  id: require.resolve('../electron/deploy/ssh-service'),
  filename: require.resolve('../electron/deploy/ssh-service'),
  loaded: true,
  exports: {
    remoteJoin: realSsh.remoteJoin,
    connect: async () => ({
      stub: true,
      // deploy-service 的 uploadTextFile 直接使用 conn.sftp 写文本（deploy.sh 上传）
      sftp: (cb) => cb(null, {
        createWriteStream: (remotePath) => {
          const dest = path.join(serverState.uploads, path.basename(remotePath))
          const s = fs.createWriteStream(dest)
          const origEnd = s.end.bind(s)
          s.end = (...a) => { setTimeout(() => s.emit('close'), 30); return origEnd(...a) }
          return s
        },
        end: () => {},
      }),
    }),
    close: () => {},
    mkdirp: async () => {},
    upload: async (_conn, localPath, remotePath, onProgress) => {
      const dest = path.join(serverState.uploads, path.basename(remotePath))
      fs.copyFileSync(localPath, dest)
      const size = fs.statSync(dest).size
      if (onProgress) onProgress(size, size)
      return { remotePath }
    },
    exec: async (_conn, command, onLine) => {
      serverState.execLog.push(command)
      // sha256sum：对已真实落盘的「服务器」文件计算真实哈希，校验链路不失真
      const shaM = command.match(/sha256sum '([^']+)'/)
      if (shaM) {
        const remoteFile = path.join(serverState.uploads, path.basename(shaM[1]))
        assert.ok(fs.existsSync(remoteFile), `上传的包应真实存在于服务器目录: ${shaM[1]}`)
        const crypto = require('crypto')
        const hash = crypto.createHash('sha256').update(fs.readFileSync(remoteFile)).digest('hex')
        // 命令里的 awk '{print $1}' 在桩中同样模拟：只返回哈希列
        return { code: 0, stdout: `${hash}\n`, stderr: '' }
      }
      for (const s of serverState.execScripts) {
        if (s.pattern.test(command)) {
          if (s.onMatch) s.onMatch(command)
          const out = s.stdout ?? ''
          // 模拟流式输出：deploy.sh 的标记解析依赖 exec 的 onLine 回调
          if (out && onLine) onLine(out, 'stdout')
          return { code: s.code ?? 0, stdout: out, stderr: '' }
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  },
}

const packager = require('../electron/deploy/packager')
const deployProjects = require('../electron/deploy/deploy-projects')
const deployService = require('../electron/deploy/deploy-service')

/** 用 PowerShell 解压 zip（真实解压，验证包可被服务器端 unzip 处理） */
function unzipTo(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
  ], { windowsHide: true })
}

function seedProject(dir, dataSync) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'VERSION'), '2.0.0\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n', 'utf8')
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(path.join(dataDir, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'kv.json'), '{"items":42}', 'utf8')
  fs.writeFileSync(path.join(dataDir, 'nested', 'blob.bin'), Buffer.from([1, 2, 3, 250]))
  const project = deployProjects.normalizeProject({
    name: '数据同步测试项目',
    localPath: dir,
    version: { strategy: 'auto', manual: '' },
    targets: [{
      id: 't1',
      name: '生产',
      remotePath: '/srv/app',
      server: { host: `${path.basename(dir)}.example.invalid`, port: 22, username: 'root', authType: 'password' },
      health: { enabled: false, url: '', timeout: 90, interval: 3 },
      dataSync,
    }],
  })
  const saved = deployProjects.save(project)
  return saved.id
}

/** 执行一次发布并收集事件 */
function runDeploy(projectId) {
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
    // ── 1. buildDataPackage 真实打包 → 解压往返 ──
    const projDir = path.join(tmpRoot, 'proj-a')
    fs.mkdirSync(projDir, { recursive: true })
    fs.mkdirSync(path.join(projDir, 'data', 'sub'), { recursive: true })
    fs.writeFileSync(path.join(projDir, 'data', 'a.txt'), 'A', 'utf8')
    fs.writeFileSync(path.join(projDir, 'data', 'sub', 'b.txt'), 'B', 'utf8')
    fs.writeFileSync(path.join(projDir, 'not-data.txt'), 'x', 'utf8')
    const dataPack = await packager.buildDataPackage({ projectDir: projDir, dataDir: 'data', appName: '测试', version: '1.0' })
    assert.ok(fs.existsSync(dataPack.zipPath))
    const roundDir = path.join(tmpRoot, 'roundtrip')
    unzipTo(dataPack.zipPath, roundDir)
    assert.strictEqual(fs.readFileSync(path.join(roundDir, 'a.txt'), 'utf8'), 'A')
    assert.strictEqual(fs.readFileSync(path.join(roundDir, 'sub', 'b.txt'), 'utf8'), 'B')
    assert.ok(!fs.existsSync(path.join(roundDir, 'not-data.txt')), '数据包不得包含数据目录之外的文件')
    assert.strictEqual(dataPack.sha256, dataPack.sha256.toLowerCase())
    assert.strictEqual(dataPack.fileCount, 2, 'fileCount 应只统计文件（目录条目不双计）')
    passed += 1
    console.log('  ✓ buildDataPackage 真实打包与解压往返内容一致')

    // ── 2. dataSync 配置规范化与持久化 ──
    const projectIdOk = seedProject(path.join(tmpRoot, 'proj-b'), { enabled: true, localDir: 'data', remoteDir: 'shared/kv' })
    const listed = deployProjects.list()
    const t = listed.find((p) => p.id === projectIdOk).targets[0]
    assert.strictEqual(t.dataSync.enabled, true)
    assert.strictEqual(t.dataSync.localDir, 'data')
    assert.strictEqual(t.dataSync.remoteDir, 'shared/kv')
    const projectIdOff = seedProject(path.join(tmpRoot, 'proj-c'), undefined) // 缺省 → 关闭+默认路径
    const tOff = deployProjects.list().find((p) => p.id === projectIdOff).targets[0]
    assert.strictEqual(tOff.dataSync.enabled, false)
    assert.strictEqual(tOff.dataSync.localDir, 'data')
    assert.strictEqual(tOff.dataSync.remoteDir, 'shared/data')
    passed += 1
    console.log('  ✓ dataSync 配置规范化、默认值与真实落盘往返正确')

    // ── 3. validateDataSync 防越界与缺失校验 ──
    const proj = deployProjects.list().find((p) => p.id === projectIdOk)
    assert.ok(deployService.validateDataSync(proj, { enabled: true, localDir: 'data', remoteDir: 'shared/x' }).ok)
    assert.strictEqual(deployService.validateDataSync(proj, { enabled: true, localDir: '../escape', remoteDir: 'shared/x' }).ok, false, '越界目录应拒绝')
    assert.strictEqual(deployService.validateDataSync(proj, { enabled: true, localDir: '.', remoteDir: 'shared/x' }).ok, false, '项目根本身应拒绝')
    assert.strictEqual(deployService.validateDataSync(proj, { enabled: true, localDir: 'ghost', remoteDir: 'shared/x' }).ok, false, '不存在的目录应拒绝')
    assert.strictEqual(deployService.validateDataSync(proj, { enabled: true, localDir: 'data', remoteDir: 'a/../b' }).ok, false, 'remoteDir 含 .. 应拒绝')
    const cmd = deployService.buildDataSyncCommand('/srv/app/uploads/d.zip', '/srv/app/shared/data')
    assert.ok(cmd.includes("mkdir -p '/srv/app/shared/data'") && cmd.includes("unzip -o '/srv/app/uploads/d.zip' -d '/srv/app/shared/data'"), '同步命令应包含建目录与解压覆盖')
    passed += 1
    console.log('  ✓ validateDataSync 防越界/缺失校验与远端命令拼装正确')

    // ── 4. 编排全链路（SSH 打桩）：启用 → 发布成功后数据同步成功 ──
    serverState.execScripts = [
      { pattern: /unzip -o .* && rm -f/, stdout: '__DATA_SYNC_OK__\n', code: 0 },
      { pattern: /readlink/, stdout: '' },
      { pattern: /bash .*deploy\.sh/, stdout: '__STAGE__:backup-code\n__STAGE__:extract\n__STAGE__:build\n__STAGE__:start\n__DEPLOY_OK__:发布成功\n', code: 0 },
    ]
    const { record: recOk, events: evOk } = await runDeploy(projectIdOk)
    assert.strictEqual(recOk.status, 'success', `应为 success，实际 ${recOk.status}: ${recOk.message}`)
    assert.strictEqual(recOk.stages.datasync.status, 'success', '数据同步阶段应为 success')
    assert.ok(serverState.execLog.some((c) => c.includes("unzip -o") && c.includes('/srv/app/shared/kv')), '应解压覆盖到配置的 remoteDir')
    // 数据包应真实上传且包含数据文件（解压桩收到的文件验证内容）
    const uploadedData = fs.readdirSync(serverState.uploads).find((f) => f.includes('-data-2.0.0-'))
    assert.ok(uploadedData, '数据包应上传到服务器 uploads')
    const extracted = path.join(tmpRoot, 'verify-ok')
    unzipTo(path.join(serverState.uploads, uploadedData), extracted)
    assert.ok(fs.existsSync(path.join(extracted, 'kv.json')), '数据包应包含 kv.json')
    const stageOk = evOk.stages.find((s) => s.stage === 'datasync' && s.status === 'success')
    assert.ok(stageOk, '应发出 datasync success 阶段事件')
    passed += 1
    console.log('  ✓ 编排全链路（SSH 打桩）：发布成功后数据真实上传并同步到 shared/')

    // ── 5. 服务器端同步失败 → 整单 failed，代码已上线的提示可见 ──
    serverState.execScripts[0] = { pattern: /unzip -o .* && rm -f/, stdout: 'unzip: cannot find or open\n', code: 9 }
    serverState.uploads = fs.mkdtempSync(path.join(tmpRoot, 'server-uploads2-'))
    const { record: recFail } = await runDeploy(projectIdOk)
    assert.strictEqual(recFail.status, 'failed')
    assert.ok(recFail.message.includes('数据同步失败'), `消息应含数据同步失败，实际: ${recFail.message}`)
    assert.strictEqual(recFail.stages.datasync.status, 'failed')
    assert.strictEqual(recFail.stages.health.status !== 'failed', true, '健康检查阶段不应被误标失败')
    passed += 1
    console.log('  ✓ 服务器端数据同步失败 → 整单 failed 且阶段状态正确')

    // ── 6. 未启用 → datasync skipped，整体成功 ──
    serverState.execScripts[0] = { pattern: /unzip -o .* && rm -f/, stdout: '__DATA_SYNC_OK__\n', code: 0 }
    serverState.execLog.length = 0
    const { record: recSkip } = await runDeploy(projectIdOff)
    assert.strictEqual(recSkip.status, 'success')
    assert.strictEqual(recSkip.stages.datasync.status, 'skipped')
    assert.ok(!serverState.execLog.some((c) => c.includes('unzip -o') && c.includes('/srv/app/')), '未启用时不得执行数据同步命令')
    passed += 1
    console.log('  ✓ 未启用数据同步 → 阶段 skipped 且不产生任何同步命令')

    // ── 7. 前置校验失败：数据目录不存在 → check 阶段失败，不产生任何服务器操作 ──
    const projectIdBad = seedProject(path.join(tmpRoot, 'proj-d'), { enabled: true, localDir: 'ghost-dir', remoteDir: 'shared/data' })
    serverState.execLog.length = 0
    const { record: recBad } = await runDeploy(projectIdBad)
    assert.strictEqual(recBad.status, 'failed')
    assert.ok(recBad.message.includes('数据目录不存在'), `消息应含数据目录不存在，实际: ${recBad.message}`)
    assert.strictEqual(recBad.stages.check.status, 'failed')
    assert.strictEqual(serverState.execLog.length, 0, '前置校验失败不得连接服务器执行任何命令')
    passed += 1
    console.log('  ✓ 数据目录缺失在检查阶段即失败，且不产生服务器操作')

    // ── 8. 导入钩子：importMode=command → 数据落盘后执行导入命令（占位符展开） ──
    const importDir = path.join(tmpRoot, 'proj-import')
    fs.mkdirSync(importDir, { recursive: true })
    fs.writeFileSync(path.join(importDir, 'VERSION'), '3.0.0\n', 'utf8')
    fs.writeFileSync(path.join(importDir, 'docker-compose.yml'), 'services: {}\n', 'utf8')
    fs.mkdirSync(path.join(importDir, 'data'), { recursive: true })
    fs.writeFileSync(path.join(importDir, 'data', 'en.json'), '{"code":200}', 'utf8')
    const savedImport = deployProjects.save(deployProjects.normalizeProject({
      name: '导入钩子项目', localPath: importDir, version: { strategy: 'auto' },
      targets: [{
        id: 't1', name: '生产', remotePath: '/srv/app2',
        server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' },
        health: { enabled: false },
        dataSync: {
          enabled: true, localDir: 'data', remoteDir: 'shared/data',
          importMode: 'command', importCommand: 'bash /opt/import.sh {dataDir} {user} {secret}',
          importUser: 'admin', importSecret: "p@ss'word",
        },
      }],
    }))
    serverState.execScripts = [
      { pattern: /unzip -o .* && rm -f/, stdout: '__DATA_SYNC_OK__\n', code: 0 },
      { pattern: /bash \/opt\/import\.sh/, stdout: 'imported 61 products\n', code: 0 },
      { pattern: /readlink/, stdout: '' },
      { pattern: /bash .*deploy\.sh/, stdout: '__DEPLOY_OK__:ok\n', code: 0 },
    ]
    const { record: recHook } = await runDeploy(savedImport.id)
    assert.strictEqual(recHook.status, 'success', '导入钩子成功时整单应 success: ' + recHook.message)
    assert.strictEqual(recHook.stages.datasync.status, 'success')
    const importCmd = serverState.execLog.find((c) => c.includes('/opt/import.sh'))
    assert.ok(importCmd, '应执行导入命令')
    assert.ok(importCmd.includes("'/srv/app2/shared/data'"), '占位符 {dataDir} 应展开为带引号远端目录')
    assert.ok(importCmd.includes("'admin'"), '{user} 应展开')
    assert.ok(importCmd.includes("'p@ss'\\''word'"), '{secret} 应单引号转义展开')
    // 导入命令退出码非 0 → 整单 failed
    serverState.execScripts[1] = { pattern: /bash \/opt\/import\.sh/, stdout: 'import failed\n', code: 3 }
    serverState.uploads = fs.mkdtempSync(path.join(tmpRoot, 'server-uploads3-'))
    const { record: recHookFail } = await runDeploy(savedImport.id)
    assert.strictEqual(recHookFail.status, 'failed')
    assert.ok(recHookFail.message.includes('数据导入命令执行失败'), '失败消息应含导入失败: ' + recHookFail.message)
    assert.strictEqual(recHookFail.stages.datasync.status, 'failed')
    // 未配置导入钩子 → 不执行导入命令
    serverState.execScripts[1] = { pattern: /unzip -o .* && rm -f/, stdout: '__DATA_SYNC_OK__\n', code: 0 }
    serverState.execLog.length = 0
    const { record: recHookNone } = await runDeploy(projectIdOff)
    assert.strictEqual(recHookNone.status, 'success')
    assert.ok(!serverState.execLog.some((c) => c.includes('/opt/import.sh')), '未配置导入时不得执行导入命令')
    passed += 1
    console.log('  ✓ 导入钩子：命令执行/占位符转义/失败传播/未配置跳过全部正确')

    // ── 9. 导入凭据：save 加密落盘、list 脱敏（不出主进程）、明文更新替换 ──
    const listedHook = deployProjects.list().find((p) => p.id === savedImport.id)
    const dsHook = listedHook.targets[0].dataSync
    assert.strictEqual(dsHook.importSecretConfigured, true, 'list 应标记导入凭据已配置')
    assert.ok(!('importSecret' in dsHook), 'list 不得携带加密对象/明文凭据')
    assert.ok(dsHook.importSecretMasked && dsHook.importSecretMasked.includes('•'), '应返回掩码')
    // 原始文件中应存加密对象而非明文
    const rawFile = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'userdata', 'deploy-projects.json'), 'utf8'))
    const rawDs = rawFile.projects.find((p) => p.id === savedImport.id).targets[0].dataSync
    assert.ok(rawDs.importSecret && typeof rawDs.importSecret === 'object' && ('plain' in rawDs.importSecret || 'enc' in rawDs.importSecret),
      '落盘应为 store 加密封装对象，而非裸明文字符串')
    passed += 1
    console.log('  ✓ 导入凭据：加密落盘、list 脱敏、掩码返回正确')

    // ── 10. 数据库备份恢复：文件名防护 / 前置校验 / 保底备份 / 恢复链路 ──
    {
      // 文件名注入防护
      assert.throws(() => deployService.assertDbBackupName('../evil.sql'), /非法/, '路径穿越应拒绝')
      assert.throws(() => deployService.assertDbBackupName('db_x;rm.sh'), /非法/, '命令注入字符应拒绝')
      assert.throws(() => deployService.assertDbBackupName('app_20260905.tar.gz'), /非法/, '非 db_ 前缀应拒绝')
      deployService.assertDbBackupName('db_20260905-123401.sql') // 合法名不抛
      // 前置校验：未启用备份配置时拒绝
      const rErr = await deployService.restoreDbBackup(projectIdOff, 't1', 'db_20260905-123401.sql').catch((e) => ({ threw: e.message }))
      assert.ok(rErr && rErr.threw && /未启用|未配置/.test(rErr.threw), '未配置数据库信息应拒绝: ' + JSON.stringify(rErr))
      // 启用备份配置的项目：走恢复链路（exec 桩验证命令序列）
      const dirR = path.join(tmpRoot, 'proj-restore2')
      fs.mkdirSync(path.join(dirR, 'data'), { recursive: true })
      fs.writeFileSync(path.join(dirR, 'VERSION'), '4.0.0\n', 'utf8')
      fs.writeFileSync(path.join(dirR, 'docker-compose.yml'), 'services: {}\n', 'utf8')
      const savedR = deployProjects.save(deployProjects.normalizeProject({
        name: '恢复项目', localPath: dirR, version: { strategy: 'auto' },
        deploy: { backupDatabase: true, dbType: 'postgres', dbContainer: 'pg-c', dbName: 'mydb', dbUser: 'u1' },
        targets: [{ id: 't1', name: '生产', remotePath: '/srv/r',
          server: { host: '203.0.113.10', port: 22, username: 'root', authType: 'password' }, health: { enabled: false },
          dataSync: { enabled: false } }],
      }))
      serverState.execLog.length = 0
      serverState.execScripts = [
        { pattern: /test -f .*db_20260905/, stdout: 'Y\n' },
        { pattern: /pg_dump .*db_guard_/, stdout: '__GUARD_OK__\n' },
        { pattern: /DROP DATABASE/, stdout: '__DB_RESTORE_OK__\n' },
      ]
      const recR = await deployService.restoreDbBackup(savedR.id, 't1', 'db_20260905-123401.sql')
      assert.strictEqual(recR.status, 'success', '恢复应成功: ' + recR.message)
      const dropCmd = serverState.execLog.find((c) => c.includes('DROP DATABASE'))
      assert.ok(dropCmd && dropCmd.includes('DROP DATABASE mydb WITH (FORCE)'), '应重建目标库')
      assert.ok(serverState.execLog.some((c) => c.includes('db_guard_') && c.includes('pg_dump')), '应先做保底备份')
      assert.ok(serverState.execLog.some((c) => c.includes('ON_ERROR_STOP=1')), '灌入应启用出错即停')
      assert.ok(serverState.execLog.some((c) => c.includes('com.docker.compose.project')), '应重启同 compose 项目容器')
      assert.strictEqual(recR.type, 'db-restore', '历史记录类型应为 db-restore')
      // 保底备份失败 → 中止且不执行 DROP
      serverState.execLog.length = 0
      serverState.execScripts = [
        { pattern: /test -f .*db_20260905/, stdout: 'Y\n' },
        { pattern: /pg_dump .*db_guard_/, stdout: '', code: 1 },
      ]
      const recGuard = await deployService.restoreDbBackup(savedR.id, 't1', 'db_20260905-123401.sql')
      assert.strictEqual(recGuard.status, 'failed', '保底失败应 failed')
      assert.ok(recGuard.message.includes('保底备份失败'), '消息应含保底备份失败')
      assert.ok(!serverState.execLog.some((c) => c.includes('DROP DATABASE')), '保底失败绝不重建库')
      // 列表解析
      serverState.execScripts = [
        { pattern: /ls -lht .*db_\*\.sql/, stdout: '2.8M 2026-09-05 12:34 db_20260905-123401.sql\n1.1M 2026-09-04 10:00 db_20260904-100000.sql\n' },
      ]
      const lb = await deployService.listDbBackups(savedR.id, 't1')
      assert.strictEqual(lb.backups.length, 2)
      assert.deepStrictEqual(lb.backups[0], { size: '2.8M', time: '2026-09-05 12:34', fileName: 'db_20260905-123401.sql' })
      passed += 1
      console.log('  ✓ 数据库备份恢复：文件名防护/前置校验/保底备份中止/恢复链/列表解析全部正确')
    }

    console.log(`\n数据同步专项自测通过（${passed} 组断言）`)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('自测失败：', err)
  process.exitCode = 1
})
