import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT = resolve(process.env.DSH_CLIENT_ROOT ?? process.cwd())
const CHANNEL_PATH = join(ROOT, 'client', 'core-channel.json')
const PNPM_VERSION = '11.7.0'

function fail(message) {
  throw new Error(`core: ${message}`)
}

async function channel() {
  return JSON.parse(await readFile(CHANNEL_PATH, 'utf8'))
}

function runtimeRoot() {
  const configured = process.env.DSH_CLIENT_CORE_ROOT
  if (configured) return resolve(configured)
  if (process.platform === 'darwin') {
    return join(process.env.HOME ?? process.cwd(), 'Library', 'Application Support', 'DeepSeek Harness', 'core')
  }
  return join(process.env.LOCALAPPDATA ?? process.env.APPDATA ?? process.cwd(), 'DeepSeek Harness', 'core')
}

function packageVersionDirectory(root, version) {
  return join(root, 'versions', version)
}

function installedEntryPath(directory) {
  return join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(String(version))
  if (!match || match.slice(1, 4).some(part => part.length > 1 && part.startsWith('0'))) return undefined
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/u.test(part) && part.length > 1 && part.startsWith('0'))) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prerelease.map(part => /^\d+$/u.test(part) ? Number(part) : part),
  }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index]
    const bv = b.prerelease[index]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    if (av === bv) continue
    if (typeof av === 'number' && typeof bv === 'number') return av - bv
    if (typeof av === 'number') return -1
    if (typeof bv === 'number') return 1
    return av < bv ? -1 : 1
  }
  return 0
}

function isCompatibleVersion(version, minimum) {
  if (!parseVersion(version)) return false
  if (!minimum) return true
  const comparison = compareVersions(version, minimum)
  return comparison !== undefined && comparison >= 0
}

async function fetchMetadata(config) {
  const packagePath = encodeURIComponent(config.packageName).replace('%40', '@')
  const response = await fetch(`${config.registry}/${packagePath}`, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) fail(`official registry returned HTTP ${response.status} for ${config.packageName}`)
  return await response.json()
}

async function resolveChannelVersion(config, metadata) {
  const requested = process.env.DSH_CORE_VERSION || config.distTag
  const version = metadata['dist-tags']?.[requested] ?? requested
  const record = metadata.versions?.[version]
  if (!record) fail(`core version '${requested}' is not published in the configured official channel`)
  if (!isCompatibleVersion(version, config.minimumCoreVersion)) {
    const reason = config.minimumCoreVersion
      ? `below the configured minimum ${config.minimumCoreVersion}`
      : 'invalid'
    fail(`core version '${version}' is ${reason}`)
  }
  return { version, record, requested }
}

async function readCurrent(root) {
  try {
    return JSON.parse(await readFile(join(root, 'current.json'), 'utf8'))
  } catch {
    return undefined
  }
}

async function isInstalledAt(directory) {
  try {
    await readFile(installedEntryPath(directory))
    return true
  } catch {
    return false
  }
}

async function isInstalled(root, version) {
  return await isInstalledAt(packageVersionDirectory(root, version))
}

function pnpmEntry() {
  const configured = process.env.DSH_CLIENT_PNPM_ENTRY
  if (configured) return configured
  const root = process.env.DSH_CLIENT_ROOT ? resolve(process.env.DSH_CLIENT_ROOT) : ROOT
  return join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
}

async function runPackageManager(args, cwd, extraEnv = {}) {
  const command = process.env.DSH_CLIENT_PNPM_COMMAND
  const configuredNode = process.env.DSH_CLIENT_NODE_BINARY
  const useNpm = process.env.DSH_CLIENT_PACKAGE_MANAGER === 'npm'
  const npmCli = process.env.DSH_CLIENT_NPM_CLI
  const executable = command || configuredNode || process.execPath
  const commandArgs = command
    ? args
    : useNpm
      ? [npmCli ?? 'npm', ...args]
      : [pnpmEntry(), ...args]
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd,
      env: {
        ...process.env,
        ...extraEnv,
        COREPACK_ENABLE_PROJECT_SPEC: '0',
      },
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) reject(new Error(`${useNpm ? 'npm' : 'pnpm'} exited with code ${String(code ?? 1)}`))
      else resolvePromise()
    })
  })
}

