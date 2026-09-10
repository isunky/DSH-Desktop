#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use flate2::read::GzDecoder;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri::{LogicalPosition, LogicalSize, WebviewUrl};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use url::Url;

const NODE_VERSION: &str = "22.19.0";
const CLIENT_INFO_JSON: &str = include_str!("../../client/client-info.json");

#[derive(Clone)]
struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    cancelled: AtomicBool,
    startup_started: AtomicBool,
    update_in_progress: AtomicBool,
    processes: Mutex<ProcessTable>,
}

struct ProcessTable {
    manager: Option<Child>,
    core: Option<Child>,
}

#[derive(Clone, Copy)]
enum ProcessKind {
    Manager,
    Core,
}

#[derive(Serialize, Clone)]
struct StartupState {
    stage: String,
    detail: String,
    progress: Option<u8>,
}

#[derive(Deserialize)]
struct CurrentCore {
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CoreChannel {
    package_name: String,
    registry: String,
    dist_tag: String,
}

struct NodeTarget {
    archive_name: String,
    archive_root: String,
    archive_extension: &'static str,
    node_relative: PathBuf,
    npm_relative: PathBuf,
}

#[derive(Clone)]
struct NodeRuntime {
    executable: PathBuf,
    npm_cli: PathBuf,
}

impl AppState {
    fn new() -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                cancelled: AtomicBool::new(false),
                startup_started: AtomicBool::new(false),
                update_in_progress: AtomicBool::new(false),
                processes: Mutex::new(ProcessTable {
                    manager: None,
                    core: None,
                }),
            }),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    fn cancel_and_kill(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        kill_process(self, ProcessKind::Manager);
        kill_process(self, ProcessKind::Core);
    }
}

impl ProcessTable {
    fn slot(&mut self, kind: ProcessKind) -> &mut Option<Child> {
        match kind {
            ProcessKind::Manager => &mut self.manager,
            ProcessKind::Core => &mut self.core,
        }
    }
}

fn emit_state(app: &AppHandle, stage: &str, detail: &str, progress: Option<u8>) {
    let _ = app.emit(
        "startup-state",
        StartupState {
            stage: stage.to_owned(),
            detail: detail.to_owned(),
            progress,
        },
    );
}

fn fail(message: impl Into<String>) -> String {
    message.into()
}

fn check_cancelled(state: &AppState) -> Result<(), String> {
    if state.is_cancelled() {
        Err(fail("启动已取消"))
    } else {
        Ok(())
    }
}

fn node_target() -> Result<NodeTarget, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return Ok(NodeTarget {
            archive_name: format!("node-v{NODE_VERSION}-win-x64.zip"),
            archive_root: format!("node-v{NODE_VERSION}-win-x64"),
            archive_extension: "zip",
            node_relative: PathBuf::from("node.exe"),
            npm_relative: PathBuf::from("node_modules/npm"),
        });
    }

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return Ok(NodeTarget {
            archive_name: format!("node-v{NODE_VERSION}-darwin-arm64.tar.gz"),
            archive_root: format!("node-v{NODE_VERSION}-darwin-arm64"),
            archive_extension: "tar.gz",
            node_relative: PathBuf::from("bin/node"),
            npm_relative: PathBuf::from("lib/node_modules/npm"),
        });
    }

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return Ok(NodeTarget {
            archive_name: format!("node-v{NODE_VERSION}-darwin-x64.tar.gz"),
            archive_root: format!("node-v{NODE_VERSION}-darwin-x64"),
            archive_extension: "tar.gz",
            node_relative: PathBuf::from("bin/node"),
            npm_relative: PathBuf::from("lib/node_modules/npm"),
        });
    }

    #[allow(unreachable_code)]
    Err(fail("当前平台暂不支持内置 Node.js 运行时"))
}

fn user_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(base).join("DeepSeek Harness"));
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("DeepSeek Harness"));
    }

    app.path()
        .app_local_data_dir()
        .map_err(|error| fail(format!("无法确定应用数据目录：{error}")))
}

fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
    } else {
        app.path()
            .resource_dir()
            .map_err(|error| fail(format!("无法确定应用资源目录：{error}")))
    }
}

fn http_client(timeout: Duration, no_redirect: bool) -> Result<Client, String> {
    let mut builder = Client::builder()
        .user_agent("DeepSeek-Harness-Client/0.1.0")
        .timeout(timeout);
    if no_redirect {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    builder
        .build()
        .map_err(|error| fail(format!("无法初始化网络客户端：{error}")))
}

fn fetch_text(url: &str) -> Result<String, String> {
    let response = http_client(Duration::from_secs(30), false)?
        .get(url)
        .send()
        .map_err(|error| fail(format!("下载失败 {url}：{error}")))?;
    if !response.status().is_success() {
        return Err(fail(format!("下载失败 {url}：HTTP {}", response.status())));
    }
    response
        .text()
        .map_err(|error| fail(format!("读取下载内容失败：{error}")))
}

fn expected_checksum(checksums: &str, archive_name: &str) -> Result<String, String> {
    for line in checksums.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next();
        let name = parts.next();
        if name == Some(archive_name) {
            if let Some(hash) = hash {
                return Ok(hash.to_ascii_lowercase());
            }
        }
    }
    Err(fail(format!("Node.js 校验文件中未找到 {archive_name}")))
}

fn download_file(
    app: &AppHandle,
    state: &AppState,
    url: &str,
    destination: &Path,
    start_progress: u8,
    end_progress: u8,
) -> Result<(), String> {
    let response = http_client(Duration::from_secs(300), false)?
        .get(url)
        .send()
        .map_err(|error| fail(format!("下载 Node.js 运行时失败：{error}")))?;
    if !response.status().is_success() {
        return Err(fail(format!(
            "下载 Node.js 运行时失败：HTTP {}",
            response.status()
        )));
    }

    let total = response.content_length();
    let temporary = destination.with_file_name(format!(
        ".{}.part",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("node-runtime")
    ));
    let _ = fs::remove_file(&temporary);
    let mut file = File::create(&temporary)
        .map_err(|error| fail(format!("无法创建 Node.js 临时文件：{error}")))?;
    let mut response = response;
    let mut buffer = [0_u8; 64 * 1024];
    let mut downloaded = 0_u64;
    let mut last_reported = 0_u64;

    loop {
        check_cancelled(state)?;
        let count = response
            .read(&mut buffer)
            .map_err(|error| fail(format!("读取 Node.js 下载内容失败：{error}")))?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count])
            .map_err(|error| fail(format!("写入 Node.js 临时文件失败：{error}")))?;
        downloaded += count as u64;
        if downloaded.saturating_sub(last_reported) >= 512 * 1024 {
            last_reported = downloaded;
            let progress = total.filter(|size| *size > 0).map(|size| {
                let fraction = (downloaded as f64 / size as f64).clamp(0.0, 1.0);
                start_progress + ((end_progress - start_progress) as f64 * fraction) as u8
            });
            emit_state(
                app,
                "正在下载 Node.js 运行时",
                &format!("正在下载 Node.js {NODE_VERSION}，请稍候…"),
                progress,
            );
        }
    }
    file.flush()
        .map_err(|error| fail(format!("保存 Node.js 下载文件失败：{error}")))?;
    fs::rename(&temporary, destination)
        .map_err(|error| fail(format!("保存 Node.js 下载文件失败：{error}")))?;
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        File::open(path).map_err(|error| fail(format!("无法读取 Node.js 下载文件：{error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| fail(format!("校验 Node.js 下载文件失败：{error}")))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn extract_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| fail(format!("无法打开 Node.js 压缩包：{error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| fail(format!("无法读取 Node.js 压缩包：{error}")))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| fail(format!("读取 Node.js 压缩包条目失败：{error}")))?;
        let normalized = entry.name().replace('\\', "/");
        let path = Path::new(&normalized);
        if path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, Component::ParentDir))
        {
            return Err(fail("Node.js 压缩包包含不安全路径"));
        }
        let output = destination.join(path);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| fail(format!("解压 Node.js 目录失败：{error}")))?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| fail(format!("解压 Node.js 文件失败：{error}")))?;
            }
            let mut target = File::create(&output)
                .map_err(|error| fail(format!("创建 Node.js 文件失败：{error}")))?;
            io::copy(&mut entry, &mut target)
                .map_err(|error| fail(format!("解压 Node.js 文件失败：{error}")))?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive_path: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive_path)
        .map_err(|error| fail(format!("无法打开 Node.js 压缩包：{error}")))?;
    let decoder = GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(destination)
        .map_err(|error| fail(format!("解压 Node.js 压缩包失败：{error}")))
}

