// Applied only to the desktop client's Node processes, including Node descendants.
// Preserve stdio/PTY behavior while hiding incidental Windows console windows.
if (process.platform === 'win32') {
  const cp = require('node:child_process')
  const { promisify } = require('node:util')
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const original = cp[name]
    function hiddenArgs(args) {
      const hasArgv = !['exec', 'execSync'].includes(name)
      const index = hasArgv && (Array.isArray(args[1]) || (args[1] == null && args.length > 2)) ? 2 : 1
      const options = args[index]
      if (options && typeof options === 'object') {
        args[index] = { ...options, windowsHide: true }
      } else if (options == null) {
        args[index] = { windowsHide: true }
      } else {
        args.splice(index, 0, { windowsHide: true })
      }
      return args
    }
    function hiddenConsole(...args) {
      return Reflect.apply(original, this, hiddenArgs(args))
    }
    // Keep Node's custom promisify adapters and other public function properties.
    for (const key of Reflect.ownKeys(original)) {
      if (!['name', 'length', 'prototype', 'arguments', 'caller'].includes(key)) {
        const descriptor = Object.getOwnPropertyDescriptor(original, key)
        if (key === promisify.custom) {
          descriptor.value = function (...args) {
            return Reflect.apply(original[key], this, hiddenArgs(args))
          }
        }
        Object.defineProperty(hiddenConsole, key, descriptor)
      }
    }
    cp[name] = hiddenConsole
  }
  require('node:module').syncBuiltinESMExports()
}
