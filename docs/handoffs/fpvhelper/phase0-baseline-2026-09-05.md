# FPVHelper Phase 0 — Baseline, Module Contract & First Verified Fix

`run_id: fpvhelper-phase0-20260905-201716` · `phase: phase-0` · `status: needs_review`

本轮完成基线、模块契约与实时油门时间窗修复；验证中另做一项独立提交的最小门禁解阻。没有进入 Phase 1–5，没有推送、PR、合并、部署或硬件验收。实现者及子代理不签发 ChatGPT 的最终复核。

## 基线、提交与证据身份

| 字段 | 已核实事实 |
|---|---|
| Helper remote | `https://github.com/LongXL6/fpvhelper.git`，无 URL 凭据 |
| 历史审查 / base_sha | `f3fbba4e9711ed0f625b2e2e326beef8693292b9`，0.6.1 |
| 远端 main 前 / 后 | 均为上述 base；先 fetch，再 ls-remote；末次 20:31:12–15 UTC 的 main/PR 只读复核仍一致 |
| 用户原 checkout | 本地 main `ad287ee4cd2605b3ecea5e41985f4b5978ed3fca`，有既有未提交/未跟踪内容，保留原状 |
| 本轮隔离分支 | `codex/fpvhelper-phase0-baseline`，独立新建 worktree，无 stash/reset/rebase |
| 解阻提交 | `339ba2f81ff7203677263f5ea5b366fdd1002111`，仅复核时间修复、组件回归和 E2E 等待条件 |
| tested_sha / 实现提交 | `7fe193876707864cb016fe87d63be181a59c8890`；完整 check/build/smoke 均在此 clean commit 执行 |
| tested tree_sha | `f3db8ad1ab24584b3aa39ee4e1873a1a64d247ea` |
| 最终交付 head/tree | 本报告另作纯文档提交；提交后生成的 [handoff.json](../../../output/playwright/phase0-delivery/handoff.json) 记录完整 head_sha/tree_sha，避免自引用提交哈希 |
| 测试后修改 | 仅新增本报告；不再改实现、测试、配置或依赖。最后检查文档 diff、链接、JSON 与产物哈希 |
| 相关 PR | #1–#8 均已合并；#8 合并提交就是 base；本轮没有远端 PR，CI 未核验 |

历史锚点与当前远端 main 无差异。此前门识别工具仍位于独立 `codex/gate-recognition` 本地分支，未在 main 中；本轮不合并、删除或改写该工作。没有重启、刷新或操作用户正在训练的浏览器、串口、摄像头或服务。

Super App 仅只读核查：`LongXL6/FPVSUPERAPP`，main 与 ls-remote 均为 `aa24eb6e9c63368b99eb6c983afb72ca2c411afd`。其既有脏文件保留；未 fetch 或写入该仓库。读取 AGENTS、CLAUDE、README、memory/PROJECT、架构、依赖规则和 active-plan 入口。现有 `packages/core/{aircraft,battery,field,repair}` 已部分提取；旧 current-to-target-map 的“packages 不存在”已过时，不能把目标目录认定为完成迁移。

## 关键调用链与模块契约

| 路径 | 代码事实 |
|---|---|
| RC | parser → `applyFrame` → `publishSample` → `subscribeSamples` → Session append → 1 秒尝试的增量检查点；UI state 从同一入口分出 |
| 多选手 | 每个 PilotTelemetryBridge 拥有 controller，workspace store 按通道订阅；当前选手绑定视频 source/crop 与录制输入 |
| 视频 | 草稿确认 → 目录 writable → 借用输入的 stick compositor → MediaRecorder → Blob writeChain → close → receipt → 最终 Session / JSON |
| 实时视觉 | 借用选手 stream/crop → 显式启动 → 单在途 Worker → 候选 → 追加复核 → 本地 run 保存；不关闭原视频轨道 |
| 离线视觉 | seek 请求时刻 → 参考模型 → 候选/人工复核；main 的此路径没有原始解码 PTS 对齐证明 |
| 统计 | 白名单客户端 → 同域 Route → 当前 Helper Supabase adapter；目标 Super App 受限入口尚未实现 |

