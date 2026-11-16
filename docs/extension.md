# RBTFlow 0.1.0 扩展

当前实现了“打开 Git 项目→分析固定范围→原生 diff→填写信息→保存/更新草稿→独立发布”。
运行时使用工作区机器已有的 Git/RBTools；无需额外常驻 RBTFlow 服务，也不需要 Docker。

## 功能与使用

活动栏 **RBTFlow / 审核项目** 枚举内置 Git 扩展发现的仓库，也检查各工作区目录的 Git 根。
多根工作区可选择仓库；活动文件所在仓库作为默认选择。每个 worktree 有独立审核会话。

审核界面包含：

- 当前仓库、服务器 URL、服务器 Git 仓库、目标主线、可选显式 BASE。
- 汇总 diff / 逐提交历史模式，当前分支、BASE/HEAD/目标主线的完整 SHA、merge 和脏工作区提示。
- 文件列表与 VS Code 原生 diff；新增/删除/rename 均使用固定提交内容，不读取工作区文件替代快照。
- 标题、修改说明、测试说明、审批人、审批组、bug 号、分支展示标签、更新说明。
- 人员/组搜索，草稿保存、按明确 ID 更新、发布、打开审核页和日志。
- 待确认写操作恢复；只查询核对，不自动重复创建审核单。

默认审核 merge-base(target, HEAD)→HEAD。高级 BASE 必须是 HEAD 祖先。
侧分支和 merge 的手工冲突解决保留在快照差异中，不使用 first-parent 拼补丁，也不执行 rebase/squash。
逐提交模式要求连续线性且无空提交；旧审核单必须保持创建时的模式。
工作区修改明确排除；正在 merge/rebase/cherry-pick 的仓库拒绝开始新审核计划。

修改审批信息时，插件将完整替换表单字段，包括清空说明、删除审批人/组和移除 bug 号。
这通过 Review Board 草稿 API 完成，避免原生 `rbt post` 的“追加 bug、忽略空值”行为。
`branch` 是展示字段，不是 Git 合入目标或 checkout 命令。

## 配置和认证

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `rbtflow.rbtPath` | `rbt` | 实际 RBTools executable 路径，不接受 shell 参数 |
| `rbtflow.serverUrl` | 空 | 新表单默认服务器；空则沿用 RBTools 配置 |
| `rbtflow.commandTimeoutSeconds` | 120 | 单次 RBTools 操作超时，可设 5–1800 秒 |

表单中的服务器地址优先；连接时保留实际配置 URL，不擅自切换到站点广告的 canonical URL，
避免代理路径和登录 cookie 失效。可以复用现有 `.reviewboardrc`、`rbt login` 和客户端证书配置。
图形化 token 设置使用 VS Code SecretStorage，账号密码不进入表单持久化。

每条命令使用私有临时 `.reviewboardrc`：禁止自动 publish、自动 stamp 和浏览器打开，
固定差异生成选项。token 不进入 argv；异常和日志会脱敏，临时配置在命令退出后删除。
临时文件位于扩展 `globalStorageUri/jobs`，目录 `0700`、文件 `0600`（Linux/WSL）。
工作区表单和待确认写操作保存在 VS Code workspaceState，按规范仓库路径区分；不写入源码。

`.reviewboardrc` 可执行 Python，因此未信任工作区中扩展不启用。虚拟工作区不支持。
已接受 RBTools 5+ 的版本入口，但本次兼容性验收仅覆盖 RBTools 7.0 / Review Board 7.0.6；
公司的版本、SSO、证书/代理仍需试点验证。

## 开发与安装

开发依赖 Node 22+、npm、Git；测试站点使用 Python 3.12，Git 核心测试使用 `python3` 生成隔离样例。
Node 依赖由 package-lock.json 固定，开发入口在 lockfile 变化时执行 npm ci。

```bash
bash dev.sh prepare       # 安装依赖并编译到 build/extension
bash dev.sh watch         # 持续编译
bash dev.sh test          # 核心测试
bash dev.sh integration   # 自动确保本地站点就绪，运行 TypeScript 真实集成测试
bash dev.sh host-smoke    # 真实 Extension Host、Webview、原生 diff、post/publish
bash dev.sh package       # 生成 build/rbtflow-0.1.0.vsix
```

在 VS Code 打开仓库根目录，F5 选择 **Run RBTFlow (local lab)**；任务自动 start 本地站点并编译，
Development Host 打开 `build/workspace`。该配置为当前 Linux/WSL 环境设置 rbt PATH；
实际部署按目标机器设置 `rbtflow.rbtPath`。本地服务账号见根 README。
也可以通过 **Extensions: Install from VSIX** 安装开发包。当前没有执行 Marketplace 发布。

Host 测试使用隔离的用户和扩展目录，不使用日常 VS Code 登录/profile。
默认下载 VS Code 1.136.1 到 `build/vscode-test`；`VSCODE_EXECUTABLE_PATH` 可指定已有的 Electron 可执行文件。
Linux 无 DISPLAY 时尝试 `xvfb-run`，缺失则明确报告 BLOCKED，不算测试通过。
`RBTFLOW_EXTENSION_PATH` 可指向已解包的 VSIX 内 `extension/` 目录，对安装包中的实际文件运行相同验收。

## 实现入口

