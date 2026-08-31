# FPVHelper 变更记录

本文件记录进入版本控制的产品变更；它不证明 CI、部署、生产或真机验收已经完成。

## [0.2.0] - 2026-08-31

### 新增

- CI workflow：锁定安装、检查与生产构建；CI 作为补充证据，账户/计费型 pre-runner 失败不替代本地门禁。
- `/version.json` 版本端点、客户端版本检查 hook 与 Dashboard 更新提示。
- 发布、试点、工作站、数据附件、DVR 对表、硬件边界和视觉计圈实验文档。

### 调整

- 产品定位统一为“FPVHelper 训练工作台 / 俱乐部训练量化”。
- 统一客户入口、内部验证入口、FPVSuperApp 共享 Supabase 与假名化统计边界。
- 生产数据库 migration 改由 FPVSuperApp 仓库拥有；当前 `FPVHELPER_ANALYTICS_SUPABASE_*` 直接写入适配器只保留为本地参考，不得配置共享项目 secret/service-role key。
- 当前本地参考 `/api/events` 与 migration 已覆盖 ingest token、工作站原子分钟配额（120 请求 / 1000 事件）和客户端退避；共享生产环境仍须改接 FPVSuperApp 受限摄入，完成前统计保持关闭。

### 未完成 / 不由本版本证明

- 未证明 main 分支保护、PR 合并、Vercel Promote、生产域、共享 Supabase migration/受限摄入或真机验收已经完成。CI 的实际状态单独记录，不作为试点唯一门禁。
