# Client Layer

本目录保存独立客户端层：

- `electron/`：轻量 Electron 壳，负责单实例、窗口、核心进程生命周期和更新菜单；
- `runtime/core-manager.mjs`：从官方 npm registry 解析、安装和缓存 DSH 核心；打包客户端使用内置 Node 的 npm，开发环境仍可使用 pnpm；
- `core-channel.json`：核心包名、registry、dist-tag 和更新策略；
- `electron-builder.config.mjs`：Windows/macOS 本地打包配置；
- `patches/`：预留客户端层补丁，不直接改写 `upstream/`。

客户端不内置 DSH 核心、插件或核心依赖树，只携带 Electron 壳和用于首次安装核心的 Node.js 运行时。核心按版本安装到用户数据目录，核心更新不会修改客户端安装目录，也不会覆盖 `dsh-home/` 用户数据。

启动页会显示核心安装、本地服务启动和 Web UI 就绪阶段，并持续显示已用时。安装或启动卡住时，可点击“取消启动并退出”、按 `Esc` 或关闭窗口；主进程会终止安装进程树和 DSH 子进程。
