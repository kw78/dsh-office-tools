# dsh-office-tools

[![npm version](https://img.shields.io/npm/v/dsh-office-tools)](https://www.npmjs.com/package/dsh-office-tools) [![ci](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Listed on awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> **If you find this project useful, please give it a ⭐ Star — it helps others find it.**

Eight model-facing Office file tools for DeepSeek Harness: create, read, and update Word (`.docx`), Excel (`.xlsx`), and PowerPoint (`.pptx`) files inside the session workspace. Zero runtime dependencies — every package is generated and parsed by the plugin's own OOXML engine, and every byte crosses the official `ctx.fs` service.

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

Compatibility: DSH `>=0.1.0-rc.6`; exact per-release records live in `package.json` (`dsh.compatibility.dshReleases`).

Further reading: [DEVELOPMENT.md](docs/DEVELOPMENT.md) · [ROADMAP.md](docs/ROADMAP.md) · [hub-registration.md](docs/hub-registration.md) · MIT [License](LICENSE)
