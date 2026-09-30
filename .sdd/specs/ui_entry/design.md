# 操作入口收敛设计

对应规格 1：AIWorkbenchView 删除正常新建入口，createRecord 仅供错误草稿另存；IdeaGlobe 移除 browse 事件及按钮。ProjectKnowledge 只展示关联记录并支持点击打开，不再单独新建或跳转空列表。

对应规格 2—3：ProjectsView 保留详情编辑、删除和项目上下文快捷操作，删除列表双击/右键及重复能力卡片；ExtensionsView 统一使用每行操作菜单，删除双击/右键/选中栏及相关事件状态。DeployConfigDrawer 服务器管理统一到部署页头；更新日志统一到侧栏版本号；Harness 更新统一到页头。

对应规格 4—5：不改业务 API、数据格式或自动保存；提示通过文字指明全局导航。既有桌面 E2E 改用保留入口并增加重复入口缺席断言；构建和相关知识、项目、扩展/部署已有测试按影响验证。
