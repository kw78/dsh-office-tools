# Changelog

All notable changes to this project will be documented in this file.

## [0.6.0] - 2026-09-01

Engineering-and-ecosystem release (spec: `docs/spec-0.6.0.md`). No tool behavior changes.

### Added

- npm publish workflow with provenance (`.github/workflows/publish.yml`): publishing a GitHub Release triggers a full `pnpm run check` and then `npm publish --provenance` under OIDC (`id-token: write`). A guard refuses non-`v*` tags and any tag that does not match `package.json`'s version. One-time setup (repo `NPM_TOKEN` secret, npm-side provenance) is documented in `docs/DEVELOPMENT.md` §10.2. Releases 0.3.0–0.5.0 never reached npm (registry still at 0.2.0) because publishing was manual; this closes that gap.
- CI matrix: `ci.yml` now tests node 20 and 22 (`fail-fast: false`) — `engines` claims `>=20` but only 22 was tested.
- README demo (both languages): the "one prompt, quarterly-report trio" example prompt with a terminal-style session image (`docs/demo/session.svg`, numbers from a real run), and `tests/demo-trio.spec.ts` — an in-repo, path-independent integration test that creates `report.docx` + `budget.xlsx` (formulas) + `deck.pptx` (notes) in one session and reads all three back, pinning the README claim. The tracked suite grows 46 → 47 tests (the maintainer's machine additionally runs an untracked local demo spec; 55 pass there).

### Changed

- Office libraries moved from build-time inlining to regular runtime `dependencies` (`docx` / `jszip` / `pptxgenjs` from npm, `xlsx` pinned to the SheetJS CDN 0.20.3 tarball URL). `lib/index.js` now bundles only this plugin's own code plus schemastery: 2,479,019 B → 90,592 B, and the npm tarball shrinks 550 kB → 31.8 kB. Reason: the third-party DSH Store review (AI-Scarlett/DSH-Store#334) caps committed runtime files at 256 KiB per file / 2 MiB total, and no inlined layout can satisfy the per-file bound — the xlsx module alone exceeds 256 KiB even minified (whole minified bundle measured 1,319,961 B). This reverses the 0.2.0 "self-contained tarball" property: installs now fetch ~15–20 MB of dependencies (including cdn.sheetjs.com for SheetJS), exactly the 0.1.0-era install model. Risk is low because the entire test suite already ran against unbundled resolution — the bundle was only the published artifact — and a plain-Node ESM import smoke test of `lib/index.js` passes. Version pins are unchanged (SheetJS stays the CVE-fixed CDN 0.20.3; jszip stays `^3.10.1`, whose `_data` field the zip guard reads — if a future jszip drops it, the guard degrades to the compressed-size cap rather than breaking).
- Peer dependency ranges for `@deepseek-ai/dsh-agent/-llm/-session/-tools` widened from `^0.1.0-rc.6` to `^0.1.0-rc.6 || ^0.1.1-rc.0`. Verified empirically with node-semver: the old range does **not** satisfy the shipping DSH runtime `0.1.1-rc.2` (prerelease versions only satisfy comparators sharing their [major.minor.patch] tuple), so the declared peers excluded the host actually running the plugin. The union covers every 0.1.x stable and rc on npm (0.1.0-rc.6/7/8, 0.1.0, 0.1.1-rc.*, 0.1.1) and still excludes 0.1.2-alpha/0.2.0. `cordis` stays `^4.0.1` (already covers the runtime's 4.0.2). devDependencies resolve to 0.1.1-rc.2, so typecheck/tests now run against the same versions as the runtime — all 55 tests green against it.

### Docs

- `docs/hub-registration.md`: catalog entry bumped to 0.6.0 with `provenance` and `ciMatrix` risk facts; maintainer steps now start from the automated npm release.
- README.zh: stale tool count (7 → 8) fixed.
- ROADMAP marks 0.6.0 implemented, with deviations recorded (session image is an SVG rendered from real output, not a recorded GIF; the dsh-hub/Atlas submission itself remains an external maintainer action; per-family config switches stay deferred until users ask).

## [0.5.0] - 2026-08-31

### Added

- `excel_read` formula read-back: formula cells return their cached value when one exists; formulas without a cached value return the formula as an `'=SUM(…)'` string — symmetric with the 0.4.0 write convention. Rows holding only such formulas are now kept (previously dropped as blank, misaligning row order).
- `word_read` rich mode: pass `format: "markdown"` for structured markdown — Title/Heading1-6 render as `#`..`######` (Title shares the top level with Heading1), numbered/bullet paragraphs as indented `- ` items, and tables as markdown tables. Default plain-text output is unchanged.
- `ppt_read` table text: each slide can carry `tables` (rows of cell texts, paragraphs joined with spaces). Table cell text no longer leaks into `paragraphs`.
- `ppt_read` image alt texts: each slide can carry `imageAlts`, the `descr` attributes of its pictures in document order (decks created by `ppt_create` carry the image source path there).

### Changed

- Excel write path now emits uncached formulas as `t="e"` cells (the shape Excel/LibreOffice use); a bare `<f>` without `t` is dropped by SheetJS on read.
- `excel_read` reads with `cellFormula: true` and walks the used range directly instead of `sheet_to_json` — output verified cell-for-cell identical for strings, numbers, booleans, empty cells, gaps, and cached formulas.
- Read budgets and `truncated` semantics are now documented in one table (`docs/DEVELOPMENT.md` §4.10): `word_read`/`ppt_read` 200 000 chars, `excel_read` 5 000 rows per sheet (cap 10 000) and 200 000 cells per workbook, 50 MiB file cap, zip budgets 256 MiB/entry / 512 MiB/archive / 100 000 entries.

## [0.4.0] - 2026-08-30

### Added

- `word_update`: append paragraphs, bullet points, and/or one table to an existing `.docx` in the session workspace. The appended body children are generated by the same `docx` package path `word_create` uses (identical styling), then spliced into `word/document.xml` right before the trailing `<w:sectPr>` and the archive is rewritten atomically through the zip-bomb guard. Bullets reuse the list numbering the document already defines — files created by `word_create` always have it; documents without list numbering show appended bullets as plain paragraphs. Same caps as `word_create` (10 000 paragraphs/bullets/rows, 200 000 table cells).
- Excel formula writing: string cells starting with `=` are now written as real formula cells (`<f>`) across `excel_create` sheets, `excel_update` whole-sheet replacements, and `cell_updates`. SheetJS would otherwise store them as plain text. Excel computes the values on open; `excel_read` returns empty for uncached formulas today, with formula read-back planned for 0.5.0.

## [0.3.0] - 2026-08-30

### Security

- Zip-bomb guard on every read path (`word_read`, `excel_read`, `excel_update`, `ppt_read`): the 50 MiB read cap only bounds the compressed bytes, and deflate can expand an archive a thousandfold. `loadZipGuarded` (`src/paths.ts`) now checks each archive's own central-directory declarations before anything is inflated — one entry may not declare more than 256 MiB uncompressed, the whole archive not more than 512 MiB, and not more than 100 000 entries — refusing with the actual value and the budget in the error. Non-zip bytes get a friendly "not a readable zip archive" refusal instead of a raw jszip stack.
- XML parts extracted from untrusted archives (`word/document.xml`, pptx slides/notes/relationships) are refused outright when they carry a DOCTYPE/ENTITY declaration: legitimate OOXML never contains one, and our regex extractors never resolve entities anyway.

### Changed

- `word_read` no longer uses mammoth. It now unzips with jszip and extracts text with an in-house regex walker; behavior is pinned byte-for-byte to mammoth 1.11.0's raw-text output by `tests/word-parity.spec.ts` (paragraphs end with `\n\n` including the last and empty ones, `w:tab` → `\t`, `w:br`/`w:cr` dropped, `w:noBreakHyphen` → U+2011, `w:softHyphen` → U+00AD, hyperlink text kept without URLs, table cells without separators, headers/footers/footnotes excluded, XML entities decoded).
- `mammoth` (and its transitive `bluebird`) removed from the dependency tree; `src/mammoth.d.ts` deleted.

### Performance

- Host bundle `lib/index.js`: 3.2 MB → 2.4 MB (bluebird references in the bundle: 0).
- npm tarball: 2.0 MB → 550 kB packed (9.8 MB → 2.5 MB unpacked). The `files` allowlist now ships `lib/*.js` + `lib/types`, excluding the ~6 MB `lib/index.js.map`, which stays in git for build debugging.

## [0.2.0] - 2026-08-30

### Security

- SheetJS dependency moved from npm `xlsx@0.18.5` to the official CDN tarball `xlsx@0.20.3` (<https://cdn.sheetjs.com>). npm's 0.18.5 carries CVE-2023-30533 (prototype pollution via crafted workbooks, fixed upstream in 0.19.3) and CVE-2024-22363 (ReDoS, fixed upstream in 0.20.2); fixed releases are only distributed through the official CDN. All Excel tool tests pass against 0.20.3.
- The five Office libraries (`docx`, `jszip`, `mammoth`, `pptxgenjs`, `xlsx`) are build-time-only and moved to `devDependencies`: they are inlined into `lib/index.js` by esbuild and never resolved at runtime, so installs of the published plugin fetch nothing beyond the plugin tarball (no cdn.sheetjs.com access required downstream). The host bundle shrinks from 4.0 MB to ~3.2 MB.

### Added

- `enablePptTools` config switch (default `true`) so this plugin can coexist with dedicated presentation plugins such as dsh-ppt, which register a colliding `ppt_create` that DSH rejects at startup. With `enablePptTools: false` only the five Word/Excel tools are registered. Declared through a schemastery `Config` validated by the Loader.

## [0.1.0] - 2026-08-15

### Added

- `word_create` / `word_read` for Word `.docx` documents.
- `excel_create` / `excel_read` / `excel_update` for Excel `.xlsx` workbooks.
- `ppt_create` / `ppt_read` for PowerPoint `.pptx` decks.
- PNG/JPG/GIF image embedding in `ppt_create` with explicit or automatic placement.
- Per-slide image count reporting in `ppt_read`.
- Workspace confinement (`session.header.cwd` + realpath check), atomic writes, overwrite protection, and size/cell limits.
- Unit/integration tests and GitHub Actions CI.
