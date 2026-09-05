# FPVHelper 模块契约（Phase 0 提案）

状态：`proposed / needs_review`；本文件不是已实现的接口、平台接入或发布批准。
范围：约定训练模块边界；本轮不增加 API、共享类型包、账号、迁移或云连接。
Helper 源码以本轮 handoff 的 `base_sha/tested_sha` 为准。
Super App 只读核查版本：`aa24eb6e9c63368b99eb6c983afb72ca2c411afd`，与本轮 `ls-remote main` 一致。
以下“现有”表示所读源码事实；“约定/提案”表示后续实现约束，不能写成已交付能力。

## 1. 所有权与依赖

Helper 拥有本地采集生命周期、原始训练证据、媒体关联、复盘及本地恢复。
Super App 拥有平台身份、装备、俱乐部及相关产品能力；Helper 不复制这些系统。
“属于 Super App”、共用账号、数据库、origin、仓库或客户端实现是不同决定，本契约不合并它们。
独立运行继续保留 Next.js/React；本轮不改包管理器、不迁移 monorepo、不拆微服务。

Super App 的[模块单体约束][sa-architecture]与[依赖规则][sa-rules]继续适用：

- Core 不导入 Race Intelligence 实现；Race 仅在另行授权后消费允许的公开契约/数据投影。
- Race 不直接读 Helper 私有数据库；本任务不开放预测，也不允许训练数据自动上传。
- 发布控制属于工具层，不进入产品运行时或决定本地记录是否可用。
- 不跨仓库导入内部 Supabase adapter、admin/service-role client 或 Race 内部模块。
- 现有迁移尚未全部完成；旧结构地图已落后于部分 Core 提取，不能据其宣布目标架构完成。

平台接入证据按下表解释，源码中的数据库表/内部类型不自动成为 Helper 可调用接口。

| 能力 | 本轮核实 | 待核实边界 |
|---|---|---|
| 身份 | [Pilot 与 auth user][sa-pilot]分开，服务端解析账号对应 Pilot | 面向 Helper 的版本、权限、映射和生命周期契约 |
| 装备 | [PublicBuildRecord][sa-build]是明确字段白名单的公开投影 | 被授权的读取接口、私有装备读取和训练关联 |
| 俱乐部 | [现有 schema][sa-club]与评论审核权限，不是训练授权 | 训练记录访问范围、角色含义、成员查询契约 |
| 赛事 | 未核实训练可用的公开 Core 赛事契约 | 赛事/赛道引用与来源；不得借用 Race 内部事件类型 |
| Field | 已有认证接口和[扫码驱动会话][sa-field] | TrainingSession 到 Field 的关联规则及授权 |

本轮不调用这些远端能力，不建立真实身份关联；`unverified` 不阻碍独立的本地修复。
生产数据库 migration 归 Super App；Helper 本仓库 migration 仅供本地验证/设计参考。
Helper 不持有共享 Supabase secret/service_role，不猜 project ref；统计保持默认关闭/可选。

## 2. 身份与会话

现有本地形状见 [training-session.ts](../../lib/training-session.ts)、[video-workspace.ts](../../lib/video-workspace.ts)。

| 现有字段 | 实际含义 | 不可推断 |
|---|---|---|
| `TrainingSession.id` | 原训练记录 ID | 平台 Flight/Field ID |
| `athleteCode` | 录制时使用的显示代号；可来自自动名称或手动输入 | 稳定人物身份、实名或账号所有权 |
| `PilotChannelConfig.id` | 视频源/slot 对应的本地工作区通道 ID | 跨换桥、跨工作区稳定的人物 ID |
| `sourceId/deviceId/crop` | 视频源、浏览器设备选择与裁切（百分比） | 物理设备身份或受训选手身份凭据 |
| `TrainingSession.build` | `PUBLIC_APP_BUILD` 软件构建号 | Super App 的 aircraft Build ID |
| `workstationId` | 本地工作站标识 | 操作员或飞行器身份 |

