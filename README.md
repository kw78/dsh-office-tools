# dsh-office-tools

Eight model-facing Office file tools for DeepSeek Harness, running entirely in the plugin host half.

[![npm version](https://img.shields.io/npm/v/dsh-office-tools)](https://www.npmjs.com/package/dsh-office-tools) [![ci](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Listed on awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> Install: `dsh plugin --profile web add github:kw78/dsh-office-tools`

| Tool | Purpose | Library |
|---|---|---|
| `word_create` | Create `.docx` (title, paragraphs, bullets, one table) | `docx` |
| `word_read` | Extract text from `.docx`; `format: "markdown"` renders headings, lists, and tables structurally | `jszip` (in-house extractor) |
| `word_update` | Append paragraphs, bullets, and/or a table to an existing `.docx` | `docx` + `jszip` |
| `excel_create` | Create a multi-sheet `.xlsx` from scalar cell grids | SheetJS (`xlsx`) |
| `excel_read` | Read one or all sheets as scalar rows; formulas return cached values or `'=…'` strings | SheetJS |
| `excel_update` | Replace/create whole sheets, or write cells by A1 address | SheetJS |
| `ppt_create` | Create a 16:9 `.pptx` (title slide, titles, paragraphs, bullets, notes, PNG/JPG/GIF images) | `pptxgenjs` |
| `ppt_read` | Extract per-slide paragraphs, tables, speaker notes, image counts, and image alt texts | `jszip` |

String cells starting with `=` are written as real Excel formulas (Excel computes them on open).

## Demo

One prompt, a quarterly-report trio — Word with a metrics table, Excel with `=SUM`/variance formulas, PowerPoint with speaker notes:

<img src="docs/demo/session.svg" alt="One prompt generating report.docx, budget.xlsx, and deck.pptx" width="780">

The prompt behind that session:

> Generate the Q3 quarterly-report trio: `report.docx` (title, two summary paragraphs, three highlights, a metrics table), `budget.xlsx` (a Budget sheet with `=SUM` totals and plan-vs-actual variance formulas, plus a Summary sheet), and `deck.pptx` (title slide + three content slides with speaker notes).

The model turns it into `word_create` → `excel_create` → `ppt_create` (reads come back through `word_read` / `excel_read` / `ppt_read`; freshly written formulas read back as `'=…'` strings until Excel caches values). The whole flow is pinned by `tests/demo-trio.spec.ts`, so the demo cannot drift from the tools. The file sizes in the image come from a real run of that test scenario.

## Harness integration

The plugin follows the standard DSH host-plugin contract:

- It exports `name` / `inject` / `apply` / `Config`; `inject = ['tools']` is its only runtime service dependency (`@deepseek-ai/dsh-tools`).
- `apply(ctx)` wraps every `ctx.tools.register(defineTool({...}))` in `ctx.effect(...)` so Cordis disposes the registrations with the plugin fiber.
- `defineTool` declares model-visible `parameters`, a validated canonical `output.schema`, and a pure `output.render` text projection.
- `execute(args, exec)` resolves every path against `exec.agent.session.header.cwd`; relative paths stay in the session workspace and absolute paths are accepted only when still inside it. A `realpath` check on the nearest existing ancestor closes the symlink escape hatch.
- Image files must live inside the session workspace (`.png/.jpg/.jpeg/.gif`, 20 MiB each); explicit inch coordinates `x/y/w/h` are supported, or omit them for automatic placement below the text.
- Writes go through a same-directory temp file + `rename`; `overwrite` defaults to `false`.

## Build

```bash
pnpm install
pnpm run check   # typecheck + tests + build
```

Artifacts: `lib/index.js` (ESM host bundle of this plugin's own code plus schemastery — 90 kB; the Office libraries are regular runtime `dependencies` resolved from the profile's node_modules) and `lib/types/**/*.d.ts`. `@deepseek-ai/*` and `cordis` stay external.

## Install

```bash
# npm (recommended)
dsh plugin --profile web add dsh-office-tools

# GitHub source
dsh plugin --profile web add github:kw78/dsh-office-tools

# local checkout
dsh plugin --profile web add /path/to/dsh-office-tools
```

Restart the DSH server after installation. The eight tools appear in the next prompt assembly. Note: since 0.6.0 the Office libraries are runtime `dependencies`, so installation fetches them (npm, plus cdn.sheetjs.com for SheetJS — ~15–20 MB); the plugin package itself is ~32 kB.

## Configuration

The plugin declares a schemastery `Config` the Loader validates at load time. One option exists today:

| Option | Type | Default | Effect |
|---|---|---|---|
| `enablePptTools` | boolean | `true` | Register `ppt_create` / `ppt_read`. Set to `false` to load this plugin for Word/Excel only. |

`enablePptTools: false` exists for coexistence: dedicated presentation plugins such as dsh-ppt also register a `ppt_create`, and DSH refuses duplicate tool names at startup (`tool "ppt_create" is already registered`). Disable the PPT pair here and let the dedicated plugin own presentations:

```yaml
# profile cordis.patch.yml
- insert:
    - id: dsh-office-tools
      config:
        enablePptTools: false
```

## Community indexes

- Registration blocks for awesome-dsh-plugin / dsh-market are in [docs/hub-registration.md](docs/hub-registration.md).
- Recommended repository topics: `dsh`, `dsh-plugin`, `deepseek-harness`, `office`.

## Safety

- All file access is confined to the calling agent's session workspace.
- Reads are capped at 50 MiB compressed; before anything is inflated, the archive's own declared sizes are checked against budgets (256 MiB per entry, 512 MiB per archive, 100 000 entries), so zip bombs are refused rather than decompressed. XML parts carrying DOCTYPE/ENTITY declarations are refused outright.
- Text/cell results are bounded and mark `truncated`.
- Creates/updates are bounded by row and cell limits and refuse overwrites by default.
- No LibreOffice/PowerPoint/Word subprocess is spawned; formats are generated and parsed with pure-JS libraries.
- SheetJS is pinned to the 0.20.3 tarball from the official CDN (<https://cdn.sheetjs.com>): npm stopped at 0.18.5, which carries CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS); fixed releases are only distributed through the official CDN. Since 0.6.0 it is a URL-pinned runtime dependency — installs download exactly this tarball from the CDN, never the vulnerable npm release.
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md).
