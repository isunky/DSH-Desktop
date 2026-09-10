const { contextBridge, ipcRenderer } = require('electron')

// Explicitly publish a non-draggable region after leaving the loading document.
// Chromium's default `none` does not necessarily clear the previous native region.
if (location.protocol !== 'file:') {
  window.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style')
    style.textContent = 'html, body { -webkit-app-region: no-drag !important; }'
    document.head.append(style)
    const controls = document.createElement('div')
    controls.id = 'dsh-client-window-controls'
    const shadow = controls.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>
      :host { position:fixed; top:10px; right:12px; z-index:2147483647; -webkit-app-region:no-drag;
        color-scheme:light dark; color:light-dark(#273244,#e5eaf2); font:13px system-ui,sans-serif; }
      * { box-sizing:border-box; } button { font:inherit; color:inherit; cursor:pointer; -webkit-app-region:no-drag; }
      nav { display:flex; align-items:center; padding:4px; border:1px solid light-dark(#d6dce8aa,#ffffff1c);
        border-radius:15px; background:light-dark(#fffffff0,#24272ddd); backdrop-filter:blur(18px);
        box-shadow:0 4px 18px #00000014; opacity:.72; transition:opacity .2s,box-shadow .2s; }
      nav:hover,nav:focus-within { opacity:1; box-shadow:0 6px 24px #0002; }
      .tray { display:flex; align-items:center; max-width:0; opacity:0; overflow:hidden;
        visibility:hidden; transition:max-width .24s ease,opacity .18s,visibility .24s; }
      nav:hover .tray,nav:focus-within .tray,nav.expanded .tray { max-width:200px; opacity:1; visibility:visible; }
      .icon { display:grid; place-items:center; flex-shrink:0; width:30px; height:30px; padding:0;
        border:0; border-radius:10px; background:transparent; transition:background .15s,color .15s; }
      .icon:hover { background:light-dark(#e9edf5,#ffffff12); }
      button:focus-visible { outline:2px solid #6d9ded; outline-offset:1px; }
      .icon.close:hover { background:#df414d; color:white; }
      svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
      .handle { width:16px; height:26px; display:grid; place-items:center; opacity:.4; -webkit-app-region:drag; }
      dialog { width:min(480px,calc(100vw - 48px)); padding:28px; border:1px solid light-dark(#dce1e9,#ffffff20);
        border-radius:22px; background:light-dark(#fafbfe,#1b1e24); color:inherit; box-shadow:0 30px 90px #0006;
        -webkit-app-region:no-drag; }
      dialog::backdrop { background:#05091288; backdrop-filter:blur(6px); }
      header { display:flex; align-items:center; justify-content:space-between; }
      .eyebrow { margin:0 0 8px; color:#7897ca; font-size:10px; letter-spacing:.15em; }
      h1 { margin:0; font-size:22px; font-weight:650; letter-spacing:-.5px; }
      .intro { color:light-dark(#657186,#9ca7b8); line-height:1.7; margin:12px 0 24px; }
      .card { display:flex; gap:12px; justify-content:space-between; align-items:center; padding:16px;
        margin:10px 0; border:1px solid light-dark(#e1e6ef,#ffffff10); border-radius:14px;
        background:light-dark(#fff,#ffffff04); }
      .name { font-weight:600; } .version { margin-top:5px; color:light-dark(#748095,#99a6b9); font-size:12px; }
      .action { border:1px solid light-dark(#dbe3f0,#ffffff20); background:light-dark(#f2f6ff,#ffffff08);
        padding:8px 12px; border-radius:9px; white-space:nowrap; font-size:12px; }
      .action:hover { border-color:#779cdb; } .action:disabled { opacity:.5; cursor:wait; }
      #status { min-height:38px; margin:14px 0; line-height:1.65; color:light-dark(#52647f,#aebdd2); font-size:12px; }
      footer { border-top:1px solid light-dark(#e1e6ef,#ffffff10); padding-top:16px; font-size:12px; }
      footer p { margin:6px 0; color:light-dark(#748095,#99a6b9); }
      .links { display:flex; gap:16px; margin-top:12px; }
      .link { padding:0; border:0; background:none; color:light-dark(#4874b9,#9ebdec); font-size:12px; }
      @media(prefers-reduced-motion:reduce) { *,*::before,*::after { transition:none!important; } }
    </style><nav aria-label="客户端与窗口控制">
      <button class="icon reveal" title="展开窗口控制" aria-label="展开窗口控制" aria-expanded="false">
        <svg viewBox="0 0 24 24"><path d="M6 8h12M6 12h12M6 16h12"/></svg>
      </button><div class="tray"><span class="handle" title="拖动窗口">⋮</span></div>
    </nav>
    <dialog aria-labelledby="about-title">
      <header><div><p class="eyebrow">DESKTOP COMPANION</p><h1 id="about-title">关于 DeepSeek Harness</h1></div>
        <button class="icon" id="dismiss" aria-label="关闭关于">×</button></header>
      <p class="intro" id="description"></p>
      <section class="card"><div><div class="name">DSH 核心</div><div class="version" id="core-version">读取版本…</div></div>
        <button class="action" data-about="core-update">检查核心更新</button></section>
      <section class="card"><div><div class="name">桌面客户端</div><div class="version" id="client-version">读取版本…</div></div>
        <button class="action" data-about="client-update">检查客户端更新</button></section>
      <p id="status" role="status" aria-live="polite">核心与客户端独立更新。</p>
      <footer><div id="developer"></div><p id="platform"></p><div class="links">
        <button class="link" data-about="upstream">上游开源项目 ↗</button>
        <button class="link" id="homepage" data-about="homepage">开发者主页 ↗</button>
      </div></footer>
    </dialog>`
    const nav = shadow.querySelector('nav')
    const tray = shadow.querySelector('.tray')
    const reveal = shadow.querySelector('.reveal')
    const about = shadow.querySelector('dialog')
    reveal.addEventListener('click', () => {
      reveal.setAttribute('aria-expanded', String(nav.classList.toggle('expanded')))
    })
    nav.addEventListener('mouseleave', () => { nav.classList.remove('expanded'); reveal.setAttribute('aria-expanded', 'false') })
    shadow.querySelector('#dismiss').addEventListener('click', () => about.close())
    async function showAbout() {
      about.showModal()
      try {
        const info = await ipcRenderer.invoke('client:about', 'info')
        shadow.querySelector('#description').textContent = info.description
        shadow.querySelector('#core-version').textContent = `v${info.coreVersion} · 官方渠道`
        shadow.querySelector('#client-version').textContent = `v${info.clientVersion}`
        shadow.querySelector('#developer').textContent = `客户端开发者 · ${info.developer}`
        shadow.querySelector('#platform').textContent = `运行平台 · ${info.platform}`
        shadow.querySelector('#homepage').hidden = !info.homepage
        shadow.querySelector('#status').textContent = info.clientReleasesUrl
          ? '核心更新后重启本地服务；客户端更新通过独立发布页面获取。'
          : '核心可独立更新。客户端在线发布渠道尚未配置。'
      } catch (error) { shadow.querySelector('#status').textContent = error.message }
    }
    for (const button of shadow.querySelectorAll('[data-about]')) {
      button.addEventListener('click', async () => {
        button.disabled = true
        shadow.querySelector('#status').textContent = button.dataset.about === 'core-update'
          ? '正在检查核心版本；如有更新，安装期间请稍候…' : '正在读取发布渠道…'
        try { shadow.querySelector('#status').textContent = await ipcRenderer.invoke('client:about', button.dataset.about) }
        catch (error) { shadow.querySelector('#status').textContent = error.message }
        finally { button.disabled = false }
      })
    }
    for (const [action, label, path] of [
      ['about', '关于与更新', '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>'],
      ['minimize', '最小化', '<path d="M5 12h14"/>'],
      ['maximize', '最大化 / 还原', '<rect x="5" y="5" width="14" height="14" rx="2"/>'],
      ['fullscreen', '进入 / 退出全屏', '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>'],
      ['close', '退出客户端', '<path d="m6 6 12 12M6 18 18 6"/>'],
    ]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.title = label
      button.setAttribute('aria-label', label)
      button.className = `icon ${action}`
      button.innerHTML = `<svg viewBox="0 0 24 24">${path}</svg>`
      button.addEventListener('click', () => action === 'about' ? void showAbout() : ipcRenderer.send('client:window-action', action))
      tray.append(button)
    }
    document.documentElement.append(controls)
  }, { once: true })
}

contextBridge.exposeInMainWorld('dshClient', {
  cancelStartup() {
    ipcRenderer.send('client:cancel-startup')
  },
})
