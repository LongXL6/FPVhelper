# FPVHelper 训练工作台

FPVHelper 是面向 FPV 俱乐部的训练量化工作台：在本机观察 HDMI 画面与遥控输入，按选手代号保存训练 Session，帮助教练形成可复核的训练台账。它不是赛事计时认证系统，也不替代俱乐部现有 DVR。

## 当前能力

- 通过浏览器 `getUserMedia` 打开 UVC HDMI 采集卡，并只在本机显示画面。
- 左右摇杆可叠加在视频画面上，布局只保存在当前浏览器。
- 通过 Web Serial 连接独立的地面桥接飞控，以只读 MSP v1 请求轮询 Betaflight：
  - `MSP_RC`：Roll / Pitch / Yaw / Throttle 与已解码的 RC 通道。
  - `MSP_ANALOG`：地面桥接飞控电压与 legacy RSSI；该值不是机上 ELRS LQ。
- 真实串口链路在线且填写选手代号后，才能开始训练 Session；草稿和已完成记录保存在本机 IndexedDB，并可导出 schema v2 JSON。
- 未连接硬件时可使用明确标记的演示数据；演示数据不计入试点生产记录。
- 不写入 Betaflight 配置，不录制或上传视频，不上传原始 RC 打杆样本。

## 产品与入口口径

- 产品名统一为“FPVHelper 训练工作台”，价值口径统一为“俱乐部训练量化”。
- 客户规范入口定为 `race.fpvsuperapp.com`。
- `helper.longxl.com` 仅用于团队内部完整验证；其验证记录不得计入生产使用统计或试点验收数据。
- 上述是发布规则，不证明 DNS、Vercel、证书、Supabase 或生产发布当前已经完成；这些状态必须按 [`docs/release-process.md`](docs/release-process.md) 逐项核验。

## 信号路径

```text
FPV Camera → Air Unit / VTX → HDMI Receiver → UVC Capture Card → Browser Video

Pilot Radio → 该选手预绑定的 Ground ELRS RX → 该选手独立 Bridge FC → USB MSP → FPVHelper
```

每位选手使用独立、预绑定的地面 `Bridge FC + ELRS RX` 套件；换人按 [`docs/ground-rx-handoff-sop.md`](docs/ground-rx-handoff-sop.md) 更换整套地面桥，不在训练现场共享接收机并临时重绑。桥接飞控不得连接 ESC 或电机。

浏览器无法直接读取电脑的 HDMI 端口；HDMI 接收端必须以 UVC 视频设备出现。推荐在桌面版 Chrome 或 Edge 中通过 HTTPS 或 `localhost` 使用。

## 离开本机的数据

| 数据 | 是否离开本机 | 目的地与用途 | 状态 / 关闭方式 |
| --- | --- | --- | --- |
| 视频帧、DVR 原片 | 否 | 仅本机实时显示；DVR 由俱乐部控制 | 永不由 FPVHelper 上传 |
| 原始 RC 通道与 20 Hz 样本 | 否 | 本机 IndexedDB；由操作员手动导出本地 JSON | 永不自动上传 |
| 选手代号、教练备注 | 否 | 仅本地 Session JSON 与线下台账 | 不进入产品统计 |
| 假名化产品使用统计 | 条件式 | 同域 Vercel Route Handler → 独立 FPVHelper 境外 Supabase，用于连接、错误和 Session 覆盖率诊断 | 尚需独立云项目、实现验收与书面确认；确认前关闭；上线后须支持 `?analytics=off` |

假名化统计只允许随机工作站 ID、白名单事件、枚举环境类别、分类错误码、Session 时长与样本数等摘要；禁止姓名、选手代号、原始 UA、设备名、串口名、原始错误文本、视频、原始 RC 与 Binding phrase。不得引入第三方 analytics SDK。

### 统计工作站登记

独立 FPVHelper analytics Supabase、Vercel server-only 配置、客户规范域、书面确认与工程验收任一未完成时，生产统计保持关闭，不生成、不登记、不安装 token。配置完成后，页面在 `waiting_token` 状态显示可复制的完整随机 workstation UUID；复制不会启用或发送统计，该 ID 也作为本地 Session JSON 的工作站台账身份，关闭统计不会删除它。

管理员只使用仓库内 CLI 生成登记材料：

```bash
npm run analytics:token -- issue  --workstation-id <UUID> --club-code <CODE>
npm run analytics:token -- rotate --workstation-id <UUID> --club-code <CODE>
npm run analytics:token -- revoke --workstation-id <UUID> --club-code <CODE>
```