fn copy_directory(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("npm 包含不支持的文件类型：{}", source_path.display()),
            ));
        }
    }
    Ok(())
}

fn ensure_node(app: &AppHandle, state: &AppState) -> Result<NodeRuntime, String> {
    let target = node_target()?;
    let data_root = user_data_root(app)?;
    let runtime_root = data_root.join("runtime").join("node").join(NODE_VERSION);
    let executable = runtime_root.join(&target.node_relative);
    let npm_root = runtime_root.join("npm-dist");
    let npm_cli = npm_root.join("bin").join("npm-cli.js");

    if executable.is_file() && npm_cli.is_file() {
        emit_state(
            app,
            "Node.js 运行时已就绪",
            &format!("已找到 Node.js {NODE_VERSION}，正在检查 DSH 核心…"),
            Some(8),
        );
        return Ok(NodeRuntime {
            executable,
            npm_cli,
        });
    }

    let download_root = data_root.join("runtime").join("downloads");
    fs::create_dir_all(&download_root)
        .map_err(|error| fail(format!("无法创建运行时下载目录：{error}")))?;
    let archive_path = download_root.join(&target.archive_name);
    let checksums_url = format!("https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt");
    let archive_url = format!(
        "https://nodejs.org/dist/v{NODE_VERSION}/{}",
        target.archive_name
    );

    emit_state(
        app,
        "正在准备 Node.js 运行时",
        &format!("客户端不内置 Node.js，首次启动将从 nodejs.org 下载 {NODE_VERSION}…"),
        Some(5),
    );
    let checksums = fetch_text(&checksums_url)?;
    let expected = expected_checksum(&checksums, &target.archive_name)?;
    if !archive_path.is_file() {
        download_file(app, state, &archive_url, &archive_path, 8, 30)?;
    }
    let actual = sha256_file(&archive_path)?;
    if actual != expected {
        let _ = fs::remove_file(&archive_path);
        return Err(fail("Node.js 下载文件校验失败，请重试。"));
    }

    check_cancelled(state)?;
    emit_state(
        app,
        "正在安装 Node.js 运行时",
        "下载已完成，正在校验并解压 Node.js…",
        Some(34),
    );
    let parent = runtime_root
        .parent()
        .ok_or_else(|| fail("无法确定 Node.js 运行时目录"))?;
    fs::create_dir_all(parent)
        .map_err(|error| fail(format!("无法创建 Node.js 运行时目录：{error}")))?;
    let staging = parent.join(format!(".staging-{}", std::process::id()));
    let extract_root = staging.join("extract");
    let normalized_root = staging.join("runtime");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&extract_root)
        .map_err(|error| fail(format!("无法创建 Node.js 解压目录：{error}")))?;
    if target.archive_extension == "zip" {
        extract_zip(&archive_path, &extract_root)?;
    } else {
        extract_tar_gz(&archive_path, &extract_root)?;
    }
    check_cancelled(state)?;

    let extracted_root = extract_root.join(&target.archive_root);
    let source_node = extracted_root.join(&target.node_relative);
    let source_npm = extracted_root.join(&target.npm_relative);
    if !source_node.is_file() || !source_npm.is_dir() {
        let _ = fs::remove_dir_all(&staging);
        return Err(fail("Node.js 压缩包缺少 node 或 npm 文件。"));
    }
    let destination_node = normalized_root.join(&target.node_relative);
    if let Some(destination_parent) = destination_node.parent() {
        fs::create_dir_all(destination_parent)
            .map_err(|error| fail(format!("无法准备 Node.js 目录：{error}")))?;
    }
    fs::copy(&source_node, &destination_node)
        .map_err(|error| fail(format!("复制 Node.js 可执行文件失败：{error}")))?;
    copy_directory(&source_npm, &normalized_root.join("npm-dist"))
        .map_err(|error| fail(format!("复制 npm 运行文件失败：{error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&destination_node)
            .map_err(|error| fail(format!("读取 Node.js 权限失败：{error}")))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&destination_node, permissions)
            .map_err(|error| fail(format!("设置 Node.js 权限失败：{error}")))?;
    }
    fs::write(
        normalized_root.join("runtime.json"),
        format!("{{\"version\":\"{NODE_VERSION}\",\"sha256\":\"{actual}\"}}\n"),
    )
    .map_err(|error| fail(format!("保存 Node.js 运行时信息失败：{error}")))?;

    if runtime_root.exists() {
        fs::remove_dir_all(&runtime_root)
            .map_err(|error| fail(format!("清理旧 Node.js 运行时失败：{error}")))?;
    }
    fs::rename(&normalized_root, &runtime_root)
        .map_err(|error| fail(format!("安装 Node.js 运行时失败：{error}")))?;
    let _ = fs::remove_dir_all(&staging);
    let _ = fs::remove_file(&archive_path);
    emit_state(
        app,
        "Node.js 运行时已就绪",
        &format!("Node.js {NODE_VERSION} 已安装到用户数据目录，正在安装 DSH 核心…"),
        Some(38),
    );
    Ok(NodeRuntime {
        executable,
        npm_cli,
    })
}

