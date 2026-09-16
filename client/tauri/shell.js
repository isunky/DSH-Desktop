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
