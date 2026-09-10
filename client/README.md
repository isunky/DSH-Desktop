# Client Layer

本目录保存独立客户端层：

- `tauri/`：Tauri 前端启动页，负责显示运行时和核心准备进度；
- `runtime/core-manager.mjs`：从官方 npm registry 解析、安装和缓存 DSH 核心；开发环境使用本机 Node.js，正式客户端使用首次启动时下载的 Node.js；
- `core-channel.json`：核心包名、registry、dist-tag 和更新策略；
- `client-info.json`：关于页和项目链接使用的客户端元数据；
- `patches/`：预留客户端层补丁，不直接改写 `upstream/`。

`src-tauri/` 是 Tauri 的 Rust 壳和本地运行时管理层，负责单实例、窗口、Node.js 下载/校验/解压、DSH 子进程生命周期和菜单。客户端安装包不内置 Node.js、DSH 核心、插件或核心依赖树；Node.js 在首次启动时从 `nodejs.org` 下载并校验 SHA-256，DSH 核心随后从配置的 npm registry 按版本安装到用户数据目录。

核心更新不会修改客户端安装目录，也不会覆盖 `dsh-home/` 用户数据。Node.js 与已安装核心会被缓存，后续启动不需要重复下载；首次安装或核心升级需要网络。

启动页会显示核心安装、本地服务启动和 Web UI 就绪阶段，并持续显示已用时。安装或启动卡住时，可点击“取消启动并退出”、按 `Esc` 或关闭窗口；主进程会终止安装进程树和 DSH 子进程。