fn terminate_child(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id().to_string();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .creation_flags(0x08000000)
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
}

fn kill_process(state: &AppState, kind: ProcessKind) {
    if let Ok(mut processes) = state.inner.processes.lock() {
        if let Some(child) = processes.slot(kind).as_mut() {
            terminate_child(child);
        }
    }
}

fn poll_process(state: &AppState, kind: ProcessKind) -> Result<Option<ExitStatus>, String> {
    let mut processes = state
        .inner
        .processes
        .lock()
        .map_err(|_| fail("无法读取进程状态"))?;
    let slot = processes.slot(kind);
    let status = match slot.as_mut() {
        Some(child) => child
            .try_wait()
            .map_err(|error| fail(format!("读取子进程状态失败：{error}")))?,
        None => return Err(fail("子进程尚未启动")),
    };
    if status.is_some() {
        let _ = slot.take();
    }
    Ok(status)
}

fn stop_process(state: &AppState, kind: ProcessKind) {
    kill_process(state, kind);
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match poll_process(state, kind) {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(mut reader: R, output: Arc<Mutex<String>>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let count = match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => count,
            };
            if let Ok(mut text) = output.lock() {
                text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                if text.len() > 8000 {
                    let mut start = text.len() - 8000;
                    while !text.is_char_boundary(start) {
                        start += 1;
                    }
                    let trimmed = text[start..].to_owned();
                    *text = trimmed;
                }
            }
        }
    });
}

fn spawn_managed(
    state: &AppState,
    kind: ProcessKind,
    mut command: Command,
) -> Result<Arc<Mutex<String>>, String> {
    check_cancelled(state)?;
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW, inherited by console descendants.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| fail(format!("启动 Node.js 子进程失败：{error}")))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let output = Arc::new(Mutex::new(String::new()));
    {
        let mut processes = state
            .inner
            .processes
            .lock()
            .map_err(|_| fail("无法保存子进程状态"))?;
        let slot = processes.slot(kind);
        if slot.is_some() {
            terminate_child(&mut child);
            return Err(fail("同类子进程已经在运行"));
        }
        *slot = Some(child);
    }
    if let Some(stdout) = stdout {
        spawn_reader(stdout, output.clone());
    }
    if let Some(stderr) = stderr {
        spawn_reader(stderr, output.clone());
    }
    Ok(output)
}

