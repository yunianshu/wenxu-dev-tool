# 一键请假设计

## 实现

- `electron/italent-page.js` 封装在已登录北森页面中执行的接口请求。根据实时 `IndexPage` 元数据定位 `SearchForm`、`TableList`，保留本人过滤条件，更换日期条件后分页读取。使用 `FormView` 和 `Attendance.EveryVacationItems` 读取实时假种和余额，禁止固化用户编号、假种编号或签名（R1、R9）。
- `electron/italent-browser.js` 使用本机 Kimi Browser Extension 桥接，固定访问 loopback；独立会话串行操作北森标签页，在 `cloud.italent.cn` 校验来源后执行页面函数，浏览器保留登录状态，后台只接收必要业务字段（R9、R10）。
- `electron/leave-service.js` 提供纯计划计算以及内存中的待确认方案。首打卡先舍弃秒数；单次迟到超过 15 分钟必须请假：上班后 15 分钟内到岗优先消耗每月额度（5 次、50 分钟），额度不足改请 0.5 小时；08:46–09:15 请上班后 0.5 小时，09:00 后余量优先占用额度、不足时升级为覆盖到岗时刻的 1 小时；09:16–10:00 按到达时刻向上取整到半小时请 1/1.5 小时；晚于 10:00 阻断（R2、R5）。假种按调休 → 年假 → 事假/请假分配；调休按原始迟到分钟从长到短优先分配，短迟到留给年假/请假（R3、R4）。跨午休或特殊班次导致平台计算与预览不一致时阻止自动提交，由用户核对平台规则。
- 已审批中/已通过的请假、重叠申请和出勤备注均参与防重复；已有申请覆盖到请假块终点（或完整覆盖到岗时刻）即视为已覆盖。无法确定的重叠阻止该日。方案保存在后台内存，有效期 10 分钟；提交只接受后台方案 ID、确认标志，调用方不能替换报文。提交前重新读取并比较方案与可用余额，任何实质变化要求重新确认；执行中串行写入，异常立即中止并保留结果（R6–R9）。
- 增加侧栏「一键请假」和独立 Vue 页面，提供范围、上下班时间、事由、余额、明细及确认弹窗；执行状态存入共享 `state.leave`。Electron preload 统一生成 Tauri 桥接（R6、R10）。

## 接口证据

已在当前登录页面核实：

- `GET /api/v2/UI/IndexPage`、`POST /api/v2/UI/TableList`，查询参数必须带 app、metaObjName、viewName。
- 出勤字段 `SwipingCardDate`、`ActualForFirstCard`、`ActualForLastCard`、`DateType`、`RetroactiveRemark`，当天汇总状态可能尚未结算，不能仅凭“迟到”标签筛选。
- 请假字段 `VacationStartDateTime`、`VacationStopDateTime`、`ApproveStatus`、`RevocationStatus`、`DocumentType`。
- `GET /api/v2/UI/FormView`、`POST /api/v2/data/datasource` 的 `Attendance.EveryVacationItems` 返回假种及 `extAttr.Remain` 小时余额；年假用完后按 active 状态识别「事假」或「请假」作为兜底假种，该假种不设余额上限，平台校验拒绝时由当天阻断兜底。
- 请假表单指向 `/VacationDomainMRest/100000/AttendanceVacation/ApplyVacation`。正式提交使用 `application/x-www-form-urlencoded`，唯一表单字段 `dataObject` 的值为请假 JSON；只读的 `AgainVerify` 接口使用 JSON。原生请求同时携带 `navViewName`、按钮及来源视图参数，正式提交的 `checkRequired` 为 false，字段仅取表单绑定控件，排除 `_id`、`IsFirst` 等内部数据。已通过浏览器网络阻断捕获原生提交，并与修复后的请求逐项比较；没有向真实系统创建申请。

## 提交失败与恢复

- 浏览器页面通过结构化错误结果保留“明确未提交”状态，避免桥接丢失阶段信息。发送前失败、HTTP 身份/权限拒绝及明确业务拒绝不会永久锁定日期；网络中断、服务端异常或回查未确认仍保留待核对标记。
- 标记保留安全错误摘要；重新生成时，平台已存在的对应申请自动核销标记。旧标记没有错误摘要时明确显示旧版未记录错误。
- 增加 `leave:resolve`：只允许当前后台方案中的待核对记录，本人确认未发现对应有效申请后，后台再次核对本人、时段及重叠申请，解除本地标记。提交不足一分钟禁止解除；解除后生成新方案，正式申请仍走原有确认门。
- 浏览器会话按后台实例隔离，专属标签关闭后用新会话重新打开，避免桥接守护进程缓存已关闭标签；不会重试已发出的写入。

## 验证

- 纯函数：整点、秒数、临界半小时、跨日打卡、无打卡、休息日、午休、余额小数、混合假种、日期倒序和重复记录（R2–R5）。
- 服务隔离测试：未确认、伪造方案、过期、重复点击、重新核对变化、部分成功、结果不确定后禁止重发（R6–R8）。
- 页面适配器：元数据分页、所有者、错误响应、余额缺失及单位不支持、实际请求字段映射，模拟请求捕获提交（R1、R7、R9）。
- UI：构建及本地浏览器隔离场景，真实北森只读生成方案；后台双桥契约回归（R10）。
