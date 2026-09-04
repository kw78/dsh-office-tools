# dsh-office-tools 开发总结

> 面向未来 agent / 维护者：本文记录本项目从 0 到发布的全过程、架构决策、已知问题与改进路线。

## 1. 目标

让 DeepSeek Harness（DSH）里的 agent 直接调用 Office 工具，完成真实文档任务：

- 创建、读取 Word `.docx`
- 创建、读取、更新 Excel `.xlsx`
- 创建、读取 PowerPoint `.pptx`
- PPT 支持 PNG/JPG/GIF 图片嵌入与布局

不修改 DSH 源码，不调用 LibreOffice / Word / PowerPoint 外部进程，全部通过纯 JS 库读写 OOXML。

## 2. 框架分析结论

DSH 是 Cordis 插件内核：

- host 插件导出 `name` / `inject` / `apply`；
- 工具通过 `@deepseek-ai/dsh-tools` 的 `ctx.tools.register(defineTool(...))` 注册；
- `defineTool` 声明模型可见 `parameters`、强制校验的 `output.schema`、模型文本投影 `output.render`；
- 执行链路：模型调用 → 参数校验 → `tools/pre-execute` → guards → `tools/execute` → 工具体 → 输出校验 → render → post-execute → result；
- 工具通过 `exec.agent.session.header.cwd` 获取当前会话工作区，通过 `exec.signal` 协作取消。

因此正确做法是新增独立 host 插件，而不是改 agent loop。

## 3. 工具清单

| 工具 | 功能 | 依赖 |
|---|---|---|
| `word_create` | 创建 `.docx`：标题、段落、项目符号、一个表格 | `docx` |
| `word_read` | 提取 `.docx` 纯文本（mammoth 契约的自研提取器，0.3.0）；`format: "markdown"` 富模式（0.5.0） | `jszip` |
| `word_update` | 向现有 `.docx` 追加段落/项目符号/表格（0.4.0） | `docx` + `jszip` |
| `excel_create` | 创建多 sheet `.xlsx`（`=…` 字符串写成公式，0.4.0） | `xlsx` (SheetJS) |
| `excel_read` | 读取一个或全部 sheet 为标量行；公式有缓存值返回值、无缓存返回 `=…` 公式串（0.5.0） | `xlsx` |
| `excel_update` | 替换/新建整张 sheet，或按 A1 地址写单元格（支持公式） | `xlsx` |
| `ppt_create` | 创建 16:9 `.pptx`，含标题页/段落/项目符号/备注/图片 | `pptxgenjs` |
| `ppt_read` | 按页提取段落、表格（0.5.0）、备注、图片数量与 alt 文本（0.5.0） | `jszip` |

## 4. 关键设计

### 4.1 路径安全（`src/paths.ts`）

- 所有路径从 `exec.agent.session.header.cwd` 解析；
- 相对路径留在工作区，绝对路径必须仍在工作区内；
- 最近存在祖先做 `realpath` 校验，防符号链接逃逸；
- 读文件上限 50 MiB；图片单张上限 20 MiB。

### 4.2 zip 炸弹守卫与 XML 拒绝（`src/paths.ts`，0.3.0）

- 50 MiB 上限只约束压缩后体积，deflate 可放大千倍；`loadZipGuarded(buffer, signal, limits?)` 在 `JSZip.loadAsync` 之后、任何解压之前，读取 jszip 3.10.1 内部的 `zip.files[name]._data.uncompressedSize`（即 central directory 声明值，零解压可读；该私有字段用局部 interface 断言访问，依赖锁 `^3.10.1`，升级需复核）；
- 预算：单条目 ≤256 MiB、整包声明总量 ≤512 MiB、条目数 ≤100 000，超限 throw 并附实际值与上限；`limits` 参数仅供测试注入小预算；
- 四条读路径全部接入：`ppt_read`（替换原 `loadAsync`）、`excel_read` / `excel_update`（`XLSX.read` 前预检）、`word_read`（流 B 后即唯一加载路径）；生成型工具不涉及；
- `assertNoXmlDtd(xml, label)`：OOXML 部件永不含 DOCTYPE/ENTITY，读到即拒绝（我们的正则提取器本就不展开实体，这是把实体膨胀载荷挡在门外）；`readZipXmlPart(zip, name, signal)` 统一「读部件文本 + DTD 拒绝」，word/ppt 共用；
- 伪 zip（随机字节）得到友好的 `not a readable zip archive` 报错，而非 jszip 原始堆栈。

