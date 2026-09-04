/**
 * Excel (.xlsx) tools over the self-contained OOXML container (1.0.0):
 * `excel_create` writes a new workbook, `excel_read` materializes sheets as
 * rows of scalar cells, and `excel_update` replaces/creates whole sheets
 * and/or writes individual cell values into an existing workbook. Reads
 * accept any real-world package (STORE and DEFLATE); writes and rewrites are
 * ASCII-safe STORE packages published through the official fs channel, with
 * strings written inline and '=…' strings materialized as real `<f>` formula
 * cells exactly like the SheetJS-era behavior the tests pin.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { asciiPartsOf, buildAsciiZip, readZip, readZipXmlPart, type ZipPart } from '../asciizip.ts'
import {
  assertMayCreate, MAX_READ_CELLS, MAX_WRITE_CELLS, readOfficeBytes, resolveOfficePath, saveOfficeText,
} from '../fschannel.ts'
import type { FsContext } from '../fschannel.ts'
import {
  CELL_VALUE_SCHEMA, decodeXmlEntities, encodeXmlAttribute, encodeXmlText, FILE_RESULT_SCHEMA, ROW_SCHEMA,
  type CellRow, type CellValue,
} from './shared.ts'

interface SheetSpec {
  name: string
  rows: CellRow[]
}

interface ExcelCreateArgs {
  path: string
  sheets: SheetSpec[]
  overwrite?: boolean
}

interface ExcelReadArgs {
  path: string
  sheet?: string
  max_rows?: number
}

interface CellUpdate {
  sheet: string
  cell: string
  value: CellValue
}

interface ExcelUpdateArgs {
  path: string
  sheets?: SheetSpec[]
  cell_updates?: CellUpdate[]
}

const SHEET_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    rowCount: { type: 'integer', required: true },
    colCount: { type: 'integer', required: true },
  },
} as const

const EXCEL_CREATE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    sheets: {
      type: 'array',
      required: true,
      items: SHEET_RESULT_SCHEMA,
    },
  },
} as const

const READ_SHEET_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    rows: {
      type: 'array',
      required: true,
      items: ROW_SCHEMA,
    },
    truncated: { type: 'boolean', required: true },
  },
} as const

const EXCEL_READ_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    sheets: {
      type: 'array',
      required: true,
      items: READ_SHEET_RESULT_SCHEMA,
    },
    sizeBytes: { type: 'integer', required: true },
  },
} as const

const CELL_UPDATE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sheet: { type: 'string', required: true },
    cell: { type: 'string', required: true },
  },
} as const

const EXCEL_UPDATE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    sheetNames: {
      type: 'array',
      required: true,
      items: { type: 'string' },
    },
    updatedSheets: {
      type: 'array',
      required: true,
      items: { type: 'string' },
    },
    cellUpdates: {
      type: 'array',
      required: true,
      items: CELL_UPDATE_RESULT_SCHEMA,
    },
  },
} as const

/** Cell model kept between parse and serialize: a value or an uncached formula. */
type GridCell = { kind: 'value'; value: CellValue } | { kind: 'formula'; formula: string } | undefined

interface SheetModel {
  name: string
  part: string
  content: string
  grid: Map<string, GridCell>
  maxRow: number
  maxColumn: number
}

function validateSheetSpecs(sheets: SheetSpec[]): void {
  if (sheets.length === 0) throw new Error('sheets must contain at least one sheet')
  const seen = new Set<string>()
  let totalCells = 0
  let totalRows = 0
  for (const sheet of sheets) {
    if (sheet.name.trim() === '') throw new Error('sheet name must be a non-empty string')
    if (seen.has(sheet.name)) throw new Error(`duplicate sheet name "${sheet.name}" in one call`)
    seen.add(sheet.name)
    if (sheet.rows.length > 10_000) throw new Error(`sheet "${sheet.name}" has too many rows (maximum 10000)`)
    totalRows += sheet.rows.length
    for (const row of sheet.rows) {
      totalCells += row.length
      if (totalCells > MAX_WRITE_CELLS) throw new Error(`too many worksheet cells (maximum ${MAX_WRITE_CELLS})`)
    }
  }
  if (totalRows === 0) throw new Error('at least one row is required across the sheets')
}

