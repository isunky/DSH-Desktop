# Client Patches

客户端当前不需要修改上游业务源代码。

本地构建所需的未签名模式由 `scripts/client.mjs` 在临时构建工作树中对上游 Electron 打包配置做受控调整；这些调整不会写回 `upstream/`。如果未来必须修改上游文件，应把最小化的 `git diff` 放在此目录，并在更新上游后通过 `git apply --check` 验证。
