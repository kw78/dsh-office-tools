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

import { inflateRawSync } from 'node:zlib'

/** Hard cap for reading an existing Office file into memory. */
export const MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024

/** Declared uncompressed ceiling for one zip entry inside an Office file. */
export const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024

/** Declared uncompressed ceiling summed over all entries of one archive. */
export const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024

/** Maximum entries (files + directories) in one archive. */
export const MAX_ZIP_ENTRIES = 100_000

/** Overridable budgets so tests can trip the guard with tiny values. */
export interface ZipGuardLimits {
  maxEntryBytes?: number
  maxTotalBytes?: number
  maxEntries?: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crcFold(state: number, byte: number): number {
  return ((CRC_TABLE[(state ^ byte) & 0xff]!) ^ (state >>> 8)) >>> 0
}

function crc32(bytes: Uint8Array): number {
  let state = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    state = crcFold(state, bytes[index]!)
  }
  return (state ^ 0xffffffff) >>> 0
}

/**
 * Rolling CRC state of a content string plus `padCount` trailing newlines:
 * fold the content once, then step one newline byte per pad. This keeps the
 * planner's retry loops O(limit) overall instead of O(limit^2).
 */
function rollingCrc(content: string, padCount: number): number {
  let state = 0xffffffff
  for (let index = 0; index < content.length; index += 1) {
    state = crcFold(state, content.charCodeAt(index))
  }
  for (let count = 0; count < padCount; count += 1) {
    state = crcFold(state, 0x0a)
  }
  return (state ^ 0xffffffff) >>> 0
}

function contentCrcState(content: string): number {
  let state = 0xffffffff
  for (let index = 0; index < content.length; index += 1) {
    state = crcFold(state, content.charCodeAt(index))
  }
  return state
}

/** Fold one more newline onto a mid-scan state and finalize. */
function crcAfterPad(state: number, padCount: number): number {
  for (let count = 0; count < padCount; count += 1) {
    state = crcFold(state, 0x0a)
  }
  return (state ^ 0xffffffff) >>> 0
}

/** ASCII-safe = every byte at most 0x7F, so UTF-8 encoding is the identity. */
export function assertAscii(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      throw new Error(`${label} contains a non-ASCII character at index ${index}; the writer requires ASCII-safe content (encode it as XML character references)`)
    }
  }
}

function asciiBytes(value: string): Uint8Array {
  assertAscii(value, 'zip content')
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index)
  return bytes
}

/** True when all four little-endian bytes of a field value stay at most 0x7F. */
function safeField(value: number): boolean {
  return value >= 0 && value <= 0x7f7f7f7f
    && (value & 0xff) <= 0x7f
    && ((value >>> 8) & 0xff) <= 0x7f
    && ((value >>> 16) & 0xff) <= 0x7f
    && ((value >>> 24) & 0xff) <= 0x7f
}

function u16(value: number): string {
  return String.fromCharCode(value & 0xff, (value >>> 8) & 0xff)
}

