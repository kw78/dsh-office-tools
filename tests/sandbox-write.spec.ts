/**
 * Regression tests for the sandboxed-fs write path (field report against
 * 1.0.0: all five write tools failed with "file access denied under
 * workspace-write mode" on deployments running @deepseek-ai/dsh-fs-sandbox,
 * while the three read tools worked).
 *
 * `SandboxedFileSystem` replicates the sandbox backend's write fence:
 * `writeText(target, content, expected, signal, sandboxPolicy)` judges
 * containment against the PER-CALL policy when the fifth parameter is
 * supplied and falls back to the deployment default when it is not — the
 * exact fallback that denied in-session writes while the plugin omitted the
 * parameter.
 */

import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveOfficePath, resolveWritePolicy, type FsContext, type OfficeWritePolicy } from '../src/fschannel.ts'
import { execFor, mountTools, run, testFileSystem } from './harness.ts'

function targetPath(target: FsTarget): string {
  return (target as unknown as { absolute: string }).absolute
}

/** One service observation, for asserting the resolve({ session }) contract. */
interface PolicyCall {
  session: unknown
}

/** A write fence modeled on dsh-fs-sandbox's checkedTarget semantics. */
class SandboxedFileSystem {
  /** Every policy writeText was called with, in order (undefined = omitted). */
  readonly policiesSeen: Array<OfficeWritePolicy | undefined> = []

  constructor(
    private readonly inner: FileSystem,
    private readonly deploymentDefault: OfficeWritePolicy,
  ) {}

  /** The deployment default mode — the capability fact the tool layer reads. */
  get sandboxMode(): 'workspace-write' {
    return 'workspace-write'
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.inner.resolve(path, opts)
  }

  processPath(target: FsTarget): string { return this.inner.processPath(target) }
  processPathFromHostPath(hostPath: string): string | undefined { return this.inner.processPathFromHostPath(hostPath) }
  fileUrl(target: FsTarget): string { return this.inner.fileUrl(target) }
  contains(parent: FsTarget, child: FsTarget): boolean { return this.inner.contains(parent, child) }
  async stat(target: FsTarget, signal?: AbortSignal) { return this.inner.stat(target, signal) }
  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal) { return this.inner.lstat(path, opts, signal) }
  async readText(target: FsTarget, signal?: AbortSignal) { return this.inner.readText(target, signal) }
  async streamText(target: FsTarget, signal?: AbortSignal) { return this.inner.streamText(target, signal) }
  async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number) {
    return this.inner.readBytes(target, signal, maxBytes)
  }
  async listDir(target: FsTarget, signal?: AbortSignal) { return this.inner.listDir(target, signal) }

  async writeText(
    target: FsTarget,
    content: string,
    expected?: undefined,
    signal?: AbortSignal,
    sandboxPolicy?: OfficeWritePolicy,
  ) {
    this.policiesSeen.push(sandboxPolicy)
    signal?.throwIfAborted()
    const policy = sandboxPolicy ?? this.deploymentDefault
    if (policy.mode === 'danger-full-access') return this.inner.writeText(target, content, expected, signal)
    if (policy.mode === 'read-only') {
      throw new Error(`cannot write "${targetPath(target)}": read-only mode`)
    }
    const fresh = await this.inner.resolve(targetPath(target))
    const rootTarget = await this.inner.resolve('.', { cwd: policy.workspaceRoot })
    if (!this.inner.contains(rootTarget, fresh)) {
      throw new Error(`cannot write "${targetPath(target)}": file access denied under workspace-write mode`)
    }
    return this.inner.writeText(target, content, expected, signal)
  }

  async editText(): Promise<never> {
    throw new Error('SandboxedFileSystem does not implement editText; the office tools never call it')
  }
}

/** Policy service (SandboxPolicyService shape) answering from the calling session's cwd. */
function sessionWorkspacePolicyService(log: PolicyCall[] = []) {
  return {
    resolve(request: { session?: unknown } = {}): OfficeWritePolicy {
      log.push({ session: request.session })
      const session = request.session as { header: { cwd: string } } | undefined
      return { mode: 'workspace-write', workspaceRoot: session?.header.cwd ?? '' }
    },
  }
}

/** Policy service always answering with a fixed policy. */
function fixedPolicyService(policy: OfficeWritePolicy) {
  return {
    resolve(): OfficeWritePolicy {
      return policy
    },
  }
}

