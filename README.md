# DeepSeek Harness 独立跨平台客户端

本仓库将桌面壳与 DSH 核心分离：`upstream/` 只保存上游源码的 Git submodule，`client/` 保存客户端启动页、核心通道配置和运行时管理脚本，`src-tauri/` 保存 Tauri/Rust 壳。客户端安装包不内置 Node.js 或完整 DSH 核心，首次启动按需下载并缓存。

上游源码：<https://github.com/deepseek-ai/deepseek-harness>

## 运行方式

Tauri 壳使用系统 WebView，启动时按以下顺序准备本地环境：

1. 从 `nodejs.org` 下载固定版本 Node.js `22.19.0`，用官方 `SHASUMS256.txt` 校验 SHA-256，并解压到用户数据目录；
2. 使用该 Node.js 运行 `client/runtime/core-manager.mjs`，从 npm registry 安装 `@deepseek-ai/dsh`；
3. 启动本地 DSH Web 服务，并在 Tauri 窗口中打开。

默认用户数据目录：

```text
Windows: %LOCALAPPDATA%/DeepSeek Harness/
macOS:   ~/Library/Application Support/DeepSeek Harness/
```

其中 Node.js 位于 `runtime/node/22.19.0/`，核心位于 `core/versions/<version>/`，DSH 用户数据位于 `dsh-home/`。已缓存 Node.js 和核心时可以断网启动；首次安装需要访问 Node.js 下载站点和配置的官方 registry。

## 开发启动

环境要求：

- Node.js `22.19+` 或 `24+`、Corepack/pnpm；
- Rust stable、Cargo，以及 Windows MSVC 工具链或 macOS Xcode Command Line Tools；
- Windows x64 或 macOS x64/arm64 构建机。

首次准备 Rust CLI：

```sh
cargo install tauri-cli --version 2.11.4 --locked
```

然后执行：

```sh
git submodule update --init --recursive
corepack enable
pnpm install
pnpm run client:check
pnpm run client:dev
```

首次启动会安装当前 `client/core-channel.json` 中的核心版本。也可以直接使用开发机 Node.js 预先检查或安装核心：

```sh
pnpm run client:core:check
pnpm run client:core:install
```

启动页会显示当前阶段、已用时和等待说明。首次安装或启动时间较长时，可以点击“取消启动并退出”，也可以按 `Esc` 或直接关闭窗口；客户端会同时终止核心安装和本地 DSH 服务。

## 本地打包

```powershell
pnpm run client:package:win
```

```sh
pnpm run client:package:mac:arm64
pnpm run client:package:mac:x64
```

只生成当前宿主机的 Tauri 应用目录：

```sh
pnpm run client:package:dir
```

产物位于 `artifacts/<target>/`。Windows 生成 NSIS 安装包，macOS 生成 DMG；安装包只包含 Tauri 壳、前端启动页和核心管理器，不包含 Node.js 或 DSH 核心。Windows 安装器在目标机缺少 WebView2 时会尝试联网下载引导程序；需要离线部署时应预先安装 WebView2 或调整 `src-tauri/tauri.conf.json`。正式发布仍需在对应平台配置签名、公证和更新服务。

## 核心更新策略

顶部使用 48px 自定义无边框工具栏：Logo、更多、最小化、最大化/还原和关闭；空白区域支持拖动和双击最大化。“更多”在工具栏内展开图标操作，支持键盘聚焦和提示。DSH 核心在独立 WebView 中完整加载，核心页面与样式不做修改。Windows 安装任务和 DSH 后台进程使用隐藏控制台模式，诊断输出由客户端接收。

“更多”内的“关于”显示客户端和核心版本；“检查核心更新”会查询 `client/core-channel.json` 配置的 npm registry，确认后下载新版本、保留旧版本并重启本地核心。核心安装采用版本目录和 `current.json`，不覆盖 `dsh-home/` 用户数据。

开发者信息与客户端发布渠道配置位于 `client/client-info.json`。发布客户端时，使用 `v主版本.次版本.修订号` 格式的正式 Release 标签并上传对应平台安装包；同步修改根目录 `package.json` 和 `src-tauri/tauri.conf.json` 的版本号。

`client/core-channel.json` 是客户端核心渠道的唯一配置点，默认使用：

```json
{
  "packageName": "@deepseek-ai/dsh",
  "registry": "https://registry.npmjs.org",
  "distTag": "latest",
  "autoUpdate": false
}
```

## 与上游同步

阅读 [UPDATE_UPSTREAM.md](UPDATE_UPSTREAM.md) 后执行：

```sh
pnpm run client:update-upstream
pnpm run client:check
```

客户端不直接修改 `upstream/`，也不把上游桌面端作为运行时依赖；上游 submodule 用于源码跟踪、版本对照和后续兼容性验证。
