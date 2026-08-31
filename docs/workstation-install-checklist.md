# 工作站安装清单

## A. 基础信息

| 字段 | 值 |
| --- | --- |
| 俱乐部代号 | 待填 |
| 工作站代号 | 待填 |
| 操作系统 / 版本 | 待填 |
| Chrome 或 Edge 版本 | 待填 |
| 屏幕与教练距离 | 待填 |
| UVC 采集卡型号 | 待填/未验证 |
| FPV 接收/DVR 系统 | 待填 |
| 安装日期 / 操作人 | 待填 |

不要记录密码、token、设备序列号、Binding phrase 或真实选手姓名。

## B. 浏览器与入口

- [ ] 使用受控的桌面 Chrome/Edge Profile，不使用微信内置浏览器或 Safari。
- [ ] 客户书签只指向 `https://race.fpvsuperapp.com`。
- [ ] `helper.longxl.com` 只保留团队内部完整验证入口，验证数据标记为非生产。
- [ ] HTTPS 安全上下文、摄像头权限、Web Serial 支持已实际验证。
- [ ] 浏览器自动休眠、标签页丢弃和系统睡眠策略已由工作站管理员核验；如使用企业策略，保存策略名称/版本，不保存凭据。
- [ ] `/version.json` 与发布记录中的版本一致。

## C. 本地数据目录

- [ ] 创建仅获授权教练可访问的 Session JSON / 本地 WebM 目录，并在页面完成文件夹授权。
- [ ] 代号映射和监护人同意编号保存在另一受控位置。
- [ ] 已验证导出、重新打开和解析一条测试 JSON。
- [ ] 已记录本机浏览器数据清除会删除 IndexedDB 记录的风险。

## D. 视频

- [ ] UVC 采集卡在浏览器设备列表中可识别。
- [ ] 选中的是 HDMI 采集卡，不是内置摄像头或虚拟摄像头。
- [ ] 已验证“同时录制当前选手视频”开关；完整画面和裁切画面各生成一段非空 WebM，停止后页面显示 `SAVED`。
- [ ] 已确认 WebM 只写入授权本地目录，FPVHelper 不上传视频；正式训练仍按俱乐部规则决定是否并行使用独立 DVR。
- [ ] 拔掉采集卡后的提示和恢复流程已记录。

## E. 每位选手独立地面桥

使用 [`ground-rx-handoff-sop.md`](ground-rx-handoff-sop.md)。

- [ ] 每个参训代号都有独立 Bridge FC + ELRS RX 套件编号。
- [ ] 每套已在拆桨台架预绑定并核对通道；现场不共享 RX 临时重绑。
- [ ] Bridge FC 不接 ESC/电机，只通过 USB 供电和只读 MSP。
- [ ] 套件标签只有代号，不含 Binding phrase 或真实姓名。
- [ ] 换人时只允许当前一套桥和对应遥控器上电。

## F. 统计与网络

- [ ] 假名化统计的书面确认已取得，或确认统计保持关闭。
- [ ] 已从 FPVSuperApp 仓库和 Dashboard 核验共享 Supabase 的真实 project ref；当前 LONGWEBSITE 项目不得使用。
- [ ] FPVSuperApp-owned production migration、FPVHelper 专属命名空间和受限摄入路径均已核验；FPVHelper Vercel 未配置共享项目 secret/service-role key。
- [ ] 未完成共享项目 migration、受限摄入、生产域和工程验收前，`NEXT_PUBLIC_ANALYTICS_ENABLED` 保持非 `true`，未生成/登记/安装 token。
- [ ] 按 [`analytics-provisioning-runbook.md`](analytics-provisioning-runbook.md) 复制页面完整 workstation ID，并使用更新后的受限登记路径登记恰好 1 行；当前旧版 SQL 不得直接执行到共享云项目。
- [ ] token 明文未进入命令参数、文件、截图、聊天、Git 或数据库；club/workstation 映射未进入 analytics 数据库。
- [ ] 安装后已分别验证页面状态、同域 `/api/events`、共享项目专属命名空间事件与禁止字段抽查。
- [ ] 已确认关闭统计只清 token/待发送队列并停止发送，不删除本地 Session 台账使用的随机 workstation ID。
- [ ] 使用俱乐部实际网络和手机热点分别验证页面；结果只写实测数据。
- [ ] 视频、原始 RC、选手代号和原始错误文本没有出站。

## G. 交付

- [ ] 操作员完成一次全流程演练。
- [ ] 支持渠道、响应范围和升级联系人已书面确认。
- [ ] 已附真机验收记录；未完成项列在下方。

未完成项：

- 待填
