# Windows 脚本打包找不到 Maven

- 开始时间：2026-10-10 09:59（Asia/Shanghai）。
- 触发条件：桌面应用继承的 PATH 不含 Maven；项目打包脚本调用裸 `mvn`。
- 预期：打包子进程能使用本机已安装、已配置的 Maven；源项目和应用进程环境保持隔离。
- 实际：Vantage `package.sh: line 36: mvn: command not found`，退出码 1，未进入上传阶段。
- 项目路径：Node 后台 `electron/deploy/deploy-service.js` 在临时构建副本执行本地 shell 命令；现有 Git Bash 选择逻辑只补 Bash，不刷新工具链 PATH。
- 本机证据：Maven 3.9.9 已安装，当前终端 `mvn -version` 成功；用户持久 PATH 含 Maven/bin，机器 MAVEN_HOME 为空。
- 检索策略：限定部署模块的结构检索，关键词 `localShellEnv`、`runPackageCommand`、`PATH`、`MAVEN_HOME`。候选收敛到 deploy-service 的环境构造，无需跨模块重构。
- 最小复现：从子进程环境移除 Maven PATH 和 Maven HOME，通过真实 `localShellEnv` 启动 Git Bash 调用 `mvn -version`。修复前应失败，补全持久配置后同输入应成功。
- 根因评级：confirmed（隔离动态复现）。旧实现执行同一输入输出 `MINGW64_NT-10.0-26300` 和 `mvn: command not found`，退出码 127；修复后输出 Maven 3.9.9、Java 17.0.19，退出码 0。未读取用户应用进程内存，未断言其实际 PATH。
- 修复边界：只为打包子进程读取当前 Windows Path/JAVA_HOME/MAVEN_HOME/M2_HOME；保留有效继承配置及已有 PATH 优先级，补齐工具目录；不安装软件、不更改系统设置、不写入生产服务器。
- 验收：窄 PATH 真实 Maven 调用成功；HOME 工具路径含空格可执行；环境键大小写规范化；非 Windows 不改 PATH；部署相关自测通过。
- 流程裁剪：定位、实现与验证集中在本文件和对应回归测试，不生成无关规格、图表或发布产物。
- 已通过：真实 Maven 3.9.9 的窄 PATH 修复前后对照；Git Bash/Maven fixture 的 PATH、HOME 优先级、中文空格目录、键大小写、去重、变量展开、读取失败降级与 cwd 回归；Java HTTP 初始化及 TEMP/TMP 隔离、工作区受限清理；构建副本复制回归；基础部署自测 50/50、脚本部署集成自测 18 组；Node 语法及 Git 差异检查。
- 测试环境：直接运行两项旧部署自测时系统 WSL Bash 接管 Windows 路径，产生路径识别失败；按现有聚合入口前置 Git Bash 后，两项均通过。
- 限制：当前持久配置只读取四个构建相关键。新注册表变量如 `TOOLS_ROOT` 若仅被 PATH 间接引用且不在继承环境内，尚不支持发现；本次 Maven 使用直接路径，不受影响。未重跑 Vantage 完整构建或操作正式服务器。
