/**
 * Shared schema fragments, cell types, and the ASCII-safe XML encoders for
 * the Office tool suite. Keeping the schemas in one place keeps the eight
 * tool contracts consistent; the encoders guarantee that generated XML stays
 * pure ASCII (non-ASCII text becomes decimal character references), which is
 * the invariant the ASCII-safe zip writer builds on.
 */

import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

/** One cell value accepted by the Excel tools. */
export const CELL_VALUE_SCHEMA = {
  oneOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
  ],
} as const satisfies ValueSchemaSpec

/** One spreadsheet row. */
export const ROW_SCHEMA = {
  type: 'array',
  items: CELL_VALUE_SCHEMA,
} as const satisfies ValueSchemaSpec

/** Common success echo for a created/replaced file. */
export const FILE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    sizeBytes: { type: 'integer', required: true },
  },
} as const satisfies ValueSchemaSpec

export type CellValue = string | number | boolean | null

export type CellRow = CellValue[]

/**
 * Encode one character for XML text or a double-quoted attribute value: the
 * five predefined entities, control characters, and — critically for the
 * ASCII-safe container — every code point above 0x7F as a decimal character
 * reference.
 */
function encodeXmlChar(code: number): string {
  if (code > 0x7f) return `&#${code};`
  if (code < 0x20 && code !== 0x9 && code !== 0xa && code !== 0xd) return ''
  return String.fromCharCode(code)
}

/** Escape text for XML element content, keeping the output pure ASCII. */
export function encodeXmlText(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '&') out += '&amp;'
    else if (char === '<') out += '&lt;'
    else if (char === '>') out += '&gt;'
    else out += encodeXmlChar(code)
  }
  return out
}

/** Escape text for a double-quoted XML attribute value, keeping it pure ASCII. */
export function encodeXmlAttribute(value: string): string {
  let out = ''
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (char === '&') out += '&amp;'
    else if (char === '<') out += '&lt;'
    else if (char === '>') out += '&gt;'
    else if (char === '"') out += '&quot;'
    else out += encodeXmlChar(code)
  }
  return out
}

/**
 * Decode the XML entities that can legally appear in OOXML text content: the
 * five predefined names plus decimal/hex character references.
 */
export function decodeXmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity, code: string) => {
    if (code === 'amp') return '&'
    if (code === 'lt') return '<'
    if (code === 'gt') return '>'
    if (code === 'quot') return '"'
    if (code === 'apos') return "'"
    const number = code.startsWith('#x') ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10)
    return Number.isFinite(number) ? String.fromCodePoint(number) : entity
  })
}
