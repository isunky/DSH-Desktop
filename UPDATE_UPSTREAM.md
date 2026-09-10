# 更新上游与核心通道

本仓库有两条独立更新链：

1. `upstream/`：上游源码 submodule，供维护者检查源码、协议和版本兼容性；
2. `@deepseek-ai/dsh`：客户端运行时核心，按官方 npm registry 的 `distTag` 独立更新。

## 更新上游源码

1. 确认根仓库和 `upstream/` 都没有未提交修改。
2. 执行 `pnpm run client:update-upstream`。
3. 检查 submodule 的变更范围，并执行 `pnpm run client:check`。
4. 如客户端壳需要跟随协议变化，只修改 `client/`，不要直接编辑 `upstream/`。
5. 在 Windows 或 macOS 目标机运行开发启动与应用目录打包。
6. 确认 `upstream/` 工作树干净后，提交根仓库中的 gitlink。

## 更新 DSH 核心

开发机可执行：

```sh
pnpm run client:core:check
pnpm run client:core:install
```

已安装客户端通过菜单执行“检查 DSH 核心更新”。更新流程会：

- 查询 `client/core-channel.json` 指定的 HTTPS registry；
- 按 dist-tag 解析版本；打包客户端使用 Node.js 自带 npm 安装依赖，开发环境脚本可使用 pnpm；
- 安装到新的版本目录，成功后原子切换 `current.json`；
- 保留旧版本，失败时不影响当前核心和用户数据。

## 验证要求

- 客户端壳可以在没有已安装 DSH 核心时首次拉取并启动；
- 已缓存核心时断网可以启动；
- 核心升级后 DSH Web UI、profile、插件管理和本地数据仍可访问；
- 第二次启动只聚焦已有窗口，不重复启动核心进程；
- Windows x64 与 macOS x64/arm64 分别生成应用目录和安装包；
- `upstream/` 工作树无修改，客户端源码与上游源码保持分离。