### 4.3 原子写与覆盖保护

- 同目录临时文件 + `rename`；
- `overwrite` 默认 `false`；
- 创建前先做存在性检查，避免昂贵生成后才发现冲突。

### 4.4 PPT 图片

- 只允许 `.png/.jpg/.jpeg/.gif`，必须位于工作区；
- 支持显式 `x/y/w/h` 英寸坐标，也支持自动排到文本下方；
- `sizing: contain | cover`，自动模式默认 `contain`；
- `ppt_read` 通过 slide rels 统计每页图片数量，并过滤页码占位符。

### 4.5 word_read 自研提取器（0.3.0）

- `word_read` 用 `loadZipGuarded` 取 `word/document.xml`，`extractDocxText`（`src/tools/word.ts`）用与 `ppt.ts` 同款正则手法全局抽取 `<w:p>`、段内按文档序拼 `<w:t>`（实体解码复用 `shared.ts` 的 `decodeXmlEntities`），每段尾 `\n\n`；表格/超链接/文本框内的 `<w:p>` 被同一正则按文档序捕获；
- 行为契约逐字节对齐 mammoth 1.11.0 raw text，由 `tests/word-parity.spec.ts` 的 golden 常量钉死（mammoth 卸载前捕获）：段尾一律 `\n\n` 含末段与空段、`w:tab`→`\t`、`w:br`/`w:cr` 丢弃、`w:noBreakHyphen`→U+2011、`w:softHyphen`→U+00AD、hyperlink 留文本弃 URL、表格格间无分隔、页眉页脚脚注不包含；
- 收益：mammoth 及其引入的 bluebird 整棵移除，bundle 3.2 MB → 2.4 MB。

### 4.6 word_update 与 Excel 公式写入（0.4.0）

- `word_update`（`src/tools/word-update.ts` + `word.ts` 的 `buildAppendFragment`/`appendBeforeSectPr`）：追加内容用与 `word_create` 完全相同的 `buildDocx` 路径生成（样式天然一致、转义由 `docx` 包负责），从临时文档抽出 body 子元素、剥掉其尾部 `<w:sectPr>`，缝合进原文档 `word/document.xml` 的 `<w:sectPr>` 之前（页面设置必须保持 body 最后一个子元素）；原 zip 经 `loadZipGuarded` 加载、只替换 document.xml、`generateAsync` DEFLATE 重打包、原子写回；
- bullet 复用文档已有的 numbering（`word_create` 产出的文件必有 numId=1）；无 numbering 的文档追加 bullet 会显示为普通段落（Word 对缺失引用优雅降级，不报修复错误）；
- Excel 公式：SheetJS 会把 `=…` 字符串存成纯文本，`formulaCellOf`/`materializeFormulas`（`excel.ts`）把本次写入的此类单元格改写为 `{ f: … }` 公式单元格，产物携带 `<f>`，Excel 打开时计算；无缓存值，`excel_read` 暂返回空（公式回读在 0.5.0 规划）。

### 4.7 构建（`build.mjs`）

- esbuild 只打包本插件自有代码与 `@deepseek-ai/schemastery`（schemastery 用于 Loader 校验 `Config`，与 dsh-notification 同策略），产物 `lib/index.js` 90.6 kB；
- Office 库（`docx`/`jszip`/`pptxgenjs`/`xlsx`）与 `@deepseek-ai/dsh-*`、`cordis` 一样保持 external，运行时从 profile 的 node_modules 解析——它们是普通 `dependencies`（0.6.0，见 4.12）；
- `xlsx` 固定来自 SheetJS 官方 CDN tarball（0.20.3 URL 依赖），npm 上无修复版（见 0.2.0 变更与第 8 节）；
- 0.3.0 为内联 xlsx 引入的 `createRequire` banner 已随内联移除一并删除（external 化后 CJS 依赖由 Node 原生处理）；
- tsc 只发 `lib/types` 声明；
- npm 包 `files` 只装 `lib/*.js` + `lib/types`，`lib/index.js.map` 留在 git 用于构建调试（packed 550 kB → 31.8 kB）。

### 4.8 类型缺口

- `pptxgenjs` 官方 d.ts 在 NodeNext 下默认导出不可构造：`src/pptxgenjs-shim.d.ts`（mammoth 的补丁已随依赖一起删除）。

### 4.9 配置开关（`src/index.ts`）

