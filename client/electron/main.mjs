import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { probeWeb, redactTokens } from './web-readiness.mjs'
import { checkClientRelease } from './client-release.mjs'

const CHANNEL_PATH = fileURLToPath(new URL('../core-channel.json', import.meta.url))
const shellUrl = new URL('./loading.html', import.meta.url)

const configuredUserData = process.env.DSH_CLIENT_USER_DATA_DIR
if (configuredUserData !== undefined) app.setPath('userData', resolve(configuredUserData))

let mainWindow
let coreProcess
let managerProcess
let startupCoreProcess
let startupActive = false
let startupCancelled = false
let shutdownInProgress = false
let updatingCore = false
let focusWindow = () => {}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function cancelledError() {
  const error = new Error('启动已取消')
  error.code = 'DSH_STARTUP_CANCELLED'
  return error
}

function throwIfCancelled() {
  if (startupCancelled) throw cancelledError()
}

async function setStartupState(stage, detail, progress = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const state = JSON.stringify({ stage, detail, progress })
  await mainWindow.webContents
    .executeJavaScript(`window.__dshSetStartupState(${state})`, true)
    .catch(() => undefined)
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.unref()
    return
  }
  child.kill('SIGTERM')
}

async function waitForClose(child, timeout = 5000) {
  if (!child || child.exitCode !== null) return
  await new Promise(resolvePromise => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise()
    }
    const timer = setTimeout(finish, timeout)
    child.once('close', finish)
  })
}

async function stopChild(child) {
  if (!child) return
  terminateProcessTree(child)
  await waitForClose(child)
}

function coreRoot() {
  return join(app.getPath('userData'), 'core')
}

function coreHome() {
  return join(app.getPath('userData'), 'dsh-home')
}

function coreVersionDirectory(version) {
  return join(coreRoot(), 'versions', version)
}

function clientRoot() {
  if (app.isPackaged) return join(process.resourcesPath, 'app.asar.unpacked')
  return fileURLToPath(new URL('../..', import.meta.url))
}

function coreManagerPath() {
  if (app.isPackaged) return join(clientRoot(), 'client', 'runtime', 'core-manager.mjs')
  return fileURLToPath(new URL('../runtime/core-manager.mjs', import.meta.url))
}

async function readCurrentCore() {
  const current = JSON.parse(await readFile(join(coreRoot(), 'current.json'), 'utf8'))
  return { ...current, directory: coreVersionDirectory(current.version) }
}

function runtimeNode() {
  const configured = process.env.DSH_CLIENT_NODE_BINARY
  if (configured) return configured
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'runtime',
      'node',
      process.platform === 'win32' ? 'node.exe' : join('bin', 'node'),
    )
  }
  return process.execPath
}

function coreEntry(core) {
  return join(core.directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

async function runManager(command, { showProgress = false } = {}) {
  await mkdir(coreRoot(), { recursive: true })
  throwIfCancelled()
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(runtimeNode(), [coreManagerPath(), command], {
      env: {
        ...process.env,
        DSH_CLIENT_NODE_BINARY: runtimeNode(),
        DSH_CLIENT_ROOT: clientRoot(),
        DSH_CLIENT_CORE_ROOT: coreRoot(),
        DSH_CLIENT_HOME: app.getPath('userData'),
        ...(app.isPackaged
          ? {
              DSH_CLIENT_PACKAGE_MANAGER: 'npm',
              DSH_CLIENT_NPM_CLI: join(
                process.resourcesPath,
                'runtime',
                'node',
                'npm-dist',
                'bin',
                'npm-cli.js',
              ),
            }
          : {
              DSH_CLIENT_PNPM_ENTRY: join(clientRoot(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
            }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    managerProcess = child
    const startedAt = Date.now()
    const progressTimer = showProgress
      ? setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000)
        void setStartupState(
          '正在准备 DSH 核心运行时',
          `正在从官方 npm registry 下载或校验核心依赖，已用时 ${seconds} 秒。首次启动可能需要几分钟。`,
          30,
        )
      }, 1000)
      : undefined
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (progressTimer !== undefined) clearInterval(progressTimer)
      if (managerProcess === child) managerProcess = undefined
      callback(value)
    }
    const forwardOutput = chunk => {
      const text = String(chunk)
      process.stdout?.write?.(text)
      if (showProgress && text.trim()) {
        void setStartupState('正在准备 DSH 核心运行时', text.trim().slice(-240), 30)
      }
    }
    child.stdout?.on('data', forwardOutput)
    child.stderr?.on('data', forwardOutput)
    child.once('error', error => finish(reject, error))
    child.once('close', code => {
      if (startupCancelled) finish(reject, cancelledError())
      else if (code !== 0) finish(reject, new Error(`core manager exited with code ${String(code ?? 1)}`))
      else finish(resolvePromise)
    })
  })
}

async function freePort() {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(error => {
        if (error) reject(error)
        else if (port === undefined) reject(new Error('could not allocate a local port'))
        else resolvePromise(port)
      })
    })
  })
}

