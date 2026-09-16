const header = document.querySelector('#shell-header')
const settings = document.querySelector('#shell-settings')
const dialog = document.querySelector('#settings-dialog')
const settingsStatus = document.querySelector('#settings-status')
const maximize = header.querySelector('[data-action="maximize"]')
const notice = document.querySelector('#shell-notice')
let noticeTimer
const coreUpdateButton = dialog.querySelector('[data-setting-action="core-update"]')
const coreUpdateLabel = document.querySelector('#core-update-label')
const coreFeedback = document.querySelector('#core-update-feedback')
const coreStatus = document.querySelector('#core-update-status')
const coreDetails = document.querySelector('#core-update-details')
let coreUpdateBusy = false
const clientUpdateButton = dialog.querySelector('[data-setting-action="client-releases"]')
const clientUpdateLabel = document.querySelector('#client-update-label')
const clientFeedback = document.querySelector('#client-update-feedback')
const clientStatus = document.querySelector('#client-update-status')
const clientProgress = document.querySelector('#client-update-progress')
const clientDownloadButton = document.querySelector('#client-update-download')
const clientInstallButton = document.querySelector('#client-update-install')
const clientCancelButton = document.querySelector('#client-update-cancel')
const clientDetails = document.querySelector('#client-update-details')
const clientNotes = document.querySelector('#client-update-notes')
let clientUpdateBusy = false
let latestClientUpdate

function showCoreFeedback(message, busy = false) {
  coreUpdateBusy = busy
  coreUpdateButton.disabled = busy
  coreUpdateButton.setAttribute('aria-busy', String(busy))
  coreUpdateLabel.textContent = busy ? '正在处理…' : '检查核心更新'
  coreFeedback.hidden = false
  const [summary, ...details] = String(message).split('\n')
  coreStatus.textContent = summary
  document.querySelector('#core-update-diagnostics').textContent = details.join('\n').trim()
  coreDetails.hidden = !details.join('').trim()
  coreDetails.open = false
}

async function refreshSettingsInfo() {
  const info = await window.__TAURI__.core.invoke('settings_info')
  document.querySelector('#settings-core-version').textContent = info.core
  document.querySelector('#settings-client-version').textContent = `v${info.client}`
  document.querySelector('#settings-runtime').textContent = info.runtime
}

// Register before dispatching so even an immediate rejection is displayed locally.
const coreListenersReady = window.__TAURI__ ? Promise.all([
  window.__TAURI__.event.listen('core-update-result', event => {
    showCoreFeedback(event.payload)
    void refreshSettingsInfo().catch(() => {})
  }),
  window.__TAURI__.event.listen('startup-state', event => {
    if (!coreUpdateBusy) return
    coreStatus.textContent = event.payload.detail || event.payload.stage
    coreUpdateLabel.textContent = event.payload.stage || '正在处理…'
  }),
  window.__TAURI__.event.listen('client-update-progress', event => {
    const payload = event.payload || {}
    if (payload.stage === 'ready') {
      clientStatus.textContent = `v${payload.version || latestClientUpdate?.latest} 已下载完成，可以打开安装包。`
      clientProgress.style.width = '100%'
      return
    }
    if (payload.stage === 'downloading') {
      const progress = typeof payload.progress === 'number' ? payload.progress : null
      const total = formatBytes(payload.total)
      clientStatus.textContent = progress === null
        ? '正在下载客户端更新…'
        : `正在下载客户端更新… ${progress}%${total ? ` / ${total}` : ''}`
      if (progress !== null) clientProgress.style.width = `${progress}%`
    }
  }),
]).then(() => null, error => error) : Promise.resolve('客户端接口不可用')