- 插件导出 schemastery `Config`，Loader 加载时校验并应用默认值；
- `enablePptTools`（默认 `true`）：`false` 时不注册 `ppt_create`/`ppt_read`，用于与 dsh-ppt 等注册同名 `ppt_create` 的专用演示插件共存（DSH 拒绝同名工具重复注册）；
- `apply(ctx, config)` 内先 `Config(config ?? {})` 解析，未传配置时行为与 0.1.0 完全一致。

### 4.10 读取增强与预算语义（0.5.0）

- **excel_read 公式回读**：读取改用 `cellFormula: true` + `decode_range` 手动遍历（弃用 `sheet_to_json`），逐格规则：缺失→null；`t:"e"` 且有 `f`→`'=公式串'`（与 0.4.0 写入对称）、无 `f`→null；其余→`w ?? String(v)`。手动遍历与旧 `sheet_to_json(raw:false)` 输出逐格一致（实验验证）；写入侧同步改为显式 `{t:'e', f}`——无 `t` 属性的裸 `<f>` 在 SheetJS 读取时整格丢弃（实测），`t="e"` 也是 Excel/LibreOffice 对无缓存公式的原生写法；
- **word_read markdown 模式**：`format: "markdown"` 时 `extractDocxMarkdown` 按文档序遍历 `<w:p>`/`<w:tbl>` 块（表格优先匹配防段落泄漏）：Title/Heading1..6（docx 包与 Word 内建 styleId 一致）→ `#`..`######`（Title 与 Heading1 同级）；含 `<w:numPr>` → 按 ilvl 缩进的 `- `；表格 → markdown 表（首行表头、短行补空、格内 `|` 转义）；inline 规则与纯文本模式共用 `paragraphBodyText`；默认纯文本模式行为不变（golden 钉死）；
- **ppt_read 表格**：每页先抽出 `<a:tbl>` 块（`a:tbl`→`a:tr`→`a:tc` 逐层非贪婪切分，OOXML 该层无嵌套），格文本 = 格内段落空格连接；剩余 XML 照旧提取段落——表格文字不再重复出现在 `paragraphs`（行为变化，CHANGELOG 已记）；
- **ppt_read 图片 alt**：`<p:pic>` 块内首个 `<p:cNvPr>` 开标签的 `descr` 属性（注意 pptxgenjs 的 cNvPr 非自闭合），实体解码、滤空、文档序；pptxgenjs 产出的 deck descr=图片源路径；`imageCount` 仍来自 slide rels。

**读取预算与截断口径（统一语义）**：

| 工具 | 预算 | truncated 语义 |
|---|---|---|
| `word_read` | `max_chars` 默认 200 000（上限同）；text/markdown 两模式同口径 | 文本超预算即 true，返回前缀 |
| `ppt_read` | `max_chars` 默认 200 000，跨全 deck；段落/备注按序截断，表格整体计入（放得下才带，否则丢弃并置 true） | 任一页有内容被截/丢即 true |
| `excel_read` | `max_rows` 默认 5 000/上限 10 000（每 sheet）；全 workbook 累计 200 000 格 | 每 sheet 各自标记 |
| 通用 | 读文件 ≤50 MiB（压缩后）；zip 声明预算 256 MiB/条目、512 MiB/整包、100 000 条目 | 超限直接拒绝（非截断） |

### 4.11 peer 依赖范围与发布工程（0.6.0）

- `@deepseek-ai/dsh-*` 的 peer 范围是 `^0.1.0-rc.6 || ^0.1.1-rc.0`。单写 `^0.1.0-rc.6` 时 node-semver 实测**不满足**运行时 0.1.1-rc.2（semver 规定预发布版本只能满足与其 [major.minor.patch] 元组相同的比较器），声明与宿主脱节；并集恰好覆盖 npm 上全部 0.1.x 稳定版与 rc、排除 0.1.2-alpha/0.2.0。0.1.2-rc 出现时按同法追加 `|| ^0.1.2-rc.0`；0.2.0 属破坏性变更，需另行评估。`cordis` 维持 `^4.0.1`（覆盖运行时 4.0.2）。
- devDependencies 经该范围解析到 0.1.1-rc.2，与 DSH 运行时同版本；`pnpm peers check` 对传递性 dsh peer（dsh-invariants 等）的 warning 是开发环境噪音——运行时由 DSH 完整提供同线版本，测试/typecheck 全绿即验证。
- 发布自动化：`.github/workflows/publish.yml` 由 GitHub Release（`published`）触发，先完整 `pnpm run check`，再 `npm publish --provenance`（OIDC `id-token: write`）；tag 非 `v*` 或与 `package.json` 版本不一致直接拒绝。CI（`ci.yml`）为 node 20/22 矩阵，对齐 `engines >= 20`。