async function waitForWeb(baseUrl, child, announcedUrl, onProgress) {
  const deadline = Date.now() + 90_000
  const startedAt = Date.now()
  let lastProgressAt = 0
  let lastError = 'not started'
  while (Date.now() < deadline) {
    throwIfCancelled()
    if (child.exitCode !== null) throw new Error(`DSH core exited before the Web UI was ready (code ${String(child.exitCode)})`)
    if (Date.now() - lastProgressAt >= 1000) {
      lastProgressAt = Date.now()
      onProgress?.(Math.floor((Date.now() - startedAt) / 1000))
    }
    const localUrl = announcedUrl()
    if (localUrl !== undefined) {
      try {
        const response = await probeWeb(localUrl)
        if (response.ready) return localUrl
        lastError = `HTTP ${response.status}`
      } catch (error) {
        lastError = errorMessage(error)
      }
    }
    if (localUrl === undefined) try {
      const response = await probeWeb(baseUrl)
      lastError = `HTTP ${response.status}`
      if (response.ready) return baseUrl
    } catch (error) {
      lastError = errorMessage(error)
    }
    throwIfCancelled()
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(`DSH Web UI did not become ready: ${lastError}`)
}

async function startCore() {
  await setStartupState('正在启动本地 DSH 服务', '正在分配本地端口并启动 Web 服务…', 55)
  throwIfCancelled()
  const core = await readCurrentCore()
  const port = await freePort()
  let url = `http://127.0.0.1:${port}`
  const child = spawn(runtimeNode(), [coreEntry(core), 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
    cwd: core.directory,
    env: {
      ...process.env,
      DSH_CLIENT_NODE_BINARY: runtimeNode(),
      DSH_HOME: coreHome(),
      DSH_CLIENT_CORE_VERSION: core.version,
      DSH_CLIENT_APP: '1',
    },
    stdio: 'pipe',
    windowsHide: true,
  })
  startupCoreProcess = child
  let diagnostics = ''
  let localUrl
  const acceptOutput = chunk => {
    const text = String(chunk)
    diagnostics = `${diagnostics}${text}`.slice(-8000)
    const match = diagnostics.match(/dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/u)
    if (match !== null && localUrl === undefined) {
      localUrl = match[1]
      console.log(`client: DSH Web UI ${redactTokens(localUrl)}`)
    }
  }
  child.stdout.on('data', acceptOutput)
  child.stderr.on('data', acceptOutput)
  child.once('exit', () => {
    if (coreProcess?.child === child) coreProcess = undefined
    if (startupCoreProcess === child) startupCoreProcess = undefined
  })
  try {
    const announcedUrl = await waitForWeb(url, child, () => localUrl, seconds => {
      void setStartupState(
        '正在启动本地 DSH 服务',
        `正在等待 Web UI 就绪，已用时 ${seconds} 秒。若网络不可用，已安装的核心仍可继续启动。`,
        Math.min(92, 62 + seconds),
      )
    })
    url = announcedUrl
  } catch (error) {
    await stopChild(child)
    throw new Error(redactTokens(`${errorMessage(error)}\n${diagnostics.trim()}`))
  }
  startupCoreProcess = undefined
  coreProcess = { child, version: core.version }
  await setStartupState('正在打开 DSH 界面', '本地服务已就绪，正在打开安全连接…', 98)
  return { core, url }
}

async function stopCore() {
  const active = coreProcess
  coreProcess = undefined
  const child = active?.child ?? startupCoreProcess
  if (startupCoreProcess === child) startupCoreProcess = undefined
  await stopChild(child)
}

async function checkCoreUpdate(manual = true) {
  if (updatingCore) return '核心更新任务正在进行中。'
  updatingCore = true
  try {
    const config = JSON.parse(await readFile(CHANNEL_PATH, 'utf8'))
    const packagePath = encodeURIComponent(config.packageName).replace('%40', '@')
    const response = await fetch(`${config.registry}/${packagePath}`, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`official registry returned HTTP ${response.status}`)
    const metadata = await response.json()
    const available = metadata['dist-tags']?.[config.distTag]
    const current = coreProcess?.version ?? (await readCurrentCore()).version
    if (!available || available === current) {
      if (manual) await dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'DSH 核心更新', message: `当前已是 ${current}`,
        detail: '来源：官方 DSH 开源项目与 npm registry。可在“关于与更新”中打开 GitHub 源码仓库核验。',
      })
      return `当前 DSH 核心已是 ${current}`
    }
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现 DSH 核心更新',
      message: `${current} → ${available}`,
      detail: '来源：官方 DSH 开源项目（github.com/deepseek-ai/deepseek-harness）。将从官方 npm registry 下载新核心，客户端窗口和用户数据保持不变。更新前可在“关于与更新”中打开 GitHub 源码核验。',
      buttons: ['立即更新并重启核心', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response !== 0) return '已取消更新。'
    await runManager('install')
    await stopCore()
    const started = await startCore()
    await mainWindow.loadURL(started.url)
    return `DSH 核心已更新至 ${started.core.version}`
  } catch (error) {
    if (manual) await dialog.showErrorBox('DSH 核心更新失败', errorMessage(error))
    return `更新失败：${errorMessage(error)}`
  } finally {
    updatingCore = false
  }
}