[模块契约](../../designs/fpvhelper-module-contract.md)覆盖所有权、稳定本地人物身份提案、字段来源/版本、独立时钟 run/timebase、媒体映射、幂等/顺序/修订/失败语义、Host 离线/登出、本地访问、桌面与移动能力、跨 origin 导入与回滚。

明确核对：`TrainingSession.build` 是软件构建号；`PilotChannelConfig.id` 不是稳定人物 ID；受训选手不必等于操作员账号；Field Session 由电池扫码驱动，不自动对应训练录制。平台身份、俱乐部和训练事件的可调用跨产品契约仍待核实。没有创建无人消费的 API/类型框架、Host harness 或账号映射。

## 发现复核表

状态采用 confirmed / refuted / already_fixed / unverified；“已修复”仅限本地代码及列明的测试证据。下列代码定位对应 tested_sha。

| 发现 / 旧判断 | 复核结果、证据等级与当前定位 |
|---|---|
| 实时油门用 60 个数值表达最近 3 秒 | **confirmed → 本轮已修复 / reproduced**。20 Hz 实收的 6 秒序列，旧 hook 留 24 个显示值；新窗口仅保留最近三秒。`lib/live-throttle-history.ts:16`、`components/throttle-timeline.tsx:6`、`hooks/use-betaflight-telemetry.test.tsx:83` |
| 来源切换不会混合显示 | **refuted → 本轮已修复 / reproduced**。旧代码返回演示后仍有 4 个 serial 值；`hooks/use-betaflight-telemetry.ts:263` 与 first-RC reset 清空旧历史 |
| 历史 Session 油门图也按等间距 | **refuted / already_fixed**。`components/session-library.tsx:90` 已按 elapsedMs、原始缺口和来源分段；本轮未修改该路径，历史回归继续通过 |
| 未编辑的视觉时间可以直接复核 | **confirmed 缺陷 → 本轮已修复 / reproduced**。342.5 / 1000.5 ms 的默认舍入会触发旧 >=0.5 判断；`components/live-gate-panel.tsx:174` 现比较显示值，保留原事件精确时间 |
| 原始 RC 由 React 批处理漏掉 | **already_fixed / reproduced**。逐样本订阅已接线，100 帧 batch 不丢；`components/flight-dashboard.tsx:527`、`hooks/use-training-session.ts:756–776` |
| 每个样本仍触发 UI 更新 | **confirmed / static**。`hooks/use-betaflight-telemetry.ts:142/165`、`hooks/use-pilot-telemetry-workspace.tsx:129`；实际 React commit/DOM 次数未测量，不能写成 100 FPS |
| 最终 RC 可先于视频收尾可靠保存 | **refuted / reproduced**。`hooks/use-training-session.ts:701–729` 先停采样、等待视频，然后才最终持久化；延迟 close 测试确认这一顺序。永久挂起导致尾段仍留内存的风险由控制流支持，未做真实断电实验 |
| 视频队列已有容量/收尾期限 | **refuted / static**。`lib/local-video-recording.ts:101/142/152/189` Promise 写入链无字节/时长预算；未实测内存溢出 |
| RC 草稿仍每秒重写全量数据 | **already_fixed / reproduced**。`lib/training-session-store.ts:426` 增量块 ≤500，慢检查点合并、事务确认后推进；全量当前样本仍驻内存，索引分页未完成 |
| 实时视觉已逐帧分块持久化 | **refuted / static**。`hooks/use-live-vision.ts:235/256` 复制 observation 全数组；`lib/live-vision-store.ts:163/201` getAll / put 全 run。5 秒检查点有单 pending 守卫，不是每帧写库 |
| Worker 旧结果混入新 run / 停止识别关闭共享视频 | **already_fixed / reproduced**。`hooks/use-live-vision.ts:206`、`lib/vision-model-client.ts:18` 单在途和 generation/requestId 隔离已有测试；不改模型或阈值 |
| 统计默认发送原始数据 | **refuted / reproduced**。`lib/analytics/client.ts:229` 的显式启用/域名/token 门禁，`lib/analytics/events.ts:413` 白名单；本轮新浏览器流程零 POST、零外部请求。生产配置未核验 |
| Super App 受限摄入已接通 | **refuted / static**。`app/api/events/route.ts:1` → `lib/supabase/analytics-admin.ts:9` 仍是直接 Supabase adapter；决策文档是目标，不是云端证据 |
| 只读 MSP 仅包含 RC/ANALOG | **refuted / static**。`lib/telemetry.ts:159/175` 还允许 STATUS_EX、API_VERSION、NAME、受限 GET_TEXT；修正文档列举，不新增串口命令 |
| 已验证 100 Hz 实收 / 无线安全 / 视频同步 / 物理过门 | **unverified / 待设备验证**。目标、主机时间/序号、地面电压/RSSI 和视觉候选含义不升级；同步字段仍 false |