function u32(value: number): string {
  return String.fromCharCode(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

/** Fixed 2026-01-01 00:00:00 DOS timestamp; both little-endian bytes stay ASCII-safe. */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

const LOCAL_HEADER_BYTES = 30
const CENTRAL_HEADER_BYTES = 46
const EOCD_BYTES = 22

export interface ZipPart {
  name: string
  content: string
}

interface PlannedEntry {
  name: string
  content: string
  crc: number
  /** Slot-aligned, band-skipped local-header offset this entry is emitted at. */
  offset: number
  localExtraLength: number
  commentLength: number
  centralExtraLength: number
}

interface PlannedArchive {
  entries: PlannedEntry[]
  /** Offset the central directory starts at (band-skipped, safe by construction). */
  directoryOffset: number
}

/** A content string padded for the planner; length is its byte size. */
function padded(content: string, pad: number): string {
  return pad === 0 ? content : content + '\n'.repeat(pad)
}

/** Retry ceiling per entry: band crossings (see below) can need ~18 KiB. */
const MAX_PLAN_PAD = 0x10000

/**
 * One (extraLength, pad) pair that keeps an entry's own fields ASCII-safe:
 * the padded content's length and CRC-32, plus the NEXT entry's offset the
 * pair produces. `extraLength` bytes of local-header extra give the planner
 * base-byte freedom that padding alone cannot express (the size and offset
 * byte windows couple at base low byte 0x80 into an unsolvable pair).
 * Offsets inside the 0x8000..0xBFFF band of every 64 KiB page are never
 * field-safe, so packages pad PAST the band — hence the generous pad ceiling.
 */
function feasiblePlacement(content: string, offset: number, nameLength: number, maxExtra: number): { extraLength: number; pad: number } | undefined {
  if (!safeField(offset)) return undefined
  const baseLength = content.length
  const rootState = contentCrcState(content)
  for (let extraLength = 0; extraLength <= maxExtra; extraLength += 1) {
    let state = rootState
    const headerSize = LOCAL_HEADER_BYTES + nameLength + extraLength
    for (let pad = 0; pad <= MAX_PLAN_PAD; pad += 1) {
      if (pad > 0) state = crcFold(state, 0x0a)
      const length = baseLength + pad
      if (!safeField(length)) continue
      if (!safeField((state ^ 0xffffffff) >>> 0)) continue
      if (!safeField(offset + headerSize + length)) continue
      return { extraLength, pad }
    }
  }
  return undefined
}

/**
 * Plan the padding of every part so that each entry's CRC-32, compressed
 * (stored) size, local-header offset, the central-directory size, and the
 * central-directory offset are all ASCII-safe field values. Trailing
 * newlines after the XML root element keep the content valid XML while
 * giving the planner retry freedom; the final central-directory entry's
 * comment steers the directory size. Every choice is committed only after
 * the next part is confirmed feasible at the resulting offset.
 */
/**
 * Slot-aligned ASCII-safe planner.
 *
 * Every local header sits at a multiple of SLOT_BYTES (1 KiB), and the
 * 0x8000..0xBFFF band of every 64 KiB page — whose offsets can never be
 * field-safe — is skipped by jumping to the next page. Offsets are therefore
 * safe BY CONSTRUCTION: byte 0 is always 0x00 (alignment) and byte 1 is a
 * multiple of 4 below 0x80 (band skipping). With the next offset decoupled
 * from this entry's length, a simple greedy pass suffices: pad each part
 * with trailing newlines (legal after the XML root) until its own length
 * and CRC-32 are field-safe, growing the entry's slot count when the pad
 * budget runs out. Gaps between entries are inert bytes; readers locate
 * local headers through the central directory, exactly how every OOXML
 * consumer works.
 */
const SLOT_BYTES = 0x400

/** Round an aligned offset up past the unsafe 0x8000..0xBFFF band of its page. */
function skipUnsafeBand(offset: number): number {
  const high = (offset >>> 8) & 0xff
  if (high < 0x80 || high > 0xbf) return offset
  return (offset | 0xffff) + 1
}

function planEntries(parts: ZipPart[]): PlannedArchive {
  const planned: PlannedEntry[] = []
  let offset = 0
  for (const part of parts) {
    assertAscii(part.name, 'zip entry name')
    const nameLength = part.name.length
    const headerSize = LOCAL_HEADER_BYTES + nameLength
    const baseLength = part.content.length
    let slots = Math.max(1, Math.ceil((headerSize + baseLength) / SLOT_BYTES))
    let chosen: { content: string; crc: number } | undefined
    let entryNext = 0
    for (let growth = 0; growth < 512 && chosen === undefined; growth += 1) {
      const budget = slots * SLOT_BYTES - headerSize - baseLength
      if (budget < 0) {
        slots += 1
        continue
      }
      let state = contentCrcState(part.content)
      for (let pad = 0; pad <= budget; pad += 1) {
        if (pad > 0) state = crcFold(state, 0x0a)
        const length = baseLength + pad
        if (!safeField(length)) continue
        if (!safeField((state ^ 0xffffffff) >>> 0)) continue
        const content = pad === 0 ? part.content : part.content + '\n'.repeat(pad)
        chosen = { content, crc: (state ^ 0xffffffff) >>> 0 }
        entryNext = skipUnsafeBand(offset + slots * SLOT_BYTES)
        break
      }
      if (chosen === undefined) slots += 1
    }
    if (chosen === undefined) {
      throw new Error(`cannot lay out an ASCII-safe zip entry for "${part.name}" (offset=${offset})`)
    }
    planned.push({
      name: part.name,
      content: chosen.content,
      crc: chosen.crc,
      offset,
      localExtraLength: 0,
      commentLength: 0,
      centralExtraLength: 0,
    })
    offset = entryNext
  }
  // Steer the central-directory size with the last entry's comment (and,
  // when the comment byte alone cannot reach a safe value — the classic
  // 0x80 low byte — with a bounded central extra extra field) so the EOCD's
  // directory-size field and the steering fields themselves stay safe.
  const baseDirectorySize = planned.reduce((sum, entry) => sum + CENTRAL_HEADER_BYTES + entry.name.length, 0)
  let commentLength = -1
  let centralExtraLength = 0
  for (; centralExtraLength <= 0x7f; centralExtraLength += 1) {
    commentLength = 0
    while (commentLength <= 0x7f) {
      if (safeField(baseDirectorySize + centralExtraLength + commentLength)) break
      commentLength += 1
    }
    if (commentLength <= 0x7f) break
  }
  if (centralExtraLength > 0x7f || commentLength > 0x7f
    || !safeField(baseDirectorySize + centralExtraLength + commentLength)) {
    throw new Error('cannot lay out an ASCII-safe central directory size')
  }
  if (planned.length > 0) {
    const last = planned[planned.length - 1]!
    last.commentLength = commentLength
    last.centralExtraLength = centralExtraLength
  }
  return { entries: planned, directoryOffset: offset }
}

/**
 * Build the whole package as one ASCII-safe string: local STORE entries in
 * order, the central directory, and the end-of-central-directory record.
 */
export function buildAsciiZip(parts: ZipPart[]): string {
  if (parts.length === 0 || parts.length > 0x7f) {
    throw new Error(`an ASCII-safe package holds 1..127 entries, got ${parts.length}`)
  }
  const plan = planEntries(parts)
  const planned = plan.entries
  const local: string[] = []
  const central: string[] = []
  let cursor = 0
  for (const entry of planned) {
    const nameLength = entry.name.length
    const length = entry.content.length
    // Gap-fill to the planned slot offset so real offsets match the plan;
    // readers locate local headers through the central directory.
    if (entry.offset > cursor) local.push('\x00'.repeat(entry.offset - cursor))
    local.push(
      'PK\x03\x04', u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(entry.crc), u32(length), u32(length), u16(nameLength), u16(entry.localExtraLength),
      entry.name, '\x00'.repeat(entry.localExtraLength), entry.content,
    )
    central.push(
      'PK\x01\x02', u16(20), u16(20), u16(0), u16(0), u16(DOS_TIME), u16(DOS_DATE),
      u32(entry.crc), u32(length), u32(length), u16(nameLength), u16(entry.centralExtraLength),
      u16(entry.commentLength), u16(0), u16(0), u32(0), u32(entry.offset),
      entry.name, '\x00'.repeat(entry.centralExtraLength), 'd'.repeat(entry.commentLength),
    )
    cursor = entry.offset + LOCAL_HEADER_BYTES + nameLength + entry.localExtraLength + length
  }
  const directorySize = central.reduce((sum, chunk) => sum + chunk.length, 0)
  const directoryOffset = plan.directoryOffset
  if (!safeField(directorySize) || !safeField(directoryOffset)) {
    throw new Error('internal error: the planned central directory fields are not ASCII-safe')
  }
  const directoryGap = directoryOffset > cursor ? '\x00'.repeat(directoryOffset - cursor) : ''
  const eocd = ['PK\x05\x06', u16(0), u16(0), u16(planned.length), u16(planned.length),
    u32(directorySize), u32(directoryOffset), u16(0)].join('')
  const output = [...local, directoryGap, central.join(''), eocd].join('')
  assertAscii(output, 'zip output')
  return output
}

export interface ZipEntryInfo {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

export class ZipArchive {
  private readonly bytes: Uint8Array
  readonly entries: ReadonlyMap<string, ZipEntryInfo>

  constructor(bytes: Uint8Array, entries: Map<string, ZipEntryInfo>) {
    this.bytes = bytes
    this.entries = entries
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  entryNames(): string[] {
    return [...this.entries.keys()]
  }

  entryCount(): number {
    return this.entries.size
  }

  /**
   * Raw (still compressed) bytes of one entry, located through its own local
   * header so central-directory offsets are never trusted for slicing.
   */
  entryBytes(name: string): Uint8Array {
    const entry = this.entries.get(name)
    if (entry === undefined) throw new Error(`zip archive has no "${name}" entry`)
    const view = this.bytes
    const base = entry.localOffset
    if (base + LOCAL_HEADER_BYTES > view.length
      || view[base] !== 0x50 || view[base + 1] !== 0x4b || view[base + 2] !== 0x03 || view[base + 3] !== 0x04) {
      throw new Error(`zip entry "${name}" has no local header; the archive is corrupt`)
    }
    const nameLength = view[base + 26]! | (view[base + 27]! << 8)
    const extraLength = view[base + 28]! | (view[base + 29]! << 8)
    const start = base + LOCAL_HEADER_BYTES + nameLength + extraLength
    const end = start + entry.compressedSize
    if (end > view.length) throw new Error(`zip entry "${name}" is truncated`)
    return view.subarray(start, end)
  }

  /** Inflated (stored or decompressed) bytes of one entry, bounded by its declared size. */
  private entryData(name: string): Uint8Array {
    const entry = this.entries.get(name)
    if (entry === undefined) throw new Error(`zip archive has no "${name}" entry`)
    const raw = this.entryBytes(name)
    const data = entry.method === 0
      ? raw
      : inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize + 1 })
    if (data.length > entry.uncompressedSize) {
      throw new Error(`zip entry "${name}" produced more bytes than its declared size; refusing it`)
    }
    return data
  }

  /** Decode one entry as UTF-8 text after inflating it when needed. */
  entryText(name: string): string {
    return new TextDecoder('utf-8').decode(this.entryData(name))
  }

  /** True when an entry's INFLATED content can round-trip an ASCII-safe rewrite. */
  entryIsAsciiSafe(name: string): boolean {
    const data = this.entryData(name)
    for (let index = 0; index < data.length; index += 1) {
      if (data[index]! > 0x7f) return false
    }
    return true
  }
}

function readU16(view: Uint8Array, offset: number): number {
  return view[offset]! | (view[offset + 1]! << 8)
}

function readU32(view: Uint8Array, offset: number): number {
  return (view[offset]! | (view[offset + 1]! << 8) | (view[offset + 2]! << 16) | (view[offset + 3]! << 24)) >>> 0
}

/**
 * Parse and guard one archive: the end-of-central-directory record is found
 * by scanning backwards, every entry's DECLARED uncompressed size is checked
 * against the budgets before anything is inflated, and every local slice is
 * re-derived from the entry's own local header.
 */
export function readZip(bytes: Uint8Array, limits?: ZipGuardLimits): ZipArchive {
  const maxEntryBytes = limits?.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES
  const maxTotalBytes = limits?.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES
  const maxEntries = limits?.maxEntries ?? MAX_ZIP_ENTRIES

  if (bytes.length < EOCD_BYTES + 4) {
    throw new Error('not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): too short')
  }
  let eocd = -1
  const scanStart = Math.max(0, bytes.length - EOCD_BYTES - 0xffff)
  for (let index = bytes.length - EOCD_BYTES; index >= scanStart; index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) {
      eocd = index
      break
    }
  }
  if (eocd === -1) {
    throw new Error('not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): no end-of-central-directory record')
  }
  const entryTotal = readU16(bytes, eocd + 10)
  const directorySize = readU32(bytes, eocd + 12)
  const directoryOffset = readU32(bytes, eocd + 16)
  if (entryTotal > maxEntries) {
    throw new Error(`zip archive holds ${entryTotal} entries; office tools refuse archives with more than ${maxEntries}`)
  }
  if (directoryOffset + directorySize > bytes.length) {
    throw new Error('not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): central directory out of bounds')
  }

  const entries = new Map<string, ZipEntryInfo>()
  let cursor = directoryOffset
  for (let count = 0; count < entryTotal; count += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > bytes.length
      || bytes[cursor] !== 0x50 || bytes[cursor + 1] !== 0x4b || bytes[cursor + 2] !== 0x01 || bytes[cursor + 3] !== 0x02) {
      throw new Error('not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): broken central directory entry')
    }
    const method = readU16(bytes, cursor + 10)
    const compressedSize = readU32(bytes, cursor + 20)
    const uncompressedSize = readU32(bytes, cursor + 24)
    const nameLength = readU16(bytes, cursor + 28)
    const extraLength = readU16(bytes, cursor + 30)
    const commentLength = readU16(bytes, cursor + 32)
    const localOffset = readU32(bytes, cursor + 42)
    const nameStart = cursor + CENTRAL_HEADER_BYTES
    const nameEnd = nameStart + nameLength
    if (nameEnd + extraLength + commentLength > bytes.length) {
      throw new Error('not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): truncated central directory entry')
    }
    const name = new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameEnd))
    cursor = nameEnd + extraLength + commentLength
    if (name.endsWith('/') || name === '') continue
    if (method !== 0 && method !== 8) {
      throw new Error(`zip entry "${name}" uses unsupported compression method ${method}; office tools accept stored and deflated entries only`)
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new Error(`zip entry "${name}" declares ${uncompressedSize} uncompressed bytes; office tools refuse entries above ${maxEntryBytes} bytes`)
    }
    const previous = entries.get(name)
    if (previous !== undefined) {
      throw new Error(`zip archive declares the entry "${name}" twice; refusing it`)
    }
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset })
  }

  let totalBytes = 0
  for (const entry of entries.values()) {
    totalBytes += entry.uncompressedSize
    if (totalBytes > maxTotalBytes) {
      throw new Error(`zip archive declares more than ${maxTotalBytes} uncompressed bytes in total (at least ${totalBytes} after "${entry.name}"); refusing to inflate it`)
    }
  }
  return new ZipArchive(bytes, entries)
}

