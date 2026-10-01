import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, test } from 'vitest'
import { buildAsciiZip, readZip, type ZipPart } from '../src/asciizip.ts'
import { mountTools, run } from './harness.ts'

async function verifyPackage(text: string): Promise<JSZip> {
  const bytes = Buffer.from(text, 'utf8')
  expect(bytes.length).toBe(text.length)
  expect(bytes.every(byte => byte <= 0x7f)).toBe(true)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let cursor = 0
  let count = 0
  while (view.getUint32(cursor, true) === 0x04034b50) {
    const extraLength = view.getUint16(cursor + 28, true)
    const nameLength = view.getUint16(cursor + 26, true)
    const extraStart = cursor + 30 + nameLength
    if (extraLength > 0) {
      expect(view.getUint16(extraStart + 2, true) + 4).toBe(extraLength)
    }
    cursor += 30 + nameLength + extraLength + view.getUint32(cursor + 18, true)
    count += 1
  }
  expect(view.getUint32(cursor, true)).toBe(0x02014b50)
  const eocd = bytes.length - 22
  expect(view.getUint32(eocd, true)).toBe(0x06054b50)
  expect(view.getUint16(eocd + 10, true)).toBe(count)
  expect(view.getUint32(eocd + 16, true)).toBe(cursor)
  // Independent decoder checks every CRC, not just our own read-back path.
  return JSZip.loadAsync(bytes, { checkCRC32: true })
}

describe('ASCII package writer regression (#7)', () => {
  test('payload size and CRC are independent across unsafe byte bands', async () => {
    for (const length of [120, 127, 128, 255, 32639, 32768, 65535, 70000, 200000]) {
      const content = `<x>${'a'.repeat(length)}</x>`
      const zip = await verifyPackage(buildAsciiZip([{ name: 'test.xml', content }]))
      expect((await zip.file('test.xml')!.async('string')).trimEnd()).toBe(content)
    }
  })

  test('counts above 127 remain actual, safe EOCD counts; padding names cannot collide', async () => {
    const parts: ZipPart[] = Array.from({ length: 129 }, (_, index) => ({ name: `parts/${index}.xml`, content: `<x>${index}</x>` }))
    parts.push({ name: 'dshPadding/pad1.xml', content: '<original/>' })
    const text = buildAsciiZip(parts)
    const zip = await verifyPackage(text)
    expect(readZip(Buffer.from(text)).entryCount()).toBe(256)
    expect((await zip.file('dshPadding/pad1.xml')!.async('string')).trimEnd()).toBe('<original/>')
    expect((await zip.file('parts/128.xml')!.async('string')).trimEnd()).toBe('<x>128</x>')
  })

  test('padding parts get explicit content types when a package has no XML default', async () => {
    const parts: ZipPart[] = [{ name: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>' }]
    parts.push(...Array.from({ length: 127 }, (_, index) => ({ name: `parts/${index}.xml`, content: '<x/>' })))
    const zip = await verifyPackage(buildAsciiZip(parts))
    const types = await zip.file('[Content_Types].xml')!.async('string')
    expect(types).toContain('PartName="/dshPadding/pad1.xml" ContentType="application/xml"')
  })

  test('duplicate names and oversized output fail explicitly', () => {
    expect(() => buildAsciiZip([{ name: 'x.xml', content: '<x/>' }, { name: 'x.xml', content: '<x/>' }])).toThrow('duplicate')
    expect(() => buildAsciiZip([{ name: 'x.xml', content: ' '.repeat(50 * 1024 * 1024) }])).toThrow('write budget')
  })

  test('the 200-slide budget includes the optional title slide', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-limit-'))
    try {
      await expect(run(mountTools(), 'ppt_create', {
        path: 'too-long.pptx', title: 'Cover',
        slides: Array.from({ length: 200 }, () => ({ title: 'Slide' })),
      }, root)).rejects.toThrow('including the title slide')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each([5, 7, 10, 25, 29, 57, 200])('%i slides with notes round-trip through the tool boundary', async count => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-long-'))
    try {
      const tools = mountTools()
      const slides = Array.from({ length: count }, (_, index) => ({ title: `第 ${index + 1} 页`, paragraphs: ['中文内容 & <测试>'], notes: `第 ${index + 1} 页备注` }))
      await run(tools, 'ppt_create', { path: 'long.pptx', slides }, root)
      await verifyPackage((await readFile(join(root, 'long.pptx'))).toString('utf8'))
      const result = await run(tools, 'ppt_read', { path: 'long.pptx' }, root) as { slides: { paragraphs: string[]; notes: string[] }[] }
      expect(result.slides).toHaveLength(count)
      expect(result.slides[count - 1]!.paragraphs).toContain(`第 ${count} 页`)
      expect(result.slides[count - 1]!.notes).toContain(`第 ${count} 页备注`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