function columnName(index: number): string {
  let name = ''
  let value = index
  do {
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return name
}

function columnIndexOf(name: string): number {
  let value = 0
  for (const char of name.toUpperCase()) {
    const code = char.charCodeAt(0)
    if (code < 65 || code > 90) return -1
    value = value * 26 + (code - 64)
  }
  return value - 1
}

function parseCellAddress(address: string): { row: number; column: number } {
  const match = address.match(/^([A-Za-z]+)([1-9][0-9]*)$/)
  if (match === null) return { row: -1, column: -1 }
  return { row: Number.parseInt(match[2]!, 10) - 1, column: columnIndexOf(match[1]!) }
}

function cellAddress(row: number, column: number): string {
  return `${columnName(column)}${row + 1}`
}

/** Grid coordinates ('B2') of every cell of one parsed grid, row-major. */
function gridAddresses(grid: Map<string, GridCell>): { address: string; row: number; column: number }[] {
  const addresses = [...grid.keys()].map(address => {
    const { row, column } = parseCellAddress(address)
    return { address, row, column }
  }).filter(item => item.row >= 0 && item.column >= 0 && grid.get(item.address) !== undefined)
  addresses.sort((left, right) => left.row - right.row || left.column - right.column)
  return addresses
}

function gridOf(rows: CellRow[]): Map<string, GridCell> {
  const grid = new Map<string, GridCell>()
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      grid.set(cellAddress(rowIndex, columnIndex), gridCellOf(value))
    })
  })
  return grid
}

/**
 * The write-side cell rule kept from the SheetJS era: null writes an empty
 * string cell (present, reads back as ''), a string starting with '=' becomes
 * an uncached formula cell, everything else is a plain scalar.
 */
function gridCellOf(value: CellValue): GridCell {
  if (typeof value === 'string' && value.startsWith('=')) {
    return { kind: 'formula', formula: value.slice(1) }
  }
  return { kind: 'value', value }
}

function cellXml(address: string, cell: NonNullable<GridCell>): string {
  if (cell.kind === 'formula') {
    return `<c r="${address}" t="e"><f>${encodeXmlText(cell.formula)}</f></c>`
  }
  const value = cell.value
  if (value === null) return `<c r="${address}" t="inlineStr"><is><t/></is></c>`
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cell ${address} holds a non-finite number; excel tools refuse it`)
    return `<c r="${address}"><v>${value}</v></c>`
  }
  if (typeof value === 'boolean') {
    return `<c r="${address}" t="b"><v>${value ? 1 : 0}</v></c>`
  }
  if (value === '') return `<c r="${address}" t="inlineStr"><is><t/></is></c>`
  if (typeof value === 'string' && value.startsWith('=')) {
    return `<c r="${address}" t="e"><f>${encodeXmlText(value.slice(1))}</f></c>`
  }
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${encodeXmlText(value)}</t></is></c>`
}

