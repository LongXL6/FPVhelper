@AGENTS.md

# FPVHelper 项目口径

- 产品名：FPVHelper 训练工作台。
- 核心价值：俱乐部训练量化；不是赛事计时认证产品。
- 客户规范入口：`race.fpvsuperapp.com`。
- `helper.longxl.com`：仅内部完整验证，事件和 Session 不计入生产统计或试点验收。
- 域名、Vercel、Supabase、硬件、收款和客户同意状态都必须从各自真相面重新核验，不能由代码或文档推断为已完成。

# 硬件与数据边界

- 每位选手使用独立、预绑定的地面 Bridge FC + ELRS RX 套件。
- Dashboard 只读 `MSP_RC` / `MSP_ANALOG` / `MSP_STATUS_EX`，并允许一次性可选名称读取 `MSP_API_VERSION` / `MSP_NAME` / `MSP2_GET_TEXT`（仅 Pilot/Craft 类型）；以 `lib/telemetry.ts` 和 `lib/betaflight-device-name.ts` 的受限请求构造器为准，不得写 Betaflight；桥接飞控不得连接 ESC 或电机。
- 地面 bridge RSSI 不是机上 ELRS LQ，桥接飞控电压不是飞行器电池电压。
- 视频与原始 RC 样本永不上传；Session JSON 保存在本机并由操作员导出。
- 选手代号与备注是假名化数据。代号映射和监护人同意编号留在线下台账，不进入 JSON 或产品统计。

# 统计与云端约束

- 统计链路只允许：浏览器 → 同域 Vercel Route Handler → FPVSuperApp 拥有的受限摄入入口 → 共享 Supabase 的 FPVHelper 专属命名空间。
- FPVSuperApp 仓库拥有生产 migration；本仓库现有 analytics migration 只作本地验证和迁移设计参考，不得直接执行到共享云项目。
- FPVHelper Vercel 不得持有共享项目的 `sb_secret_...` 或旧 `service_role`；受限摄入路径、书面确认和工程验收完成前，生产统计保持关闭。
- 当前可见的 LONGWEBSITE 项目不得用于 FPVHelper；必须从 FPVSuperApp 真实配置重新确认 project ref。
- 只允许假名化工作站 ID、白名单事件、枚举环境类别、分类错误码与数值摘要；禁止原始错误文本、姓名、选手代号、设备名、串口名、原始 UA、视频、原始 RC 和 Binding phrase。
- 禁止引入第三方 analytics SDK、autocapture 或 session replay。

# 发布纪律

- 功能分支经 PR、独立审查和本地完整门禁后才可合并 main。CI 保留为补充证据；账户/计费造成的 `steps: []` pre-runner 失败不阻塞试点，但真正执行后的代码/测试失败仍是阻断项。
- Preview 验收通过后才能 Promote；生产核验通过后才创建与 `package.json` 一致的 `vX.Y.Z` tag。
- `/version.json` 和版本检查 hook 已接入 Dashboard 的升级提示与页脚版本；仍需在真实 Preview/生产域核验后才能宣称发布识别生效。
- 发布证据按本地、CI、PR、合并、Preview、Promote、生产页面、真机与业务验收分层报告。