## 最小修复、兼容与回滚

主修复观察每个原始间隔，再沿用串口每 5 帧追加的显示节奏。使用现有 `CAPTURE_GAP_THRESHOLD_MS = 50` 分段定义，仅对相邻原始主机接收时间应用 >50 ms、非正/无效间隔条件；正常的 100/250 ms 显示抽点间距不因此成为缺口。该阈值不是 RF 丢包或新有效性门槛。

显示按当前 `performance.now()` 的 3000 ms 窗口投影，不插值补空白、不延伸到“现在”、不伪造无数据水平线；孤立点仍可见。缓冲硬上限 512 点只是显示保护。图表内部 50 ms 时钟使停收时旧点移出；内部导航隐藏/卸载会清理该时钟，浏览器后台标签页依旧受自身节流约束，恢复后按真实时间更新，不承诺墙钟硬实时。

原始 RC 订阅、轮询、尾迹节奏、训练有效性、Session schema v1/v2 兼容、存储和录像路径未改。仅 controller 内部的 `throttleHistory` 从数值改为有时间/来源的显示点；不是导出 schema 变更。没有新依赖、数据库迁移、云配置或框架升级。

必要解阻独立在 `339ba2f`：默认显示舍入不算用户编辑，confirm/reject 传原始时间；实际更改必须走 adjust，理由/范围/忙碌守卫保留。已有 E2E 增加基于已事务确认草稿 >100 样本的等待，停止后原有断言保留，不加任意 sleep、不降低阈值。

回滚可分别 revert `7fe1938` 与 `339ba2f`；没有存储迁移或用户素材变动，不需数据回写。新发现只在独立 worktree 处理，没有重构 Dashboard 的业务生命周期。

实现与契约提交总 diff：**15 文件，+597 / -33**；最终另有本报告这一文档文件，最终精确规模见交付 JSON。

| 变更文件 | 用途 |
|---|---|
| `lib/live-throttle-history.ts`、`lib/live-throttle-history.test.ts` | 时间窗、原始间隔传播、边界回归 |
| `hooks/use-betaflight-telemetry.ts`、对应 `.test.tsx` | 有时间的显示点、来源重置、原始订阅保留 |
| `components/throttle-timeline.tsx`、对应 `.test.tsx` | 时钟驱动、窗口留白、孤立点及生命周期 |
| `components/flight-dashboard.tsx` | 替换原内部油门图；传内部视图 active |
| `e2e/throttle-timeline.e2e.ts` | 真实浏览器中部分窗口、停流、过期、返回演示与无上传 |
| `components/live-gate-panel.tsx`、对应 `.test.tsx` | 半毫秒默认舍入解阻，保留精确源时间 |
| `e2e/live-vision.e2e.ts` | 停止前等待持久化样本，保留全部原断言 |
| `docs/designs/fpvhelper-module-contract.md` | 模块契约提案 |
| `README.md`、`CLAUDE.md`、`docs/designs/telemetry-analysis-plan.md` | 入口、实际显示行为和只读白名单口径 |
| 本文件 | 持久化交接；测试后唯一文档变更 |

## 测试矩阵与失败原始证据

环境：macOS 27.0 (26A5388g)、arm64；Node v25.8.1（Helper 要求 >=24，CI 为24）、npm 11.11.0；锁定 Next 16.3.3 / React 19.2.8 / Vitest 4.1.11 / Playwright 1.62.1 / Chromium 151.0.7922.34。独立安装 node_modules，未共享 Next build 目录。Next 的本地 Client Components / use-client / Playwright 指南已读。

