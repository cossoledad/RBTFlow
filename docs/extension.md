# RBTFlow 0.6.2 (development)

全部交互使用 VS Code 原生控件，默认简短英文。没有 Webview、HTML 输入框、select 或自绘折叠区域。
运行时复用工作区机器上的 Git/RBTools，连接现有 Review Board；本地站点只供开发，不使用 Docker。

## 原生视图

| 视图 | 职责 | 输入方式 |
| --- | --- | --- |
| Submit | 当前分支、目标主线、冻结 BASE/HEAD、审批人/组、Bug、提交信息；预览、生成新草稿 | Quick Pick、Input Box、原生编辑器 |
| Inbox | 当前连接的待审请求、未读优先、原生通知、阅读状态 | TreeView、原生通知、上下文菜单 |
| Review | 选中的服务器审核单：版本、元数据、发布、更新差异、审阅、浏览器、恢复 | Quick Pick、Input Box、原生编辑器、原生复选框/评论 |
| Changes | 当前预览或选中审核单的文件，目录树/列表切换、原生 diff、只读原始 patch | 原生 TreeView / readonly FileSystemProvider |

四个视图使用 VS Code 自身的折叠、菜单和拖放，可移到 Panel。多根工作区可在 Submit 工具栏切换仓库。
工具栏命令可通过 hover 查看英文名称，也可从命令面板执行。

**常见提交**：在 Submit 选择 Target / Reviewers / Bugs → Preview Changes → 在 Changes 检查 → Create Draft。
生成后自动加载服务器版本到 Review，Submit 清除本次标题、说明和单号，沿用仓库默认配置准备下一次提交。
Publish Request、编辑服务器详情、更新已有差异、浏览器入口均不再由 Submit 承担。

Repository Settings → Diff mode 提供三种模式，按仓库保存：Final diff + HEAD（默认）、Squash diff、Commit history。
前两者使用最终汇总差异；只有默认模式强制绑定完整 HEAD，History 要求服务支持且提交链线性、无空提交。
预览的 BASE/HEAD 和服务器 Commit 可复制；Draft.branch 保存选择的完整目标引用，例如 origin/main。
绑定/发布核对、部分写入恢复和旧 History 单规则见 [最终 Diff 与 HEAD 绑定](final-diff.md)。

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
本地未保存评论可在原生线程上删除；已保存评论的修改/删除、回复写入、issue 状态操作仍使用网页。
描述和评论编辑临时文档位于扩展私有 inputs 目录，目录 0700、文件 0600（Linux/WSL），不写入源码。

## 评论阅读与待审通知

Review → Comments 是原生可展开的评论列表，按审阅人/回复分组；包含公开总体意见的头尾、general/diff/file-attachment/screenshot 评论和公开回复。
显示作者、时间、Ship It、文件/差异版本和 issue 状态。点击行内评论直接定位差异并展开原生线程；其他项目打开只读全文。行内评论菜单也可阅读全文，View All Comments 读取完整公开讨论。
先读取审阅列表，展开时读取对应评论/回复，使用已有 RBTools 认证和分页/容量限制；失败记录日志并允许 Refresh Comments 重试。
私有审阅和未发布回复不显示。附件/截图只显示评论文字，不下载图片或自动打开评论中的链接。
行内评论使用 filediff ID、版本和统一服务器行映射定位；删除行聚焦原始侧。公开回复在原生线程中跟随父评论分组，显示作者、时间和 issue 状态。
当前版本内定位不重载审核或覆盖本地意见；历史版本只读，添加意见/Ship It 使用最新已发布版本。
interdiff 评论只读，不推测行位置。
历史文件元数据读取失败不隐藏评论正文，会标识 File unavailable。

Inbox 只列当前连接中直接或通过审批组分配给当前登录用户的公开 pending 请求，排除本人提交、仅加星和已关闭请求。
范围是该服务器的待审列表，不限于当前 Git 仓库；多根工作区跟随当前选中仓库的连接，后台不并行扫描其他服务器。
自动刷新默认每 60 秒，范围 30–3600 秒，可在 Repository Settings 或 VS Code 配置中关闭/调整；每仓库设置优先。
第一次同步静默，之后的新分配、公开评论/回复、发布字段、新 Diff 和审批/issue 统计变化合并为原生通知；相同活动去重，自己的公开审阅动作不反复提醒。
网络或认证失败保留已知列表、显示简短离线提示并写 Output，失败不会生成空列表或虚假通知；切换连接时清除旧界面并重新静默同步。
这是工作区打开期间的轮询，不是服务端推送，也不会在 VS Code 退出后接收通知。