function sheetXml(grid: Map<string, GridCell>): string {
  const addresses = gridAddresses(grid)
  const rows = new Map<number, string[]>()
  for (const item of addresses) {
    const cells = rows.get(item.row) ?? []
    cells.push(cellXml(item.address, grid.get(item.address)!))
    rows.set(item.row, cells)
  }
  const last = addresses.at(-1)
  const dimension = last === undefined ? 'A1' : `A1:${last.address}`
  const body = [...rows.entries()].sort((left, right) => left[0] - right[0])
    .map(([rowIndex, cells]) => `<row r="${rowIndex + 1}">${cells.join('')}</row>`).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="${dimension}"/><sheetData>${body}</sheetData></worksheet>`
}

const XLSX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  + '</Types>'

const XLSX_ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + '</Relationships>'

const XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
  + '</styleSheet>'

const XLSX_APP_PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
  + '<Application>dsh-office-tools</Application></Properties>'

const XLSX_CORE_PROPS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
  + 'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Workbook</dc:title></cp:coreProperties>'

/** Assemble the full workbook package for the given ordered sheet models. */
function buildXlsxText(models: SheetModel[]): string {
  const workbookSheets = models.map((model, index) =>
    `<sheet name="${encodeXmlAttribute(model.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${workbookSheets}</sheets></workbook>`
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + models.map((model, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${encodeXmlAttribute(model.part)}"/>`).join('')
    + '</Relationships>'
  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', content: XLSX_CONTENT_TYPES },
    { name: '_rels/.rels', content: XLSX_ROOT_RELS },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { name: 'xl/styles.xml', content: XLSX_STYLES },
    { name: 'docProps/core.xml', content: XLSX_CORE_PROPS },
    { name: 'docProps/app.xml', content: XLSX_APP_PROPS },
  ]
  for (const model of models) {
    parts.push({ name: `xl/${model.part}`, content: model.content })
  }
  return buildAsciiZip(parts)
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const SHARED_STRING_ITEM = /<si>([\s\S]*?)<\/si>/g
const SHARED_STRING_TEXT = /<t\b[^>]*>([\s\S]*?)<\/w:t>|<t\b[^>]*>([\s\S]*?)<\/t>/g

function parseSharedStrings(xml: string): string[] {
  const values: string[] = []
  for (const item of xml.matchAll(SHARED_STRING_ITEM)) {
    let text = ''
    for (const run of (item[1] ?? '').matchAll(SHARED_STRING_TEXT)) {
      text += decodeXmlEntities(run[1] ?? run[2] ?? '')
    }
    values.push(text)
  }
  return values
}

const WORKBOOK_SHEET = /<sheet\b[^>]*?name="([^"]*)"[^>]*?(?:r:id="([^"]*)")?[^>]*?\/>/g
const RELATIONSHIP = /<Relationship\b[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?\/>/g
const SHEET_ROW = /<row\b[^>]*?r="(\d+)"[^>]*?>([\s\S]*?)<\/row>/g
const SHEET_CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
const CELL_REF = /\br="([A-Za-z]+)(\d+)"/
const CELL_TYPE = /\bt="([^"]*)"/
const CELL_VALUE = /<v\b[^>]*>([\s\S]*?)<\/v>/
const CELL_FORMULA = /<f\b[^>]*>([\s\S]*?)<\/f>/
const CELL_INLINE_TEXT = /<t\b[^>]*>([\s\S]*?)<\/t>/

/**
 * Materialize one worksheet as rows of scalar values, replicating the legacy
 * SheetJS `sheet_to_json(header:1, raw:false)` cell-for-cell contract the
 * tests pin: formatted strings for scalars, "TRUE"/"FALSE" for booleans,
 * null for gaps — plus the two kept extensions: an uncached formula returns
 * its formula as an `'=SUM(A1:A1)'` string, and rows holding only such
 * formulas survive instead of being dropped as blank.
 */
function worksheetRows(grid: Map<string, GridCell>): CellRow[] {
  const addresses = gridAddresses(grid)
  if (addresses.length === 0) return []
  const lastRow = addresses[addresses.length - 1]!.row
  const lastColumn = addresses.reduce((width, item) => Math.max(width, item.column), 0)
  const rows: CellRow[] = []
  for (let rowIndex = 0; rowIndex <= lastRow; rowIndex += 1) {
    const row: CellRow = []
    let hasValue = false
    for (let columnIndex = 0; columnIndex <= lastColumn; columnIndex += 1) {
      const value = gridCellToValue(grid.get(cellAddress(rowIndex, columnIndex)))
      if (value !== null) hasValue = true
      row.push(value)
    }
    if (hasValue) rows.push(row)
  }
  return rows
}

function gridCellToValue(cell: GridCell): CellValue {
  if (cell === undefined) return null
  if (cell.kind === 'formula') return `=${cell.formula}`
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE'
  if (typeof cell.value === 'number') return String(cell.value)
  return cell.value
}

