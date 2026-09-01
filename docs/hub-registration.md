# Hub / awesome list registration notes

This file is the registration reference for maintainers. It collects the exact
blocks needed to onboard `dsh-office-tools` into the DSH community indexes.

## Repository

- URL: <https://github.com/kw78/dsh-office-tools>
- Branch: `main`
- Package: `dsh-office-tools` (declares `dsh.bundle.patch` → `cordis.patch.yml`)
- Install: `dsh plugin --profile web add github:kw78/dsh-office-tools`

## GitHub topics

Apply these topics in the repository settings:

```text
dsh
dsh-plugin
deepseek-harness
office
word
excel
powerpoint
```

## awesome-dsh-plugin

PRs are welcome. Add one line under **Tools & Capabilities** in both
`README.md` and `README.zh.md`.

`README.md`:

```markdown
- [kw78/dsh-office-tools](https://github.com/kw78/dsh-office-tools) - Workspace-safe Office toolkit for agents: create/read Word, create/read/update Excel, and create/read PowerPoint decks with PNG/JPG/GIF image placement.
```

`README.zh.md`:

```markdown
- [kw78/dsh-office-tools](https://github.com/kw78/dsh-office-tools) - 面向 agent 的工作区安全 Office 工具集：创建/读取 Word、创建/读取/更新 Excel、创建/读取 PowerPoint，并支持 PNG/JPG/GIF 图片排版。
```

dsh-market mirrors the plugins listed on awesome-dsh-plugin, so no separate
dsh-market PR is required.

## dsh-hub (OMDSH Hub)

The hub registry is generated through Atlas and then vendored with
`npm run registry:vendor`; hand-edited registry JSON is not accepted
(see `omdsh-dev/dsh-hub` CONTRIBUTING.md). The catalog entry below is a
maintainer reference only.

```json
{
  "id": "dsh-office-tools",
  "displayName": "dsh-office-tools",
  "description": "Workspace-safe Office tools for DeepSeek Harness: Word create/read, Excel create/read/update, PowerPoint create/read with image placement.",
  "kind": "extension",
  "tags": ["office", "word", "excel", "powerpoint", "tools"],
  "author": { "name": "kw78", "url": "https://github.com/kw78" },
  "version": "0.6.0",
  "license": "MIT",
  "source": {
    "repository": "https://github.com/kw78/dsh-office-tools",
    "ref": "main",
    "path": null
  },
  "compatibility": { "declared": "npm-next" },
  "risk": {
    "level": "unknown",
    "facts": {
      "sourcePinned": false,
      "vulnerabilityScan": "unknown",
      "permissions": "workspace-fs",
      "nativeCode": "none",
      "installScripts": "build-only",
      "runtimeDependencies": "docx/jszip/pptxgenjs (npm) + xlsx (SheetJS CDN 0.20.3 tarball URL)",
      "provenance": "npm --provenance via GitHub Actions OIDC (publish.yml)",
      "ciMatrix": "node 20/22"
    }
  },
  "listing": {
    "state": "unreviewed",
    "catalogStatus": "prototype",
    "trustedPublisher": "unknown"
  },
  "maintenance": { "state": "active", "notice": null, "successor": null },
  "install": {
    "mode": "profile-bundle",
    "adapter": "official-profile/v1",
    "packageName": "dsh-office-tools",
    "spec": "github:kw78/dsh-office-tools"
  },
  "links": {
    "atlas": "https://github.com/kw78/dsh-office-tools",
    "repository": "https://github.com/kw78/dsh-office-tools"
  }
}
```

Maintainer steps:

1. Publish the release first: push the tag, then create the GitHub Release — `publish.yml` runs `pnpm run check` and publishes to npm with provenance. The registry entry below should reference the npm version, not the git ref.
2. Verify the package's `dsh.bundle.patch` manifest and the green `publish.yml` run.
3. Create the catalog entry in Atlas and regenerate the signed registry.
4. Pin the generated file with `npm run registry:vendor -- <file>` and open a PR.
