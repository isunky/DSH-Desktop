// The CLI exchanges its launch token for a browser cookie via a 303 redirect.
// Node fetch does not retain that cookie when automatically following redirects.
export async function probeWeb(url) {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(3000),
  })
  const authenticatedRedirect = response.status === 303
    && response.headers.get('location') === '/'
    && Boolean(response.headers.get('set-cookie'))
  await response.body?.cancel()
  return { ready: response.ok || authenticatedRedirect, status: response.status }
}

export function redactTokens(text) {
  return text.replace(/([?&]token=)[^\s]+/gu, '$1[REDACTED]')
}
