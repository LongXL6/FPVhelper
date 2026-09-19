# 添加飞手：推送版本验证

基线：`origin/main` 的 `c3858cc693a3eac11cab22e1d818e713a934242f`。
分支：`codex/pilot-setup-review`。仅提取添加飞手及相关测试，不包含本地预览中此前未提交的训练库、复盘和存储恢复改动。原预览工作区保留。

新工作区从空状态开始，确认飞手名称、输入和完整/象限画面后逐个增加窗口。已有配置继续保留；取消不保存，保存失败保留草稿，记录中禁止添加和切换。沿用现有遥测控制器生命周期，窗口布局变化不会因此卸载控制器。

## 验证结果

- `npm run check`：84 个测试文件、838 项测试通过，TypeScript 和 ESLint 通过。
- 最终代码：`npx playwright test e2e/pilot-setup.e2e.ts --project=chromium-smoke`，3/3 通过，包含本地生产构建。覆盖空状态、取消、逐个添加、裁切、持久化、录制锁定及手机弹窗。
- 最终代码：`npx playwright test e2e/rc-finalization.e2e.ts --config=playwright.phase2a.config.ts --project=chromium-smoke`，9/9 通过，包含本地生产构建。
- `git diff --cached --check` 通过。

首轮默认 `npm run test:e2e:smoke` 为 33/42，通过的用例包括原有 ARM 自动录制、飞控名称、输入绑定、录像及新添加流程。9 项 RC 收尾用例在进入应用前被自身网络限制阻止：用例固定允许 `127.0.0.1:3137`，默认配置启动 `localhost:3107`。用既有 `playwright.phase2a.config.ts` 补验后 9/9 通过。本轮没有改动这些既有配置或 RC 收尾用例；默认全量命令的端口冲突仍存在，不将其报告为全绿。

以上为本机检查，视频和串口使用项目现有模拟设备。不是 CI、真实硬件或生产验证；本轮不合并或部署。
