// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/tools/excel.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/asciizip.ts
import { inflateRawSync } from "node:zlib";
var MAX_OFFICE_FILE_BYTES = 50 * 1024 * 1024;
var MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024;
var MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
var MAX_ZIP_ENTRIES = 1e5;
var CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();
function crcFold(state, byte) {
  return (CRC_TABLE[(state ^ byte) & 255] ^ state >>> 8) >>> 0;
}
function contentCrcState(content) {
  let state = 4294967295;
  for (let index = 0; index < content.length; index += 1) {
    state = crcFold(state, content.charCodeAt(index));
  }
  return state;
}
function assertAscii(value, label) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 127) {
      throw new Error(`${label} contains a non-ASCII character at index ${index}; the writer requires ASCII-safe content (encode it as XML character references)`);
    }
  }
}
function safeField(value) {
  return value >= 0 && value <= 2139062143 && (value & 255) <= 127 && (value >>> 8 & 255) <= 127 && (value >>> 16 & 255) <= 127 && (value >>> 24 & 255) <= 127;
}
function u16(value) {
  return String.fromCharCode(value & 255, value >>> 8 & 255);
}
function u32(value) {
  return String.fromCharCode(value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255);
}
var DOS_TIME = 0;
var DOS_DATE = 2026 - 1980 << 9 | 1 << 5 | 1;
var LOCAL_HEADER_BYTES = 30;
var CENTRAL_HEADER_BYTES = 46;
var EOCD_BYTES = 22;
var SLOT_BYTES = 1024;
function skipUnsafeBand(offset) {
  const high = offset >>> 8 & 255;
  if (high < 128 || high > 191) return offset;
  return (offset | 65535) + 1;
}
function planEntries(parts) {
  const planned = [];
  let offset = 0;
  for (const part of parts) {
    assertAscii(part.name, "zip entry name");
    const nameLength = part.name.length;
    const headerSize = LOCAL_HEADER_BYTES + nameLength;
    const baseLength = part.content.length;
    let slots = Math.max(1, Math.ceil((headerSize + baseLength) / SLOT_BYTES));
    let chosen;
    let entryNext = 0;
    for (let growth = 0; growth < 512 && chosen === void 0; growth += 1) {
      const budget = slots * SLOT_BYTES - headerSize - baseLength;
      if (budget < 0) {
        slots += 1;
        continue;
      }
      let state = contentCrcState(part.content);
      for (let pad = 0; pad <= budget; pad += 1) {
        if (pad > 0) state = crcFold(state, 10);
        const length = baseLength + pad;
        if (!safeField(length)) continue;
        if (!safeField((state ^ 4294967295) >>> 0)) continue;
        const content = pad === 0 ? part.content : part.content + "\n".repeat(pad);
        chosen = { content, crc: (state ^ 4294967295) >>> 0 };
        entryNext = skipUnsafeBand(offset + slots * SLOT_BYTES);
        break;
      }
      if (chosen === void 0) slots += 1;
    }
    if (chosen === void 0) {
      throw new Error(`cannot lay out an ASCII-safe zip entry for "${part.name}" (offset=${offset})`);
    }
    planned.push({
      name: part.name,
      content: chosen.content,
      crc: chosen.crc,
      offset,
      localExtraLength: 0,
      commentLength: 0,
      centralExtraLength: 0
    });
    offset = entryNext;
  }
  const baseDirectorySize = planned.reduce((sum, entry) => sum + CENTRAL_HEADER_BYTES + entry.name.length, 0);
  let commentLength = -1;
  let centralExtraLength = 0;
  for (; centralExtraLength <= 127; centralExtraLength += 1) {
    commentLength = 0;
    while (commentLength <= 127) {
      if (safeField(baseDirectorySize + centralExtraLength + commentLength)) break;
      commentLength += 1;
    }
    if (commentLength <= 127) break;
  }
  if (centralExtraLength > 127 || commentLength > 127 || !safeField(baseDirectorySize + centralExtraLength + commentLength)) {
    throw new Error("cannot lay out an ASCII-safe central directory size");
  }
  if (planned.length > 0) {
    const last = planned[planned.length - 1];
    last.commentLength = commentLength;
    last.centralExtraLength = centralExtraLength;
  }
  return { entries: planned, directoryOffset: offset };
}
function buildAsciiZip(parts) {
  if (parts.length === 0 || parts.length > 127) {
    throw new Error(`an ASCII-safe package holds 1..127 entries, got ${parts.length}`);
  }
  const plan = planEntries(parts);
  const planned = plan.entries;
  const local = [];
  const central = [];
  let cursor = 0;
  for (const entry of planned) {
    const nameLength = entry.name.length;
    const length = entry.content.length;
    if (entry.offset > cursor) local.push("\0".repeat(entry.offset - cursor));
    local.push(
      "PK",
      u16(20),
      u16(0),
      u16(0),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(entry.crc),
      u32(length),
      u32(length),
      u16(nameLength),
      u16(entry.localExtraLength),
      entry.name,
      "\0".repeat(entry.localExtraLength),
      entry.content
    );
    central.push(
      "PK",
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(entry.crc),
      u32(length),
      u32(length),
      u16(nameLength),
      u16(entry.centralExtraLength),
      u16(entry.commentLength),
      u16(0),
      u16(0),
      u32(0),
      u32(entry.offset),
      entry.name,
      "\0".repeat(entry.centralExtraLength),
      "d".repeat(entry.commentLength)
    );
    cursor = entry.offset + LOCAL_HEADER_BYTES + nameLength + entry.localExtraLength + length;
  }
  const directorySize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const directoryOffset = plan.directoryOffset;
  if (!safeField(directorySize) || !safeField(directoryOffset)) {
    throw new Error("internal error: the planned central directory fields are not ASCII-safe");
  }
  const directoryGap = directoryOffset > cursor ? "\0".repeat(directoryOffset - cursor) : "";
  const eocd = [
    "PK",
    u16(0),
    u16(0),
    u16(planned.length),
    u16(planned.length),
    u32(directorySize),
    u32(directoryOffset),
    u16(0)
  ].join("");
  const output = [...local, directoryGap, central.join(""), eocd].join("");
  assertAscii(output, "zip output");
  return output;
}
var ZipArchive = class {
  bytes;
  entries;
  constructor(bytes, entries) {
    this.bytes = bytes;
    this.entries = entries;
  }
  has(name2) {
    return this.entries.has(name2);
  }
  entryNames() {
    return [...this.entries.keys()];
  }
  entryCount() {
    return this.entries.size;
  }
  /**
   * Raw (still compressed) bytes of one entry, located through its own local
   * header so central-directory offsets are never trusted for slicing.
   */
  entryBytes(name2) {
    const entry = this.entries.get(name2);
    if (entry === void 0) throw new Error(`zip archive has no "${name2}" entry`);
    const view = this.bytes;
    const base = entry.localOffset;
    if (base + LOCAL_HEADER_BYTES > view.length || view[base] !== 80 || view[base + 1] !== 75 || view[base + 2] !== 3 || view[base + 3] !== 4) {
      throw new Error(`zip entry "${name2}" has no local header; the archive is corrupt`);
    }
    const nameLength = view[base + 26] | view[base + 27] << 8;
    const extraLength = view[base + 28] | view[base + 29] << 8;
    const start = base + LOCAL_HEADER_BYTES + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > view.length) throw new Error(`zip entry "${name2}" is truncated`);
    return view.subarray(start, end);
  }
  /** Inflated (stored or decompressed) bytes of one entry, bounded by its declared size. */
  entryData(name2) {
    const entry = this.entries.get(name2);
    if (entry === void 0) throw new Error(`zip archive has no "${name2}" entry`);
    const raw = this.entryBytes(name2);
    const data = entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize + 1 });
    if (data.length > entry.uncompressedSize) {
      throw new Error(`zip entry "${name2}" produced more bytes than its declared size; refusing it`);
    }
    return data;
  }
  /** Decode one entry as UTF-8 text after inflating it when needed. */
  entryText(name2) {
    return new TextDecoder("utf-8").decode(this.entryData(name2));
  }
  /** True when an entry's INFLATED content can round-trip an ASCII-safe rewrite. */
  entryIsAsciiSafe(name2) {
    const data = this.entryData(name2);
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] > 127) return false;
    }
    return true;
  }
};
function readU16(view, offset) {
  return view[offset] | view[offset + 1] << 8;
}
function readU32(view, offset) {
  return (view[offset] | view[offset + 1] << 8 | view[offset + 2] << 16 | view[offset + 3] << 24) >>> 0;
}
function readZip(bytes, limits) {
  const maxEntryBytes = limits?.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxTotalBytes = limits?.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  const maxEntries = limits?.maxEntries ?? MAX_ZIP_ENTRIES;
  if (bytes.length < EOCD_BYTES + 4) {
    throw new Error("not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): too short");
  }
  let eocd = -1;
  const scanStart = Math.max(0, bytes.length - EOCD_BYTES - 65535);
  for (let index = bytes.length - EOCD_BYTES; index >= scanStart; index -= 1) {
    if (bytes[index] === 80 && bytes[index + 1] === 75 && bytes[index + 2] === 5 && bytes[index + 3] === 6) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): no end-of-central-directory record");
  }
  const entryTotal = readU16(bytes, eocd + 10);
  const directorySize = readU32(bytes, eocd + 12);
  const directoryOffset = readU32(bytes, eocd + 16);
  if (entryTotal > maxEntries) {
    throw new Error(`zip archive holds ${entryTotal} entries; office tools refuse archives with more than ${maxEntries}`);
  }
  if (directoryOffset + directorySize > bytes.length) {
    throw new Error("not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): central directory out of bounds");
  }
  const entries = /* @__PURE__ */ new Map();
  let cursor = directoryOffset;
  for (let count = 0; count < entryTotal; count += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > bytes.length || bytes[cursor] !== 80 || bytes[cursor + 1] !== 75 || bytes[cursor + 2] !== 1 || bytes[cursor + 3] !== 2) {
      throw new Error("not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): broken central directory entry");
    }
    const method = readU16(bytes, cursor + 10);
    const compressedSize = readU32(bytes, cursor + 20);
    const uncompressedSize = readU32(bytes, cursor + 24);
    const nameLength = readU16(bytes, cursor + 28);
    const extraLength = readU16(bytes, cursor + 30);
    const commentLength = readU16(bytes, cursor + 32);
    const localOffset = readU32(bytes, cursor + 42);
    const nameStart = cursor + CENTRAL_HEADER_BYTES;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > bytes.length) {
      throw new Error("not a readable zip archive (Office files must be valid .docx/.xlsx/.pptx zips): truncated central directory entry");
    }
    const name2 = new TextDecoder("utf-8").decode(bytes.subarray(nameStart, nameEnd));
    cursor = nameEnd + extraLength + commentLength;
    if (name2.endsWith("/") || name2 === "") continue;
    if (method !== 0 && method !== 8) {
      throw new Error(`zip entry "${name2}" uses unsupported compression method ${method}; office tools accept stored and deflated entries only`);
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new Error(`zip entry "${name2}" declares ${uncompressedSize} uncompressed bytes; office tools refuse entries above ${maxEntryBytes} bytes`);
    }
    const previous = entries.get(name2);
    if (previous !== void 0) {
      throw new Error(`zip archive declares the entry "${name2}" twice; refusing it`);
    }
    entries.set(name2, { name: name2, method, compressedSize, uncompressedSize, localOffset });
  }
  let totalBytes = 0;
  for (const entry of entries.values()) {
    totalBytes += entry.uncompressedSize;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`zip archive declares more than ${maxTotalBytes} uncompressed bytes in total (at least ${totalBytes} after "${entry.name}"); refusing to inflate it`);
    }
  }
  return new ZipArchive(bytes, entries);
}
function assertNoXmlDtd(xml, label) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error(`${label} contains a DOCTYPE/ENTITY declaration; office tools refuse such XML parts`);
  }
}
function readZipXmlPart(zip, name2) {
  if (!zip.has(name2)) return null;
  const xml = zip.entryText(name2);
  assertNoXmlDtd(xml, name2);
  return xml;
}
function asciiPartsOf(zip) {
  const parts = [];
  for (const name2 of zip.entryNames()) {
    if (!zip.entryIsAsciiSafe(name2)) {
      throw new Error(`zip entry "${name2}" contains binary (non-ASCII) bytes; this rewrite path publishes through the official UTF-8 text channel and cannot round-trip binary parts`);
    }
    parts.push({ name: name2, content: zip.entryText(name2) });
  }
  return parts;
}

