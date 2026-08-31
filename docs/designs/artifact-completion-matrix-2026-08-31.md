# FPVHelper Artifact 完成矩阵

更新时间：2026-08-31
代码基线：`1cba5b5`（本地集成分支；尚未推送）
客户入口决定：`race.fpvsuperapp.com`
内部验证入口决定：`helper.longxl.com`

## 1. 用途与证据边界

这份矩阵把 Claude Artifact 对应的两份仓库产出拆成可执行项：

- `docs/designs/strategy-review-2026-08-31.md`
- `docs/designs/analytics-tracking-plan.md`

原 Artifact 链接在当前浏览器会话中显示 `Page not found`，因此本轮以仓库中的完整 Markdown、当前代码、测试、PR、Preview 和独立审查作为可复核来源。恢复 Artifact 访问后仍要做一次逐段差异核对。

状态只允许使用以下口径：

- `已实现待集成`：代码和本地测试存在，但尚未进入集成分支。
- `集成分支已验证`：已进入集成分支，并通过对应本地门禁。
- `外部待验证`：需要真实硬件、俱乐部、云项目、合同或付款证据，代码无法替代。
- `明确延后`：战略文档明确放在 Later 或许可后，不计入试点起算版本。
- `未完成`：仍需工程实现或运营产出。

## 2. 当前证据层

| 证据层 | 当前状态 | 可证明 | 不可证明 |
| --- | --- | --- | --- |
| 本地代码 | `1cba5b5` 已完成 42 个 Vitest 文件 / 229 项、非增量 typecheck、lint、生产 build；Chromium 2 条流程各重复 3 次共 6/6；本地 Supabase pgTAP 2 文件 / 56 项通过 | 当前集成实现可编译，单元、假硬件浏览器主链、数据库策略与限流测试通过 | 真实 UVC、真实 ELRS、生产域、云数据库、真实 YOLO 模型 |
| GitHub PR | PR #1 已建立；当前本地集成分支仍含尚未推送的新提交 | 旧变更可审查 | 当前集成 SHA 的远端审查、CI 成功、已合并 |
| GitHub Actions | runner 在执行任何 step 前因账户 Billing 被阻止 | workflow 已声明 | CI 测试结果；这不是测试失败 |
| Vercel Preview | `813c26e` 的旧 Preview 为 Ready；不对应当前 `1cba5b5` | 旧预览构建可访问 | 当前集成版本部署、商用生产许可、生产 Promote、客户网络可用性 |
| Supabase 云端 | 独立 FPVHelper 项目尚未建立；当前可见项目属于 LONGWEBSITE | 本地 migration/pgTAP 可运行 | 云端 migration、RLS、定时清理、事件链 |
| 真实硬件 | 未取得本轮设备验收记录 | 无 | UVC、Bridge FC、ELRS RX、failsafe、换人 SOP |
| 商业试点 | 报价/附件/台账/运行手册已有草案 | 交付流程可讨论 | 签字、¥666、起算、基线周、4 周结果、¥6,000 尾款 |

## 3. Now-A：试点起算前置

