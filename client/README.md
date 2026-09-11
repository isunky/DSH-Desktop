# Client Layer

本目录保存独立客户端层：

- `tauri/`：Tauri 前端启动页，负责显示运行时和核心准备进度；
- `runtime/core-manager.mjs`：从官方 npm registry 解析、安装和缓存 DSH 核心；正式客户端首次启动时会优先复用满足要求的本机 Node.js 与全局官方 DSH，找不到时才进入客户端托管安装；
- `core-channel.json`：核心包名、registry、dist-tag 和更新策略；
- `client-info.json`：关于页和项目链接使用的客户端元数据；
- `patches/`：预留客户端层补丁，不直接改写 `upstream/`。

`src-tauri/` 是 Tauri 的 Rust 壳和本地运行时管理层，负责单实例、窗口、本机运行时发现、Node.js 下载/校验/解压、DSH 子进程生命周期和菜单。客户端安装包不内置 Node.js、DSH 核心、插件或核心依赖树；首次启动会检查本机兼容的 Node.js 以及全局官方 `@deepseek-ai/dsh`，验证通过后保存路径绑定并直接使用。若仅有 Node.js，客户端会用它把 DSH 核心安装到自己的用户数据目录；如果本机没有可用 Node.js，才从 `nodejs.org` 下载并校验 SHA-256。

核心更新不会修改客户端安装目录，也不会覆盖 `dsh-home/` 用户数据。绑定本机全局 DSH 时，用户确认后客户端会用原 Node.js/npm 更新原全局安装；客户端托管核心则继续在独立用户目录中更新。Node.js 与已安装核心会被缓存，后续启动不需要重复下载；首次安装或核心升级需要网络。

启动页会显示核心安装、本地服务启动和 Web UI 就绪阶段，并持续显示已用时。安装或启动卡住时，可点击“取消启动并退出”、按 `Esc` 或关闭窗口；主进程会终止安装进程树和 DSH 子进程。