// src/fschannel.ts
import { extname, isAbsolute, join, relative, resolve } from "node:path";
var MAX_TEXT_CHARS = 2e5;
var MAX_READ_CELLS = 2e5;
var MAX_WRITE_CELLS = 2e5;
function workspaceRootOf(exec) {
  const cwd = exec.agent?.session.header.cwd;
  if (cwd === void 0 || cwd === "") {
    throw new Error("office tools require an active session with a working directory (session.header.cwd is empty)");
  }
  return resolve(cwd);
}
function displayPathOf(root, absolute) {
  const rel = relative(root, absolute);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}
function assertLexicallyWithin(root, candidate) {
  const rel = relative(root, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path "${candidate}" escapes the session workspace "${root}"`);
  }
}
async function resolveOfficePath(exec, ctx, rawPath, allowedExts, mustExist) {
  exec.signal.throwIfAborted();
  if (rawPath.trim() === "") throw new Error("path must be a non-empty string");
  const root = workspaceRootOf(exec);
  const candidate = resolve(isAbsolute(rawPath) ? rawPath : join(root, rawPath));
  assertLexicallyWithin(root, candidate);
  const ext = extname(candidate).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new Error(`expected ${allowedExts.join(" or ")} file, got extension "${ext || "(none)"}"`);
  }
  const fs = ctx.fs;
  const rootTarget = await fs.resolve(".", { cwd: root, signal: exec.signal });
  const target = await fs.resolve(rawPath, { cwd: root, signal: exec.signal });
  if (!fs.contains(rootTarget, target)) {
    throw new Error(`path "${rawPath}" escapes the session workspace "${root}"`);
  }
  const absolute = fs.processPath(target);
  if (mustExist) {
    const info = await fs.stat(target, exec.signal);
    if (info === void 0) throw new Error(`"${absolute}" does not exist`);
    if (info.type !== "file") throw new Error(`"${absolute}" is not a regular file`);
  }
  return { input: rawPath, target, absolute, display: displayPathOf(root, absolute), ext };
}
async function readOfficeBytes(exec, ctx, target) {
  exec.signal.throwIfAborted();
  const fs = ctx.fs;
  const info = await fs.stat(target, exec.signal);
  if (info === void 0) throw new Error("the file disappeared before it could be read");
  if (info.type !== "file") throw new Error("the path is not a regular file");
  const declared = info.size ?? 0;
  if (declared > MAX_OFFICE_FILE_BYTES) {
    throw new Error(`the file is ${declared} bytes; office tools refuse files larger than ${MAX_OFFICE_FILE_BYTES} bytes`);
  }
  const bytes = await fs.readBytes(target, exec.signal, MAX_OFFICE_FILE_BYTES);
  exec.signal.throwIfAborted();
  return { bytes, sizeBytes: bytes.byteLength };
}
async function saveOfficeText(exec, ctx, target, text) {
  exec.signal.throwIfAborted();
  await ctx.fs.writeText(target, text, void 0, exec.signal);
  exec.signal.throwIfAborted();
  return Buffer.byteLength(text, "utf-8");
}
async function assertMayCreate(exec, ctx, target, overwrite) {
  if (overwrite) return;
  const info = await ctx.fs.stat(target, exec.signal);
  if (info !== void 0) {
    throw new Error("the target already exists; pass overwrite: true to replace it");
  }
}

// src/tools/shared.ts
var CELL_VALUE_SCHEMA = {
  oneOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" }
  ]
};
var ROW_SCHEMA = {
  type: "array",
  items: CELL_VALUE_SCHEMA
};
var FILE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    sizeBytes: { type: "integer", required: true }
  }
};
function encodeXmlChar(code) {
  if (code > 127) return `&#${code};`;
  if (code < 32 && code !== 9 && code !== 10 && code !== 13) return "";
  return String.fromCharCode(code);
}
function encodeXmlText(value) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else out += encodeXmlChar(code);
  }
  return out;
}
function encodeXmlAttribute(value) {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else out += encodeXmlChar(code);
  }
  return out;
}
function decodeXmlEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity, code) => {
    if (code === "amp") return "&";
    if (code === "lt") return "<";
    if (code === "gt") return ">";
    if (code === "quot") return '"';
    if (code === "apos") return "'";
    const number = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
  });
}

