# RBTFlow：统一 Git Diff 提交与 CI Commit ID 关联机制

## 1. 项目背景

项目仓库：https://github.com/cossoledad/RBTFlow

RBTFlow 是一个基于 VS Code 原生控件开发的 Review Board 客户端，使用 Git、RBTools 和 Review Board API 实现代码审核。

目前已经支持 Git 分支分析、复杂 Merge 历史的汇总 Diff、审核预览、草稿创建、审核单更新、发布、审批、评论和错误恢复。

本次任务的核心目标是：

**统一所有 Git 历史场景的审核提交方式，使 Review Board 始终保存正确的最终文件差异，并将审核单的 `commit_id` 与真实 Git HEAD SHA 关联，以兼容现有 CI。**

## 2. 已验证的实际行为

当前实际验证环境使用 RBTools 7.0 和 Review Board 服务。

此前确认：

- 使用 `rbt post --with-history`，能够为线性 Git 历史创建具有 Commit History 的审核单。
- 包含 Merge Commit 时，RBTools 7.0 的 Commit History 模式可能因非线性历史而失败。
- 使用 `rbt post --squash-history BASE HEAD`，能够正确上传包含 Merge、冲突解决的最终文件差异。
- 但上述 Squash History 模式默认没有将真实 HEAD SHA 写入审核单的 `commit_id`。
- Review Board 支持单独修改 Draft 的 `commit_id`，不要求启用 Commit History。

实际 CI 实验：

原始 Squash History 审核单，CI 返回：

`does not have code reviews, have you updated rbt and git push ?`

随后通过 Review Board Draft API 执行：

```python
draft.update(
    commit_id=head_sha,
    update_from_commit_id=False,
)
```

再次执行 CI，返回：

`rb: 95283, current code reviews are less than two ship it`

这说明 CI 已经能够识别审核单，并进入审批检查阶段。

因此，**不再需要通过 Commit History 提供最后一个 Git SHA**。

本次实验没有验证最终 Git 合并成功，因此不得将后续合并行为作为已验证事实。

## 3. 核心设计决策

### 3.1 统一使用 Squash History

新建审核单统一采用：

```bash
rbt post --squash-history BASE HEAD
```

普通线性历史和复杂 Merge 历史使用相同流程。

不再需要根据是否存在 Merge Commit 自动切换到 Commit History 模式。

保留现有 Git 差异提取逻辑，特别是：

- Merge Base 分析。
- 固定 BASE/HEAD SHA。
- 文件增加、删除、重命名处理。
- 冲突解决后的最终文件变化。
- 原始 Diff 预览。
- 预览与上传一致性校验。
- Git 状态变化检测。

默认审核范围仍为：

`merge-base(target, HEAD) → HEAD`

不要求目标分支的当前 HEAD 一定是源 HEAD 的祖先。

目标分支可能在开发者创建审核时已经前进。此时应保留现有范围语义，并提示相关风险，不应强制用户 Fetch、Merge 或 Rebase。

### 3.2 单独绑定真实 Commit ID

每次上传 Diff 成功后，在尚未发布的 Review Board Draft 中设置：

```python
draft.update(
    commit_id=plan.git.head,
    update_from_commit_id=False,
)
```

要求：

- `commit_id` 必须是本次审核固定的真实 Git HEAD SHA。
- 不得使用缩写 SHA。
- 不得生成临时提交替代真实 HEAD。
- 必须显式设置 `update_from_commit_id=False`。
- 不得让 Review Board 自动重新生成或替换已经上传的 Diff。
- 更新后必须重新读取服务器状态验证。

注意：`rbt post --field=commit_id=...` 不能被直接视为等价替代，因为 RBTools 的 `--field` 主要用于审核单扩展字段，并不保证设置 Review Request 的原生 `commit_id`。

### 3.3 审核文件内容与提交身份分别处理

RBTFlow 应明确区分：

**文件差异：**

`Diff = BASE Tree → HEAD Tree`

**提交身份：**

`Commit ID = HEAD SHA`

**合并目标：**

`Target Branch = 用户指定的目标分支`

