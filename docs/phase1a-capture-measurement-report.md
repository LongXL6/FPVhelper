# Phase 1A — 本地采集与界面更新测量报告

状态：本地实现、检查与正式测量完成；等待外部审阅。未执行性能优化、下一阶段、推送、合并、部署或硬件操作。

## 版本与范围

- 已审阅 Phase 0：`4a35333f9aea79340105a0eaf8b1b3eb7875920f`。
- 本轮 tested source / frozen-plan commit：`62d757e1144d9dc93060d4f3243a52301fbcd4d0`。
- Tested tree：`ee953a37602e6abe475911735c2bfd106d4665c4`。
- 计划：`benchmarks/capture/measurement-plan.json`，SHA-256 `419ef43b9d54d759cea4cfe4abeab34343ad8040e43a0664d03447e20fd73159`。
- 正式批次：`formal-62d757e-01`；UTC `2026-09-05T22:03:32.054Z` 至 `2026-09-05T22:20:16.591Z`。
- 普通 BUILD_ID：`WWbEi0_KSMqvC06hwBg0f`；profiling BUILD_ID：`_bAEdlA5jR_3E_VUFwMMl`。
- 交付提交仅添加本报告；完整 tested→delivery diff 与准确交付 SHA 在外部 handoff/commit manifest 中，避免自引用。

仅新增默认关闭的有界观察点、真实浏览器 Profiler 边界、合成夹具、测量与分析工具。普通构建不暴露测量入口；P0 与 P1 共用 profiling 构建，分别关闭/开启记录。没有更改采样频率、原始监听顺序、异常传播、Session 守卫/格式、持久化、录制合成或现有 UI 时钟。

真实时钟、真实 MediaRecorder、OPFS/IndexedDB；独立 AUX 标识追踪实际已交付的输入。固定 5 秒预热、20 秒稳态、3 秒有界 drain、三轮顺序轮换；S3/S4 用独立生命周期窗口。20 秒短窗口用于活动工作站上的第一份有界基线，不是长期稳定性或热负载测试。

## 已执行验证

干净 tested commit 上依次运行并保留原始日志、退出码、时长和构建来源：

- `npm run check`：75 个测试文件、720 项测试通过，类型检查与 ESLint 通过。
- 两份 `.mts` 测量 CLI 的独立严格 TypeScript 检查通过。
- `npm run test:e2e:smoke`：23 项通过，使用隔离合成媒体/串口。
- profiling build（`FPV_MEASUREMENT_BUILD=1 npm run build -- --profile`）与普通 build（flag=0）均通过；两者关闭分析上报。profiling 构建临时改写 `next-env.d.ts`，随后普通构建恢复，正式批次开始与结束均保持源码干净。
- 正式执行：`node --experimental-transform-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/run-phase1a-batch.mts --plan benchmarks/capture/measurement-plan.json --output output/playwright/phase1a/formal-62d757e-01 --port 3124`。
- 最终 3107/3124 无监听；只管理本任务创建的服务与隔离浏览器。

环境：macOS 27.0 / 26A5388g，Apple M4 Max（14 核、36 GiB RAM），Node 25.8.1 / npm 11.11.0，Next 16.3.3，锁定 React 包 19.2.8，实际 profiling app runtime React `19.3.0-canary-cbb046ab-20260731`，Playwright 1.62.1 / Chromium 151.0.7922.34。N 模式没有直接 React runtime 观测，保留 unavailable；GPU 后端未查询，不推断硬件加速。React Strict Mode 配置始终开启，测量使用 production/profile 构建。

## 结果与解释

正式本机批次共 30/30 项完成，全部 exit 0，原分析器 valid=true；汇总再次验证计划/source/run ID、原始与压缩字节收据，artifactIssues=0。版本为提交 62d757e，Chromium 151.0.7922.34 headless、1440×1100；每个稳态窗口 warmup 5 秒、测量 20 秒，3 次重复。总批次 1,004.536 秒（16 分 44.536 秒）。

