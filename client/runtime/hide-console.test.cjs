const { test } = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const { promisify } = require('node:util')

const source = fs.readFileSync(require.resolve('./hide-console.cjs'), 'utf8')
function setup(platform = 'win32') {
  const cp = {}
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[name] = (...args) => args
    cp[name][promisify.custom] = (...args) => args
  }
  vm.runInNewContext(source, {
    process: { platform },
    require: name => name === 'node:child_process' ? cp : name === 'node:util' ? { promisify } : { syncBuiltinESMExports() {} },
  })
  return cp
}

test('all process APIs hide consoles without mutating options', () => {
  const cp = setup()
  for (const name of Object.keys(cp)) {
    const options = { windowsHide: false, stdio: 'pipe' }
    const args = ['exec', 'execSync'].includes(name) ? ['cmd', options] : ['cmd', ['arg'], options]
    for (const fn of [cp[name], cp[name][promisify.custom]]) {
      const result = fn(...args)
      assert.equal(result.at(-1).windowsHide, true, name)
      assert.equal(result.at(-1).stdio, 'pipe')
      assert.equal(options.windowsHide, false)
    }
  }
})

test('optional argv, callback and omitted options are preserved', () => {
  const cp = setup()
  const cb = () => {}
  for (const input of [['cmd'], ['cmd', cb], ['cmd', [], cb], ['cmd', undefined, {}, cb]]) {
    const result = cp.execFile(...input)
    assert.equal(result.find(value => value?.windowsHide)?.windowsHide, true)
    if (input.includes(cb)) assert.equal(result.at(-1), cb)
  }
})

test('other platforms remain unchanged', () => {
  assert.equal(setup('darwin').spawn('cmd').length, 1)
})