describe('sandboxed write path', () => {
  test('all five write tools succeed when the per-call policy is resolvable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-'))
    const deploymentDefaultRoot = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-default-'))
    try {
      const calls: PolicyCall[] = []
      const fs = new SandboxedFileSystem(testFileSystem(), {
        mode: 'workspace-write',
        workspaceRoot: deploymentDefaultRoot,
      })
      const tools = mountTools(undefined, { fs: fs as unknown as FileSystem, sandboxPolicy: sessionWorkspacePolicyService(calls) })

      const doc = await run(tools, 'word_create', { path: 'report.docx', title: 'Report', paragraphs: ['hello'] }, root) as any
      expect(doc.sizeBytes).toBeGreaterThan(0)
      await run(tools, 'word_update', { path: 'report.docx', paragraphs: ['more'] }, root)
      await run(tools, 'excel_create', { path: 'budget.xlsx', sheets: [{ name: 'S1', rows: [['a', 1]] }] }, root)
      await run(tools, 'excel_update', { path: 'budget.xlsx', cell_updates: [{ sheet: 'S1', cell: 'B2', value: 42 }] }, root)
      await run(tools, 'ppt_create', { path: 'deck.pptx', title: 'Deck' }, root)

      for (const name of ['report.docx', 'budget.xlsx', 'deck.pptx']) {
        expect((await stat(join(root, name))).isFile()).toBe(true)
      }
      const read = await run(tools, 'word_read', { path: 'report.docx' }, root) as any
      expect(read.text).toContain('hello')
      expect(read.text).toContain('more')

      expect(fs.policiesSeen).toHaveLength(5)
      for (const policy of fs.policiesSeen) {
        expect(policy?.mode).toBe('workspace-write')
        expect(policy?.workspaceRoot).toBe(root)
      }
      expect(calls).toHaveLength(5)
      for (const call of calls) {
        expect((call.session as { header: { cwd: string } })?.header?.cwd).toBe(root)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(deploymentDefaultRoot, { recursive: true, force: true })
    }
  })

  test('a confining backend without the policy service fails loudly before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-none-'))
    const deploymentDefaultRoot = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-none-default-'))
    try {
      const fs = new SandboxedFileSystem(testFileSystem(), {
        mode: 'workspace-write',
        workspaceRoot: deploymentDefaultRoot,
      })
      const tools = mountTools(undefined, { fs: fs as unknown as FileSystem })
      // The plugin mirrors dsh-tool-fs's invariant: a filesystem that confines
      // requires ctx.sandboxPolicy, and refuses before writing rather than
      // letting the backend deny with the confusing deployment-default error.
      await expect(run(tools, 'word_create', { path: 'report.docx', paragraphs: ['x'] }, root))
        .rejects.toThrow(/the mounted filesystem confines but ctx\.sandboxPolicy is missing/)
      expect(fs.policiesSeen).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(deploymentDefaultRoot, { recursive: true, force: true })
    }
  })

  test('the fence double itself still denies an omitted policy by the deployment default (the 1.0.0 mechanism)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-mech-'))
    const deploymentDefaultRoot = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-mech-default-'))
    try {
      const fs = new SandboxedFileSystem(testFileSystem(), {
        mode: 'workspace-write',
        workspaceRoot: deploymentDefaultRoot,
      })
      const target = await fs.resolve(join(root, 'report.docx'))
      await expect(fs.writeText(target, 'x', undefined, undefined, undefined))
        .rejects.toThrow(/file access denied under workspace-write mode/)
      expect(fs.policiesSeen).toEqual([undefined])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(deploymentDefaultRoot, { recursive: true, force: true })
    }
  })

  test('writes anchor to the policy workspace root when it differs from the session cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-out-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-out-elsewhere-'))
    try {
      const fs = new SandboxedFileSystem(testFileSystem(), {
        mode: 'workspace-write',
        workspaceRoot: elsewhere,
      })
      const tools = mountTools(undefined, { fs: fs as unknown as FileSystem, sandboxPolicy: fixedPolicyService({ mode: 'workspace-write', workspaceRoot: elsewhere }) })
      const created = await run(tools, 'excel_create', { path: 'budget.xlsx', sheets: [{ name: 'S1', rows: [['a']] }] }, root) as any
      expect(created.sizeBytes).toBeGreaterThan(0)
      // Relative paths resolve against the effective (policy) workspace, the
      // way the official fs tools resolve them — not the session cwd.
      expect((await stat(join(elsewhere, 'budget.xlsx'))).isFile()).toBe(true)
      await expect(stat(join(root, 'budget.xlsx'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  test('an absolute path outside the policy workspace root is refused before the write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-abs-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-abs-elsewhere-'))
    try {
      const fs = new SandboxedFileSystem(testFileSystem(), {
        mode: 'workspace-write',
        workspaceRoot: elsewhere,
      })
      const tools = mountTools(undefined, { fs: fs as unknown as FileSystem, sandboxPolicy: fixedPolicyService({ mode: 'workspace-write', workspaceRoot: elsewhere }) })
      await expect(run(tools, 'word_create', { path: join(root, 'report.docx'), paragraphs: ['x'] }, root))
        .rejects.toThrow(/escapes the session workspace/)
      expect(fs.policiesSeen).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  test('a danger-full-access per-call policy bypasses the fence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-full-'))
    const deploymentDefaultRoot = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-full-default-'))
    try {
      const fs = new SandboxedFileSystem(testFileSystem(), {
        mode: 'workspace-write',
        workspaceRoot: deploymentDefaultRoot,
      })
      const tools = mountTools(undefined, {
        fs: fs as unknown as FileSystem,
        sandboxPolicy: fixedPolicyService({ mode: 'danger-full-access', workspaceRoot: deploymentDefaultRoot }),
      })
      const deck = await run(tools, 'ppt_create', { path: 'deck.pptx', title: 'Deck' }, root) as any
      expect(deck.sizeBytes).toBeGreaterThan(0)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(deploymentDefaultRoot, { recursive: true, force: true })
    }
  })
})