`build` 的实际赋值见 [use-training-session.ts](../../hooks/use-training-session.ts)。
提案：以后引入稳定本地 `localPilotId`，显示名、设备名、视频绑定和可选平台身份引用分别记录。
目前 TrainingSession 没有该稳定人物字段；不把通道 ID 或相同名字补造成历史人物身份。
受训选手可以不同于操作员账号，不要求每个选手注册，不新增实名或监护系统。
历史训练 ID、采集时身份快照和原文件保留；改名/合并只新增显式映射，不重写原始归属。
远端引用需记录来源平台、契约版本和关联依据；由服务端校验权限，不信任客户端 `pilotId/clubId`。
授权缺失、关联撤销或字段缺失时，保留未知/未关联；不偷偷匹配名字或上传本地名单。

Super App [FlightSession][sa-flight-model]是 `public.flights` 的最小投影，含 Pilot、Build、电池和时间。
其 Field 流程由电池预飞扫码创建；新扫描可结束旧 Flight，一名 Pilot 只能有一个 active Field session。
Helper 录制边界、选手切换和多源工作区并不具备这一语义，因此不作自动一对一映射。
以后只能通过显式、可撤销的关联记录连接两者；基数、权限和冲突规则需要单独核实。
扫码、录制开始、实际起飞和实际过门均是不同事件；任何一个都不能自动替代另一个。

## 3. 数据、时间与事件

边界仅传可序列化数据：版本、来源、引用和明确单位；不传 DOM、MediaStream、串口/数据库/文件句柄。
现有 Session schema 为 v2，兼容读取 v1；缺失质量/校准/设备/身份字段继续保留未知。
约定分开保存：原始观察、媒体引用、人工修订、派生指标和训练结论；派生物引用其输入版本。
追加修订不能覆盖原始样本、原始视觉候选或原媒体；原始文件身份与修订身份分别保留。
当前 markers/notes 不等于已建成追加式修订账本；这一要求是后续切片约束。

现有时间与单位见 [training-capture-quality.ts](../../lib/training-capture-quality.ts)：

| 数据 | 当前事实 | 使用限制 |
|---|---|---|
| `samples.elapsedMs` | 相对录制开始的 `performance.now`，ms；真实源为主机帧解码时间，演示源为生成时间 | 不是发射时刻、硬实时或物理动作时刻 |
| `sequence` | 主机生成的帧计数器 | 不是空口序号，不能计算 RF 丢包率 |
| `channelsUs` | MSP RC payload 或演示生成值，单位 us | 不是轨迹、姿态、马达输出或未经混控的物理摇杆 |
| `rc.*Percent` | 固定端点归一化/钳制后的显示值 | 不覆盖原通道值，不代表逐设备实测校准 |
| `startedAt / timing.wallClockStartedAt` | ISO 墙钟/带时区本地墙钟 | 不跨运行期替代单调时钟 |
| `captureQuality` | 主机已存样本相邻间隔统计，阈值 50 ms，版本 1 | 不是 RF 质量或 UI 降采样丢帧测量 |

100 Hz 是 RC 轮询目标；实收频率、独立空口样本率和 UI 发布频率分开报告。
地面 bridge 电压/RSSI 不代表飞行器电池或机上 ELRS LQ。
质量指标要记录阈值、来源和算法版本；UI 下采样后的正常间隔不直接算底层丢帧。

后续跨产品边界提案：同时标注 `clockKind`、`runId/timebaseId`、单位、原点、采集位置和来源版本。
这些字段尚未完整存在于当前 Session，不回填伪造历史值；不同运行期的单调时钟不能直接相减。
媒体应保存原 PTS/timebase（若实际获得）、媒体身份与映射版本；只有实际获得的精度才可标注。
主机接收时间、媒体时间、估计呈现时间和物理穿越时间分别表达；不靠文件名或同 Session 推断同步。

现有 `TrainingSession.video` 在 `recorded: true` 时保存写入并关闭完成的本地收据，含文件名/MIME/字节数/墙钟区间。
`video.synchronized` 与 `timing.videoOffsetCalibrated` 均固定为 false；带摇杆 OSD 时 `video.overlayTiming` 为 `latest_available_host_sample`。
这不是媒体内容指纹或经测量的 RC↔视频映射；写入成功也不证明物理同步。
提案：媒体关联另存文件身份、内容校验依据、裁切/选手快照及版本化时间映射，不依赖同名文件。
映射须区分未校准、人工对齐和测量校准，并记录偏移/漂移、适用区间与误差证据。
现有记录没有这些证据就继续未知；校准或裁切修改不得改写原视频/原样本。

