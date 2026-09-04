/**
 * Zip-bomb guard tests for `readZip` (v0.3.0 stream C, ported to the
 * self-contained reader in 1.0.0): declared-size budgets, the entry-count
 * budget, friendly pseudo-zip refusal, and tool-level regression through
 * word_read / excel_read / ppt_read.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import JSZip from 'jszip'
import { readZip } from '../src/asciizip.ts'
import { mountTools, run } from './harness.ts'

/** A real high-ratio archive: `declaredBytes` of repetitive text, deflated. */
async function bombZip(declaredBytes: number): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('word/document.xml', 'A'.repeat(declaredBytes))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

describe('readZip declared-size budgets', () => {
  test('accepts a high-ratio archive within the default budgets', async () => {
    const buffer = await bombZip(10 * 1024 * 1024)
    const zip = readZip(buffer)
    expect(zip.has('word/document.xml')).toBe(true)
    expect(zip.entryText('word/document.xml').length).toBe(10 * 1024 * 1024)
  })

  test('refuses one entry above the injected per-entry budget', async () => {
    const buffer = await bombZip(10 * 1024 * 1024)
    expect(() => readZip(buffer, { maxEntryBytes: 1024 * 1024 })).toThrow(
      /word\/document\.xml" declares 10485760 uncompressed bytes; office tools refuse entries above 1048576 bytes/,
    )
  })

  test('refuses when declared sizes sum above the total budget', async () => {
    const zip = new JSZip()
    zip.file('a.txt', 'A'.repeat(4 * 1024 * 1024))
    zip.file('b.txt', 'B'.repeat(4 * 1024 * 1024))
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    expect(() => readZip(buffer, { maxTotalBytes: 5 * 1024 * 1024 })).toThrow(
      /more than 5242880 uncompressed bytes in total/,
    )
  })

  test('refuses archives with too many entries', async () => {
    const zip = new JSZip()
    for (let index = 0; index < 5; index += 1) zip.file(`part${index}.xml`, 'x')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    expect(() => readZip(buffer, { maxEntries: 4 })).toThrow(
      /holds 5 entries; office tools refuse archives with more than 4/,
    )
  })

  test('pseudo-zip bytes get a friendly refusal', () => {
    const buffer = Buffer.from('this is obviously not a zip archive'.repeat(8))
    expect(() => readZip(buffer)).toThrow('not a readable zip archive')
  })

  test('writer output round-trips through the reader with valid CRCs', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    const read = readZip(buffer)
    expect(read.entryNames()).toEqual(['[Content_Types].xml'])
    // The writer may pad parts with trailing newlines (legal after the XML root).
    expect(read.entryText('[Content_Types].xml').replace(/\n+$/, '')).toBe('<?xml version="1.0"?><Types/>')
  })
})

describe('tools route hostile archives through the guard', () => {
  test('word_read, excel_read, and ppt_read refuse pseudo-zip files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-zipguard-'))
    try {
      const garbage = Buffer.from('definitely not an OOXML zip'.repeat(32))
      await writeFile(join(root, 'bad.docx'), garbage)
      await writeFile(join(root, 'bad.xlsx'), garbage)
      await writeFile(join(root, 'bad.pptx'), garbage)

      const tools = mountTools()
      await expect(run(tools, 'word_read', { path: 'bad.docx' }, root)).rejects.toThrow('not a readable zip archive')
      await expect(run(tools, 'excel_read', { path: 'bad.xlsx' }, root)).rejects.toThrow('not a readable zip archive')
      await expect(run(tools, 'ppt_read', { path: 'bad.pptx' }, root)).rejects.toThrow('not a readable zip archive')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('ppt_read refuses a deck whose slide XML carries a DOCTYPE', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
    zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY x "y">]><p:sld/>')
    const buffer = await zip.generateAsync({ type: 'nodebuffer' })
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-dtd-'))
    try {
      await writeFile(join(root, 'evil.pptx'), buffer)
      const tools = mountTools()
      await expect(run(tools, 'ppt_read', { path: 'evil.pptx' }, root)).rejects.toThrow('DOCTYPE/ENTITY declaration')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
