# FPVHelper 埋点实施规格（analytics tracking plan）

Generated 2026-08-31 · Status: IMPLEMENTATION SPEC · 母文档：[`strategy-review-2026-08-31.md`](strategy-review-2026-08-31.md) 第 3 章
适用范围：试点期（1 家俱乐部、≤2 台工作站）的最小可行埋点；Phase 2 事件在试点第 2 周后按需启用。

**一句话决定**：自建最小管道（`lib/analytics` 本地队列 → Vercel 上同域 `POST /api/events` 处理入口 → 独立 FPVHelper Supabase 托管的 `app_events` 表 → SQL 视图），不引入第三方分析 SDK，也不双写第三方接收方。

**上线硬前提**（先于任何 `track()` 调用）：① 错误码枚举（`lib/analytics/error-codes.ts`）；② `source` / `connection` 分离；③构建号；④ `assessTrainingSession()`；⑤客户只在 `race.fpvsuperapp.com` 产生生产事件，`helper.longxl.com` 仅内部非生产；⑥数据附件写入“假名化产品使用统计”并获书面确认；⑦新建独立 FPVHelper Supabase 并完成工程验收。任何一项未完成，生产统计保持关闭。

## 实施勘误与单一真相源

- Phase 1 是 **19 个事件名**；“17”只可表示把 `telemetry_stalled/resumed` 与 `page_hidden/visible` 各视为一个事件族后的 17 族。
- `workstation_id` 可被线下台账重新关联，是假名化 ID，不是匿名 ID。
- 事件永不含原始 `error.message`、stack、视频、原始 RC、设备名、串口名、原始 UA 或选手代号；历史代码骨架中的 raw error 字段已在本版删除。
- 唯一可执行、可部署的数据库来源是 [`supabase/migrations/20260830192551_app_events_analytics.sql`](../../supabase/migrations/20260830192551_app_events_analytics.sql)；本文不保留 SQL 副本，避免规格与实际 migration 漂移。
- 当前不做 301/308：`race.fpvsuperapp.com` 是客户生产入口，`helper.longxl.com` 是内部完整验证且强制非生产。未来停用内部入口时才另行审批 308。
- 人工 Marker 只定位 DVR 复盘时刻；视觉计圈属于独立实验，见 [`../vision-lap-experiment.md`](../vision-lap-experiment.md)。
- 工作站与俱乐部的映射只留在线下台账，不进入本数据库，也不得通过可 join 表重建；实际 migration 不包含旧 `app_workstations` 草案。
- 本文不证明 Supabase、Vercel、域名、客户书面确认或生产统计已经完成。

---

## 目标与范围

## 3.1 要回答的业务问题

这是一个单页、约 14 个按钮、一家俱乐部两台工作站的产品。"哪一页流失多"要改问"6 步漏斗死在哪一步"；"哪个按键没人点"只需盯 5 个按钮（开始记录、导出、返回演示、简洁模式、重置叠层）。埋点要回答：

1. **验收第 5 项的分子分母**：本周有多少次"点击开始记录"的尝试（含失败的）？其中多少条按 L168 有效？多少条被导出？——覆盖率是否 ≥80%。
2. **确认白录了多少**：多少未导出 Session 被确认已覆盖或卸载且无法从 IndexedDB 恢复（`session_lost`）？当前客户端没有可靠证明机制，所以该指标为 0；刷新、录制中关页和未导出仅由 `page_unloaded` 作为风险信号统计，不能算作丢失。
3. **连接失败主因**：串口失败是取消弹窗、串口被占、选错端口还是 USB 掉线？画面失败是选错设备、权限还是被 OBS/DVR 软件占用？——决定第 2–5 天修什么。
4. **静默劣化**：录制中出现了多少次数据冻结（`telemetry_stalled`）、标签页被切走多久（`page_hidden`）、遥控器失联多少次？——解释"为什么这条无效"。
5. **有效使用时长**：一次打开页面，画面 + 飞控同时在线的时间占多少？演示模式占多少？
6. **环境噪声**：多少次打开来自根本不可能成功的环境（微信内置浏览器、Safari、HTTP、视口 <1120px）？
7. **这周俱乐部到底打开没有**：决定要不要打电话。
8. **验收第 6 项的可复现记录**：任何一次故障都要能给出 `error_code + build + 时间戳 + 当时状态`。

## 3.2 工具选型结论与理由

**结论：自建最小管道，不引入第三方分析 SDK。** `lib/analytics.ts`（localStorage 队列 + `fetch keepalive` / `sendBeacon`）→ Vercel 上的同域 `app/api/events/route.ts` 处理入口（Next Route Handler，Node 运行时）→ 新建的 FPVHelper 独立 Supabase 项目托管 `app_events`。分析写入只读取 `FPVHELPER_ANALYTICS_SUPABASE_URL` 与 `FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY` 两个服务端配置，不回退到公开、通用或旧 `service_role` 变量。分析使用数据库内的受限 SQL 视图，试点期不做看板产品。

理由：
- **规模**：试点是 1 家俱乐部、2 台工作站、4 周约 16–30 条 Session、几十次页面打开，任何转化率都没有统计意义；埋点的价值在于"每一次失败都能归因"，而不是漏斗曲线。
- **数据边界**：页面文案（`flight-dashboard.tsx:277`）与报价单附件（L112）必须分别写清 Vercel 处理入口和独立 FPVHelper Supabase 境外托管存储；二者都属于数据链路。禁止第三方分析 SDK，以免未经书面确认增加新的处理方或接收方。
- **可迁移但不双写**：事件信封保持通用 `event_name` + `props` 结构；未来更换接收方必须重新审批数据附件，当前禁止 PostHog 双写和第三方 SDK。
- **与训练数据同源**：`recording_id` 贯穿 `app_events` 与未来的 `training_sessions`，验收指标可以一条 SQL 算出来（data-eng 视角）。

**中国网络考量**（必须写进实施前置）：
1. 浏览器只请求自己的域名（Vercel），可减少客户端直接依赖境外数据库，但不能据此断言中国大陆网络可达或稳定。Vercel 客户入口及其到境外 Supabase 的完整链路都必须在实际俱乐部网络与手机热点现场验证并留证。
2. 赛道网络不稳定（L48）而产品核心完全离线可用，所以埋点必须离线容忍：localStorage 队列（上限 500 条、7 天过期）、`online` 事件与每 10 秒 flush/retry、`pagehide` 用 `sendBeacon`；上线前在 DevTools 断网 → 操作 → 恢复验证补发。
3. 工作站系统时间可能不准：服务端记 `received_at`，看板以 `received_at` 校正。
4. 只有 `race.fpvsuperapp.com` 可产生生产事件；`helper.longxl.com` 强制标记为内部非生产并从试点统计排除。
5. 数据出境：Phase 1 使用随机 `workstation_id` + 枚举属性，但仍按假名化数据管理。是否需要何种合规程序由有权法律/合规负责人书面判断；本文不作“只需告知”等法律结论。
6. 开发/预览流量会污染只有一家俱乐部的数据：`VERCEL_ENV === "production"` 才发送，`hostname / vercel_env` 作为公共字段兜底过滤。

**被否决的方案**：

