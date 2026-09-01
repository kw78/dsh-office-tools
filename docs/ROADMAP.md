# dsh-office-tools 多版本路线图

> 版本节奏与取舍的单一事实来源。v0.6.0（含 0.3.0/0.4.0/0.5.0）已实施；后续版本按需启动，逐流推进、独立提交、测试全绿才前进。

---

# v0.3.0「lighter & safer」

按 A → C → B → D 四个流推进。

## 流 A · npm 包瘦身

- `package.json` 的 `files`：`"lib"` → `"lib/*.js", "lib/types"`，把 ~6 MB 的 `index.js.map` 剔出 npm 包（保留在 git 里用于构建调试）。
- 验证：`npm pack --dry-run`（预期 packed ~2.0 MB → ~1.3 MB）+ `pnpm run check`。

## 流 C · zip 炸弹守卫

- 问题：50 MiB 上限只限压缩后体积，解压可放大百倍，inflate 打爆宿主内存。
- 依据（已核实源码）：jszip 3.10.1 的 `zip.files[name]._data.uncompressedSize` 即 central directory 声明大小，`loadAsync` 后可读、零解压。
- `src/paths.ts` 新增 `loadZipGuarded(buffer, signal): Promise<JSZip>` + 常量：单条目 ≤256 MiB、总量 ≤512 MiB、条目数 ≤100 000，超限即 throw（错误含实际值与上限）；返回 zip 实例避免二次解析；`_data` 私有字段用局部 interface 断言 + 注释锁 `^3.10.1`。
- 接入：`ppt_read`（替换现有 loadAsync）、`excel_read`/`excel_update`（XLSX.read 前预检）、`word_read`（mammoth 前预检，流 B 后成为唯一路径）。生成型工具不涉及。
- 测试：高压缩比 zip（测试内造 ~10 MB 重复文本）+ 可注入小上限触发拒绝；正常文件回归；伪 zip 友好报错。

## 流 B · word_read 去 mammoth 化

- 收益：mammoth 及其唯一引入的 bluebird（bundle 内 172 处引用、Mimosa 误报主力）整棵消失，预期 bundle 3.2 MB → 2.3~2.6 MB。诚实预期：jszip 自带 setimmediate 仍在，误报大减而非清零。
- 第 1 步 golden 对拍（mammoth 还在时）：新增 `tests/word-parity.spec.ts`，`word_create` 生成 fixture（标题/段落/空段/bullets/表格）+ JSZip 手工构造 docx 覆盖 `w:tab`、`w:br`、hyperlink、hyphen、连续空段；把 mammoth 输出硬编码为期望常量。行为契约（已核实 mammoth 源码）：段尾一律 `\n\n` 含末段；`w:tab`→`\t`；`w:br`→空字符串（丢失）；表格格间无分隔；hyperlink 留文本弃 URL；hyphen 映射 `\u2011`/`\u00AD`；页眉页脚脚注不包含。
- 第 2 步替换：`word_read` 改为 `loadZipGuarded` → `word/document.xml` → 复用 `ppt.ts` 正则手法（全局抽 `<w:p>`、段内拼 `<w:t>`、实体解码复用 `decodeXmlEntities`、每段尾 `\n\n`）。表格/超链接内段落被同一正则按文档序捕获，天然对齐。
- 第 3 步清理：删 mammoth 依赖与 `src/mammoth.d.ts`，更新 `build.mjs` 注释。
- 验证：对拍全绿 + `grep -ci bluebird lib/index.js` = 0 + 体积实测。

## 流 D · 发版收尾

- 版本 0.3.0（package.json + dsh.plugin.json）、CHANGELOG（Security/Changed/Perf 附实测数字）、README 双语安全边界、DEVELOPMENT.md 4/5/8 节、本地 AGENTS.md。
- `pnpm run check` + `npm pack --dry-run` 复核。
- 发版动作按 0.2.0 流程（push → tag → `npm publish --otp` → GitHub Release → 重启 DSH）。

---

# v0.4.0「写入增强」（已实施）

路线图原本未单列 0.4.0 细案；0.5.0 的「公式回读」与远期的「word 模板替换」都指向 0.4.0 = `word_update` + Excel 公式写入，据此实施：

- **`word_update`**：向现有 `.docx` 追加段落/项目符号/一个表格。追加片段由与 `word_create` 相同的 `buildDocx` 路径生成（样式一致、转义由 docx 包负责），剥掉临时文档的 `<w:sectPr>` 后缝合进原文档 `<w:sectPr>` 之前，经 zip 守卫加载、原子写回。bullet 复用文档已有 numbering（word_create 产物必有）；无 numbering 的文档降级为普通段落。与 word_create 同上限（10 000 段/20 万格）。
- **Excel 公式写入**：`=…` 前缀字符串在 excel_create / excel_update（整表与 cell_updates）三条路径写成真 `<f>` 公式单元格（SheetJS 默认会存成纯文本，需显式转换）。无缓存值，Excel 打开时计算；回读属 0.5.0。