/**
 * OOXML parts are plain element trees; a DOCTYPE/ENTITY declaration is never
 * legitimate in one. Our extractors never resolve entities, but we refuse to
 * look at such a part at all so entity-expansion payloads die at the door.
 */
export function assertNoXmlDtd(xml: string, label: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error(`${label} contains a DOCTYPE/ENTITY declaration; office tools refuse such XML parts`)
  }
}

/**
 * Read one zip part as text and refuse DTD/entity-bearing XML before any
 * caller parses it. Returns null when the archive has no such part.
 */
export function readZipXmlPart(zip: ZipArchive, name: string): string | null {
  if (!zip.has(name)) return null
  const xml = zip.entryText(name)
  assertNoXmlDtd(xml, name)
  return xml
}

/**
 * Materialize every file entry as text for an ASCII-safe re-emit. Any entry
 * with binary (non-ASCII) bytes throws: the re-publish path goes through the
 * official UTF-8 text channel and cannot round-trip binary parts.
 */
export function asciiPartsOf(zip: ZipArchive): ZipPart[] {
  const parts: ZipPart[] = []
  for (const name of zip.entryNames()) {
    if (!zip.entryIsAsciiSafe(name)) {
      throw new Error(`zip entry "${name}" contains binary (non-ASCII) bytes; this rewrite path publishes through the official UTF-8 text channel and cannot round-trip binary parts`)
    }
    parts.push({ name, content: zip.entryText(name) })
  }
  return parts
}
