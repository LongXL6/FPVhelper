# FPVHelper 训练工作台

FPVHelper 是面向 FPV 俱乐部的训练量化工作台：在本机观察 HDMI 画面与遥控输入，按选手代号保存训练 Session，帮助教练形成可复核的训练台账。它不是赛事计时认证系统，也不替代俱乐部现有 DVR。

## 当前能力

新版界面按「飞行工作台 / 训练记录 / 工作站设置」组织，完整保留多视频、选手绑定、原 100 Hz 采集目标、本地录像与可靠导出。当前设计见 [UI 系统](docs/designs/ui-system.md)，功能保留与后续重构见 [集成审查](docs/designs/integration-review-2026-09-04.md)。

遥控数据能分析什么、长期采集与归档如何演进，见 [数据分析与保存方案](docs/designs/telemetry-analysis-plan.md)；该方案与已实现能力分别标注。

- 通过浏览器 `getUserMedia` 打开 UVC HDMI 采集卡；可录制当前选手绑定的完整或裁切画面，将左右摇杆、刻度、选手代号和输入状态烧录进本地 WebM，并把原始打杆 JSON 保存到同一授权目录。
- 预览中的左右摇杆支持拖动、缩放与布局保存；录像使用独立的固定叠层，不依赖预览叠层是否显示。
- 通过 Web Serial 连接独立的地面桥接飞控，以只读 MSP v1 请求轮询 Betaflight：
  - `MSP_RC`：目标 100 Hz 轮询 Roll / Pitch / Yaw / Throttle 与已解码的 RC 通道；实际有效频率取决于飞控、USB、浏览器与工作站负载。
  - 历史与尾迹每 5 个有效 RC 帧追加，目标 20 Hz；原始记录逐帧订阅，界面显示最近 1 秒实际接收帧数。
  - `MSP_ANALOG`：地面桥接飞控电压与 legacy RSSI；该值不是机上 ELRS LQ。
- 真实串口链路在线且填写选手代号后，才能开始训练 Session；IndexedDB v2 分块追加保存，每秒尝试一次检查点，显示已经事务确认的帧数与时间。历史列表读取摘要，详情按需读取；导出继续使用兼容旧文件的 schema v2 JSON。
- 未连接硬件时可使用明确标记的演示数据；演示数据不计入试点生产记录。
- 不写入 Betaflight 配置，不上传视频，也不上传原始 RC 打杆样本；本地 WebM 录像默认关闭，必须由操作员明确开启并授权目录。

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
| 视频帧、本地 WebM、DVR 原片 | 否 | 实时画面与可选 WebM 仅写入操作员授权的本地目录；俱乐部仍控制正式 DVR | FPVHelper 永不上传；关闭“录制视频与摇杆叠层”即可只看不录 |
| 原始 RC 通道与高频样本 | 否 | 本机 IndexedDB；手动导出或按设置自动保存本地 JSON，开启录像时一并保存到授权目录 | 永不自动上传 |
| 本机诊断 JSON / 原始串口夹具 | 否 | 操作员主动下载到本机，用于状态排查与 MSP parser 回归 | 不自动采集或上传；原始 `.bin` 最长 60 秒、内存上限 8 MiB |
| 选手代号、教练备注 | 否 | 仅本地 Session JSON 与线下台账 | 不进入产品统计 |
| 假名化产品使用统计 | 条件式 | 同域 Vercel Route Handler → FPVSuperApp 受限摄入入口 → 共享 Supabase 的 FPVHelper 专属命名空间，用于连接、错误和 Session 覆盖率诊断 | 尚需共享项目迁移、最小权限摄入、实现验收与书面确认；确认前关闭；上线后须支持 `?analytics=off` |

假名化统计只允许随机工作站 ID、白名单事件、枚举环境类别、分类错误码、Session 时长与样本数等摘要；禁止姓名、选手代号、原始 UA、设备名、串口名、原始错误文本、视频、原始 RC 与 Binding phrase。不得引入第三方 analytics SDK。

### 统计工作站登记

FPVSuperApp 共享项目 migration、受限摄入路径、客户规范域、书面确认与工程验收任一未完成时，生产统计保持关闭，不生成、不登记、不安装 token。不得把共享项目 secret/service-role key 配置到 FPVHelper Vercel。配置完成后，页面在 `waiting_token` 状态显示可复制的完整随机 workstation UUID；复制不会启用或发送统计，该 ID 也作为本地 Session JSON 的工作站台账身份，关闭统计不会删除它。

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

