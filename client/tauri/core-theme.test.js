import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const script = readFileSync(new URL('./core-theme.js', import.meta.url), 'utf8')

test('shell follows core colors and clears stale overrides on fallback', () => {
  const properties = new Map()
  const root = { dataset: {}, style: {
    setProperty: (key, value) => properties.set(key, value),
    removeProperty: key => properties.delete(key),
  } }
  const shell = readFileSync(new URL('./shell.js', import.meta.url), 'utf8').split("const header =")[0]
  const context = { document: { documentElement: root }, window: {}, CSS: { supports: () => true } }
  runInNewContext(shell, context)
  runInNewContext("receiveCoreTheme({ scheme: 'dark', background: '#181818' })", context)
  assert.equal(root.dataset.shellTheme, 'dark')
  assert.equal(properties.get('--shell-header-bg'), '#181818')
  runInNewContext("receiveCoreTheme({ scheme: 'light', background: 'var(--missing)' })", context)
  assert.equal(root.dataset.shellTheme, 'light')
  assert.equal(properties.has('--shell-header-bg'), false)
  runInNewContext("receiveCoreTheme({ scheme: 'invalid' })", context)
  assert.equal(root.dataset.shellTheme, 'light')
})

test('core theme emits initial state, coalesces changes, and never polls', () => {
  let dark = false
  let mutate
  let colors = { '--dsw-alias-bg-base': '#fff' }
  const frames = []
  const messages = []
  const window = { addEventListener() {} }
  window.top = window
  const document = {
    documentElement: { style: { colorScheme: 'light' } },
    body: { hasAttribute: () => dark },
    head: {},
    addEventListener() {},
  }
  const context = {
    window, document,
    location: { origin: 'http://127.0.0.1:3456', set href(value) {
      messages.push(JSON.parse(new URL(value).searchParams.get('payload')))
    } },
    getComputedStyle: () => ({ getPropertyValue: key => colors[key] || '' }),
    CSS: { supports: () => true },
    MutationObserver: class { constructor(callback) { mutate = callback } observe() {} },
    requestAnimationFrame: callback => frames.push(callback),
    matchMedia: () => ({ addEventListener() {} }),
  }
  const flush = () => { while (frames.length) frames.shift()() }
  runInNewContext(script, context)
  flush()
  assert.equal(messages.length, 1)
  assert.equal(messages[0].scheme, 'light')
  assert.equal(messages[0].background, '#fff')
  mutate(); mutate(); flush()
  assert.equal(messages.length, 1)
  dark = true
  colors = { '--dsw-alias-bg-base': '#181818' }
  mutate(); mutate()
  assert.equal(frames.length, 1)
  flush()
  assert.equal(messages[1].scheme, 'dark')
  assert.equal(messages[1].background, '#181818')
  colors = {}
  mutate(); flush()
  assert.equal(messages[2].background, undefined)
  runInNewContext(script, context)
  assert.equal(frames.length, 0, 're-injection does not create another observer')
})
