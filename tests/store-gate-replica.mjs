#!/usr/bin/env node
/**
 * Local replica of DSH-Store's analyzeFixedSource gate
 * (AI-Scarlett/DSH-Store scripts/automate-catalog.mjs + src/automation-source-policy.mjs),
 * run against the working tree. Zero reasons + zero signals == the fixed
 * source passes the automatic approval policy exactly as the store computes
 * it. Read-only; never executes plugin code.
 */
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|sh|py|rb|go|rs)$/i
const NATIVE_FILE = /\.(?:node|wasm|dll|dylib|so|exe|bin)$/i
const EXCLUDED_DIRECTORY = /(?:^|\/)(?:node_modules|vendor|test|tests|docs?|examples?|fixtures?|benchmarks?|coverage|\.github)(?:\/|$)/i
const EXCLUDED_METADATA_FILE = /(?:^|\/)(?:brief\.json|catalog-entry(?:\.draft)?\.json)$/i
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

const policy = {
  sourceBounds: { maxTreeEntries: 1200, maxRuntimeFiles: 240, maxFileBytes: 262144, maxTotalRuntimeBytes: 2097152 },
  automaticApproval: {
    requireManifestRepositoryMatch: true,
    requireRepositoryLicenseMatch: true,
    requireExplicitFiles: true,
    requireDshCompatibility: true,
    requireNodeCompatibility: true,
    allowLifecycleScripts: false,
    allowRuntimeDependencies: false,
    allowSymlinks: false,
    allowSubmodules: false,
    permissionSignals: { files: false, network: false, commands: false, credentials: false, protectedDsh: false, nativeOrExecutableArtifacts: false },
  },
}

