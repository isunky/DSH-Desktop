const stage = document.querySelector('#stage')
const detail = document.querySelector('#detail')
const bar = document.querySelector('#bar')
const elapsed = document.querySelector('#elapsed')
const cancel = document.querySelector('#cancel')
let startedAt = Date.now()
let startupFailed = false
let controlsReady = false
let invokeApi

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

async function start() {
  startedAt = Date.now()
  cancel.disabled = false
  cancel.textContent = '取消启动并退出'
  const tauri = window.__TAURI__
  if (!tauri) {
    document.body.classList.add('error')
    setState({ stage: '客户端配置错误', detail: 'Tauri API 未加载，无法启动客户端。', progress: null })
    cancel.textContent = '退出'
    return
  }

  invokeApi = tauri.core.invoke

  if (!controlsReady) {
    controlsReady = true
    await tauri.event.listen('startup-state', event => setState(event.payload))
    cancel.addEventListener('click', async () => {
    if (startupFailed) {
      startupFailed = false
      cancel.disabled = true
      cancel.textContent = '正在自动修复…'
      document.body.classList.remove('error')
      setState({ stage: '正在自动修复', detail: '正在清理上一次失败的任务，并切换备用运行时重试…', progress: null })
      await invokeApi('reset_startup').catch(error => {
        document.body.classList.add('error')
        startupFailed = true
        cancel.disabled = false
        cancel.textContent = '自动修复并重试'
        detail.textContent = String(error)
      })
      if (!startupFailed) void start()
      return
    }
    cancel.disabled = true
    cancel.textContent = '正在退出…'
    setState({ stage: '正在退出', detail: '正在停止 Node.js、安装任务和本地 DSH 服务，请稍候…', progress: null })
    await invokeApi('cancel_startup').catch(error => {
      document.body.classList.add('error')
      cancel.disabled = false
      cancel.textContent = '退出'
      detail.textContent = String(error)
    })
    })

    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') cancel.click()
    })
  }

  try {
    const url = await invokeApi('start_client')
    await invokeApi('navigate_to_core', { url })
    document.body.classList.add('core-ready')
  } catch (error) {
    if (String(error).includes('启动已取消')) return
    document.body.classList.add('error')
    startupFailed = true
    cancel.disabled = false
    cancel.textContent = '自动修复并重试'
    setState({
      stage: '启动失败',
      detail: `${String(error)}\n\n可点击“自动修复并重试”，或使用窗口右上角关闭按钮退出。`,
      progress: 0,
    })
  }
}

void start()