### 4.12 Office 库去内联化与第三方商店字节上限（0.6.0）

- 背景：DSH Store（AI-Scarlett/DSH-Store，issue #334）的固定 Commit 自动审查对仓库提交的运行时文件设硬上限——单文件 ≤262,144 B（256 KiB）、总量 ≤2,097,152 B（2 MiB）；超限即"更新暂缓"。
- 实测排除了"保持内联"的一切变体：未压缩 `lib/index.js` 2,479,019 B；开 minify 后 1,319,961 B（总量可过 2 MiB，单文件仍超 5 倍）；xlsx 单模块压缩后仍 >256 KiB，而任何打包器都无法把一个模块拆进多个文件——**内联架构与单文件上限数学上不相容**。
- 方案：docx/jszip/pptxgenjs 移回 npm `dependencies`、xlsx 钉 CDN tarball URL，`lib/index.js` 只含自有代码（2,479,019 → 90,592 B；packed 550 kB → 31.8 kB）。这回到 0.1.0 的安装模型，推翻 0.2.0 的"tarball 零依赖自包含"性质：安装需联网拉 ~15–20 MB 依赖（含 cdn.sheetjs.com）。低风险依据：测试套件从来就是按非内联解析跑的（vitest 直接走 node_modules，bundle 只是发布产物），且 `lib/index.js` 纯 Node ESM 导入冒烟通过。
- jszip 范围维持 `^3.10.1`：zip 守卫读其私有 `_data.uncompressedSize`，未来版本若移除该字段，守卫按条目静默跳过（降级为 50 MiB 压缩上限兜底）而非崩溃，升级时按 ROADMAP 复核即可。
- 附带收益：`lib/index.js` 不再包含第三方库内部代码，Mimosa 类提交扫描对构建产物的误报面大幅缩小。

### 4.13 零依赖与官方 fs 通道架构（1.0.0）

- 背景（DSH Store #334 的后续三轮复检）：`source-verified` 条目的更新必须通过**完整**自动低风险策略——零 reason。字节上限 0.6.0 已过，剩余三个阻断是：`runtime or optional dependencies require a separate supply-chain review`（运行时依赖）、`runtime source contains the files permission signal`（`node:fs` 导入或 `readFile/writeFile/...(` 调用名）、`runtime source contains the commands permission signal`（`child_process` 导入或 `exec/spawn/...(`——**注意 `RegExp.prototype.exec(` 也会命中**，0.6.x 的正则用法即因此被判信号）。另有最新三版兼容窗口要求逐版本精确 `compatible` 声明。
- 官方通道：`@deepseek-ai/dsh-fs` 提供 `ctx.fs`（resolve/contains/stat/readBytes/writeText…）。读走 `readBytes`（二进制无碍）；写只有 UTF-8 `writeText`——这是硬约束，也是 1.0.0 全部架构的出发点。
- ASCII-safe STORE zip：生成的包每个字节 <=0x7F。槽位对齐规划器（`src/asciizip.ts`）把每个本地头放在 1 KiB 对齐处并跳过每 64 KiB 页的 `0x8000..0xBFFF` 偏移带（该带内偏移的字节永远不安全），部件内容用 XML 根元素后的合法尾随换行做填充重试，直至 CRC/大小字段全部字节安全；CD 大小用末条目注释 + CD extra 双自由度导向。曾尝试贪心 + 一级前瞻与 DFS 回溯，均会被"基址低字节 0x80 的进位互补"类死锁卡住或爆炸——槽位对齐让"下一偏移"与"本长度"彻底解耦，贪心一遍即成。
- 图片=链接（`a:blip r:link` + TargetMode=External）：包内零二进制字节，模型保留全部摆放自由度；PNG/JPG/GIF 头部嗅探（`src/imgsize.ts`）提供原图尺寸默认值；cover 用 `a:srcRect` 百分比裁剪。
- 读取兼容性：自研 zip 读取器解析 EOCD/CD，本地头按自身 nameLen/extraLen 定位切片，STORE 直读、DEFLATE 走 `node:zlib` 且以声明尺寸为膨胀上限——原 zip 炸弹守卫语义完整保留（条目/总量/条目数三预算 + DOCTYPE/ENTITY 拒绝 + 伪 zip 友好报错）。
- 本地门禁复检：`tests/store-gate-replica.mjs` 逐字复刻商店 `analyzeFixedSource` + `permissionSignals` 正则与全部边界，对工作树运行；1.0.0 固定源输出零 reason、零信号。兼容声明全部有实测：0.1.1-rc.2 / 0.1.2-alpha.4 / alpha.5 / rc.1 四条线的 `@deepseek-ai/*` devDeps 下 51/51 全绿。更新流程用商店自己的 `catalog-update-review.mjs` + `catalog-compatibility-policy.mjs` 模块本地仿真：`newer-version → 身份一致 → 更新写入 → 恢复 approved、清除下架原因、删除 managed candidate`。

