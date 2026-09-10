const header = document.querySelector('#shell-header')
const more = document.querySelector('#shell-more')
const extra = document.querySelector('#shell-extra')
const maximize = header.querySelector('[data-action="maximize"]')
const notice = document.querySelector('#shell-notice')
let noticeTimer

function collapse() {
  extra.hidden = true
  more.setAttribute('aria-expanded', 'false')
}

async function act(action) {
  try {
    if (!window.__TAURI__) return
    const maximized = await window.__TAURI__.core.invoke('shell_action', { action })
    maximize.title = maximize.ariaLabel = maximized ? '还原' : '最大化'
    maximize.setAttribute('aria-pressed', String(maximized))
    maximize.querySelector('img').src = maximized ? './icons/panels-top-left.svg' : './icons/square.svg'
  } catch (error) {
    notice.textContent = String(error)
    notice.hidden = false
    clearTimeout(noticeTimer)
    noticeTimer = setTimeout(() => { notice.hidden = true }, 6000)
  }
}

more.addEventListener('click', () => {
  extra.hidden = !extra.hidden
  more.setAttribute('aria-expanded', String(!extra.hidden))
})
header.addEventListener('click', event => {
  const button = event.target.closest('[data-action]')
  if (!button) return
  collapse()
  void act(button.dataset.action)
})
document.querySelector('#drag-region').addEventListener('mousedown', event => {
  if (event.button !== 0) return
  collapse()
  void act(event.detail === 2 ? 'maximize' : 'drag')
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !extra.hidden) {
    event.stopImmediatePropagation()
    collapse()
    more.focus()
  }
}, true)
window.addEventListener('blur', collapse)
window.addEventListener('resize', () => void act('state'))
void act('state')
