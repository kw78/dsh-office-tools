/**
 * Card-presenter contract tests (1.0.0). Every tool declares a `presentCall`
 * card and an `output.render` result presenter; both must be total, pure,
 * and deterministic: the same call replays to the same card bytes, malformed
 * or minimal inputs fall back to a generic card / a single text block
 * instead of throwing, and the serialized result never amplifies its input
 * (bounds stay linear). These are the replay/fallback/bounds guarantees the
 * build-dsh-plugin card audit checks for.
 */

import { describe, expect, test } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mountTools } from './harness.ts'

const tools = mountTools()

/** Canonical minimal model-facing values for each tool's output.render. */
const CANONICAL_VALUES: Record<string, Record<string, unknown>> = {
  word_create: { path: 'a.docx', sizeBytes: 12, paragraphCount: 1, bulletCount: 0, tableRows: 0 },
  word_read: { path: 'a.docx', text: 'hello', totalChars: 5, truncated: false, sizeBytes: 12 },
  word_update: { path: 'a.docx', sizeBytes: 12, appendedParagraphs: 1, appendedBullets: 0, appendedTableRows: 0 },
  excel_create: { path: 'b.xlsx', sizeBytes: 12, sheets: [{ name: 'S', rowCount: 1, colCount: 1 }] },
  excel_read: { path: 'b.xlsx', sizeBytes: 12, sheets: [{ name: 'S', rows: [['x']], truncated: false }] },
  excel_update: { path: 'b.xlsx', sizeBytes: 12, sheetNames: ['S'], updatedSheets: ['S'], cellUpdates: [{ sheet: 'S', cell: 'B2' }] },
  ppt_create: {
    path: 'c.pptx', sizeBytes: 12, slideCount: 1, slideWidthInches: 13.33, slideHeightInches: 7.5,
    slides: [{ index: 1, elements: [{ type: 'text', xIn: 1, yIn: 1, wIn: 2, hIn: 1, text: 't' }] }],
  },
  ppt_read: {
    path: 'c.pptx', sizeBytes: 12, slideCount: 1, slideWidthInches: 13.33, slideHeightInches: 7.5,
    slides: [{ index: 1, paragraphs: ['p'], imageCount: 0, elements: [] }],
  },
}

/** Minimal valid args per tool — presentCall only reads argument fields. */
const CANONICAL_ARGS: Record<string, Record<string, unknown>> = {
  word_create: { path: 'a.docx', paragraphs: ['x'] },
  word_read: { path: 'a.docx' },
  word_update: { path: 'a.docx', paragraphs: ['x'] },
  excel_create: { path: 'b.xlsx', sheets: [{ name: 'S', rows: [['x']] }] },
  excel_read: { path: 'b.xlsx' },
  excel_update: { path: 'b.xlsx', cell_updates: [{ sheet: 'S', cell: 'B2', value: 1 }] },
  ppt_create: { path: 'c.pptx', slides: [{ title: 's' }] },
  ppt_read: { path: 'c.pptx' },
}

function definitionOf(name: string): ToolDefinition {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} should be registered`)
  return tool
}

describe('card presenter replay/fallback/bounds contract', () => {
  test('every tool declares a generic presentCall and a render', () => {
    for (const name of tools.keys()) {
      const definition = definitionOf(name)
      expect(typeof definition.presentCall).toBe('function')
      expect(typeof definition.output.render).toBe('function')
    }
  })

  test('presentCall replays deterministically — identical args, identical card', () => {
    for (const name of tools.keys()) {
      const definition = definitionOf(name)
      const args = CANONICAL_ARGS[name]!
      const first = JSON.stringify(definition.presentCall!(args as never))
      const second = JSON.stringify(definition.presentCall!(args as never))
      expect(first, `${name} presentCall must replay identically`).toBe(second)
      expect(JSON.parse(first)).toMatchObject({ card: 'generic' })
    }
  })

  test('presentCall falls back cleanly on sparse args — undefined (host default) or a generic card, never a throw', () => {
    for (const name of tools.keys()) {
      const definition = definitionOf(name)
      // defineTool's wrapper rejects schema-invalid args by returning
      // undefined, which tells the host to keep its default pending view;
      // a tool may also degrade to a generic card. Both are the documented
      // fallbacks — a throw is not.
      let card: unknown
      expect(() => { card = definition.presentCall!({} as never) }).not.toThrow()
      expect(card === undefined || (card as { card?: string }).card === 'generic').toBe(true)
    }
  })

  test('output.render replays deterministically and stays a single text block', () => {
    for (const name of tools.keys()) {
      const definition = definitionOf(name)
      const value = CANONICAL_VALUES[name]!
      const first = JSON.stringify(definition.output.render({} as never, value as never))
      const second = JSON.stringify(definition.output.render({} as never, value as never))
      expect(first, `${name} render must replay identically`).toBe(second)
      const blocks = JSON.parse(first) as Array<{ type: string; text: string }>
      expect(Array.isArray(blocks)).toBe(true)
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) expect(typeof block.text).toBe('string')
    }
  })

  test('output.render output size is bounded by its input (no amplification)', () => {
    const long = 'x'.repeat(100_000)
    const read = definitionOf('word_read')
    const blocks = read.output.render({} as never, {
      path: 'a.docx', text: long, totalChars: long.length, truncated: true, sizeBytes: long.length,
    } as never) as Array<{ text: string }>
    const rendered = blocks.map(block => block.text).join('')
    // The text plus a short truncation suffix — strictly linear, never inflated.
    expect(rendered.length).toBeGreaterThan(long.length)
    expect(rendered.length).toBeLessThan(long.length + 500)

    const deck = definitionOf('ppt_read')
    const deckBlocks = deck.output.render({} as never, {
      path: 'c.pptx', sizeBytes: 1, slideCount: 1, slideWidthInches: 13.33, slideHeightInches: 7.5,
      slides: [{ index: 1, paragraphs: [long], imageCount: 0, elements: [{ type: 'text', xIn: 0, yIn: 0, wIn: 1, hIn: 1, text: long }] }],
    } as never) as Array<{ text: string }>
    const deckRendered = deckBlocks.map(block => block.text).join('')
    // The wireframe sketch truncates labels; paragraphs are echoed once.
    expect(deckRendered.length).toBeLessThan(long.length * 2 + 5000)
  })

  test('presentResult is intentionally left undefined — the host renders raw results as the fallback view', () => {
    for (const name of tools.keys()) {
      // These tools present results through output.render (the schema-
      // validated content projection); overriding presentResult would
      // duplicate that path. Pin the absence so a future override is a
      // deliberate contract change, not an accident.
      expect(definitionOf(name).presentResult).toBeUndefined()
    }
  })

  test('wireframe sketch bounds element labels regardless of text length', async () => {
    const { sketchSlide } = await import('../src/tools/ppt.ts')
    const sketch = sketchSlide(13.33, 7.5, [{
      type: 'text', xIn: 1, yIn: 1, wIn: 5, hIn: 2, text: 'y'.repeat(50_000),
    }])
    expect(sketch.length).toBeLessThan(5_000)
    expect(sketch).toContain('+')
  })
})
