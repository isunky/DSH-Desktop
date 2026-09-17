# DSH Launcher Client Layer

本目录保存独立客户端层：

- `tauri/`：Tauri 前端启动页，负责显示运行时和核心准备进度；
- `runtime/core-manager.mjs`：从官方 npm registry 解析、安装和缓存 DSH 核心；正式客户端首次启动时会优先复用满足要求的本机 Node.js 与全局官方 DSH，找不到时才进入客户端托管安装；
- `core-channel.json`：核心包名、registry、dist-tag 和更新策略；
- `client-info.json`：关于页和项目链接使用的客户端元数据；
- `patches/`：预留客户端层补丁，不直接改写 `upstream/`。

`src-tauri/` 是 Tauri 的 Rust 壳和本地运行时管理层，负责单实例、窗口、本机运行时发现、Node.js 下载/校验/解压、DSH 子进程生命周期和菜单。客户端安装包不内置 Node.js、DSH 核心、插件或核心依赖树；首次启动会检查本机兼容的 Node.js 以及全局官方 `@deepseek-ai/dsh`，验证通过后保存路径绑定并直接使用。若仅有 Node.js，客户端会用它把 DSH 核心安装到自己的用户数据目录；如果本机没有可用 Node.js，才从 `nodejs.org` 下载并校验 SHA-256。

核心更新不会修改客户端安装目录，也不会覆盖 `dsh-home/` 用户数据。绑定本机全局 DSH 时，用户确认后客户端会用原 Node.js/npm 更新原全局安装；客户端托管核心则继续在独立用户目录中更新。Node.js 与已安装核心会被缓存，后续启动不需要重复下载；首次安装或核心升级需要网络。

客户端更新在设置弹窗内独立完成：客户端从 `isunky/DSH-Desktop` 的 GitHub Release 查询版本，按当前平台下载对应安装器到用户数据目录的 `updates/`，显示实时进度，下载完成后由用户确认启动安装。GitHub 仓库链接保留用于查看发布来源和版本说明；客户端本身不会把下载动作交给浏览器。

默认的 `autoUpdate` 为 `false`：已有核心时启动直接使用本地缓存，只有用户在设置中确认“检查核心更新”后才会访问官方 registry 并升级。更新判断使用 SemVer，只有官方 `dist-tags.latest` 高于当前版本时才会更新，不会因为渠道回退而降级；候选版本还必须存在于 registry 的已发布版本清单且满足 `minimumCoreVersion`。

启动页会显示核心安装、本地服务启动和 Web UI 就绪阶段，并持续显示已用时。安装或启动卡住时，可点击“取消启动并退出”、按 `Esc` 或关闭窗口；主进程会终止安装进程树和 DSH 子进程。
