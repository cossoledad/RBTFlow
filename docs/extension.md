# RBTFlow 0.2.0 扩展

当前支持在 VS Code 侧边栏完成提交、对比和审阅。文件使用原生 TreeView，内容使用只读原生 diff，
行内意见使用 CommentController。运行时复用工作区机器上的 Git/RBTools，连接现有 Review Board；
本仓库的本地站点仅供开发，无需额外常驻 RBTFlow 后端或 Docker。

## 界面和操作

活动栏 RBTFlow 提供“审核”和“更改”两个视图；可通过 VS Code 原生视图菜单/拖放移至下方 Panel。
仓库选择来自内置 Git 扩展和工作区目录，规范根路径去重；已选择仓库会记住，各 worktree 独立。

| 位置 | 内容 |
| --- | --- |
| 提交 | 目标主线、标题、说明、审批人、bug 号，预览和保存草稿 |
| 更多信息 | 审批组、测试说明、分支展示标签、更新说明、已有审核单 ID |
| 原生齿轮/仓库设置 | 服务器、服务器 Git 仓库、目标主线、显式 BASE、审核模式、rbt 路径、超时、Token |
| 审阅 | 按 ID 或“我的…”打开，切换差异版本，填写意见、Ship It、保存/发布审阅 |
| 更改 | 三类来源共用的文件列表，点击进入固定版本原生 diff；工具栏可查看原始 patch |

**提交**：预览 → 检查更改 → 保存/更新草稿 → 单独发布。已有单先载入再预览；审核字段会完整替换，
包括移除审批人/bug 和清空可选字段。`branch` 是展示标签，Git 合入目标由目标主线决定。

**审阅**：输入审核单 ID，打开文件，在 diff 行号处添加行内意见；填写总体意见并按需勾选 Ship It，
先保存审阅草稿，再发布。已保存至服务器的评论显示为服务器草稿；当前版本的编辑/删除需在网页操作。
本地未保存评论可通过原生线程标题的删除按钮移除。

统一对比支持本地提交预览、自己的已提交审核（含自己的未发布差异草稿）、他人的已发布审核。
不会请求他人的私有提交草稿，即使当前用户是管理员。远程文件通过 Review Board 的
original-file/patched-file 获取，包含服务端 parent diff 重建，不用本地 HEAD 冒充远程版本。
因此查看他人代码无需 checkout 对方分支，也不要求其服务器仓库映射到当前 Git remote；编辑自己的提交仍要求仓库匹配。

## 缓存、配置和认证

普通状态保存在扩展 `globalState`，按 Git 规范 worktree 根路径区分，同一 profile/扩展宿主下换工作区或重开窗口仍可使用，
不会写入源码或 `.vscode/settings.json`。不同克隆/worktree、VS Code profile 和远程宿主分别存储。
0.1.0 的 workspaceState 表单和待确认提交会迁移，确认写入新存储后才移除旧待确认记录。

| 状态 | 保存规则 |
| --- | --- |
| 仓库默认值 | 服务器/仓库 ID、目标主线、BASE、模式、审批人/组、bug、分支、测试说明 |
| 自己的提交草稿 | 全表单，含标题/说明、更新说明和已有单号；新建时清空这些一次性内容 |
| 工具 | 仓库自己的 rbt 路径和超时，未指定则使用 VS Code 设置 |
| 审阅草稿 | 按仓库 + 服务器 + 登录用户 + 审核单 + 差异 ID 单独存储，包括本地行内评论 |
| 导航 | 当前仓库、提交/审阅模式、最近单号、更多信息展开状态 |
| 凭据 | API Token 在 SecretStorage 中按服务器保存，不放入普通配置 |

浏览别人的审核、载入服务器字段或切换 diff 不会覆盖仓库默认审批人和自己的提交表单。
初次打开可从 `.reviewboardrc`/RBTools 配置读取服务地址、tracking branch、默认人/组和分支标签。
之后沿用仓库缓存；服务器仓库优先使用明确选择、配置中的 REPOSITORY，再匹配 Git remote。
重开后需重新预览或打开远程单号，避免把旧缓存当作已验证的服务器/Git 状态。