async function installVersion(config, resolved) {
  const root = runtimeRoot()
  const destination = packageVersionDirectory(root, resolved.version)
  if (await isInstalled(root, resolved.version)) {
    await writeFile(join(root, 'current.json'), JSON.stringify({
      packageName: config.packageName,
      version: resolved.version,
      integrity: resolved.record.dist?.integrity ?? null,
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n')
    return { root, version: resolved.version, reused: true }
  }

  await mkdir(join(root, 'versions'), { recursive: true })
  const staging = join(root, 'versions', `.staging-${process.pid}-${Date.now()}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: 'dsh-launcher-core',
      private: true,
      version: resolved.version,
      packageManager: `pnpm@${PNPM_VERSION}`,
      dependencies: { [config.packageName]: resolved.version },
    }, null, 2) + '\n')
    if (process.env.DSH_CLIENT_PACKAGE_MANAGER === 'npm') {
      await runPackageManager([
        'install',
        '--omit=dev',
        '--ignore-scripts',
        '--no-package-lock',
        '--no-audit',
        '--no-fund',
        `--registry=${config.registry}`,
      ], staging, { npm_config_registry: config.registry })
    } else {
      await runPackageManager([
        'install',
        '--ignore-workspace',
        '--node-linker=hoisted',
        '--prod',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        `--registry=${config.registry}`,
      ], staging, { npm_config_registry: config.registry })
    }
    if (!(await isInstalledAt(staging))) {
      fail(`installed package did not contain ${config.packageName}@${resolved.version}`)
    }
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
    await writeFile(join(root, 'current.json'), JSON.stringify({
      packageName: config.packageName,
      version: resolved.version,
      integrity: resolved.record.dist?.integrity ?? null,
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n')
    return { root, version: resolved.version, reused: false }
  } finally {
    if (process.env.DSH_KEEP_CORE_STAGING !== '1') await rm(staging, { recursive: true, force: true })
  }
}

async function check() {
  const config = await channel()
  const metadata = await fetchMetadata(config)
  const resolved = await resolveChannelVersion(config, metadata)
  const root = runtimeRoot()
  const current = await readCurrent(root)
  const installed = await isInstalled(root, resolved.version)
  const comparison = current?.version ? compareVersions(resolved.version, current.version) : undefined
  if (current?.version && comparison === undefined) fail(`cached core version '${current.version}' is invalid`)
  console.log(JSON.stringify({
    packageName: config.packageName,
    registry: config.registry,
    requested: resolved.requested,
    available: resolved.version,
    current: current?.version ?? null,
    installed,
    updateAvailable: current?.version ? comparison > 0 : true,
    integrity: resolved.record.dist?.integrity ?? null,
  }, null, 2))
}

async function install() {
  const config = await channel()
  const root = runtimeRoot()
  let metadata
  try {
    metadata = await fetchMetadata(config)
  } catch (error) {
    const cached = await readCurrent(root)
    if (!cached || !isCompatibleVersion(cached.version, config.minimumCoreVersion) || !(await isInstalled(root, cached.version))) throw error
    console.warn(`core: official registry unavailable; reusing cached ${config.packageName}@${cached.version}`)
    console.log(`core: runtime ${root}`)
    return
  }
  const resolved = await resolveChannelVersion(config, metadata)
  const current = await readCurrent(root)
  if (current?.version) {
    const comparison = compareVersions(resolved.version, current.version)
    if (comparison === undefined) fail(`cached core version '${current.version}' is invalid`)
    if (comparison < 0) {
      if (!(await isInstalled(root, current.version))) {
        fail(`official channel ${resolved.version} is older than cached ${current.version}; refusing downgrade while the cached core is unavailable`)
      }
      console.warn(`core: official channel ${resolved.version} is older than cached ${current.version}; refusing downgrade`)
      console.log(`core: runtime ${root}`)
      return
    }
  }
  const result = await installVersion(config, resolved)
  console.log(`core: ${result.reused ? 'reused' : 'installed'} ${config.packageName}@${result.version}`)
  console.log(`core: runtime ${result.root}`)
}

const [command = 'check'] = process.argv.slice(2)
if (command === 'check') await check()
else if (command === 'install') await install()
else fail('usage: core-manager.mjs <check|install>')