未读优先，Inbox badge 显示数量；已读项目使用原生淡色装饰。成功显式打开最新已发布版本才自动标记已读，自动恢复上次页面不代替阅读。
支持 Mark as Read / Unread 和 Mark All as Read；标记绑定实际看到的内容版本，轮询与打开并发时不把未看到的新版本读掉。
阅读记录保存在 globalState，按服务器 + 登录账号隔离，在同一扩展 profile/宿主内跨仓库共享；不写入服务器，也不与浏览器阅读状态同步。
阅读不代表 Ship It；审批仍使用 Review 原有的意见、Ship It、Save Review / Publish Review 流程。

## 插件模式与自动刷新

Review 工具栏的 Clear Review 清空当前选择及 Changes，保留服务器草稿和本地意见。Submit 中的 Open draft 可重新进入上一次打开或创建的草稿。Discard 需要确认。已发布请求有未发布修改时只丢弃修改草稿，其余自己的待审请求会关闭为 Discarded。

Repository Settings → Plugin mode 默认使用 Minimal。启动后可以按 ID 或 Open last request 手动打开审核，预览、创建和发布草稿以及评论、Ship It 均由当前操作触发。Full 模式提供 Inbox 与自动刷新，可单独关闭通知轮询。

勾选 Ship It 后，Publish Ship Its 可选择 1–10 条独立审阅。当前意见和行内评论随第一条发布，后续沿用当前账号。部分失败时查看 Output 和待核对记录，按已确认数量继续。项目审批门槛由服务端判定。

Full 模式默认每 60 秒刷新，窗口重新获得焦点也会检查。关闭自动刷新后手动 Refresh Inbox 仍可刷新当前请求。
分配给自己的待审单与自己发布的 pending 请求通过 last-update 检测公开评论、回复、Diff 和元数据活动；审批/issue 计数补充变化检测。
自己发布的请求收到反馈也会通知，但当前 Inbox 列表仍只列直接/组分配，统一活动队列属于后续规划。
首次同步静默，按服务器/账号去重，自己的公开审阅动作不会反复通知；读取失败不推进活动游标。
当前选中请求还回读自身可见的私有请求/审阅草稿；不会探测别人的私有请求草稿。

同版本后台更新保持 comparison ID、只读代码、打开的本地输入及意见；刷新 Comments 树、已显示行内线程和打开的 View All Comments 文档。
单条评论全文仍是只读快照。新 Diff 提示 Open latest，确认前保留旧代码并阻止发布/审阅写入。
打开的描述字段若被网页改动，其后保存会阻止覆盖，保留输入文本；其他字段变化可回读后合并保存。
外部私有审阅草稿变化且存在本地意见时，保留本地意见并要求 Reload。

浏览器仅访问草稿会在本地 Review Board 7.0.6 添加 extra_data.calculated_trophies 缓存。
校验忽略这个已确认缓存、只读统计和链接展示字段，规范化无序集合；标题、说明、审批人身份、未知扩展字段、时间、状态与提交身份仍受保护。
旧待确认日志重新按实际内容计算，上传/发布继续独立校验 patch、文件集合和 HEAD。
这些前后校验不等于跨 API 的服务器原子事务。

## 发布失败与日志

服务端发布要求至少一个审批人或组，以及非空标题和说明。明确拒绝和未知写入结果分别处理。

现在分开处理：

- 缺少审批人/标题/说明：写操作前校验；UI 引导补齐，不产生待确认发布记录。
- 服务端明确拒绝且回读确认草稿未改变：保留已知草稿，清除本次待确认记录，详细原因写日志。
- 超时、取消、响应丢失、部分完成：保留持久化记录；Review 出现简短 Check Server 入口，不自动重试。
- 升级时发现旧的待确认发布：回读字段、文件和主 patch；确认服务器仍是完整草稿后恢复草稿，允许继续编辑和发布。

发布 RPC 通过小型 RBTools bridge 保留结构化 API error code，避免只解析 `rbt publish` 的长文本报错。
真实 API 225 已验证为 ApiError，发布后的网络丢失也有故障注入恢复测试。
测试只在隔离请求/合成 Git 仓库验证，不改写用户审核单。

所有详细诊断在 **Output → RBTFlow**（LogOutputChannel），包含命令、范围、结果、stdout/stderr。
界面只用原生简短英文通知，不显示堆栈、长 URL、日志卡片或待确认说明面板。
确需人工接管部分写入时，Review 菜单仅在有待确认记录时提供 Clear Recovery Record，使用原生选择和确认后清除。

## HEAD 占用冲突

