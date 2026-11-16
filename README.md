# RBTFlow

VS Code 的 Review Board 审核扩展：在侧边栏提交、查看和审阅代码，使用原生更改列表、diff 和行内评论。
审批人、bug 号、分支和工具等默认配置按仓库保存。

**0.2.0 支持本地预览、自己的已提交审核和按 ID 审阅他人的代码，包含审阅意见和 Ship It。**
包含 merge 的分支默认使用汇总 diff，保留 Git 历史。
实际执行 merge/land/push 尚未实现。RBTools 是 `rbt` 客户端，Review Board 是服务端；
扩展可连接现有服务，下面的本地站点仅用于开发，不是插件用户必须部署的后端。

## 运行扩展

在本项目根目录运行（开发构建需要 Node 22+、npm；Git 测试还使用 Python 3）：

```bash
bash dev.sh prepare   # 安装 lockfile 中的 Node 依赖并编译
bash dev.sh package   # 生成 build/rbtflow-0.2.0.vsix
```

VS Code 使用“Extensions: Install from VSIX”安装该文件，或在本仓库按 F5，选择
`Run RBTFlow (local lab)`。F5 会准备本地服务并在示例项目中运行扩展。

点击活动栏的 RBTFlow 图标，或执行 **RBTFlow: 打开审核侧边栏**。
“审核”和“更改”使用 VS Code 的视图容器，可通过视图标题的原生菜单/拖放移至下方 Panel。

1. **提交**：选择目标主线，填写标题、说明、审批人和 bug 号；“更多信息”中配置组、测试和已有审核单 ID。
2. 点击“预览更改”，从原生“更改”列表打开 diff，然后保存草稿，确认后单独发布。
3. **审阅**：输入自己的或他人的审核单 ID，也可从“我的…”选择；切换已发布版本或自己的差异草稿。
4. 在原生 diff 的行号处添加评论，填写总体意见，按需勾选 Ship It；先保存审阅草稿，再发布审阅。

服务器地址从现有 RBTools 配置读取；目标主线、服务器仓库、BASE、审核模式、工具路径和超时均在齿轮“仓库设置”中。
普通配置和草稿保存在扩展存储，重开同一仓库自动沿用；新建审核保留审批人等默认值，清空单号、标题和说明。
浏览他人的审核不会改动自己的提交表单。各 worktree 分别保存；API Token 使用 SecretStorage，按服务器区分。

通过 `rbtflow.rbtPath` 指定工作区所在机器的 RBTools 可执行文件，默认 `rbt`。
可复用 `rbt login`，也可通过 **RBTFlow: 设置服务器 API Token** 存入 SecretStorage。
本地示例的 rbt 路径为 `<项目>/build/venv/bin/rbt`，F5 已自动加入 PATH。
扩展需受信任的文件系统工作区；WSL/SSH 中应安装在对应的远程扩展宿主。

扩展会在上传后核对主 patch、字段和文件集合；Git/审核单变化会阻止旧计划提交。
取消或错误后结果不明时，先“检查服务器状态”，不会自动重复 post。

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
