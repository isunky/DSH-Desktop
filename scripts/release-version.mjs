import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u

function fail(message) {
  throw new Error(`release-version: ${message}`)
}

function parseVersion(value, source) {
  const match = VERSION_PATTERN.exec(String(value).trim())
  if (!match) fail(`${source} must use stable semver X.Y.Z, got '${value}'`)
  return match.slice(1).map(Number)
}

function formatVersion(parts) {
  return parts.join('.')
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function gitTags() {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/u)
      .map(tag => tag.match(/^v(\d+\.\d+\.\d+)$/u)?.[1])
      .filter(Boolean)
      .map(version => parseVersion(version, 'git tag'))
  } catch {
    return []
  }
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  return parseVersion(packageJson.version, 'package.json version')
}

function increment(parts, bump) {
  const next = [...parts]
  if (bump === 'major') return [next[0] + 1, 0, 0]
  if (bump === 'minor') return [next[0], next[1] + 1, 0]
  if (bump === 'patch') return [next[0], next[1], next[2] + 1]
  fail(`bump must be patch, minor or major, got '${bump}'`)
}

async function replaceVersion(path, expression, label, version) {
  const source = await readFile(path, 'utf8')
  let replacements = 0
  const updated = source.replace(expression, (...args) => {
    replacements += 1
    const prefix = args[1]
    const suffix = args[3]
    return `${prefix}${version}${suffix}`
  })
  if (replacements !== 1) fail(`${label} must contain exactly one client version field`)
  await writeFile(path, updated)
}

async function updateFiles(version) {
  await replaceVersion(
    join(ROOT, 'package.json'),
    /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/u,
    'package.json',
    version,
  )
  await replaceVersion(
    join(ROOT, 'src-tauri', 'tauri.conf.json'),
    /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/u,
    'src-tauri/tauri.conf.json',
    version,
  )
  await replaceVersion(
    join(ROOT, 'src-tauri', 'Cargo.toml'),
    /(^version\s*=\s*")(\d+\.\d+\.\d+)(")/mu,
    'src-tauri/Cargo.toml',
    version,
  )
  await replaceVersion(
    join(ROOT, 'src-tauri', 'Cargo.lock'),
    /(\[\[package\]\]\r?\nname = "deepseek-harness"\r?\nversion = ")(\d+\.\d+\.\d+)(")/u,
    'src-tauri/Cargo.lock',
    version,
  )
}

async function main() {
  const [command = 'next', bump = 'patch'] = process.argv.slice(2)
  const current = await readPackageVersion()
  const tagged = gitTags()
  const baseline = [current, ...tagged].sort(compareVersions).at(-1)
  const next = formatVersion(increment(baseline, bump))

  if (command === 'next') {
    console.log(next)
    return
  }
  if (command !== 'bump') fail(`usage: node scripts/release-version.mjs <next|bump> [patch|minor|major]`)
  await updateFiles(next)
  console.log(next)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
