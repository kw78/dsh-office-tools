/**
 * Word (.docx) tools over the self-contained OOXML container (1.0.0):
 * `word_create` builds a styled document part set directly (no third-party
 * library — the package is an ASCII-safe STORE zip written through the
 * official fs channel); `word_read` extracts plain text or markdown with the
 * same in-house regex extractor whose behavior is pinned to mammoth 1.11.0's
 * raw-text output by `tests/word-parity.spec.ts`.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildAsciiZip, readZip, readZipXmlPart, type ZipPart } from '../asciizip.ts'
import {
  assertMayCreate, MAX_TEXT_CHARS, readOfficeBytes, resolveOfficePath, saveOfficeText,
} from '../fschannel.ts'
import type { FsContext } from '../fschannel.ts'
import { decodeXmlEntities, encodeXmlAttribute, encodeXmlText, FILE_RESULT_SCHEMA } from './shared.ts'
import { registerWordUpdate } from './word-update.ts'

export interface WordCreateArgs {
  path: string
  title?: string
  paragraphs?: string[]
  bullets?: string[]
  table?: { headers: string[]; rows: string[][] }
  overwrite?: boolean
}

interface WordReadArgs {
  path: string
  max_chars?: number
  format?: 'text' | 'markdown'
}

export interface WordUpdateArgs {
  path: string
  paragraphs?: string[]
  bullets?: string[]
  table?: { headers: string[]; rows: string[][] }
}

const WORD_CREATE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    title: { type: 'string' },
    paragraphCount: { type: 'integer', required: true },
    bulletCount: { type: 'integer', required: true },
    tableRows: { type: 'integer', required: true },
  },
} as const

const WORD_READ_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    text: { type: 'string', required: true },
    totalChars: { type: 'integer', required: true },
    truncated: { type: 'boolean', required: true },
    sizeBytes: { type: 'integer', required: true },
  },
} as const

export function wordCreateCounts(args: WordUpdateArgs & { title?: string }): { paragraphs: number; cells: number } {
  const tableCells = args.table === undefined
    ? 0
    : (args.table.headers.length + args.table.rows.length) * Math.max(1, args.table.headers.length)
  return {
    paragraphs: (args.title === undefined ? 0 : 1)
      + (args.paragraphs?.length ?? 0)
      + (args.bullets?.length ?? 0)
      + (args.table === undefined ? 0 : 1 + args.table.rows.length),
    cells: tableCells,
  }
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** One paragraph with an optional style/numbering prelude and its text. */
function paragraphXml(text: string, prelude: string): string {
  if (text === '' && prelude === '') return '<w:p/>'
  const run = text === '' ? '' : `<w:r><w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r>`
  return `<w:p>${prelude}${run}</w:p>`
}

const BULLET_PRELUDE = '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
const TITLE_PRELUDE = '<w:pPr><w:pStyle w:val="Title"/></w:pPr>'

function cellXml(text: string, bold: boolean, widthPercent: number): string {
  const run = text === '' ? '' : `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${encodeXmlText(text)}</w:t></w:r>`
  return `<w:tc><w:tcPr><w:tcW w:w="${widthPercent * 50}" w:type="pct"/></w:tcPr><w:p>${run}</w:p></w:tc>`
}

function tableXml(table: { headers: string[]; rows: string[][] }): string {
  const columns = Math.max(1, table.headers.length)
  const width = Math.max(1, Math.floor(100 / columns))
  const headerRow = `<w:tr>${table.headers.map(header => cellXml(header, true, width)).join('')}</w:tr>`
  const bodyRows = table.rows.map(row =>
    `<w:tr>${Array.from({ length: columns }, (_, index) => cellXml(row[index] ?? '', false, width)).join('')}</w:tr>`)
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>${headerRow}${bodyRows.join('')}</w:tbl>`
}

/** The document body children for one create/update argument set, in order. */
function documentBodyChildren(args: WordUpdateArgs & { title?: string }): string {
  const children: string[] = []
  if (args.title !== undefined && args.title.trim() !== '') {
    children.push(paragraphXml(args.title, TITLE_PRELUDE))
  }
  for (const text of args.paragraphs ?? []) {
    children.push(paragraphXml(text, ''))
  }
  for (const item of args.bullets ?? []) {
    children.push(paragraphXml(item, BULLET_PRELUDE))
  }
  if (args.table !== undefined) {
    children.push(tableXml(args.table))
  }
  return children.join('')
}

const SECT_PR = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'

function documentXml(bodyChildren: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document ${W_NS} ${R_NS}><w:body>${bodyChildren}${SECT_PR}</w:body></w:document>`
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<w:styles ${W_NS}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:spacing w:after="300"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>'
  + '<w:pPr><w:ind w:left="720"/></w:pPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr>'
  + '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:left w:val="single" w:sz="4" w:color="auto"/>'
  + '<w:bottom w:val="single" w:sz="4" w:color="auto"/><w:right w:val="single" w:sz="4" w:color="auto"/>'
  + '<w:insideH w:val="single" w:sz="4" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style>'
  + '</w:styles>'

const NUMBERING_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<w:numbering ${W_NS}>`
  + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
  + Array.from({ length: 3 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>`
    + `<w:lvlText w:val="${encodeXmlAttribute('\u2022')}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${720 * (level + 1)}" w:hanging="${360}"/></w:pPr></w:lvl>`).join('')
  + '</w:abstractNum>'
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
  + '</w:numbering>'

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  + '</Types>'

