# FPVHelper Artifact 完成矩阵

更新时间：2026-08-31  
代码基线：`813c26eb0be8f937eafdf27fb46e0bd014058f25`  
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
| 本地代码 | `813c26e` 已完成 121 个 Vitest、typecheck、lint、build；本地 Supabase pgTAP 46 项通过 | 当前实现可编译，单元与数据库策略测试通过 | 真实 UVC、真实 ELRS、生产域、云数据库 |
| GitHub PR | PR #1 已建立并推送 | 变更可审查 | CI 成功、已合并 |
| GitHub Actions | runner 在执行任何 step 前因账户 Billing 被阻止 | workflow 已声明 | CI 测试结果；这不是测试失败 |
| Vercel Preview | Preview 为 Ready | 预览构建可访问 | 商用生产许可、生产 Promote、客户网络可用性 |
| Supabase 云端 | 独立 FPVHelper 项目尚未建立；当前可见项目属于 LONGWEBSITE | 本地 migration/pgTAP 可运行 | 云端 migration、RLS、定时清理、事件链 |
| 真实硬件 | 未取得本轮设备验收记录 | 无 | UVC、Bridge FC、ELRS RX、failsafe、换人 SOP |
| 商业试点 | 报价/附件/台账/运行手册已有草案 | 交付流程可讨论 | 签字、¥666、起算、基线周、4 周结果、¥6,000 尾款 |

## 3. Now-A：试点起算前置

| 要求 | 状态 | 当前证据 | 下一动作 / 负责人 |
| --- | --- | --- | --- |
| 报价单、数据附件、老板书面确认、¥666 | 外部待验证 | 定价设计和附件草案存在 | 冻结收款主体、税务、交付日、书面支持渠道；老板签回后才可收款 |
| 教练 5 问与换人 SOP | 部分完成 | 每名选手独立 Bridge FC+RX 的决定已确认；SOP 文档存在 | 现场确认谁按开始、DVR 类型、老板 3 个数字、屏幕距离、换人耗时 |
| 唯一客户域、内部验证域、独立 Supabase | 部分完成 | 域名与独立项目决策已确认 | 新建独立 Supabase；生产只统计客户域；不得使用 LONGWEBSITE 项目 |
| IndexedDB 草稿、结束写入、列表、离开保护、自动导出 | 部分完成 | 主体和测试已在基线 | `session-completion` 修复跨日未导出记录不可再次导出 |
| Session schema、代号、备注、channels、markers、重解析、文件名 | 部分完成 | v2 主体、parser、文件名和备注存在 | `session-completion` 补 workstation/build、产品内 JSON 校验、台账完整状态 |
| 有效性、录制守卫、首帧、stale、拔线、错误码 | 部分完成 | RC 首帧、1.5 秒 stale、串口/视频断线和技术 validity 已实现 | `link-integrity` 增加 RX failsafe 证据；真机验证后才可通过 |
| Phase 1 统计、Route、DB、周漏斗、验收记录 | 部分完成 | 19 事件、白名单、token、限流、migration、pgTAP 已实现 | `analytics-provisioning` 闭合工作站令牌装机；独立云项目与书面确认后才启用 |
| 文案、离开本机的数据表、CI、Node 版本 | 集成分支已验证 | README、CLAUDE、CI、Node 24 已提交；本地门禁通过 | 修复 GitHub 账户 Billing 后重跑 CI |
| 版本提示、Preview、Promote、tag、CHANGELOG | 部分完成 | `/version.json`、版本提示、release 文档、CHANGELOG、Preview 存在 | 完成全门禁、独立审查、付费 Vercel 方案后才 Promote/tag |
| Vercel/Supabase 商用、区域、配额、备份、限流 | 外部待验证 | Vercel 当前团队为 Hobby；Supabase 本地策略通过 | 有权负责人批准 Vercel 商用方案；建立并核验独立 Supabase |
| 真机全链路与大陆网络 | 外部待验证 | 只有清单和模板 | 拆桨台架 + UVC + 3 分钟 Session + 拔线恢复 + JSON 重解析 + 热点实测 |
| 安装清单、台账、监护人同意、硬件记录 | 部分完成 | 模板已在仓库 | 由真实俱乐部和硬件负责人填写签署，空模板不是验收证据 |
| Pilot runbook 与 DVR 基线周 | 部分完成 | 运行手册已在仓库 | T-10 至 T-3 真实记录 DVR 复盘分钟 |
| 两台工作站安装、验收 Session、起算 | 外部待验证 | 无真实记录 | 满足前置门后现场执行 |

