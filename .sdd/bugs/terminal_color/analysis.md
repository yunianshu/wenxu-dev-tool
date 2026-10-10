# 终端工作台 PowerShell 颜色丢失

- 开始时间：2026-10-10 14:37（Asia/Shanghai）。
- 预期：终端工作台保留 PowerShell 正常显示的文字颜色，包括输入语法着色与带色输出。
- 实际：用户报告内嵌终端丢失外部 PowerShell 中正常显示的颜色，具体命令尚未提供。
- 复现前提：Windows、真实 node-pty / ConPTY、项目当前的 PowerShell 启动参数。
- 代码路径：`electron/pty-service.js` 创建 shell 与广播原始输出；`src/components/TerminalPane.vue` 将原始输出批写到 xterm。
- 当前证据：未发现输出颜色过滤；PowerShell 用 `-NoExit -EncodedCommand` 安装目录上报 prompt；当前诊断进程继承 `NO_COLOR=1`、`TERM=dumb`。
- 候选根因：带启动命令的 PowerShell 未自动导入 PSReadLine；非终端宿主环境中的禁色变量被 PTY 继承。两者均需真实执行确认。
- 最小复现：对比普通交互 PowerShell 与工作台启动参数的模块状态、输入语法颜色和 `Write-Host -ForegroundColor` 输出颜色；同时控制 `NO_COLOR` 等环境变量。
- 验收：输入着色与显式带色输出经过真实 PTY 和 xterm 后保留；目录上报、会话重用、回放和用户 profile 行为不受影响。

本任务采用有范围的诊断记录和真实复现证据，不增加无关项目文档、发布流程或图表。

## 复现证据

- 修改生产代码前运行 `node scripts/terminal-workbench-selftest.cjs`：46 项通过，新增的 3 项颜色回归断言失败（子 shell 禁色状态、实时绿色 ANSI、attach 回放绿色 ANSI）。
- 真实 ConPTY 对照：普通交互和工作台 `-EncodedCommand` 启动均已加载 PSReadLine，VT 支持为 true；继承 `NO_COLOR` 时 PowerShell 输出模式为 `PlainText`，清除后为 `Host`，绿色输出恢复 `ESC[38;5;10m`。
- 结论为 `confirmed`：颜色在 PowerShell 输出前已被禁用，xterm、广播和缓冲未剥离颜色。启动参数没有导致 PSReadLine 缺失。

## 修复与验证

- `electron/pty-service.js` 为真实 PTY 创建独立环境副本，仅移除继承的 `NO_COLOR`（Windows 兼容变量名大小写），保留父进程环境和用户 profile。
- 修复后运行同一自测：49 项通过 / 0 项失败，覆盖绿色输出实时转发和 attach 回放、目录上报、独立窗格、会话关闭与布局。
- `node scripts/terminal-color-e2e.cjs`：10 项全部通过（2026-10-10 14:43，22.9 秒）。真实隐藏 Electron → PowerShell → IPC → xterm：红绿输出分别为 `rgb(239, 41, 41)` / `rgb(138, 226, 52)`；命令与字符串输入分别为黄 / 青；切页回放颜色及 sessionId / PID 保持一致；父进程 `NO_COLOR=1` 未修改；渲染错误为 0。
- E2E 初次窗口隐藏 bootstrap 使用不可替换的 Electron getter，已改为测试专用 module shim；之后窗口计数断言错误已根据实际生命周期修正为创建次数与 show 事件计数。最终验证窗口创建 1 个、可见事件 0 次。
- `npm run build:renderer` 通过；现有语法自测通过（282 个脚本及 1 份打包产物 main.js）；最终任务脚本独立 `node --check` 和 `git diff --check` 通过。
- 受控六组探针在 `repro-before.json`；PowerShell 5.1 两组均正常带色，PowerShell 7 两种启动方式仅随禁色变量改变。
- 相关行为与测试入口已更新 README，修复说明已写入 CHANGELOG 的「未发布」。没有发布版本或更新已安装应用；新构建需要重新创建终端会话才能使用新的环境。