// src/tools/excel.ts
var SHEET_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    rowCount: { type: "integer", required: true },
    colCount: { type: "integer", required: true }
  }
};
var EXCEL_CREATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    sheets: {
      type: "array",
      required: true,
      items: SHEET_RESULT_SCHEMA
    }
  }
};
var READ_SHEET_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", required: true },
    rows: {
      type: "array",
      required: true,
      items: ROW_SCHEMA
    },
    truncated: { type: "boolean", required: true }
  }
};
var EXCEL_READ_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    sheets: {
      type: "array",
      required: true,
      items: READ_SHEET_RESULT_SCHEMA
    },
    sizeBytes: { type: "integer", required: true }
  }
};
var CELL_UPDATE_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    sheet: { type: "string", required: true },
    cell: { type: "string", required: true }
  }
};
var EXCEL_UPDATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    sheetNames: {
      type: "array",
      required: true,
      items: { type: "string" }
    },
    updatedSheets: {
      type: "array",
      required: true,
      items: { type: "string" }
    },
    cellUpdates: {
      type: "array",
      required: true,
      items: CELL_UPDATE_RESULT_SCHEMA
    }
  }
};
function validateSheetSpecs(sheets) {
  if (sheets.length === 0) throw new Error("sheets must contain at least one sheet");
  const seen = /* @__PURE__ */ new Set();
  let totalCells = 0;
  let totalRows = 0;
  for (const sheet of sheets) {
    if (sheet.name.trim() === "") throw new Error("sheet name must be a non-empty string");
    if (seen.has(sheet.name)) throw new Error(`duplicate sheet name "${sheet.name}" in one call`);
    seen.add(sheet.name);
    if (sheet.rows.length > 1e4) throw new Error(`sheet "${sheet.name}" has too many rows (maximum 10000)`);
    totalRows += sheet.rows.length;
    for (const row of sheet.rows) {
      totalCells += row.length;
      if (totalCells > MAX_WRITE_CELLS) throw new Error(`too many worksheet cells (maximum ${MAX_WRITE_CELLS})`);
    }
  }
  if (totalRows === 0) throw new Error("at least one row is required across the sheets");
}
function columnName(index) {
  let name2 = "";
  let value = index;
  do {
    name2 = String.fromCharCode(65 + value % 26) + name2;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name2;
}
function columnIndexOf(name2) {
  let value = 0;
  for (const char of name2.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    value = value * 26 + (code - 64);
  }
  return value - 1;
}
function parseCellAddress(address) {
  const match = address.match(/^([A-Za-z]+)([1-9][0-9]*)$/);
  if (match === null) return { row: -1, column: -1 };
  return { row: Number.parseInt(match[2], 10) - 1, column: columnIndexOf(match[1]) };
}
function cellAddress(row, column) {
  return `${columnName(column)}${row + 1}`;
}
function gridAddresses(grid) {
  const addresses = [...grid.keys()].map((address) => {
    const { row, column } = parseCellAddress(address);
    return { address, row, column };
  }).filter((item) => item.row >= 0 && item.column >= 0 && grid.get(item.address) !== void 0);
  addresses.sort((left, right) => left.row - right.row || left.column - right.column);
  return addresses;
}
function gridOf(rows) {
  const grid = /* @__PURE__ */ new Map();
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      grid.set(cellAddress(rowIndex, columnIndex), gridCellOf(value));
    });
  });
  return grid;
}
function gridCellOf(value) {
  if (typeof value === "string" && value.startsWith("=")) {
    return { kind: "formula", formula: value.slice(1) };
  }
  return { kind: "value", value };
}
function cellXml(address, cell) {
  if (cell.kind === "formula") {
    return `<c r="${address}" t="e"><f>${encodeXmlText(cell.formula)}</f></c>`;
  }
  const value = cell.value;
  if (value === null) return `<c r="${address}" t="inlineStr"><is><t/></is></c>`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cell ${address} holds a non-finite number; excel tools refuse it`);
    return `<c r="${address}"><v>${value}</v></c>`;
  }
  if (typeof value === "boolean") {
    return `<c r="${address}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  if (value === "") return `<c r="${address}" t="inlineStr"><is><t/></is></c>`;
  if (typeof value === "string" && value.startsWith("=")) {
    return `<c r="${address}" t="e"><f>${encodeXmlText(value.slice(1))}</f></c>`;
  }
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${encodeXmlText(value)}</t></is></c>`;
}
function sheetXml(grid) {
  const addresses = gridAddresses(grid);
  const rows = /* @__PURE__ */ new Map();
  for (const item of addresses) {
    const cells = rows.get(item.row) ?? [];
    cells.push(cellXml(item.address, grid.get(item.address)));
    rows.set(item.row, cells);
  }
  const last = addresses.at(-1);
  const dimension = last === void 0 ? "A1" : `A1:${last.address}`;
  const body = [...rows.entries()].sort((left, right) => left[0] - right[0]).map(([rowIndex, cells]) => `<row r="${rowIndex + 1}">${cells.join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/><sheetData>${body}</sheetData></worksheet>`;
}
var XLSX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
var XLSX_ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
var XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>';
var XLSX_APP_PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>dsh-office-tools</Application></Properties>';
var XLSX_CORE_PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Workbook</dc:title></cp:coreProperties>';
function buildXlsxText(models) {
  const workbookSheets = models.map((model, index) => `<sheet name="${encodeXmlAttribute(model.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`;
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + models.map((model, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${encodeXmlAttribute(model.part)}"/>`).join("") + "</Relationships>";
  const parts = [
    { name: "[Content_Types].xml", content: XLSX_CONTENT_TYPES },
    { name: "_rels/.rels", content: XLSX_ROOT_RELS },
    { name: "xl/workbook.xml", content: workbook },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRels },
    { name: "xl/styles.xml", content: XLSX_STYLES },
    { name: "docProps/core.xml", content: XLSX_CORE_PROPS },
    { name: "docProps/app.xml", content: XLSX_APP_PROPS }
  ];
  for (const model of models) {
    parts.push({ name: `xl/${model.part}`, content: model.content });
  }
  return buildAsciiZip(parts);
}
var SHARED_STRING_ITEM = /<si>([\s\S]*?)<\/si>/g;
var SHARED_STRING_TEXT = /<t\b[^>]*>([\s\S]*?)<\/w:t>|<t\b[^>]*>([\s\S]*?)<\/t>/g;
function parseSharedStrings(xml) {
  const values = [];
  for (const item of xml.matchAll(SHARED_STRING_ITEM)) {
    let text = "";
    for (const run of (item[1] ?? "").matchAll(SHARED_STRING_TEXT)) {
      text += decodeXmlEntities(run[1] ?? run[2] ?? "");
    }
    values.push(text);
  }
  return values;
}
var WORKBOOK_SHEET = /<sheet\b[^>]*?name="([^"]*)"[^>]*?(?:r:id="([^"]*)")?[^>]*?\/>/g;
var RELATIONSHIP = /<Relationship\b[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/>/g;
var SHEET_ROW = /<row\b[^>]*?r="(\d+)"[^>]*?>([\s\S]*?)<\/row>/g;
var SHEET_CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
var CELL_REF = /\br="([A-Za-z]+)(\d+)"/;
var CELL_TYPE = /\bt="([^"]*)"/;
var CELL_VALUE = /<v\b[^>]*>([\s\S]*?)<\/v>/;
var CELL_FORMULA = /<f\b[^>]*>([\s\S]*?)<\/f>/;
var CELL_INLINE_TEXT = /<t\b[^>]*>([\s\S]*?)<\/t>/;
function worksheetRows(grid) {
  const addresses = gridAddresses(grid);
  if (addresses.length === 0) return [];
  const lastRow = addresses[addresses.length - 1].row;
  const lastColumn = addresses.reduce((width, item) => Math.max(width, item.column), 0);
  const rows = [];
  for (let rowIndex = 0; rowIndex <= lastRow; rowIndex += 1) {
    const row = [];
    let hasValue = false;
    for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
      const value = gridCellToValue(grid.get(cellAddress(rowIndex, columnIndex)));
      if (value !== null) hasValue = true;
      row.push(value);
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}
function gridCellToValue(cell) {
  if (cell === void 0) return null;
  if (cell.kind === "formula") return `=${cell.formula}`;
  if (typeof cell.value === "boolean") return cell.value ? "TRUE" : "FALSE";
  if (typeof cell.value === "number") return String(cell.value);
  return cell.value;
}
function parseSheetXml(xml, sharedStrings) {
  const grid = /* @__PURE__ */ new Map();
  for (const rowMatch of xml.matchAll(SHEET_ROW)) {
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(SHEET_CELL)) {
      const attributes = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const ref = attributes.match(CELL_REF);
      if (ref === null) continue;
      const address = `${ref[1]}${ref[2]}`;
      const type = attributes.match(CELL_TYPE)?.[1];
      const rawValue = body.match(CELL_VALUE)?.[1];
      const formula = body.match(CELL_FORMULA)?.[1];
      const inlineText = body.match(CELL_INLINE_TEXT)?.[1];
      let cell;
      if (formula !== void 0) {
        if (rawValue !== void 0 && type !== "e") {
          cell = { kind: "value", value: decodeXmlEntities(rawValue) };
        } else {
          cell = { kind: "formula", formula: decodeXmlEntities(formula) };
        }
      } else if (type === "s") {
        const index = rawValue === void 0 ? -1 : Number.parseInt(rawValue, 10);
        cell = { kind: "value", value: sharedStrings[index] ?? "" };
      } else if (type === "inlineStr") {
        cell = { kind: "value", value: inlineText === void 0 ? "" : decodeXmlEntities(inlineText) };
      } else if (type === "b") {
        cell = { kind: "value", value: rawValue === "1" ? "TRUE" : "FALSE" };
      } else if (type === "str") {
        cell = { kind: "value", value: rawValue === void 0 ? "" : decodeXmlEntities(rawValue) };
      } else if (rawValue !== void 0) {
        cell = { kind: "value", value: decodeXmlEntities(rawValue) };
      } else {
        cell = { kind: "value", value: "" };
      }
      grid.set(address, cell);
    }
  }
  return grid;
}
function parseWorkbook(zip) {
  const workbookXml = readZipXmlPart(zip, "xl/workbook.xml");
  if (workbookXml === null) throw new Error("the .xlsx has no xl/workbook.xml part; is this a valid Excel file?");
  const relsXml = readZipXmlPart(zip, "xl/_rels/workbook.xml.rels") ?? "";
  const targets = /* @__PURE__ */ new Map();
  for (const rel of relsXml.matchAll(RELATIONSHIP)) {
    targets.set(rel[1], rel[2]);
  }
  const sharedStringsXml = readZipXmlPart(zip, "xl/sharedStrings.xml");
  const sharedStrings = sharedStringsXml === null ? [] : parseSharedStrings(sharedStringsXml);
  const sheets = /* @__PURE__ */ new Map();
  const names = [];
  for (const sheetMatch of workbookXml.matchAll(WORKBOOK_SHEET)) {
    const name2 = decodeXmlEntities(sheetMatch[1]);
    const id = sheetMatch[2];
    const target = id === void 0 ? void 0 : targets.get(id);
    const part = target === void 0 ? `worksheets/sheet${names.length + 1}.xml` : target.replace(/^\//, "").replace(/^xl\//, "");
    const sheetXml2 = readZipXmlPart(zip, `xl/${part}`);
    if (sheetXml2 === null) continue;
    const grid = parseSheetXml(sheetXml2, sharedStrings);
    const addresses = gridAddresses(grid);
    const last = addresses.at(-1);
    sheets.set(name2, {
      name: name2,
      part,
      content: sheetXml2,
      grid,
      maxRow: last?.row ?? -1,
      maxColumn: last?.column ?? -1
    });
    names.push(name2);
  }
  return { names, sheets };
}
function registerExcelCreate(ctx) {
  return ctx.tools.register(defineTool({
    name: "excel_create",
    description: "Create a new .xlsx Excel workbook in the session workspace from structured sheets. Each sheet has a name and an array of rows; each row is an array of scalar cells (string, number, boolean, or null). Use excel_update to change an existing workbook without recreating it.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Output path. Relative paths resolve against the session workspace; the extension must be .xlsx."
      },
      sheets: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true, description: "Worksheet name (unique within this call)." },
            rows: {
              type: "array",
              required: true,
              items: ROW_SCHEMA,
              description: "Grid rows; the first row is typically a header row. String cells starting with = are written as formulas."
            }
          }
        },
        description: "Sheets to write, in tab order."
      },
      overwrite: {
        type: "boolean",
        description: "Replace the file when it already exists. Defaults to false."
      }
    },
    output: {
      schema: EXCEL_CREATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Created Excel workbook ${value.path} (${value.sizeBytes} bytes; ${value.sheets.length} sheet(s): ${value.sheets.map((sheet) => `${sheet.name} ${sheet.rowCount}x${sheet.colCount}`).join(", ")}).`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Create ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".xlsx"], false);
      await assertMayCreate(exec, ctx, target.target, args.overwrite ?? false);
      validateSheetSpecs(args.sheets);
      exec.signal.throwIfAborted();
      const summaries = [];
      const models = args.sheets.map((spec, index) => {
        const grid = gridOf(spec.rows);
        const last = gridAddresses(grid).at(-1);
        const model = {
          name: spec.name,
          part: `worksheets/sheet${index + 1}.xml`,
          content: sheetXml(grid),
          grid,
          maxRow: last?.row ?? -1,
          maxColumn: last?.column ?? -1
        };
        summaries.push({
          name: spec.name,
          rowCount: spec.rows.length,
          colCount: spec.rows.length === 0 ? 0 : Math.max(...spec.rows.map((row) => row.length))
        });
        return model;
      });
      const text = buildXlsxText(models);
      exec.signal.throwIfAborted();
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text);
      return { path: target.display, sizeBytes, sheets: summaries };
    }
  }));
}
function registerExcelRead(ctx) {
  return ctx.tools.register(defineTool({
    name: "excel_read",
    description: 'Read one or all sheets of an existing .xlsx workbook and return each sheet as rows of scalar values (formatted strings). Formula cells return their cached value when one exists; formulas without a cached value return the formula as an "=SUM(\u2026)" string. Rows are capped; the per-sheet `truncated` flag reports when more rows were not returned. Pass `sheet` to read a single named sheet.',
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the .xlsx file, relative to the session workspace or absolute inside it."
      },
      sheet: {
        type: "string",
        description: "Read only this worksheet by exact name. Omit to read every sheet."
      },
      max_rows: {
        type: "integer",
        description: "Maximum rows returned per sheet. Defaults to 5000."
      }
    },
    output: {
      schema: EXCEL_READ_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: value.sheets.map(
          (sheet) => `${sheet.name} (${sheet.rows.length} row(s)${sheet.truncated ? ", truncated" : ""}):
` + JSON.stringify(sheet.rows)
        ).join("\n\n")
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Read ${args.path}`,
      kind: "read",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".xlsx"], true);
      const { bytes, sizeBytes } = await readOfficeBytes(exec, ctx, target.target);
      const zip = readZip(bytes);
      const workbook = parseWorkbook(zip);
      if (args.sheet !== void 0 && !workbook.names.includes(args.sheet)) {
        throw new Error(`sheet "${args.sheet}" not found; available sheets: ${workbook.names.join(", ")}`);
      }
      const names = args.sheet === void 0 ? workbook.names : [args.sheet];
      const maxRows = Math.min(Math.max(args.max_rows ?? 5e3, 1), 1e4);
      const sheets = [];
      let totalCells = 0;
      let budgetExhausted = false;
      for (const name2 of names) {
        const model = workbook.sheets.get(name2);
        if (model === void 0) continue;
        const rawRows = worksheetRows(model.grid);
        const rows = [];
        let truncated = false;
        for (const rawRow of rawRows) {
          if (budgetExhausted) break;
          totalCells += rawRow.length;
          if (totalCells > MAX_READ_CELLS) {
            truncated = true;
            budgetExhausted = true;
            break;
          }
          rows.push(rawRow);
          if (rows.length >= maxRows) {
            truncated = rawRows.length > rows.length;
            break;
          }
        }
        if (rawRows.length > rows.length) truncated = true;
        sheets.push({ name: name2, rows, truncated });
      }
      return { path: target.display, sheets, sizeBytes };
    }
  }));
}
function registerExcelUpdate(ctx) {
  return ctx.tools.register(defineTool({
    name: "excel_update",
    description: 'Update an existing .xlsx workbook in place: replace or create whole sheets by name (`sheets`) and/or write individual scalar values into cells (`cell_updates`, e.g. "B2"). The workbook is re-published as an ASCII-safe package, so binary-only extensions cannot survive; prefer excel_create for new workbooks. Provide at least one sheet or cell update.',
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the existing .xlsx file."
      },
      sheets: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true, description: "Worksheet to replace; created when absent." },
            rows: {
              type: "array",
              required: true,
              items: ROW_SCHEMA,
              description: "Replacement grid rows."
            }
          }
        },
        description: "Whole-sheet replacements (optional)."
      },
      cell_updates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            sheet: { type: "string", required: true, description: "Worksheet name." },
            cell: { type: "string", required: true, description: 'Cell address in A1 notation, e.g. "B2".' },
            value: {
              ...CELL_VALUE_SCHEMA,
              required: true,
              description: "Scalar value to write into the cell. A string starting with = is written as a formula."
            }
          }
        },
        description: "Individual cell writes (optional)."
      }
    },
    output: {
      schema: EXCEL_UPDATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Updated Excel workbook ${value.path} (${value.sizeBytes} bytes). Sheets now: ${value.sheetNames.join(", ")}. Replaced/created sheets: ${value.updatedSheets.length === 0 ? "(none)" : value.updatedSheets.join(", ")}. Cell writes: ${value.cellUpdates.length}.`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Update ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".xlsx"], true);
      if ((args.sheets?.length ?? 0) === 0 && (args.cell_updates?.length ?? 0) === 0) {
        throw new Error("excel_update needs at least one entry in sheets or cell_updates");
      }
      const sheetSpecs = args.sheets ?? [];
      if (sheetSpecs.length > 0) validateSheetSpecs(sheetSpecs);
      const { bytes } = await readOfficeBytes(exec, ctx, target.target);
      const zip = readZip(bytes);
      void asciiPartsOf(zip);
      const workbook = parseWorkbook(zip);
      const names = [...workbook.names];
      const models = new Map(workbook.sheets);
      const updatedSheets = [];
      for (const spec of sheetSpecs) {
        const grid = gridOf(spec.rows);
        const last = gridAddresses(grid).at(-1);
        if (!names.includes(spec.name)) names.push(spec.name);
        models.set(spec.name, {
          name: spec.name,
          part: models.get(spec.name)?.part ?? `worksheets/sheet${names.length}.xml`,
          content: sheetXml(grid),
          grid,
          maxRow: last?.row ?? -1,
          maxColumn: last?.column ?? -1
        });
        updatedSheets.push(spec.name);
      }
      const cellUpdates = [];
      for (const update of args.cell_updates ?? []) {
        const model = models.get(update.sheet);
        if (model === void 0) throw new Error(`sheet "${update.sheet}" not found for cell update; available sheets: ${names.join(", ")}`);
        const { row, column } = parseCellAddress(update.cell);
        if (row < 0 || column < 0 || row >= 1048576) {
          throw new Error(`invalid cell address "${update.cell}"; use A1 notation such as "B2"`);
        }
        model.grid.set(update.cell.toUpperCase(), gridCellOf(update.value));
        model.maxRow = Math.max(model.maxRow, row);
        model.maxColumn = Math.max(model.maxColumn, column);
        model.content = sheetXml(model.grid);
        cellUpdates.push({ sheet: update.sheet, cell: update.cell });
      }
      exec.signal.throwIfAborted();
      const orderedModels = names.map((name2) => models.get(name2)).filter((model) => model !== void 0).map((model, index) => ({ ...model, part: `worksheets/sheet${index + 1}.xml` }));
      const text = buildXlsxText(orderedModels);
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text);
      return {
        path: target.display,
        sizeBytes,
        sheetNames: names,
        updatedSheets,
        cellUpdates
      };
    }
  }));
}
function registerExcelTools(ctx) {
  const disposers = [registerExcelCreate(ctx), registerExcelRead(ctx), registerExcelUpdate(ctx)];
  return () => disposers.forEach((dispose) => dispose());
}

// src/tools/ppt.ts
import { defineTool as defineTool2 } from "@deepseek-ai/dsh-tools";

// src/imgsize.ts
function pngSize(bytes) {
  if (bytes.length < 24) return void 0;
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return void 0;
  const width = (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0;
  const height = (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0;
  return width > 0 && height > 0 ? { width, height } : void 0;
}
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return void 0;
  let cursor = 2;
  while (cursor + 9 < bytes.length) {
    if (bytes[cursor] !== 255) return void 0;
    const marker = bytes[cursor + 1];
    if (marker === 216 || marker >= 208 && marker <= 217) {
      cursor += 2;
      continue;
    }
    const length = bytes[cursor + 2] << 8 | bytes[cursor + 3];
    const isStartOfFrame = marker >= 192 && marker <= 195 || marker >= 197 && marker <= 199 || marker >= 201 && marker <= 203 || marker >= 205 && marker <= 207;
    if (isStartOfFrame) {
      const height = bytes[cursor + 5] << 8 | bytes[cursor + 6];
      const width = bytes[cursor + 7] << 8 | bytes[cursor + 8];
      return width > 0 && height > 0 ? { width, height } : void 0;
    }
    if (marker === 218) return void 0;
    cursor += 2 + length;
  }
  return void 0;
}
function gifSize(bytes) {
  if (bytes.length < 10) return void 0;
  if (bytes[0] !== 71 || bytes[1] !== 73 || bytes[2] !== 70) return void 0;
  const width = bytes[6] | bytes[7] << 8;
  const height = bytes[8] | bytes[9] << 8;
  return width > 0 && height > 0 ? { width, height } : void 0;
}
function sniffImageSize(bytes) {
  return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes);
}

// src/tools/ppt.ts
var IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif"];
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var MAX_IMAGES_PER_SLIDE = 20;
var EMU_PER_INCH = 914400;
var EMU_PER_PIXEL = 9525;
var SLIDE_WIDTH_INCHES = 40 / 3;
var SLIDE_HEIGHT_INCHES = 7.5;
var SLIDE_WEMU = Math.round(SLIDE_WIDTH_INCHES * EMU_PER_INCH);
var SLIDE_HEMU = Math.round(SLIDE_HEIGHT_INCHES * EMU_PER_INCH);
var A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
var P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
var R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
var REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
var CT_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"';
function relationshipXml(id, type, target, external) {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/${type}" Target="${encodeXmlAttribute(target)}"${external ? ' TargetMode="External"' : ""}/>`;
}
function shapeTree(children) {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${children}</p:spTree>`;
}
function roundedInches(emu) {
  return Math.round(emu / EMU_PER_INCH * 100) / 100;
}
function textBoxPart(id, x, y, w, h, fontSizePt, paragraphs, bold, centered) {
  const runs = paragraphs.map((paragraph) => `<a:p>${centered ? '<a:pPr algn="ctr"/>' : ""}<a:r><a:rPr lang="en-US" sz="${fontSizePt * 100}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr><a:t xml:space="preserve">${encodeXmlText(paragraph)}</a:t></a:r></a:p>`).join("");
  const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x * EMU_PER_INCH)}" y="${Math.round(y * EMU_PER_INCH)}"/><a:ext cx="${Math.round(w * EMU_PER_INCH)}" cy="${Math.round(h * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`;
  const text = paragraphs.join(" | ");
  return { xml, box: { type: "text", xIn: Math.round(x * 100) / 100, yIn: Math.round(y * 100) / 100, wIn: Math.round(w * 100) / 100, hIn: Math.round(h * 100) / 100, text: text.length > 120 ? `${text.slice(0, 117)}...` : text } };
}
function bulletBoxPart(id, x, y, w, h, items) {
  const paragraphs = items.map((item) => `<a:p><a:pPr marL="228600" indent="-228600"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="${encodeXmlAttribute("\u2022")}"/></a:pPr><a:r><a:rPr lang="en-US" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr><a:t xml:space="preserve">${encodeXmlText(item)}</a:t></a:r></a:p>`).join("");
  const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Bullets ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x * EMU_PER_INCH)}" y="${Math.round(y * EMU_PER_INCH)}"/><a:ext cx="${Math.round(w * EMU_PER_INCH)}" cy="${Math.round(h * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
  return { xml, box: { type: "bullets", xIn: Math.round(x * 100) / 100, yIn: Math.round(y * 100) / 100, wIn: Math.round(w * 100) / 100, hIn: Math.round(h * 100) / 100, items } };
}
function linkedPicturePart(id, image, relId) {
  const crop = image.crop === void 0 ? "" : `<a:srcRect l="${image.crop.l}" t="${image.crop.t}" r="${image.crop.r}" b="${image.crop.b}"/>`;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${encodeXmlAttribute(image.alt ?? "")}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="${relId}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(image.xIn * EMU_PER_INCH)}" y="${Math.round(image.yIn * EMU_PER_INCH)}"/><a:ext cx="${Math.round(image.wIn * EMU_PER_INCH)}" cy="${Math.round(image.hIn * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}
function slideXml(shapes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${A_NS} ${R_NS} ${P_NS}><p:cSld>${shapeTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function notesSlideXml(notes) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notes ${A_NS} ${R_NS} ${P_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="5029200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t xml:space="preserve">${encodeXmlText(notes)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}
var THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme ${A_NS} name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="105000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
var SLIDE_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${A_NS} ${R_NS} ${P_NS}><p:cSld name="Office">${shapeTree("")}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
var SLIDE_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${A_NS} ${R_NS} ${P_NS} type="blank" preserve="1"><p:cSld name="Blank">${shapeTree("")}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
var NOTES_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:notesMaster ${A_NS} ${R_NS} ${P_NS}><p:cSld name="Notes">${shapeTree("")}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`;
function contentTypesXml(slideCount, notesCount) {
  const slides = Array.from({ length: slideCount }, (_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  const notes = Array.from({ length: notesCount }, (_, index) => `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types ${CT_NS}><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` + slides + notes + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
}
function presentationXml(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  const notesRid = slideCount + 2;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${A_NS} ${R_NS} ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId id="2147483649" r:id="rId${notesRid}"/></p:notesMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${SLIDE_WEMU}" cy="${SLIDE_HEMU}"/><p:notesSz cx="${SLIDE_HEMU}" cy="9144000"/></p:presentation>`;
}
function presentationRelsXml(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, index) => relationshipXml(`rId${index + 2}`, "officeDocument/2006/relationships/slide", `slides/slide${index + 1}.xml`, false)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` + relationshipXml("rId1", "officeDocument/2006/relationships/slideMaster", "slideMasters/slideMaster1.xml", false) + slides + relationshipXml(`rId${slideCount + 2}`, "officeDocument/2006/relationships/notesMaster", "notesMasters/notesMaster1.xml", false) + "</Relationships>";
}
function corePropsXml(title) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${encodeXmlText(title ?? "Presentation")}</dc:title></cp:coreProperties>`;
}
var APP_PROPS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>dsh-office-tools</Application><PresentationFormat>Widescreen</PresentationFormat></Properties>';
var ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` + relationshipXml("rId1", "officeDocument/2006/relationships/officeDocument", "ppt/presentation.xml", false) + relationshipXml("rId2", "package/2006/relationships/metadata/core-properties", "docProps/core.xml", false) + relationshipXml("rId3", "officeDocument/2006/relationships/extended-properties", "docProps/app.xml", false) + "</Relationships>";
var MASTER_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` + relationshipXml("rId1", "officeDocument/2006/relationships/slideLayout", "../slideLayouts/slideLayout1.xml", false) + relationshipXml("rId2", "officeDocument/2006/relationships/theme", "../theme/theme1.xml", false) + "</Relationships>";
var LAYOUT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` + relationshipXml("rId1", "officeDocument/2006/relationships/slideMaster", "../slideMasters/slideMaster1.xml", false) + "</Relationships>";
var NOTES_MASTER_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` + relationshipXml("rId1", "officeDocument/2006/relationships/theme", "../theme/theme2.xml", false) + "</Relationships>";
function slideRelsXml(index, imageTargets, hasNotes) {
  const images = imageTargets.map((target, offset) => relationshipXml(`rImg${offset + 1}`, "officeDocument/2006/relationships/image", target, true)).join("");
  const notes = hasNotes ? relationshipXml("rNotes", "officeDocument/2006/relationships/notesSlide", `../notesSlides/notesSlide${index}.xml`, false) : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` + relationshipXml("rId1", "officeDocument/2006/relationships/slideLayout", "../slideLayouts/slideLayout1.xml", false) + images + notes + "</Relationships>";
}
function notesRelsXml(index) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships ${REL_NS}>` + relationshipXml("rId1", "officeDocument/2006/relationships/slide", `../slides/slide${index}.xml`, false) + relationshipXml("rId2", "officeDocument/2006/relationships/notesMaster", "../notesMasters/notesMaster1.xml", false) + "</Relationships>";
}
function validateSlideSpecs(slides) {
  if (slides.length === 0) throw new Error("slides must contain at least one slide");
  if (slides.length > 200) throw new Error("too many slides (maximum 200)");
  for (const [slideIndex, slide] of slides.entries()) {
    const hasContent = (slide.title?.trim().length ?? 0) > 0 || (slide.paragraphs?.length ?? 0) > 0 || (slide.bullets?.length ?? 0) > 0 || (slide.images?.length ?? 0) > 0;
    if (!hasContent) throw new Error(`slide ${slideIndex + 1} is empty; give it a title, paragraphs, bullets, or images`);
    if ((slide.paragraphs?.length ?? 0) + (slide.bullets?.length ?? 0) > 500) {
      throw new Error(`slide ${slideIndex + 1} has too many text blocks (maximum 500)`);
    }
    const images = slide.images ?? [];
    if (images.length > MAX_IMAGES_PER_SLIDE) {
      throw new Error(`slide ${slideIndex + 1} has too many images (maximum ${MAX_IMAGES_PER_SLIDE})`);
    }
    for (const [imageIndex, image] of images.entries()) {
      for (const key of ["x", "y", "w", "h"]) {
        const value = image[key];
        if (value !== void 0 && (!Number.isFinite(value) || value <= 0 || value > 100)) {
          throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} ${key} must be a positive number of inches (0-100)`);
        }
      }
      if (image.sizing !== void 0 && (image.w === void 0 || image.h === void 0)) {
        throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} uses sizing; provide both w and h`);
      }
    }
  }
}
function imageLinkTarget(deck, image) {
  const deckParts = deck.absolute.split("/").filter(Boolean).slice(0, -1);
  const imageParts = image.absolute.split("/").filter(Boolean);
  let common = 0;
  while (common < deckParts.length && common < imageParts.length - 1 && deckParts[common] === imageParts[common]) common += 1;
  const up = deckParts.length - common;
  const relative2 = [...Array.from({ length: up }, () => ".."), ...imageParts.slice(common)].join("/");
  return relative2.startsWith("../") || relative2 === "" ? image.absolute : relative2;
}
async function placeImage(exec, ctx, deck, image, slideIndex, imageIndex) {
  const resolved = await resolveOfficePath(exec, ctx, image.path, IMAGE_EXTENSIONS, true);
  const info = await ctx.fs.stat(resolved.target, exec.signal);
  if (info !== void 0 && (info.size ?? 0) > MAX_IMAGE_BYTES) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} "${image.path}" is ${info.size} bytes; maximum linked image size is ${MAX_IMAGE_BYTES} bytes`);
  }
  const head = await ctx.fs.readBytes(resolved.target, exec.signal, 4096);
  const intrinsic = sniffImageSize(head.subarray(0, Math.min(head.byteLength, 1024)));
  const target = imageLinkTarget(deck, resolved);
  const naturalW = intrinsic === void 0 ? void 0 : intrinsic.width * EMU_PER_PIXEL / EMU_PER_INCH;
  const naturalH = intrinsic === void 0 ? void 0 : intrinsic.height * EMU_PER_PIXEL / EMU_PER_INCH;
  let w = image.w;
  let h = image.h;
  if ((w === void 0 || h === void 0) && naturalW !== void 0 && naturalH !== void 0) {
    if (w === void 0 && h === void 0) {
      w = naturalW;
      h = naturalH;
    } else if (w === void 0) {
      w = (h ?? naturalH) / naturalH * naturalW;
    } else {
      h = w / naturalW * naturalH;
    }
  }
  if (w === void 0 || h === void 0) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} "${image.path}" is not a recognizable PNG/JPEG/GIF (no intrinsic size); provide explicit w and h in inches`);
  }
  if (w <= 0 || h <= 0) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} resolves to a non-positive size`);
  }
  const placed = {
    type: "image",
    xIn: 0,
    yIn: 0,
    wIn: Math.round(w * 100) / 100,
    hIn: Math.round(h * 100) / 100,
    alt: image.alt ?? image.path,
    path: target,
    sizing: image.sizing,
    target,
    pixelWidth: intrinsic?.width,
    pixelHeight: intrinsic?.height
  };
  if (image.sizing === "contain" || image.sizing === "cover") {
    const boxAspect = w / h;
    const imageAspect = naturalW !== void 0 && naturalH !== void 0 && naturalH !== 0 ? naturalW / naturalH : boxAspect;
    if (image.sizing === "contain") {
      const containedW = Math.min(w, h * imageAspect);
      const containedH = Math.min(h, w / imageAspect);
      placed.wIn = Math.round(containedW * 100) / 100;
      placed.hIn = Math.round(containedH * 100) / 100;
    } else if (imageAspect > boxAspect && imageAspect > 0) {
      const visible = Math.round(boxAspect / imageAspect * 1e5 / 2);
      placed.crop = { l: visible, t: 0, r: visible, b: 0 };
    } else if (imageAspect > 0) {
      const visible = Math.round(imageAspect / boxAspect * 1e5 / 2);
      placed.crop = { l: 0, t: visible, r: 0, b: visible };
    }
  }
  return placed;
}
function slideParts(build) {
  const { spec, first } = build;
  const shapes = [];
  const elements = [];
  const hasTitle = spec.title !== void 0 && spec.title.trim() !== "";
  let id = 2;
  if (first && hasTitle) {
    const part = textBoxPart(id++, 0.9, 1.2, 11.53, 1.2, 32, [spec.title], true, true);
    shapes.push(part.xml);
    elements.push(part.box);
  } else if (hasTitle) {
    const part = textBoxPart(id++, 0.9, 0.35, 11.53, 0.9, 26, [spec.title], true, false);
    shapes.push(part.xml);
    elements.push(part.box);
  }
  const top = first && hasTitle ? 2.7 : hasTitle ? 1.5 : 0.8;
  let y = top;
  if ((spec.paragraphs?.length ?? 0) > 0) {
    for (const paragraph of spec.paragraphs) {
      if (y > 6.4) break;
      const part = textBoxPart(id++, 0.9, y, 11.53, 0.7, 18, [paragraph], false, false);
      shapes.push(part.xml);
      elements.push(part.box);
      y += 0.8;
    }
    y += 0.2;
  }
  if ((spec.bullets?.length ?? 0) > 0) {
    const height = Math.min(4.5, Math.max(1, spec.bullets.length * 0.6));
    const part = bulletBoxPart(id++, 0.9, y, 11.53, height, spec.bullets);
    shapes.push(part.xml);
    elements.push(part.box);
  }
  const images = build.images;
  if (images.length > 0) {
    const explicitAt = (index) => {
      const explicit = build.spec.images?.[index];
      return explicit !== void 0 && (explicit.x !== void 0 || explicit.y !== void 0);
    };
    const automaticCount = images.filter((_, index) => !explicitAt(index)).length;
    const automaticHeight = Math.max(0.6, Math.min(3.2, (6.6 - Math.min(y, 6.4)) / Math.max(1, automaticCount)));
    let imageY = Math.min(y + 0.25, 6.5);
    images.forEach((image, imageIndex) => {
      const explicit = build.spec.images?.[imageIndex];
      if (explicitAt(imageIndex)) {
        image.xIn = explicit?.x ?? 0;
        image.yIn = explicit?.y ?? 0;
      } else {
        image.xIn = 0.9;
        image.yIn = Math.round(imageY * 100) / 100;
        if (explicit?.w === void 0 && explicit?.h === void 0) {
          image.wIn = Math.round(11.53 * 100) / 100;
          image.hIn = Math.round(automaticHeight * 100) / 100;
        }
        imageY += image.hIn + 0.15;
      }
      shapes.push(linkedPicturePart(id++, image, `rImg${imageIndex + 1}`));
      const { target: _target, pixelWidth: _w, pixelHeight: _h, crop: _c, ...box } = image;
      elements.push({ ...box, sizing: image.sizing ?? (explicit?.sizing ?? "contain") });
    });
  }
  return { xml: shapes.join(""), elements };
}
async function buildPptxText(args, exec, ctx, deck) {
  const builds = [];
  if (args.title !== void 0 && args.title.trim() !== "") {
    builds.push({ spec: { title: args.title }, first: true, images: [] });
  }
  const slides = args.slides ?? [];
  let first = args.title === void 0 || args.title.trim() === "";
  for (const spec of slides) {
    builds.push({ spec, first, images: [] });
    first = false;
  }
  const slideCount = builds.length;
  if (slideCount === 0) throw new Error("ppt_create needs a title or at least one slide");
  for (const [slideIndex, build] of builds.entries()) {
    const images = build.spec.images ?? [];
    build.images = [];
    for (const [imageIndex, image] of images.entries()) {
      build.images.push(await placeImage(exec, ctx, deck, image, slideIndex, imageIndex));
    }
  }
  const notesCount = builds.filter((build) => build.spec.notes !== void 0 && build.spec.notes.trim() !== "").length;
  const layout = [];
  const parts = [
    { name: "[Content_Types].xml", content: contentTypesXml(slideCount, notesCount) },
    { name: "_rels/.rels", content: ROOT_RELS_XML },
    { name: "ppt/presentation.xml", content: presentationXml(slideCount) },
    { name: "ppt/_rels/presentation.xml.rels", content: presentationRelsXml(slideCount) },
    { name: "ppt/slideMasters/slideMaster1.xml", content: SLIDE_MASTER_XML },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", content: MASTER_RELS_XML },
    { name: "ppt/slideLayouts/slideLayout1.xml", content: SLIDE_LAYOUT_XML },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", content: LAYOUT_RELS_XML },
    { name: "ppt/notesMasters/notesMaster1.xml", content: NOTES_MASTER_XML },
    { name: "ppt/notesMasters/_rels/notesMaster1.xml.rels", content: NOTES_MASTER_RELS_XML },
    { name: "ppt/theme/theme1.xml", content: THEME_XML },
    { name: "ppt/theme/theme2.xml", content: THEME_XML },
    { name: "docProps/core.xml", content: corePropsXml(args.title) },
    { name: "docProps/app.xml", content: APP_PROPS_XML }
  ];
  builds.forEach((build, index) => {
    const number = index + 1;
    const { xml, elements } = slideParts(build);
    layout.push({ index: number, elements });
    const hasNotes = build.spec.notes !== void 0 && build.spec.notes.trim() !== "";
    parts.push({ name: `ppt/slides/slide${number}.xml`, content: slideXml(xml) });
    parts.push({
      name: `ppt/slides/_rels/slide${number}.xml.rels`,
      content: slideRelsXml(number, build.images.map((image) => image.target), hasNotes)
    });
    if (hasNotes) {
      parts.push({ name: `ppt/notesSlides/notesSlide${number}.xml`, content: notesSlideXml(build.spec.notes) });
      parts.push({ name: `ppt/notesSlides/_rels/notesSlide${number}.xml.rels`, content: notesRelsXml(number) });
    }
  });
  return { text: buildAsciiZip(parts), layout };
}
function sketchSlide(widthIn, heightIn, elements) {
  const columns = 64;
  const rows = 18;
  const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => " "));
  const scaleX = columns / widthIn;
  const scaleY = rows / heightIn;
  const drawRect = (x, y, w, h, label) => {
    const left = Math.max(1, Math.min(columns - 2, Math.round(x * scaleX)));
    const right = Math.max(left + 1, Math.min(columns - 2, Math.round((x + w) * scaleX)));
    const topRow = Math.max(1, Math.min(rows - 2, Math.round(y * scaleY)));
    const bottom = Math.max(topRow + 1, Math.min(rows - 2, Math.round((y + h) * scaleY)));
    for (let column = left; column <= right; column += 1) {
      grid[topRow][column] = "-";
      grid[bottom][column] = "-";
    }
    for (let row = topRow; row <= bottom; row += 1) {
      grid[row][left] = "|";
      grid[row][right] = "|";
    }
    grid[topRow][left] = "+";
    grid[topRow][right] = "+";
    grid[bottom][left] = "+";
    grid[bottom][right] = "+";
    const inner = right - left - 1;
    if (inner > 2 && bottom - topRow >= 2) {
      const text = label.slice(0, Math.min(label.length, inner));
      for (let offset = 0; offset < text.length; offset += 1) {
        grid[topRow + 1][left + 1 + Math.floor((inner - text.length) / 2) + offset] = text[offset];
      }
    }
  };
  for (const element of elements) {
    const label = element.type === "image" ? "IMG" : (element.text ?? element.type).split(/\s+/)[0]?.slice(0, 10) || element.type;
    drawRect(element.xIn, element.yIn, element.wIn, element.hIn, label);
  }
  const border = [];
  border.push("+" + "-".repeat(columns) + "+");
  for (const row of grid) border.push("|" + row.join("") + "|");
  border.push("+" + "-".repeat(columns) + "+");
  return border.join("\n");
}
function paragraphText(paragraphXml2) {
  const runs = [];
  const runPattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
  for (const match of paragraphXml2.matchAll(runPattern)) runs.push(match[1] ?? "");
  const text = decodeXmlEntities(runs.join("").replace(/<a:br\b[^>]*\/>/g, "\n"));
  return text;
}
function extractParagraphs(xml, skipFields) {
  const paragraphs = [];
  const pattern = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  for (const match of xml.matchAll(pattern)) {
    const paragraph = match[1] ?? "";
    if (skipFields && /<a:fld\b/.test(paragraph)) continue;
    const text = paragraphText(paragraph);
    if (text.trim() !== "") paragraphs.push(text);
  }
  return paragraphs;
}
var A_TABLE = /<a:tbl\b[\s\S]*?<\/a:tbl>/g;
var A_TABLE_ROW = /<a:tr\b[\s\S]*?<\/a:tr>/g;
var A_TABLE_CELL = /<a:tc\b[\s\S]*?<\/a:tc>/g;
var PICTURE = /<p:pic\b[\s\S]*?<\/p:pic>/g;
var PICTURE_DESCR = /<p:cNvPr\b[^>]*\bdescr="([^"]*)"/;
var SHAPE_WITH_GEOMETRY = /<p:sp\b[\s\S]*?<\/p:sp>|<p:pic\b[\s\S]*?<\/p:pic>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g;
var GEOMETRY = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/;
function extractTables(slideXmlText) {
  const tables = [];
  for (const tableMatch of slideXmlText.matchAll(A_TABLE)) {
    const rows = [...(tableMatch[0] ?? "").matchAll(A_TABLE_ROW)].map((rowMatch) => [...(rowMatch[0] ?? "").matchAll(A_TABLE_CELL)].map((cellMatch) => extractParagraphs(cellMatch[0] ?? "", false).join(" ")));
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}
function stripTables(slideXmlText) {
  return slideXmlText.replace(A_TABLE, "");
}
function extractImageAlts(slideXmlText) {
  const alts = [];
  for (const pictureMatch of slideXmlText.matchAll(PICTURE)) {
    const descrMatch = (pictureMatch[0] ?? "").match(PICTURE_DESCR);
    const descr = descrMatch === null ? void 0 : descrMatch[1];
    if (descr !== void 0 && descr.trim() !== "") alts.push(decodeXmlEntities(descr));
  }
  return alts;
}
function extractElements(slideXmlText) {
  const elements = [];
  for (const match of slideXmlText.matchAll(SHAPE_WITH_GEOMETRY)) {
    const block = match[0] ?? "";
    const geometry = block.match(GEOMETRY);
    const base = geometry === null ? { xIn: 0, yIn: 0, wIn: 0, hIn: 0 } : {
      xIn: roundedInches(Number(geometry[1])),
      yIn: roundedInches(Number(geometry[2])),
      wIn: roundedInches(Number(geometry[3])),
      hIn: roundedInches(Number(geometry[4]))
    };
    if (block.startsWith("<p:pic")) {
      const descr = block.match(PICTURE_DESCR)?.[1];
      elements.push({ type: "image", ...base, alt: descr === void 0 ? void 0 : decodeXmlEntities(descr) });
      continue;
    }
    if (block.startsWith("<p:graphicFrame")) {
      const table = extractTables(block)[0];
      elements.push({
        type: "table",
        ...base,
        text: table === void 0 ? void 0 : `${table.length}x${table[0]?.length ?? 0}`
      });
      continue;
    }
    const text = extractParagraphs(stripTables(block), false).join(" | ");
    elements.push({ type: "text", ...base, text: text.length > 120 ? `${text.slice(0, 117)}...` : text });
  }
  return elements;
}
function decodeRelationshipTarget(xml) {
  const match = xml.match(/Target="([^"]*notesSlides\/notesSlide(\d+)\.xml)"/);
  if (match === null) return void 0;
  return `ppt/notesSlides/notesSlide${match[2]}.xml`;
}
function slideNumber(name2) {
  const match = name2.match(/slide(\d+)\.xml$/);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}
function countSlideImages(zip, number) {
  const xml = readZipXmlPart(zip, `ppt/slides/_rels/slide${number}.xml.rels`);
  if (xml === null) return 0;
  return [...xml.matchAll(/Type="[^"]*\/image"/g)].length;
}
function readSlideXml(zip) {
  const slideFiles = zip.entryNames().filter((name2) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name2)).sort((left, right) => slideNumber(left) - slideNumber(right));
  const xmls = slideFiles.map((name2) => readZipXmlPart(zip, name2) ?? "");
  const presentation = readZipXmlPart(zip, "ppt/presentation.xml");
  const size = (presentation ?? "").match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/);
  const widthInches = size === null ? SLIDE_WIDTH_INCHES : roundedInches(Number(size[1]));
  const heightInches = size === null ? SLIDE_HEIGHT_INCHES : roundedInches(Number(size[2]));
  const notes = xmls.map((_, index) => {
    const number = slideNumber(slideFiles[index]) || index + 1;
    const relationship = readZipXmlPart(zip, `ppt/slides/_rels/slide${number}.xml.rels`);
    let notesName = `ppt/notesSlides/notesSlide${number}.xml`;
    if (relationship !== null) {
      const target = decodeRelationshipTarget(relationship);
      if (target !== void 0) notesName = target;
    }
    const noteFile = readZipXmlPart(zip, notesName);
    if (noteFile === null) return void 0;
    const paragraphs = extractParagraphs(noteFile, true);
    return paragraphs.length === 0 ? void 0 : paragraphs.join("\n");
  });
  const imageCounts = xmls.map((_, index) => {
    const number = slideNumber(slideFiles[index]) || index + 1;
    return countSlideImages(zip, number);
  });
  return { xmls, notes, imageCounts, widthInches, heightInches };
}
var ELEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", required: true, description: "Element kind: text, bullets, image, or table." },
    xIn: { type: "number", required: true, description: "Left edge in inches from the slide origin." },
    yIn: { type: "number", required: true, description: "Top edge in inches from the slide origin." },
    wIn: { type: "number", required: true, description: "Width in inches." },
    hIn: { type: "number", required: true, description: "Height in inches." },
    text: { type: "string", description: "Text content (short); tables report rows x columns." },
    items: { type: "array", items: { type: "string" }, description: "Bullet items, for bullets boxes this plugin wrote." },
    alt: { type: "string", description: "Image alt text." },
    path: { type: "string", description: "Linked image target path, when the writer placed it." },
    sizing: { type: "string", enum: ["contain", "cover"], description: "Fit mode used for the placement." }
  }
};
var SLIDE_LAYOUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    index: { type: "integer", required: true },
    elements: { type: "array", required: true, items: ELEMENT_SCHEMA }
  }
};
var SLIDE_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    index: { type: "integer", required: true },
    title: { type: "string" },
    paragraphs: {
      type: "array",
      required: true,
      items: { type: "string" }
    },
    notes: {
      type: "array",
      items: { type: "string" }
    },
    tables: {
      type: "array",
      items: { type: "array", items: { type: "array", items: { type: "string" } } },
      description: "Tables as rows of cell texts (paragraphs joined with spaces); present only when the slide has tables."
    },
    imageAlts: {
      type: "array",
      items: { type: "string" },
      description: "Alt text (descr) of the slide's pictures in order; present only when at least one is non-empty."
    },
    imageCount: { type: "integer", required: true },
    elements: {
      type: "array",
      items: ELEMENT_SCHEMA,
      description: "Every placed shape with its bounding box in inches, in z-order."
    }
  }
};
var PPT_CREATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    title: { type: "string" },
    slideCount: { type: "integer", required: true },
    slideWidthInches: { type: "number", required: true, description: "Canvas width (13.33 in widescreen)." },
    slideHeightInches: { type: "number", required: true, description: "Canvas height (7.5 in widescreen)." },
    slides: {
      type: "array",
      required: true,
      items: SLIDE_LAYOUT_SCHEMA,
      description: "Per-slide element layout echo: where every text box, bullet list, and linked image landed, in inches."
    }
  }
};
var PPT_READ_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    slideCount: { type: "integer", required: true },
    slideWidthInches: { type: "number", required: true },
    slideHeightInches: { type: "number", required: true },
    slides: {
      type: "array",
      required: true,
      items: SLIDE_SUMMARY_SCHEMA
    },
    truncated: { type: "boolean", required: true },
    sizeBytes: { type: "integer", required: true }
  }
};
function registerPptCreate(ctx) {
  return ctx.tools.register(defineTool2({
    name: "ppt_create",
    description: "Create a PowerPoint .pptx presentation in the session workspace (16:9 widescreen, 13.33 x 7.5 in). Optionally start with a title slide, then add slides with a title, body paragraphs, bullet points, speaker notes, and linked PNG/JPG/GIF images. Images are linked, not embedded: give x/y/w/h in inches for explicit placement (sizing: contain fits inside the box, cover fills it and crops), or omit them for automatic placement below the text at natural size. The result echoes every element's landing position (inches) and a text wireframe sketch of each slide, so you can verify the composition you authored.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Output path. Relative paths resolve against the session workspace; the extension must be .pptx."
      },
      title: {
        type: "string",
        description: "Deck title. When provided, a title slide is inserted before the explicit slides."
      },
      slides: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "Slide title." },
            paragraphs: {
              type: "array",
              items: { type: "string" },
              description: "Body paragraphs rendered as plain text boxes."
            },
            bullets: {
              type: "array",
              items: { type: "string" },
              description: "Bullet list items rendered after the paragraphs."
            },
            notes: { type: "string", description: "Speaker notes for this slide." },
            images: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: {
                    type: "string",
                    required: true,
                    description: "Image file inside the session workspace: .png, .jpg, .jpeg, or .gif. The deck links to it, so keep the file in place."
                  },
                  x: { type: "number", description: "Left position in inches on the 13.33x7.5 slide. Omit for automatic placement below the text." },
                  y: { type: "number", description: "Top position in inches. Omit for automatic placement." },
                  w: { type: "number", description: "Display width in inches. Omit to use the intrinsic size (PNG/JPG/GIF headers are sniffed)." },
                  h: { type: "number", description: "Display height in inches. Omit to use the intrinsic size; a single dimension scales by aspect." },
                  sizing: {
                    type: "string",
                    enum: ["contain", "cover"],
                    description: "Fit mode inside the w x h box: contain fits whole (default), cover fills and crops. Requires w and h."
                  },
                  alt: { type: "string", description: "Alt text; defaults to the image path." }
                }
              },
              description: "Images linked on this slide, drawn after the text content."
            }
          }
        },
        description: "Slides in presentation order. Optional when a title is provided."
      },
      overwrite: {
        type: "boolean",
        description: "Replace the file when it already exists. Defaults to false."
      }
    },
    output: {
      schema: PPT_CREATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Created PowerPoint ${value.path} (${value.sizeBytes} bytes; ${value.slideCount} slide(s), canvas ${value.slideWidthInches}x${value.slideHeightInches} in).
` + value.slides.map((slide) => `Slide ${slide.index} layout:
${sketchSlide(value.slideWidthInches, value.slideHeightInches, slide.elements)}`).join("\n\n")
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Create ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".pptx"], false);
      await assertMayCreate(exec, ctx, target.target, args.overwrite ?? false);
      if ((args.slides?.length ?? 0) > 0) validateSlideSpecs(args.slides);
      if (args.title === void 0 && (args.slides?.length ?? 0) === 0) {
        throw new Error("ppt_create needs a title or at least one slide");
      }
      exec.signal.throwIfAborted();
      const { text, layout } = await buildPptxText(args, exec, ctx, target);
      exec.signal.throwIfAborted();
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text);
      const result = {
        path: target.display,
        sizeBytes,
        slideCount: layout.length,
        slideWidthInches: Math.round(SLIDE_WIDTH_INCHES * 100) / 100,
        slideHeightInches: SLIDE_HEIGHT_INCHES,
        slides: layout
      };
      if (args.title !== void 0 && args.title.trim() !== "") result.title = args.title;
      return result;
    }
  }));
}
function registerPptRead(ctx) {
  return ctx.tools.register(defineTool2({
    name: "ppt_read",
    description: "Extract the content and layout of an existing .pptx presentation. Per slide, in slide order: paragraphs, tables (rows of cell texts), speaker notes, linked/embedded image count, image alt texts \u2014 plus an `elements` array giving every shape's bounding box in inches (x/y/w/h) and the deck canvas size, with a text wireframe sketch of each slide. Table cell text is reported under `tables`, not duplicated into `paragraphs`. Use it to understand, summarize, or re-layout a deck: the element boxes tell you exactly where everything sits on the canvas.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the .pptx file, relative to the session workspace or absolute inside it."
      },
      max_chars: {
        type: "integer",
        description: `Maximum characters returned across the deck. Defaults to ${MAX_TEXT_CHARS}.`
      }
    },
    output: {
      schema: PPT_READ_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Canvas ${value.slideWidthInches}x${value.slideHeightInches} in.
` + value.slides.map(
          (slide) => `Slide ${slide.index}${slide.title !== void 0 ? ` \u2014 ${slide.title}` : ""} (images: ${slide.imageCount}${slide.imageAlts !== void 0 ? `; alts: ${slide.imageAlts.join(" | ")}` : ""}):
` + slide.paragraphs.map((paragraph) => `- ${paragraph}`).join("\n") + (slide.tables !== void 0 ? `
Tables:
${slide.tables.map((table) => table.map((row) => row.join(" | ")).join("\n")).join("\n\n")}` : "") + (slide.notes !== void 0 ? `
Notes: ${slide.notes.join(" | ")}` : "") + (slide.elements !== void 0 && slide.elements.length > 0 ? `
${sketchSlide(value.slideWidthInches, value.slideHeightInches, slide.elements)}` : "")
        ).join("\n\n") + (value.truncated ? "\n[text truncated]" : "")
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Read ${args.path}`,
      kind: "read",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".pptx"], true);
      const { bytes, sizeBytes } = await readOfficeBytes(exec, ctx, target.target);
      const zip = readZip(bytes);
      const { xmls, notes, imageCounts, widthInches, heightInches } = readSlideXml(zip);
      if (xmls.length === 0) throw new Error("the .pptx contains no slides");
      const maxChars = Math.min(Math.max(args.max_chars ?? MAX_TEXT_CHARS, 1), MAX_TEXT_CHARS);
      const slides = [];
      let totalChars = 0;
      let truncated = false;
      for (let index = 0; index < xmls.length; index += 1) {
        const slideXmlText = xmls[index];
        const paragraphs = extractParagraphs(stripTables(slideXmlText), false);
        const tables = extractTables(slideXmlText);
        const imageAlts = extractImageAlts(slideXmlText);
        const elements = extractElements(slideXmlText);
        const noteText = notes[index];
        const noteParagraphs = noteText === void 0 || noteText.trim() === "" ? void 0 : [noteText];
        const body = paragraphs;
        const remainingChars = Math.max(0, maxChars - totalChars);
        let slideChars = 0;
        const bounded = body.map((paragraph) => {
          if (slideChars >= remainingChars) return "";
          const retained = paragraph.slice(0, remainingChars - slideChars);
          slideChars += retained.length;
          return retained;
        });
        const noteBounded = noteParagraphs === void 0 ? void 0 : [noteParagraphs[0].slice(0, Math.max(0, remainingChars - slideChars))];
        const bodyChars = body.reduce((sum, paragraph) => sum + paragraph.length, 0);
        const noteChars = noteParagraphs?.[0]?.length ?? 0;
        totalChars += slideChars + (noteBounded?.[0]?.length ?? 0);
        if (bodyChars + noteChars > slideChars + (noteBounded?.[0]?.length ?? 0)) truncated = true;
        const tablesChars = tables.reduce((sum, table) => sum + table.reduce((rowSum, row) => rowSum + row.join("").length, 0), 0);
        const tablesFit = totalChars + tablesChars <= maxChars;
        if (!tablesFit && tables.length > 0) truncated = true;
        const slide = {
          index: index + 1,
          paragraphs: bounded.filter((paragraph) => paragraph !== ""),
          imageCount: imageCounts[index] ?? 0,
          elements
        };
        if (noteBounded !== void 0) slide.notes = noteBounded;
        if (tablesFit && tables.length > 0) {
          slide.tables = tables;
          totalChars += tablesChars;
        }
        if (imageAlts.length > 0) slide.imageAlts = imageAlts;
        slides.push(slide);
      }
      return {
        path: target.display,
        slideCount: slides.length,
        slideWidthInches: widthInches,
        slideHeightInches: heightInches,
        slides,
        truncated,
        sizeBytes
      };
    }
  }));
}
function registerPptTools(ctx) {
  const disposers = [registerPptCreate(ctx), registerPptRead(ctx)];
  return () => disposers.forEach((dispose) => dispose());
}

