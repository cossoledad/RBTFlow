# 本地验证环境

这是开发 RBTFlow 的真实审核服务和样例环境，范围为单机验证。
不提供生产部署方案，也没有实现 RBTFlow 插件。

## 依赖与入口

当前验证版本：Python 3.12.16、Review Board 7.0.6、RBTools 7.0、Django 4.2.30。
[requirements.txt](../requirements.txt) 固定了本次环境的完整 Python 依赖版本。
已有全局 Review Board 使用 Python 3.14；本项目使用独立 3.12 环境验证，未修改该全局安装。

```bash
bash dev.sh start   # 缺少环境时先 setup，然后后台启动；等待 /api/ 就绪
bash dev.sh setup   # 只准备环境、站点、示例仓库和用户，不启动
bash dev.sh smoke   # 确保已启动，然后运行真实集成验证
bash dev.sh status  # 同时检查受管进程和 API；异常返回非零
bash dev.sh logs    # 最近 60 行服务器日志
bash dev.sh stop    # 只停止本项目记录且身份匹配的进程，保留所有数据
```

`bash dev.sh` 默认等同于 `start`。命令可从其他目录调用，服务路径按脚本定位。
`rbt` 动作例外：它有意保留当前目录，便于在选定的 Git 仓库运行客户端。

首次创建虚拟环境时，`RBTFLOW_PYTHON` 优先，其次 `python3.12`，否则使用 mise 安装的
`python@3.12.16`。没有 Python 3.12 和 mise 时，会说明缺失项并退出。
`start/stop/status` 的进程身份检查使用 Linux `/proc`，当前启动脚本面向 Linux/WSL。
原生 Windows/macOS 尚未验收。

## 最小服务

调用 `rb-site install --noinput`，显式指定 SQLite 文件的绝对路径，避免非交互安装
将数据库生成在当前目录。缓存使用 Django 文件缓存，不依赖机器上的 PostgreSQL/memcached。
站点仅由官方 `rb-site manage ... runserver` 提供，使用 `--noreload` 禁止重复子进程。

安装包中的预编译静态文件位于站点 `htdocs/static`。本地配置为 Django 增加
`FileSystemFinder` 以提供这些文件；只启动 API 而遗漏 CSS/JS 不能算启动完成。
`DEBUG=True`，邮件使用 console backend，演示邮件写入日志，不向示例邮箱发送邮件。
生成配置中的 `RBTFlow local development settings` 段由脚本维护。

重复 `start` 复用身份匹配且 API 健康的进程；启动、停止和准备环境使用文件锁串行执行。
记录 PID 和进程创建时间，停止前也检查命令所属站点；不会仅凭一个过期 PID 杀进程。
8080 被其他服务占用时退出，不接管该服务。当前端口固定为 8080。

## 数据与诊断

| 路径 | 用途 |
| --- | --- |
| `build/venv/` | 本项目 Python 运行环境；无需手动 activate |
| `build/site/data/reviewboard.db` | SQLite 数据库，包含用户和审核单 |
| `build/site/conf/settings_local.py` | 生成的站点设置与随机站点密钥 |
| `build/cache/` | 文件缓存 |
| `build/repos/demo.git/` | Review Board 可读的 bare Git 仓库，只推送了示例 main |
| `build/workspace/` | 本地开发仓库；功能分支未推送，含本地 `.reviewboardrc` |
| `build/fixtures.json` | 示例审核范围的固定 base/head SHA |
| `build/server.json` | 受管进程身份 |
| `build/server.log` | 启动、HTTP 请求、console 邮件和错误日志 |
| `build/site/logs/reviewboard.log` | Review Board 应用日志 |
| `build/install.log` | 依赖安装和 `pip check` |
| `build/site-install.log`、`build/seed.log` | 站点初始化、用户/仓库注册日志 |
| `build/smoke/latest.json` | 最近一次验证的 PASS/FAIL 和审核单链接 |
| `build/smoke/<时间>/` | 每条命令、stdout/stderr、上传的 patch、验证报告 |

`setup` 不删除数据库，不重复创建现有示例用户，不覆盖已有示例 Git 历史。
检测到不完整的示例仓库会停止并提示检查，不自动 reset 或删除数据。
修改服务配置后使用 `stop`、`start` 加载新配置。

示例 `.reviewboardrc` 包含固定本地测试账号，权限为 `0600`，并由示例 Git 忽略。
它不是公司项目的配置模板。真实服务器认证、SSO 和插件 SecretStorage 尚未接入。

## 示例历史

| 分支 | 用途 |
| --- | --- |
| `main` / `origin/main` | 服务端可访问的主线 |
| `feature/linear` | 两个线性功能提交，主线后来另有进展 |
| `feature/merged` | 功能分支合并主线，保留 merge commit |
| `feature/merged-side` | 再合并另一个功能分支，审核应包含 side.txt |
| `feature/conflict-resolved` | 真实冲突后手工解决，结果只存在于 merge commit |
| `feature/stacked-parent`、`feature/stacked-child` | 父分支未推送；子分支修改父分支新增文件 |

最后一项需要 RBTools 的 parent diff：服务端从已知 main 重建父基线，再展示子分支差异。
这能验证“本地命令生成了 patch”之外的服务端文件重建链路。
