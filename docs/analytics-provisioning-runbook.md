# 假名化统计工作站登记手册

本手册描述可审计的工作站 token 生成、登记、安装、验证、轮换与撤销流程。仓库中的实现和命令不证明 FPVSuperApp 共享 Supabase、Vercel 环境、生产域、书面确认或线上统计已经配置完成。

> 2026-08-31 决定：生产数据复用 FPVSuperApp 的 Supabase 云项目，migration 由 FPVSuperApp 仓库拥有。当前仓库的登记 SQL、migration 和直连适配器仅用于本地逻辑验证；在共享项目的专属命名空间与受限摄入入口完成前，不得对云项目执行本手册的 SQL。

## 0. 开启前门禁

以下各项必须从对应真相面逐项核验：

- [ ] 已从 FPVSuperApp 仓库和 Dashboard 核验共享 Supabase 的真实 project ref，且不是当前可见的 LONGWEBSITE 项目。
- [ ] production migration 已由 FPVSuperApp 仓库创建并执行；FPVHelper 专属命名空间、显式 grants、RLS、保留任务与共享项目回归测试均已复核。
- [ ] FPVSuperApp 已提供受限摄入入口或最小权限数据库角色；FPVHelper Vercel 未配置共享项目 `sb_secret_...` 或旧 `service_role` key。
- [ ] 客户规范域与同域 `/api/events` 已验证，写入只到 FPVHelper 专属对象。
- [ ] 数据范围、境外处理和关闭方式已取得书面确认。
- [ ] 生产配置、Route Handler 和数据库写入已通过工程验收。

任一项未完成时，`NEXT_PUBLIC_ANALYTICS_ENABLED` 必须保持非 `true`，不生成、不登记、不安装工作站 token。训练、Session 本地保存和导出不依赖统计。

## 1. 取得本地 workstation ID

门禁全部满足并开启生产配置后，在客户规范域打开工作台。页面显示“等待工作站令牌”时：

1. 在“WORKSTATION ID”区域核对并复制完整 UUID。
2. 复制 ID 本身不会开启统计、创建事件或发送网络请求。
3. 该随机 ID 同时是本地 Session JSON 的工作站台账身份。关闭统计不会删除或轮换它。

若页面显示“当前发布未开启客户统计”，先修复云端/发布配置，不要绕过 UI 手工创建另一个 ID。

## 2. 生成 token 与登记材料

在不录屏、不共享输出、不使用 `tee` 或重定向的私密终端运行：

```bash
npm run analytics:token -- issue --workstation-id <页面复制的完整UUID> --club-code <俱乐部代号>
```

命令只接收 workstation UUID 和受限字符集的 club code，不接收 Supabase secret、数据库 URL 或既有 token 参数，也不会连接数据库。它会输出：

1. 256-bit 随机 `fpvh_ingest_...` 明文 token，恰好显示一次；立即粘贴安装，不保存到文件、聊天、工单、仓库或数据库。
2. 不含明文 token 的 operator audit/registration JSON，其中含 club code、workstation ID、SHA-256 hash 与预期返回行数。该映射只进入受控运营记录，不进入 Git 或 analytics 数据库。
3. 只含 workstation ID、SHA-256 hash 和固定 purpose 的最小登记 SQL；SQL 不含 club code 或明文 token。

明文遗失后不能恢复。若 hash 已登记但明文未成功安装，按“轮换”生成新 token，禁止从终端记录或日志中找回。

## 3. 在 FPVSuperApp 共享项目登记

本节只有在 FPVSuperApp-owned production migration 和受限摄入实现完成后才可执行。当前 CLI 输出的登记 SQL 不是共享项目生产接口，不得直接使用。

1. 从 FPVSuperApp 仓库配置和提供方控制台交叉确认真实 project ref，并确认不是 LONGWEBSITE 项目。
2. 通过 FPVSuperApp 批准的受限运营入口登记；不要把共享项目 secret/service-role key 配置到 FPVHelper，也不要粘贴明文 token 或 operator JSON。
3. 执行后必须返回恰好 1 行，且 workstation ID 与页面一致。0 行、多行、唯一约束错误或项目不符都视为未登记完成。
4. 将不含明文的 operator JSON 保存到受控运营记录；analytics 数据库内不得建立 workstation-to-club 映射。

## 4. 在工作站一次性安装

1. 回到仍显示相同 workstation ID 的客户页面。
2. 将本次明文 token 粘贴到密码输入框，点击“安装并开启”。
3. 页面必须变为“本机统计 · 已开启”。若 ID 已变化，停止安装并调查本地浏览器 Profile/站点数据，不要为错误 ID 继续登记。
4. 关闭私密终端输出；不要把 token 复制到台账、截图或支持消息。

## 5. 验证闭环

安装后逐层验证，不能只看相邻层成功：

- 浏览器：状态为“已开启”；Network 中同域 `POST /api/events` 返回 `204`，请求只发往客户规范域。
- Route Handler：确认请求通过 token/workstation 绑定与配额授权；不得记录 request body 或 token。
- FPVSuperApp 共享 Supabase：在 FPVHelper 专属命名空间按 workstation ID 查到 active token hash 与新 `app_events`，且事件只含白名单枚举/数值摘要；同时抽查没有访问其他业务对象的权限。
- 隐私抽查：无视频、原始 RC、姓名、选手代号、备注、设备/串口名、原始 UA、message、stack、digest 或原始错误文本。

`204` 不证明后续报表、试点验收或硬件工作流完成；数据库事件也不证明书面同意、生产发布或真机验收。

## 6. 轮换

先复制/核对当前 workstation ID，再运行：

```bash
npm run analytics:token -- rotate --workstation-id <完整UUID> --club-code <俱乐部代号>
```

轮换 SQL 会在同一条语句中撤销当前 active 行，并仅从被撤销行插入新 hash。SQL 必须返回恰好 1 行；返回 0 行时新 hash 未登记，禁止把该明文当作已生效 token。登记成功后，在页面“替换工作站令牌”输入新明文，并重新执行第 5 节验证。

## 7. 关闭与撤销

1. 核对并记录要撤销的 workstation ID。
2. 在工作站点击“关闭并清除本机统计数据”，确认 token/待发送队列清除且不再发送。共享 workstation ID 仍保留给本地 Session 台账。
3. 生成撤销材料（此命令不生成 token）：

```bash
npm run analytics:token -- revoke --workstation-id <完整UUID> --club-code <俱乐部代号>
```

4. 通过 FPVSuperApp 批准的受限撤销入口执行，必须返回恰好 1 行；不得直接使用当前 CLI SQL 操作共享云项目。
5. 用旧 token 的受控负向测试应得到拒绝；不得把旧明文放入命令参数、日志或工单。

紧急情况下可先执行服务器撤销，再尽快完成本地关闭。服务器撤销与本地清理是两个独立证据层，必须分别记录。