| 方案 | 一句话理由 |
| --- | --- |
| PostHog Cloud + `next.config` rewrites 反代（analytics-events 主推） | 31 事件 / 8 漏斗 / 5 看板 / 5 天，为"很多用户"设计；新增境外第三方接收方必须写进 L112 附件并与"不上传"文案冲突；反代依赖 Node 服务端，若后续走静态导出/桌面壳即失效。保留其事件设计精华，>5 家俱乐部时再评估。 |
| PostHog Session Replay | 与界面"不录制 · 不上传"、README:16 承诺正面冲突；2 台工作站最便宜的"回放"是创始人坐在教练旁边看前两次训练。 |
| Google Analytics 4 | 会增加未经书面确认的第三方分析处理方与 SDK；本阶段不采用。 |
| 神策 / GrowingIO | 会增加第三方处理方、合同和成本评审；本阶段不采用，也不在本文比较价格。 |
| Mixpanel / Amplitude | 会增加第三方处理方和客户端/代理链路；本阶段不采用。 |
| Vercel Web Analytics | 不属于本次已批准的事件管道；如未来启用，需先核验字段、处理链路与合同边界。 |
| Umami / Plausible | 会增加新的处理方或自托管运维面，且本阶段未完成能力验证；不作为当前事实依据。 |
| Sentry | 试点期用 `js_error` 事件走同一管道即可；许可后再评估。 |
| 在共用的 FPVSuperApp Supabase 项目里建表 | 违反你的全局规则（本仓库无 migrations）；RLS 漏洞与删除承诺无法按产品切开。 |

## 3.3 事件表

命名 `object_action` 小写下划线；属性只允许枚举/数字/布尔/哈希，**绝不上报 `error.message`/stack 原文、`device.label`、串口名、原始 UA**。Phase 1 = 起算日前上线（19 个事件名；17 个事件族）；Phase 2 = 试点第 2 周之后按需补。

| 事件名 | 触发时机 | 关键属性 | 回答什么问题 | 埋点位置（file / handler） | Phase |
| --- | --- | --- | --- | --- | --- |
| `app_opened` | `FlightDashboard` 首次 mount（`useRef` 守卫，`next.config.ts:4` StrictMode 会双触发） | `browser_family, browser_major, os_family, serial_supported, secure_context, media_supported, viewport_w, viewport_h, dpr, is_wechat, is_standalone, referrer_host` | 多少次打开来自不可能成功的环境；这周俱乐部有没有打开 | 新建 `hooks/use-analytics-lifecycle.ts`，在 `components/flight-dashboard.tsx` `FlightDashboard()` 顶部调用 | 1 |
| `video_connect_result` | `getUserMedia` 成功 `setState("live")` 前 / catch | `ok, reason(unsupported / insecure_context / permission_denied / device_not_found / device_busy / constraint_failed / aborted / unknown), device_kind(capture_card / webcam / virtual / unknown), width, height, frame_rate, latency_ms, attempt_index` | 漏斗第 2 步转化；失败主因；采集卡分辨率分布 | `hooks/use-video-capture.ts` `connect()` `:65` 与 `:67-70`，经 `classifyMediaError()` | 1 |
| `video_lost` | `MediaStreamTrack` `ended`（采集卡拔出 / 被抢占） | `live_ms, was_recording, device_kind` | 现场 HDMI/USB 掉线频率 | `hooks/use-video-capture.ts:59` 之后为 track 挂 `onended` 并置 `error` | 1 |
| `serial_connect_result` | 成功：收到首帧校验通过的 MSP_RC（每次连接一次，ref 守卫）；失败：任一失败路径 | `ok, reason(web_serial_unsupported / picker_cancelled / port_busy / open_failed / not_readable / not_writable / first_frame_timeout / device_lost / unknown), stage(unsupported / picker / open / handshake), ms_to_first_frame, usb_vendor_id, usb_product_id, attempt_index` | 漏斗第 3 步真正的转化（点击 ≠ 连上）；失败主因排名 | `hooks/use-betaflight-telemetry.ts` `applyFrame` `:156`（成功）；`:185-189`、`:229-233`（失败）；新增 `port.open` 后 5 秒首帧超时 | 1 |
| `serial_lost` | 曾 live 的连接结束 | `reason(read_error / write_error / device_disconnect / user_demo / unmount), live_ms, was_recording, rc_frames, analog_frames, checksum_errors, error_frames, effective_hz` | 一次真实连接持续多久、为何断、USB 链路质量 | `hooks/use-betaflight-telemetry.ts` `disconnect()` `:80` 开头读取计数器；`:215-218`、`:224-228`；新增 `navigator.serial` `disconnect` 监听 | 1 |
| `telemetry_stalled` / `telemetry_resumed` | 新增看门狗：`connection === "live"` 且 >1500 ms 无 RC 帧；恢复时发 resumed | `stall_ms（恢复时）, was_recording, tab_hidden, rc_frames_before` | "数据桥在线"但数据冻结了多少次；后台节流影响 | `hooks/use-betaflight-telemetry.ts` 新增 `useEffect` 看门狗，新增 connection 状态 `stale` | 1 |
| `demo_returned` | 点击"返回演示" | `was_recording, previous_connection(live / error / connecting / stale), serial_live_ms` | 主动退回，还是被"取消后冻结"逼回 | `components/flight-dashboard.tsx:199` 改为具名 `handleReturnToDemo` | 1 |
| `recording_started` | `startRecording()` | `recording_id, connection_at_start, source_at_start, video_state, athlete_set, prev_unexported, recording_index, ms_since_serial_live` | 漏斗第 4 步；L182 分母；多少记录在未连上/演示时开始 | `hooks/use-training-session.ts:39-46`（需从 dashboard 传入 `connection / videoState` 快照） | 1 |
| `recording_stopped` | `stopRecording()` | `recording_id, duration_ms, sample_count, hz, data_sources, valid, invalid_reasons[], max_gap_ms, hidden_ms, stall_count, athlete_set` | 80% 覆盖率的分子；无效原因分布 | `hooks/use-training-session.ts:48-57`，`finishTrainingSession` 后调 `assessTrainingSession()` | 1 |
| `session_exported` | 点击"导出 Session JSON"，或自动下载 / 文件夹写入成功 | `recording_id, valid, ms_since_stop, bytes, export_index, method(download / auto / folder)` | 漏斗第 6 步；结束后犹豫多久 | `hooks/use-training-session.ts:77-88` | 1 |
| `session_lost` | 仅当客户端能确认未导出 Session 已被覆盖，或卸载后无法从 IndexedDB 恢复 | `reason(overwritten / unload), recording_id, valid, duration_ms, sample_count, ms_since_stop` | 确认不可恢复的白录次数；当前没有可靠触发路径，因此为 0 | 保留严格事件合同供未来可靠检测；不能由 `recording_interrupted`、`pagehide` 或“未导出”直接触发 | 1 |
| `page_hidden` / `page_visible` | `document` `visibilitychange` | `was_recording, hidden_ms（回到可见时）, connection, video_state` | 教练是否在录制中切走标签页（节流根因） | `hooks/use-analytics-lifecycle.ts` | 1 |
| `page_unloaded` | `pagehide`（`sendBeacon`） | `page_duration_ms, is_recording, has_unexported_session, max_funnel_step(1-6), recordings_started, recordings_stopped, sessions_exported, error_count, serial_live_ms_total, video_live_ms_total` | 每次会话死在漏斗第几步 | `hooks/use-analytics-lifecycle.ts` | 1 |
| `error_shown` | `error` 或 `videoError` 从空变非空或文案变化 | `domain(serial / video), code, masked_other, shown_index, is_recording` | 错误横幅出现次数与类型；是否遮蔽了另一类错误 | `components/flight-dashboard.tsx` 新增 `useEffect` 依赖 `[error, videoError]`（横幅 `:207-212`） | 1 |
| `js_error` | `window` `error` / `unhandledrejection` / `app/error.tsx` | `name, message_hash, stack_hash, connection, video_state, is_recording` | 生产有没有不知道的崩溃（验收第 6 项） | `hooks/use-analytics-lifecycle.ts`；新建 `app/error.tsx`（Next 16 签名 `{ error, retry }`） | 1 |
| `overlay_mode_changed` | 点击"动态轨迹 / 简洁模式"且模式确实改变 | `from, to, is_recording` | 两种叠层的真实偏好 | `components/flight-dashboard.tsx:251`、`:257` 抽成 `handleOverlayMode(next)` | 1 |
| `overlay_layout_reset` | 点击"重置叠层" | `overlay_mode, was_default` | 重置按钮有没有人用、是否拖丢了才重置 | `components/flight-dashboard.tsx:262-265` | 1 |
| `video_devices_enumerated` | `refreshDevices()` 完成 | `video_input_count, labels_available, capture_card_like_count, reason(initial / devicechange / after_connect)` | 工作站是否真插了采集卡；下拉框是不是一堆"视频输入 N" | `hooks/use-video-capture.ts:26-33` `setDevices` 之后 | 2 |
| `video_device_selected` | 改变采集设备下拉框 | `device_index, device_kind, device_count, video_state_at_change` | 默认设备有多少人要手动换掉 | `components/flight-dashboard.tsx:225` `<select onChange>` | 2 |
| `video_connect_clicked` / `video_disconnect_clicked` | 点击"打开画面 / 断开画面" | `attempt_index, previous_video_state, live_ms, was_recording` | 重试次数；录制中断开 | `components/flight-dashboard.tsx:237` / `:235` | 2 |
| `serial_connect_clicked` | 点击"连接桥接飞控" | `serial_supported, secure_context, previous_connection, attempt_index, video_state` | 真实使用顺序（先画面还是先飞控） | `components/flight-dashboard.tsx:201` | 2 |
| `serial_port_selected` | `requestPort()` resolve | `picker_ms, usb_vendor_id, usb_product_id` | 选择器停留时间；桥接飞控硬件型号分布 | `hooks/use-betaflight-telemetry.ts:198` 之后（需 `lib/web-serial.d.ts` 补 `getInfo()`） | 2 |
| `serial_frame_stats` | 录制中每 30 秒或 Session 结束时汇总 | `frames_ok, checksum_errors, error_frames, resyncs, sequence_gaps, effective_hz, rtt_p95` | USB 链路质量趋势 | `hooks/use-betaflight-telemetry.ts` + `lib/telemetry.ts` 解析器计数器 | 2 |
| `link_lost` / `link_recovered` | `MSP_STATUS_EX` 的 RXLOSS 位翻转 | `is_recording, duration_ms` | 遥控器未对频 / 失联次数 | `hooks/use-betaflight-telemetry.ts`（`MSP_STATUS_EX` 轮询上线后） | 2 |
| `page_heartbeat` | 页面可见时每 60 秒 | `connection, video_state, is_recording, rc_frames_last_minute, serial_live_ms_total, video_live_ms_total, recording_ms_total` | 一次打开里"画面 + 飞控都在线"的时间占比 | `hooks/use-analytics-lifecycle.ts` 读状态快照 ref | 2 |
| `overlay_visibility_toggled` | 点击"叠层开启 / 关闭" | `visible, overlay_mode, is_recording` | 有没有人在训练时关叠层（遮挡画面） | `components/flight-dashboard.tsx:243` | 2 |
| `overlay_dragged` / `overlay_resized` | 拖动 / 缩放手柄 `pointerup` 且布局确实改变（**不在** `storeStickOverlayLayout` 埋，`:159-165` 每帧写入） | `stick, overlay_mode, from_x, from_y, to_x, to_y, from_size, to_size, pointer_type, duration_ms` | 默认布局是否遮挡画面关键区域；拖拽功能是否过度设计 | `components/draggable-stick-overlay.tsx` `endInteraction` `:168-172`，与 `startLayout` 比较 | 2 |
| `athlete_selected` | 开始记录对话框选择代号 | `athlete_code_hash（仅同意名单内）, from_recent` | 选手切换频率 | 新的开始记录对话框组件 | 2（需老板确认同意名单） |
| `marker_added` | 热键 / 按钮打 Marker | `kind, elapsed_ms, is_armed` | Marker 使用率与分布 | Marker 组件（D11–D14 上线后） | 2 |
| `session_summary_viewed` / `report_generated` | 小结卡展示 / 周报脚本运行 | `recording_id, metrics_version` | 教练是否看小结 | 小结卡组件 / 周报脚本 | 2 |
| `gamepad_detected` | `gamepadconnected` | `id_hash, axes, buttons` | 是否有遥控器以 HID 方式插入（v2 数据源评估） | 仅在评估 Gamepad 路线时加 | 2（可选） |

