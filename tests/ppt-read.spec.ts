/**
 * ppt_read extraction tests (0.5.0): tables come back as structured rows
 * (and no longer leak into `paragraphs`), and picture alt texts (descr) are
 * surfaced per slide when present.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import JSZip from 'jszip'
import { mountTools, run } from './harness.ts'

/** One slide with body text around a 2x2 table, plus a picture without alt text. */
const SLIDE_WITH_TABLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>before table</a:t></a:r></a:p></p:txBody></p:sp>
    <p:graphicFrame>
      <p:xfrm><a:off x="1828800" y="3657600"/><a:ext cx="7315200" cy="1828800"/></p:xfrm>
      <a:tbl>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>r1c1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>r1</a:t></a:r></a:p><a:p><a:r><a:t>c2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>r2c1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t/></a:r></a:p></a:txBody></a:tc></a:tr>
      </a:tbl>
    </p:graphicFrame>
    <p:sp><p:txBody><a:p><a:r><a:t>after table</a:t></a:r></a:p></p:txBody></p:sp>
    <p:pic><p:nvPicPr><p:cNvPr id="7" name="Picture 6"></p:cNvPr></p:nvPicPr></p:pic>
  </p:spTree></p:cSld>
</p:sld>`

/** One slide with two pictures carrying alt text (one entity-encoded). */
const SLIDE_WITH_ALTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:pic><p:nvPicPr><p:cNvPr id="4" name="Image 0" descr="revenue chart"></p:cNvPr></p:nvPicPr></p:pic>
    <p:pic><p:nvPicPr><p:cNvPr id="5" name="Image 1" descr="A &amp; B &#x2014; diagram"></p:cNvPr></p:nvPicPr></p:pic>
  </p:spTree></p:cSld>
</p:sld>`

async function buildPptx(slides: string[]): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  slides.forEach((xml, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, xml)
  })
  return zip.generateAsync({ type: 'nodebuffer' })
}

/**
 * The DSH harness rejects a tool result containing any `undefined` value
 * ("value is not lossless JSON") before schema validation runs; this in-process
 * harness returns the raw object, so mirror that guard here.
 */
function isLosslessJson(value: unknown): boolean {
  if (value === undefined) return false
  if (Array.isArray(value)) return value.every(isLosslessJson)
  if (value !== null && typeof value === 'object') return Object.values(value).every(isLosslessJson)
  return true
}

/** Issue #9 cause 1: `descr` present (non-empty), empty, and absent. */
const SLIDE_DESCR_BOUNDARY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:pic><p:nvPicPr><p:cNvPr id="2" name="Picture 1" descr="red parts crate"/></p:nvPicPr></p:nvPicPr></p:pic>
    <p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 2" descr=""/></p:nvPicPr></p:nvPicPr></p:pic>
    <p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 3"/></p:nvPicPr></p:nvPicPr></p:pic>
  </p:spTree></p:cSld>
</p:sld>`

/** Issue #9 cause 2: an OLE frame and a table frame at identical geometry. */
const SLIDE_TABLE_PLUS_OLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:graphicFrame>
      <p:xfrm><a:off x="1828800" y="3657600"/><a:ext cx="7315200" cy="1828800"/></p:xfrm>
      <a:tbl>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>part</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>qty</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>chain</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      </a:tbl>
    </p:graphicFrame>
    <p:graphicFrame>
      <p:xfrm><a:off x="1828800" y="3657600"/><a:ext cx="7315200" cy="1828800"/></p:xfrm>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj name="Worksheet"/></a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`