面向训练模块 Host 的下述事件契约尚未实现；如以后需要，先作为本地边界采用以下语义，不意味着获准发送到云端：

- 每事件持久化唯一 `eventId`，注明类型/版本、来源、Session 与采集 run、发生/接收时间的时钟。
- 重试复用原 `eventId`；同 ID 同内容是幂等重放，同 ID 不同内容返回显式冲突并保留原始内容。
- 仅在同来源/run 内按明确序号解释顺序；不承诺跨进程总序，重复/缺口/迟到显式记录。
- 人工更正以新事件引用被更正事件和修订号；撤回也追加，不删除原观察。
- 本地待保存、已确认、失败、结果未知分别表示；超时不等于取消或未写入，不重复制造事实。
- 视觉事件始终是候选；人工 marker/确认不自动变成自动模型成绩或物理过门真值。

未来云摘要需另有字段白名单、用户/俱乐部隔离、幂等与最小权限校验；本轮只设计、不发送。
视频、照片、原始 RC/串口、姓名/代号、设备名、备注和身份映射不自动上传或进入报告/PR。

## 4. 运行、接入与迁移

桌面能力按浏览器实际支持定义：视频输入、用户授权的只读串口、录像和本地保存。
移动端首先定义为选取/导入已授权记录、媒体复盘和结论编辑；这些跨产品流程尚未接入。
WebView 包装不证明 Web Serial 可用；不支持采集时明确展示能力边界，不阻断已有记录的可用复盘。
Super App [移动现场与 Web 深度编辑角色][sa-platform]不等于所有平台运行同一硬件实现。

Host 不可用、账号退出或模型失败不能成为本地基础记录丢失的原因。
提案：正在写入的数据继续由本地采集所有者收尾/标记可恢复状态；新 Host 连接不接管旧写入。
退出平台账号时撤销远端访问和平台引用的可用授权，不隐式删除本地训练、媒体或待保存记录。
共享电脑上的本地历史访问/锁定、所有者确认和显式删除行为须在真正接入前确定并测试。
当前尚无该 Host 退出协议；不能宣称已实现账号隔离或安全锁定。
没有账号/token/云/模型仍允许本地基础记录；真实输入、选手确认和安全保存守卫继续保留。

切换 origin/宿主前必须实现并验收可逆迁移；不能假设 IndexedDB、文件权限或设备授权自动共享：

1. 原入口导出版本化记录和关联清单；保留原目录与原始文件，区分数据/媒体/权限引用。
2. 新入口先校验版本、文件身份和完整性；同快照幂等，不同修订保留或显式处理冲突。
3. 用户明确确认身份映射；重新选择媒体、目录与设备并授权，不静默复用旧 origin 权限。
4. 新入口只在实际持久化/重新打开验证后确认导入；失败保留输入和可重试状态。
5. 原入口和备份保持可用；回滚入口不删除新数据，也不把撤回代码等同于撤回迁移。

本轮未构建 Host Adapter/harness、媒体重新绑定、身份映射或跨 origin 迁移。
以后可先用无网络的合成 fixture/薄 Host harness 验证契约，不必等所有可选实验完成。
最小验收包括：序列化往返、未知版本拒绝且保留输入、缺字段/无权限、Host 离线/登出、重复事件和局部失败。
补充验证媒体不匹配、时钟 run 不同、导入冲突及回滚恢复；harness 通过仍不是真实平台/硬件验收。
实际修改 Super App、云端写入或生产发布仍需下一轮明确范围与独立授权。

[sa-architecture]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/docs/architecture/ARCHITECTURE.md#L18-L106
[sa-rules]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/docs/architecture/dependency-rules.md#L39-L87
[sa-pilot]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/src/lib/auth/pilots.ts#L3-L36
[sa-build]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/packages/core/aircraft/contracts/public-build.ts#L10-L40
[sa-club]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/supabase/migrations/20260607120000_clubs_v1.sql#L3-L53
[sa-field]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/supabase/migrations/20260716170633_minimal_flight_field_sessions.sql#L603-L669
[sa-flight-model]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/ios/FPVSuperApp/Models/FlightSession.swift#L18-L44
[sa-platform]: https://github.com/LongXL6/FPVSUPERAPP/blob/aa24eb6e9c63368b99eb6c983afb72ca2c411afd/memory/PROJECT.md#L89-L103