/** Parse one `xl/worksheets/sheetN.xml` into the shared grid model. */
function parseSheetXml(xml: string, sharedStrings: string[]): Map<string, GridCell> {
  const grid = new Map<string, GridCell>()
  for (const rowMatch of xml.matchAll(SHEET_ROW)) {
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(SHEET_CELL)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const ref = (attributes).match(CELL_REF)
      if (ref === null) continue
      const address = `${ref[1]!}${ref[2]!}`
      const type = (attributes).match(CELL_TYPE)?.[1]
      const rawValue = (body).match(CELL_VALUE)?.[1]
      const formula = (body).match(CELL_FORMULA)?.[1]
      const inlineText = (body).match(CELL_INLINE_TEXT)?.[1]
      let cell: GridCell
      if (formula !== undefined) {
        if (rawValue !== undefined && type !== 'e') {
          cell = { kind: 'value', value: decodeXmlEntities(rawValue) }
        } else {
          cell = { kind: 'formula', formula: decodeXmlEntities(formula) }
        }
      } else if (type === 's') {
        const index = rawValue === undefined ? -1 : Number.parseInt(rawValue, 10)
        cell = { kind: 'value', value: sharedStrings[index] ?? '' }
      } else if (type === 'inlineStr') {
        cell = { kind: 'value', value: inlineText === undefined ? '' : decodeXmlEntities(inlineText) }
      } else if (type === 'b') {
        cell = { kind: 'value', value: rawValue === '1' ? 'TRUE' : 'FALSE' }
      } else if (type === 'str') {
        cell = { kind: 'value', value: rawValue === undefined ? '' : decodeXmlEntities(rawValue) }
      } else if (rawValue !== undefined) {
        cell = { kind: 'value', value: decodeXmlEntities(rawValue) }
      } else {
        cell = { kind: 'value', value: '' }
      }
      grid.set(address, cell)
    }
  }
  return grid
}

interface WorkbookModel {
  names: string[]
  sheets: Map<string, SheetModel>
}