---

# v0.5.0「读取增强」（已实施，2026-08-31）

四项全部落地；与原细案的偏差均已实测依据并在 DEVELOPMENT.md 4.10 记录：

- **excel 公式回读**：格内 `'=…'` 对称形态（有缓存值返回值）；顺带修复纯公式行被 `blankrows:false` 整行丢弃的对齐 bug；写入侧改为显式 `t="e"`（裸 `<f>` 会被 SheetJS 读取丢弃，实测）。
- **word_read 富模式**：`format: "markdown"`，Title/Heading1..6 → `#`..`######`（Title 与 H1 同级）、`numPr` → ilvl 缩进 `- `、表格 → markdown 表；默认纯文本不变。
- **ppt_read 表格**：结构化 `tables`（行×格），表格文字不再混入 `paragraphs`（行为变化）。
- **ppt_read 图片 alt**：`imageAlts`（descr，文档序、实体解码）；pptxgenjs deck 的 descr=图片源路径。
- **bounded 语义统一**：DEVELOPMENT.md 4.10 一张预算/截断口径总表。

---

# v0.6.0「工程化与生态」（已实施，2026-09-01）

规格与验收见 `docs/spec-0.6.0.md`。六项需求的落地结果：

- **CI 矩阵** ✅：`ci.yml` node 20/22 矩阵（`fail-fast: false`），engines 下限开始被真实测试。
- **npm provenance + 发布工作流** ✅：`publish.yml` 由 GitHub Release 触发，`id-token: write` + `npm publish --provenance`，带 tag↔version 一致性门禁与完整 check 前置；0.3.0–0.5.0 滞留 GitHub 未发 npm 的根因（手工发布）就此消除。首次运行需配 `NPM_TOKEN` secret 并在 npm 侧允许 provenance（DEVELOPMENT.md §10.2 清单）。
- **peer 依赖实测刷新** ✅：node-semver 实测 `^0.1.0-rc.6` 不满足运行时 0.1.1-rc.2（预发布元组规则），四个 `dsh-*` 放宽为 `^0.1.0-rc.6 || ^0.1.1-rc.0`（恰好覆盖 npm 上全部 0.1.x 稳定版与 rc、排除 0.1.2-alpha/0.2.0）；cordis 维持 `^4.0.1`（覆盖运行时 4.0.2）。devDependencies 解析到 0.1.1-rc.2，55 测试全绿。
- **README 演示 + 示例 prompt** ✅（有偏差）：双语 Demo 章节内嵌示例 prompt；演示图用 `docs/demo/session.svg`（终端风格、数字取自真实运行）而非录屏 GIF——模型无法代录终端，GIF 留作后续可选增强；`tests/demo-trio.spec.ts` 把「一句话三件套」钉进 CI，演示不与工具漂移。
- **dsh-hub / Atlas 提交** ⏳（仓库内部分完成）：登记材料刷新到 0.6.0（含 provenance/ciMatrix 事实、先经 publish.yml 发 npm 的步骤）；实际提交仍需维护者在 Atlas/omdsh-dev 仓库操作。
- **开关泛化** ❌（按原条件维持不做）：无用户提出 Word/Excel 同类共存需求，`enablePptTools` 保持唯一开关。

发版卫生（2026-09-01 核对）：SheetJS CDN 仍以 0.20.3 为最新（0.20.5 tarball 404）；docx 9.7.1 / jszip 3.10.1 / pptxgenjs 4.0.1 均为 npm 最新，无需升级。

# 远期候选（按需评估，不承诺）

- **`ppt_update`**（向现有 deck 追加 slide）：需克隆 slide XML + `_rels` + `[Content_Types].xml` 三处联动，OOXML 手术里最硬的一块。仅当出现真实需求再啃。
- **PDF 导出**：纯 JS 无满意方案，得破"不调外部进程"纪律 → **建议永久放弃**，除非未来出现可靠的纯 JS 渲染器。
- **`.doc/.xls/.ppt` 旧 OLE 格式**：解析复杂、攻击面大、需求稀少 → 建议不做；确有需求时引导用户先转换。
- **`word_update` 模板替换**（占位符变量注入）：word_update 打底后可加 `template_fill` 模式。

# 持续卫生（不占版本号，每次发版前过一遍）

1. 瞄一眼 cdn.sheetjs.com 是否有 >0.20.3 新版，有则升级 + 跑全套测试；
2. 依赖刷新（docx/jszip/pptxgenjs minor）+ `pnpm run check`；
3. Mimosa 提交门禁被拦 → 重试一次（会话基线吸收），持续被拦再显式深扫；
4. CHANGELOG / README / DEVELOPMENT.md / AGENTS.md 四处同步。

# 风险与对策（全程适用）

- 对拍差异：golden 测试先钉行为再动手；
- jszip `_data` 私有字段：锁 `^3.10.1` + 断言注释；
- 体积数字以实测为准，预期值仅参考；
- 每个流独立提交，任何一步出问题可单独 revert，不影响已合入部分。
