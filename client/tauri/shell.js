const header = document.querySelector('#shell-header')
const settings = document.querySelector('#shell-settings')
const dialog = document.querySelector('#settings-dialog')
const settingsStatus = document.querySelector('#settings-status')
const maximize = header.querySelector('[data-action="maximize"]')
const notice = document.querySelector('#shell-notice')
let noticeTimer

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
    const info = await window.__TAURI__.core.invoke('settings_info')
    document.querySelector('#settings-core-version').textContent = info.core
    document.querySelector('#settings-client-version').textContent = `v${info.client}`
    document.querySelector('#settings-runtime').textContent = info.runtime
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
  if (button.dataset.settingAction === 'core-update') settingsStatus.textContent = '正在检查核心更新…'
  void act(button.dataset.settingAction)
})
if (window.__TAURI__) void window.__TAURI__.event.listen('core-update-result', event => {
  settingsStatus.textContent = event.payload
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