不应将 BASE SHA、HEAD SHA、目标分支 HEAD 或 Diff Hash 混为同一个概念。

即使 Commit History 为空，也不影响最终审核单的有效性。

### 3.4 不修改用户 Git 历史

禁止为了完成审核而自动执行：

- Git Rebase / Reset。
- Git Squash。
- Git Cherry-pick。
- Git Replace / Graft。
- 创建临时 Clone 或 Worktree。
- 修改、伪造真实 Git Commit。
- 自动 Fetch、Merge 或 Push。

本次任务只涉及读取 Git、生成 Diff，以及与 Review Board 交互。

## 4. 主要代码修改范围

### `src/domain/model.ts`

补充 Review Request 和 Draft Resource 的 `commit_id` 字段。

应正确表示服务器返回的 `string | null`，并考虑旧审核单或服务器响应字段缺失的情况。

ReviewPlan 已包含真实 `git.head`，原则上无需重复增加一个完全等价的数据源。

### `src/adapters/rbtools.ts`

重点修改：

- `post()`：统一使用 `--squash-history`。
- `replaceFields()`：在同步草稿字段时，同时绑定 HEAD SHA。
- `verify()`：增加 Draft/Review Request 的 Commit ID 验证。
- 相关快照及错误处理逻辑。

必须确认更新顺序正确：

1. 上传 Diff。
2. 更新 Draft 字段与 Commit ID。
3. 重新读取审核单。
4. 校验 HEAD SHA。
5. 校验服务器保存的主 Patch。
6. 全部通过后，才将草稿视为成功创建。

保留现有 Patch Hash、文件列表、Repository ID 和审核单状态核对逻辑。

### `python/rbtflow_bridge.py`

扩展现有 `SyncDraft` 命令。

允许更新原生 Draft `commit_id`，但不要允许调用者随意传入危险的额外更新参数。

更新 Commit ID 时，明确传入：

```python
update_from_commit_id=False
```

要求使用现有 RBTools API 客户端和认证机制，不单独引入一套 HTTP 请求与 Token 管理逻辑。

### `src/application/reviewSession.ts`

完善提交状态机。

创建新审核单时，只有 Commit ID 与 Patch 全部校验通过，才能清除待确认写操作状态。

如果服务器已经创建审核单，但绑定 Commit ID 失败：

- 不自动重新创建另一张审核单。
- 不自动 Publish。
- 保留审核单 ID 和待确认操作记录。
- 支持从服务器重新读取和恢复。
- 给出准确错误原因。

保留现有 journal、fingerprint、取消与未知结果恢复机制。

### `src/application/requestSession.ts`

重点检查实际使用的 Publish 流程。

当前发布操作独立于本地 Git checkout，因此不能简单要求用户发布时仍停留在最初提交的 Git HEAD。

对于 RBTFlow 新流程创建的审核单，应在发布前确认：

- Draft 的 Commit ID 已绑定。
- Commit ID 对应此前确认的审核 HEAD。
- 最新审核 Diff 未发生未经确认的变化。
- 服务器仓库与目标分支符合预期。

发布后再次回读公开 Review Request，验证 Commit ID 和 Diff 未发生意外变化。

不要因此破坏用户通过 RBTFlow 发布其他合法旧审核单的能力。

### `src/application/repositoryStore.ts` 和 `src/views/reviewController.ts`

新建审核默认统一使用 Squash History。

检查并合理调整原有 Diff Mode 设置、缓存、预览及 Update Request Diff 流程。

可以取消面向普通用户的 Commit History / Squash History 选择，或者保留历史兼容入口，但不应让该选项再次影响新流程的默认 CI 兼容性。

需要特别考虑旧审核单：

- 旧的 With History 审核单仍必须能够正常查看、评论和发布。
- 不得默默把已有 `created_with_history=true` 的审核单转换为 Squash History。
- 对不兼容的旧审核单更新，明确给出可操作的提示。
- 不得因配置迁移导致已有审核单丢失。

## 5. 更新已有审核单

当用户修改代码并产生新的 HEAD SHA 后，应支持更新现有审核单。