| 阶段 / 命令 | 退出码 | 通过 / 失败 / 跳过 | 实际命令耗时 |
|---|---:|---|---:|
| base `npm ci` | 0 | 443 packages，audit 0；非行为测试 | 3.853 s |
| base `npm run check` | 0 | 654 / 0 / 0，70 文件；typecheck/lint 通过 | 10.716 s |
| base `npm run build` | 0 | 构建成功；测试数不适用 | 5.525 s |
| base `npm run test:e2e:smoke` | 1 | 21 / 1 / 0 | 33.925 s |
| 油门 red `npx vitest run hooks/use-betaflight-telemetry.test.tsx` | 1 | 8 / 2 / 0；只先加测试，未改实现 | 0.714 s |
| 首次解阻浏览器 `npx playwright test e2e/live-vision.e2e.ts --project=chromium-smoke --config=output/playwright/phase0-smoke-unblock/playwright.config.cjs` | 1 | 0 / 1 / 0；暴露默认舍入守卫问题 | 36.675 s |
| 舍入 red `npx vitest run components/live-gate-panel.test.tsx` | 1 | 10 / 4 / 0 | 0.865 s |
| 同一组件 green | 0 | 14 / 0 / 0 | 0.636 s |
| 修复后两项 browser（同3120配置，增加 `e2e/throttle-timeline.e2e.ts`） | 0 | 2 / 0 / 0 | 12.942 s |
| tested_sha `npm run check` | 0 | **674 / 0 / 0，72 文件**；typecheck/lint 通过 | **8.594 s** |
| tested_sha `npm run build` | 0 | 构建成功；测试数不适用 | **2.224 s** |
| tested_sha `npm run test:e2e:smoke` | 0 | **23 / 0 / 0** | **38.993 s** |

每个主命令的 UTC 起止、退出码、环境、SHA 和原始日志保存于下列 local-only JSON。构建缓存、执行环境和样本不同，表中耗时不是性能提升证明。新增测试类型错误（act 回调返回 VitestUtils）曾使局部 typecheck exit 2，改为 void 回调后定向及最终完整检查通过，未跳过类型检查。

- [原始基线收据](../../../output/playwright/phase0-baseline/summary.json)；首轮失败 screenshot/trace 已复制到其 `test-results/`，未被后续覆盖。
- [油门 red](../../../output/playwright/phase0-fix/red.json)；日志显示 `expected 24 <= 13`、返回演示仍有 5 点（4 个旧 serial）。
- [独立解阻汇总](../../../output/playwright/phase0-smoke-unblock/unblock-summary.json)：第一次 baseline 开始/停止仅 846.245 ms，得到 87 样本；不是已证明的 RC 丢失。`attempt-1/` 保留默认时间 0.343、理由已填而排除按钮 disabled 的后续失败。
- [完整 check](../../../output/playwright/phase0-fix/final-check.json)、[build](../../../output/playwright/phase0-fix/final-build.json)、[smoke](../../../output/playwright/phase0-fix/final-e2e.json)：均记录 tested_sha、clean before/after 和日志 SHA-256。

附加独立源码审计回归：原已有 4 文件定向筛选 11 通过、68 因 `-t` 未选中；最终全量无跳过。5 文件定向 56 通过。仅保留工具 stdout（Vitest 分别272/271 ms），未采集独立可靠墙钟日志，不替代上表完整门禁。

Super App 只读 `node scripts/architecture-check.mjs` exit 0：0 新违规，11 项既有边界债务；执行 Node25，不是其锁定Node24的完整验收，耗时未可靠测量。未跑 Super App 测试、CI、托管数据库检查或本地 DB reset；本轮无 migration，数据库门禁未运行、不记通过。

## 用户体验与验证边界

新浏览器流程用合成串口/合成摄像头、独立 Chromium context；从未附着用户 Chrome。软件测试覆盖20/50/100 Hz输入、抖动、被抽掉样本中的缺口、重复时间、反向/无效时间、来源切换、停滞/恢复、显示容量上限、原始订阅和旧历史行为。

