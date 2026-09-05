# FPVHelper 版本与发布流程

## 版本规则

- 使用 SemVer：修复为 patch，向后兼容功能为 minor，破坏性变更为 major。
- 每次计划生产发布前更新 `package.json`、`package-lock.json` 与 [`CHANGELOG.md`](CHANGELOG.md)。
- tag 必须与 `package.json` 完全一致，格式为 `vX.Y.Z`。
- 无 Vercel 环境变量时，`/version.json` 安全返回 `<version>+local`；本地构建不依赖云端变量。

## main 保护清单（仓库管理员手工配置并截图/导出核验）

- [ ] 禁止直接 push 到 `main`，要求 PR。
- [ ] CI 仅作为补充证据；账户/计费造成的 pre-runner `steps: []` 失败不设为 required check。若 job 真正执行后出现代码/测试失败，仍禁止合并。
- [ ] 要求分支与 `main` 保持最新后才能合并。
- [ ] 至少 1 名 reviewer 批准；新提交后撤销旧批准。
- [ ] 禁止强推和删除 `main`。
- [ ] 管理员是否允许绕过须有书面决定；默认不绕过。

这些复选框是配置与验收清单，不表示 GitHub 当前已经启用对应规则。

## Preview → Promote → tag

1. 从独立 worktree/功能分支提交小而可审阅的 commit。
2. 本地运行：`npm ci`、`npm run check`、`npm run build`、`git diff --check`。
3. 推送分支并创建 PR；至少 1 名独立 reviewer 复核。本地完整门禁必须通过；CI 如能运行则记录结果，账户/计费型 pre-runner 失败单独标记但不阻塞试点。
4. 在 Vercel Preview 核验页面、`/version.json`、视频/串口权限提示和无凭据构建；记录 Preview URL 与 commit SHA。
5. 合并 `main` 后，核对 Vercel 对应 commit 的生产构建为 `READY`，且生产别名已指向该构建。若 Git 集成已自动发布，记录自动发布证据；否则明确选择该 commit 的构建 Promote。不要用“合并成功”代替生产部署证据。
6. 核验客户规范域 `race.fpvsuperapp.com` 的页面与 `/version.json`；`helper.longxl.com` 只做内部完整验证，数据不计生产。
7. 生产核验通过后创建 annotated tag：`git tag -a vX.Y.Z -m "FPVHelper vX.Y.Z"`，再推送该 tag。
8. 更新发布记录，分别写清代码、CI、Preview、Promote、生产、真机和业务验收状态。

## 可验证发布记录模板

| 层级 | 证据 | 结果 |
| --- | --- | --- |
| 本地 | commit SHA；`check/build/diff --check` 输出 | 待填 |
| CI（补充证据） | workflow run URL + commit SHA；注明未运行、pre-runner 阻断或真实测试结果 | 待填 |
| PR / 合并 | PR URL；merge commit | 待填 |
| Preview | URL；`/version.json` 响应 | 待填 |
| Promote | Vercel deployment ID；目标域 | 待填 |
| 生产 | `race.fpvsuperapp.com` 页面和版本响应 | 待填 |
| 真机 | UVC、独立 Bridge FC+RX、导出 JSON 的验收记录 | 待填 |
| 业务 | 书面同意、试点起算、付款/发票 | 待填或未确认 |

## 新版本提醒的串行集成边界

`hooks/use-version-check.ts` 每 5 分钟和页面重新可见时请求 `/version.json`，Dashboard 已接入版本提示。录制中只提示“本次记录结束后刷新”且不显示刷新按钮；空闲时可由操作员手动刷新。
