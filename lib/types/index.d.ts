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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Plugin identity for cordis.yml rows. */
export declare const name = "dsh-office-tools";
/** The tool registry and the official filesystem service are the only runtime services required. */
export declare const inject: string[];
/** Host plugin configuration, validated at load by the Loader. */
export interface Config {
    /** Register `ppt_create` / `ppt_read`. */
    enablePptTools: boolean;
}
/** Configuration schema; the callable form applies schema defaults. */
export declare const Config: z<Schemastery.ObjectS<{
    enablePptTools: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    enablePptTools: z<boolean, boolean>;
}>>;
export declare function apply(ctx: Context, config?: Config): void;
