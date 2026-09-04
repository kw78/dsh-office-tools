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
 */
export declare function resolveOfficePath(exec: ToolRunContext, ctx: FsContext, rawPath: string, allowedExts: readonly string[], mustExist: boolean): Promise<ResolvedOfficePath>;
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
 * byte-identical. Returns the on-disk size.
 */
export declare function saveOfficeText(exec: ToolRunContext, ctx: FsContext, target: FsTarget, text: string): Promise<number>;
/**
 * Reject an overwrite when `overwrite` is false and the target already
 * exists. Callers use this BEFORE doing expensive generation so the model
 * gets a fast refusal instead of wasted work.
 */
export declare function assertMayCreate(exec: ToolRunContext, ctx: FsContext, target: FsTarget, overwrite: boolean): Promise<void>;