## 4. Now-B：D11–D14 转化杠杆

| 要求 | 状态 | 当前证据 | 下一动作 |
| --- | --- | --- | --- |
| Marker 四标签、M、墙钟、复制清单、DVR 对表 | 部分完成 | 四标签、M、清单和文档存在 | 补 Space 长按和浏览器验收；真实 DVR 测定位偏差 |
| 教练大屏 | 部分完成 | F 模式和大字号布局存在 | 补 Fullscreen API、Esc 退出和 720p 冒烟 |
| 老板 3 指标、纯函数、周报脚本 | 未完成 | 无 `lib/metrics.ts` 或周报生成脚本 | 老板先冻结 3 个数字，再实现指标和两工作站 JSON 合并 |

## 5. Next：试点期到尾款

| 能力 | 当前状态 | 推荐切片 |
| --- | --- | --- |
| ARM/AUX 飞行段、RXLOSS、attempts | 未完成 | `link-integrity` 先完成 RXLOSS；ARM/AUX 需真实通道确认后再做 |
| 指标库 v1 与上一包对比 | 未完成 | `metrics-report`，先锁定老板 3 指标 |
| 50 Hz 与 maxGap/gapCount validity | 未完成 | `session-quality`，必须台架确认轮询稳定性 |
| 串口免弹窗重连、VID/PID、3 次重连、无 React client | 部分完成 | 已有 `getPorts()`；其余放 `serial-client` |
| 逐字节 parser 与 quality 计数 | 部分完成 | 现有 stream parser 有统计；需用原始夹具核对恢复行为 |
| 视频设备优选、记忆、自动打开、settings 入 Session | 部分完成 | 记忆和 settings 已有；采集卡标签优选及 Session 写入未完成 |
| 首次使用清单、demo 水印、微信/Chromium 提示 | 未完成 | `onboarding` |
| 有效 Session 实时进度和停止小结 | 部分完成 | 有停止小结；实时阈值进度与 3 指标未完成 |
| Space/M/E/Esc、视频 REC、720p | 部分完成 | `ux-workstation` |
| 指定文件夹自动保存与回退 | 未完成 | `ux-workstation`，File System Access 只存本机句柄 |
| 一键诊断包与 60 秒串口原始夹具 | 未完成 | `diagnostics`；原始字节只留本机 |
| 采样与 React state 解耦 | 未完成 | 真机/页面隐藏数据证明需要后再做 |
| Wake Lock 与第二标签页锁 | 未完成 | `ux-workstation` |
| 埋点 Phase 2 | 未完成 | Phase 1 云端验收后再做；不引入第三方 SDK |
| 真实回放/销售演示资产 | 外部待验证 | 需要书面素材授权；回放器可独立实现 |
| 硬件 BOM 与安装 SOP | 部分完成 | 文档是待确认模板；型号/接线/固件必须真机负责人批准 |
| 文案字典、LICENSE、私有仓库确认 | 未完成 | `release-completeness`，开源边界需创始人决定 |
| Playwright 假 UVC/Serial 冒烟 | 未完成 | `browser-smoke` |
| 两工作站 JSON 合并周报 | 未完成 | `metrics-report` |

## 6. 视觉 Start Gate / YOLO

当前只有 `docs/vision-lap-experiment.md`，没有数据集、标注、训练、模型、推理、计圈状态机或独立测试记录。因此它是一个已定义门槛的实验，不是已交付功能，也不得替代正式计时器。

实验必须保持本地视频边界，并按顺序完成：

1. 获得经书面同意的本地训练片段，建立 train/validation/test，选手与场地分层避免泄漏。
2. 建立标注规范与数据版本清单；原始画面不上传到云端产品或埋点。
3. 训练小模型并导出本地推理格式；记录模型、数据、代码三方版本。
4. 实现 start-gate 检测 + 方向/滞回/冷却状态机，避免同一次穿门重复计圈。
5. 在独立 test ≥300 次穿门上达到 Recall ≥98%、误报与重复计数各 ≤1%、P95 ≤100 ms。
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
supabase db reset --local
supabase test db --local supabase/tests
```

最终交付还需要：

- 浏览器假硬件 E2E；
- 独立代码审查；
- GitHub CI 真正开始并通过；
- Vercel Preview 对应 commit；
- 独立 Supabase 项目迁移与事件链；
- 拆桨真机验收记录；
- 俱乐部书面确认与 DVR 基线。