const moduleImport = names => new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*(?:\\(\\s*)?|\\brequire\\s*\\(\\s*)["'](?:node:)?(?:${names})["']`,
  'i',
)
const FILE_MODULE = moduleImport('fs|fs/promises')
const NETWORK_MODULE = moduleImport('http|https|net|tls|dgram|axios|got|undici')
const COMMAND_MODULE = moduleImport('child_process')

function permissionSignals(source) {
  return {
    files: FILE_MODULE.test(source)
      || /\b(?:readFile|writeFile|appendFile|rename|unlink|mkdir|rmdir|rm)\s*\(/i.test(source)
      || /\$DSH_HOME|\.dsh\/profiles/i.test(source),
    network: NETWORK_MODULE.test(source)
      || /\b(?:fetch|WebSocket|EventSource)\s*\(/i.test(source)
      || /\b(?:axios|got|undici)\s*(?:\.|\()/i.test(source),
    commands: COMMAND_MODULE.test(source)
      || /\b(?:exec|execFile|spawn|fork)\s*\(|shell\s*:\s*true|Bun\.spawn|new\s+Deno\.Command/i.test(source),
    credentials: /process\.env/i.test(source)
      || /\b(?:keychain|credentials?|oauth)\b\s*(?:\.|\[|\()/i.test(source)
      || /\b(?:api[_-]?key|apiKey|access[_-]?token|accessToken|client[_-]?secret|clientSecret|password)\b/i.test(source),
    protectedDsh: /(?:__ModuleLoader__[^\n]{0,120}(?:unload|remove)|\bFiber\b[^\n]{0,120}(?:remove|disable|replace)|@deepseek-ai\/[^\n]{0,160}disabled\s*:\s*true|tool\.call\.toolview)/i.test(source),
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) walk(absolute, out)
    else if (entry.isFile()) out.push({ absolute, rel: relative(process.cwd(), absolute), mode: lstatSync(absolute).mode })
  }
  return out
}

const reasons = []
const signals = { files: false, network: false, commands: false, credentials: false, protectedDsh: false, nativeOrExecutableArtifacts: false }
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))

// --- manifest-level gates (checkRepository/inferredCompatibility equivalents) ---
const repositoryUrl = 'https://github.com/kw78/dsh-office-tools'
const canonical = String(manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
if (policy.automaticApproval.requireManifestRepositoryMatch && canonical !== repositoryUrl) {
  reasons.push('manifest repository does not match the canonical GitHub repository')
}
if (policy.automaticApproval.requireExplicitFiles && (!Array.isArray(manifest.files) || manifest.files.length === 0)) {
  reasons.push('manifest does not declare an explicit distributable files list')
}
const declared = manifest?.dsh?.compatibility && typeof manifest.dsh.compatibility === 'object' ? manifest.dsh.compatibility : {}
const peerRanges = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  .map(([, range]) => range)
const compatibilityDsh = typeof declared.dsh === 'string' ? declared.dsh : [...new Set(peerRanges)].length === 1 ? peerRanges[0] : null
if (policy.automaticApproval.requireDshCompatibility && !compatibilityDsh) {
  reasons.push('DSH compatibility is not explicitly declared')
}
const compatibilityNode = typeof manifest.engines?.node === 'string' ? manifest.engines.node : null
if (policy.automaticApproval.requireNodeCompatibility && !compatibilityNode) {
  reasons.push('Node.js compatibility is not explicitly declared')
}
const installScripts = Object.keys(manifest.scripts ?? {}).filter(name => LIFECYCLE_SCRIPTS.includes(name))
if (!policy.automaticApproval.allowLifecycleScripts && installScripts.length > 0) {
  reasons.push(`install lifecycle scripts are present: ${installScripts.join(', ')}`)
}
const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) }
if (!policy.automaticApproval.allowRuntimeDependencies && Object.keys(dependencies).length > 0) {
  reasons.push('runtime or optional dependencies require a separate supply-chain review')
}
if (Array.isArray(manifest.bundledDependencies) && manifest.bundledDependencies.length > 0) {
  reasons.push('bundled dependencies are not eligible for automatic approval')
}

// --- tree + runtime source gates (analyzeFixedSource equivalents) ---
const tree = walk('.')
if (tree.length === 0 || tree.length > policy.sourceBounds.maxTreeEntries) {
  reasons.push(`repository tree exceeds the automatic review bound: ${tree.length}`)
}
if (tree.some(item => (item.mode & 0o170000) === 0o120000)) reasons.push('package contains symbolic links')
if (tree.some(item => (item.mode & 0o170000) === 0o160000)) reasons.push('package contains Git submodules')

const runtimeFiles = tree.filter(item => {
  if (NATIVE_FILE.test(item.rel) || (item.mode & 0o111) !== 0) signals.nativeOrExecutableArtifacts = true
  if (EXCLUDED_DIRECTORY.test(item.rel)) return false
  if (EXCLUDED_METADATA_FILE.test(item.rel)) return false
  return SOURCE_FILE.test(item.rel)
})
const runtimeCountWithinBounds = runtimeFiles.length > 0 && runtimeFiles.length <= policy.sourceBounds.maxRuntimeFiles
if (!runtimeCountWithinBounds) {
  reasons.push(`runtime source file count is outside the automatic review bound: ${runtimeFiles.length} files (maximum ${policy.sourceBounds.maxRuntimeFiles})`)
}
const runtimeSizes = runtimeFiles.map(item => statSync(item.absolute).size)
const totalBytes = runtimeSizes.reduce((sum, size) => sum + size, 0)
const largest = Math.max(0, ...runtimeSizes)
const bytesWithinBounds = runtimeSizes.every(size => size <= policy.sourceBounds.maxFileBytes)
  && totalBytes <= policy.sourceBounds.maxTotalRuntimeBytes
if (!bytesWithinBounds) {
  reasons.push(`runtime source exceeds the automatic review byte bound: ${totalBytes} total bytes (maximum ${policy.sourceBounds.maxTotalRuntimeBytes}); largest file ${largest} bytes (maximum ${policy.sourceBounds.maxFileBytes})`)
}
if (runtimeCountWithinBounds && bytesWithinBounds) {
  for (const item of runtimeFiles) {
    const source = readFileSync(item.absolute, 'utf8')
    for (const [signal, value] of Object.entries(permissionSignals(source))) {
      if (value) {
        signals[signal] = true
        console.error(`  SIGNAL ${signal} <- ${item.rel}`)
      }
    }
  }
}
for (const [signal, allowed] of Object.entries(policy.automaticApproval.permissionSignals)) {
  if (!allowed && signals[signal]) reasons.push(`runtime source contains the ${signal} permission signal`)
}

// --- dshReleases validation (declaredDshReleaseCompatibility equivalent) ---
const DSH_RC_RELEASES = ['rc.7', 'rc.8', '0.1.1-rc.1', '0.1.1-rc.2', '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5']
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const LATEST_THREE = ['0.1.2-alpha.4', '0.1.2-alpha.5', '0.1.2-rc.1']
const releaseStatuses = new Map()
for (const [release, status] of Object.entries(declared.dshReleases ?? {})) {
  if (!VERSION.test(release)) reasons.push(`dshReleases key ${release} is not a supported DSH release key`)
  if (!['compatible', 'incompatible', 'unknown'].includes(status)) reasons.push(`dshReleases.${release} has an invalid status`)
  releaseStatuses.set(release, status)
}
const supported = LATEST_THREE.some(release => releaseStatuses.get(release) === 'compatible')
if (!supported) reasons.push(`latest-three compatibility window (${LATEST_THREE.join(', ')}) has no exact compatible record`)

console.log(`runtime files: ${runtimeFiles.length}, total bytes: ${totalBytes}, largest: ${largest}`)
console.log(`signals: ${JSON.stringify(signals)}`)
console.log(`reasons (${reasons.length}):`)
for (const reason of reasons) console.log(`  - ${reason}`)
console.log(reasons.length === 0 ? 'RESULT: APPROVED (zero reasons, zero signals)' : 'RESULT: DEFERRED')
process.exitCode = reasons.length === 0 ? 0 : 1