正确流程：

1. 固定新的 BASE 和 HEAD。
2. 生成新的最终文件 Diff。
3. 检查审核单身份、作者、状态和当前版本。
4. 上传新的 Diff。
5. 将 Draft `commit_id` 更新为新的 HEAD SHA。
6. 回读核对 Diff 和 Commit ID。
7. 等待用户明确 Publish。

更新过程中不能出现“新 Diff + 旧 Commit ID”被视为成功结果的情况。

如果部分写入成功但后续失败，必须保留恢复能力，而不是自动重复上传。

## 6. 错误处理

重点考虑以下情况：

- Review Board 不支持设置 Commit ID。
- Commit ID 与其他审核单冲突。
- HEAD SHA 在预览之后发生变化。
- Git 引用变化导致原有 ReviewPlan 失效。
- RBTools 上传成功但 API 更新失败。
- API 更新成功但客户端未收到响应。
- 更新后服务器返回的 Commit ID 不一致。
- 审核单已经被外部修改。
- 发布前 Draft 不存在或发生变化。
- 更新旧 History 审核单时模式不兼容。

错误提示应准确、简短，并将详细诊断保留在现有 RBTFlow OutputChannel。

不得以未知错误为由自动重新发布、创建新审核单或强制修改 Git 历史。

## 7. 界面设计

保持现有 VS Code 原生 UI 风格，不引入 Webview。

推荐提交视图继续保留：

- Source Branch。
- Target Branch。
- BASE。
- HEAD。
- Reviewers / Groups。
- Bugs。
- Message。
- Preview Changes。
- Create Draft。

Diff Mode 可以从普通用户的主要操作路径中移除。

用户不需要理解 Review Board 的 Commit History 机制。

在适当位置显示完整 HEAD SHA，或提供复制能力，方便诊断。

原有 Changes、Review、Inbox、评论、通知、历史版本浏览功能保持不变。

## 8. 验收场景

至少覆盖：

**A. 普通线性 Git 历史**

创建 Squash History 审核单，确认最终 Diff 正确，Draft.commit_id 等于 HEAD SHA。

**B. HEAD 是双父 Merge Commit**

使用真实 Merge HEAD 作为 Commit ID，确认不出现非线性历史错误。

**C. 历史中包含多个 Merge Commit**

无论中间有多少次 Merge，最终只需要正确的 BASE → HEAD Diff 和真实 HEAD SHA。

**D. Merge 冲突解决**

验证最终 Diff 包含冲突解决结果，而不是仅包含某个父分支的历史。

**E. 目标分支已经前进**

确认仍可按明确基线生成审核，不因 `BASE != Target HEAD` 被错误拒绝。

**F. 更新审核单**

HEAD 变化后，更新 Diff 与 Commit ID，防止旧 SHA 遗留。

**G. 创建后部分失败**

模拟 Commit ID 写入失败、服务器响应丢失等情况，检查恢复逻辑。

**H. 旧审核单兼容**

确认已有 History 模式审核单的阅读、审阅和发布没有回归。

## 9. 验收不变量

新创建并成功核对的 RBTFlow 草稿必须满足：

```text
created_with_history = false
commit_count = 0

Draft.commit_id = ReviewPlan.git.head

Server.patch_hash = Preview.patch_hash

Draft.branch = SelectedTargetBranch

ReviewRequest.repository = SelectedRepository
```

发布成功后：

```text
ReviewRequest.commit_id = ReviewPlan.git.head
```

上述 SHA 必须是真实 Git 对象的完整 SHA。

还应保证原始 Git HEAD、分支引用、索引与工作区不会被插件主动修改。

## 10. 开发要求

完成后说明：

- 修改的文件和核心行为。
- 新增或调整的测试。
- 旧审核单兼容性。
- 仍然存在的限制。
- 是否能够满足本方案的所有验收不变量。

**最终交付目标：RBTFlow 对复杂 Git 历史统一使用真实最终 Diff + 真实 HEAD SHA，兼容既有 CI 审核关联机制，不再受 RBTools Commit History 非线性限制。**