## 5. 测试

`tests/tools.spec.ts`（14 例）+ `tests/zip-guard.spec.ts`（7 例，0.3.0）+ `tests/word-parity.spec.ts`（3 例，0.3.0）+ `tests/excel-formula.spec.ts`（7 例，0.4.0 写入 + 0.5.0 回读）+ `tests/word-update.spec.ts`（5 例，0.4.0）+ `tests/word-markdown.spec.ts`（6 例，0.5.0）+ `tests/ppt-read.spec.ts`（4 例，0.5.0）+ `tests/demo-trio.spec.ts`（1 例，0.6.0），合计 47 例（CI 口径），共享挂载器 `tests/harness.ts`：

- 8 个工具恰好注册一次；
- 所有 schema 通过 `assertSupportedJsonSchema`；
- 在真实 `ToolRuntime` 上注册成功；
- `enablePptTools: false` 只注册 6 个 Word/Excel 工具（含真实 ToolRuntime 验证与 Word/Excel 功能闭环）；
- Word/Excel/PPT 创建、读取、更新闭环；
- PPT 图片嵌入、缺失图片/错误扩展名报错；
- 工作区路径逃逸拒绝；
- 生成文件 ZIP 签名 `PK` 校验；
- zip 守卫：高压缩比包默认预算放行、注入小预算触发单条目/总量/条目数拒绝、伪 zip 友好报错、read 工具对伪 zip 拒绝、slide XML 带 DOCTYPE 拒绝；
- word golden 对拍：`word_create` fixture 与手工构造 docx（tab/br/两种连字符/hyperlink/空段/实体/表格/页眉脚注不泄漏）逐字节等于 mammoth 1.11.0 冻结输出；缺 `word/document.xml` 报错；
- word_update：追加段落/项目符号/表格后 `word_read` 全文逐字节校验、插入位置在 sectPr 之前且保留原包其它部件、XML 特殊字符转义、no-op/伪 zip/超上限拒绝、无 sectPr 文档兜底；
- Excel 公式：create/update 单元格/整表替换三条路径的产物含 `<f>`，普通字符串不误转；回读四态（无缓存→`=…`、有缓存→值、纯公式行保留、标量格式化与旧行为逐格一致）；
- word markdown：标题/嵌套 bullet/含 `|` 表格的精确输出、word_create fixture 的 markdown 全文、默认 format 与 golden 常量逐字节回归；
- ppt_read：表格结构化返回且不泄漏进 paragraphs、表格超预算丢弃并置 truncated、图片 descr 解码与文档序、pptxgenjs deck 的 alt=源路径；
- 三件套（0.6.0）：单会话 word_create + excel_create（公式）+ ppt_create（备注）生成 report.docx / budget.xlsx / deck.pptx，三件均 `PK` 签名，回读断言 markdown 标题与表格、`=SUM(B2:B4)` 公式串、页数与 notes——README Demo 的可执行形态。

## 6. 发布与生态状态

| 项 | 状态 |
|---|---|
| GitHub | <https://github.com/kw78/dsh-office-tools> |
| npm | `dsh-office-tools@0.2.0`；0.3.0–0.5.0 滞留 GitHub 未发 npm（手工发布缺口），0.6.0 起由 `publish.yml` 自动发布（Release 触发 + provenance），跨版本内容见 CHANGELOG |
| topics | `dsh`, `dsh-plugin`, `deepseek-harness`, `office` 等 |
| CI | GitHub Actions `pnpm run check`，node 20/22 矩阵（0.6.0），全绿 |
| tag | `v0.1.0` ~ `v0.5.0` |
| awesome-dsh-plugin | PR #405 已合并 |
| dsh-market | 随 awesome 列表同步 |
| dsh-hub / Atlas | 未收录，候选 entry 在 `docs/hub-registration.md`（0.6.0 已刷新，提交动作待维护者） |
| DSH Store (AI-Scarlett) | 自动收录于 0.1.0；0.5.0 更新因运行时字节上限暂缓（#334）；0.6.0 去内联化后达标（单文件 90.6 kB / 总量 101.6 kB），推送后等其 8 小时周期自动复检 |

