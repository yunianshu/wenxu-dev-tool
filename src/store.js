import { reactive } from 'vue'

/** 跨视图共享状态 */
export const state = reactive({
  /** 个人项目：AI、活动报告与部署共享的统一上下文 */
  projects: {
    items: [],
    currentId: '',
    loading: false,
  },
  /** 扫描发现的全部仓库（含 info，跨视图保留） */
  discoveredRepos: [],
  /** Git 扫描全局状态（启动预热/手动扫描共用，工作台实时展示进度） */
  scan: {
    scanning: false,    // 目录扫描进行中（预热或设置页手动扫描）
    scanned: 0,         // 已检查目录数
    collecting: false,  // 启动预热：预收集今日提交进行中
    collectDone: 0,
    collectTotal: 0,
  },
  /** 应用配置 */
  config: {
    roots: [],
    excludes: [],
    identities: [],
    ai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      temperature: 0.7,
    },
    zentao: {
      baseUrl: '',
      account: '',
      workStart: '08:30',
      lunchStart: '12:00',
      lunchEnd: '13:00',
    },
    hanprint: {
      baseUrl: '',
      clientId: '1',
      account: '',
    },
    /** 内置 DeepSeek Harness 本地服务（端口 / 是否随应用自动启动 / 进入时是否全屏） */
    harness: {
      port: 3080,
      autoStart: true,
      fullscreen: false,
    },
  },
  /** 应用外壳状态：沉浸全屏由主进程窗口全屏驱动（Harness 视图铺满整屏时隐藏侧栏/顶栏） */
  ui: {
    fullscreen: false,
    /** 侧栏是否收起（收起后只显示图标）。纯外观偏好，由主进程 ui-prefs.json 持久化 */
    sidebarCollapsed: false,
    /** 外壳（含顶栏插槽）是否已挂载进文档。初始挂载期间根元素还没进 document，
     *  document.querySelector 找不到顶栏插槽，投递页头的 Teleport 会失败 */
    shellMounted: false,
  },
  /** 报告生成过程（跨视图保留，切换 tab 不中断） */
  report: {
    phase: 'idle', // idle | scanning | collecting | done
    scanProgress: { scanned: 0 },
    collectProgress: { done: 0, total: 0 },
    rawCommits: [],
    /** rawCommits 实际对应的收集范围（until 为排他上界）。报告页与 AI 页共用
     *  rawCommits，展示、复制与导出必须以此范围为准，避免数据与标题错标 */
    collectedRange: null, // { since, until, repoPaths: string[] }
  },
  /** 内置 Harness 运行时更新：dsh 新版本提示与应用内热更新进度 */
  harnessUpdate: {
    checking: false,
    current: '',            // 当前运行时的 dsh 版本
    latest: '',             // 源上的最新版本
    updateAvailable: false,
    canUpdate: false,       // 当前形态是否允许热更新（开发态/自定义运行时目录不允许）
    reason: '',             // 不允许时的原因
    error: '',
    busy: false,
    install: { status: 'idle', version: '', fetched: 0, packages: 0, elapsedMs: 0, error: '' },
  },
  /** 终端工作台（内嵌多窗格终端）：跨视图只保留轻量标记，
   *  窗格与会话列表在视图内维护，pty 进程本身在主进程常驻 */
  terminal: {
    /** 当前聚焦窗格对应的项目（用于顶栏/其他页面展示上下文） */
    focusedProjectId: '',
    /** 从项目页跳转过来时要聚焦的项目（视图挂载时消费一次） */
    pendingFocusProjectId: '',
  },  /** AI 聊天状态（跨视图保留，切换 tab 不丢失对话） */
  chat: {
    messages: [], // [{ role: 'user'|'assistant', content }]
    streaming: false,
  },
  /** 一键部署（OneDeploy）运行状态（跨视图保留，切换 tab 不中断进度/日志） */
  deploy: {
    projects: [],
    currentProjectId: '',
    running: false,
    stages: {}, // { check: { status, durationMs }, ... } status: waiting|running|success|failed|skipped|rollback
    logs: [], // [{ level, text, ts }]
    packageCount: 0,
    uploadPercent: 0,
    datasyncPercent: 0, // 数据同步阶段上传进度
    currentVersion: '', // 服务器当前运行版本（查询 releases / 发布事件更新）
    startedAt: 0, // 本次发布/回滚开始时刻（渲染层计时用；切换项目或换版本时清空）
    finishedAt: 0, // 本次发布/回滚结束时刻（done 事件写入，0 表示尚未结束）
  },
  /** 一键填报（禅道工时）状态（跨视图保留，切换 tab 不丢计划） */
  fillReport: {
    plan: null, // 最近一次 fill:plan 结果（planned/tasks/bindings 等）
    date: '', // 填报日期 YYYY-MM-DD
    startTime: '', // 实际上班时间 HH:MM（空则用设置页默认）
    endTime: '', // 下班/加班结束时间 HH:MM（空则取点击生成报告的时刻；早于上班时间按次日跨夜）
    selectedIds: null, // 所选填报项目 id 数组；null=尚未选择过（首次进入按已绑定项目自动选中）
    running: false, // 生成/提交进行中
    submitting: false,
  },
})
