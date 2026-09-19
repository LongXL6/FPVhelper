# 添加飞手：推送版本验证

基线：`origin/main` 的 `c3858cc693a3eac11cab22e1d818e713a934242f`。
分支：`codex/pilot-setup-review`。仅提取添加飞手及相关测试，不包含本地预览中此前未提交的训练库、复盘和存储恢复改动。原预览工作区保留。

新工作区从空状态开始，确认飞手名称、输入和完整/象限画面后逐个增加窗口。已有配置继续保留；取消不保存，保存失败保留草稿，记录中禁止添加和切换。沿用现有遥测控制器生命周期，窗口布局变化不会因此卸载控制器。

## 首次推送前验证

- `npm run check`：84 个测试文件、838 项测试通过，TypeScript 和 ESLint 通过。
- 最终代码：`npx playwright test e2e/pilot-setup.e2e.ts --project=chromium-smoke`，3/3 通过，包含本地生产构建。覆盖空状态、取消、逐个添加、裁切、持久化、录制锁定及手机弹窗。
- 最终代码：`npx playwright test e2e/rc-finalization.e2e.ts --config=playwright.phase2a.config.ts --project=chromium-smoke`，9/9 通过，包含本地生产构建。
- `git diff --cached --check` 通过。

首轮默认 `npm run test:e2e:smoke` 为 33/42，通过的用例包括原有 ARM 自动录制、飞控名称、输入绑定、录像及新添加流程。9 项 RC 收尾用例在进入应用前被自身网络限制阻止：用例固定允许 `127.0.0.1:3137`，默认配置启动 `localhost:3107`。用既有 `playwright.phase2a.config.ts` 补验后 9/9 通过。本轮没有改动这些既有配置或 RC 收尾用例；默认全量命令的端口冲突仍存在，不将其报告为全绿。

以上为首次推送前的本机检查，视频和串口使用项目现有模拟设备。当时未合并或部署。

## 0.8.0-beta.1 发布准备

- 用户随后授权合并上线，版本号与 lockfile、CHANGELOG 同步更新。
- 修复标准浏览器测试入口的端口冲突：同源只读网络限制改为读取当前 Playwright 配置的 baseURL，不再固定端口。
- 独立审查发现旧布局隐藏飞手可能被覆盖；现统一保护保存配置及实时串口占用，添加界面提供逐个恢复保留飞手的入口。连续添加、恢复及刷新均保留原姓名、取景和档案；原问题及恢复入口均经独立复核关闭。
- `npm ci`、`npm run check` 通过：84 文件、847 项测试，TypeScript、ESLint 通过。
- 修复端口和覆盖问题后，标准 `npm run test:e2e:smoke` 43/43 通过。补恢复入口后，重新生产构建并运行最终添加/恢复流程 `e2e/pilot-setup.e2e.ts`，4/4 通过。
- 独立复核：7 个直接相关测试文件、47 项通过，无剩余合并阻断。

这些结果仍为本地与模拟硬件证据。CI、合并、Vercel 构建及正式域名的上线状态须分别读取验证；真实采集卡、飞控及持续写盘尚未验证。