Final diff + HEAD 在预览和上传前查找同仓库、同 SHA 已有审核单以及自己的私有草稿。已有关联时 Review 提供 Open existing，不再创建另一份失败草稿。
明确的 API 227 和旧版本留下的部分上传记录会被识别为占用冲突，隐藏 Complete draft；Check server 只重新检查，不重复绑定写入。
Open existing 或 Keep draft and continue 会先保存完整本地恢复归档，再解除当前阻塞。服务器上的失败草稿和已有审核单都保留；打开后是否更新或发布仍由用户明确操作。
不可见的占用者不泄露单号；冲突缓存按服务器、账号、仓库、HEAD 区分。详细合同见 [提交与恢复](final-diff.md#commit-conflicts-and-recovery-061)。

## 缓存和认证

普通状态在 globalState，按规范 Git worktree 根路径区分，同一 profile/扩展宿主下重开或换工作区仍可沿用。
不同克隆/worktree、profile、远程宿主分别存储。0.1 的 workspaceState 表单/待确认记录迁移仍保留。
升级 0.2 时备份原提交表单，将旧服务器单号迁入 Review，不再当作 Submit 的更新目标。

| 状态 | 保存范围 |
| --- | --- |
| 默认值 | 服务器/仓库 ID、目标主线、BASE、Diff mode、审批人/组、Bug |
| 提交信息 | 当前本地草稿、绑定 HEAD 的自定义标题/说明；生成后清空一次性内容 |
| 工具 | 每仓库 rbt 路径和超时，未设置则用 VS Code 配置 |
| 通知设置 | 每仓库开关和轮询间隔，未设置则用 VS Code 配置 |
| Inbox 已读/提醒 | 服务器 + 登录账号 + 请求内容指纹；同一 profile/宿主共享 |
| Review 导航 | 服务器 + 单号，重开重新读取服务器内容 |
| 审阅草稿 | 仓库 + 服务器 + 登录用户 + 请求 + 差异 ID，保存总体意见/Ship It/本地行内评论 |
| Changes | 每仓库 Tree / List；折叠交由原生 TreeView 管理 |
| 凭据 | SecretStorage，按服务器 URL 存 Token |

浏览他人或载入服务器字段不会覆盖自己的提交配置；显式为自己的请求选择审批人/Bug 后更新仓库默认值。
初次可从 .reviewboardrc / RBTools 配置读取 URL、tracking branch、审批人/组。
服务器仓库优先明确选择、配置中的 REPOSITORY，再匹配 Git remote。
服务器 URL、BASE、Diff mode 等低频内容在 Repository Settings 中。0.5 缓存的统一模式迁为 Final diff + HEAD；更早的显式模式选择保留，待确认写入日志不改动。

| VS Code 设置 | 默认 | 用途 |
| --- | --- | --- |
| rbtflow.rbtPath | rbt | 工作区机器的 executable，不接受 shell 参数 |
| rbtflow.serverUrl | 空 | 仓库没有缓存时的默认值，空使用 RBTools 配置 |
| rbtflow.commandTimeoutSeconds | 120 | 单条命令超时，5–1800 秒 |
| rbtflow.mode | minimal | 仓库默认插件模式，可在 Repository Settings 覆盖 |
| rbtflow.notifications.enabled | true | Full 模式的自动刷新和通知 |
| rbtflow.notifications.pollIntervalSeconds | 60 | 刷新间隔，30–3600 秒 |

兼容 rbt login 和已有证书配置，保留实际配置 URL 及代理前缀；Token 不进入 argv，日志脱敏。
每条 rbt 命令有私有临时配置，禁止自动发布/stamp/打开浏览器，退出删除。
.reviewboardrc 是可执行 Python，因此仅在受信任的文件系统工作区启用。

## 数据与写操作合同

本地提交范围仍是 merge-base(target, HEAD) → HEAD；显式 BASE 必须是祖先。
默认使用最终汇总 Diff + HEAD，不重写 Git 历史，保留侧分支和冲突解决；显式 History 及旧 History 单的更新要求连续线性、无空提交。已有 History 单保留原模式；绑定过 HEAD 的单不允许降级为普通 Squash。
工作区未提交内容排除；merge/rebase/cherry-pick 未结束时拒绝新预览。

ReviewPlan 固定 worktree/common-dir、SHA、Git/remote 指纹、工具和服务版本、repository ID、主 patch hash、旧单快照。
上传前重查，上传后回读字段、文件和主 patch；Git 状态事件只有检测到实际指纹变化才使计划失效。
原始 patch 使用冻结的预览字节或指定服务器版本，和文件快照一样由只读 FS 提供，不能编辑/覆盖。

RequestSession 负责服务器页面元数据和发布：核对作者、pending 状态、快照、最新差异 ID/hash、字段，
写前持久化 journal，写后回读；发布不要求本地分支仍处于上传时的位置。
新流程还根据 diff 绑定记录核对真实 HEAD、目标引用、仓库和文件集合；发布后的 Commit ID 同样验证。
绑定失败保留单号和检查点，可显式 Complete draft 完成同一 Diff，绝不自动重新 post。
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
bash dev.sh test          # 核心、缓存、通知并发/隔离、评论读取
bash dev.sh integration   # 真实提交、跨用户审阅、服务器草稿和发布恢复
bash dev.sh host-smoke    # 原生 VS Code 控件验收，自动准备所需本地数据
bash dev.sh package       # build/rbtflow-0.6.2.vsix
```

F5 选择 Run RBTFlow (local lab)；成品扩展标识为 ganjinbo.rbtflow，也可使用 Extensions: Install from VSIX。
发布者从旧测试包的 cossoledad 改为 ganjinbo，两者的扩展存储独立；发布步骤见 [Marketplace 发布](publishing.md)。
Node 22+ / Git / RBTools；本地站点 Python 3.12。新提交信息解析器使用 RBTools 7 的 API，兼容性实测为
RBTools 7.0 / Review Board 7.0.6；公司版本、SSO/代理/证书仍需试点。

| 入口 | 职责 |
| --- | --- |
| src/extension.ts | Git 发现、原生命令、LogOutputChannel、生命周期 |
| src/views/reviewSidebar.ts / nativeTree.ts | 原生视图协调、行项目/复选框、对比、浏览器归属 |
| src/views/inboxView.ts / discussionTree.ts | 收件箱/通知/已读装饰、延迟加载的评论树 |
| src/views/reviewController.ts | 每仓库动作、Submit→Review 交接、Git 默认信息、恢复 |
| src/views/nativeInputs.ts | 原生搜索多选框、短输入/多行编辑器支持 |
| src/views/changesTree.ts / src/domain/fileTree.ts | 目录树/列表，保留原文件索引和评论身份 |
| src/views/snapshots.ts / reviewComments.ts | 只读文档和原生行内评论 |
| src/application/repositoryStore.ts | 缓存、迁移和默认值 |
| src/application/reviewSession.ts / src/domain/submission.ts | 最终 diff/HEAD 绑定、上传校验、检查点与恢复 |
| src/application/requestSession.ts | 服务器页面编辑、发布、结构化拒绝和 journal 恢复 |
| src/application/reviewBrowser.ts / feedbackSession.ts | 远程版本、审阅写操作 |
| src/application/inboxSession.ts / discussionSession.ts | 待审 API、串行本地阅读记录、公开评论/回复读取 |
| src/domain/inbox.ts / discussion.ts | 内容指纹/阅读版本、评论身份/只读文档 |
| src/adapters / python/rbtflow_bridge.py | Git、进程、RBTools/认证及精确服务器操作 |

2026-11-16 在 Git 2.53.0 / Node 26.7.0 / TypeScript 7.0.2 / VS Code 1.136.1 上验证。
0.4.0 基线曾覆盖 16 项核心、6 组真实集成和 18 项 Extension Host 检查。0.5 的绑定基线见 final-diff.md；0.6 验证见 build/verification-v6.json。
Host 使用隔离 profile 和带真实嵌套/Unicode 文件的临时 worktree，覆盖原生多选框确认审批人后发布、
Git 默认信息、草稿交接、服务器说明连续保存、目录树/列表、readonly patch 原生打字/写入拒绝、
原生编辑器/复选框/评论、缓存恢复及另一作者的审阅发布；新增公开评论/四类回复只读阅读、
历史版本精确定位、静默同步、通知去重、更新重新未读、点击阅读和批量已读。

Host 默认下载 VS Code 1.136.1，VSCODE_EXECUTABLE_PATH 可指定已有 Electron；无 DISPLAY 尝试 xvfb-run，
缺失报告 BLOCKED。RBTFLOW_EXTENSION_PATH 支持对 VSIX 解包文件验收；RBTFLOW_CDP_PORT 为可选测试截图端口。
本机仅临时解包 Xvfb/依赖，复用 javavscode-terminal 的 Electron，没有改动该项目或安装系统包。

证据：build/test-v4-core.log、build/test-v4-integration.log（旧功能 5 组通过，新增用例首次认证夹具失败）、
build/test-v4-collaboration.log（修正本地测试账号夹具后专项复验）、build/test-v4-host.log、
build/host/latest.json、build/package-validation-v4.json。
实际窗口截图：build/host/reviewers.png、review.png、submit.png、comments.png、inbox.png。
成功测试清理自己的 worktree，失败保留诊断。本地站点保留运行，测试显示进程结束后关闭。

尚未实现回复写入、issue 生命周期操作、附件上传/图片预览、interdiff 对比、merge/land/push、未提交内容审核；
Windows/macOS、所有主题/快捷键、公司服务兼容和大仓库容量未完成验收。

## 当前补齐方向

从开发者/审阅者的具体工作闭环评估当前能力、剩余网页依赖及分批验收，见 [网页版替代范围与规划](web-parity.md)。
0.6 的本地验证证据与限制记录在 build/verification-v6.json；该文件不随 VSIX 分发。
