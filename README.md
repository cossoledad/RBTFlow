# RBTFlow

VS Code 的 Review Board 审核扩展：原生 **Submit / Review / Changes** 三个折叠视图，
使用原生 Quick Pick、Input Box、编辑器、复选框、diff 和行内评论，没有自绘表单。
审批人、bug 号、分支和工具等默认配置按仓库保存。

**0.3.0 按“预览和生成草稿 → 管理服务器审阅 → 查看更改”分工，界面采用简短英文。**
包含 merge 的分支默认使用汇总 diff，保留 Git 历史。
实际执行 merge/land/push 尚未实现。RBTools 是 `rbt` 客户端，Review Board 是服务端；
扩展可连接现有服务，下面的本地站点仅用于开发，不是插件用户必须部署的后端。

## 运行扩展

在本项目根目录运行（开发构建需要 Node 22+、npm；Git 测试还使用 Python 3）：

```bash
bash dev.sh prepare   # 安装 lockfile 中的 Node 依赖并编译
bash dev.sh package   # 生成 build/rbtflow-0.3.0.vsix
```

VS Code 使用“Extensions: Install from VSIX”安装该文件，或在本仓库按 F5，选择
`Run RBTFlow (local lab)`。F5 会准备本地服务并在示例项目中运行扩展。

点击活动栏的 RBTFlow 图标，或执行 **RBTFlow: Open RBTFlow**。
三个视图均可通过 VS Code 原生菜单/拖放移至下方 Panel。

1. **Submit**：选择 Target、Reviewers 和 Bugs；标题/说明默认按 RBTools 的 Git 提交解析器生成，点 Message 可调整。
2. 视图工具栏 **Preview Changes** 生成固定预览，**Create Draft** 上传；创建后自动交给 Review，Submit 准备下一次提交。
3. **Review**：管理服务器页面。发布自己的草稿，或按 ID / My Requests 打开自己及他人的审核；Version 用原生 Quick Pick 切换。
4. 发布前若缺少审批人，会先打开原生多选框；确定的校验失败不会被误标为“结果未知”。旧的待确认发布会回读并恢复草稿状态。
5. 在原生 diff 添加评论；Comment 使用原生编辑器，Ctrl+S 保存本地意见，勾选 Ship It，然后 Save Review / Publish Review。
6. **Changes**：显示当前预览或选中审阅的文件，可切换 Tree / List；View Raw Diff 始终只读。

服务器地址从现有 RBTools 配置读取；服务器仓库、BASE、审核模式、工具路径和超时均在齿轮 Repository Settings 中。
普通配置和草稿保存在扩展存储，重开同一仓库自动沿用；新建审核保留审批人等默认值，清空单号、标题和说明。
浏览他人的审核不会改动自己的提交配置。各 worktree 分别保存；API Token 使用 SecretStorage，按服务器区分。
浏览器入口仅位于 Review；详细诊断统一在 **Output → RBTFlow**，侧边栏不显示错误堆栈和日志面板。

通过 `rbtflow.rbtPath` 指定工作区所在机器的 RBTools 可执行文件，默认 `rbt`。
可复用 `rbt login`，也可通过 **RBTFlow: Set API Token** 存入 SecretStorage。
本地示例的 rbt 路径为 `<项目>/build/venv/bin/rbt`，F5 已自动加入 PATH。
扩展需受信任的文件系统工作区；WSL/SSH 中应安装在对应的远程扩展宿主。

扩展会在上传后核对主 patch、字段和文件集合；Git/审核单变化会阻止旧计划提交。
取消或网络错误后结果不明时，在 Review 中使用 **Check Server**，不会自动重复 post。

详见 [扩展开发、配置和验证](docs/extension.md)。

## 本地启动

在 Linux/WSL 运行，已有 Git 和 Python 3。服务使用独立 Python 3.12 虚拟环境、SQLite、
文件缓存和开发服务器，不使用 Docker，不需要数据库或缓存服务。

```bash
bash dev.sh start
```

首次自动创建 `build/venv`、安装固定依赖、初始化站点和示例 Git 仓库。
有 `python3.12` 时直接使用；否则通过已安装的 mise 获取 Python 3.12.16。
也可用 `RBTFLOW_PYTHON=/path/to/python3.12 bash dev.sh start` 指定解释器。
首次下载需要网络。不会变更全局 Python 包或 mise 的全局版本设置。

- 访问：<http://127.0.0.1:8080/>
- 管理员：`admin` / `rbtflow-local`
- 示例审批人：`reviewer` / `rbtflow-local`；审批组：`reviewers`
- 示例项目：`build/workspace`，默认分支 `feature/merged`，含真实 merge commit。
- 本地测试站点的数据、凭据、虚拟环境和日志均在 Git 忽略的 `build/`。

这些固定账号仅供本机演示，服务只监听 `127.0.0.1:8080`。

## 验证与管理

```bash
bash dev.sh smoke   # 真实 diff/post/发布/更新验证，会创建本地示例审核单
bash dev.sh test    # Git/进程/仓库缓存/评论行映射测试
bash dev.sh integration  # 真实服务：提交、跨用户对比、行内评论、审阅发布和恢复
bash dev.sh host-smoke   # 真实 VS Code Extension Host，需要桌面 DISPLAY 或 xvfb-run
bash dev.sh status
bash dev.sh logs
bash dev.sh stop    # 保留数据；再次 start 继续使用
```

本地环境验证报告为 `build/smoke/latest.json`，扩展宿主验收为 `build/host/latest.json`；
测试日志和 patch 均保存在 `build/`，具体证据见扩展文档。

也可手动验证示例仓库。`rbt` 动作保留调用者的工作目录：

```bash
cd build/workspace
bash ../../dev.sh rbt diff origin/main HEAD
bash ../../dev.sh rbt post --json --squash-history \
  --summary="本地 merge 分支审核" --target-people=reviewer \
  --target-groups=reviewers --bugs-closed=1234 --branch=main origin/main HEAD
```

`post` 默认保存草稿；上例不修改 Git 历史、不 push、不合并分支。
`.reviewboardrc` 仅生成在示例仓库中，不要在 RBTFlow 根仓库执行示例提交。

## 阅读入口

- [本地环境与诊断](docs/local-lab.md)：启动方式、目录、依赖和限制。
- [扩展开发与验收](docs/extension.md)：当前实现、F5、VSIX、代码入口、测试证据。
- [实现思路与分阶段方向](docs/design.md)：Git 范围语义、merge 处理、扩展架构与交互。
- [首阶段验证记录](docs/verification.md)：本地站点搭建阶段的历史验证记录。