// src/tools/word.ts
import { defineTool as defineTool4 } from "@deepseek-ai/dsh-tools";

// src/tools/word-update.ts
import { defineTool as defineTool3 } from "@deepseek-ai/dsh-tools";
var WORD_UPDATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    appendedParagraphs: { type: "integer", required: true },
    appendedBullets: { type: "integer", required: true },
    appendedTableRows: { type: "integer", required: true }
  }
};
function registerWordUpdate(ctx) {
  return ctx.tools.register(defineTool3({
    name: "word_update",
    description: "Append content to an existing .docx Word document in the session workspace: paragraphs, bullet points, and/or one table are added at the end of the body (in that order), leaving everything already in the file untouched. Bullets reuse the list numbering the document already defines, so they render as bullets in files that have them (files created by word_create always do); documents without list numbering show appended bullets as plain paragraphs. The file is re-published atomically through the official workspace file service; packages with binary parts (embedded images or fonts) cannot be rewritten and are refused. Use word_read afterwards to verify.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the existing .docx file, relative to the session workspace or absolute inside it."
      },
      paragraphs: {
        type: "array",
        items: { type: "string" },
        description: "Paragraphs to append in document order. Optional."
      },
      bullets: {
        type: "array",
        items: { type: "string" },
        description: "Bullet list items appended after the paragraphs. Optional."
      },
      table: {
        type: "object",
        additionalProperties: false,
        properties: {
          headers: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "Table column headers (bold)."
          },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            required: true,
            description: "Table body rows; each row should match the header column count."
          }
        },
        description: "One optional table appended after the text content."
      }
    },
    output: {
      schema: WORD_UPDATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Appended to Word document ${value.path} (${value.sizeBytes} bytes; ${value.appendedParagraphs} paragraph(s), ${value.appendedBullets} bullet(s), ${value.appendedTableRows} table body row(s) appended).`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Update ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".docx"], true);
      const { paragraphs: paragraphCount, cells } = wordCreateCounts(args);
      if ((args.paragraphs?.length ?? 0) === 0 && (args.bullets?.length ?? 0) === 0 && args.table === void 0) {
        throw new Error("word_update needs at least one of paragraphs, bullets, or table");
      }
      if (paragraphCount > 1e4) throw new Error("too many paragraphs/bullets/table rows (maximum 10000)");
      if (cells > 2e5) throw new Error("too many table cells (maximum 200000)");
      exec.signal.throwIfAborted();
      const { bytes } = await readOfficeBytes(exec, ctx, target.target);
      const zip = readZip(bytes);
      const documentXml2 = readZipXmlPart(zip, "word/document.xml");
      if (documentXml2 === null) {
        throw new Error("the .docx has no word/document.xml part; is this a valid Word file?");
      }
      const fragment = buildAppendFragment(args);
      const updated = appendBeforeSectPr(documentXml2, fragment);
      const parts = [];
      for (const name2 of zip.entryNames()) {
        if (name2 === "word/document.xml") {
          parts.push({ name: name2, content: updated });
          continue;
        }
        if (!zip.entryIsAsciiSafe(name2)) {
          throw new Error(`zip entry "${name2}" contains binary (non-ASCII) bytes; the update path re-publishes through the official UTF-8 text channel and cannot round-trip binary parts`);
        }
        parts.push({ name: name2, content: zip.entryText(name2) });
      }
      const text = buildAsciiZip(parts);
      exec.signal.throwIfAborted();
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text);
      return {
        path: target.display,
        sizeBytes,
        appendedParagraphs: args.paragraphs?.length ?? 0,
        appendedBullets: args.bullets?.length ?? 0,
        appendedTableRows: args.table?.rows.length ?? 0
      };
    }
  }));
}

// src/tools/word.ts
var WORD_CREATE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    title: { type: "string" },
    paragraphCount: { type: "integer", required: true },
    bulletCount: { type: "integer", required: true },
    tableRows: { type: "integer", required: true }
  }
};
var WORD_READ_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    text: { type: "string", required: true },
    totalChars: { type: "integer", required: true },
    truncated: { type: "boolean", required: true },
    sizeBytes: { type: "integer", required: true }
  }
};
function wordCreateCounts(args) {
  const tableCells = args.table === void 0 ? 0 : (args.table.headers.length + args.table.rows.length) * Math.max(1, args.table.headers.length);
  return {
    paragraphs: (args.title === void 0 ? 0 : 1) + (args.paragraphs?.length ?? 0) + (args.bullets?.length ?? 0) + (args.table === void 0 ? 0 : 1 + args.table.rows.length),
    cells: tableCells
  };
}
var W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
var R_NS2 = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function paragraphXml(text, prelude) {
  if (text === "" && prelude === "") return "<w:p/>";
  const run = text === "" ? "" : `<w:r><w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r>`;
  return `<w:p>${prelude}${run}</w:p>`;
}
var BULLET_PRELUDE = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>';
var TITLE_PRELUDE = '<w:pPr><w:pStyle w:val="Title"/></w:pPr>';
function cellXml2(text, bold, widthPercent) {
  const run = text === "" ? "" : `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r>`;
  return `<w:tc><w:tcPr><w:tcW w:w="${widthPercent * 50}" w:type="pct"/></w:tcPr><w:p>${run}</w:p></w:tc>`;
}
function tableXml(table) {
  const columns = Math.max(1, table.headers.length);
  const width = Math.max(1, Math.floor(100 / columns));
  const headerRow = `<w:tr>${table.headers.map((header) => cellXml2(header, true, width)).join("")}</w:tr>`;
  const bodyRows = table.rows.map((row) => `<w:tr>${Array.from({ length: columns }, (_, index) => cellXml2(row[index] ?? "", false, width)).join("")}</w:tr>`);
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${headerRow}${bodyRows.join("")}</w:tbl>`;
}
function documentBodyChildren(args) {
  const children = [];
  if (args.title !== void 0 && args.title.trim() !== "") {
    children.push(paragraphXml(args.title, TITLE_PRELUDE));
  }
  for (const text of args.paragraphs ?? []) {
    children.push(paragraphXml(text, ""));
  }
  for (const item of args.bullets ?? []) {
    children.push(paragraphXml(item, BULLET_PRELUDE));
  }
  if (args.table !== void 0) {
    children.push(tableXml(args.table));
  }
  return children.join("");
}
var SECT_PR = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
function documentXml(bodyChildren) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS} ${R_NS2}><w:body>${bodyChildren}${SECT_PR}</w:body></w:document>`;
}
var STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="300"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style></w:styles>`;
var NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>` + Array.from({ length: 3 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${encodeXmlAttribute("\u2022")}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="${360}"/></w:pPr></w:lvl>`).join("") + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
var CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
var ROOT_RELS_XML2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
var DOCUMENT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>';
function corePropsXml2(title) {
  const escaped = title === void 0 ? "" : encodeXmlText(title);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escaped}</dc:title></cp:coreProperties>`;
}
var APP_PROPS_XML2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>dsh-office-tools</Application></Properties>';
function buildDocxText(args) {
  const parts = [
    { name: "[Content_Types].xml", content: CONTENT_TYPES_XML },
    { name: "_rels/.rels", content: ROOT_RELS_XML2 },
    { name: "word/document.xml", content: documentXml(documentBodyChildren(args)) },
    { name: "word/styles.xml", content: STYLES_XML },
    { name: "word/numbering.xml", content: NUMBERING_XML },
    { name: "word/_rels/document.xml.rels", content: DOCUMENT_RELS_XML },
    { name: "docProps/core.xml", content: corePropsXml2(args.title) },
    { name: "docProps/app.xml", content: APP_PROPS_XML2 }
  ];
  return buildAsciiZip(parts);
}
var W_RUN_PART = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:noBreakHyphen\b[^>]*\/?>|<w:softHyphen\b[^>]*\/?>/g;
var W_PARAGRAPH = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
function paragraphBodyText(bodyXml) {
  const parts = [];
  for (const match of bodyXml.matchAll(W_RUN_PART)) {
    if (match[1] !== void 0) {
      parts.push(decodeXmlEntities(match[1]));
    } else if (match[0].startsWith("<w:tab")) {
      parts.push("	");
    } else if (match[0].startsWith("<w:noBreakHyphen")) {
      parts.push("\u2011");
    } else if (match[0].startsWith("<w:softHyphen")) {
      parts.push("\xAD");
    }
  }
  return parts.join("");
}
function extractDocxText(documentXml2) {
  return [...documentXml2.matchAll(W_PARAGRAPH)].map((match) => (match[1] === void 0 ? "" : paragraphBodyText(match[1])) + "\n\n").join("");
}
var W_BLOCK = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
var W_HEADING_LEVELS = {
  Title: 1,
  Heading1: 1,
  Heading2: 2,
  Heading3: 3,
  Heading4: 4,
  Heading5: 5,
  Heading6: 6
};
var W_P_STYLE = /<w:pStyle w:val="([^"]*)"/;
var W_NUM_PR = /<w:numPr>/;
var W_ILVL = /<w:ilvl w:val="(\d+)"/;
var W_TABLE_ROW = /<w:tr\b[\s\S]*?<\/w:tr>/g;
var W_TABLE_CELL = /<w:tc\b[\s\S]*?<\/w:tc>/g;
function markdownParagraph(paragraphXml2) {
  const styleMatch = paragraphXml2.match(W_P_STYLE);
  const styleId = styleMatch === null ? void 0 : styleMatch[1];
  const body = paragraphBodyText(paragraphXml2);
  if (styleId !== void 0 && W_HEADING_LEVELS[styleId] !== void 0) {
    return `${"#".repeat(W_HEADING_LEVELS[styleId])} ${body}`;
  }
  if (W_NUM_PR.test(paragraphXml2)) {
    const levelMatch = paragraphXml2.match(W_ILVL);
    const level = levelMatch === null ? 0 : Number.parseInt(levelMatch[1], 10);
    return `${"  ".repeat(Math.min(level, 8))}- ${body}`;
  }
  return body;
}
function markdownCellText(cellXml3) {
  return [...cellXml3.matchAll(W_PARAGRAPH)].map((match) => paragraphBodyText(match[1] ?? "").trim()).filter((text) => text !== "").join(" ");
}
function markdownTable(tableXml2) {
  const rows = [...tableXml2.matchAll(W_TABLE_ROW)].map((rowMatch) => [...(rowMatch[0] ?? "").matchAll(W_TABLE_CELL)].map((cellMatch) => markdownCellText(cellMatch[0] ?? "").replace(/\|/g, "\\|")));
  const columns = rows.reduce((width, row) => Math.max(width, row.length), 0);
  if (columns === 0) return "";
  const line = (cells) => `| ${[...cells, ...Array.from({ length: columns - cells.length }, () => "")].join(" | ")} |`;
  return [line(rows[0] ?? []), `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}