fn wait_process(state: &AppState, kind: ProcessKind) -> Result<ExitStatus, String> {
    loop {
        check_cancelled(state)?;
        if let Some(status) = poll_process(state, kind)? {
            return Ok(status);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn hide_descendant_consoles(command: &mut Command, app: &AppHandle) -> Result<(), String> {
    if cfg!(target_os = "windows") {
        let preload = resource_root(app)?.join("client/runtime/hide-console.cjs");
        let existing = std::env::var("NODE_OPTIONS").unwrap_or_default();
        // NODE_OPTIONS consumes backslash escapes inside quoted paths.
        let preload = preload.to_string_lossy().replace('\\', "/");
        command.env("NODE_OPTIONS", format!("{existing} --require \"{preload}\""));
    }
    Ok(())
}

fn run_manager(
    app: &AppHandle,
    state: &AppState,
    node: &NodeRuntime,
    user_root: &Path,
) -> Result<(), String> {
    let resources = resource_root(app)?;
    let manager_path = resources
        .join("client")
        .join("runtime")
        .join("core-manager.mjs");
    if !manager_path.is_file() {
        return Err(fail(format!(
            "缺少 DSH 核心管理器：{}",
            manager_path.display()
        )));
    }
    fs::create_dir_all(user_root.join("core"))
        .map_err(|error| fail(format!("无法创建 DSH 核心目录：{error}")))?;
    emit_state(
        app,
        "正在准备 DSH 核心",
        "正在连接官方 npm registry，检查并安装 DSH 核心…",
        Some(42),
    );
    let mut command = Command::new(&node.executable);
    hide_descendant_consoles(&mut command, app)?;
    command
        .arg(manager_path)
        .arg("install")
        .current_dir(&resources)
        .env("DSH_CLIENT_ROOT", &resources)
        .env("DSH_CLIENT_CORE_ROOT", user_root.join("core"))
        .env("DSH_CLIENT_HOME", user_root)
        .env("DSH_CLIENT_NODE_BINARY", &node.executable)
        .env("DSH_CLIENT_PACKAGE_MANAGER", "npm")
        .env("DSH_CLIENT_NPM_CLI", &node.npm_cli);
    let _output = spawn_managed(state, ProcessKind::Manager, command)?;
    let status = wait_process(state, ProcessKind::Manager)?;
    if !status.success() {
        return Err(fail(format!(
            "DSH 核心安装失败，Node.js 子进程退出码：{}",
            status
                .code()
                .map_or_else(|| "unknown".to_owned(), |code| code.to_string())
        )));
    }
    Ok(())
}

fn read_current_core(core_root: &Path) -> Result<CurrentCore, String> {
    let path = core_root.join("current.json");
    let bytes = fs::read(&path).map_err(|error| fail(format!("无法读取 DSH 核心版本：{error}")))?;
    let current: CurrentCore = serde_json::from_slice(&bytes)
        .map_err(|error| fail(format!("DSH 核心版本文件格式错误：{error}")))?;
    if current.version.is_empty()
        || current.version.contains('/')
        || current.version.contains('\\')
        || current.version.contains("..")
    {
        return Err(fail("DSH 核心版本无效"));
    }
    Ok(current)
}

fn announced_url(output: &str) -> Option<String> {
    let marker = "dsh web:";
    let position = output.rfind(marker)? + marker.len();
    let candidate = output[position..]
        .split_whitespace()
        .next()?
        .trim_matches(|character: char| character == '\r' || character == '\n');
    if candidate.starts_with("http://127.0.0.1:") {
        Some(candidate.to_owned())
    } else {
        None
    }
}

fn probe_ready(client: &Client, url: &str) -> Result<bool, String> {
    let response = client
        .get(url)
        .send()
        .map_err(|error| fail(error.to_string()))?;
    let authenticated_redirect = response.status() == reqwest::StatusCode::SEE_OTHER
        && response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            == Some("/")
        && response.headers().contains_key(reqwest::header::SET_COOKIE);
    Ok(response.status().is_success() || authenticated_redirect)
}

fn start_core(
    app: &AppHandle,
    state: &AppState,
    node: &NodeRuntime,
    user_root: &Path,
) -> Result<(String, String), String> {
    let core_root = user_root.join("core");
    let current = read_current_core(&core_root)?;
    let core_directory = core_root.join("versions").join(&current.version);
    let core_entry = core_directory
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !core_entry.is_file() {
        return Err(fail(format!(
            "DSH 核心入口不存在：{}",
            core_entry.display()
        )));
    }

    emit_state(
        app,
        "正在启动本地 DSH 服务",
        "正在分配本地端口并启动 Web 服务…",
        Some(55),
    );
    check_cancelled(state)?;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| fail(format!("无法分配本地端口：{error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| fail(format!("无法读取本地端口：{error}")))?
        .port();
    drop(listener);
    let base_url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(&node.executable);
    hide_descendant_consoles(&mut command, app)?;
    command
        .arg(&core_entry)
        .args(["web", "--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .args(["--no-open"])
        .current_dir(&core_directory)
        .env("DSH_HOME", user_root.join("dsh-home"))
        .env("DSH_CLIENT_CORE_VERSION", &current.version)
        .env("DSH_CLIENT_APP", "1");
    let output = spawn_managed(state, ProcessKind::Core, command)?;
    let client = http_client(Duration::from_secs(3), true)?;
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut last_progress = Instant::now();

    loop {
        check_cancelled(state)?;
        if let Some(status) = poll_process(state, ProcessKind::Core)? {
            let diagnostics = output.lock().map(|text| text.clone()).unwrap_or_default();
            return Err(fail(format!(
                "DSH 核心在 Web UI 就绪前退出（{}）\n{}",
                status
                    .code()
                    .map_or_else(|| "unknown".to_owned(), |code| code.to_string()),
                diagnostics.trim()
            )));
        }
        let diagnostics = output.lock().map(|text| text.clone()).unwrap_or_default();
        let last_error = if let Some(url) = announced_url(&diagnostics) {
            match probe_ready(&client, &url) {
                Ok(true) => {
                    emit_state(
                        app,
                        "正在打开 DSH 界面",
                        "本地服务已就绪，正在打开安全连接…",
                        Some(98),
                    );
                    return Ok((current.version, url));
                }
                Ok(false) => "DSH Web UI 尚未完成登录态初始化".to_owned(),
                Err(error) => error,
            }
        } else {
            match probe_ready(&client, &base_url) {
                Ok(true) => {
                    emit_state(
                        app,
                        "正在打开 DSH 界面",
                        "本地服务已就绪，正在打开安全连接…",
                        Some(98),
                    );
                    return Ok((current.version, base_url));
                }
                Ok(false) => "本地服务返回未就绪状态".to_owned(),
                Err(error) => error,
            }
        };
        if last_progress.elapsed() >= Duration::from_secs(1) {
            last_progress = Instant::now();
            let seconds = 90
                - deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs()
                    .min(90);
            emit_state(
                app,
                "正在启动本地 DSH 服务",
                &format!("正在等待 Web UI 就绪，已用时 {seconds} 秒。{}", last_error),
                Some((62 + seconds as u8).min(92)),
            );
        }
        if Instant::now() >= deadline {
            stop_process(state, ProcessKind::Core);
            let diagnostics = output.lock().map(|text| text.clone()).unwrap_or_default();
            return Err(fail(format!(
                "DSH Web UI 未在 90 秒内就绪：{}\n{}",
                last_error,
                diagnostics.trim()
            )));
        }
        thread::sleep(Duration::from_millis(250));
    }
}

fn start_client_blocking(app: &AppHandle, state: &AppState) -> Result<String, String> {
    let result = (|| {
        let user_root = user_data_root(app)?;
        fs::create_dir_all(&user_root)
            .map_err(|error| fail(format!("无法创建应用数据目录：{error}")))?;
        let node = ensure_node(app, state)?;
        emit_state(
            app,
            "正在检查 DSH 核心",
            "Node.js 运行时已就绪，正在检查官方核心版本…",
            Some(40),
        );
        run_manager(app, state, &node, &user_root)?;
        let (_version, url) = start_core(app, state, &node, &user_root)?;
        Ok(url)
    })();
    if let Err(error) = &result {
        state.cancel_and_kill();
        let user_root = user_data_root(app).ok();
        if let Some(user_root) = user_root {
            let _ = fs::create_dir_all(&user_root);
            let _ = fs::write(user_root.join("startup-error.log"), format!("{error}\n"));
        }
    }
    result
}

fn navigate_to_core_window(app: &AppHandle, url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| fail(format!("DSH 地址无效：{error}")))?;
    if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1") {
        return Err(fail("只允许打开本机 DSH Web UI 地址"));
    }
    let window = app.get_window("main").ok_or_else(|| fail("主窗口不存在"))?;
    if let Some(core) = app.get_webview("core") {
        return core.navigate(parsed).map_err(|error| error.to_string());
    }
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(window.scale_factor().map_err(|error| error.to_string())?);
    window
        .add_child(
            WebviewBuilder::new("core", WebviewUrl::External(parsed)),
            LogicalPosition::new(0.0, 48.0),
            LogicalSize::new(size.width, (size.height - 48.0).max(1.0)),
        )
        .map_err(|error| format!("打开 DSH Web UI 失败：{error}"))?;
    Ok(())
}

fn current_core_version(app: &AppHandle) -> String {
    user_data_root(app)
        .ok()
        .and_then(|root| read_current_core(&root.join("core")).ok())
        .map(|core| core.version)
        .unwrap_or_else(|| "尚未安装".to_owned())
}

fn show_about(app: &AppHandle) {
    let info: Value = serde_json::from_str(CLIENT_INFO_JSON).unwrap_or(Value::Null);
    let developer = info
        .get("developer")
        .and_then(Value::as_str)
        .unwrap_or("Sunky");
    let description = info
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("DeepSeek Harness 独立桌面客户端");
    let message = format!(
        "{description}\n\n桌面客户端 v0.1.0\nDSH 核心 {core}\n客户端开发者 · {developer}\n\nNode.js 运行时在首次启动时按需下载并缓存。",
        core = current_core_version(app)
    );
    app.dialog()
        .message(message)
        .title("关于与更新")
        .kind(MessageDialogKind::Info)
        .blocking_show();
}

fn read_channel(app: &AppHandle) -> Result<CoreChannel, String> {
    let path = resource_root(app)?.join("client").join("core-channel.json");
    let bytes = fs::read(&path).map_err(|error| fail(format!("无法读取核心渠道配置：{error}")))?;
    serde_json::from_slice(&bytes).map_err(|error| fail(format!("核心渠道配置格式错误：{error}")))
}

fn check_core_update_blocking(app: &AppHandle, state: &AppState) -> Result<String, String> {
    let channel = read_channel(app)?;
    if channel.package_name != "@deepseek-ai/dsh" || !channel.registry.starts_with("https://") {
        return Err(fail("核心渠道配置无效"));
    }
    let user_root = user_data_root(app)?;
    let current = read_current_core(&user_root.join("core"))?;
    let package_path = channel.package_name.clone();
    let metadata_url = format!("{}/{}", channel.registry, package_path);
    let metadata: Value = http_client(Duration::from_secs(20), false)?
        .get(&metadata_url)
        .send()
        .map_err(|error| fail(format!("读取核心版本失败：{error}")))?
        .json()
        .map_err(|error| fail(format!("解析核心版本失败：{error}")))?;
    let available = metadata
        .get("dist-tags")
        .and_then(|tags| tags.get(&channel.dist_tag))
        .and_then(Value::as_str)
        .ok_or_else(|| fail("官方 registry 未返回可用核心版本"))?;
    if available == current.version {
        return Ok(format!("当前 DSH 核心已是 {available}"));
    }

    let accepted = app
        .dialog()
        .message(format!(
            "发现 DSH 核心更新：{} → {}",
            current.version, available
        ))
        .title("发现 DSH 核心更新")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancel)
        .blocking_show();
    if !accepted {
        return Ok("已取消更新。".to_owned());
    }
    let node = ensure_node(app, state)?;
    run_manager(app, state, &node, &user_root)?;
    stop_process(state, ProcessKind::Core);
    let (version, url) = start_core(app, state, &node, &user_root)?;
    navigate_to_core_window(app, &url)?;
    Ok(format!("DSH 核心已更新至 {version}"))
}

fn launch_core_update(app: &AppHandle, state: &AppState) {
    if app.get_webview("core").is_none() {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            handle
                .dialog()
                .message("请等待客户端启动完成后再检查更新。")
                .title("DSH 核心更新")
                .blocking_show();
        });
        return;
    }
    if state.inner.update_in_progress.swap(true, Ordering::SeqCst) {
        app.dialog()
            .message("核心更新任务正在进行中。")
            .title("DSH 核心更新")
            .kind(MessageDialogKind::Info)
            .blocking_show();
        return;
    }
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = check_core_update_blocking(&app, &state);
        state
            .inner
            .update_in_progress
            .store(false, Ordering::SeqCst);
        let (message, kind) = match result {
            Ok(message) => (message, MessageDialogKind::Info),
            Err(error) => (error, MessageDialogKind::Error),
        };
        app.dialog()
            .message(message)
            .title("DSH 核心更新")
            .kind(kind)
            .blocking_show();
    });
}

