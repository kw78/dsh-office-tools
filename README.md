# dsh-office-tools

[![npm version](https://img.shields.io/npm/v/dsh-office-tools)](https://www.npmjs.com/package/dsh-office-tools) [![ci](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Listed on awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> **If you find this project useful, please give it a ⭐ Star — it helps others find it.**

Eight model-facing Office file tools for DeepSeek Harness: create, read, and update Word (`.docx`), Excel (`.xlsx`), and PowerPoint (`.pptx`) files inside the session workspace. Zero runtime dependencies — every package is generated and parsed by the plugin's own OOXML engine, and every byte crosses the official `ctx.fs` service.

**Scope:** this is a file generator, not an editor. It creates files and appends to them (`word_update` appends; there is no `ppt_update`), `word_create` and each `word_update` write at most one table, and PPT images are **linked, not embedded** because the workspace write channel is text-only.

## Tools

| Tool | Purpose |
|---|---|
| `word_create` | Create `.docx` (title, paragraphs, bullets, one table) |
| `word_read` | Extract text; `format: "markdown"` renders structure |
| `word_update` | Append paragraphs, bullets, and/or a table |
| `excel_create` | Create multi-sheet `.xlsx` from cell grids |
| `excel_read` | Read sheets as rows; formulas return cached values or `'=…'` |
| `excel_update` | Replace/create sheets, or write cells by A1 address |
| `ppt_create` | Create 16:9 `.pptx` (slides, bullets, notes, linked images) |
| `ppt_read` | Extract text, notes, tables, and per-shape geometry |

Strings starting with `=` become real Excel formulas.

## Demo

One prompt, a quarterly-report trio:

<img src="docs/demo/session.svg" alt="One prompt generating report.docx, budget.xlsx, and deck.pptx" width="780">

## Positioning

A headless OOXML toolkit, not a visual office suite: about 160 KB unpacked, no runtime npm dependencies (everything is bundled), no local service, no browser, and no telemetry. Every write goes through the DSH filesystem service, so behavior is identical in a desktop session and in CI.

| | dsh-office-tools | Visual office suites (e.g. Univer-based plugins) |
|---|---|---|
| Output | Standard `.docx` / `.xlsx` / `.pptx` files | Native document model, exported to Office formats |
| Runtime | Node ≥ 20 only | Local gateway service + headless Chromium |
| Install size | ~160 KB unpacked | Hundreds of MB |
| Review | Tool results, markdown, wireframe sketches | Live canvas previews and approval cards |

Use a visual suite when you need to see and approve every edit; use this plugin when the agent should produce standard Office files in bulk without extra moving parts.

## Install

```bash
dsh plugin --profile web add dsh-office-tools              # npm (recommended)
dsh plugin --profile web add github:kw78/dsh-office-tools  # from source
```

Restart DSH after installing. Requires a profile that provides the `fs` service (every profile with built-in read/write tools does).

## Notes

- All paths are confined to the session workspace; `overwrite` defaults to `false`.
- Reads accept any real package (STORE/DEFLATE) with zip-bomb guards; updates refuse packages with binary parts instead of corrupting them.
- PPT images are **linked, not embedded**: the sanctioned `ctx.fs` write channel is UTF-8 text only, so a package cannot carry binary image parts. Keep image files next to the deck when moving it, and note that PowerPoint blocks external content by default — a linked picture renders as a "blocked automatic download" placeholder until you enable external content (File → Info → Enable Content, or add the folder under Trust Center → Trusted Locations). This is a PowerPoint security policy, not a package defect.
- `ppt_create` echoes every element's landing position; `ppt_read` returns the same geometry for any deck.

## Configuration

One option: `enablePptTools` (default `true`) — set it to `false` to coexist with a dedicated presentation plugin such as dsh-ppt:

```yaml
- insert:
    - id: dsh-office-tools
      config:
        enablePptTools: false
```

## Development

```bash
pnpm install && pnpm run check   # typecheck + tests + build
pnpm run test:e2e                # real-composition E2E (sandbox-policy + fs-sandbox + tools)
```

<!-- compatibility:start -->
Compatibility: `^0.1.0-rc.6 || ^0.1.1-rc.0 || ^0.1.2-alpha.0 || ^0.1.5-alpha.0 || ^0.2.0-rc.1 || ^0.2.1-rc.3`; exact tested releases live in `package.json` (`dsh.compatibility.dshReleases`). CI exercises 0.1.2-rc.1, 0.2.0-rc.1, and 0.2.1-rc.3. DSH 0.3.x is not declared supported.
<!-- compatibility:end -->

Generated packages are limited to 50 MiB. Up to 200 PPT slides (including an optional title slide) are accepted; linked images remain external. See [architecture and migration plan](docs/ARCHITECTURE.zh.md) for the binary-write seam needed for true embedding.

Further reading: [DEVELOPMENT.md](docs/DEVELOPMENT.md) · [ROADMAP.md](docs/ROADMAP.md) · [hub-registration.md](docs/hub-registration.md) · MIT [License](LICENSE)