可分享的**合成**截图（local-only；无用户素材）：

- [刚开始时只有右侧短曲线](../../../output/playwright/test-results/throttle-timeline.e2e.ts-l-790db-silence-and-returns-to-demo-chromium-smoke/synthetic-partial-window.png)
- [停收后右侧留白](../../../output/playwright/test-results/throttle-timeline.e2e.ts-l-790db-silence-and-returns-to-demo-chromium-smoke/synthetic-receive-silence.png)
- [超过窗口后旧曲线清空](../../../output/playwright/test-results/throttle-timeline.e2e.ts-l-790db-silence-and-returns-to-demo-chromium-smoke/synthetic-expired-window.png)

MediaRecorder、视频回放、OPFS 与 IndexedDB 在浏览器中真实执行；串口、摄像头内容和模型候选是合成/模拟。证明软件关联、保存和回放断言，不证明外部真实目录的长期耐久性、采集卡、RF、安全、140 km/h视频覆盖、模型准确率或计时精度。

## 性能、保存、安全与剩余风险

| 项目 | 状态 |
|---|---|
| 显示历史预算 | 测试验证最多512点；3秒窗口为主边界；不是原始记录上限 |
| RC实收/RF、React commits、主线程开销、RSS/堆字节 | `null / 未测量`；未宣称性能提升或硬实时 |
| 原始/媒体写入队列预算 | 本轮未修改、未长测；视频队列无字节/时长预算的静态风险仍在 |
| 保存确认 | 浏览器现有事务/收据测试通过；视频永久挂起时的最终RC尾段风险仍在，不能称零丢失 |
| 长时间录制、断电/强制关页、换电脑恢复 | 本轮未验收；不能由原IndexedDB仍在而宣称归档恢复完成 |
| 网络与配置 | 未读取或修改凭据/线上环境变量；没有新统计/网络代码，没有上传用户素材/身份/RC；合成油门流程外部请求和POST均为0 |
| 发布层 | 本地提交完成；CI未核验；本轮PR/merge/deploy/tag/Promote/生产变更均无 |
| 硬件与业务 | 未测试/未批准；地面桥不得接ESC/电机，无线安全需要具体设备配置和拆桨验收 |

Phase 0 本地代码审查没有剩余阻断。非阻断但必须在相应阶段解决：RC最终持久化被视频挂起拖住（采集/存储负责人）；媒体队列预算和晚到写入隔离（存储负责人）；视觉全run保存/内存规模（视觉负责人）；宿主身份/权限与跨origin契约（Super App负责人）；实际设备安全和长期记录（用户/硬件负责人）。它们会阻止相应的可靠性、集成或飞行交付声明，不隐藏在“测试全过”之后。

## 只推荐一个下一轮切片

**Phase 1A：先度量采集发布与 UI 更新，不搬运行层。** 用确定性合成100 Hz样本和两选手切换场景，在固定环境记录 raw订阅次数、store通知次数和真实React commit次数；核对所有原始样本的顺序/完整性，并为之后的一条受控UI快照路径建立基线。验收是可重放输入、原始零非预期丢失/重复、明确计数口径和可复核profile，实际硬件率继续未测量。不得改协议/存储/schema/部署、引入云/模型上传或降低原始采集率。该建议尚未获批，未执行。

视频收尾解耦是已确认的后续高优先级风险，属于 Phase 2；不能因本报告提到它就跳过阶段复核。

请外层编排器或用户把本报告、最终 [JSON](../../../output/playwright/phase0-delivery/handoff.json) 与 [脱敏 patch](../../../output/playwright/phase0-delivery/phase0.patch) 送回原 ChatGPT 对话。产物目前仅在本机；没有声称 ChatGPT 已读取、已联系或已批准。

请求结构化复核字段：`run_id`、`reviewed_head_sha`（使用最终 JSON 的完整 head）、`decision`（PASS/REVISE/BLOCKED）、`accepted_scope`、`required_fixes`、`evidence_gaps`、`next_scope`、`owner_authorizations_required`。必须匹配本轮与提交；PASS仅是指明范围的技术复核，不授权合并、生产、硬件或下一阶段的额外范围。