async function checkCoreUpdate() {
  if (coreUpdateBusy) return
  showCoreFeedback('正在连接官方渠道，检查可用版本…', true)
  coreUpdateLabel.textContent = '正在检查…'
  try {
    const listenerError = await coreListenersReady
    if (listenerError) throw listenerError
    await window.__TAURI__.core.invoke('shell_action', { action: 'core-update' })
  } catch (error) {
    showCoreFeedback(`检查未完成，请重试。\n${String(error)}`)
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function setClientUpdateBusy(busy, downloading = false) {
  clientUpdateBusy = busy
  clientUpdateButton.disabled = busy
  clientUpdateButton.setAttribute('aria-busy', String(busy))
  clientCancelButton.hidden = !downloading
  if (!busy) clientUpdateLabel.textContent = '重新检查客户端更新'
}

async function checkClientUpdate() {
  if (clientUpdateBusy) return
  setClientUpdateBusy(true, false)
  clientFeedback.hidden = false
  clientDownloadButton.hidden = true
  clientInstallButton.hidden = true
  clientDetails.hidden = true
  clientProgress.style.width = '0%'
  clientStatus.textContent = '正在查询 GitHub 最新版本…'
  try {
    const listenerError = await coreListenersReady
    if (listenerError) throw listenerError
    const info = await window.__TAURI__.core.invoke('client_update_check')
    latestClientUpdate = info
    if (info.available) {
      const size = info.assetName ? `（${info.assetName}）` : ''
      clientStatus.textContent = info.assetAvailable
        ? `发现新版本 v${info.latest} ${size}`
        : `发现新版本 v${info.latest}，但当前平台暂未提供安装包。`
      clientDownloadButton.textContent = `下载 v${info.latest}`
      clientDownloadButton.hidden = !info.assetAvailable
      clientNotes.textContent = info.notes || '此版本没有附加说明。'
      clientDetails.hidden = false
    } else {
      clientStatus.textContent = `当前已是最新版本 v${info.current}`
    }
  } catch (error) {
    clientStatus.textContent = `暂时无法检查客户端更新：${String(error)}`
  } finally {
    setClientUpdateBusy(false)
  }
}

async function downloadClientUpdate() {
  if (clientUpdateBusy) return
  setClientUpdateBusy(true, true)
  clientDownloadButton.disabled = true
  clientInstallButton.hidden = true
  clientFeedback.hidden = false
  clientProgress.style.width = '0%'
  clientStatus.textContent = `正在下载 v${latestClientUpdate?.latest || '最新'}，请稍候…`
  try {
    const result = await window.__TAURI__.core.invoke('client_update_download')
    clientStatus.textContent = `v${result.version} 已下载完成，可以打开安装包。`
    clientProgress.style.width = '100%'
    clientDownloadButton.hidden = true
    clientInstallButton.hidden = false
  } catch (error) {
    clientStatus.textContent = `客户端下载失败：${String(error)}`
  } finally {
    clientDownloadButton.disabled = false
    setClientUpdateBusy(false)
    clientCancelButton.hidden = true
  }
}

async function cancelClientUpdate() {
  if (!clientUpdateBusy) return
  clientStatus.textContent = '正在取消下载…'
  await window.__TAURI__.core.invoke('client_update_cancel').catch(error => {
    clientStatus.textContent = String(error)
  })
}

async function installClientUpdate() {
  clientInstallButton.disabled = true
  clientStatus.textContent = '正在打开安装包…'
  try {
    await window.__TAURI__.core.invoke('client_update_install')
  } catch (error) {
    clientInstallButton.disabled = false
    clientStatus.textContent = `无法打开安装包：${String(error)}`
  }
}

async function act(action) {
  try {
    if (!window.__TAURI__) return
    const maximized = await window.__TAURI__.core.invoke('shell_action', { action })
    maximize.title = maximize.ariaLabel = maximized ? '还原' : '最大化'
    maximize.setAttribute('aria-pressed', String(maximized))
    maximize.querySelector('img').src = maximized ? './icons/panels-top-left.svg' : './icons/square.svg'
  } catch (error) {
    if (dialog.open) settingsStatus.textContent = String(error)
    notice.textContent = String(error)
    notice.hidden = false
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice.hidden = true }, 6000)
  }
}

settings.addEventListener('click', async () => {
  settings.disabled = true
  try {
    await window.__TAURI__.core.invoke('shell_action', { action: 'settings-open' })
    dialog.showModal()
    settingsStatus.textContent = ''
    await refreshSettingsInfo()
    void checkClientUpdate()
  } catch (error) {
    settingsStatus.textContent = String(error)
    if (!dialog.open) await act('settings-close')
  } finally {
    settings.disabled = false
  }
})
document.querySelector('#settings-close').addEventListener('click', () => dialog.close())
dialog.addEventListener('close', () => { void act('settings-close'); settings.focus() })
dialog.addEventListener('click', event => {
  const button = event.target.closest('[data-setting-action]')
  if (!button) return
  if (button.dataset.settingAction === 'core-update') {
    void checkCoreUpdate()
    return
  }
  if (button.dataset.settingAction === 'client-releases') {
    void checkClientUpdate()
    return
  }
  if (button.dataset.settingAction === 'client-download') {
    void downloadClientUpdate()
    return
  }
  if (button.dataset.settingAction === 'client-cancel') {
    void cancelClientUpdate()
    return
  }
  if (button.dataset.settingAction === 'client-install') {
    void installClientUpdate()
    return
  }
  void act(button.dataset.settingAction)
})
header.addEventListener('click', event => {
  const button = event.target.closest('[data-action]')
  if (!button) return
  void act(button.dataset.action)
})
document.querySelector('#drag-region').addEventListener('mousedown', event => {
  if (event.button !== 0) return
  void act(event.detail === 2 ? 'maximize' : 'drag')
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && dialog.open) {
    event.preventDefault()
    event.stopImmediatePropagation()
    dialog.close()
  }
}, true)
window.addEventListener('resize', () => void act('state'))
void act('state')
