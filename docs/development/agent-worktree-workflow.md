# 多 Agent worktree 交付流程

本流程用于把并行修改收敛为可审阅 commit。它是协作约定，不能替代 Codex 的任务分配、消息、完成事件或人工判断。

## 1. root 建立边界

1. root 从已核验的基线 commit 创建独立 worktree 和 `codex/<task>` 分支。
2. root 为每个 agent 指定唯一 owner、允许修改的文件/目录、禁止触碰的热点文件和验收命令。
3. 多个任务可能触碰同一文件时，root 先指定单一真相源 owner；其他 agent 只提供建议，不提交该文件。
4. root 记录每个 worktree 的路径、分支、基线 SHA 和依赖顺序。

## 2. agent 交付合同

- 开工先核对 `pwd`、branch、HEAD、`git status` 与 `git worktree list`。
- 只修改分配范围，保留已有脏改动；发现冲突范围立即回报 root。
- 完成后运行约定测试和 `git diff --check`，把改动提交为独立、可 cherry-pick 的 commit。
- agent 必须主动回报：commit SHA、文件清单、测试命令/结果、未验证项和外部确认项。没有 commit 的口头“完成”不算交付。

## 3. root 集成规则

- root 只用 `git cherry-pick <sha>` 集成 agent commit，不复制未提交文件，也不把 agent 分支直接 merge 到集成分支。
- cherry-pick 前核对 SHA 的作者、基线、文件范围和测试证据。
- 冲突文件由预先指定的单一真相源 owner 解决；root 不把两份实现机械拼接。
- 集成后重新运行受影响的组合测试；agent 分支上的绿色结果不证明集成分支绿色。

## 4. 独立 reviewer 与修复回环

1. reviewer 使用只读任务检查目标 commit/集成 diff，不改文件、不提交修复。
2. reviewer 按严重度报告可定位问题和证据；没有问题时明确写“未发现可操作问题”。
3. root 把问题发回原 owner；原 owner 在原 worktree 修复、测试并提交新 SHA。
4. root cherry-pick 修复 SHA，再让 reviewer 复核相关范围。重复直到没有阻塞项或 root 明确接受剩余风险。

## 5. 证据分层

| 层级 | 证明 | 不能证明 |
| --- | --- | --- |
| agent commit | 指定文件已提交 | 已集成、CI、部署 |
| root cherry-pick | 集成分支包含改动 | 组合测试通过 |
| 本地组合测试 | 当前 checkout 通过检查 | GitHub CI 通过 |
| CI | 远端 commit 的 workflow 通过 | Preview/生产正确 |
| Preview | 指定预览构建可验收 | 已 Promote |
| Promote | 指定部署进入生产目标 | 域名、设备、业务结果正确 |
| 生产与真机 | 页面/硬件路径实际通过 | 客户同意、付款或长期稳定性 |

## 6. 删除 worktree 的时机

只有同时满足以下条件才删除：commit 已被 root cherry-pick；集成测试完成；reviewer 闭环；无待取回的修复 commit；root 已记录 SHA 和未验证项。先用 `git worktree list --porcelain` 确认精确路径，再由 root 使用 Git worktree 命令移除；不要在 Finder 中直接删除，也不要删除仍含未提交改动的 worktree。

## 只读检查的边界

`git status --short --branch`、`git log -1 --oneline`、`git diff --check` 和测试命令能提供仓库证据，但无法证明 owner 分配、消息已送达、reviewer 独立性或 Codex 协作事件已经发生。协作状态仍以 root 的任务编排与 agent 主动回报为准。