| 要求 | 状态 | 当前证据 | 下一动作 / 负责人 |
| --- | --- | --- | --- |
| 报价单、数据附件、老板书面确认、¥666 | 外部待验证 | 定价设计和附件草案存在 | 冻结收款主体、税务、交付日、书面支持渠道；老板签回后才可收款 |
| 教练 5 问与换人 SOP | 外部待验证 | 每名选手独立 Bridge FC+RX 的决定已确认；SOP 文档存在 | 现场确认谁按开始、DVR 类型、老板 3 个数字、屏幕距离、换人耗时 |
| 唯一客户域、内部验证域、独立 Supabase | 外部待验证 | 域名与独立项目决策已确认 | 新建独立 Supabase；生产只统计客户域；不得使用 LONGWEBSITE 项目 |
| IndexedDB 草稿、结束写入、列表、离开保护、自动导出 | 集成分支已验证 | 跨日未导出 Session、恢复草稿、列表、再次导出和目录回退均有自动化覆盖 | 浏览器配额、断电和真实工作站长期运行仍需现场验证 |
| Session schema、代号、备注、channels、markers、重解析、文件名 | 集成分支已验证 | schema v2、workstation/build、parser、产品内校验、导出证据和完整状态已合入 | 真实俱乐部代号与台账操作仍需现场验证 |
| 有效性、录制守卫、首帧、stale、拔线、错误码 | 外部待验证 | 首帧后才可记录、stale/RX link lost、断线结束和枚举错误已通过代码与假串口测试 | 真 ELRS failsafe、拔线、串口占用与恢复必须拆桨台架验证 |
| Phase 1 统计、Route、DB、周漏斗、验收记录 | 外部待验证 | 19 事件、白名单、工作站 token、替换流程、限流、migration 与本地 pgTAP 56 项已通过；内部域默认不发送 | 独立云项目、书面确认、Vercel 环境变量和端到端事件链尚未建立 |
| 文案、离开本机的数据表、CI、Node 版本 | 集成分支已验证 | README、CLAUDE、CI、Node 24 已提交；本地门禁通过 | 修复 GitHub 账户 Billing 后重跑 CI |
| 版本提示、Preview、Promote、tag、CHANGELOG | 外部待验证 | `/version.json`、版本提示、release 文档、CHANGELOG 存在；当前全门禁通过 | 推送当前 SHA、获得远端审查与 CI、付费 Vercel 方案后才创建新 Preview / Promote / tag |
| Vercel/Supabase 商用、区域、配额、备份、限流 | 外部待验证 | Vercel 当前团队为 Hobby；Supabase 本地策略通过 | 有权负责人批准 Vercel 商用方案；建立并核验独立 Supabase |
| 真机全链路与大陆网络 | 外部待验证 | 只有清单和模板 | 拆桨台架 + UVC + 3 分钟 Session + 拔线恢复 + JSON 重解析 + 热点实测 |
| 安装清单、台账、监护人同意、硬件记录 | 外部待验证 | 首次使用清单已在产品内；业务与硬件模板已在仓库 | 由真实俱乐部和硬件负责人填写签署，空模板不是验收证据 |
| Pilot runbook 与 DVR 基线周 | 外部待验证 | 运行手册已在仓库 | T-10 至 T-3 真实记录 DVR 复盘分钟 |
| 两台工作站安装、验收 Session、起算 | 外部待验证 | 无真实记录 | 满足前置门后现场执行 |

## 4. Now-B：D11–D14 转化杠杆

| 要求 | 状态 | 当前证据 | 下一动作 |
| --- | --- | --- | --- |
| Marker 四标签、M、墙钟、复制清单、DVR 对表 | 集成分支已验证 | 四标签、M、Space 长按、墙钟/偏移清单和安全快捷键测试已合入 | 真实 DVR 定位偏差仍需现场测量 |
| 教练大屏 | 集成分支已验证 | Fullscreen API、F 开关、Esc、安全布局、Wake Lock 与单主标签页锁已合入 | 真实 720p 显示器、浏览器权限与教练可读性仍需现场冒烟 |
| 老板 3 指标、纯函数、周报脚本 | 集成分支已验证 | 本地周报纯函数、两工作站 JSON 合并、冲突隔离、台账分母与 Markdown 已合入 | 老板仍需冻结最终 3 个商业数字；当前技术覆盖率不是最终 80% 业务验收率 |

## 5. Next：试点期到尾款