| VS Code 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `rbtflow.rbtPath` | `rbt` | 工作区机器上的 executable，不能附加 shell 参数 |
| `rbtflow.serverUrl` | 空 | 没有仓库缓存时的服务器默认值，空则用 RBTools 配置 |
| `rbtflow.commandTimeoutSeconds` | 120 | 单条命令超时，5–1800 秒 |

服务器设置留空可复用现有 RBTools 配置，支持 `rbt login` 和已有客户端证书配置。
连接保留实际配置 URL，不替换为服务器广告的 canonical URL，以保留代理前缀/cookie 语义。
每条 rbt 命令使用私有临时配置，禁止自动发布/stamp/打开浏览器；Token 不进入 argv，日志脱敏。
临时文件在 `globalStorageUri/jobs`，Linux/WSL 目录 `0700`、文件 `0600`，进程退出即清理。
`.reviewboardrc` 是可执行 Python，扩展仅在受信任的文件系统工作区中启用。

## 范围和写操作合同

默认审核 merge-base(target, HEAD) → HEAD，显式 BASE 必须是 HEAD 祖先。
包含 merge 的分支使用汇总 diff，保留侧分支和手工冲突解决的净改动，不改写本地历史。
逐提交模式仅支持连续线性、无空提交的历史；更新已有单保持创建时的模式。
工作区未提交内容排除；merge/rebase/cherry-pick 未结束时拒绝新建审核计划。

本地预览固定 HEAD/目标/BASE SHA、worktree/common-dir、Git/remote 指纹、工具/服务器版本、主 patch hash、
服务器 repository ID 和旧单快照。上传前重查这些状态及登录用户；字段变化无需重新生成 patch。
上传后核对字段、文件集合和服务端主 patch，保存成功与已发布分别显示。
主 patch 比较仅去除 rbt 控制台额外附加的末尾换行。

