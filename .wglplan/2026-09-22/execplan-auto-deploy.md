# 自动正式发布实施进度

开始时间：2026-09-22（由会话代码计时）。规格见 .sdd/specs/autodeploy/。

- [x] 确认已有故障与 SecWatch 缺少部署文件。
- [x] 修复配置隔离、打包、版本与多模块识别。
- [x] 实现自动部署方案、远端准备及编排。
- [x] 接入正式服务器简表与一键发布。
- [x] 更新 README 与未发布更新日志；完成针对性回归、真实 Electron 界面验证及渲染构建。
- [x] 全量 25 个自测套件通过，最后补充的自动发布 10 组断言单独复核通过。
- [x] 完成代码审查与本地提交；推送为提交后的交付动作，实际结果以 Git 历史与会话交付说明为准。

约束：保留用户已有 .gitignore 和无关未跟踪文件；不执行真实生产操作。自动化无法推导外部密钥或取得 SSH 权限时明确列出缺项，不伪造成功。官方 Docker 仓库与固定 Compose 项目名依据 https://docs.docker.com/engine/install/ubuntu/ 和 https://docs.docker.com/compose/how-tos/project-name/。

验证证据：自动发布 10 组断言通过；真实 Bash 验证环境复用、项目名和全部容器健康；脚本发布 17 组断言通过；Electron 正式服务器保存与跨项目复制均通过；Vite 构建通过。使用已配置 AI 对 SecWatch 做只读方案生成，得到 Java 21 服务、Python 3.12 Worker、PostgreSQL 服务与运行变量，未经真实服务器安装或 Docker 构建验证。本机没有 Docker 运行环境，不能据此声称 SecWatch 已上线。

决策：自动安装仅支持 Ubuntu/Debian，其他 Linux 复用已安装环境；自动修复限制一次，不迁移生产数据；部署失败与回滚恢复失败如实区分。无需新发布版本或安装包，因此不改版本号、不打发布 tag。
