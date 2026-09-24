# 实现设计

- `electron/knowledge-service.js`：userData/knowledge 下每条记录一个 UUID.md，YAML 元数据 + Markdown 正文；原子落盘，revision 防止迟到覆盖，软删除。
- `electron/main.js`/`preload.js`：同一套 IPC；生成 Tauri bridge，Node 后台直接复用主进程服务。
- `useKnowledge`：应用级记录缓存和按 ID 串行自动保存；切页保留未保存文本，保存期间继续编辑采用最新修订；失败保持草稿并允许重试。
- `AIWorkbenchView`：工作视图 / 搜索筛选 / 紧凑记录表 / 按需编辑或 AI 面板。项目详情通过同一数据源打开记录。
- `KnowledgeEditor`：元信息、Markdown 编辑预览、模板、来源、回收站恢复。
- `KnowledgeAnalysis`：输入目标、明确来源、流式分析、停止、编辑结果、保存草稿；使用现有 AI IPC 与配置，不触碰密钥。
- 原有 AI 与报告页面移除；保留填报依赖、旧历史文件和公用导出功能。

## 验证

真实临时目录测试存储、修订冲突、路径边界、导入导出、坏文件隔离；前端保存竞态测试；AI 提示与停止测试；隔离浏览器测试增改删恢复、项目关联、主题/尺寸、AI 保存及填报回归；渲染构建。