/** Parse `xl/workbook.xml` + its rels and every referenced worksheet. */
function parseWorkbook(zip: ReturnType<typeof readZip>): WorkbookModel {
  const workbookXml = readZipXmlPart(zip, 'xl/workbook.xml')
  if (workbookXml === null) throw new Error('the .xlsx has no xl/workbook.xml part; is this a valid Excel file?')
  const relsXml = readZipXmlPart(zip, 'xl/_rels/workbook.xml.rels') ?? ''
  const targets = new Map<string, string>()
  for (const rel of relsXml.matchAll(RELATIONSHIP)) {
    targets.set(rel[1]!, rel[2]!)
  }
  const sharedStringsXml = readZipXmlPart(zip, 'xl/sharedStrings.xml')
  const sharedStrings = sharedStringsXml === null ? [] : parseSharedStrings(sharedStringsXml)

  const sheets = new Map<string, SheetModel>()
  const names: string[] = []
  for (const sheetMatch of workbookXml.matchAll(WORKBOOK_SHEET)) {
    const name = decodeXmlEntities(sheetMatch[1]!)
    const id = sheetMatch[2]
    const target = id === undefined ? undefined : targets.get(id)
    const part = target === undefined
      ? `worksheets/sheet${names.length + 1}.xml`
      : target.replace(/^\//, '').replace(/^xl\//, '')
    const sheetXml = readZipXmlPart(zip, `xl/${part}`)
    if (sheetXml === null) continue
    const grid = parseSheetXml(sheetXml, sharedStrings)
    const addresses = gridAddresses(grid)
    const last = addresses.at(-1)
    sheets.set(name, {
      name,
      part,
      content: sheetXml,
      grid,
      maxRow: last?.row ?? -1,
      maxColumn: last?.column ?? -1,
    })
    names.push(name)
  }
  return { names, sheets }
}

function registerExcelCreate(ctx: Context & FsContext): () => void {
  return ctx.tools.register(defineTool({
    name: 'excel_create',
    description:
      'Create a new .xlsx Excel workbook in the session workspace from structured sheets. '
      + 'Each sheet has a name and an array of rows; each row is an array of scalar cells (string, number, boolean, or null). '
      + 'Use excel_update to change an existing workbook without recreating it.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Output path. Relative paths resolve against the session workspace; the extension must be .xlsx.',
      },
      sheets: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Worksheet name (unique within this call).' },
            rows: {
              type: 'array',
              required: true,
              items: ROW_SCHEMA,
              description: 'Grid rows; the first row is typically a header row. String cells starting with = are written as formulas.',
            },
          },
        },
        description: 'Sheets to write, in tab order.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace the file when it already exists. Defaults to false.',
      },
    },
    output: {
      schema: EXCEL_CREATE_OUTPUT,
      render: (_args, value: any) => [{
        type: 'text',
        text: `Created Excel workbook ${value.path} (${value.sizeBytes} bytes; ${value.sheets.length} sheet(s): ${value.sheets.map((sheet: any) => `${sheet.name} ${sheet.rowCount}x${sheet.colCount}`).join(', ')}).`,
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Create ${args.path}`,
      kind: 'edit',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec: ToolRunContext) {
      const target = await resolveOfficePath(exec, ctx, args.path, ['.xlsx'], false)
      await assertMayCreate(exec, ctx, target.target, args.overwrite ?? false)
      validateSheetSpecs(args.sheets)
      exec.signal.throwIfAborted()

      const summaries: Array<{ name: string; rowCount: number; colCount: number }> = []
      const models = args.sheets.map((spec, index) => {
        const grid = gridOf(spec.rows)
        const last = gridAddresses(grid).at(-1)
        const model: SheetModel = {
          name: spec.name,
          part: `worksheets/sheet${index + 1}.xml`,
          content: sheetXml(grid),
          grid,
          maxRow: last?.row ?? -1,
          maxColumn: last?.column ?? -1,
        }
        summaries.push({
          name: spec.name,
          rowCount: spec.rows.length,
          colCount: spec.rows.length === 0 ? 0 : Math.max(...spec.rows.map(row => row.length)),
        })
        return model
      })

      const text = buildXlsxText(models)
      exec.signal.throwIfAborted()
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text)
      return { path: target.display, sizeBytes, sheets: summaries }
    },
  }))
}

function registerExcelRead(ctx: Context & FsContext): () => void {
  return ctx.tools.register(defineTool({
    name: 'excel_read',
    description:
      'Read one or all sheets of an existing .xlsx workbook and return each sheet as rows of scalar values (formatted strings). '
      + 'Formula cells return their cached value when one exists; formulas without a cached value return the formula as an "=SUM(…)" string. '
      + 'Rows are capped; the per-sheet `truncated` flag reports when more rows were not returned. '
      + 'Pass `sheet` to read a single named sheet.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the .xlsx file, relative to the session workspace or absolute inside it.',
      },
      sheet: {
        type: 'string',
        description: 'Read only this worksheet by exact name. Omit to read every sheet.',
      },
      max_rows: {
        type: 'integer',
        description: 'Maximum rows returned per sheet. Defaults to 5000.',
      },
    },
    output: {
      schema: EXCEL_READ_OUTPUT,
      render: (_args, value: any) => [{
        type: 'text',
        text: value.sheets.map((sheet: any) =>
          `${sheet.name} (${sheet.rows.length} row(s)${sheet.truncated ? ', truncated' : ''}):\n`
          + JSON.stringify(sheet.rows),
        ).join('\n\n'),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Read ${args.path}`,
      kind: 'read',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec: ToolRunContext) {
      const target = await resolveOfficePath(exec, ctx, args.path, ['.xlsx'], true)
      const { bytes, sizeBytes } = await readOfficeBytes(exec, ctx, target.target)
      const zip = readZip(bytes)
      const workbook = parseWorkbook(zip)
      if (args.sheet !== undefined && !workbook.names.includes(args.sheet)) {
        throw new Error(`sheet "${args.sheet}" not found; available sheets: ${workbook.names.join(', ')}`)
      }
      const names = args.sheet === undefined ? workbook.names : [args.sheet]

      const maxRows = Math.min(Math.max(args.max_rows ?? 5000, 1), 10_000)
      const sheets: Array<{ name: string; rows: CellRow[]; truncated: boolean }> = []
      let totalCells = 0
      let budgetExhausted = false

      for (const name of names) {
        const model = workbook.sheets.get(name)
        if (model === undefined) continue
        const rawRows = worksheetRows(model.grid)
        const rows: CellRow[] = []
        let truncated = false
        for (const rawRow of rawRows) {
          if (budgetExhausted) break
          totalCells += rawRow.length
          if (totalCells > MAX_READ_CELLS) {
            truncated = true
            budgetExhausted = true
            break
          }
          rows.push(rawRow)
          if (rows.length >= maxRows) {
            truncated = rawRows.length > rows.length
            break
          }
        }
        if (rawRows.length > rows.length) truncated = true
        sheets.push({ name, rows, truncated })
      }

      return { path: target.display, sheets, sizeBytes }
    },
  }))
}

