# Tauri 架构迁移 ExecPlan

状态：Windows 实现与验证完成；macOS/Linux 真机验证待运行。开始：2026-09-23 10:02（Asia/Shanghai）。

## 目标与边界

实现 Tauri + Vue + 随包 Node 后台，完整保留现有桌面能力与用户数据，降低安装包体积。验收细则见 `.sdd/specs/tauri_migr/spec.md`。保护当前工作区中既有 `.gitignore` 修改及所有未跟踪文件。

## 已知证据

- 现有 1.4.92 Windows 安装器 158.96 MiB；解包目录 444.34 MiB，Harness 归档约 52 MiB。
- `electron/main.js` 注册约 98 个 IPC 处理入口；`electron/preload.js` 是前端 API 统一边界。
- Harness 通过 Electron 自带 Node 启动，换壳后必须提供兼容 Node 与平台原生依赖。
- 本机有 Rust 1.94/cargo 1.94；当前仓库尚无 Tauri 文件。

## 实施顺序

1. [完成] 固化验收与接口清单，建立可编译 Tauri 壳。
2. [完成初版] Node 后台与 Tauri IPC 连接，前端 API 适配。隔离后台冒烟验证 98 个入口已注册，配置/项目/Harness 状态可读取。
3. [完成 Windows 验证] 真实窗口、配置与项目增删、Git 工作进程扫描、PTY 往返、关闭询问和单实例均通过隔离验证；macOS/Linux 待 CI 验证。
4. [完成 Windows 验证] Harness 子 Webview、真实内置服务、全屏切换已通过；更新失败回滚合成测试通过；新凭据已接系统凭据库，Electron 旧密文需用户在设置页重新输入。
5. [完成 Windows 验证] 默认开发/构建和三平台 CI 已切换 Tauri。最终 Windows NSIS 85.38 MiB（旧版 158.96 MiB，约减少 46.3%）；macOS/Linux 尚未实际构建。
6. [完成 Windows 验证] 全套自测通过；从最终安装包解出的程序已确认 Harness 内嵌、圆角图标及关闭后主进程/服务端口清理。迁移与图标提交 `f53f74a` 已推送至 `main`。三平台 CI 需具有 Actions 权限的环境手动触发；当前 `gh` 未登录，尚无 macOS/Linux 实际构建结果。

## 本轮补充

- 应用图标仅给原有绿色底添加透明圆角，PNG/ICO 的 1024/256/128/64/48/32/24/16 尺寸校验通过，Tauri 平台图标同步生成。
- Windows 安装包解压后约 208.22 MB；旧版解包约 444.34 MiB。Tauri 版 Node 后台通过系统凭据库存储新凭据，Electron 旧密文保留但须在设置中重新输入。
- Windows 隔离环境中已验证项目、Git 工作进程、PTY 往返、Harness 内嵌与全屏、单实例、关闭及退出清理。macOS/Linux 真机运行与产物仍待 CI 或对应系统验证。

## 恢复方法

迁移过程中保留当前 Electron 构建链作为可运行基线；新构建未通过所有验收前不覆盖现有用户数据或发布版本。每阶段以文件和命令输出更新计划，不用阶段性成功替代完整验收。
