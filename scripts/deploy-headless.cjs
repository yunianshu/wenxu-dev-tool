/**
 * 无头发布入口 —— 用法: npx electron scripts/deploy-headless.cjs <projectId> [targetId]
 *
 * 场景：参数已在 GUI 里配置好（凭据引用保存在 userData，密码在系统凭据库），
 * 需要在不打开界面的情况下执行一次完整发布（CI / 脚本化 / 代办）。
 * targetId 省略时使用项目第一个部署目标。复用主进程 deploy 模块与 GUI
 * 完全相同的链路；日志与阶段事件打到 stdout。退出码：0=成功，1=失败/回滚/取消。
 */
const os = require('os')
const path = require('path')
const { app } = require('electron')

// 安装版后台以 PLM_NODE_BACKEND=1 启动，凭据走系统凭据库；无头入口须一致。
process.env.PLM_NODE_BACKEND = '1'

const projectId = process.argv[2]
const targetId = process.argv[3] || undefined
if (!projectId) {
  console.error('用法: electron scripts/deploy-headless.cjs <projectId> [targetId]')
  app.exit(1)
}

// 复用 GUI 应用的 userData（部署项目配置、凭据引用、发布历史都在这里）
const userDataDir = path.join(app.getPath('appData'), 'dev-project-manager')
// 安装版首次加载 store 时宿主还没设置 userData，凭据库服务名按 homedir 计算；
// 这里复现同一加载顺序，否则读不到已有密码。
const getPath = app.getPath.bind(app)
app.getPath = (name) => (name === 'userData' ? os.homedir() : getPath(name))
require('../electron/store')
app.getPath = getPath
app.setPath('userData', userDataDir)

app.whenReady().then(async () => {
  // 延迟 require：history/deploy-projects 在调用时才取 userData 路径，ready 后再加载最稳妥
  const deployService = require('../electron/deploy/deploy-service')
  deployService.setEmitter((ch, payload) => {
    if (ch === 'deploy:log') {
      console.log(`${payload.ts} [${payload.level.toUpperCase()}] ${payload.text}`)
    } else if (ch === 'deploy:stage') {
      console.log(`>> 阶段 ${payload.stage}: ${payload.status}`)
    } else if (ch === 'deploy:progress') {
      if (payload.kind === 'upload') process.stdout.write(`\r上传进度 ${payload.percent}%`)
      if (payload.kind === 'package' && payload.count % 50 === 0) process.stdout.write(`\r打包文件数 ${payload.count}`)
    } else if (ch === 'deploy:done') {
      const r = payload.record
      console.log(`\n== 发布结束: ${r.status} | 版本 ${r.version} | 耗时 ${(r.durationMs / 1000).toFixed(1)}s ==`)
      console.log(`== 说明: ${r.message} | 历史日志: ${r.logFile} ==`)
    }
  })

  try {
    const record = await deployService.run(projectId, targetId)
    console.log('FINAL_STATUS=' + record.status)
    app.exit(record.status === 'success' ? 0 : 1)
  } catch (e) {
    console.error('发布异常:', e.message)
    app.exit(1)
  }
})
