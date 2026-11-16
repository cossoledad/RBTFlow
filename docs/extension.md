# RBTFlow 0.3.0

全部交互使用 VS Code 原生控件，默认简短英文。没有 Webview、HTML 输入框、select 或自绘折叠区域。
运行时复用工作区机器上的 Git/RBTools，连接现有 Review Board；本地站点只供开发，不使用 Docker。

## 三个原生视图

| 视图 | 职责 | 输入方式 |
| --- | --- | --- |
| Submit | 当前分支、目标主线、审批人/组、Bug、提交信息；预览、生成新草稿 | Quick Pick、Input Box、原生编辑器 |
| Review | 选中的服务器审核单：版本、元数据、发布、更新差异、审阅、浏览器、恢复 | Quick Pick、Input Box、原生编辑器、原生复选框/评论 |
| Changes | 当前预览或选中审核单的文件，目录树/列表切换、原生 diff、只读原始 patch | 原生 TreeView / readonly FileSystemProvider |

三个视图使用 VS Code 自身的折叠、菜单和拖放，可移到 Panel。多根工作区可在 Submit 工具栏切换仓库。
工具栏命令可通过 hover 查看英文名称，也可从命令面板执行。

**常见提交**：在 Submit 选择 Target / Reviewers / Bugs → Preview Changes → 在 Changes 检查 → Create Draft。
生成后自动加载服务器版本到 Review，Submit 清除本次标题、说明和单号，沿用仓库默认配置准备下一次提交。
Publish Request、编辑服务器详情、更新已有差异、浏览器入口均不再由 Submit 承担。

标题和说明使用固定 BASE..HEAD 的 Git log，顺序和格式与 RBTools GitClient 相同，并调用 rbt 自己的
`parse_commit_message`（包含项目配置的 COMMIT_MESSAGE_PARSER）。说明为空时回退到生成的标题，满足服务端必填要求。
点击 Message 可更改 Title / Description / Bugs，标题和说明的手动覆盖绑定当前 HEAD；换提交后重新使用 Git 默认值。
不再提供 Testing Done / Change Description 输入；已有服务器元数据保留，Git 消息中解析出的 testing_done 仍可随新请求提交。

**管理服务器草稿**：Review 的 Publish Request 独立于本地 checkout 和 ReviewPlan。
缺少审批人时先打开原生多选框（人和组均可搜索），确认后保存字段再发布；取消不会发送发布写操作。
老草稿说明为空时使用其标题补齐，不从可能已切换的本地分支猜测内容。
Edit Request Details 使用原生输入；多行 Description 在原生编辑器中 Ctrl+S 应用，支持同一编辑器连续保存。
Update Request Diff 第一次生成当前分支的更新预览，在 Changes 检查后用 Review 中的 Save Diff 上传。

**审阅代码**：Open Request by ID 或 My Requests 打开审核单，Version 使用 Quick Pick。
自己的未发布差异草稿和已发布版本都可查看；不会探测他人的私有提交草稿，即使当前用户是管理员。
远程文件从服务器 original-file/patched-file 读取，包含 parent diff 重建，无需 checkout 对方分支。
编辑自己的差异仍要求匹配服务器 Git 仓库。

Comment 使用原生编辑器，Ctrl+S 保存本地总体意见；Ship It 是原生 TreeView 复选框。
行内评论从原生 diff 行号处添加。Save Review 保存服务器审阅草稿，Publish Review 再独立发布。
本地未保存评论可在原生线程上删除；已保存评论的修改/删除、回复、issue 等仍使用网页。
描述和评论编辑临时文档位于扩展私有 inputs 目录，目录 0700、文件 0600（Linux/WSL），不写入源码。

## 发布失败与日志

本次用户报告的 #60 经本地服务回读，草稿审批人/组为空，description 也为空。
服务端要求至少一个审批人或组，以及非空标题和说明；原实现又将明确拒绝误留在未知写操作状态。

现在分开处理：

- 缺少审批人/标题/说明：写操作前校验；UI 引导补齐，不产生待确认发布记录。
- 服务端明确拒绝且回读确认草稿未改变：保留已知草稿，清除本次待确认记录，详细原因写日志。
- 超时、取消、响应丢失、部分完成：保留持久化记录；Review 出现简短 Check Server 入口，不自动重试。
- 升级时发现旧的待确认发布：回读字段、文件和主 patch；确认服务器仍是完整草稿后恢复草稿，允许继续编辑和发布。