describe('ppt_read tables (0.5.0)', () => {
  test('tables come back structured and stay out of paragraphs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-ppttbl-'))
    try {
      await writeFile(join(root, 'deck.pptx'), await buildPptx([SLIDE_WITH_TABLE]))
      const tools = mountTools()
      const read = await run(tools, 'ppt_read', { path: 'deck.pptx' }, root) as any

      const slide = read.slides[0]
      expect(slide.paragraphs).toEqual(['before table', 'after table'])
      expect(slide.tables).toEqual([[['r1c1', 'r1 c2'], ['r2c1', '']]])
      expect(slide.imageAlts).toBeUndefined()
      expect(read.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('tables are dropped with truncated=true when they exceed the deck budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-ppttbl-budget-'))
    try {
      await writeFile(join(root, 'deck.pptx'), await buildPptx([SLIDE_WITH_TABLE]))
      const tools = mountTools()
      const read = await run(tools, 'ppt_read', { path: 'deck.pptx', max_chars: 20 }, root) as any

      // 20 chars fit "before table" + part of a paragraph; the table cannot
      // fit whole, so it is dropped and the deck is marked truncated.
      expect(read.slides[0].tables).toBeUndefined()
      expect(read.truncated).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ppt_read image alt texts (0.5.0)', () => {
  test('picture descr attributes surface as imageAlts, decoded and in order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-pptalt-'))
    try {
      await writeFile(join(root, 'deck.pptx'), await buildPptx([SLIDE_WITH_ALTS]))
      const tools = mountTools()
      const read = await run(tools, 'ppt_read', { path: 'deck.pptx' }, root) as any

      expect(read.slides[0].imageAlts).toEqual(['revenue chart', 'A & B — diagram'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('element geometry is reported per slide with the canvas size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-pptgeom-'))
    try {
      const withBox = SLIDE_WITH_TABLE.replace(
        '<p:sp><p:txBody><a:p><a:r><a:t>before table</a:t></a:r></a:p></p:txBody></p:sp>',
        '<p:sp><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="4572000" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:p><a:r><a:t>before table</a:t></a:r></a:p></p:txBody></p:sp>',
      )
      await writeFile(join(root, 'deck.pptx'), await buildPptx([withBox]))
      const tools = mountTools()
      const read = await run(tools, 'ppt_read', { path: 'deck.pptx' }, root) as any

      expect(read.slideWidthInches).toBeGreaterThan(13)
      expect(read.slideHeightInches).toBe(7.5)
      const box = read.slides[0].elements.find((element: any) => element.type === 'text' && element.text === 'before table')
      expect(box).toMatchObject({ xIn: 1, yIn: 2, wIn: 5, hIn: 1 })
      const table = read.slides[0].elements.find((element: any) => element.type === 'table')
      expect(table).toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('ppt_read survives decks written by other tools (issue #9)', () => {
  test('descr present, empty, and absent: only the absent attribute omits alt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-pptissue9-descr-'))
    try {
      await writeFile(join(root, 'deck.pptx'), await buildPptx([SLIDE_DESCR_BOUNDARY]))
      const tools = mountTools()
      const read = await run(tools, 'ppt_read', { path: 'deck.pptx' }, root) as any

      expect(isLosslessJson(read)).toBe(true)
      const elements = read.slides[0].elements
      expect(elements.map((element: any) => element.type)).toEqual(['image', 'image', 'image'])
      expect(elements[0].alt).toBe('red parts crate')
      expect(elements[1].alt).toBe('')
      expect('alt' in elements[2]).toBe(false)
      expect(read.slides[0].imageAlts).toEqual(['red parts crate'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a non-table graphicFrame reports as graphicFrame without text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-pptissue9-frame-'))
    try {
      await writeFile(join(root, 'deck.pptx'), await buildPptx([SLIDE_TABLE_PLUS_OLE]))
      const tools = mountTools()
      const read = await run(tools, 'ppt_read', { path: 'deck.pptx' }, root) as any

      expect(isLosslessJson(read)).toBe(true)
      const elements = read.slides[0].elements
      expect(elements.map((element: any) => element.type)).toEqual(['table', 'graphicFrame'])
      expect(elements[0]).toMatchObject({ text: '2x2', xIn: 2, yIn: 4, wIn: 8, hIn: 2 })
      expect(elements[1]).toMatchObject({ xIn: 2, yIn: 4, wIn: 8, hIn: 2 })
      expect('text' in elements[1]).toBe(false)

      const blocks = tools.get('ppt_read')!.output!.render({} as never, read as never) as Array<{ text: string }>
      expect(blocks.map(block => block.text).join('')).toContain('FRAME')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
