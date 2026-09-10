import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM = join(ROOT, 'upstream')
const CLIENT = join(ROOT, 'client')
const BUILD_ROOT = join(ROOT, '.client-build')
const ARTIFACTS_ROOT = join(ROOT, 'artifacts')
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'

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

function validateTarget(target) {
  if (target === 'win-x64') {
    if (process.platform !== 'win32' || process.arch !== 'x64') fail('win-x64 must be built on a Windows x64 host')
    return
  }
  if (target === 'mac-arm64') {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('mac-arm64 must be built on an Apple Silicon macOS host')
    return
  }
  if (target === 'mac-x64') {
    if (process.platform !== 'darwin' || process.arch !== 'x64') fail('mac-x64 must be built on an Intel macOS host')
    return
  }
  fail(`unsupported target '${target}'`)
}

async function packageClient(target, directory = false) {
  validateTarget(target)
  await mkdir(BUILD_ROOT, { recursive: true })
  const outputDirectory = join(ARTIFACTS_ROOT, directory ? 'dir' : target)
  await rm(outputDirectory, { recursive: true, force: true })
  await mkdir(outputDirectory, { recursive: true })

  const builderArgs = ['tauri', 'build']
  if (directory) builderArgs.push('--no-bundle')
  else builderArgs.push('--bundles', target === 'win-x64' ? 'nsis' : 'dmg')
  await run('cargo', builderArgs)

  const releaseRoot = join(ROOT, 'src-tauri', 'target', 'release')
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const version = packageJson.version
  const executableName = process.platform === 'win32' ? 'deepseek-harness.exe' : 'deepseek-harness'
  if (directory) {
    const binary = join(releaseRoot, executableName)
    await cp(binary, join(outputDirectory, executableName))
    const resources = join(releaseRoot, 'client')
    await cp(resources, join(outputDirectory, 'client'), { recursive: true })
  } else {
    const bundleDirectory = join(releaseRoot, 'bundle', target === 'win-x64' ? 'nsis' : 'dmg')
    const extension = target === 'win-x64' ? '.exe' : '.dmg'
    const candidates = (await readdir(bundleDirectory)).filter(name => name.endsWith(extension))
    if (candidates.length === 0) fail(`Tauri did not produce a ${extension} installer in ${bundleDirectory}`)
    const source = join(bundleDirectory, candidates[0])
    const name = target === 'win-x64'
      ? `DeepSeek-Harness-${version}-win-x64.exe`
      : `DeepSeek-Harness-${version}-${target}.dmg`
    await cp(source, join(outputDirectory, name))
  }
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
  for (const path of ['src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'client/tauri/index.html']) {
    try { await readFile(join(ROOT, path)) } catch { fail(`missing Tauri client file: ${path}`) }
  }
  console.log(`client: upstream ${commit.slice(0, 12)} is clean`)
  console.log(`client: upstream dsh ${upstreamManifest.version}; official core channel ${channel.packageName}@${channel.distTag}`)
  console.log(`client: source ${UPSTREAM_URL}`)
  console.log('client: Tauri shell uses an on-demand Node.js runtime and on-demand DSH core')
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
      await run('cargo', ['tauri', 'dev'])
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
