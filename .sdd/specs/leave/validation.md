# 一键请假验证记录

> 后续真实试用发现正式提交格式与原生表单不符，已修复并更新 PC 安装版。最新的 25 组回归、原生请求拦截对照及旧标记恢复验证见 [提交修复验证](../../bugs/leave-submit/validation.md)；真实请假仍由用户确认提交。

- 开始时间：2026-10-15 14:02:25（上海时区）。
- 最终结束时间：2026-10-15 14:38:36（上海时区）；耗时 36 分 11 秒。
- 真实请假提交数：0。真实页面只用于读取、表单联动计算和提交前校验。

## 已通过

- `node scripts/leave-selftest.cjs`：20 组业务和接口断言，覆盖分钟截断、半小时边界、倒序、混合假种、余额不足、重复覆盖、确认门、账号切换、变化重确认、写入中断和结果待核对。
- `node scripts/leave-ui-selftest.cjs`：真实 Vue setup 验证生成不写入、未打开确认弹窗不提交、重复点击互斥、切页执行状态保持、已使用方案不可重发、编辑后方案失效。
- `node scripts/knowledge-rpc-selftest.cjs`：Electron preload 与生成的 Tauri bridge 经真实后台 RPC 验证日期校验、确认门；请求均为隔离输入，不访问北森写入。
- `npm run build:renderer`、`git diff --check`：通过。构建仅有原有第三方 PURE 注解与静态/动态混合导入提示。
- 隔离浏览器页面：生成方案、打开确认框、取消时写入次数均为 0；确认后模拟写入次数为 1；1280px 与 1920px 页面无横向溢出。
- 北森真实只读：15 天出勤，6 天已有申请覆盖，1 天可申请 1 小时调休；平台表单计算与方案一致。
- 用户补充的分钟边界：30 分 59 秒先舍弃秒数，终点取 09:00，计 0.5 小时；31 分钟计 1 小时。纯计算、重复覆盖、拆分和表单输入均已验证；真实北森只读表单也确认 08:30–09:00 为 0.5 小时。

## 全量回归的阻塞

`npm test` 已运行结束，退出码 1，报告 5 个套件失败。请假专项、界面专项、填报专项、UI 状态、Electron/Tauri RPC 和 Tauri 存储检查均通过。按项目 `AGENTS.md` 的“验证失败停止提交”要求，保留修改，未暂存、提交或推送：

- `deploy-image-prepull-selftest.cjs`：真实 Git Bash 子进程 20 秒超时；单独复跑也出现超时及临时目录 EPERM。
- `deploy-datasync-selftest.cjs:197`：“应解压覆盖到配置的 remoteDir”断言失败，单独复跑一致。
- `deploy-release-notes-selftest.cjs:265`：发布记录的提交号为 undefined，单独复跑一致。
- `harness-selftest.cjs`：原有套件报告 1 项失败，未修改其代码。
- `terminal-workbench-selftest.cjs`：真实 pty 套件报告 47 通过、2 失败，未修改其代码。

上述源文件与对应测试均未修改；保持当前任务范围，记录失败证据供后续处理。请假专项、填报专项和相关 RPC 已通过。

## 本机 PC 客户端交付

- 根据用户补充要求，完成 Windows Tauri 原生客户端构建、NSIS 安装及安装版实测；本次为本机更新，版本保持 1.4.122。
- 安装目标：`C:/Users/Administrator/AppData/Local/Personnel PLM/personnel-plm.exe`。
- 本次安装包：`src-tauri/target/release/bundle/nsis/Personnel PLM_1.4.122_x64-setup.exe`；旧安装包已保留至 `release/local-leave-20261015-1444/`。
- 本次安装包 SHA256：`4C7F94DEAC8A1936E1FAE7F6C917199028490FF5212EA4BAF7FCA96202F173CD`。
- 关键请假后台资源与工作区文件 SHA256 一致；3 个现有个人配置文件在安装前后哈希一致。
- 安装版 Tauri 窗口中，侧栏「一键请假」、页面、三项后台桥接均存在；真实只读获取 15 天出勤；未确认提交被拒绝；核对弹窗可取消；真实请假提交数为 0。
- 隔离本机测试已退出，已按原有用户数据正常重新打开客户端；没有保留调试端口启动参数。
- PC 页面截图：`release/local-leave-20261015-1444/pc-leave.png`。
- 本机交付耗时：约 8 分钟。已确认正常用户配置的主窗口显示为 Personnel PLM 并响应；原有全量回归阻塞未改变，未执行 Git 提交或推送。

## 2026-10-22 迟到规则更新

- 规则口径：每笔请假固定覆盖上班后 0.5 小时（默认 08:30–09:00）；09:00 后最多再迟到 15 分钟；到岗超过 09:15 或晚于 10:00 阻断；每个自然月最多 5 次，09:00 后余量合计 ≤50 分钟。
- 假种顺序：调休（优先给原始迟到较长的日期）→ 年假 → 事假/请假（不设余额上限）。已有申请覆盖到请假块终点即视为已覆盖。
- `node scripts/leave-selftest.cjs`：33 组通过，新增固定 0.5 小时、09:15/10:00 边界、每月 5 次与 50 分钟上限、调休长迟到优先、事假兜底以及部分覆盖阻断断言。
- `node scripts/leave-ui-selftest.cjs`、`node scripts/knowledge-rpc-selftest.cjs`、`npm run build:tauri:renderer`：通过。
- 未连接真实北森提交；本次验证未创建任何请假申请。

## 2026-10-22 迟到规则二次修订（1.4.141）

- 最终口径：单次迟到超过 15 分钟必须请假。08:30–08:45 到岗走每月额度（5 次/50 分钟）不申请，额度不足改请 0.5 小时；08:46–09:00 请 0.5 小时；09:01–09:15 请 0.5 小时且余量计入额度，额度不足升级为 1 小时；09:16–10:00 按到达时刻请 1/1.5 小时；晚于 10:00 阻断。
- `node scripts/leave-selftest.cjs`：34 组通过，重写迟到分层、额度上限与升级断言；`leave-ui-selftest`、`knowledge-rpc-selftest`、`build:tauri:renderer` 通过。未创建真实请假。
