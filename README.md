# RBTFlow

VS Code 的 Review Board 审核扩展：识别 Git 项目，选择审核范围，以原生 diff 预览固定提交，
通过表单指定审批人、审批组和 bug 号，保存/更新草稿并独立发布。

**0.1.0 已实现审核闭环，包含 merge 的分支默认使用汇总 diff，不改写 Git 历史。**
实际执行 merge/land/push 尚未实现。RBTools 是 `rbt` 客户端，Review Board 是服务端；
扩展可连接现有服务，下面的本地站点仅用于开发，不是插件用户必须部署的后端。

## 运行扩展

在本项目根目录运行（开发构建需要 Node 22+、npm；Git 测试还使用 Python 3）：

```bash
bash dev.sh prepare   # 安装 lockfile 中的 Node 依赖并编译
bash dev.sh package   # 生成 build/rbtflow-0.1.0.vsix，不发布到 Marketplace
```

VS Code 使用“Extensions: Install from VSIX”安装该文件，或在本仓库按 F5，选择
`Run RBTFlow (local lab)`。F5 会准备本地服务并在示例项目中运行扩展。

点击活动栏的 RBTFlow 图标，选择仓库，或执行 **RBTFlow: 打开提交审核**：

1. 填写服务器（留空沿用 `.reviewboardrc`），选择目标主线；需要时连接并选择服务器仓库。
2. 点击“分析并预览”，检查基线、HEAD、merge 提示和变更文件；点击文件打开原生 diff。
3. 填写审核信息，点击“保存草稿”。更新已有单时先输入 ID 并“载入”，再预览。
4. 确认后单独“发布当前草稿”，可打开审核网页。

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
bash dev.sh test    # Git/进程/状态等核心测试
bash dev.sh integration  # TypeScript 审核工作流对接真实本地服务
bash dev.sh host-smoke   # 真实 VS Code Extension Host，需要桌面 DISPLAY 或 xvfb-run
bash dev.sh status
bash dev.sh logs
bash dev.sh stop    # 保留数据；再次 start 继续使用
```

最新验证报告：`build/smoke/latest.json`，每轮详细命令、stdout/stderr 和 patch 保存在对应时间目录。

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