## 3.4 通用属性与命名规范

**事件信封**（每条必带，由 `lib/analytics/client.ts` 自动附加）：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `event_id` | `crypto.randomUUID()` | 重试幂等，服务端主键 |
| `event_name` | 白名单 | `^[a-z][a-z0-9_]{2,63}$`，`object_action` |
| `occurred_at` | 客户端墙钟 | 服务端另记 `received_at` |
| `client_monotonic_ms` | `performance.now()` | 同一 visit 内排序 |
| `workstation_id` | 首次启动生成的随机 UUID，存 localStorage `fpvhelper.workstation.v1`（IndexedDB 互备） | 假名化标识，不是机器名/序列号；与俱乐部/工作站的对应关系只在团队线下台账 |
| `visit_id` | 每次页面加载生成 | |
| `recording_id` | 正在记录或最近一条训练 Session 的 id | 与未来 `training_sessions` 关联，不加外键 |
| `build` | `NEXT_PUBLIC_APP_VERSION` = `package.json` version + `VERCEL_GIT_COMMIT_SHA` 前 7 位（`next.config.ts` 注入） | 同时显示在页脚与 JSON 顶层 |
| `hostname`, `vercel_env` | `location.hostname`, `VERCEL_ENV` | 过滤开发/预览流量 |
| `session_schema_version` | `TRAINING_SESSION_SCHEMA_VERSION` | |
| 状态快照：`connection, video_state, is_recording, overlay_mode, telemetry_source` | dashboard 状态 ref | 任何事件都能按"当时是演示还是真实"切片 |
| `club_code` | Phase 1 **不发送**；工作站与俱乐部的映射只存线下台账，不进本数据库。Phase 2 如需云端俱乐部维度，必须重新设计、评审并取得书面确认 | 见 3.7 |
| `athlete_*` | Phase 1 **不发送**；Phase 2 至多 `athlete_code_hash` 且只对同意名单内代号 | 见 3.7 |

**规范**：
- 属性值只允许枚举、数字、布尔、哈希；`props` < 4 KB；在 `lib/analytics/events.ts` 用 TypeScript 联合类型把每个事件的属性写死，非法属性编译不过。
- 错误一律先经 `lib/analytics/error-codes.ts` 映射为枚举（`DOMException.name + message` 正则），UI 中文文案与埋点共用同一张表。
- 埋点插在 hooks 的**状态迁移点**（frontend 视角），按钮只给 5 个关键按钮加 `data-track-id`（`record-toggle / session-export / demo-return / overlay-mode-simple / overlay-reset`）用于 QA 定位；关闭任何 autocapture。
- "真实数据"一律以 `connection === "live"` 判定，不以 `source === "serial"` 判定（C4）。

## 3.5 漏斗定义