async function requestQuit() {
  if (shutdownInProgress) return
  shutdownInProgress = true
  startupCancelled = true
  await setStartupState('正在退出', '正在停止安装任务和本地 DSH 服务…', null)
  await stopChild(managerProcess)
  managerProcess = undefined
  await stopCore()
  app.exit(0)
}

async function main() {
  startupActive = true
  startupCancelled = false
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'DeepSeek Harness',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {
          frame: false,
        }),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  })
  mainWindow.on('close', event => {
    if (!shutdownInProgress && (startupActive || managerProcess || startupCoreProcess || coreProcess)) {
      event.preventDefault()
      void requestQuit()
    }
  })
  mainWindow.once('ready-to-show', () => { if (!mainWindow.isDestroyed()) mainWindow.show() })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' }
    return { action: 'deny' }
  })
  await mainWindow.loadURL(shellUrl.href)
  try {
    await setStartupState('正在检查 DSH 核心', '正在连接官方 npm registry，确认本地核心版本…', 12)
    await runManager('install', { showProgress: true })
    await setStartupState('DSH 核心已就绪', '核心运行时准备完成，正在启动本地服务…', 48)
    const started = await startCore()
    // Flush the loading document's full-window drag region before navigation.
    await mainWindow.webContents.executeJavaScript(`new Promise(resolve => {
      document.body.style.setProperty('-webkit-app-region', 'no-drag', 'important');
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    })`)
    await mainWindow.loadURL(started.url)
    startupActive = false
  } catch (error) {
    if (startupCancelled || error?.code === 'DSH_STARTUP_CANCELLED') {
      await requestQuit()
      return
    }
    startupActive = false
    await writeFile(join(app.getPath('userData'), 'startup-error.log'), `${errorMessage(error)}\n`).catch(() => undefined)
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'DeepSeek Harness 启动失败',
      message: errorMessage(error),
      detail: '首次启动需要从官方 npm registry 获取 DSH 核心；已缓存核心时可断网启动。',
    })
    app.exit(1)
    return
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: process.platform === 'darwin' ? app.name : 'DeepSeek Harness',
    submenu: [
      { label: '检查 DSH 核心更新', click: () => { void checkCoreUpdate(true) } },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }]))
  focusWindow = () => {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
else {
  app.on('second-instance', () => focusWindow())
  ipcMain.handle('client:about', async (event, action = 'info') => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Invalid sender')
    const info = JSON.parse(await readFile(new URL('./client-info.json', import.meta.url), 'utf8'))
    if (action === 'info') return {
      ...info,
      clientVersion: app.getVersion(),
      coreVersion: coreProcess?.version ?? '尚未启动',
      platform: `${process.platform} / ${process.arch}`,
    }
    if (action === 'core-update') return checkCoreUpdate(false)
    if (action === 'client-update' && info.clientRepository) {
      const release = await checkClientRelease(info.clientRepository, app.getVersion())
      if (release.message) return release.message
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'info', title: '客户端更新', message: `v${app.getVersion()} → v${release.version}`,
        detail: '来源：github.com/isunky/DSH-Desktop。打开 GitHub Release 页面，下载适合当前系统的安装包并覆盖安装。DSH 核心和用户数据将保留。',
        buttons: ['打开下载页面', '稍后'], cancelId: 1,
      })
      if (choice.response !== 0) return '已取消客户端更新。'
      await shell.openExternal(release.url)
      return `已打开 v${release.version} 下载页面。安装前请退出客户端。`
    }
    const url = action === 'client-update' ? info.clientReleasesUrl
      : action === 'upstream' ? info.upstreamUrl
        : action === 'client-repository' && info.clientRepository ? `https://github.com/${info.clientRepository}`
          : action === 'homepage' ? info.homepage : null
    if (!url) return action === 'client-update'
      ? '客户端在线更新渠道尚未配置。当前可使用新版安装包覆盖安装，DSH 核心和用户数据独立保留。'
      : '暂未配置开发者主页。'
    if (new URL(url).protocol !== 'https:') throw new Error('更新与主页地址必须使用 HTTPS')
    await shell.openExternal(url)
    if (action === 'upstream') return '已在浏览器打开官方 DSH GitHub 源码仓库。'
    if (action === 'client-repository') return '已在浏览器打开独立客户端 GitHub 仓库。'
    return action === 'client-update' ? '已打开客户端 GitHub 发布页面。下载新版安装包后覆盖安装即可；不会更新 DSH 核心。' : '已在浏览器打开。'
  })
  ipcMain.on('client:window-action', (event, action) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) return
    if (action === 'minimize') mainWindow.minimize()
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    } else if (action === 'fullscreen') mainWindow.setFullScreen(!mainWindow.isFullScreen())
    else if (action === 'close') void requestQuit()
  })
  ipcMain.on('client:cancel-startup', () => {
    if (startupActive || managerProcess || startupCoreProcess || coreProcess) void requestQuit()
  })
  app.on('before-quit', event => {
    if (shutdownInProgress) return
    if (!startupActive && managerProcess === undefined && startupCoreProcess === undefined && coreProcess === undefined) return
    event.preventDefault()
    void requestQuit()
  })
  void app.whenReady().then(main).catch(error => {
    dialog.showErrorBox('DeepSeek Harness 启动失败', errorMessage(error))
    app.exit(1)
  })
}
