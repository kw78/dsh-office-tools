/**
 * Self-contained OOXML zip container (1.0.0).
 *
 * Two halves:
 *
 *  - `buildAsciiZip` WRITES a package whose every byte is at most 0x7F. All
 *    entries are STOREd and the planner pads each XML part with trailing
 *    newlines (legal after the root element) until every CRC-32, size, and
 *    offset field of the archive is itself ASCII-safe. That makes the whole
 *    document a pure-ASCII string, so it can travel through any UTF-8 text
 *    channel — specifically the official `ctx.fs.writeText` service — and land
 *    on disk byte-identical. No compression, no binary parts: this is the
 *    contract that keeps the plugin free of direct file-system access while
 *    still producing real .docx/.xlsx/.pptx files every Office suite opens.
 *
 *  - `readZip` READS any real-world OOXML package: STORE and DEFLATE entries
 *    (via node:zlib), bounded by the same declared-size budgets the jszip
 *    guard enforced in <=0.6.x — per-entry, total, and entry-count caps are
 *    checked against the central directory BEFORE anything is inflated.
 */
/** Hard cap for reading an existing Office file into memory. */
export declare const MAX_OFFICE_FILE_BYTES: number;
/** Declared uncompressed ceiling for one zip entry inside an Office file. */
export declare const MAX_ZIP_ENTRY_BYTES: number;
/** Declared uncompressed ceiling summed over all entries of one archive. */
export declare const MAX_ZIP_TOTAL_BYTES: number;
/** Maximum entries (files + directories) in one archive. */
export declare const MAX_ZIP_ENTRIES = 100000;
/** Overridable budgets so tests can trip the guard with tiny values. */
export interface ZipGuardLimits {
    maxEntryBytes?: number;
    maxTotalBytes?: number;
    maxEntries?: number;
}
/** ASCII-safe = every byte at most 0x7F, so UTF-8 encoding is the identity. */
export declare function assertAscii(value: string, label: string): void;
export interface ZipPart {
    name: string;
    content: string;
}
/**
 * Build the whole package as one ASCII-safe string: local STORE entries in
 * order, the central directory, and the end-of-central-directory record.
 */
export declare function buildAsciiZip(parts: ZipPart[]): string;
export interface ZipEntryInfo {
    name: string;
    method: number;
    compressedSize: number;
    uncompressedSize: number;
    localOffset: number;
}
export declare class ZipArchive {
    private readonly bytes;
    readonly entries: ReadonlyMap<string, ZipEntryInfo>;
    constructor(bytes: Uint8Array, entries: Map<string, ZipEntryInfo>);
    has(name: string): boolean;
    entryNames(): string[];
    entryCount(): number;
    /**
     * Raw (still compressed) bytes of one entry, located through its own local
     * header so central-directory offsets are never trusted for slicing.
     */
    entryBytes(name: string): Uint8Array;
    /** Inflated (stored or decompressed) bytes of one entry, bounded by its declared size. */
    private entryData;
    /** Decode one entry as UTF-8 text after inflating it when needed. */
    entryText(name: string): string;
    /** True when an entry's INFLATED content can round-trip an ASCII-safe rewrite. */
    entryIsAsciiSafe(name: string): boolean;
}
/**
 * Parse and guard one archive: the end-of-central-directory record is found
 * by scanning backwards, every entry's DECLARED uncompressed size is checked
 * against the budgets before anything is inflated, and every local slice is
 * re-derived from the entry's own local header.
 */
export declare function readZip(bytes: Uint8Array, limits?: ZipGuardLimits): ZipArchive;
/**
 * OOXML parts are plain element trees; a DOCTYPE/ENTITY declaration is never
 * legitimate in one. Our extractors never resolve entities, but we refuse to
 * look at such a part at all so entity-expansion payloads die at the door.
 */
export declare function assertNoXmlDtd(xml: string, label: string): void;
/**
 * Read one zip part as text and refuse DTD/entity-bearing XML before any
 * caller parses it. Returns null when the archive has no such part.
 */
export declare function readZipXmlPart(zip: ZipArchive, name: string): string | null;
/**
 * Materialize every file entry as text for an ASCII-safe re-emit. Any entry
 * with binary (non-ASCII) bytes throws: the re-publish path goes through the
 * official UTF-8 text channel and cannot round-trip binary parts.
 */
export declare function asciiPartsOf(zip: ZipArchive): ZipPart[];