审阅只写最新已发布、仍处于 pending 的版本；发布前重查版本和登录用户。
行内评论使用服务器 diff-data 的虚拟行映射，实际源文件/目标文件行号不能直接传给 first_line。
例如删除 B/C 后，目标文件第 2 行 D 对应虚拟行 4；没有精确映射的范围拒绝写入。
服务器草稿被其他窗口修改时保留本地内容并要求重新载入；重新载入前保留一份本地备份。
草稿含其他差异版本的评论时，必须先在网页处理，避免在当前版本下发布未核对的历史意见。
保留并显示已有 body_bottom，保存/发布后核对 body、Ship It、评论内容、范围、filediff 和操作标记。
API 评论合同参考 [Review Board diff comment 资源](https://www.reviewboard.org/docs/manual/latest/webapi/2.0/resources/review-diff-comment/)。

提交和审阅均在写操作前持久化待确认记录；收到 ID 后立即保存。失败、取消或响应丢失时不自动重试，
通过“检查服务器”回读并核对，部分完成则保留待确认状态。新单/评论标记用于识别响应丢失后的结果。
只有用户人工核对后才能显式清除待确认记录。

客户端快照/时间戳检查不是服务器原子 CAS，检查与写入之间仍有并发窗口。
主 patch 已冻结并回读；完整 parent diff 上传包冻结尚未实现，父 diff 在固定 SHA/remote 下由 RBTools 生成，
真实集成测试另外验证服务端重建结果。
进程输出预算 64 MiB，快照单文件 16 MiB，列表最多 10,000 项；触限报错，不静默截断。

## 开发和实现入口

Node 22+、npm、Git；本地站点使用 Python 3.12，核心 Git 测试还用 Python 3 创建隔离样例。
开发入口按 lockfile hash 执行 npm ci；普通编译先清理 build/extension，避免旧界面进入 VSIX。

```bash
bash dev.sh prepare       # 安装固定依赖并编译
bash dev.sh watch         # 持续编译
bash dev.sh test          # 核心/仓库缓存/行映射
bash dev.sh integration   # 确保本地服务就绪，真实提交和跨用户审阅
bash dev.sh host-smoke    # 实际 VS Code Extension Host
bash dev.sh package       # build/rbtflow-0.2.0.vsix
```

F5 选择 **Run RBTFlow (local lab)**，自动启动本地站点并编译，然后打开 build/workspace。
实际机器在仓库设置中指定 rbt。可用 **Extensions: Install from VSIX** 安装开发包，尚未执行 Marketplace 发布。

| 入口 | 职责 |
| --- | --- |
| `src/extension.ts` | Git 仓库发现、原生视图注册、命令和生命周期 |
| `src/application/repositoryStore.ts` | 仓库默认值、自己的草稿、持久化迁移 |
| `src/application/reviewSession.ts` | 原有提交状态机、固定范围、post/publish 和恢复 |
| `src/application/reviewBrowser.ts` | 远程审核元数据、版本、文件和自己的审阅草稿 |
| `src/application/feedbackSession.ts` | 审阅写操作、最新版本检查、回读、恢复 |
| `src/domain/model.ts`、`comparison.ts` | 提交与对比数据合同，虚拟行映射 |
| `src/adapters/git.ts`、`process.ts`、`rbtools.ts` | Git DAG、无 shell 进程、RBTools/API/认证 |
| `src/views/reviewSidebar.ts`、`reviewController.ts` | 侧边栏生命周期、按仓库会话、消息边界 |
| `src/views/changesTree.ts`、`snapshots.ts`、`reviewComments.ts` | 原生更改、只读 diff、行内意见 |
| `media/review.*` | 极简侧边栏表单，VS Code 主题、CSP、本地资源 |
| `python/rbtflow_bridge.py` | 在 rbt 自己的解释器里读取配置/文件/行映射和精确写入草稿 |

Python bridge 通过官方 rbtools_commands entry points，经进程专属 PYTHONPATH 加载；
没有向全局 Python 安装包或猜测 rbt 的解释器。应用状态机与界面均在 TypeScript 中。

## 验证边界和证据

本轮在本地 Review Board 7.0.6 / RBTools 7.0 / Git 2.53.0 / Node 26.7.0 / TypeScript 7.0.2 上验证。
2026-11-16 已通过 10 项核心测试、4 组真实集成测试和 16 项真实 VS Code 1.136.1 Extension Host 检查。
集成测试覆盖五类 Git 图、上传后完整 tree、字段清空、并发变动拒绝、跨用户权限、服务端 parent diff 重建、
多 diff revision、删除行后的评论定位、Ship It 和两类写操作响应丢失恢复。
Host 另验证真实 CSP 脚本渲染、原生 TreeView/diff/CommentController、实际 global Memento 恢复、
查看他人不会修改自己的默认值、原生评论到服务器发布，以及新建时默认值沿用。

Host 使用隔离的用户/扩展目录。默认下载 VS Code 1.136.1，VSCODE_EXECUTABLE_PATH 可复用 Electron；
无 DISPLAY 尝试 xvfb-run，缺失明确报告 BLOCKED。RBTFLOW_EXTENSION_PATH 可对已解包 VSIX 运行相同检查。
本机验证将 Xvfb/依赖解包至 build/host-tools，复用 javavscode-terminal 的 Electron，没有修改该项目或安装系统包。
可选 RBTFLOW_CDP_PORT 供测试窗口截图，人工检查了 300px 侧边栏的实际布局；这不代表所有主题、键盘和平台已验收。

证据文件：

- `build/test-core-v2.log`：10 项核心/缓存/行映射测试。
- `build/test-integration-v2.log`：原有三组真实提交回归。
- `build/test-review-v2.log`：跨用户、远程对比、精确行内评论、审阅发布和丢失响应恢复。
- `build/review-test-fixture.json`：为 Host 准备的另一作者审核单和预期服务端文件内容。
- `build/host/latest.json`、`build/test-host-v2.log`：真实扩展宿主检查和审核收据。
- `build/host/submit.png`、`build/host/review.png`：实际 Electron 窗口截图。
- `build/rbtflow-0.2.0.vsix`、`build/package-validation-v2.json`：安装包、文件清单与 SHA-256。

目前仅覆盖已提交的 Git 文本代码、单个差异版本对比、顶层审阅意见/行内评论/Ship It。
评论回复、issue 状态处理、附件/图片、interdiff、merge/land/push 仍需后续实现或网页操作。
已接受 RBTools 5+ 入口，但公司的具体版本、SSO/代理/证书、Windows/macOS、LFS/submodule、大仓库容量
和全快捷键流程尚未验收。成功测试清理自己注册的临时 worktree，失败保留诊断；本地服务数据和日志保留。