describe('resolveWritePolicy', () => {
  test('skips the service entirely when the backend does not confine', async () => {
    const service = fixedPolicyService({ mode: 'workspace-write', workspaceRoot: '/w' })
    const ctx = { fs: testFileSystem(), get: () => service } as unknown as Context & FsContext
    expect(await resolveWritePolicy(ctx, execFor('/tmp'))).toBeUndefined()
  })

  test('fails loudly when the backend confines but the service is missing', async () => {
    const fs = new SandboxedFileSystem(testFileSystem(), { mode: 'workspace-write', workspaceRoot: '/deploy' })
    const ctx = { fs, get: () => undefined } as unknown as Context & FsContext
    await expect(resolveWritePolicy(ctx, execFor('/tmp'))).rejects.toThrow(/ctx\.sandboxPolicy is missing/)
  })

  test('returns undefined for services predating resolve', async () => {
    const fs = new SandboxedFileSystem(testFileSystem(), { mode: 'workspace-write', workspaceRoot: '/deploy' })
    const ctx = { fs, get: () => ({}) } as unknown as Context & FsContext
    expect(await resolveWritePolicy(ctx, execFor('/tmp'))).toBeUndefined()
  })

  test('resolves the standing policy for the calling session', async () => {
    const fs = new SandboxedFileSystem(testFileSystem(), { mode: 'workspace-write', workspaceRoot: '/deploy' })
    const seen: unknown[] = []
    const service = {
      resolve(request: { session?: unknown } = {}): OfficeWritePolicy {
        seen.push(request.session)
        return { mode: 'workspace-write', workspaceRoot: '/w' }
      },
    }
    const ctx = { fs, get: (name: string) => (name === 'sandboxPolicy' ? service : undefined) } as unknown as Context & FsContext
    const exec = execFor('/tmp')
    expect(await resolveWritePolicy(ctx, exec)).toEqual({ mode: 'workspace-write', workspaceRoot: '/w' })
    expect(seen).toEqual([(exec as unknown as { agent: { session: unknown } }).agent.session])
  })
})

describe('resolveOfficePath write-policy anchoring', () => {
  test('relative paths resolve against the policy workspace root when supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-sbx-anchor-'))
    try {
      const granted = join(root, 'granted')
      await mkdir(granted)
      const ctx = { fs: testFileSystem() }
      const anchored = await resolveOfficePath(
        execFor(root), ctx, 'report.docx', ['.docx'], false,
        { mode: 'workspace-write', workspaceRoot: granted },
      )
      expect(anchored.absolute).toBe(join(granted, 'report.docx'))

      const plain = await resolveOfficePath(execFor(root), ctx, 'report.docx', ['.docx'], false)
      expect(plain.absolute).toBe(join(root, 'report.docx'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
