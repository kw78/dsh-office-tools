/**
 * The official file-system channel (1.0.0).
 *
 * Every byte this plugin reads or writes goes through the host's `ctx.fs`
 * service (`@deepseek-ai/dsh-fs`): reads arrive as raw byte arrays via
 * `readBytes`, writes leave as UTF-8 text via `writeText` — which is exactly
 * why `buildAsciiZip` keeps generated packages pure ASCII. The plugin itself
 * never touches the file system directly: workspace containment, symlink
 * resolution, and atomic publication all belong to the backend, and this
 * module only adds the Office-tool path policy on top (extension allow-lists,
 * size caps, overwrite refusal, display paths). Writes carry the per-call
 * sandbox policy (`ctx.sandboxPolicy.resolve({ session })` when a confining
 * backend is mounted) so sandboxing backends fence them by the session's
 * effective policy rather than the deployment default.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { MAX_OFFICE_FILE_BYTES } from './asciizip.ts'

/** Cap for text materialized into a single tool result. */
export const MAX_TEXT_CHARS = 200_000

/** Cap for worksheet cells materialized into a single tool result. */
export const MAX_READ_CELLS = 200_000

/** Cap for worksheet cells accepted by one create/update call. */
export const MAX_WRITE_CELLS = 200_000

/** The slice of the Cordis context this suite consumes: the official fs service. */
export interface FsContext {
  fs: FileSystem
}

/**
 * The per-call sandbox execution policy `ctx.fs.writeText` accepts as its
 * fifth parameter (`SandboxExecutionPolicy` from `@deepseek-ai/dsh-sandbox`):
 * a sandboxing backend fences the write by it, the bare backend ignores it,
 * and omitting it leaves the backend its deployment default — whose writable
 * roots need not include this session's workspace. Derived from the official
 * `writeText` signature so the plugin never depends on `@deepseek-ai/dsh-sandbox`
 * directly.
 */
export type OfficeWritePolicy = NonNullable<Parameters<FileSystem['writeText']>[4]>

/**
 * Structural slice of the sandbox-policy service a confining deployment
 * mounts (`@deepseek-ai/dsh-sandbox-policy`'s SandboxPolicyService, the same
 * service the sandboxing fs backend itself reads). `resolve({ session })`
 * folds the deployment default and the session's standing override into the
 * per-call mode and workspace root. The official fs tools wrap this same
 * service; their escalation retry path applies only to tools that advertise
 * `sandbox_permissions`, which these office tools do not, so the standing
 * policy is the whole policy here.
 */
interface SandboxPolicyService {
  resolve(request?: { session?: unknown }): OfficeWritePolicy | undefined
}

/**
 * Resolve the per-call write policy the way the official fs tool layer does:
 * skip when the mounted backend does not confine (`fs.sandboxMode` undefined),
 * otherwise ask the shared `sandboxPolicy` service for the calling session.
 */
export async function resolveWritePolicy(ctx: Context & FsContext, exec: ToolRunContext): Promise<OfficeWritePolicy | undefined> {
  if (ctx.fs.sandboxMode === undefined) return undefined
  const service = typeof ctx.get === 'function'
    ? ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
    : undefined
  if (service === undefined || service === null) {
    throw new Error('office tools: the mounted filesystem confines but ctx.sandboxPolicy is missing')
  }
  if (typeof service.resolve !== 'function') return undefined
  return service.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
}

export interface ResolvedOfficePath {
  /** The path exactly as the model passed it. */
  input: string
  /** The backend's stable target for every subsequent operation. */
  target: FsTarget
  /** The backend's canonical absolute process path (display and extension source). */
  absolute: string
  /** Path rendered back to the model (workspace-relative when possible). */
  display: string
  /** Lowercased extension including the leading dot. */
  ext: string
}

function workspaceRootOf(exec: ToolRunContext): string {
  const cwd = exec.agent?.session.header.cwd
  if (cwd === undefined || cwd === '') {
    throw new Error('office tools require an active session with a working directory (session.header.cwd is empty)')
  }
  return resolve(cwd)
}

function displayPathOf(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolute
}

/**
 * Reject paths that lexically escape the session workspace before the
 * backend gets to weigh in; the backend's own containment (realpath-aware)
 * remains the authoritative second gate.
 */
function assertLexicallyWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path "${candidate}" escapes the session workspace "${root}"`)
  }
}

/**
 * Resolve one model-supplied path to a workspace-confined backend target.
 *
 * @param exec - the running tool call (carries the session cwd + abort signal).
 * @param rawPath - the model-supplied path string.
 * @param allowedExts - acceptable lowercased extensions WITH dots (e.g. `.docx`).
 * @param mustExist - when true, stat the target and refuse anything but a regular file.
 * @param writePolicy - the per-call write policy, when a sandbox controller is
 *   mounted; its `workspaceRoot` is the authoritative workspace the write is
 *   fenced to, so relative paths resolve against it exactly like the official
 *   fs tools do. Omitted (reads, bare backends) keeps the session cwd.
 */
export async function resolveOfficePath(
  exec: ToolRunContext,
  ctx: FsContext,
  rawPath: string,
  allowedExts: readonly string[],
  mustExist: boolean,
  writePolicy?: OfficeWritePolicy,
): Promise<ResolvedOfficePath> {
  exec.signal.throwIfAborted()
  if (rawPath.trim() === '') throw new Error('path must be a non-empty string')

  const root = workspaceRootOf(exec)
  const effectiveRoot = writePolicy?.workspaceRoot ? resolve(writePolicy.workspaceRoot) : root
  const candidate = resolve(isAbsolute(rawPath) ? rawPath : join(effectiveRoot, rawPath))
  assertLexicallyWithin(effectiveRoot, candidate)

  const ext = extname(candidate).toLowerCase()
  if (!allowedExts.includes(ext)) {
    throw new Error(`expected ${allowedExts.join(' or ')} file, got extension "${ext || '(none)'}"`)
  }

  const fs = ctx.fs
  const rootTarget = await fs.resolve('.', { cwd: effectiveRoot, signal: exec.signal })
  const target = await fs.resolve(rawPath, { cwd: effectiveRoot, signal: exec.signal })
  if (!fs.contains(rootTarget, target)) {
    throw new Error(`path "${rawPath}" escapes the session workspace "${root}"`)
  }
  const absolute = fs.processPath(target)

  if (mustExist) {
    const info = await fs.stat(target, exec.signal)
    if (info === undefined) throw new Error(`"${absolute}" does not exist`)
    if (info.type !== 'file') throw new Error(`"${absolute}" is not a regular file`)
  }

  return { input: rawPath, target, absolute, display: displayPathOf(root, absolute), ext }
}

/**
 * Read a bounded Office file through the backend, observing tool-call
 * cancellation and refusing files above the hard cap before any transfer.
 */
export async function readOfficeBytes(
  exec: ToolRunContext,
  ctx: FsContext,
  target: FsTarget,
): Promise<{ bytes: Uint8Array; sizeBytes: number }> {
  exec.signal.throwIfAborted()
  const fs = ctx.fs
  const info = await fs.stat(target, exec.signal)
  if (info === undefined) throw new Error('the file disappeared before it could be read')
  if (info.type !== 'file') throw new Error('the path is not a regular file')
  const declared = info.size ?? 0
  if (declared > MAX_OFFICE_FILE_BYTES) {
    throw new Error(`the file is ${declared} bytes; office tools refuse files larger than ${MAX_OFFICE_FILE_BYTES} bytes`)
  }
  const bytes = await fs.readBytes(target, exec.signal, MAX_OFFICE_FILE_BYTES)
  exec.signal.throwIfAborted()
  return { bytes, sizeBytes: bytes.byteLength }
}

/**
 * Publish one generated package: the text is pure ASCII (asserted by the zip
 * planner), so the backend's atomic UTF-8 write lands it on disk
 * byte-identical. The per-call write policy rides along as `writeText`'s
 * fifth parameter so a sandboxing backend fences the write by the session's
 * effective policy instead of its deployment default. Returns the on-disk size.
 */
export async function saveOfficeText(
  exec: ToolRunContext,
  ctx: FsContext,
  target: FsTarget,
  text: string,
  writePolicy?: OfficeWritePolicy,
): Promise<number> {
  exec.signal.throwIfAborted()
  await ctx.fs.writeText(target, text, undefined, exec.signal, writePolicy)
  exec.signal.throwIfAborted()
  return Buffer.byteLength(text, 'utf-8')
}

/**
 * Reject an overwrite when `overwrite` is false and the target already
 * exists. Callers use this BEFORE doing expensive generation so the model
 * gets a fast refusal instead of wasted work.
 */
export async function assertMayCreate(exec: ToolRunContext, ctx: FsContext, target: FsTarget, overwrite: boolean): Promise<void> {
  if (overwrite) return
  const info = await ctx.fs.stat(target, exec.signal)
  if (info !== undefined) {
    throw new Error('the target already exists; pass overwrite: true to replace it')
  }
}
