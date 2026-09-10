import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { probeWeb, redactTokens } from '../client/electron/web-readiness.mjs'

test('token exchange is ready even though automatic redirects lose the cookie', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/?token=valid') {
      res.writeHead(303, { location: '/', 'set-cookie': 'session=valid; HttpOnly; SameSite=Strict' })
    } else if (req.headers.cookie === 'session=valid') {
      res.writeHead(200)
    } else if (req.url === '/?token=missing-cookie') {
      res.writeHead(303, { location: '/' })
    } else {
      res.writeHead(401)
    }
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.equal((await fetch(`${base}/?token=valid`)).status, 401)
    assert.deepEqual(await probeWeb(`${base}/?token=valid`), { ready: true, status: 303 })
    assert.equal((await probeWeb(base)).ready, false)
    assert.equal((await probeWeb(`${base}/?token=bad`)).ready, false)
    assert.equal((await probeWeb(`${base}/?token=missing-cookie`)).ready, false)
    const exchange = await fetch(`${base}/?token=valid`, { redirect: 'manual' })
    const cookie = exchange.headers.get('set-cookie').split(';')[0]
    assert.equal((await fetch(base, { headers: { cookie } })).status, 200)
    assert.equal(redactTokens(`${base}/?token=secret`), `${base}/?token=[REDACTED]`)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})
