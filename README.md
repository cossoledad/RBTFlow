# RBTFlow

计划中的 VS Code 扩展：识别工作区的 Git 仓库，以图形界面选择审核范围、预览差异、
提交/更新 Review Board 审核、指定审批人和 bug 号，并逐步支持审核后的分支合入。

**当前阶段已实现本地验证环境和集成验证脚本；VS Code 扩展尚未实现。**
RBTools 是 `rbt` 客户端，Review Board 才是审核服务端。这里启动真实 Review Board，
插件将来连接公司的现有审核服务，不需要为每位插件用户部署此测试服务。

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
- 所有运行数据、凭据、虚拟环境和日志均在 Git 忽略的 `build/`。

这些固定账号仅供本机演示，服务只监听 `127.0.0.1:8080`。

## 验证与管理

```bash
bash dev.sh smoke   # 真实 diff/post/发布/更新验证，会创建本地示例审核单
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
- [实现思路与分阶段方向](docs/design.md)：Git 范围语义、merge 处理、扩展架构与交互。
- [首阶段验证记录](docs/verification.md)：实际证据与尚未验证的边界。