function registerExcelUpdate(ctx: Context & FsContext): () => void {
  return ctx.tools.register(defineTool({
    name: 'excel_update',
    description:
      'Update an existing .xlsx workbook in place: replace or create whole sheets by name (`sheets`) and/or write individual scalar values into cells (`cell_updates`, e.g. "B2"). '
      + 'The workbook is re-published as an ASCII-safe package, so binary-only extensions cannot survive; prefer excel_create for new workbooks. '
      + 'Provide at least one sheet or cell update.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the existing .xlsx file.',
      },
      sheets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Worksheet to replace; created when absent.' },
            rows: {
              type: 'array',
              required: true,
              items: ROW_SCHEMA,
              description: 'Replacement grid rows.',
            },
          },
        },
        description: 'Whole-sheet replacements (optional).',
      },
      cell_updates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sheet: { type: 'string', required: true, description: 'Worksheet name.' },
            cell: { type: 'string', required: true, description: 'Cell address in A1 notation, e.g. "B2".' },
            value: {
              ...CELL_VALUE_SCHEMA,
              required: true,
              description: 'Scalar value to write into the cell. A string starting with = is written as a formula.',
            },
          },
        },
        description: 'Individual cell writes (optional).',
      },
    },
    output: {
      schema: EXCEL_UPDATE_OUTPUT,
      render: (_args, value: any) => [{
        type: 'text',
        text: `Updated Excel workbook ${value.path} (${value.sizeBytes} bytes). Sheets now: ${value.sheetNames.join(', ')}. `
          + `Replaced/created sheets: ${value.updatedSheets.length === 0 ? '(none)' : value.updatedSheets.join(', ')}. `
          + `Cell writes: ${value.cellUpdates.length}.`,
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Update ${args.path}`,
      kind: 'edit',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec: ToolRunContext) {
      const target = await resolveOfficePath(exec, ctx, args.path, ['.xlsx'], true)
      if ((args.sheets?.length ?? 0) === 0 && (args.cell_updates?.length ?? 0) === 0) {
        throw new Error('excel_update needs at least one entry in sheets or cell_updates')
      }

      const sheetSpecs = args.sheets ?? []
      if (sheetSpecs.length > 0) validateSheetSpecs(sheetSpecs)

      const { bytes } = await readOfficeBytes(exec, ctx, target.target)
      const zip = readZip(bytes)
      // Touch every part once: the re-emit refuses binary parts up front
      // instead of failing halfway through a rewrite.
      void asciiPartsOf(zip)
      const workbook = parseWorkbook(zip)
      const names = [...workbook.names]
      const models = new Map(workbook.sheets)
      const updatedSheets: string[] = []

      for (const spec of sheetSpecs) {
        const grid = gridOf(spec.rows)
        const last = gridAddresses(grid).at(-1)
        if (!names.includes(spec.name)) names.push(spec.name)
        models.set(spec.name, {
          name: spec.name,
          part: models.get(spec.name)?.part ?? `worksheets/sheet${names.length}.xml`,
          content: sheetXml(grid),
          grid,
          maxRow: last?.row ?? -1,
          maxColumn: last?.column ?? -1,
        })
        updatedSheets.push(spec.name)
      }

      const cellUpdates: Array<{ sheet: string; cell: string }> = []
      for (const update of args.cell_updates ?? []) {
        const model = models.get(update.sheet)
        if (model === undefined) throw new Error(`sheet "${update.sheet}" not found for cell update; available sheets: ${names.join(', ')}`)
        const { row, column } = parseCellAddress(update.cell)
        if (row < 0 || column < 0 || row >= 1_048_576) {
          throw new Error(`invalid cell address "${update.cell}"; use A1 notation such as "B2"`)
        }
        model.grid.set(update.cell.toUpperCase(), gridCellOf(update.value))
        model.maxRow = Math.max(model.maxRow, row)
        model.maxColumn = Math.max(model.maxColumn, column)
        model.content = sheetXml(model.grid)
        cellUpdates.push({ sheet: update.sheet, cell: update.cell })
      }

      exec.signal.throwIfAborted()
      const orderedModels = names
        .map(name => models.get(name))
        .filter((model): model is SheetModel => model !== undefined)
        .map((model, index) => ({ ...model, part: `worksheets/sheet${index + 1}.xml` }))
      const text = buildXlsxText(orderedModels)
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text)
      return {
        path: target.display,
        sizeBytes,
        sheetNames: names,
        updatedSheets,
        cellUpdates,
      }
    },
  }))
}

export function registerExcelTools(ctx: Context & FsContext): () => void {
  const disposers = [registerExcelCreate(ctx), registerExcelRead(ctx), registerExcelUpdate(ctx)]
  return () => disposers.forEach(dispose => dispose())
}
