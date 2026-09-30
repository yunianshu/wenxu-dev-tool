# 项目工作台设计

规则 1：新增 WorkOverviewView，dashboard 对应首页，knowledge 对应原知识视图。
规则 2：复用 terminalList、deployHistoryList、useKnowledge。useWorkOverview 定时刷新，卸载停止并丢弃晚到响应。ProjectWorkStatus 共用真实状态。
规则 3：App 集中处理带 projectId 的导航，复用 selectProject 与 pendingFocusProjectId；知识库沿用项目筛选与创建逻辑。顶栏提供返回项目。
规则 4：不修改知识存储与自动保存。界面 E2E 覆盖项目上下文与原有知识流程，以及两种主题和窗口大小。