| 漏斗 | 步骤（事件 / 条件） | 回答什么 | 主要流失假设（来自代码） | Phase |
| --- | --- | --- | --- | --- |
| F1 核心激活（= 验收路径） | `app_opened` → `video_connect_result(ok)` → `serial_connect_result(ok)` → `recording_started(connection_at_start=live)` → `recording_stopped(valid=true)` → `session_exported`（同一 `recording_id`） | 每次会话走到第几步 | 1→2 默认选中内置摄像头且无设备名（`use-video-capture.ts:32`）；2→3 串口被 Configurator 占用、选错口永远"正在连接"、Safari/HTTP 无 `navigator.serial`；3→4 不知道要点"开始记录"；4→5 切标签页节流、中途断线、录不到 60 秒；5→6 忘导出就刷新（`README.md:45`） | 1 |
| F2 画面接入 | `app_opened` → `video_devices_enumerated(count>0)` → `video_connect_result(ok, device_kind=capture_card)` | 采集卡是否插上、第一次打开的是不是摄像头 | 0 个设备 = 没插卡/驱动；先打开 webcam 再换设备；`NotReadableError` = 被 OBS/DVR 软件占用 | 1（第 2 步 Phase 2） |
| F3 桥接飞控连接（点击 ≠ 连上） | `serial_connect_clicked` → `serial_port_selected` → `serial_connect_result(ok)` → 连续 live ≥60 秒且 `stall_count=0` | 选择器、打开、首帧、稳定四段各丢多少 | 端口名分不清直接取消；被占用 open 失败；选错口永不回帧；USB 线/供电导致 `device_lost` | 1（前两步 Phase 2） |
| F4 记录质量（有效 Session 覆盖率） | `recording_started` → `recording_stopped` → `recording_stopped(valid)` → `session_exported` → 台账关联代号 | L182 核心指标 | 录制中关页；demo 来源；太短；后台节流样本不够；混合来源；导出按钮在页面最底部 | 1 |
| F5 周留存（按 `workstation_id`） | 第 N 周 `app_opened` → 第 N 周 `recording_started(live)` ≥2 → 第 N 周 `valid` ≥2 → 第 N+1 周 `app_opened` | 验收第 4 项"每周至少 2 次" | 第一周新鲜感后没有周报把数据变成"看得见的进步"（L59）；硬件摩擦（每次插卡+插飞控+选设备+选端口） | 1 |
| F6 错误恢复 | `serial_connect_result(ok=false)` 或 `video_connect_result(ok=false)` → 5 分钟内再次 `*_connect_result` → `ok=true` | 错误后重试率与重试成功率 | 英文 DOMException 看不懂；取消后冻结在 serial 唯一出路"返回演示"在 ≤720px 被隐藏（`globals.css:526`） | 1 |
| F7 演示误用（反向） | `app_opened` → `recording_started(source_at_start=demo)` → `recording_stopped(data_sources=[demo])` → `session_exported(valid=false)` | 演示数据被当真实导出的次数 | 状态条 ≤1120px 隐藏（`globals.css:505`），看不出自己在演示 | 1 |
| F8 叠层自定义 → 真实使用 | `app_opened` → `overlay_*` 任一 → `recording_started(live)` | 叠层拖拽是否过度设计；默认布局是否挡画面 | | 2 |

## 3.6 每周看板

试点期不做看板产品：在 Supabase SQL 编辑器保存以下视图，每周一看一次并把 D1 的数字直接抄进周报。

| 看板 | 每周一要回答的问题 | 数据来源 | 形式 |
| --- | --- | --- | --- |
| D1 试点验收周报（对应 L154-159 / L182） | 活跃工作站数（≥1 且 ≤2）；训练尝试数（`recording_started` 且 `connection_at_start=live`）≥2；有效覆盖率 = `recording_stopped(valid)` / 尝试数 ≥80%；导出率；确认不可恢复的 `session_lost` 次数（无可靠触发时为 0）；无效原因分布；4 周趋势 | `app_events` | SQL 视图 `weekly_workstation_funnel`（见 3.8） |
| D2 连接健康 | 串口/画面成功率与 `reason` 排名；`ms_to_first_frame` P50/P95；`telemetry_stalled` 次数与其中 `tab_hidden=true` 占比；`serial_lost.reason` 分布；`checksum_errors` 均值；`video_lost` 次数；按 `browser_family / secure_context` 拆分 | `serial_connect_result`, `video_connect_result`, `serial_lost`, `video_lost`, `telemetry_stalled` | SQL |
| D3 流失与漏斗 | F1 六步转化；`page_unloaded.max_funnel_step` 分布；`is_recording=true` / `has_unexported_session=true` 的关页风险次数（不等于丢失）；`recording_stopped.invalid_reasons` 中的中断结束数（也不等于丢失）；F6 重试率；`serial_live_ms_total / page_duration_ms` 比例 | `page_unloaded`, `recording_stopped.invalid_reasons`, `session_lost` | SQL |
| D4 功能使用（"哪个按键没人点"） | 5 个关键按钮的点击次数与使用它们的工作站数；`overlay_mode` 时长占比；`demo_returned.previous_connection` 分布（主动 vs 被逼） | `recording_started`, `session_exported`, `demo_returned`, `overlay_mode_changed`, `overlay_layout_reset` | SQL |
| D5 环境与兼容 | `browser_family / os_family` 分布；`serial_supported=false`、`secure_context=false`、`is_wechat=true` 的会话数；`viewport_w<1120` 占比；`hostname` 分布；`build` 分布（旧缓存是否残留） | `app_opened` | SQL |

每次故障的"可复现记录" = 该 `workstation_id` 在故障时刻前后 10 分钟的事件时间线（按 `client_monotonic_ms` 排序）+ `build`，一条 SQL 即可导出附在台账。

## 3.7 隐私与合规规则

1. **假名化 ID**：`workstation_id` 是随机 UUID，不含机器名/序列号/MAC/指纹，但可由团队线下台账重新关联；映射永远不写进事件表或可 join 的外键。
2. **不采姓名**：任何时候不采集姓名、手机、邮箱、原始 UA、`device.label`、串口名、`error.message` 原文、Binding phrase（`docs/hardware-architecture.md:56`）、20 Hz 打杆样本、视频帧、串口原始字节。`error_message` 只保留分类枚举；设备只保留 `device_kind` 与 USB VID/PID。
3. **选手代号**：Phase 1 事件设计上不含姓名或选手代号；这不替代对假名化工作站数据、平台日志及未成年人场景的法律判断。Phase 2 若引入 `athlete_code_hash`，前端只接收“已取得监护人同意的代号列表”（L113），未同意代号不得出现在任何事件或云端摘要里。
4. **未成年人与出境**：敏感信息、PIA、跨境机制与平台日志保留应由有权法律/合规负责人结合主体和地区书面判断；本文不提供法律意见。选手档案上云前必须另行审查。Route Handler 不主动落 IP/UA，平台日志边界仍需核验并写入附件。
5. **报价单附件必须写的一行**（L112 要求“采集字段、用途、处理方/托管方、访问人、保留期、删除方式”）：“假名化产品使用统计：操作事件、设备环境类别、分类错误码、Session 时长与样本数统计；不含画面、原始 RC、选手代号或原始错误文本；经 Vercel 同域入口处理后写入境外托管的独立 FPVHelper Supabase；平台日志边界、访问人、保留期与删除方式以最终书面附件为准；工作站可关闭统计。”书面确认、独立项目和工程验收完成前保持关闭；`?analytics=off` 是否作为最终关闭机制须由工程实现与验收确认。
6. **界面与文档同步**：文案改为"视频与原始 RC 不上传；假名化使用统计在书面确认后可启用并可关闭"；README 增加「离开本机的数据」表，`hardware-architecture.md` 引用该表，同一口径复制进附件。
7. **保留与删除**：`app_events` 90 天（覆盖 4 周试点 + 复盘）；试点结束 30 天内俱乐部未转年许可则删除该 `workstation_id` 全部事件（一条 SQL）；聚合后的周报数字不含标识可长期保留；本地离线队列上限 500 条、7 天过期。
8. **工程约束**：不引入第三方分析 SDK 写进 `CLAUDE.md`；`VERCEL_ENV !== "production"` 不上报；Route Handler 在接受任何事件行前校验受控 ingest token，并执行严格事件名/属性白名单、批量 ≤50、请求体与单条属性大小限制、时间窗校验、幂等去重和限速；Preview 访问保护是否可用、如何配置需按实际 Vercel 项目与方案现场核验。
9. **JSON 文件里的代号**：Session JSON 内含 `athleteCode` 与 `notes` 后属于假名化数据，README 注明"请按俱乐部内部规则保管"；`consentRef`（监护人同意单编号）留在台账不进文件。

## 3.8 实施步骤

