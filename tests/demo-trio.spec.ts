/**
 * The README "one prompt, quarterly-report trio" demo, pinned as an in-repo
 * integration test (0.6.0): word_create + excel_create + ppt_create build
 * report.docx / budget.xlsx / deck.pptx in one mounted session, then every
 * file is read back through the matching read tool. The scenario previously
 * lived only in an untracked local spec against machine-specific demo files;
 * this version has no absolute paths and runs in CI.
 */

import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { mountTools, run } from './harness.ts'

describe('quarterly-report trio (README demo)', () => {
  test('one session: create report.docx + budget.xlsx + deck.pptx, read all three back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-office-trio-'))
    try {
      const tools = mountTools()

      await run(tools, 'word_create', {
        path: 'report.docx',
        title: 'Q3 2026 Quarterly Report',
        paragraphs: [
          'Revenue grew 12% quarter over quarter, led by the enterprise segment.',
          'Operating margin held steady despite the mid-quarter pricing change.',
        ],
        bullets: [
          'Enterprise ARR up 18%',
          'Churn down to 2.1%',
          'Two new regional partners signed',
        ],
        table: {
          headers: ['Metric', 'Q2 2026', 'Q3 2026'],
          rows: [
            ['Revenue', '4.10M', '4.59M'],
            ['Gross margin', '61%', '62%'],
            ['Net churn', '2.6%', '2.1%'],
          ],
        },
      }, root)

      await run(tools, 'excel_create', {
        path: 'budget.xlsx',
        sheets: [
          {
            name: 'Budget',
            rows: [
              ['Category', 'Plan', 'Actual', 'Variance'],
              ['Engineering', 120000, 118500, '=C2-B2'],
              ['Marketing', 45000, 51200, '=C3-B3'],
              ['Operations', 35000, 33800, '=C4-B4'],
              ['Total', '=SUM(B2:B4)', '=SUM(C2:C4)', '=C5-B5'],
            ],
          },
          {
            name: 'Summary',
            rows: [['Headline', 'Value'], ['Marketing overrun', '=C3-B3']],
          },
        ],
      }, root)

      await run(tools, 'ppt_create', {
        path: 'deck.pptx',
        title: 'Q3 2026 Quarterly Review',
        slides: [
          {
            title: 'Results',
            bullets: ['Revenue 4.59M (+12% QoQ)', 'Gross margin 62%', 'Churn 2.1%'],
            notes: 'Lead with the enterprise wins, then margin stability.',
          },
          {
            title: 'Spend vs plan',
            bullets: ['Engineering under plan', 'Marketing over plan by 6.2K', 'Operations flat'],
            notes: 'Variance detail lives in budget.xlsx.',
          },
          {
            title: 'Next quarter',
            bullets: ['Close two partner deals', 'Rebalance marketing spend', 'Ship pricing v2'],
            notes: 'Commit to dates after the ops review.',
          },
        ],
      }, root)

      // All three artifacts are real zip/OOXML files.
      for (const file of ['report.docx', 'budget.xlsx', 'deck.pptx']) {
        const head = (await readFile(join(root, file))).subarray(0, 2).toString('latin1')
        expect(head).toBe('PK')
      }

      const word = await run(tools, 'word_read', { path: 'report.docx', format: 'markdown' }, root) as {
        text: string
      }
      expect(word.text).toContain('# Q3 2026 Quarterly Report')
      expect(word.text).toContain('| Metric | Q2 2026 | Q3 2026 |')

      const excel = await run(tools, 'excel_read', { path: 'budget.xlsx', sheet: 'Budget' }, root) as {
        sheets: { name: string; rows: string[][] }[]
      }
      const budget = excel.sheets.find(sheet => sheet.name === 'Budget')
      expect(budget).toBeDefined()
      // Freshly written formulas have no cached value: read-back returns them
      // as '=…' strings (the 0.5.0 convention).
      expect(budget!.rows[4]).toEqual(['Total', '=SUM(B2:B4)', '=SUM(C2:C4)', '=C5-B5'])
      expect(budget!.rows[1]).toEqual(['Engineering', '120000', '118500', '=C2-B2'])

      const ppt = await run(tools, 'ppt_read', { path: 'deck.pptx' }, root) as {
        slides: { paragraphs: string[]; notes?: string[] }[]
      }
      expect(ppt.slides).toHaveLength(4) // title slide + 3 content slides
      // ppt_read reports slide text as paragraphs (title slide included).
      expect(ppt.slides[0]!.paragraphs[0]).toBe('Q3 2026 Quarterly Review')
      expect(ppt.slides[1]!.notes?.[0]).toBe('Lead with the enterprise wins, then margin stability.')
      expect(ppt.slides[2]!.paragraphs).toContain('Marketing over plan by 6.2K')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
