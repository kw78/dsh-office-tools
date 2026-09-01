/**
 * ESM host build for dsh-office-tools.
 *
 * The harness profile resolves `main` (`lib/index.js`). The artifact bundles
 * only this plugin's own code plus `@deepseek-ai/schemastery` (needed by the
 * Loader to validate `Config`); the Office libraries (docx / xlsx / pptxgenjs
 * / jszip) stay external and resolve from the profile's node_modules at
 * runtime — they are regular `dependencies` (0.6.0: committed runtime files
 * must fit third-party store review byte bounds — 256 KiB per file makes any
 * inlined layout impossible, since the xlsx module alone exceeds it even
 * minified). `@deepseek-ai/dsh-*` and `cordis` stay external (the profile's
 * healed node_modules provides them). Type declarations are emitted by tsc.
 */

import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
mkdirSync('lib', { recursive: true })

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  sourcemap: true,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-*',
    'docx',
    'jszip',
    'pptxgenjs',
    'xlsx',
  ],
  logLevel: 'info',
})

execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit' })