发布 RPC 通过小型 RBTools bridge 保留结构化 API error code，避免只解析 `rbt publish` 的长文本报错。
真实 API 225 已验证为 ApiError，发布后的网络丢失也有故障注入恢复测试。
原始的 #60 没有被测试自动发布或改写；新的流程在隔离测试请求上验证。

所有详细诊断在 **Output → RBTFlow**（LogOutputChannel），包含命令、范围、结果、stdout/stderr。
界面只用原生简短英文通知，不显示堆栈、长 URL、日志卡片或待确认说明面板。
确需人工接管部分写入时，Review 菜单仅在有待确认记录时提供 Clear Recovery Record，使用原生选择和确认后清除。

## 缓存和认证

普通状态在 globalState，按规范 Git worktree 根路径区分，同一 profile/扩展宿主下重开或换工作区仍可沿用。
不同克隆/worktree、profile、远程宿主分别存储。0.1 的 workspaceState 表单/待确认记录迁移仍保留。
升级 0.2 时备份原提交表单，将旧服务器单号迁入 Review，不再当作 Submit 的更新目标。

| 状态 | 保存范围 |
| --- | --- |
| 默认值 | 服务器/仓库 ID、目标主线、BASE、模式、审批人/组、Bug、分支标签 |
| 提交信息 | 当前本地草稿、绑定 HEAD 的自定义标题/说明；生成后清空一次性内容 |
| 工具 | 每仓库 rbt 路径和超时，未设置则用 VS Code 配置 |
| Review 导航 | 服务器 + 单号，重开重新读取服务器内容 |
| 审阅草稿 | 仓库 + 服务器 + 登录用户 + 请求 + 差异 ID，保存总体意见/Ship It/本地行内评论 |
| Changes | 每仓库 Tree / List；折叠交由原生 TreeView 管理 |
| 凭据 | SecretStorage，按服务器 URL 存 Token |

浏览他人或载入服务器字段不会覆盖自己的提交配置；显式为自己的请求选择审批人/Bug 后更新仓库默认值。
初次可从 .reviewboardrc / RBTools 配置读取 URL、tracking branch、审批人/组。
服务器仓库优先明确选择、配置中的 REPOSITORY，再匹配 Git remote。
服务器 URL、BASE、模式等低频内容在 Repository Settings 中。

| VS Code 设置 | 默认 | 用途 |
| --- | --- | --- |
| rbtflow.rbtPath | rbt | 工作区机器的 executable，不接受 shell 参数 |
| rbtflow.serverUrl | 空 | 仓库没有缓存时的默认值，空使用 RBTools 配置 |
| rbtflow.commandTimeoutSeconds | 120 | 单条命令超时，5–1800 秒 |

兼容 rbt login 和已有证书配置，保留实际配置 URL 及代理前缀；Token 不进入 argv，日志脱敏。
每条 rbt 命令有私有临时配置，禁止自动发布/stamp/打开浏览器，退出删除。
.reviewboardrc 是可执行 Python，因此仅在受信任的文件系统工作区启用。

## 数据与写操作合同

本地提交范围仍是 merge-base(target, HEAD) → HEAD；显式 BASE 必须是祖先。
merge 分支使用汇总 diff，不重写 Git 历史，保留侧分支和冲突解决；逐提交模式要求连续线性、无空提交。
工作区未提交内容排除；merge/rebase/cherry-pick 未结束时拒绝新预览。

ReviewPlan 固定 worktree/common-dir、SHA、Git/remote 指纹、工具和服务版本、repository ID、主 patch hash、旧单快照。
上传前重查，上传后回读字段、文件和主 patch；Git 状态事件只有检测到实际指纹变化才使计划失效。
原始 patch 使用冻结的预览字节或指定服务器版本，和文件快照一样由只读 FS 提供，不能编辑/覆盖。

RequestSession 负责服务器页面元数据和发布：核对作者、pending 状态、快照、最新差异 ID/hash、字段，
写前持久化 journal，写后回读；发布不要求本地分支仍处于上传时的位置。
保存元数据时保留测试说明/分支等未编辑字段。Python bridge 额外检查 request/draft 的 last_updated。
这些检查不是服务端原子 CAS，仍存在检查与写入之间的并发窗口。

FeedbackSession 只审阅最新已发布版本。行内评论映射使用服务器 diff-data 虚拟行：
例如删除 B/C 后，目标文件第 2 行 D 是虚拟行 4；没有精确映射时拒绝写入。
服务器草稿被外部修改时保留本地内容，要求 Reload；跨差异版本的已有评论要求先在网页处理。
保存/发布核对意见、Ship It、已有附加意见、评论内容、filediff、行范围、操作标记，避免静默混入未知评论。

