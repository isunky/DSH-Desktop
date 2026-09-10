import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = join(ROOT, 'upstream')
const CLIENT = join(ROOT, 'client')
const BUILD_ROOT = join(ROOT, '.client-build')
const ARTIFACTS_ROOT = join(ROOT, 'artifacts')
const UPSTREAM_URL = 'https://github.com/isunky/deepseek-harness.git'
const NODE_VERSION = '22.19.0'

const TARGETS = {
  'win-x64': { platform: 'win32', nodePlatform: 'win', nodeArch: 'x64', archiveExt: 'zip' },
  'mac-arm64': { platform: 'darwin', nodePlatform: 'darwin', nodeArch: 'arm64', archiveExt: 'tar.gz' },
  'mac-x64': { platform: 'darwin', nodePlatform: 'darwin', nodeArch: 'x64', archiveExt: 'tar.gz' },
}

function executable(name) {
  return process.platform === 'win32' && name === 'corepack' ? 'corepack.cmd' : name
}

function fail(message) {
  throw new Error(`client: ${message}`)
}

async function run(command, args, options = {}) {
  const { cwd = ROOT, env = process.env, capture = false } = options
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32' && command.endsWith('.cmd'),
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('close', (code, signal) => {
      const result = { code: code ?? 1, signal, stdout, stderr }
      if (result.code !== 0) {
        const detail = capture ? `\n${stderr.trim() || stdout.trim()}` : ''
        reject(new Error(`command failed (${result.code}): ${command} ${args.join(' ')}${detail}`))
      } else resolvePromise(result)
    })
  })
}

async function capture(command, args, cwd = ROOT) {
  return (await run(command, args, { cwd, capture: true })).stdout.trim()
}

async function ensureUpstream() {
  try {
    await readFile(join(UPSTREAM, 'package.json'))
  } catch {
    fail(`upstream checkout is missing: ${UPSTREAM}`)
  }
  const status = await capture(executable('git'), ['status', '--porcelain'], UPSTREAM)
  if (status !== '') fail('upstream has local changes; keep the submodule clean before checking or updating')
  return await capture(executable('git'), ['rev-parse', 'HEAD'], UPSTREAM)
}

async function readChannel() {
  return JSON.parse(await readFile(join(CLIENT, 'core-channel.json'), 'utf8'))
}

function hostTarget() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'mac-x64'
  fail('only Windows x64 and macOS x64/arm64 are supported')
}

async function runElectron(args, env = process.env) {
  await ensureElectron()
  const electron = process.platform === 'win32'
    ? join(ROOT, 'node_modules', '.bin', 'electron.cmd')
    : join(ROOT, 'node_modules', '.bin', 'electron')
  await run(electron, [join(ROOT, 'client', 'electron', 'main.mjs'), ...args], {
    env: { ...env, DSH_CLIENT_NODE_BINARY: process.execPath },
  })
}

async function ensureElectron() {
  const electronRoot = join(ROOT, 'node_modules', 'electron')
  try {
    await readFile(join(electronRoot, 'dist', 'version'))
    return
  } catch {
    console.log('client: Electron binary is not present; downloading the pinned Electron runtime')
  }
  await run(process.execPath, [join(electronRoot, 'install.js')], { cwd: electronRoot })
}

