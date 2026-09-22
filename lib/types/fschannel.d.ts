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
import type { Context } from '@deepseek-ai/cordis';
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
/** Cap for text materialized into a single tool result. */
export declare const MAX_TEXT_CHARS = 200000;
/** Cap for worksheet cells materialized into a single tool result. */
export declare const MAX_READ_CELLS = 200000;
/** Cap for worksheet cells accepted by one create/update call. */
export declare const MAX_WRITE_CELLS = 200000;
/** The slice of the Cordis context this suite consumes: the official fs service. */
export interface FsContext {
    fs: FileSystem;
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
export type OfficeWritePolicy = NonNullable<Parameters<FileSystem['writeText']>[4]>;
/**
 * Resolve the per-call write policy the way the official fs tool layer does:
 * skip when the mounted backend does not confine (`fs.sandboxMode` undefined),
 * otherwise ask the shared `sandboxPolicy` service for the calling session.
 */
export declare function resolveWritePolicy(ctx: Context & FsContext, exec: ToolRunContext): Promise<OfficeWritePolicy | undefined>;
export interface ResolvedOfficePath {
    /** The path exactly as the model passed it. */
    input: string;
    /** The backend's stable target for every subsequent operation. */
    target: FsTarget;
    /** The backend's canonical absolute process path (display and extension source). */
    absolute: string;
    /** Path rendered back to the model (workspace-relative when possible). */
    display: string;
    /** Lowercased extension including the leading dot. */
    ext: string;
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
export declare function resolveOfficePath(exec: ToolRunContext, ctx: FsContext, rawPath: string, allowedExts: readonly string[], mustExist: boolean, writePolicy?: OfficeWritePolicy): Promise<ResolvedOfficePath>;
/**
 * Read a bounded Office file through the backend, observing tool-call
 * cancellation and refusing files above the hard cap before any transfer.
 */
export declare function readOfficeBytes(exec: ToolRunContext, ctx: FsContext, target: FsTarget): Promise<{
    bytes: Uint8Array;
    sizeBytes: number;
}>;
/**
 * Publish one generated package: the text is pure ASCII (asserted by the zip
 * planner), so the backend's atomic UTF-8 write lands it on disk
 * byte-identical. The per-call write policy rides along as `writeText`'s
 * fifth parameter so a sandboxing backend fences the write by the session's
 * effective policy instead of its deployment default. Returns the on-disk size.
 */
export declare function saveOfficeText(exec: ToolRunContext, ctx: FsContext, target: FsTarget, text: string, writePolicy?: OfficeWritePolicy): Promise<number>;
/**
 * Reject an overwrite when `overwrite` is false and the target already
 * exists. Callers use this BEFORE doing expensive generation so the model
 * gets a fast refusal instead of wasted work.
 */
export declare function assertMayCreate(exec: ToolRunContext, ctx: FsContext, target: FsTarget, overwrite: boolean): Promise<void>;
