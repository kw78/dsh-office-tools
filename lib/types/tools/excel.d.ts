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
import type { Context } from '@deepseek-ai/cordis';
import type { FsContext } from '../fschannel.ts';
export declare function registerExcelTools(ctx: Context & FsContext): () => void;