| 能力 | 当前状态 | 推荐切片 |
| --- | --- | --- |
| ARM/AUX 飞行段、RXLOSS、attempts | 未完成 | `link-integrity` 先完成 RXLOSS；ARM/AUX 需真实通道确认后再做 |
| 指标库 v1 与上一包对比 | 未完成 | 周报与多工作站合并已完成；逐包对比和最终老板 3 指标待冻结 |
| 50 Hz 与 maxGap/gapCount validity | 未完成 | `session-quality`，必须台架确认轮询稳定性 |
| 串口免弹窗重连、VID/PID、3 次重连、无 React client | 未完成 | 已有 `getPorts()`；其余放 `serial-client` |
| 逐字节 parser 与 quality 计数 | 未完成 | 现有 stream parser 有统计；需用原始夹具核对恢复行为 |
| 视频设备优选、记忆、自动打开、settings 入 Session | 未完成 | 记忆和 settings 已有；采集卡标签优选及 Session 写入未完成 |
| 首次使用清单、demo 水印、微信/Chromium 提示 | 集成分支已验证 | 首次/稍后/手动重开、受限存储回退与 Demo 水印已实现；真实浏览器安装仍需现场执行 |
| 有效 Session 实时进度和停止小结 | 未完成 | 有停止小结；实时阈值进度与 3 指标未完成 |
| Space/M/E/Esc、视频 REC、720p | 外部待验证 | Space/M/E/Esc 已完成软件门禁；真实采集卡 REC 状态与 720p 显示仍需现场验证 |
| 指定文件夹自动保存与回退 | 集成分支已验证 | 目录句柄只留本机，确认写入后才记导出，普通下载回退已覆盖 |
| 一键诊断包与 60 秒串口原始夹具 | 集成分支已验证 | 枚举化 JSON 与 60 秒 / 8 MiB 原始串口本地下载已实现，ready 防覆盖并完成二次独立审查 |
| 采样与 React state 解耦 | 未完成 | 真机/页面隐藏数据证明需要后再做 |
| Wake Lock 与第二标签页锁 | 集成分支已验证 | Screen Wake Lock 与 Web Locks 单主标签页门禁已实现；不支持时明确降级 |
| 埋点 Phase 2 | 未完成 | Phase 1 云端验收后再做；不引入第三方 SDK |
| 真实回放/销售演示资产 | 外部待验证 | 需要书面素材授权；回放器可独立实现 |
| 硬件 BOM 与安装 SOP | 外部待验证 | 文档是待确认模板；型号/接线/固件必须真机负责人批准 |
| 文案字典、LICENSE、私有仓库确认 | 未完成 | `release-completeness`，开源边界需创始人决定 |
| Playwright 假 UVC/Serial 冒烟 | 集成分支已验证 | 生产态假 UVC + 只读 MSP_RC/STATUS_EX/ANALOG + IndexedDB Session + analytics 不外发，最终 6/6 |
| 两工作站 JSON 合并周报 | 集成分支已验证 | 去重、冲突隔离、台账分母、确认文件证据和本地周一窗口已覆盖 |

## 6. 视觉 Start Gate / YOLO

当前已加入纯本地实验支架：dataset manifest 校验、manifest 原文 SHA 绑定、冻结配置与 test Session/场景证据门、最大匹配数再最小误差的一对一评估、长缺帧重置的过门状态机，以及双输入 20 MiB 上限 CLI。它已经有独立反例复审和 16 项定向测试，但仍没有真实数据集、标注、训练权重、视频推理管线或盲测结果，因此不是已交付计圈功能，也不得替代正式计时器。

实验必须保持本地视频边界，并按顺序完成：

1. 获得经书面同意的本地训练片段，建立 train/validation/test，选手与场地分层避免泄漏。
2. 建立标注规范与数据版本清单；原始画面不上传到云端产品或埋点。
3. 训练小模型并导出本地推理格式；记录模型、数据、代码三方版本。
4. 将现有方向/滞回/冷却/长缺帧重置状态机接入真实本地推理输出；当前仅有算法支架。
5. 使用现有证据门在独立 test ≥300 次穿门上验证 Recall ≥98%、误报与重复计数各 ≤1%、P95 ≤100 ms；当前没有真实通过报告。
6. 与 4000 元级计时器盲测；达到门槛前 UI 必须标记“实验圈数，不作为正式成绩”。

## 7. 集成顺序与统一门禁

1. `session-completion`
2. `link-integrity`
3. `analytics-provisioning`
4. `metrics-report`
5. `ux-workstation`
6. `browser-smoke`
7. `diagnostics / onboarding / vision experiment harness`

每个分支都必须提交 SHA、变更文件、定向测试和残余风险。总设计师只在独立审查通过后 cherry-pick 到集成分支。

统一软件门禁：

```bash
npm run check
npm run build
git diff --check
supabase db start
supabase test db
supabase stop
```

最终交付还需要：

- 浏览器假硬件 E2E；
- 独立代码审查；
- GitHub CI 真正开始并通过；
- Vercel Preview 对应 commit；
- 独立 Supabase 项目迁移与事件链；
- 拆桨真机验收记录；
- 俱乐部书面确认与 DVR 基线。