## 7. 安装方式

```bash
# npm（推荐）
dsh plugin --profile web add dsh-office-tools

# GitHub 源码
dsh plugin --profile web add github:kw78/dsh-office-tools
```

安装后重启 DSH。host 插件不会热加载。

## 8. 已知问题与风险

1. ~~`xlsx@0.18.5` 的 CVE-2023-30533 / CVE-2024-22363~~：0.2.0 起已迁移至 SheetJS 官方 CDN 0.20.3 tarball，且仅作构建期依赖（内联进 bundle，运行时不解析）。
2. ~~zip 炸弹面~~：0.3.0 起读路径全部经 `loadZipGuarded` 预检声明大小（256 MiB/条目、512 MiB/整包、100 000 条目），见 4.2。残余面：central directory 声明造假的 zip（声明小、实际膨胀大）不在声明预算内——jszip 解压结束时会因 `uncompressed data size mismatch` 报错，但内存峰值在报错前已发生；50 MiB 压缩上限把最坏情形约束在可控量级。
3. `excel_read` / `excel_update` 把整个 buffer 交给 SheetJS，无法逐部件做 DTD 检查；SheetJS 自带解析器不做实体展开/外部实体。
4. `excel_update` 会由 SheetJS 重写工作簿，图表、宏等高级特性可能丢失。
5. 不支持旧 OLE 格式 `.doc/.xls/.ppt`。
6. `ppt_read` 只提取文本和图片数量，不解析表格、SmartArt、图片内容。
7. Word 有 `word_update` 追加能力（0.4.0），但仍没有原位编辑/删除/模板替换；PPT 没有更新能力。
8. npm 的 `@deepseek-ai/*` 为 optional peerDependencies；裸环境 import 会失败是预期的，必须在 DSH profile 内加载。
9. 当前机器上 web profile 已通过 link 接入插件，但运行中的 DSH 进程未重启时不会加载新 host 插件。

## 9. 改进路线建议

版本化的路线与取舍记录见 [docs/ROADMAP.md](ROADMAP.md)（0.5.0 读取增强、0.6.0 工程化与生态、远期候选）。历史上的候选清单：

- 支持 `.doc/.xls/.ppt` 降级读取或 LibreOffice 转换；
- 增加 `excel_format`（条件格式、列宽、图表）能力；
- 增加 `word_update`（模板替换、追加段落）；
- 增加 `ppt_update`（向现有 deck 追加 slide）；
- 读取工具返回结构化 markdown/HTML，而非纯文本；
- 增加 PDF 工具，把 Office 文档导出 PDF；
- 给每个工具加 `presentCall/presentResult` 文件位置定位；
- 补充 npm publish / GitHub release 的自动化 workflow。

## 10. 维护者操作手册

### 10.1 改代码

```bash
pnpm run check     # 必须全绿
git add -A
git commit -m "fix: ..."
git push
```

### 10.2 发布新版本（0.6.0 起：Release 触发 + provenance）

一次性前置（仅首次）：

1. npm 侧：确认账号对 `dsh-office-tools` 允许 provenance；
2. GitHub 仓库 Settings → Secrets：配置 `NPM_TOKEN`（granular、仅 publish 该包）。

每次发版：

```bash
pnpm run check     # 必须全绿（版本号、CHANGELOG 已就位）
git add -A && git commit -m "release: v0.x.y" && git push
git tag vx.y.z && git push --follow-tags
# 在 GitHub 上基于该 tag 创建并发布 Release → publish.yml 自动 check + npm publish --provenance
```

工作流自带门禁：tag 非 `v*`、tag 与 `package.json` 版本不一致、或 check 失败都会拒绝发布；发布失败时删除 Release 修正后重发即可。0.3.0–0.5.0 未上 npm 的历史缺口自此闭合（首个经工作流发布的版本为 0.6.0）。

### 10.3 验证插件真实执行

使用 `tests/tools.spec.ts` 或真实 profile：

```bash
# 在 DSH web profile 重启后，模型直接调用工具即可
```

## 11. 安全注意事项

- 不要在仓库、文档、日志中提交 npm/GitHub token；
- 已用于发布的两个 npm token 应尽快在 npm 后台 revoke；
- 工具本身只访问会话工作区，但插件代码运行在用户权限下，发布前请再次 review 依赖。
