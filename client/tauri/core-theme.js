// Injected by the host after a local core page loads. No privileged IPC is exposed.
(() => {
  if (window !== window.top || window.__dshLauncherThemeObserver) return
  window.__dshLauncherThemeObserver = true
  let previous = ''
  let scheduled = false
  const colors = {
    background: '--dsw-alias-bg-base',
    foreground: '--dsw-alias-label-primary',
    border: '--dsw-alias-border-l1',
    hover: '--dsw-alias-interactive-bg-hover',
  }
  function publish() {
    scheduled = false
    const body = document.body
    if (!body) return
    const style = getComputedStyle(body)
    const theme = {
      origin: location.origin,
      scheme: body.hasAttribute('data-ds-dark-theme') || document.documentElement.style.colorScheme === 'dark' ? 'dark' : 'light',
    }
    for (const [key, variable] of Object.entries(colors)) {
      const value = style.getPropertyValue(variable).trim()
      if (value && value.length <= 128 && CSS.supports('color', value)) theme[key] = value
    }
    const payload = JSON.stringify(theme)
    if (payload === previous) return
    previous = payload
    // The host intercepts and cancels this notification before any navigation occurs.
    location.href = `dsh-launcher-theme://changed/?payload=${encodeURIComponent(payload)}`
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(publish)
  }
  const observer = new MutationObserver(schedule)
  const options = { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style', 'class'] }
  observer.observe(document.documentElement, options)
  observer.observe(document.body, options)
  // Theme overrides and lazily loaded styles can arrive after the page load event.
  if (document.head) observer.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true })
  document.addEventListener('load', schedule, true)
  window.addEventListener('pageshow', schedule)
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule)
  schedule()
})()