**前置（D1，创始人）**：新建 FPVHelper 独立 Supabase 项目；Vercel 只配置 `FPVHELPER_ANALYTICS_SUPABASE_URL` 与 `FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY`，密钥永远不加 `NEXT_PUBLIC_` 前缀且值不进对话/文件/commit；不得复用其他项目的 `NEXT_PUBLIC_SUPABASE_URL`、通用 `SUPABASE_URL / SUPABASE_SECRET_KEY` 或旧 `SUPABASE_SERVICE_ROLE_KEY`；另配置受控 ingest token 与统计开关；核验 System Environment Variables 和 `VERCEL_GIT_COMMIT_SHA`；客户域固定为 `race.fpvsuperapp.com`。

**文件级改动清单**

| 文件 | 新建/修改 | 做什么 |
| --- | --- | --- |
| `lib/analytics/events.ts` | 新建 | 全部事件名与属性的 TS 联合类型（本 tracking plan 的代码化版本） |
| `lib/analytics/client.ts` | 新建 | `track() / flush() / optOut()`；生成并持久化 `workstation_id`、`visit_id`；localStorage 队列（500 条 / 7 天）；20 条或 10 秒冲刷；`online` 重放；`pagehide` 用 `sendBeacon`；SSR / 测试 / 非 production 时 no-op |
| `lib/analytics/error-codes.ts` + `.test.ts` | 新建 | `classifySerialError() / classifyMediaError()`：`DOMException.name + message` → 枚举 + 中文下一步文案；vitest 覆盖 NotFoundError / NetworkError / InvalidStateError / NotAllowedError / NotReadableError / OverconstrainedError |
| `lib/training-session.ts` + `.test.ts` | 修改 | `assessTrainingSession(session): { valid, reasons[] }` 纯函数（L168 逐子句）；schema v2 字段；`parseTrainingSession()` 兼容 v1；`serializeTrainingSession` 去掉 pretty print；补 3–5 个用例 |
| `hooks/use-analytics-lifecycle.ts` | 新建 | `app_opened`（含微信/浏览器检测）、`page_hidden/visible`、`page_unloaded`、`js_error`；`beforeunload` 在录制中或有未导出记录时 `preventDefault` |
| `app/api/events/route.ts` | 新建 | `POST`，Node 运行时；接受 `application/json` 与 `sendBeacon` 的 `text/plain`；校验白名单与批量上限；剥 IP/UA；独立项目 secret key 写入；每 token + 工作站在数据库内原子限流，超限返回 429 + `Retry-After`，成功返回 204 |
| `lib/supabase/analytics-admin.ts` | 新建 | `import "server-only"` 的独立分析项目 secret-key 客户端，只被 Route Handler 引用 |
| `supabase/migrations/20260830192551_app_events_analytics.sql` | 已实现 | 唯一可执行、可部署的数据库 migration；部署与审查都直接读取该文件 |
| `app/error.tsx` | 新建 | Next 16 错误边界（`{ error, retry }`），上报 `js_error` |
| `next.config.ts` | 修改 | `env.NEXT_PUBLIC_APP_VERSION`、`NEXT_PUBLIC_ANALYTICS_ENABLED`（仅 `VERCEL_ENV === "production"`） |
| `.env.example` | 修改 | 独立分析项目只写 `FPVHELPER_ANALYTICS_SUPABASE_URL=` 与 `FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY=`（值留空，仅 Vercel 服务端）；不回退通用/旧项目变量；统计开关与 ingest token 均不写真实值 |
| `package.json` | 修改 | `npm i server-only`；`version` 随发布递增 |
| `hooks/use-betaflight-telemetry.ts` | 修改 | `error` 改 `{ code, message }`；`source` 只在首帧后切 serial；`NotFoundError` 视为取消；1.5 秒看门狗 + `stale` 状态 + 首帧超时；`navigator.serial` `disconnect` 监听；RC/ANALOG/checksum/error 帧计数 ref；在 `:156 / :185 / :215 / :224 / :229 / :118` 处 `track()` |
| `hooks/use-video-capture.ts` | 修改 | `error` 改 `{ code, message }`；`:65 / :67` 处 `track()`（含 `getSettings()`）；`:59` 后 `track.onended` |
| `hooks/use-training-session.ts` | 修改 | 接收 `connection / videoState` 快照；`recording_started / stopped / session_exported`；返回 `hasUnexportedSession`；中断不进入 `session_lost`，可观测的中断结束由 `recording_stopped.invalid_reasons` 表达 |
| `lib/telemetry.ts` | 修改 | `MspV1StreamParser` 增加 `checksumErrorCount / errorFrameCount`（`:93` 分支） |
| `lib/web-serial.d.ts` | 修改 | `getInfo(): { usbVendorId?, usbProductId? }`；`Serial.addEventListener("disconnect" / "connect")`；`navigator.serial.getPorts()` |
| `components/flight-dashboard.tsx` | 修改 | 5 个关键按钮改具名 handler + `data-track-id`；错误横幅按 `code` 显示中文并 `error_shown`；接入 `useAnalyticsLifecycle`；页脚显示 `build`；改 `:277 / :332 / :403` 文案；状态 chip 全断点保留 |
| `README.md` | 修改 | 「离开本机的数据」表；「使用统计」小节（采什么、不采什么、如何关闭） |
| `CLAUDE.md` | 修改 | 项目用途 / 技术栈 / 两个域名哪个正式 / Supabase 项目归属与 migrations 位置 / 凭证只在 Vercel 与 `.env.local` / 禁止事项（不引入第三方分析 SDK；不在本仓库改共用 Supabase） |

**Supabase migration 来源**：不要从本文复制或执行 SQL。新建的独立 FPVHelper Supabase 只部署并审查 [`supabase/migrations/20260830192551_app_events_analytics.sql`](../../supabase/migrations/20260830192551_app_events_analytics.sql)；历史最小草案已删除。

**工作量**（人日）

| 阶段 | 内容 | 天 |
| --- | --- | --- |
| 前置改动 | 错误码枚举 + 看门狗 + `source/connection` 分离 + `assessTrainingSession()`（已计入第 4 章 Now-A 的守卫项） | 1.5 |
| Phase 1 埋点本体 | `lib/analytics/*`、lifecycle hook、Route Handler、SQL、`build` 注入、5 个 handler、文案、README | 1.5 |
| 埋点验收 | 在真实 Chrome + 采集卡 + 桥接飞控上把 19 个 Phase 1 事件名各触发一次，含拔线、取消选择器、后台标签页、录制中关页四条异常路径；断网补发验证；写一页中文"埋点验收记录"附在台账 | 0.5 |
| Phase 2 | 第 2 周后按需：设备枚举、点击事件、帧统计、heartbeat、叠层拖拽、Marker、athlete_hash（需同意名单） | 2–3 |

## 3.9 现有代码中妨碍埋点的地方及先改什么

按顺序改，前 4 项是埋点上线的硬前提：