| 文件 | 职责 |
| --- | --- |
| `src/extension.ts` | Git API、仓库发现、TreeView、命令、SecretStorage 和生命周期 |
| `src/domain/model.ts` | 固定范围、审核字段、服务器快照、收据和待确认记录 |
| `src/application/reviewSession.ts` | 预览、过期检查、post/publish、结果核对和恢复 |
| `src/adapters/git.ts` | DAG/merge-base、worktree 身份、refs、文件变化、blob 快照 |
| `src/adapters/process.ts` | 无 shell argv 调用，超时/取消、输出预算和进程组终止 |
| `src/adapters/rbtools.ts` | RBTools/API、认证配置、草稿同步、字段与主 patch 回读 |
| `src/views/reviewPanel.ts`、`media/review.*` | 审核表单与受约束的 host 消息协议 |
| `src/views/snapshots.ts` | 原生 diff 使用的只读快照文件系统 |
| `python/rbtflow_bridge.py` | 在 rbt 自己的 Python 环境执行的小型扩展命令 |

Python bridge 使用官方 `rbtools_commands` entry points 机制，经进程专属 PYTHONPATH 加载，
没有向全局环境安装包或猜测 rbt 的 Python 解释器。它只提供实际服务器 URL、草稿字段替换和
主 patch 哈希读取；图分析、状态机和界面仍由 TypeScript 负责。

## 提交合同与失败恢复

预览固定 HEAD/目标/BASE SHA、worktree/common-dir、远程引用和 Git 状态指纹、工具/服务器版本、
主 patch hash、服务器 repository ID 和旧审核单快照。字段变化不要求重新生成 patch；
仓库、范围、模式、审核单 ID 等变化使计划失效。

post 前检查 Git、登录用户、旧单状态和服务器快照，重新生成 diff 并核对 hash。
上传后明确同步所有表单字段，回读字段、文件集合和服务端主 patch；仅去除 `rbt diff`
控制台额外附加的末尾换行后比较哈希。保存成功不意味着已发布。

开始写操作前先持久化待确认记录；收到 ID 后立即记下。失败/取消不会自动重试。
新草稿携带一次性标记以辅助找到“服务端已完成但客户端丢失响应”的请求。
未注册的自定义字段只保存在草稿，发布时 Review Board 不会复制到公开审核单，因此发布恢复使用
已经记录的审核单 ID。仅完成部分写入或服务器又被编辑时，保留待确认状态供检查，不擅自覆盖。

客户端旧快照检查不是服务器原子 CAS；检查和写入之间仍有并发窗口。
主 patch 已回读核对，parent diff 的完整上传包冻结仍未实现；父 diff 在固定 SHA/远程引用下交由
RBTools 生成，集成测试另外验证了服务端实际重建。明确的成功返回和原始诊断都保留在日志中。

单次进程输出预算为 64 MiB，原生快照单文件上限 16 MiB，diff 还受服务器报告的大小限制。
触限会报错，不静默截断后继续提交。API 列表分页读取，上限 10,000 项时明确报错。

## 验证范围

本次运行了真实 VS Code 1.136.1 Extension Host，Webview 脚本在 CSP 下加载，确认实际渲染的文件数、
保存/发布按钮状态和原生 diff 文档内容，再经同一 host 消息处理入口保存并发布本地审核单。
这不是只用 vscode mock 的测试，也不等于完成手工视觉和键盘可用性验收。

2026-11-16 验证结果：7 项核心测试、3 组真实集成测试、8 项 Extension Host 检查通过。
Host 最后一轮使用 `build/vsix-check/extension`，来自生成的 VSIX 解包；额外检查运行文件与当前源码构建一致，
包中只有 19 个发行文件，不含测试、source map、缓存、Node 依赖目录或 SQLite 数据。
环境为 Git 2.53.0、Node 26.7.0、TypeScript 7.0.2、RBTools 7.0、Review Board 7.0.6。

本机缺少桌面 DISPLAY/Xvfb，验证时将 Xvfb 及依赖临时解包至 `build/host-tools`，
复用之前 Java 插件目录中的 VS Code Electron；没有安装系统包或修改该项目。
这些临时测试进程已停止，本地 Review Board 保留运行。成功的集成测试会清理自己注册的临时 worktree，
保留日志、patch 和报告；失败时保留工作树用于诊断。

证据文件：

- `build/test-core.log`：Git 图、worktree/rename/Unicode、字面 argv、取消/超时/输出限制、过期结果、凭据脱敏/清理。
- `build/test-integration.log`：五类历史、上传 patch 应用后的完整 Git tree、发布后更新、字段清空、Git/服务器变动拒绝、响应丢失恢复。
- `build/host/latest.json` 和 `build/test-host.log`：真实 Extension Host 与审核单链接。
- `build/rbtflow-0.1.0.vsix`：供安装验证的开发包。
- `build/package-validation.json`：发行文件数量与 VSIX 的 SHA-256。

错误恢复测试包含明确的故障注入：实际完成服务端保存后，主动丢弃客户端返回，再新建会话读取
持久化状态并核对服务器。它不能替代公司网络环境的所有故障测试。

尚未提供实际 merge/land/push、未提交内容审核、任意不连续 commits 组合、全量上传包冻结。
原生 Windows/macOS、公司环境、LFS/submodule/大仓库容量、手工视觉和所有快捷键流程尚未验收。
