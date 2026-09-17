import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const stableTag = /^v\d+\.\d+\.\d+$/u
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

export function verifyVersion(tag, cwd = process.cwd()) {
  if (!stableTag.test(tag)) throw new Error('Release tag must be vX.Y.Z')
  const read = path => readFileSync(resolve(cwd, path), 'utf8')
  const versions = [
    JSON.parse(read('package.json')).version,
    JSON.parse(read('src-tauri/tauri.conf.json')).version,
    read('src-tauri/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/mu)?.[1],
    read('src-tauri/Cargo.lock').match(/name = "dsh-launcher"\r?\nversion = "([^"]+)"/u)?.[1],
  ]
  if (versions.some(version => version !== tag.slice(1))) throw new Error('Tag and all four client version files must match')
}

export function releaseNotes(tag, cwd = process.cwd(), repository = 'isunky/DSH-Desktop') {
  if (!stableTag.test(tag)) throw new Error('Release tag must be vX.Y.Z')
  // Exclude future and unrelated tags when rebuilding an older release.
  const parents = git(cwd, 'rev-list', '--parents', '-n', '1', tag).split(' ').slice(1)
  const previous = parents.length
    ? git(cwd, 'tag', '--merged', parents[0], '--sort=-version:refname').split(/\r?\n/u).find(candidate => stableTag.test(candidate))
    : undefined
  const commits = git(cwd, 'log', '--no-merges', '--format=%H%x09%s', previous ? `${previous}..${tag}` : tag)
    .split(/\r?\n/u).filter(Boolean)
    .map(line => {
      const [sha, ...subject] = line.split('\t')
      return { sha, subject: subject.join('\t') }
    }).filter(({ subject }) => !/^chore\(release\): /u.test(subject))
  const url = `https://github.com/${repository}`
  const escape = text => text.replace(/[\\`*_[\]<>]/gu, '\\$&')
  return [
    `# DSH Launcher ${tag}`, '', '## 最近更新', '',
    ...commits.map(({ sha, subject }) => `- ${escape(subject)} ([${sha.slice(0, 7)}](${url}/commit/${sha}))`),
    ...(commits.length ? [] : ['- 本次版本没有额外的功能或修复提交。']),
    '', ...(previous ? [`[查看完整变更 ${previous} → ${tag}](${url}/compare/${previous}...${tag})`, ''] : []),
    '## 下载', '', '- Windows x64：EXE 安装包',
    '- macOS Apple Silicon：arm64 DMG', '- macOS Intel：x64 DMG', '',
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, tag] = process.argv.slice(2)
    if (command === 'verify') verifyVersion(tag)
    else if (command === 'notes') console.log(releaseNotes(tag, process.cwd(), process.env.GITHUB_REPOSITORY))
    else throw new Error('Usage: release-notes.mjs <verify|notes> vX.Y.Z')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
