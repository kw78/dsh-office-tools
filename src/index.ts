/**
 * dsh-office-tools host plugin.
 *
 * Registers eight model-facing tools on `ctx.tools`:
 *
 *   word_create / word_read / word_update
 *   excel_create / excel_read / excel_update
 *   ppt_create / ppt_read
 *
 * All file access is confined to the calling agent's session workspace and
 * flows exclusively through the official `ctx.fs` service — reads as raw
 * bytes, writes as UTF-8 text (generated packages are pure ASCII by
 * construction). Every registration is wrapped in `ctx.effect` so Cordis
 * disposes the tools with the plugin fiber.
 *
 * The PowerPoint pair is config-gated: dedicated presentation plugins such
 * as dsh-ppt register a colliding `ppt_create`, and DSH refuses duplicate tool
 * names at startup, so profiles running one of those set `enablePptTools: false`
 * to load this plugin for Word/Excel only.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerExcelTools } from './tools/excel.ts'
import { registerPptTools } from './tools/ppt.ts'
import { registerWordTools } from './tools/word.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-office-tools'

/** The tool registry and the official filesystem service are the only runtime services required. */
export const inject = ['tools', 'fs']

/** Host plugin configuration, validated at load by the Loader. */
export interface Config {
  /** Register `ppt_create` / `ppt_read`. */
  enablePptTools: boolean
}

/** Configuration schema; the callable form applies schema defaults. */
export const Config = z.object({
  enablePptTools: z.boolean().default(true)
    .description('register ppt_create / ppt_read (set to false to coexist with a dedicated PPT plugin such as dsh-ppt)'),
})

export function apply(ctx: Context, config?: Config): void {
  const resolved = Config(config ?? {})
  ctx.effect(() => {
    const disposers = [
      registerWordTools(ctx),
      registerExcelTools(ctx),
      ...(resolved.enablePptTools ? [registerPptTools(ctx)] : []),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
}
