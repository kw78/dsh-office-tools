#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const canonical = JSON.parse(readFileSync(join(root, 'compatibility.json'), 'utf8'))
const { range, releases, ci } = canonical
const releaseMap = Object.fromEntries(releases.map(release => [release, 'compatible']))
const ciVersions = ci.map(row => row.version)
const listEn = ciVersions.length > 1
  ? `${ciVersions.slice(0, -1).join(', ')}, and ${ciVersions[ciVersions.length - 1]}`
  : ciVersions[0]
const listZh = ciVersions.join('、')

function replaceBlock(text, startMarker, endMarker, content) {
  const from = text.indexOf(startMarker)
  const to = text.indexOf(endMarker)
  if (from < 0 || to < from) throw new Error(`missing markers: ${startMarker}`)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const normalized = content.split(/\r?\n/).join(eol)
  const indent = text.slice(text.lastIndexOf('\n', to) + 1, to)
  return `${text.slice(0, from + startMarker.length)}${eol}${normalized}${eol}${indent}${text.slice(to)}`
}

function json(value, original) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  return JSON.stringify(value, null, 2).replace(/\n/g, eol) + eol
}

const matrix = [
  '        include:',
  ...ci.flatMap(row => [
    `          - dsh-version: '${row.version}'`,
    ...(row.cordis === undefined ? [] : [`            cordis-version: '${row.cordis}'`]),
  ]),
].join('\n')

const pkgSource = readFileSync(join(root, 'package.json'), 'utf8')
const pluginSource = readFileSync(join(root, 'dsh.plugin.json'), 'utf8')
const readmeEn = readFileSync(join(root, 'README.md'), 'utf8')
const readmeZh = readFileSync(join(root, 'README.zh.md'), 'utf8')
const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

const pkg = JSON.parse(pkgSource)
pkg.dsh.compatibility.dsh = range
pkg.dsh.compatibility.dshReleases = releaseMap
for (const name of Object.keys(pkg.peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) pkg.peerDependencies[name] = range
}
pkg.engines.dsh = range
pkg.dshWorkshop.compatibility.dshVersions = [...releases]

const plugin = JSON.parse(pluginSource)
plugin.engines.dsh = range

const files = [
  ['package.json', json(pkg, pkgSource)],
  ['dsh.plugin.json', json(plugin, pluginSource)],
  ['README.md', replaceBlock(readmeEn, '<!-- compatibility:start -->', '<!-- compatibility:end -->',
    `Compatibility: \`${range}\`; exact tested releases live in \`package.json\` (\`dsh.compatibility.dshReleases\`). CI exercises ${listEn}. DSH 0.3.x is not declared supported.`)],
  ['README.zh.md', replaceBlock(readmeZh, '<!-- compatibility:start -->', '<!-- compatibility:end -->',
    `兼容性：\`${range}\`；逐版本的实测记录见 \`package.json\`（\`dsh.compatibility.dshReleases\`）。CI 验证 ${listZh}，尚未声明支持 DSH 0.3.x。`)],
  ['.github/workflows/ci.yml', replaceBlock(workflow, '# compatibility-matrix:start', '# compatibility-matrix:end', matrix)],
]

let drift = false
for (const [file, content] of files) {
  const current = readFileSync(join(root, file), 'utf8')
  if (current === content) continue
  drift = true
  if (check) console.error(`out of sync: ${file}`)
  else writeFileSync(join(root, file), content)
}
if (check && drift) {
  console.error('Compatibility metadata drifted. Run: pnpm run sync:metadata')
  process.exit(1)
}
if (!check && drift) console.log('compatibility metadata synced')