1. **错误是自由字符串**（`use-betaflight-telemetry.ts:32/:227/:232`、`use-video-capture.ts:69`）→ 先做 `error-codes.ts`，否则 `reason` 字段没有来源。
2. **`source` 在 `requestPort` 前就切 serial**（`:191-198`）→ 先分离 `source / connection`，否则"真实数据时长"把取消后的冻结时间算进去，`recording_started.connection_at_start` 也无意义。
3. **没有 `build` 号**（`package.json:3` 未引用，`next.config.ts` 无 env）→ 注入 `NEXT_PUBLIC_APP_VERSION`，否则任何事件都无法按发布切片。
4. **没有有效性函数**（`lib/training-session.ts:109-135`）→ `assessTrainingSession()` 是 `recording_stopped.valid` 的唯一来源；未来若实现可证明的 `session_lost`，才可复用同一判定，不能从 `pagehide` 推断丢失。
5. **没有看门狗**（`:156` 永不回退）→ `telemetry_stalled` 与 `serial_connect_result(first_frame_timeout)` 需要它。
6. **解析器无计数器**（`lib/telemetry.ts:93-95`、hook `:177`）→ 两个 ref 计数器，一行改动 + 一个测试。
7. **`web-serial.d.ts` 缺 `getInfo / disconnect`** → 否则拿不到 VID/PID，拔线只能等写入失败。
8. **10 个 onClick 全是内联闭包**（`flight-dashboard.tsx:194/199/201/235/237/243/251/257/262/405`），按钮文案随状态切换（`:196`、`:244`）→ 只把 5 个关键按钮抽成具名 handler；其余在 hook 状态迁移点埋，不碰。
9. **StrictMode 双 mount**（`next.config.ts:4`）→ `app_opened` 用 ref 守卫。
10. **叠层每帧写 localStorage**（`draggable-stick-overlay.tsx:159-165`、`:126-134`）→ 绝不在 `storeStickOverlayLayout` 埋点，Phase 2 只在 `endInteraction` 比较起止布局。
11. **两个域名（已拍板）**→ `race.fpvsuperapp.com` 才能产生生产事件；`helper.longxl.com` 内部非生产。当前不重定向，未来停用内部入口时再审批 308。
12. **`server.ts` 依赖未在 `package.json` 声明的 `server-only`**（Next 构建有别名，vitest 没有）→ Route Handler 的测试一旦 import 相关模块就会 `MODULE_NOT_FOUND`；`npm i server-only`。

---

## 附录 A · 技术骨架（analytics-infra agent 独立核实；与 3.2 结论一致）

analytics-infra 在没有看到合成文档的情况下独立得出同一技术方向：**自建管道 → 同域 Vercel Route Handler 处理入口 → 独立 FPVHelper Supabase 托管，RLS 开且零策略，不接第三方 SDK**。历史工时估算不构成排期承诺。本附录收录它补充的参数与代码骨架；外部云服务行为、区域与方案必须在实施时重新核验。命名已统一为本文档口径：表 `app_events`；ID 三层 `workstation_id / visit_id / recording_id`（刻意避开 "session" 一词，以免与训练 Session 混淆）；事件名以 3.3 事件表为准。

### A.1 为什么必须走同域 Route Handler，而不是浏览器直连 Supabase

1. **减少客户端直接依赖**：浏览器 → 同域 Vercel 函数 → 境外 Supabase 可避免浏览器直接携带数据库连接配置，但不代表链路“不过墙”或已经可用。中国大陆到客户域、Vercel 函数再到 Supabase 的实际可达性、延迟与稳定性必须在现场网络验证；社区讨论不能替代服务商承诺或真机证据。
2. **`navigator.sendBeacon` 不能设置 `apikey` / `Authorization` 头**：直连 Supabase REST 时，页面关闭前的最后一批要么丢，要么把 key 塞进 URL 进日志。同域端点接受 `text/plain`，无 CORS 预检，`sendBeacon` 直接可用。
3. **凭据边界**：直连要把 publishable key + RLS insert 策略暴露给任何人，垃圾数据只能靠 CHECK 兜底；Route Handler 让浏览器 bundle 里不含任何 Supabase 凭据，服务端统一校验（白名单 / UUID / 时间窗 / 大小 / 批数），补 `country`（仅两位国家码，不存 IP）与 `clock_offset_ms`，并用 `upsert(onConflict: event_id, ignoreDuplicates)` 幂等去重。
4. 第三方分析/错误上报产品的区域、可达性、合同和字段边界均未在本项目核验；无论供应商是谁，未经新的数据附件和工程审批都不得接入。
5. **Vercel 函数区域**：项目当前区域、可选区域与方案限制均需从实际项目和服务商文档核验；确认 Supabase 项目区域后再选择函数区域，并用现场请求记录评估链路延迟，本文不预设区域或延迟数字。

### A.2 三层 ID 模型

| ID | 生命周期 | 生成与存储 | 说明 |
| --- | --- | --- | --- |
| `workstation_id` | 工作站（清除数据 / 重装 / 换 Profile 即新实例，与定价文档 L166 定义一致） | UUID v4，localStorage `fpvhelper.workstation.v1`，首次运行生成；localStorage 不可用时用内存临时 ID 并在 `app_opened` 带 `workstation_persisted=false` | 前 8 位显示在页脚，试点期由团队登记到受控线下台账（`workstation_id` → 俱乐部）；该映射不进入本数据库、事件属性或任何可 join 表。将来若把许可激活与该 ID 关联，须单独评审。 |
| `visit_id` | 一次页面加载 | 模块级变量 UUID + `seq`（visit 内单调递增），时钟不准时也能排序 | `app_opened` 是第一条，`page_hidden` / `page_unloaded` 是最后一条（可能重复，无妨） |
| `recording_id` | 一次训练记录 | 直接复用 `TrainingSession.id`；`startRecording` 时 `setContext({ recordingId })`，`stopRecording` 时置 null | `recording_started → page_heartbeat×N → recording_stopped → session_exported` 按它串成一条；导出文件名里的 shortId 也能对上台账 |

时间字段：`client_ts = Date.now()`（可能不准）、`mono_ms = performance.now()`（visit 内单调）、`received_at` 服务端 `now()`、`clock_offset_ms = 服务端收到时间 − 批的 sent_at`（整批共享），分析时可校正。

### A.3 队列与批处理参数

- 遥测样本永远不进埋点：`applyFrame` 与 demo 定时器都是 50 ms 路径，任何放在渲染路径上的 `track()` 都会每秒打 20 次。高频信号折成计数器（`rcFramesRef`、解析器 `droppedFrames`），由 `page_heartbeat` 每 60 秒（仅 `visibilityState === "visible"`）带走并清零：`rc_frames_60s / dropped_frames_60s / observed_hz`。
- 批处理：队列 ≥20 条立即 flush，否则 10 秒定时；`js_error / recording_stopped / session_exported` 标 `urgent` 立即 flush；单批 ≤40 条且 JSON ≤32 KB（`sendBeacon` 64 KiB 上限留一半），超出自动拆批；`props` 单条 ≤2 KB（客户端截断）/ ≤4 KB（服务端与 CHECK 拒绝）。
- 去重："宁可重发、不可丢"——`event_id` 客户端生成，服务端 `ignoreDuplicates`；beacon 路径发完**不出队**，下次打开页面再 fetch 补发，重复由数据库吸收。
- 出队按 `event_id` 集合，不按数量（发送期间可能有新事件入队）；`inflight` 单飞标志防并发；4xx（400 / 413 / 422）视为毒数据丢弃，5xx / 429 保留并指数退避（5 s → 5 min）。
- 离线队列上限 500 条 FIFO（约 200 KB localStorage）；`online` 事件触发立即重放。
- 叠层拖动只在 `endInteraction` 上报并 2 秒节流；`continueInteraction`（每个 pointermove）绝不埋。

### A.4 成本估算

容量模型只用于 sizing，不是价格或套餐承诺：按“工作站数 × 每周会话数 × 单次事件数 + heartbeat”估算月事件量，再用真实样本测量平均行大小、索引膨胀与函数调用数。实施前必须在实际 Supabase/Vercel 项目核对当时的配额、备份、暂停、商用与计费条款，并由有权负责人选择方案；本文不声明任何当前价格、免费额度或升级阈值。

### A.5 错误上报

试点期错误走同一条管道（`js_error`），`props` 只允许 `{ kind, name, message_hash, stack_hash, breadcrumbs(事件名), src_category }`；禁止原始 message、stack、URL、文件路径和用户输入。四个来源可记录分类码；对 `DOMException` 只记录白名单 `error.name` 和阶段。服务端异常只记录内部分类码。当前禁止 Sentry 或其他第三方 SDK；未来变更需重新审批数据附件。

