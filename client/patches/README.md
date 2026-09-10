# Client Patches

客户端当前不需要修改上游业务源代码。

如果未来必须修改上游文件，应把最小化的 `git diff` 放在此目录，并在更新上游后通过 `git apply --check` 验证。Tauri 壳和运行时管理代码位于 `src-tauri/`，不改写 `upstream/`。
