/**
 * word_update tests (v0.4.0): appended content must land at the end of the
 * body (before the trailing sectPr), keep everything already in the file,
 * survive round-trips through word_read, and refuse no-op/hostile inputs.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import JSZip from 'jszip'
import { mountTools, run } from './harness.ts'

/** A minimal docx with a body, one paragraph, and a trailing sectPr. */
async function buildMinimalDocx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships/>')
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>original</w:t></w:r></w:p>'
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
    + '</w:body></w:document>',
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

describe('word_update', () => {
  test('appends paragraphs, bullets, and a table to a word_create document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-wu-'))
    try {
      const tools = mountTools()
      await run(tools, 'word_create', {
        path: 'doc.docx',
        title: 'Base',
        paragraphs: ['first'],
      }, root)

      const updated = await run(tools, 'word_update', {
        path: 'doc.docx',
        paragraphs: ['second', ''],
        bullets: ['bullet one'],
        table: { headers: ['H'], rows: [['v1'], ['v2']] },
      }, root) as any
      expect(updated.appendedParagraphs).toBe(2)
      expect(updated.appendedBullets).toBe(1)
      expect(updated.appendedTableRows).toBe(2)
      expect(updated.sizeBytes).toBeGreaterThan(0)

      const read = await run(tools, 'word_read', { path: 'doc.docx' }, root) as any
      expect(read.text).toBe('Base\n\nfirst\n\nsecond\n\n\n\nbullet one\n\nH\n\nv1\n\nv2\n\n')
      expect(read.truncated).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('inserts before the trailing sectPr and preserves the rest of the package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-wu-sect-'))
    try {
      await writeFile(join(root, 'min.docx'), await buildMinimalDocx())
      const tools = mountTools()
      await run(tools, 'word_update', { path: 'min.docx', paragraphs: ['appended'] }, root)

      const zip = await JSZip.loadAsync(await readFile(join(root, 'min.docx')))
      const documentXml = await zip.file('word/document.xml')!.async('string')
      const appendedAt = documentXml.indexOf('<w:t xml:space="preserve">appended</w:t>')
      const sectAt = documentXml.indexOf('<w:sectPr')
      const originalAt = documentXml.indexOf('<w:t>original</w:t>')
      expect(appendedAt).toBeGreaterThan(-1)
      expect(originalAt).toBeGreaterThan(-1)
      expect(appendedAt).toBeGreaterThan(originalAt)
      expect(appendedAt).toBeLessThan(sectAt)
      // The rest of the archive survives the rewrite.
      expect(zip.file('[Content_Types].xml')).not.toBeNull()
      expect(zip.file('_rels/.rels')).not.toBeNull()

      const read = await run(tools, 'word_read', { path: 'min.docx' }, root) as any
      expect(read.text).toBe('original\n\nappended\n\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('escapes XML-significant characters in appended text (via the docx package)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-wu-esc-'))
    try {
      const tools = mountTools()
      await run(tools, 'word_create', { path: 'doc.docx', paragraphs: ['base'] }, root)
      await run(tools, 'word_update', { path: 'doc.docx', paragraphs: ['a & b < c > d "e" \'f\''] }, root)

      const read = await run(tools, 'word_read', { path: 'doc.docx' }, root) as any
      expect(read.text).toContain('a & b < c > d "e" \'f\'')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('refuses no-op calls, hostile archives, and over-cap appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-wu-err-'))
    try {
      const tools = mountTools()
      await run(tools, 'word_create', { path: 'doc.docx', paragraphs: ['base'] }, root)
      await expect(run(tools, 'word_update', { path: 'doc.docx' }, root)).rejects.toThrow('at least one of paragraphs, bullets, or table')
      await expect(run(tools, 'word_update', { path: 'missing.docx', paragraphs: ['x'] }, root)).rejects.toThrow()

      await writeFile(join(root, 'bad.docx'), Buffer.from('not a zip at all'.repeat(16)))
      await expect(run(tools, 'word_update', { path: 'bad.docx', paragraphs: ['x'] }, root)).rejects.toThrow('not a readable zip archive')

      const many = Array.from({ length: 10_001 }, (_, index) => `p${index}`)
      await expect(run(tools, 'word_update', { path: 'doc.docx', paragraphs: many }, root)).rejects.toThrow('maximum 10000')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('appends work on a document without any sectPr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-wu-nosect-'))
    try {
      const zip = new JSZip()
      zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
      zip.file(
        'word/document.xml',
        '<?xml version="1.0"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        + '<w:p><w:r><w:t>only</w:t></w:r></w:p>'
        + '</w:body></w:document>',
      )
      await writeFile(join(root, 'nosect.docx'), await zip.generateAsync({ type: 'nodebuffer' }))

      const tools = mountTools()
      await run(tools, 'word_update', { path: 'nosect.docx', paragraphs: ['after'] }, root)
      const read = await run(tools, 'word_read', { path: 'nosect.docx' }, root) as any
      expect(read.text).toBe('only\n\nafter\n\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  test('refuses rewrites of packages carrying binary parts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-wu-binary-'))
    try {
      const zip = new JSZip()
      zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
      zip.file(
        'word/document.xml',
        '<?xml version="1.0"?>'
          + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
          + '<w:p><w:r><w:t>binary media below</w:t></w:r></w:p>'
          + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
          + '</w:body></w:document>',
      )
      // A part with non-ASCII bytes stands in for embedded media: it cannot
      // round-trip the official UTF-8 text channel.
      zip.file('word/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x9a, 0xc4, 0xff, 0xfe, 0x01]))
      await writeFile(join(root, 'media.docx'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

      const tools = mountTools()
      await expect(run(tools, 'word_update', { path: 'media.docx', paragraphs: ['x'] }, root)).rejects.toThrow('non-ASCII')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

