# FPVHelper 复用 FPVSuperApp Supabase 决策

状态：APPROVED

决定日期：2026-08-31

## 决定

- FPVHelper 不再新建独立 Supabase 云项目；未来云端数据进入 FPVSuperApp 已有 Supabase 项目。
- FPVSuperApp 仓库是生产数据库 migration 的唯一所有者。FPVHelper 仓库中的现有 migration 继续用于本地验证和迁移设计参考，不得直接执行到共享云项目。
- 当前浏览器曾指向的 LONGWEBSITE 项目不在本决定范围内；未从 FPVSuperApp 真实配置确认 project ref 前，不连接或执行任何云端 SQL。
- 视频、DVR 原片、原始 RC、原始串口字节、选手代号和备注仍不得上传。

## 共享项目的安全边界

Supabase 的 secret key 与旧 `service_role` 都通过内建 `service_role` Postgres 角色访问数据，拥有完整项目数据权限并绕过 RLS。为避免 FPVHelper 的 Vercel 环境获得整个 FPVSuperApp 项目的高权限：

1. 不得把 FPVSuperApp 的 `sb_secret_...` 或旧 `service_role` 配置到 FPVHelper Vercel。
2. 生产摄入必须由 FPVSuperApp 拥有的受限服务入口完成，或使用只被授予 FPVHelper 对象权限的自定义数据库角色。实施 PR 冻结其中一种方案前，统计保持关闭。
3. FPVHelper 对象使用专属 schema 或 `fpvhelper_` 前缀；所有 `GRANT`、RLS、函数执行权和保留任务必须显式声明，禁止依赖 `public` schema 的默认权限。
4. 受限入口只能写入白名单事件和数值摘要；token、配额、90 天保留与 `race.fpvsuperapp.com` 单域限制继续保留。

官方依据：

- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)：secret key 拥有完整项目数据访问并绕过 RLS。
- [Securing your API](https://supabase.com/docs/guides/api/securing-your-api)：对象授权与 RLS 是两层控制，暴露对象需要显式授权。
- [Data API 默认暴露变更](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)：新表的 Data API 权限正在转为显式 opt-in。

## 实施顺序

1. 从 FPVSuperApp 仓库和 Supabase Dashboard 重新确认真实 project ref、区域、方案和备份状态，不从浏览器相邻项目推断。
2. 在 FPVSuperApp 独立 worktree 中通过 Supabase CLI 创建 production migration；把现有 analytics 对象改成专属命名空间并加入共享项目回归测试。
3. 实现受限摄入入口或自定义最小权限数据库角色；删除 FPVHelper 对共享项目 secret key 的依赖。
4. 更新工作站 token CLI 与登记手册，确保生成的 SQL/API 请求只命中新的专属对象。
5. 完成书面数据附件、云端 migration/RLS/限流/保留期验证和真实同域事件闭环后，才可在客户域开启统计。

## 当前证据边界

- 本决定只改变架构方向和发布门禁，不证明 FPVSuperApp 云项目已经连接或迁移。
- 当前 FPVHelper 本地 migration 和 pgTAP 仍是有效的逻辑回归证据，但不是共享项目可直接部署的生产 migration。
- GitHub Actions 的账户/计费型 pre-runner 失败不再阻塞试点推进；若 CI 真正启动并产生代码或测试失败，仍必须处理。