function extractDocxMarkdown(documentXml2) {
  const blocks = [];
  for (const match of documentXml2.matchAll(W_BLOCK)) {
    const block = match[0] ?? "";
    if (block.startsWith("<w:tbl")) {
      blocks.push(markdownTable(block));
    } else {
      blocks.push(markdownParagraph(match[1] ?? ""));
    }
  }
  return blocks.join("\n\n");
}
var DOCUMENT_BODY = /<w:body>([\s\S]*)<\/w:body>/g;
var TRAILING_SECT_PR = /<w:sectPr[\s\S]*<\/w:sectPr>\s*$/;
function buildAppendFragment(args) {
  const document = documentXml(documentBodyChildren(args));
  const body = [...document.matchAll(DOCUMENT_BODY)][0]?.[1];
  if (body === void 0) throw new Error("internal error: the append document has no body");
  return body.replace(TRAILING_SECT_PR, "");
}
function appendBeforeSectPr(documentXml2, addition) {
  const sectStart = documentXml2.lastIndexOf("<w:sectPr");
  const closeStart = sectStart !== -1 ? -1 : documentXml2.lastIndexOf("</w:body>");
  const splitAt = sectStart !== -1 ? sectStart : closeStart;
  if (splitAt === -1) throw new Error("word/document.xml has no </w:body>; refusing to modify it");
  const pieces = [documentXml2.slice(0, splitAt), addition, documentXml2.slice(splitAt)];
  return pieces.join("");
}
function registerWordCreate(ctx) {
  return ctx.tools.register(defineTool4({
    name: "word_create",
    description: "Create a Microsoft Word .docx document inside the session workspace from structured content. Supply paragraphs as plain text, optional bullet points, and one optional table (headers + string rows). The file is published atomically through the official workspace file service; pass overwrite: true to replace an existing file. Use word_read afterwards to verify the extracted text.",
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Output path. Relative paths resolve against the session workspace; the extension must be .docx."
      },
      title: {
        type: "string",
        description: "Document title rendered as the title heading. Optional."
      },
      paragraphs: {
        type: "array",
        items: { type: "string" },
        description: "Body paragraphs in document order. Empty strings create blank paragraphs. Optional."
      },
      bullets: {
        type: "array",
        items: { type: "string" },
        description: "Bullet list items rendered after the paragraphs. Optional."
      },
      table: {
        type: "object",
        additionalProperties: false,
        properties: {
          headers: {
            type: "array",
            items: { type: "string" },
            required: true,
            description: "Table column headers (bold)."
          },
          rows: {
            type: "array",
            items: { type: "array", items: { type: "string" } },
            required: true,
            description: "Table body rows; each row should match the header column count."
          }
        },
        description: "One optional table appended after the text content."
      },
      overwrite: {
        type: "boolean",
        description: "Replace the file when it already exists. Defaults to false (existing files are refused)."
      }
    },
    output: {
      schema: WORD_CREATE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `Created Word document ${value.path} (${value.sizeBytes} bytes; ${value.paragraphCount} paragraphs, ${value.bulletCount} bullets, ${value.tableRows} table body rows).`
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Create ${args.path}`,
      kind: "edit",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".docx"], false);
      await assertMayCreate(exec, ctx, target.target, args.overwrite ?? false);
      const { paragraphs: paragraphCount, cells } = wordCreateCounts(args);
      if (paragraphCount > 1e4) throw new Error("too many paragraphs/bullets/table rows (maximum 10000)");
      if (cells > 2e5) throw new Error("too many table cells (maximum 200000)");
      if (args.title === void 0 && (args.paragraphs?.length ?? 0) === 0 && (args.bullets?.length ?? 0) === 0 && args.table === void 0) {
        throw new Error("word_create needs at least one of title, paragraphs, bullets, or table");
      }
      const text = buildDocxText(args);
      exec.signal.throwIfAborted();
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text);
      const result = {
        path: target.display,
        sizeBytes,
        paragraphCount: (args.title === void 0 || args.title.trim() === "" ? 0 : 1) + (args.paragraphs?.length ?? 0),
        bulletCount: args.bullets?.length ?? 0,
        tableRows: args.table?.rows.length ?? 0
      };
      if (args.title !== void 0 && args.title.trim() !== "") result.title = args.title;
      return result;
    }
  }));
}
function registerWordRead(ctx) {
  return ctx.tools.register(defineTool4({
    name: "word_read",
    description: 'Extract text from an existing .docx Word document in the session workspace. Default plain-text mode returns the document text up to the character limit with a truncated flag. Pass format: "markdown" for structured markdown instead: Title/Heading1-6 become # .. ###### headings, bullet/numbered paragraphs become "- " items (indented by level), and tables become markdown tables.',
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "Path to the .docx file, relative to the session workspace or absolute inside it."
      },
      max_chars: {
        type: "integer",
        description: `Maximum characters to return. Defaults to ${MAX_TEXT_CHARS}.`
      },
      format: {
        type: "string",
        enum: ["text", "markdown"],
        description: "Output mode: plain text (default) or structured markdown."
      }
    },
    output: {
      schema: WORD_READ_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: value.text + (value.truncated ? `
[text truncated; total ${value.totalChars} characters]` : "")
      }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Read ${args.path}`,
      kind: "read",
      locations: [{ path: args.path }]
    }),
    async execute(args, exec) {
      const target = await resolveOfficePath(exec, ctx, args.path, [".docx"], true);
      const { bytes, sizeBytes } = await readOfficeBytes(exec, ctx, target.target);
      const zip = readZip(bytes);
      const documentXml2 = readZipXmlPart(zip, "word/document.xml");
      if (documentXml2 === null) {
        throw new Error("the .docx has no word/document.xml part; is this a valid Word file?");
      }
      const fullText = args.format === "markdown" ? extractDocxMarkdown(documentXml2) : extractDocxText(documentXml2);
      const totalChars = fullText.length;
      const maxChars = Math.min(Math.max(args.max_chars ?? MAX_TEXT_CHARS, 1), MAX_TEXT_CHARS);
      const truncated = totalChars > maxChars;
      const text = truncated ? fullText.slice(0, maxChars) : fullText;
      return { path: target.display, text, totalChars, truncated, sizeBytes };
    }
  }));
}
function registerWordTools(ctx) {
  const disposeCreate = registerWordCreate(ctx);
  const disposeRead = registerWordRead(ctx);
  const disposeUpdate = registerWordUpdate(ctx);
  return () => {
    disposeCreate();
    disposeRead();
    disposeUpdate();
  };
}

// src/index.ts
var name = "dsh-office-tools";
var inject = ["tools", "fs"];
var Config = z.object({
  enablePptTools: z.boolean().default(true).description("register ppt_create / ppt_read (set to false to coexist with a dedicated PPT plugin such as dsh-ppt)")
});
function apply(ctx, config) {
  const resolved = Config(config ?? {});
  ctx.effect(() => {
    const disposers = [
      registerWordTools(ctx),
      registerExcelTools(ctx),
      ...resolved.enablePptTools ? [registerPptTools(ctx)] : []
    ];
    return () => disposers.forEach((dispose) => dispose());
  });
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
