/**
 * Preload —— 通过 contextBridge 向渲染进程暴露安全的 IPC API
 *
 * 关键：Vue 的 ref/reactive 会把数组/对象包装为 Proxy，
 * Electron 的 structuredClone 无法克隆 Proxy，导致 ipcRenderer.invoke
 * 抛出 "An object could not be cloned"。因此在 preload 层将参数统一
 * 转换为普通可克隆对象（JSON 往返），从源头规避该问题。
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 将 Vue 响应式代理等转为普通可 JSON 序列化对象 */
function toPlain(value) {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function subscribe(channel, cb) {
  const listener = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('gitReport', {
  // 配置
  configLoad: () => ipcRenderer.invoke('config:load'),
  configSave: (cfg) => ipcRenderer.invoke('config:save', toPlain(cfg)),
  // 目录
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  // 文件（如 SSH 私钥）
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  // git（参数经 toPlain 去除响应式代理）；force=true 强制重新扫盘（手动「重新扫描」用）
  scanRepos: (roots, excludes, force) =>
    ipcRenderer.invoke('git:scanRepos', { roots: toPlain(roots), excludes: toPlain(excludes), force: !!force }),
  warmup: () => ipcRenderer.invoke('git:warmup'),
  // 渲染层首帧已绘制：主进程据此启动后台任务（仓库预热 / 内置 Harness），
  // 保证这些重型任务不与首屏渲染抢主进程与磁盘
  appUiReady: () => ipcRenderer.invoke('app:uiReady'),
  // 已发现仓库快照（补齐接线前错过的发现事件，避免数量与收集总数不一致）
  reposSnapshot: () => ipcRenderer.invoke('git:reposSnapshot'),
  repoInfo: (repo) => ipcRenderer.invoke('git:repoInfo', repo),
  collectCommits: (repos, opts) =>
    ipcRenderer.invoke('git:collectCommits', { repos: toPlain(repos), opts: toPlain(opts) }),
  getIdentity: () => ipcRenderer.invoke('git:identity'),
  onScanProgress: (cb) => subscribe('git:scanProgress', cb),
  onScanRepoFound: (cb) => subscribe('git:scanRepoFound', cb),
  onScanDone: (cb) => subscribe('git:scanDone', cb),
  onCollectProgress: (cb) => subscribe('git:collectProgress', cb),
  // 报告
  saveReport: (defaultName, content) => ipcRenderer.invoke('report:save', { defaultName, content }),
  // 报告历史
  saveReportAuto: (payload) => ipcRenderer.invoke('report:saveAuto', toPlain(payload)),
  listHistory: () => ipcRenderer.invoke('report:listHistory'),
  readHistory: (id) => ipcRenderer.invoke('report:readHistory', id),
  deleteHistory: (id) => ipcRenderer.invoke('report:deleteHistory', id),
  // AI 对话（流式）
  aiChat: (messages, opts) =>
    ipcRenderer.invoke('ai:chat', { messages: toPlain(messages), opts: toPlain(opts) }),
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  aiTest: (opts) => ipcRenderer.invoke('ai:test', toPlain(opts)),
  aiModels: (opts) => ipcRenderer.invoke('ai:models', toPlain(opts)),
  onAiDelta: (cb) => subscribe('ai:chatDelta', cb),
  // 系统
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  // 窗口控制（无边框自定义标题栏）
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  // 关闭询问（Element Plus 询问框在渲染层，与项目 UI 风格一致）：主进程广播 → 弹框 → 结果回传
  onWinAskClose: (cb) => subscribe('win:askClose', cb),
  winCloseConfirm: (payload) => ipcRenderer.invoke('win:closeConfirm', toPlain(payload)),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onWinMaximized: (cb) => subscribe('win:maximized', cb),
  winSetFullScreen: (flag) => ipcRenderer.invoke('win:setFullScreen', !!flag),
  winIsFullScreen: () => ipcRenderer.invoke('win:isFullScreen'),
  onWinFullscreen: (cb) => subscribe('win:fullscreen', cb),
  // 项目中心
  projectsList: () => ipcRenderer.invoke('projects:list'),
  projectsSave: (project) => ipcRenderer.invoke('projects:save', toPlain(project)),
  projectsRemove: (projectId) => ipcRenderer.invoke('projects:remove', projectId),
  // 扩展管理（四平台技能与插件）
  extensionsList: () => ipcRenderer.invoke('extensions:list'),
  extensionsToggleSkill: (platform, name, enable) =>
    ipcRenderer.invoke('extensions:toggleSkill', { platform, name, enable }),
  extensionsTogglePlugin: (platform, id, enable) =>
    ipcRenderer.invoke('extensions:togglePlugin', { platform, id, enable }),
  extensionsReadSkill: (platform, name) =>
    ipcRenderer.invoke('extensions:readSkill', { platform, name }),
  // 终端（在项目目录打开 PowerShell / 系统终端）
  openTerminal: (dir) => ipcRenderer.invoke('terminal:open', dir),
  // 本地调试（项目根目录 start.bat 探测 / 运行 / 生成模板）
  debugStatus: (dir) => ipcRenderer.invoke('debug:status', dir),
  debugRun: (dir) => ipcRenderer.invoke('debug:run', dir),
  debugGenerate: (dir) => ipcRenderer.invoke('debug:generate', dir),
  // ─── 一键部署模块（OneDeploy） ───
  deployProjectsList: () => ipcRenderer.invoke('deploy:projects:list'),
  deployProjectsSave: (p) => ipcRenderer.invoke('deploy:projects:save', toPlain(p)),
  deployProjectsRemove: (id) => ipcRenderer.invoke('deploy:projects:remove', id),
  deployProjectsCopyConfig: (args) => ipcRenderer.invoke('deploy:projects:copyConfig', args),
  deployDetectVersion: (project) => ipcRenderer.invoke('deploy:detectVersion', toPlain(project)),
  deployTestConnection: (projectId, targetId) =>
    ipcRenderer.invoke('deploy:testConnection', { projectId, targetId }),
  deployRun: (projectId, targetId) =>
    ipcRenderer.invoke('deploy:run', { projectId, targetId }),
  deployCancel: () => ipcRenderer.invoke('deploy:cancel'),
  deployReleases: (projectId, targetId) =>
    ipcRenderer.invoke('deploy:releases', { projectId, targetId }),
  deployRollback: (projectId, targetId, version) =>
    ipcRenderer.invoke('deploy:rollback', { projectId, targetId, version }),
  deployHistoryList: (projectId) => ipcRenderer.invoke('deploy:history:list', projectId),
  deployHistoryReadLog: (logFile) => ipcRenderer.invoke('deploy:history:readLog', logFile),
  deployHistoryClear: (projectId) => ipcRenderer.invoke('deploy:history:clear', projectId),
  // 更新内容：生成/重算通俗中文说明；为某次发布打 Git 标签
  deployHistorySummarize: (recordId, refresh) =>
    ipcRenderer.invoke('deploy:history:summarize', { recordId, refresh: refresh === true }),
  deployHistoryTag: (recordId, tag) => ipcRenderer.invoke('deploy:history:tag', { recordId, tag }),
  // 数据库备份（列表 / 一键恢复）
  deployDbBackups: (projectId, targetId) =>
    ipcRenderer.invoke('deploy:dbBackups', { projectId, targetId }),
  deployDbRestore: (projectId, targetId, fileName) =>
    ipcRenderer.invoke('deploy:dbRestore', { projectId, targetId, fileName }),
  // AI 部署助手：本地体检 / 服务器体检 / AI 方案 / 生成部署文件 / 套用方案
  deployAiScanLocal: (projectId) => ipcRenderer.invoke('deploy:ai:scanLocal', { projectId }),
  deployAiScanRemote: (projectId, targetId) => ipcRenderer.invoke('deploy:ai:scanRemote', { projectId, targetId }),
  deployAiDiagnose: (projectId, targetId) => ipcRenderer.invoke('deploy:ai:diagnose', { projectId, targetId }),
  deployAiWriteFiles: (projectId, files) =>
    ipcRenderer.invoke('deploy:ai:writeFiles', { projectId, files: toPlain(files) }),
  deployAiGenerateFile: (projectId, targetId, req) =>
    ipcRenderer.invoke('deploy:ai:generateFile', { projectId, targetId, req: toPlain(req) }),
  deployAiApply: (projectId, targetId, plan) =>
    ipcRenderer.invoke('deploy:ai:apply', { projectId, targetId, plan: toPlain(plan) }),
  onDeployLog: (cb) => subscribe('deploy:log', cb),
  onDeployStage: (cb) => subscribe('deploy:stage', cb),
  onDeployProgress: (cb) => subscribe('deploy:progress', cb),
  onDeployDone: (cb) => subscribe('deploy:done', cb),
  // 发布历史的更新内容在后台整理完成后推送，界面据此刷新
  onDeployHistoryUpdated: (cb) => subscribe('deploy:history:updated', cb),
  // ─── 一键填报模块（Git 提交 → 工时计划 → 禅道任务工时） ───
  fillPlan: (payload) => ipcRenderer.invoke('fill:plan', toPlain(payload)),
  fillSubmit: (payload) => ipcRenderer.invoke('fill:submit', toPlain(payload)),
  fillZtTasks: () => ipcRenderer.invoke('fill:ztTasks'),
  fillTestLogin: (opts) => ipcRenderer.invoke('fill:testLogin', toPlain(opts)),
  fillHpTest: (opts) => ipcRenderer.invoke('fill:hpTest', toPlain(opts)),
  fillBindings: () => ipcRenderer.invoke('fill:bindings'),
  fillBind: (projectId, taskId, taskName) =>
    ipcRenderer.invoke('fill:bind', { projectId, taskId, taskName }),
  fillUnbind: (projectId) => ipcRenderer.invoke('fill:unbind', projectId),
  // ─── DeepSeek Harness（内置 dsh web 服务） ───
  harnessStatus: () => ipcRenderer.invoke('harness:status'),
  harnessStart: (opts) => ipcRenderer.invoke('harness:start', toPlain(opts)),
  harnessStop: () => ipcRenderer.invoke('harness:stop'),
  harnessRestart: (opts) => ipcRenderer.invoke('harness:restart', toPlain(opts)),
  harnessOpenExternal: () => ipcRenderer.invoke('harness:openExternal'),
  onHarnessStatus: (cb) => subscribe('harness:status', cb),
  // 内置运行时更新：检查新版本 / 应用内热更新（进度经 harness:update 广播）
  harnessUpdateStatus: () => ipcRenderer.invoke('harness:updateStatus'),
  harnessUpdateCheck: (opts) => ipcRenderer.invoke('harness:updateCheck', toPlain(opts)),
  harnessUpdateInstall: (opts) => ipcRenderer.invoke('harness:updateInstall', toPlain(opts)),
  onHarnessUpdate: (cb) => subscribe('harness:update', cb),
})