所有写操作失败后都不盲目重发。主 patch 已冻结并回读，但完整 parent diff 上传包冻结仍未实现；
父 diff 由固定 SHA/remote 下的 RBTools 生成，集成测试验证服务端重建。
进程输出预算 64 MiB、单文件快照 16 MiB、列表 10,000 项，触限明确报错。

## 开发、入口和验证

```bash
bash dev.sh prepare       # 固定 Node 依赖、清理旧产物、编译
bash dev.sh watch
bash dev.sh test          # 11 项核心/缓存/文件树/行映射
bash dev.sh integration   # 真实提交、跨用户审阅、服务器草稿和发布恢复
bash dev.sh host-smoke    # 原生 VS Code 控件验收，自动准备所需本地数据
bash dev.sh package       # build/rbtflow-0.3.0.vsix
```

F5 选择 Run RBTFlow (local lab)；成品扩展标识为 ganjinbo.rbtflow，也可使用 Extensions: Install from VSIX。
发布者从旧测试包的 cossoledad 改为 ganjinbo，两者的扩展存储独立；发布步骤见 [Marketplace 发布](publishing.md)。
Node 22+ / Git / RBTools；本地站点 Python 3.12。新提交信息解析器使用 RBTools 7 的 API，兼容性实测为
RBTools 7.0 / Review Board 7.0.6；公司版本、SSO/代理/证书仍需试点。

| 入口 | 职责 |
| --- | --- |
| src/extension.ts | Git 发现、原生命令、LogOutputChannel、生命周期 |
| src/views/reviewSidebar.ts | 三视图协调、原生行项目/复选框、对比、浏览器归属 |
| src/views/reviewController.ts | 每仓库动作、Submit→Review 交接、Git 默认信息、恢复 |
| src/views/nativeInputs.ts | 原生搜索多选框、短输入/多行编辑器支持 |
| src/views/changesTree.ts / src/domain/fileTree.ts | 目录树/列表，保留原文件索引和评论身份 |
| src/views/snapshots.ts / reviewComments.ts | 只读文档和原生行内评论 |
| src/application/repositoryStore.ts | 缓存、迁移和默认值 |
| src/application/reviewSession.ts | 固定范围、上传、旧发布状态兼容恢复 |
| src/application/requestSession.ts | 服务器页面编辑、发布、结构化拒绝和 journal 恢复 |
| src/application/reviewBrowser.ts / feedbackSession.ts | 远程版本、审阅写操作 |
| src/adapters / python/rbtflow_bridge.py | Git、进程、RBTools/认证及精确服务器操作 |

2026-11-16 在 Git 2.53.0 / Node 26.7.0 / TypeScript 7.0.2 / VS Code 1.136.1 上验证。
11 项核心、5 组真实集成（其中新增服务器请求测试单独记录）、14 项真实 Extension Host 检查。
Host 使用隔离 profile 和带真实嵌套/Unicode 文件的临时 worktree，覆盖原生多选框确认审批人后发布、
Git 默认信息、草稿交接、服务器说明连续保存、目录树/列表、readonly patch 原生打字/写入拒绝、
原生编辑器/复选框/评论、缓存恢复及另一作者的审阅发布。

Host 默认下载 VS Code 1.136.1，VSCODE_EXECUTABLE_PATH 可指定已有 Electron；无 DISPLAY 尝试 xvfb-run，
缺失报告 BLOCKED。RBTFLOW_EXTENSION_PATH 支持对 VSIX 解包文件验收；RBTFLOW_CDP_PORT 为可选测试截图端口。
本机仅临时解包 Xvfb/依赖，复用 javavscode-terminal 的 Electron，没有改动该项目或安装系统包。

证据：build/test-core-v3.log、build/test-integration-v3.log、build/test-request-v3.log、
build/test-host-v3.log、build/host/latest.json、build/package-validation-v3.json。
实际窗口截图：build/host/reviewers.png、review.png、submit.png。
成功测试清理自己的 worktree，失败保留诊断。本地站点保留运行，测试显示进程结束后关闭。

尚未覆盖评论回复、issue 生命周期、附件/图片、interdiff、merge/land/push、未提交内容审核；
Windows/macOS、所有主题/快捷键、公司服务兼容和大仓库容量未完成验收。