CLI 不连接数据库、不接收 secret/数据库 URL/现有 token 参数。`issue`/`rotate` 生成 256-bit token，明文仅在私密终端显示一次；SQL/JSON 只包含 SHA-256 hash。完整的生成→登记→安装→验证→轮换/撤销流程见 [`docs/analytics-provisioning-runbook.md`](docs/analytics-provisioning-runbook.md)。

### Session JSON 保管

- `athleteCode` 和 `notes` 是假名化训练数据，不是匿名数据；知道线下映射的人仍可识别选手。
- JSON 只保存在俱乐部授权目录，文件名和备注不写真实姓名、电话或其他身份信息。
- 监护人同意编号只放线下台账，不写入 JSON；代号映射表与 JSON 分开保管、分别授权。
- 试点结束、撤回同意或收到删除请求时，按双方书面规则处理；模板不是法律意见。

## 本地运行

需要 Node.js `>=24`，与 `package.json` 和 CI 保持一致。

```bash
npm ci
npm run dev
```

打开 `http://localhost:3000`。点击“打开画面”选择 HDMI 采集卡，点击“连接桥接飞控”选择 Betaflight USB 串口。

如果 Betaflight Configurator 或其他程序占用串口，请先断开该程序。连接地面桥时先确认飞行器已拆桨；FPVHelper 本身只发送读取请求，但设备操作仍按现场安全流程执行。

## 数据边界

- `遥控油门` 是接收机传入桥接飞控的 RC 指令，不是电机输出。
- 桥接飞控不接 ESC/电机，因此不读取或展示 `MSP_MOTOR`。
- `MSP_ANALOG` 的 legacy RSSI 与桥接飞控电压只属于地面桥，不能标成机上 ELRS LQ 或飞行器电池电压。
- Session 使用 `performance.now()` 单调时钟记录 RC 样本；视频不进入 JSON，也没有帧级时间戳校准。
- 人工 Marker 只用于定位 DVR 复盘时刻；视觉计圈是独立实验，见 [`docs/vision-lap-experiment.md`](docs/vision-lap-experiment.md)。

硬件取值边界见 [`docs/hardware-architecture.md`](docs/hardware-architecture.md)，试点流程见 [`docs/pilot-runbook.md`](docs/pilot-runbook.md)。

## 文档导航

- 发布与版本：[`docs/release-process.md`](docs/release-process.md)、[`docs/CHANGELOG.md`](docs/CHANGELOG.md)
- 试点运营：[`docs/pilot-runbook.md`](docs/pilot-runbook.md)、[`docs/workstation-install-checklist.md`](docs/workstation-install-checklist.md)、[`docs/coach-interview.md`](docs/coach-interview.md)
- 硬件与换人：[`docs/hardware-kit.md`](docs/hardware-kit.md)、[`docs/ground-rx-handoff-sop.md`](docs/ground-rx-handoff-sop.md)、[`docs/templates/hardware-acceptance-record.md`](docs/templates/hardware-acceptance-record.md)
- 训练与对表：[`docs/templates/training-ledger.md`](docs/templates/training-ledger.md)、[`docs/dvr-alignment.md`](docs/dvr-alignment.md)
- 数据与同意：[`docs/quote-data-appendix-draft.md`](docs/quote-data-appendix-draft.md)、[`docs/templates/guardian-consent-template.md`](docs/templates/guardian-consent-template.md)
- 统计登记：[`docs/analytics-provisioning-runbook.md`](docs/analytics-provisioning-runbook.md)
- 实验与协作：[`docs/vision-lap-experiment.md`](docs/vision-lap-experiment.md)、[`docs/development/agent-worktree-workflow.md`](docs/development/agent-worktree-workflow.md)
- 实施规格与商业设计底稿：[`strategy-review-2026-08-31.md`](docs/designs/strategy-review-2026-08-31.md)、[`analytics-tracking-plan.md`](docs/designs/analytics-tracking-plan.md)、[`fpv-club-pricing-license.md`](docs/designs/fpv-club-pricing-license.md)

## 检查

```bash
npm run check
npm run build

# 需要 Docker；只启动本地 Postgres，不连接线上 Supabase。
npx supabase@2.108.0 db start
npx supabase@2.108.0 test db --local supabase/tests
npx supabase@2.108.0 stop --project-id fpvhelper --no-backup --yes
```