### A.6 新增风险（合成文档未列）

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| Supabase 项目可能因方案或状态不可用 | `/api/events` 返回 5xx，离线队列持续增长 | 先从实际项目与服务商文档核验暂停/恢复规则；客户端退避重试，运营台账记录不可用时段；不得为 keep-alive 或升级方案作未审批承诺 |
| Vercel 函数区域与 Supabase 区域不一致 | 每批多一次跨洋往返 | `vercel.json` `regions` 对齐 Supabase 区域 |
| `lib/supabase/server.ts` 不能作为写入端 | 它用 publishable key + cookie，写入会被零策略 RLS 拒绝 | 新建 `lib/supabase/analytics-admin.ts`（`server-only`，只读取 `FPVHELPER_ANALYTICS_SUPABASE_URL / FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY`，`persistSession: false`；不兼容回退其他项目变量） |

### A.7 代码骨架

事件名已改为 3.3 表的规范名；`ua` 已按 3.7 去掉。以下仅展示数据形状，**不能直接部署**：实际 Route Handler 必须在接受任何事件行前完成受控 ingest token 的签发/轮换/校验，并按事件名执行严格属性白名单；token 的传输机制和撤销方式须在工程评审中确定，不在本文伪造。

```ts
// lib/analytics.ts — 浏览器专用，零依赖；服务端代码不得 import。
import { ANALYTICS_EVENT_NAMES, type AnalyticsEventName } from "@/lib/analytics/events";

export type AnalyticsProps = Record<string, string | number | boolean | null>;
export interface AnalyticsEvent {
  event_id: string;          // crypto.randomUUID()，服务端按它幂等去重
  event_name: AnalyticsEventName;
  client_ts: number;         // Date.now()
  mono_ms: number;           // performance.now()，visit 内排序
  seq: number;               // visit 内单调递增
  workstation_id: string;
  visit_id: string;
  recording_id: string | null;
  props: AnalyticsProps;
}

const ENDPOINT = "/api/events";
const QUEUE_KEY = "fpvhelper.analytics.queue.v1";
const WORKSTATION_KEY = "fpvhelper.workstation.v1";
const BATCH_SIZE = 20;            // 攒够 20 条立即发
const FLUSH_INTERVAL_MS = 10_000; // 否则每 10s 发一次
const MAX_QUEUE = 500;            // 离线队列上限，FIFO 丢最旧（约 200KB localStorage）
const MAX_BATCH_BYTES = 32_000;   // sendBeacon 64KiB 上限留一半
const MAX_PROPS_BYTES = 2_000;
const POISON_STATUSES = new Set([400, 413, 422]); // 校验失败：丢弃不重试

const state = {
  ctx: { workstationId: "", visitId: "", recordingId: null as string | null, appVersion: "" },
  queue: [] as AnalyticsEvent[],
  seq: 0,
  inflight: false,
  backoffMs: 0,
  timer: 0,
  breadcrumbs: [] as string[],
  throttleAt: new Map<string, number>(),
};

function readJson<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额/隐私模式：仅内存 */ }
}

/** 同步、< 1ms：只读两个 localStorage key。由 instrumentation-client.ts 在 hydration 前调用。 */
export function init(opts: { appVersion: string }) {
  if (typeof window === "undefined" || state.ctx.visitId) return;
  let workstationId = readJson<string | null>(WORKSTATION_KEY, null);
  if (!workstationId) { workstationId = crypto.randomUUID(); writeJson(WORKSTATION_KEY, workstationId); }
  state.ctx = { workstationId, visitId: crypto.randomUUID(), recordingId: null, appVersion: opts.appVersion };
  state.queue = readJson<AnalyticsEvent[]>(QUEUE_KEY, []);          // 上次没发出去的
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { track("page_hidden", {}); flush({ beacon: true }); }
  });
  window.addEventListener("pagehide", () => flush({ beacon: true }));
  window.addEventListener("online", () => scheduleFlush(0));
  scheduleFlush(FLUSH_INTERVAL_MS);
}

export function setContext(patch: Partial<typeof state.ctx>) { Object.assign(state.ctx, patch); }
export function getWorkstationId() { return state.ctx.workstationId; }

export function track(name: AnalyticsEventName, props: AnalyticsProps = {}, opts: { urgent?: boolean } = {}) {
  if (!state.ctx.visitId || !ANALYTICS_EVENT_NAMES.has(name)) return;
  const event: AnalyticsEvent = {
    event_id: crypto.randomUUID(), event_name: name, client_ts: Date.now(), mono_ms: performance.now(),
    seq: state.seq++, workstation_id: state.ctx.workstationId, visit_id: state.ctx.visitId,
    recording_id: state.ctx.recordingId, props: clampProps(props),
  };
  state.queue.push(event);
  if (state.queue.length > MAX_QUEUE) state.queue.splice(0, state.queue.length - MAX_QUEUE);
  state.breadcrumbs = [...state.breadcrumbs.slice(-19), name];
  writeJson(QUEUE_KEY, state.queue);
  if (opts.urgent || state.queue.length >= BATCH_SIZE) scheduleFlush(0);
}

/** 噪声型 UI 事件（叠层拖动结束等）：每个事件名最多 windowMs 一次。 */
export function trackThrottled(name: AnalyticsEventName, props: AnalyticsProps = {}, windowMs = 2_000) {
  const now = Date.now();
  if ((state.throttleAt.get(name) ?? 0) + windowMs > now) return;
  state.throttleAt.set(name, now);
  track(name, props);
}

export function trackError(kind: string, error: unknown, extra: AnalyticsProps = {}) {
  const e = error instanceof Error ? error : new Error(String(error));
  track("js_error", {
    kind, name: e.name, raw_error_omitted: true,
    breadcrumbs: state.breadcrumbs.join(">"), ...extra,
  }, { urgent: true });
}

function scheduleFlush(delayMs: number) {
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(() => void flush(), delayMs);
}

export async function flush(opts: { beacon?: boolean } = {}) {
  if (state.queue.length === 0) { scheduleFlush(FLUSH_INTERVAL_MS); return; }
  const batch = takeBatch();
  const body = JSON.stringify({ sent_at: Date.now(), app_version: state.ctx.appVersion, events: batch });
  if (opts.beacon) {
    // 页面即将关闭：发了就走，但不出队。下次打开再 fetch 补发一次，重复由服务端 event_id 去重吸收。
    navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
    return;
  }
  if (state.inflight || !navigator.onLine) return;
  state.inflight = true;
  try {
    const res = await fetch(ENDPOINT, { method: "POST", body, headers: { "content-type": "text/plain" }, keepalive: true });
    if (res.ok || POISON_STATUSES.has(res.status)) {
      const sent = new Set(batch.map((e) => e.event_id));
      state.queue = state.queue.filter((e) => !sent.has(e.event_id)); // 按 id 出队，不按数量
      writeJson(QUEUE_KEY, state.queue);
      state.backoffMs = 0;
    } else {
      throw new Error(`HTTP ${res.status}`);                           // 5xx/429：保留，退避重试
    }
  } catch {
    state.backoffMs = Math.min(state.backoffMs ? state.backoffMs * 2 : 5_000, 300_000);
  } finally {
    state.inflight = false;
    const hasMore = state.queue.length >= BATCH_SIZE && state.backoffMs === 0;
    scheduleFlush(hasMore ? 0 : Math.max(FLUSH_INTERVAL_MS, state.backoffMs));
  }
}

function takeBatch() {
  const out: AnalyticsEvent[] = [];
  let bytes = 0;
  for (const e of state.queue) {
    const size = JSON.stringify(e).length;
    if (out.length >= BATCH_SIZE * 2 || bytes + size > MAX_BATCH_BYTES) break;
    out.push(e); bytes += size;
  }
  return out.length ? out : state.queue.slice(0, 1); // 单条超限也要能发出去（服务端会 413/422 丢弃）
}

function clampProps(props: AnalyticsProps): AnalyticsProps {
  const s = JSON.stringify(props);
  return s.length <= MAX_PROPS_BYTES ? props : { _truncated: true, preview: s.slice(0, MAX_PROPS_BYTES) };
}
// lib/analytics/events.ts —— 客户端与 Route Handler 共用的唯一白名单；migration 里 seed 同一份。
// 事件名以本文档 3.3 事件表为准（Phase 1 + Phase 2），不要在这里发明新名字。

```