const ROOT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + '</Relationships>'

const DOCUMENT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
  + '</Relationships>'

function corePropsXml(title: string | undefined): string {
  const escaped = title === undefined ? '' : encodeXmlText(title)
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:title>${escaped}</dc:title></cp:coreProperties>`
}

const APP_PROPS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
  + '<Application>dsh-office-tools</Application></Properties>'

/** Build the complete .docx package as an ASCII-safe zip string. */
export function buildDocxText(args: WordUpdateArgs & { title?: string }): string {
  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', content: CONTENT_TYPES_XML },
    { name: '_rels/.rels', content: ROOT_RELS_XML },
    { name: 'word/document.xml', content: documentXml(documentBodyChildren(args)) },
    { name: 'word/styles.xml', content: STYLES_XML },
    { name: 'word/numbering.xml', content: NUMBERING_XML },
    { name: 'word/_rels/document.xml.rels', content: DOCUMENT_RELS_XML },
    { name: 'docProps/core.xml', content: corePropsXml(args.title) },
    { name: 'docProps/app.xml', content: APP_PROPS_XML },
  ]
  return buildAsciiZip(parts)
}

/**
 * Inline content of one `<w:p>` paragraph, in document order: text runs
 * (entities decoded), tabs, and the two hyphen characters mammoth renders.
 * `<w:br>`/`<w:cr>` are matched too and contribute nothing — mammoth's raw
 * text drops line breaks, and we pin to that.
 */
const W_RUN_PART = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>|<w:noBreakHyphen\b[^>]*\/?>|<w:softHyphen\b[^>]*\/?>/g

/**
 * One paragraph: the paired form captures its body; the self-closing form
 * (`<w:p/>`) is an empty paragraph. Table cells, hyperlinks, and textboxes
 * nest plain `<w:p>` elements, so a global scan keeps document order.
 */
const W_PARAGRAPH = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g

function paragraphBodyText(bodyXml: string): string {
  const parts: string[] = []
  for (const match of bodyXml.matchAll(W_RUN_PART)) {
    if (match[1] !== undefined) {
      parts.push(decodeXmlEntities(match[1]))
    } else if (match[0].startsWith('<w:tab')) {
      parts.push('\t')
    } else if (match[0].startsWith('<w:noBreakHyphen')) {
      parts.push('\u2011')
    } else if (match[0].startsWith('<w:softHyphen')) {
      parts.push('\u00AD')
    }
  }
  return parts.join('')
}

/**
 * Extract mammoth-compatible plain text from a `word/document.xml` string:
 * every paragraph — body, table cell, hyperlink, or textbox — contributes its
 * runs followed by `\n\n`, including the final and empty paragraphs.
 */
export function extractDocxText(documentXml: string): string {
  return [...documentXml.matchAll(W_PARAGRAPH)]
    .map(match => (match[1] === undefined ? '' : paragraphBodyText(match[1])) + '\n\n')
    .join('')
}

/**
 * Markdown mode (0.5.0): body children in document order, one block per
 * `<w:p>`/`<w:tbl>`. Tables are matched FIRST so their inner paragraphs stay
 * inside the table block instead of leaking out as plain paragraphs.
 */
const W_BLOCK = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g

/** Title and the six headings share Word's built-in style ids in both files we write and files Word writes. */
const W_HEADING_LEVELS: Record<string, number> = {
  Title: 1,
  Heading1: 1,
  Heading2: 2,
  Heading3: 3,
  Heading4: 4,
  Heading5: 5,
  Heading6: 6,
}

const W_P_STYLE = /<w:pStyle w:val="([^"]*)"/
const W_NUM_PR = /<w:numPr>/
const W_ILVL = /<w:ilvl w:val="(\d+)"/
const W_TABLE_ROW = /<w:tr\b[\s\S]*?<\/w:tr>/g
const W_TABLE_CELL = /<w:tc\b[\s\S]*?<\/w:tc>/g

/** One paragraph as a markdown block: heading prefix, list marker, or plain text. */
function markdownParagraph(paragraphXml: string): string {
  const styleMatch = (paragraphXml).match(W_P_STYLE)
  const styleId = styleMatch === null ? undefined : styleMatch[1]
  const body = paragraphBodyText(paragraphXml)
  if (styleId !== undefined && W_HEADING_LEVELS[styleId] !== undefined) {
    return `${'#'.repeat(W_HEADING_LEVELS[styleId]!)} ${body}`
  }
  if (W_NUM_PR.test(paragraphXml)) {
    const levelMatch = (paragraphXml).match(W_ILVL)
    const level = levelMatch === null ? 0 : Number.parseInt(levelMatch[1]!, 10)
    return `${'  '.repeat(Math.min(level, 8))}- ${body}`
  }
  return body
}

/** All inline text of one table cell: its paragraphs joined with single spaces. */
function markdownCellText(cellXml: string): string {
  return [...cellXml.matchAll(W_PARAGRAPH)]
    .map(match => paragraphBodyText(match[1] ?? '').trim())
    .filter(text => text !== '')
    .join(' ')
}

/** One `<w:tbl>` as a markdown table: first row is the header, short rows padded. */
function markdownTable(tableXml: string): string {
  const rows = [...tableXml.matchAll(W_TABLE_ROW)].map(rowMatch =>
    [...(rowMatch[0] ?? '').matchAll(W_TABLE_CELL)].map(cellMatch => markdownCellText(cellMatch[0] ?? '').replace(/\|/g, '\\|')))
  const columns = rows.reduce((width, row) => Math.max(width, row.length), 0)
  if (columns === 0) return ''
  const line = (cells: string[]) => `| ${[...cells, ...Array.from({ length: columns - cells.length }, () => '')].join(' | ')} |`
  return [line(rows[0] ?? []), `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

/**
 * Extract structured markdown from a `word/document.xml` string: Title and
 * Heading1-6 render as `#`..`######`, numbered/bullet paragraphs as indented
 * `- ` items, tables as markdown tables, everything else as plain blocks —
 * inline rules identical to {@link extractDocxText}.
 */
export function extractDocxMarkdown(documentXml: string): string {
  const blocks: string[] = []
  for (const match of documentXml.matchAll(W_BLOCK)) {
    const block = match[0] ?? ''
    if (block.startsWith('<w:tbl')) {
      blocks.push(markdownTable(block))
    } else {
      blocks.push(markdownParagraph(match[1] ?? ''))
    }
  }
  return blocks.join('\n\n')
}

const DOCUMENT_BODY = /<w:body>([\s\S]*)<\/w:body>/g
const TRAILING_SECT_PR = /<w:sectPr[\s\S]*<\/w:sectPr>\s*$/

/**
 * Body children for an append, generated by the same part builder
 * word_create uses (so paragraphs, bullets, and tables come out identical)
 * and extracted from the throwaway document minus its trailing `<w:sectPr>`.
 */
export function buildAppendFragment(args: WordUpdateArgs): string {
  const document = documentXml(documentBodyChildren(args))
  const body = [...document.matchAll(DOCUMENT_BODY)][0]?.[1]
  if (body === undefined) throw new Error('internal error: the append document has no body')
  return body.replace(TRAILING_SECT_PR, '')
}

/**
 * Splice new body children into `word/document.xml`: appended content goes
 * right before the trailing `<w:sectPr>` (page setup must stay the last body
 * child), or before `</w:body>` when the document has no section properties.
 */
export function appendBeforeSectPr(documentXml: string, addition: string): string {
  const sectStart = documentXml.lastIndexOf('<w:sectPr')
  const closeStart = sectStart !== -1 ? -1 : documentXml.lastIndexOf('</w:body>')
  const splitAt = sectStart !== -1 ? sectStart : closeStart
  if (splitAt === -1) throw new Error('word/document.xml has no </w:body>; refusing to modify it')
  const pieces = [documentXml.slice(0, splitAt), addition, documentXml.slice(splitAt)]
  return pieces.join('')
}

function registerWordCreate(ctx: Context & FsContext): () => void {
  return ctx.tools.register(defineTool({
    name: 'word_create',
    description:
      'Create a Microsoft Word .docx document inside the session workspace from structured content. '
      + 'Supply paragraphs as plain text, optional bullet points, and one optional table (headers + string rows). '
      + 'The file is published atomically through the official workspace file service; pass overwrite: true to replace an existing file. '
      + 'Use word_read afterwards to verify the extracted text.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Output path. Relative paths resolve against the session workspace; the extension must be .docx.',
      },
      title: {
        type: 'string',
        description: 'Document title rendered as the title heading. Optional.',
      },
      paragraphs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Body paragraphs in document order. Empty strings create blank paragraphs. Optional.',
      },
      bullets: {
        type: 'array',
        items: { type: 'string' },
        description: 'Bullet list items rendered after the paragraphs. Optional.',
      },
      table: {
        type: 'object',
        additionalProperties: false,
        properties: {
          headers: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Table column headers (bold).',
          },
          rows: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            required: true,
            description: 'Table body rows; each row should match the header column count.',
          },
        },
        description: 'One optional table appended after the text content.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace the file when it already exists. Defaults to false (existing files are refused).',
      },
    },
    output: {
      schema: WORD_CREATE_OUTPUT,
      render: (_args, value: any) => [{
        type: 'text',
        text: `Created Word document ${value.path} (${value.sizeBytes} bytes; ${value.paragraphCount} paragraphs, ${value.bulletCount} bullets, ${value.tableRows} table body rows).`,
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Create ${args.path}`,
      kind: 'edit',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec: ToolRunContext) {
      const target = await resolveOfficePath(exec, ctx, args.path, ['.docx'], false)
      await assertMayCreate(exec, ctx, target.target, args.overwrite ?? false)
      const { paragraphs: paragraphCount, cells } = wordCreateCounts(args)
      if (paragraphCount > 10_000) throw new Error('too many paragraphs/bullets/table rows (maximum 10000)')
      if (cells > 200_000) throw new Error('too many table cells (maximum 200000)')
      if (args.title === undefined && (args.paragraphs?.length ?? 0) === 0 && (args.bullets?.length ?? 0) === 0 && args.table === undefined) {
        throw new Error('word_create needs at least one of title, paragraphs, bullets, or table')
      }

      const text = buildDocxText(args)
      exec.signal.throwIfAborted()
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text)
      const result: {
        path: string
        sizeBytes: number
        title?: string
        paragraphCount: number
        bulletCount: number
        tableRows: number
      } = {
        path: target.display,
        sizeBytes,
        paragraphCount: (args.title === undefined || args.title.trim() === '' ? 0 : 1) + (args.paragraphs?.length ?? 0),
        bulletCount: args.bullets?.length ?? 0,
        tableRows: args.table?.rows.length ?? 0,
      }
      if (args.title !== undefined && args.title.trim() !== '') result.title = args.title
      return result
    },
  }))
}

function registerWordRead(ctx: Context & FsContext): () => void {
  return ctx.tools.register(defineTool({
    name: 'word_read',
    description:
      'Extract text from an existing .docx Word document in the session workspace. '
      + 'Default plain-text mode returns the document text up to the character limit with a truncated flag. '
      + 'Pass format: "markdown" for structured markdown instead: Title/Heading1-6 become # .. ###### headings, bullet/numbered paragraphs become "- " items (indented by level), and tables become markdown tables.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the .docx file, relative to the session workspace or absolute inside it.',
      },
      max_chars: {
        type: 'integer',
        description: `Maximum characters to return. Defaults to ${MAX_TEXT_CHARS}.`,
      },
      format: {
        type: 'string',
        enum: ['text', 'markdown'],
        description: 'Output mode: plain text (default) or structured markdown.',
      },
    },
    output: {
      schema: WORD_READ_OUTPUT,
      render: (_args, value: any) => [{
        type: 'text',
        text: value.text + (value.truncated ? `\n[text truncated; total ${value.totalChars} characters]` : ''),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Read ${args.path}`,
      kind: 'read',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec: ToolRunContext) {
      const target = await resolveOfficePath(exec, ctx, args.path, ['.docx'], true)
      const { bytes, sizeBytes } = await readOfficeBytes(exec, ctx, target.target)
      const zip = readZip(bytes)
      const documentXml = readZipXmlPart(zip, 'word/document.xml')
      if (documentXml === null) {
        throw new Error('the .docx has no word/document.xml part; is this a valid Word file?')
      }
      const fullText = args.format === 'markdown' ? extractDocxMarkdown(documentXml) : extractDocxText(documentXml)
      const totalChars = fullText.length
      const maxChars = Math.min(Math.max(args.max_chars ?? MAX_TEXT_CHARS, 1), MAX_TEXT_CHARS)
      const truncated = totalChars > maxChars
      const text = truncated ? fullText.slice(0, maxChars) : fullText
      return { path: target.display, text, totalChars, truncated, sizeBytes }
    },
  }))
}

export function registerWordTools(ctx: Context & FsContext): () => void {
  const disposeCreate = registerWordCreate(ctx)
  const disposeRead = registerWordRead(ctx)
  const disposeUpdate = registerWordUpdate(ctx)
  return () => {
    disposeCreate()
    disposeRead()
    disposeUpdate()
  }
}