### 训练记录与录像保存

开始训练先确认空草稿写入成功。录制中每秒尝试追加尚未保存的样本，单块最多 500 帧；写入进行中不堆叠定时请求。界面区分“已采集”和“已保存至”，后者只在 IndexedDB 事务完成后推进。突然关页只能恢复最近确认的检查点，不能保证最多只丢 1 秒；当前训练的完整样本仍保留在页面内存中。

新记录包含版本化 `captureQuality` 和 `captureContext`：目标 100 Hz、正接收间隔的中位数/P95/P99/最大值、大于 50 ms 的缺口、可用时段、零值/倒序/无效间隔，以及主机时钟、单位和归一化定义。旧文件缺少这些字段时显示“未记录”，不推算为当时的实时采集事实；原有效训练门槛保持不变。

开启“录制视频与摇杆叠层”后，停止训练先结束采样，再等待 WebM 最后写入和 `close()`，之后将成功收据关联到 Session、完成本机保存并自动导出同目录 JSON。收据含实际文件名、MIME、字节数、录像起止时间与叠层说明。视频失败仍保存遥控数据，且不写入成功录像收据；JSON 与视频的保存结果分别显示。浏览器请求普通下载不等于确认文件落盘。

已实现的存储与合成逻辑不代表真设备验收完成：真实飞控/UVC、持续录像、真实目录写盘与权限恢复仍待验证。当前浏览器合成 WebM 的验收进展另见[集成审查](docs/designs/integration-review-2026-09-04.md)。

### 本机诊断

“下载诊断 JSON”只导出公开构建号、浏览器能力与最近 200 次枚举状态变化，不包含画面、选手代号、备注、设备名称、原始 UA 或原始 RC。只有真实桥接链路在线时，操作员才能主动开始“录制 60 秒原始串口夹具”；响应字节暂存在当前页面内存，到时、断线或达到 8 MiB 即停止，必须再次点击才会下载本地 `.bin`。原始夹具不进入诊断 JSON、Session、analytics 或任何网络请求，排查完成后由操作员按俱乐部数据规则删除。

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
- Session 使用 `performance.now()` 记录主机解码 RC 帧的时间；序号也是主机生成，不能据此测量 RF 丢包。批量串口接收可能产生很短或相同的时间间隔。
- WebM 烧录绘制时最新的主机摇杆样本；JSON 保存原始通道与成功录像收据，视频二进制不进入 JSON。`synchronized` 与 `videoOffsetCalibrated` 保持 `false`，没有设备时间或帧级同步校准。
- 人工 Marker 只用于定位 DVR 复盘时刻；视觉计圈是独立实验，见 [`docs/vision-lap-experiment.md`](docs/vision-lap-experiment.md)。

硬件取值边界见 [`docs/hardware-architecture.md`](docs/hardware-architecture.md)，试点流程见 [`docs/pilot-runbook.md`](docs/pilot-runbook.md)。

## 文档导航

- 发布与版本：[`docs/release-process.md`](docs/release-process.md)、[`docs/CHANGELOG.md`](docs/CHANGELOG.md)
- 试点运营：[`docs/pilot-runbook.md`](docs/pilot-runbook.md)、[`docs/workstation-install-checklist.md`](docs/workstation-install-checklist.md)、[`docs/coach-interview.md`](docs/coach-interview.md)
- 硬件与换人：[`docs/hardware-kit.md`](docs/hardware-kit.md)、[`docs/ground-rx-handoff-sop.md`](docs/ground-rx-handoff-sop.md)、[`docs/templates/hardware-acceptance-record.md`](docs/templates/hardware-acceptance-record.md)
- 训练与对表：[`docs/templates/training-ledger.md`](docs/templates/training-ledger.md)、[`docs/dvr-alignment.md`](docs/dvr-alignment.md)
- 数据与同意：[`docs/quote-data-appendix-draft.md`](docs/quote-data-appendix-draft.md)、[`docs/templates/guardian-consent-template.md`](docs/templates/guardian-consent-template.md)
- 统计登记：[`docs/analytics-provisioning-runbook.md`](docs/analytics-provisioning-runbook.md)
- 云端归属决策：[`docs/designs/fpvsuperapp-shared-supabase-decision.md`](docs/designs/fpvsuperapp-shared-supabase-decision.md)
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
