# DeepSeek Harness 独立跨平台客户端

本仓库将客户端壳与 DSH 核心分离：`upstream/` 只保存上游源码的 Git submodule，`client/` 保存独立 Electron 壳和核心通道配置。客户端安装包不内置完整 DSH 核心；首次启动从官方 npm registry 获取 `@deepseek-ai/dsh`，之后核心版本可以独立更新，用户数据和客户端窗口不需要迁移。

上游源码：<https://github.com/deepseek-ai/deepseek-harness>

## 运行方式

客户端使用 Electron 打开本机 DSH Web UI，并把核心版本缓存到用户数据目录：

```text
Windows: %LOCALAPPDATA%/DeepSeek Harness/core/versions/<version>/
macOS:   ~/Library/Application Support/DeepSeek Harness/core/versions/<version>/
```

DSH 用户数据单独放在同一应用数据目录下的 `dsh-home/`。已缓存核心时可以断网启动；首次安装或核心升级需要访问配置的官方 registry。

## 开发启动

环境要求：Node.js `22.19+` 或 `24+`、Corepack，以及 Windows x64 或 macOS 构建机。

```sh
git submodule update --init --recursive
corepack enable
pnpm install
pnpm run client:check
pnpm run client:dev
```

首次启动会安装当前 `client/core-channel.json` 中的核心版本。也可以先检查或安装核心：

```sh
pnpm run client:core:check
pnpm run client:core:install
```

启动页会显示当前阶段、已用时和等待说明。首次安装或启动时间较长时，可以点击“取消启动并退出”，也可以按 `Esc` 或直接关闭窗口；客户端会同时终止核心安装和本地 DSH 服务，不会留下继续运行的后台任务。

## 本地打包

```powershell
pnpm run client:package:win
```

```sh
pnpm run client:package:mac:arm64
pnpm run client:package:mac:x64
```

只生成当前宿主机的应用目录：

```sh
pnpm run client:package:dir
```

产物位于 `artifacts/<target>/`。本地构建关闭签名、公证和自动更新托管；Windows 生成 NSIS 安装包，macOS 生成 DMG/ZIP。正式发布仍需在对应平台配置签名、公证和更新服务。

## 核心更新策略

主界面右上角控件默认收起，鼠标悬停、键盘聚焦或点击后展开；“关于与更新”提供独立的核心和客户端更新入口，并显示 Sunky 开发者信息。客户端检查 `isunky/DSH-Desktop` 的最新正式 GitHub Release，发现新版本后打开下载页面，由用户覆盖安装；未发布版本时会明确提示。此模式不静默下载或自动替换正在运行的程序。

开发者信息与客户端发布渠道配置位于 `client/electron/client-info.json`。发布客户端时，使用 `v主版本.次版本.修订号` 格式的正式 Release 标签并上传对应平台安装包；同步修改根目录 `package.json` 的版本号。

`client/core-channel.json` 是客户端核心渠道的唯一配置点，默认使用：

```json
{
  "packageName": "@deepseek-ai/dsh",
  "registry": "https://registry.npmjs.org",
  "distTag": "latest",
  "autoUpdate": false
}
```

客户端默认不静默替换核心；菜单中的“检查 DSH 核心更新”会查询官方 registry，确认后下载新版本、保留旧版本并重启本地核心。核心安装采用版本目录和 `current.json`，后续可扩展为回滚、灰度通道或企业私有 registry，而不改变客户端壳。

## 与上游同步

阅读 [UPDATE_UPSTREAM.md](UPDATE_UPSTREAM.md) 后执行：

```sh
pnpm run client:update-upstream
pnpm run client:check
```

客户端不直接修改 `upstream/`，也不把上游桌面端作为运行时依赖；上游 submodule 用于源码跟踪、版本对照和后续兼容性验证。
