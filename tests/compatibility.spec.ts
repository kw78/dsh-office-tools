import { readFileSync } from 'node:fs'
import semver from 'semver'
import { expect, test } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const plugin = JSON.parse(readFileSync(new URL('../dsh.plugin.json', import.meta.url), 'utf8'))

test('every declared DSH release satisfies the host peer gate (#6)', () => {
  for (const [release, status] of Object.entries(manifest.dsh.compatibility.dshReleases)) {
    if (status !== 'compatible') continue
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      expect(semver.satisfies(release, range as string, { includePrerelease: true }), `${release}: ${name}`).toBe(true)
    }
    expect(semver.satisfies(release, plugin.engines.dsh, { includePrerelease: true })).toBe(true)
    expect(manifest.dshWorkshop.compatibility.dshVersions).toContain(release)
  }
  expect(plugin.version).toBe(manifest.version)
  expect(semver.satisfies('0.3.0-rc.1', manifest.peerDependencies['@deepseek-ai/dsh-fs'], { includePrerelease: true })).toBe(false)
})

test('every compatible release is accepted under default semver', () => {
  // Hosts and npm evaluate ranges without includePrerelease, where a
  // prerelease needs a comparator with the same major.minor.patch — e.g.
  // `>=0.2.0-rc.1 <0.3.0-0` does not match 0.2.1-rc.3.
  for (const [release, status] of Object.entries(manifest.dsh.compatibility.dshReleases)) {
    if (status !== 'compatible') continue
    expect(semver.satisfies(release, manifest.dsh.compatibility.dsh), `${release}: dsh range`).toBe(true)
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      expect(semver.satisfies(release, range as string), `${release}: ${name}`).toBe(true)
    }
    expect(semver.satisfies(release, plugin.engines.dsh), `${release}: plugin engines`).toBe(true)
  }
})
