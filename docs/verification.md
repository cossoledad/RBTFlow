# 首阶段验证记录

验证日期：2026-11-16。所有审核对象均为本项目生成的本地样例，未连接公司审核服务，
未对 RBTFlow 源码仓库执行提交、合并或 push。VS Code 扩展尚未实现。

## 环境事实

| 项目 | 实测 |
| --- | --- |
| 系统 | Ubuntu 26.04.1 LTS，Linux 环境 |
| Git | 2.53.0 |
| 默认 Python | 3.14.7；全局已有 Review Board 7.0.6，但没有 RBTools |
| 本项目 Python | 独立 3.12.16 虚拟环境 |
| 审核服务 / 客户端 | Review Board 7.0.6 / RBTools 7.0 |
| Django | 4.2.30 |
| Node / npm | 26.7.0 / 11.19.0；尚未用于构建 RBTFlow 扩展 |
| VS Code CLI | 当前 PATH 无 `code`，未进行 F5 验收 |
| Docker | 未使用；服务不依赖 Docker |

检查了 `/home/ganjb/project/javavscode-terminal/vscode` 的入口、开发脚本、开发文档、
TypeScript 配置和 F5 配置。它可作为开发方式参考，未修改该仓库，也没有以其已有测试结果
代替 RBTFlow 的扩展验收。

## 一键启动与进程管理

移走本轮创建的虚拟环境、站点、缓存和示例仓库后，实际执行单条 `bash dev.sh start`：
自动安装固定依赖、创建 SQLite 站点、创建示例 Git 图、注册用户/仓库，API 就绪后成功返回。
最终站点没有依赖手工改库或全局 Python 包修改。

额外进行了 8 项真实进程检查，报告位于 `build/launcher-validation.json`：

- 重复 start 保留同一个服务 PID。
- stop 后 API 确实无法连接。
- PID 创建时间已变化时，不停止该 PID 对应的进程。
- PID 和创建时间相同但命令属于其他进程时，也不停止它。
- 8080 被独立测试 HTTP 服务占用时，start 返回错误。
- 随后的 stop 不停止那个独立测试服务。
- 正常 restart 创建新的受管进程。
- restart 前后审核单数量一致，数据保留。

测试创建的独立进程已结束，Review Board 留在运行状态。

## 真实审核链路

运行 `bash dev.sh smoke`，11 项检查通过。可重复执行；每轮会新建 5 个本地样例审核单。
最新结果与本次实际审核链接见 `build/smoke/latest.json`，历史报告和每条命令输出按时间保留。

| 检查 | 核对内容 |
| --- | --- |
| 服务与静态资源 | `/api/` 能力、`/api/info/` 版本、页面引用的一份 CSS 和一份 JS 可获取 |
| 非线性历史的拒绝 | `--with-history` 上传 merge 范围出现预期 linear 错误，不创建审核单 |
| 两个线性提交 | 成功创建 history 审核单，服务端 commit_count 为 2 |
| merge 主线 | 汇总上传成功；文件集只含功能修改，不含已同步的 upstream.txt |
| merge 侧分支 | side.txt 被保留，未被 first-parent 过滤掉 |
| merge 冲突解决 | 手工解决后的 greeting.txt 内容与目标提交一致 |
| 未推送父分支 | 子分支修改父分支新增的 parent.txt，服务端通过 parent diff 重建原文件和结果 |
| 旧 history 单不能降级 | 给旧单追加 `--squash-history` 仍出现预期 linear 错误，不另建审核单 |
| 草稿发布 | 最初草稿对 reviewer 不可见；发布后 reviewer 可读 |
| 同一审核单更新 | 已发布单上传新内容，ID 不变，生成 diff revision 2 并发布 |
| Git 状态不变 | 审核操作前后全部 refs、当前分支和 worktree 状态一致 |

每个正向审核范围都会：

1. 调用真正的 `rbt diff`，把输出 patch 应用到独立 Git index；验证生成的完整 tree SHA 等于
   所选 HEAD 的 tree SHA。
2. 调用真正的 `rbt post`，通过 HTTP 读取草稿/审核单，核对审批人、组、bug 号、branch 和模式。
3. 下载服务端保存的原始 patch，再验证完整 tree SHA，并检查服务端文件集合。
4. 从 Review Board 下载 reconstructed original/patched file，分别与 BASE/HEAD 中的文件字节比较。

因此证据涵盖 Git、RBTools、HTTP、服务端保存和文件重建，不只是客户端退出码。
独立 index 不改动用户工作区；服务端基础仓库只包含 main，功能分支未推送。

## 源码与专项观察

- 当前 `GitClient.get_commit_history()` 明确检查 parent 数量，merge 会触发 linear 错误。
  对新单与旧 history 单分别用真实命令复现了这一点。
- 当前 `post.py` 更新时沿用旧单 `created_with_history`；不能假定所有错误都能通过追加 `-S` 修复。
- 专项执行 `rbt diff --json` 只取得 `{ "status": "success" }`，没有 patch；普通 diff 则返回原始
  patch。集成脚本据此分别解析 diff 与 post 的输出。
- 初次仅运行标准 runserver 时，页面引用的 CSS 返回 404；站点增加对安装包预编译静态文件的
  FileSystemFinder 后通过 HTTP 静态资源检查，未修改 Review Board/Django 安装包源码。
- 首次草稿尚未发布时，重新 post 会替换草稿 diff；不能据此要求 revision 递增。当前验证流程
  先发布基线，再检查后续第 2 版，这与产品应显示的审核状态相对应。

## 其他检查与边界

`bash -n dev.sh`、Python 脚本编译检查、`pip check` 和变更空白检查通过。
没有进行浏览器视觉/交互测试；HTTP 获取 CSS/JS 不代表浏览器完成渲染或全部前端交互验收。

尚未验证：公司的真实 merge 问题、旧服务器/客户端版本、SSO、公司证书和代理、私有远端仓库、
原生 Windows/macOS、扩展 F5/VSIX、多根工作区与 worktree 实际界面、取消/部分失败恢复，
以及大型仓库、二进制文件、LFS、submodule 和不同文件名编码。
这些是后续兼容性和产品验收范围，不应从本次小型样例推断为已经支持。

`rbt land`、真实分支合入、push 和关闭审核单也未验证，本阶段不提供这些写操作。