```ts
// instrumentation-client.ts（仓库根目录，与 app/ 同级）
// Next 16 约定：HTML 加载后、hydration 前同步执行；只做同步、<16ms 的初始化。
import { init, track, trackError } from "@/lib/analytics";

try {
  init({ appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev" }); // next.config.ts 里从 VERCEL_GIT_COMMIT_SHA 注入
  track("app_opened", {
    host: location.host,                                           // 只有 race 允许 production；helper 强制 internal
    serial_supported: "serial" in navigator,                       // Web Serial 只在桌面 Chrome/Edge
    media_supported: Boolean(navigator.mediaDevices?.getUserMedia),
    secure_context: window.isSecureContext,                        // http 打开会导致两个 API 都不可用
    screen: `${screen.width}x${screen.height}`,
    lang: navigator.language,
    referrer_host: document.referrer ? new URL(document.referrer).host : "",
  });
  window.addEventListener("error", (event) =>
    trackError("window_error", event.error ?? event.message, { src: `${event.filename}:${event.lineno}` }));
  window.addEventListener("unhandledrejection", (event) => trackError("unhandled_rejection", event.reason));
} catch {
  // 埋点永远不能拖垮仪表盘
}

// 目前是单页；等 /admin 或 /session/[id] 出现时自动生效。
export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse") {
  track("route_navigated", { path: new URL(url, location.origin).pathname, type: navigationType });
}
```

```ts
// app/api/events/route.ts
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/analytics-admin"; // server-only；FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY，无 cookie
import { ANALYTICS_EVENT_NAMES } from "@/lib/analytics/events";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 50;
const MAX_PROPS_BYTES = 4096;
const MIN_CLIENT_TS = Date.parse("2026-01-01T00:00:00Z");
const MAX_FUTURE_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function POST(request: Request) {
  const text = await request.text();             // sendBeacon 发的是 text/plain：不看 content-type，自己 parse
  if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }
  if (!isObject(body) || !Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS) {
    return NextResponse.json({ error: "bad_batch" }, { status: 400 });
  }

  const now = Date.now();
  const clockOffsetMs = typeof body.sent_at === "number" ? Math.round(now - body.sent_at) : null;
  const appVersion = typeof body.app_version === "string" ? body.app_version.slice(0, 40) : null;
  const country = request.headers.get("x-vercel-ip-country")?.slice(0, 2) ?? null; // 不存 IP，不存原始 UA（3.7）
  const hostname = typeof body.hostname === "string" ? body.hostname.slice(0, 80) : null;
  const vercelEnv = process.env.VERCEL_ENV ?? "development";

  const rows = [];
  for (const e of body.events) {
    if (!isObject(e)) continue;
    const props = isObject(e.props) ? e.props : null;
    const ok =
      typeof e.event_id === "string" && UUID.test(e.event_id) &&
      typeof e.workstation_id === "string" && UUID.test(e.workstation_id) &&
      typeof e.visit_id === "string" && UUID.test(e.visit_id) &&
      (e.recording_id == null || (typeof e.recording_id === "string" && UUID.test(e.recording_id))) &&
      typeof e.event_name === "string" && ANALYTICS_EVENT_NAMES.has(e.event_name as never) &&
      Number.isInteger(e.seq) && (e.seq as number) >= 0 &&
      typeof e.client_ts === "number" && e.client_ts >= MIN_CLIENT_TS && e.client_ts <= now + MAX_FUTURE_MS &&
      props !== null && JSON.stringify(props).length <= MAX_PROPS_BYTES;
    if (!ok) continue;                             // 坏行跳过，好行照收；数量在响应里返回便于排查
    rows.push({
      event_id: e.event_id, event_name: e.event_name, seq: e.seq,
      client_ts: new Date(e.client_ts as number).toISOString(),
      mono_ms: typeof e.mono_ms === "number" && e.mono_ms >= 0 ? e.mono_ms : null,
      workstation_id: e.workstation_id, visit_id: e.visit_id, recording_id: e.recording_id ?? null,
      props, build: appVersion, hostname, vercel_env: vercelEnv, country, clock_offset_ms: clockOffsetMs,
    });
  }
  if (rows.length === 0) return NextResponse.json({ error: "no_valid_events" }, { status: 422 });

  // 幂等：event_id 冲突直接忽略。beacon 补发、双开标签页产生的重复都在这里被吸收。
  const { error } = await createAdminClient()
    .from("app_events")
    .upsert(rows, { onConflict: "event_id", ignoreDuplicates: true });
  if (error) {
    console.error("analytics insert failed", error.code); // 不记录 raw error message；客户端凭状态码决定是否出队
    return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ accepted: rows.length, rejected: body.events.length - rows.length });
}

// lib/supabase/analytics-admin.ts
// import "server-only";
// import { createClient } from "@supabase/supabase-js";
// export function createAdminClient() {
//   const url = process.env.FPVHELPER_ANALYTICS_SUPABASE_URL;
//   const key = process.env.FPVHELPER_ANALYTICS_SUPABASE_SECRET_KEY;
//   if (!url || !key) throw new Error("analytics server configuration missing");
//   return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
// }
```

### A.8 migration 部署来源（不含 SQL 副本）

唯一可执行、可部署、可审查的数据库来源是 [`supabase/migrations/20260830192551_app_events_analytics.sql`](../../supabase/migrations/20260830192551_app_events_analytics.sql)。本附录不再复制表结构、RLS、权限、清理函数或看板视图 SQL；任何数据库变更必须直接修改并验证该 migration（或新增由 Supabase CLI 创建的后续 migration），不得从本文恢复旧 A.8 草案。

该 migration 当前覆盖事件写入白名单与校验、服务端 ingest token/配额、90 天保留清理、私有分析台账及周报视图。这里的摘要只用于导航，不构成部署指令；最终行为始终以 migration 文件及其自动化数据库测试为准。

### A.9 analytics-infra 提出、需要创始人回答的问题（与母文档第 7 章去重后的补充）

- 已决定：不得使用 FPVSuperApp 共用项目；必须新建独立 FPVHelper Supabase。仍需创建后核验项目区域、migration 所有权和 Vercel 函数区域。
- Vercel 当前实际方案是什么？试点收费前须由有权负责人核验当时的商用条款、函数区域、访问保护与限流规则，并记录选择；本文不指定套餐或价格。
- 已决定：`race.fpvsuperapp.com` 是客户规范域，`helper.longxl.com` 仅内部非生产；当前不做 301/308。仍需核验两域的真实云端状态。
- 已决定：假名化统计经 Vercel 到境外独立 FPVHelper Supabase，书面确认和工程验收前关闭。具体合规程序、访问人和保留期仍待有权负责人确认。
- 是否要在界面上给俱乐部一个'使用统计已开启'的可见提示或关闭开关？还是只在报价单附件里告知？
- recording_stop 事件是否顺便带上训练 Session 摘要（时长、样本数、采样率、valid 判定、导出与否，不含样本），让'有效 Session 覆盖率'这个试点核心 KPI 自动统计？这会是训练摘要上云的第一步。
- 周报由你一个人看 SQL Editor 就够，还是主教练也要能自己看（决定是否做 /admin 页）？
- 工作站短 ID 显示在页脚、由俱乐部口头/微信报给你登记台账，这个流程可以吗？还是希望在 URL 里带 ?club=xxx 自动归属？
