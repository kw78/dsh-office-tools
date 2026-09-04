/**
 * ESM host build for dsh-office-tools.
 *
 * The harness profile resolves `main` (`lib/index.js`). The artifact bundles
 * only this plugin's own code; every `@deepseek-ai/*` package (cordis, the
 * dsh services, and schemastery, which dsh-tools itself imports at runtime)
 * stays external because the profile's healed node_modules provides them.
 * esbuild writes the output itself, so this script needs no file-system or
 * process APIs. Type declarations are emitted separately by `pnpm run types`
 * (tsc, see package.json scripts).
 */

import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  sourcemap: true,
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
})
