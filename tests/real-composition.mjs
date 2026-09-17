/**
 * Real-composition E2E for the sandboxed write path.
 *
 * Unlike the vitest suite (whose fs is a test double), this script boots a
 * genuine Cordis context from the repo's devDependencies — the REAL
 * deployment packages:
 *
 *   SessionProjectionRegistry (@deepseek-ai/dsh-session-projection)
 *   SandboxPolicyService      (@deepseek-ai/dsh-sandbox-policy, workspace-write,
 *                             deployment workspaceRoot deliberately ELSEWHERE)
 *   SandboxedFileSystem       (@deepseek-ai/dsh-fs-sandbox) as ctx.fs
 *   ToolRuntime               (@deepseek-ai/dsh-tools)
 *   this repo's built lib/index.js
 *
 * The deployment default's writable root does NOT contain the session
 * workspace, which is the exact posture of the 1.0.0 field report (#2): a
 * write fenced by the deployment default must fail, so this run proves the
 * plugin passes the per-call session policy through to writeText.
 *
 * Run after `pnpm run build` (the script imports the built artifact):
 *   pnpm run test:e2e
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'

// Both roots must sit OUTSIDE /tmp and os.tmpdir(): workspace-write's writable
// set includes the platform temp area, so a session workspace under /tmp would
// be writable even under the deployment-default policy and this run could not
// distinguish per-call fencing from the temp-area escape hatch.
const scratch = '/var/tmp'
const deployRoot = await mkdtemp(join(scratch, 'dsh-rc-deploy-'))
const sessionRoot = await mkdtemp(join(scratch, 'dsh-rc-session-'))

let failures = 0
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failures++
}

try {
  const ctx = new Context()
  ctx.provide('systemPrompt', {
    tools() {},
    section() {},
    context() {},
    getContextOrder() { return 0 },
  })
  ctx.plugin(SessionProjectionRegistry)
  ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: deployRoot })
  ctx.plugin(SandboxedFileSystem, { cwd: deployRoot })
  new ToolRuntime(ctx)

  const definitions = new Map()
  const collectingCtx = new Proxy(ctx, {
    get(target, prop) {
      if (prop === 'tools') {
        return {
          register(definition) {
            definitions.set(definition.name, definition)
            return () => definitions.delete(definition.name)
          },
        }
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  apply(collectingCtx)

  // The service chain (sessionProjections → sandboxPolicy → fs) starts over
  // several cordis fiber ticks; wait for it before driving tools.
  const deadline = Date.now() + 10_000
  for (;;) {
    const ready = definitions.size === 8
      && ctx.get('fs') !== undefined && ctx.fs.sandboxMode === 'workspace-write'
      && ctx.get('sandboxPolicy') !== undefined
    if (ready || Date.now() > deadline) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (definitions.size !== 8) throw new Error(`only ${definitions.size} tools registered (services: fs=${ctx.get('fs') !== undefined}, policy=${ctx.get('sandboxPolicy') !== undefined})`)

  const exec = {
    signal: new AbortController().signal,
    agent: {
      // Minimal Session shape for the projection fold: an empty event log
      // means no sandbox/mode override, so resolve() falls to the deployment
      // default mode with the session cwd as the workspace root.
      session: {
        id: 'e2e-session',
        header: { cwd: sessionRoot },
        inheritedEventCount: 0,
        seq: 0,
        snapshotEvents: () => [],
        eventAt: (seq) => ({ seq, type: 'e2e/noop', data: {} }),
      },
    },
    callId: 'e2e-call',
    name: 'e2e',
    arguments: {},
  }

  const run = async (name, args) => {
    const tool = definitions.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    return tool.execute(args, exec)
  }

  const doc = await run('word_create', { path: 'report.docx', title: 'Report', paragraphs: ['hello'] })
  check(doc.sizeBytes > 0, `word_create (${doc.sizeBytes} bytes)`)
  const upd = await run('word_update', { path: 'report.docx', paragraphs: ['more'] })
  check(upd.sizeBytes > 0, `word_update (${upd.sizeBytes} bytes)`)
  const book = await run('excel_create', { path: 'budget.xlsx', sheets: [{ name: 'S1', rows: [['a', 1]] }] })
  check(book.sizeBytes > 0, `excel_create (${book.sizeBytes} bytes)`)
  const cells = await run('excel_update', { path: 'budget.xlsx', cell_updates: [{ sheet: 'S1', cell: 'B2', value: 42 }] })
  check(cells.sizeBytes > 0, `excel_update (${cells.sizeBytes} bytes)`)
  const deck = await run('ppt_create', { path: 'deck.pptx', title: 'Deck' })
  check(deck.sizeBytes > 0, `ppt_create (${deck.sizeBytes} bytes)`)

  for (const name of ['report.docx', 'budget.xlsx', 'deck.pptx']) {
    check((await stat(join(sessionRoot, name))).isFile(), `${name} landed in the session workspace`)
    const head = await readFile(join(sessionRoot, name), 'utf-8')
    check(head.startsWith('PK'), `${name} starts with the PK zip signature`)
  }

  const word = await run('word_read', { path: 'report.docx' })
  check(word.text.includes('hello') && word.text.includes('more'), 'word_read round-trips appended content')
  const excel = await run('excel_read', { path: 'budget.xlsx' })
  check(JSON.stringify(excel.sheets).includes('S1'), 'excel_read round-trips the sheet')
  const ppt = await run('ppt_read', { path: 'deck.pptx' })
  check((ppt.slideCount ?? ppt.slides?.length ?? 0) >= 1, 'ppt_read round-trips the deck')

  // The fence itself is still live: an absolute path outside every writable
  // root (session workspace, deployment default, and the temp areas) is refused.
  const outside = await mkdtemp(join(scratch, 'dsh-rc-outside-'))
  try {
    await run('word_create', { path: join(outside, 'escape.docx'), paragraphs: ['x'] })
    check(false, 'out-of-root write: expected refusal')
  } catch (error) {
    const text = String(error?.message ?? error)
    check(/escapes the session workspace|FS_SANDBOX_DENIED|file access denied/.test(text), `out-of-root write refused (${text.slice(0, 80)})`)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nreal-composition E2E: ALL CHECKS PASSED' : `\nreal-composition E2E: ${failures} CHECK(S) FAILED`)
  process.exitCode = failures === 0 ? 0 : 1
} catch (error) {
  console.error('real-composition E2E crashed:', error)
  process.exitCode = 1
} finally {
  await rm(deployRoot, { recursive: true, force: true }).catch(() => {})
  await rm(sessionRoot, { recursive: true, force: true }).catch(() => {})
}
