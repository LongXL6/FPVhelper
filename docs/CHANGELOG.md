# FPVHelper 变更记录

本文件记录进入版本控制的产品变更；它不证明 CI、部署、生产或真机验收已经完成。

## [0.2.0] - 2026-08-31

### 新增

- P0 CI：锁定安装、检查与生产构建。
- `/version.json` 版本端点、客户端版本检查 hook 与 Dashboard 更新提示。
- 发布、试点、工作站、数据附件、DVR 对表、硬件边界和视觉计圈实验文档。

### 调整

- 产品定位统一为“FPVHelper 训练工作台 / 俱乐部训练量化”。
- 统一客户入口、内部验证入口、独立 Supabase 与假名化统计边界。
- 分析写入只接受独立项目的 `FPVHELPER_ANALYTICS_SUPABASE_*` 服务端配置，不再回退到公开、通用或旧 `service_role` 环境变量。
- `/api/events` 在 Supabase 内按 ingest token + 工作站执行原子分钟配额（120 请求 / 1000 事件），超限返回无响应体的 `429` 与 `Retry-After`；客户端保留队列并退避重放。

### 未完成 / 不由本版本证明

- 未证明 main 分支保护、CI 运行、PR 合并、Vercel Preview/Promote、生产域、独立 Supabase 或真机验收已经完成。