// Only the bundled shell can operate the window; the core webview has no IPC capability.
#[tauri::command]
async fn shell_action(
    app: AppHandle,
    webview: tauri::Webview,
    action: String,
) -> Result<bool, String> {
    if webview.label() != "main" {
        return Err("无权限".into());
    }
    let window = app.get_window("main").ok_or("主窗口不存在")?;
    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string())?,
        "maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize().map_err(|e| e.to_string())?;
            } else {
                window.maximize().map_err(|e| e.to_string())?;
            }
        }
        "state" => {}
        "drag" => window.start_dragging().map_err(|e| e.to_string())?,
        "close" => {
            window.close().map_err(|e| e.to_string())?;
            return Ok(false);
        }
        "about" => {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || show_about(&handle));
        }
        "core-update" => launch_core_update(&app, app.state::<AppState>().inner()),
        "upstream" => app
            .opener()
            .open_url(
                "https://github.com/deepseek-ai/deepseek-harness",
                None::<&str>,
            )
            .map_err(|e| e.to_string())?,
        "client-repository" => app
            .opener()
            .open_url("https://github.com/isunky/DSH-Desktop", None::<&str>)
            .map_err(|e| e.to_string())?,
        _ => return Err("未知操作".into()),
    }
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_client(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let state = state.inner().clone();
    if state.inner.startup_started.swap(true, Ordering::SeqCst) {
        return Err(fail("启动任务已经在运行"));
    }
    state.inner.cancelled.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || start_client_blocking(&app, &state))
        .await
        .map_err(|error| fail(format!("启动任务异常：{error}")))?
}

#[tauri::command]
fn cancel_startup(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_and_kill();
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn navigate_to_core(app: AppHandle, url: String) -> Result<(), String> {
    navigate_to_core_window(&app, &url)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            start_client,
            cancel_startup,
            navigate_to_core,
            shell_action
        ])
        .setup(|app| {
            let _ = app.remove_menu();
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let (Some(core), Ok(size), Ok(scale)) = (
                    window.app_handle().get_webview("core"),
                    window.inner_size(),
                    window.scale_factor(),
                ) {
                    let size = size.to_logical::<f64>(scale);
                    let _ = core.set_bounds(tauri::Rect {
                        position: LogicalPosition::new(0.0, 48.0).into(),
                        size: LogicalSize::new(size.width, (size.height - 48.0).max(1.0)).into(),
                    });
                }
            }
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let state = window.app_handle().state::<AppState>();
                state.cancel_and_kill();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