下面均为三次实际观测的算术均值（最小–最大）。输入是请求驱动的合成串口，不是 RF 接收速率，也不能把与理想 100 Hz 的差距当成原始数据丢失。CDP 比例为 TaskDuration / Timestamp，属于 renderer task 时域，观察区间包含 drain，不是全进程 CPU 占用。

| 条件 | 模式 | 实际交付 Hz | CDP task 时间比例 |
|---|---|---:|---:|
| S1 100 Hz 目标，空闲 | N | 85.743（85.579–85.873） | 22.383%（22.026–23.078） |
| 同上 | P0 | 85.719（85.516–85.878） | 21.704%（21.134–22.087） |
| 同上 | P1 | 85.936（85.866–86.030） | 22.111%（21.975–22.304） |
| S2 正常视频＋OSD＋JSON录制 | N | 81.553（81.174–82.215） | 25.451%（25.301–25.600） |
| 同上 | P0 | 82.200（82.064–82.421） | 28.085%（27.898–28.210） |
| 同上 | P1 | 81.454（81.125–81.867） | 28.893%（28.648–29.084） |
| S1 50 Hz 目标 | P1 | 46.171（46.135–46.235） | 17.290%（16.644–17.703） |
| S0 DEMO | P1 | 不适用，无串口输入 | 22.142%（21.978–22.290） |

同条件、同 repeat 的配对差值均值：S1 的 P0−N 是 −0.023 Hz / −0.680 个百分点，P1−P0 是 +0.216 Hz / +0.407 个百分点；S2 的 P0−N 是 +0.646 Hz / +2.634 个百分点，P1−P0 是 −0.745 Hz / +0.808 个百分点。对应逐次差值及范围保留在 paired-common.csv 和 precise-statistics.json。短窗口、三次重复只提供本机观察，不能宣称显著性或普遍的探针开销。

P1 的每个边界保留全部实际 Profiler 回调；以下是 callback Hz 均值，括号为每次实际 throttle tick 对应的回调数。不能把多个嵌套边界的 render 时间相加。

| 边界 | S1 100 Hz 目标 | S2 录制 |
|---|---:|---:|
| workbench | 182.784（9.143×） | 180.918（9.049×） |
| telemetry-display | 87.285（4.366×） | 169.323（8.469×） |
| recording-ui | 87.285（4.366×） | 169.323（8.469×） |
| throttle-timeline | 107.028（5.353×） | 179.919（8.999×） |
| 当前 pilot bridge | 174.571（8.732×） | 170.556（8.531×） |
| 其余每个 pilot bridge | 87.285（4.366×） | 169.323（8.469×） |

所有 S0/S1/S2 P1 的 20 秒稳态窗口均为 400 次 throttle tick，实际约 19.993–19.999 Hz。S1 workbench 的 render p95 为 0.800 ms、单次最大 1.700 ms；S2 p95 为 0.600 ms、单次最大 1.200 ms。其它主要显示边界的 p95 约 0.100 ms。值为零或 0.1 ms 受浏览器计时粒度影响，不是无成本证明。全部窗口共 10 个 workbench 重复提交时间戳；已标歧义并保留回调，没有据此静默合并根提交。

S1-100 每个 20 秒窗口 store.updated/notify 为 1,739–1,752，store.read 为 10,434–10,512。S2 分别为 1,651–1,673 和 14,094–14,244。显示更新未被 20 Hz 时间线计时器自动限制；录制时显示回调增加，有必要把原始样本保留与 UI 计数发布作为不同工作来考虑。

完整性证据：全部窗口共有 45,813 个独立合成输入；其中 P1 可观察的 25,693 个输入全部且各一次 decoded/published。41,062 次有效订阅预期均有对应 attempted/returned，无缺失、多余、重复、逆序及跨层因果错误。P1 窗口实际读取 655,258 bytes、29,409 个 read batch，解析 29,409 个协议帧、错误帧 0；帧数包含 STATUS/ANALOG 等，并非全部 RC。N/P0 内部计数明确为 null。

9 个独立 Session 共保存 20,643 条完整原始样本；其中测量窗口交付并应保存的 14,718 条全部匹配，缺失/重复/错序为零。完整样本包括 warmup/tail，不应与窗口分母相减推断丢失。P1 的开始、append、冻结、完成及 Session ID 的因果链通过，N/P0 通过普通 UI 状态与最终持久化文件独立核对。

