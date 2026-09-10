const stage = document.querySelector('#stage')
const detail = document.querySelector('#detail')
const bar = document.querySelector('#bar')
const elapsed = document.querySelector('#elapsed')
const cancel = document.querySelector('#cancel')
const startedAt = Date.now()

function setState({ stage: nextStage, detail: nextDetail, progress }) {
  if (nextStage) stage.textContent = nextStage
  if (nextDetail) detail.textContent = nextDetail
  if (typeof progress === 'number') {
    bar.classList.remove('indeterminate')
    bar.style.width = `${Math.max(3, Math.min(100, progress))}%`
  } else {
    bar.classList.add('indeterminate')
  }
}

setInterval(() => {
  elapsed.textContent = `已用时 ${Math.floor((Date.now() - startedAt) / 1000)} 秒`
}, 1000)

async function main() {
  const tauri = window.__TAURI__
  if (!tauri) {
    document.body.classList.add('error')
    setState({ stage: '客户端配置错误', detail: 'Tauri API 未加载，无法启动客户端。', progress: null })
    cancel.textContent = '退出'
    return
  }

  const { invoke } = tauri.core
  await tauri.event.listen('startup-state', event => setState(event.payload))

  cancel.addEventListener('click', async () => {
    cancel.disabled = true
    cancel.textContent = '正在退出…'
    setState({ stage: '正在退出', detail: '正在停止 Node.js、安装任务和本地 DSH 服务，请稍候…', progress: null })
    await invoke('cancel_startup').catch(error => {
      document.body.classList.add('error')
      cancel.disabled = false
      cancel.textContent = '退出'
      detail.textContent = String(error)
    })
  })

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') cancel.click()
  })

  try {
    const url = await invoke('start_client')
    await invoke('navigate_to_core', { url })
  } catch (error) {
    if (String(error).includes('启动已取消')) return
    document.body.classList.add('error')
    cancel.disabled = false
    cancel.textContent = '退出'
    setState({
      stage: '启动失败',
      detail: `${String(error)}\n\n可以点击“退出”后重试。`,
      progress: null,
    })
  }
}

void main()
