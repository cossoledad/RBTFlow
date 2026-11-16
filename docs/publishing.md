# Marketplace 发布

发布者为 `ganjinbo`，扩展标识为 `ganjinbo.rbtflow`，版本由 package.json 决定。
管理入口：<https://marketplace.visualstudio.com/manage/publishers/ganjinbo>。
仓库目前保留原有 `UNLICENSED` 和 npm `private: true` 设置，不因上架自行变更授权协议。

## 发布指定安装包

```bash
bash dev.sh package
```

核对 VSIX 中 publisher/name/version、发行文件白名单和运行验证。
包不包含源码测试、Node 开发依赖、source map、站点数据库、.reviewboardrc 或认证凭据。
以本地 0.4.0 包为例：

```bash
VSCE_STORE=file npx --no-install vsce verify-pat ganjinbo
VSCE_STORE=file npx --no-install vsce publish --packagePath build/rbtflow-0.4.0.vsix
```

命令复用本机已有的 vsce 文件凭据库，不在命令行、仓库、日志或 VSIX 中传入 Token。
发布前应确认有对应发布者的发布权限；没有本地凭据时可用 `vsce login ganjinbo` 的隐藏输入登录。
不要在聊天或源码中粘贴 Token。

使用 packagePath 发布已验证包，避免重建时内容变化、自动升版或创建 Git tag。
同一版本不可重复上传；先查询 Marketplace 状态，再决定是否需要更新版本。
本次发布按用户要求在上传成功后结束，不轮询等待微软验证。
记录上传结果，区分已上传与已公开可安装；发布命令退出码不代表已经通过平台验证。

旧的 `cossoledad.rbtflow` 测试 VSIX 是另一扩展身份，安装新扩展前先卸载旧扩展，避免重复注册视图/命令。
普通缓存和 SecretStorage 按扩展身份隔离，不自动复制；RBTools 既有配置/登录可以继续使用。

后续自动发布可按 [VS Code 官方发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
配置 Trusted Publishing / OIDC；当前流程不修改 GitHub 工作流、仓库可见性或发布者成员权限。