9 次均真实生成可解码播放的 1920×1080 MP4/H.264，单文件 2,185,827–2,262,730 bytes，合计 20,103,524 bytes。容器、MIME、后缀、文件大小和成功 close 的收据一致；JSON 的原始 samples 与 video receipt 同 IDB 完全一致，overlay=sticks。synchronized=false 始终保留；此次未做逐像素 OSD 验证或物理摄像/摇杆同步精度证明。

S3 两路独立来源在切选手、进入记录页、返回工作台的各阶段均有输入，阶段平均交付约 85.331–86.522 Hz；没有跨来源混入。S4 每次暂停阶段只有一帧已经在途的尾帧，恢复后平均 85.821 Hz；返回 DEMO 和模拟断开后串口交付为零。这些仅证明合成软件生命周期，不能代替真实设备异常验证。

资源：P1 最大事件数 134,186 / 200,000；原始单项最大 37,314,554 bytes（35.586 MiB）/64 MiB；全部正式 gzip 为 16,945,430 bytes（16.160 MiB）。统计时本隔离 output/playwright 总量约 24.1 MB，远低于 250 MiB，含探索失败/构建/报告。最大已观察 renderer JSHeapUsedSize 为 58,613,656 bytes（55.898 MiB），仅窗口端点取样，不是峰值或总内存上限证明。raw 编码合计 369.9 MiB 是逐项解压总量，并未作为未压缩文件累计保存。

全部 30 个 contextClosed=true，所有端口 closed 且 pending read/write 为零；runner 与 server 进程关闭由 orchestrator 收据证明。9 次录制结束后的页面快照仍保留借用的视频源 track live，随后才关闭 context；因此不能声称页面快照证明 track 显式 ended。外联/上传 0、协议错误 0、collector/fixture overflow 0、instrumentation error 0。

证据最强的下一小步建议（未执行）：只把训练录制 UI 的 sample/unique count 等统计发布与逐帧原始 append 分离，原始监听、时间戳、source/generation guard、持久化与最终 stop 刷新保持原语义，先验证限制 UI 统计发布频率是否减少 S2 的约 169 Hz 遥测/录制 UI 回调。用同一冻结基线与完整性账本复测。当前数据支持把它作为候选，不证明该优化已经有效，也不授权改动。

## 原始证据与探索历史

完整 30 项矩阵、窗口/Profiler 明细和每轮配对差值见 `runs.csv`、`windows.csv`、`profilers.csv`、`paired-common.csv`、`report.json` 与 `precise-statistics.json`。每项原始 `formal-*.json.gz` 保留独立输入账本、全部有界事件、实际 Profiler 字段、CDP 原计数、Session、文件核对、错误及清理结果；它们可重跑本轮提交的分析器。本机合成视频在隔离 OPFS 中验证，视频媒体文件本身未附在报告包中。

保留全部探索过程，不作为正式重复：首次缺少 Node transform-types 参数（只有执行者记录，无伪造机器日志）；随后首次使用弹窗阻挡连接；早版夹具定时器提前唤醒；S4 旧按钮定位超时。均已记录、修正并重新验证。六项实际复现的测量判定漏洞用失败回归修复，包括空来源、额外订阅调用、顺序和 Session/跨层因果关联；没有把这些工具漏洞写成已观察到的产品丢包。

分享包提供上一阶段与本阶段的 full-index diff、commit/tree/parent/time 元数据、tested 全部 242 个 tracked 文件的 Git blob/SHA-256 清单、当前变更源文件、完整正式原始记录、探索/重新分析和检查日志。个人本机路径在分享副本中替换；manifest 同时记录原始与分享文件的压缩/解压哈希和字节数。冻结计划引用的是原始证据哈希，分享副本变换需通过 manifest 对应，不把经过脱敏的文件声称为原文件的相同哈希。

ChatGPT 的职责是核对这份特定 source/plan/batch 的证据并生成下一步有边界的执行 Prompt。Codex 负责实施与验收；当前阶段不自动进入下一优化阶段。
