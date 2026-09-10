export async function checkClientRelease(repository, currentVersion, fetcher = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error('客户端仓库配置无效')
  const response = await fetcher(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404) return { message: '尚未发现公开的客户端正式版本。请等待开发者发布 Release。' }
  if (!response.ok) throw new Error(`客户端更新检查失败（HTTP ${response.status}），请稍后重试。`)
  const release = await response.json()
  const version = String(release.tag_name ?? '').replace(/^v/u, '')
  const parse = value => /^\d+\.\d+\.\d+$/u.test(value) ? value.split('.').map(Number) : null
  const available = parse(version)
  const current = parse(currentVersion)
  if (!available || !current) return { message: '发布版本号无法自动比较，请在开发者主页查看 Releases。' }
  const difference = available.map((part, index) => part - current[index]).find(part => part !== 0) ?? 0
  if (difference <= 0) return { message: `当前客户端 v${currentVersion} 已是最新版本。` }
  return { version, url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(release.tag_name)}` }
}
