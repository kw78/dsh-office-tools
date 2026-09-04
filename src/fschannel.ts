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
 * size caps, overwrite refusal, display paths).
 */

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
 */
export async function resolveOfficePath(
  exec: ToolRunContext,
  ctx: FsContext,
  rawPath: string,
  allowedExts: readonly string[],
  mustExist: boolean,
): Promise<ResolvedOfficePath> {
  exec.signal.throwIfAborted()
  if (rawPath.trim() === '') throw new Error('path must be a non-empty string')

  const root = workspaceRootOf(exec)
  const candidate = resolve(isAbsolute(rawPath) ? rawPath : join(root, rawPath))
  assertLexicallyWithin(root, candidate)

  const ext = extname(candidate).toLowerCase()
  if (!allowedExts.includes(ext)) {
    throw new Error(`expected ${allowedExts.join(' or ')} file, got extension "${ext || '(none)'}"`)
  }

  const fs = ctx.fs
  const rootTarget = await fs.resolve('.', { cwd: root, signal: exec.signal })
  const target = await fs.resolve(rawPath, { cwd: root, signal: exec.signal })
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
 * byte-identical. Returns the on-disk size.
 */
export async function saveOfficeText(
  exec: ToolRunContext,
  ctx: FsContext,
  target: FsTarget,
  text: string,
): Promise<number> {
  exec.signal.throwIfAborted()
  await ctx.fs.writeText(target, text, undefined, exec.signal)
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