async function ensureNodeRuntime(target) {
  const targetConfig = TARGETS[target]
  const runtimeRoot = join(BUILD_ROOT, 'node-runtime', target)
  const nodeBinary = targetConfig.platform === 'win32' ? join(runtimeRoot, 'node.exe') : join(runtimeRoot, 'bin', 'node')
  try {
    await readFile(nodeBinary)
    await ensureNodeNpm(runtimeRoot)
    return runtimeRoot
  } catch {
    // Download and extract only when the target cache is absent.
  }
  const archiveName = `node-v${NODE_VERSION}-${targetConfig.nodePlatform}-${targetConfig.nodeArch}.${targetConfig.archiveExt}`
  const archivePath = join(BUILD_ROOT, 'downloads', archiveName)
  await mkdir(join(BUILD_ROOT, 'downloads'), { recursive: true })
  try {
    await readFile(archivePath)
  } catch {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`
    console.log(`client: downloading Node.js ${NODE_VERSION} for ${target} from ${url}`)
    const response = await fetch(url)
    if (!response.ok) fail(`Node.js runtime download failed with HTTP ${response.status}`)
    await writeFile(archivePath, Buffer.from(await response.arrayBuffer()))
  }
  const extractRoot = join(BUILD_ROOT, 'node-runtime', `.extract-${target}`)
  await rm(extractRoot, { recursive: true, force: true })
  await mkdir(extractRoot, { recursive: true })
  const tarArgs = targetConfig.archiveExt === 'zip'
    ? ['-xf', archivePath, '-C', extractRoot]
    : ['-xzf', archivePath, '-C', extractRoot]
  await run('tar', tarArgs)
  const extractedRoot = join(extractRoot, `node-v${NODE_VERSION}-${targetConfig.nodePlatform}-${targetConfig.nodeArch}`)
  await rm(runtimeRoot, { recursive: true, force: true })
  await mkdir(dirname(runtimeRoot), { recursive: true })
  await cp(extractedRoot, runtimeRoot, { recursive: true })
  await rm(extractRoot, { recursive: true, force: true })
  await ensureNodeNpm(runtimeRoot)
  return runtimeRoot
}

async function ensureNodeNpm(runtimeRoot) {
  const npmSource = join(runtimeRoot, 'node_modules', 'npm')
  const npmTarget = join(runtimeRoot, 'npm-dist')
  try {
    await readFile(join(npmTarget, 'bin', 'npm-cli.js'))
    return
  } catch {
    await cp(npmSource, npmTarget, { recursive: true })
  }
}

async function packageClient(target, directory = false) {
  const targetConfig = TARGETS[target]
  if (targetConfig === undefined) fail(`unsupported target '${target}'`)
  if (process.platform !== targetConfig.platform) {
    fail(`${target} must be built on a ${targetConfig.platform === 'win32' ? 'Windows x64' : 'macOS'} host`)
  }
  if (target === 'win-x64' && process.arch !== 'x64') fail('win-x64 requires a Windows x64 host')
  if (target === 'mac-arm64' && process.arch !== 'arm64') fail('mac-arm64 requires an Apple Silicon host')

  await mkdir(BUILD_ROOT, { recursive: true })
  await ensureElectron()
  const nodeRuntime = await ensureNodeRuntime(target)
  const outputDirectory = join(ARTIFACTS_ROOT, target)
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })
  const env = {
    ...process.env,
    DSH_CLIENT_TARGET: target,
    DSH_CLIENT_OUTPUT_DIR: outputDirectory,
    DSH_CLIENT_NODE_RUNTIME: nodeRuntime,
  }
  const builderArgs = [
    'exec', 'electron-builder',
    '--config', join(CLIENT, 'electron-builder.config.mjs'),
    '--publish', 'never',
  ]
  if (directory) builderArgs.push('--dir')
  else builderArgs.push(target.startsWith('mac-') ? '--mac' : '--win', target === 'mac-arm64' ? '--arm64' : '--x64')
  await run(executable('corepack'), ['pnpm', ...builderArgs], { env })
  console.log(`client: artifacts written to ${outputDirectory}`)
}

async function updateUpstream() {
  const before = await ensureUpstream()
  await run(executable('git'), ['fetch', '--prune', 'origin', 'master'], { cwd: UPSTREAM })
  const after = await capture(executable('git'), ['rev-parse', 'origin/master'], UPSTREAM)
  if (before === after) {
    console.log(`client: upstream already points to ${before.slice(0, 12)}`)
    return
  }
  await run(executable('git'), ['checkout', '--detach', 'origin/master'], { cwd: UPSTREAM })
  console.log(`client: upstream moved ${before.slice(0, 12)} -> ${after.slice(0, 12)}`)
  console.log('client: review the submodule change, run client:check, then commit the gitlink in the client repository')
}

async function check() {
  const commit = await ensureUpstream()
  const upstreamManifest = JSON.parse(await readFile(join(UPSTREAM, 'package.json'), 'utf8'))
  const channel = await readChannel()
  if (channel.packageName !== '@deepseek-ai/dsh') fail('client/core-channel.json must point to @deepseek-ai/dsh')
  if (!channel.registry.startsWith('https://')) fail('core registry must use HTTPS')
  console.log(`client: upstream ${commit.slice(0, 12)} is clean`)
  console.log(`client: upstream dsh ${upstreamManifest.version}; official core channel ${channel.packageName}@${channel.distTag}`)
  console.log(`client: source ${UPSTREAM_URL}`)
}

async function coreCommand(command) {
  await run(process.execPath, [join(CLIENT, 'runtime', 'core-manager.mjs'), command], {
    env: { ...process.env, DSH_CLIENT_ROOT: ROOT },
  })
}

async function clean() {
  await rm(BUILD_ROOT, { recursive: true, force: true })
  await rm(ARTIFACTS_ROOT, { recursive: true, force: true })
  console.log('client: removed generated build and artifact directories')
}

async function main() {
  const [command, value] = process.argv.slice(2)
  switch (command) {
    case 'dev':
      await runElectron([])
      return
    case 'package':
      await packageClient(value === 'dir' ? hostTarget() : value, value === 'dir')
      return
    case 'core:check':
      await coreCommand('check')
      return
    case 'core:install':
      await coreCommand('install')
      return
    case 'check':
      await check()
      return
    case 'update-upstream':
      await updateUpstream()
      return
    case 'clean':
      await clean()
      return
    default:
      fail('usage: node scripts/client.mjs <dev|core:check|core:install|check|update-upstream|clean|package> [target]')
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
