# dsh-office-tools

[![npm version](https://img.shields.io/npm/v/dsh-office-tools)](https://www.npmjs.com/package/dsh-office-tools) [![ci](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![已收录于 awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> 安装：`dsh plugin --profile web add github:kw78/dsh-office-tools`

为 DeepSeek Harness 提供 8 个模型可调用的 Office 文件工具，全部运行在 host 半 —— 1.0.0 起零运行时依赖：所有文件由插件自带的 OOXML 引擎生成与解析，所有字节都经由官方文件服务 `ctx.fs` 传输，插件自身不直接触碰文件系统。

| 工具 | 作用 |
|---|---|
| `word_create` | 创建 `.docx`（标题、段落、项目符号、一个表格） |
| `word_read` | 提取任意 `.docx` 的文本；`format: "markdown"` 结构化渲染标题/列表/表格 |
| `word_update` | 向现有 `.docx` 追加段落、项目符号和/或一个表格 |
| `excel_create` | 创建多 sheet 的 `.xlsx`（标量单元格网格） |
| `excel_read` | 读取一个或全部 sheet 为标量行；公式返回缓存值或 `'=…'` 公式串 |
| `excel_update` | 就地替换/新建整张 sheet，或按 A1 地址写单元格 |
| `ppt_create` | 创建 16:9 `.pptx`（标题页、标题、段落、项目符号、备注、链接式 PNG/JPG/GIF 图片），并回显每个元素的落点坐标 |
| `ppt_read` | 按页提取段落、表格、演讲者备注、图片数量、alt 文本 —— 外加每个形状的英寸包围盒与文本线框图 |

以 `=` 开头的字符串单元格会写成真正的 Excel 公式（Excel 打开时计算）。

## 演示

一句话，季度报告三件套 —— 带指标表的 Word、带 `=SUM`/差异公式的 Excel、带演讲者备注的 PowerPoint：

<img src="docs/demo/session.svg" alt="一句话生成 report.docx、budget.xlsx、deck.pptx" width="780">

上图会话用的提示词：

> 生成 Q3 季度报告三件套：`report.docx`（标题、两段摘要、三个要点、一张指标表）、`budget.xlsx`（Budget sheet 含 `=SUM` 合计与计划/实际差异公式，再加一个 Summary sheet）、`deck.pptx`（标题页 + 3 页正文，含演讲者备注）。

模型会把它拆成 `word_create` → `excel_create` → `ppt_create`（回读走 `word_read` / `excel_read` / `ppt_read`；新写入的公式在被 Excel 计算缓存前以 `'=…'` 串回读）。整个流程由 `tests/demo-trio.spec.ts` 钉死，演示不会与工具行为漂移；图中的体积数字来自该测试场景的一次真实运行。

## 框架接入方式

插件遵循 DSH 标准 host 插件契约：

- 模块导出 `name` / `inject` / `apply` / `Config`；本插件 `inject = ['tools', 'fs']`——官方工具注册表与官方文件服务（`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-fs`）是仅有的运行时服务依赖。
- `apply(ctx)` 中用 `ctx.effect(() => ...)` 包裹 `ctx.tools.register(defineTool({...}))`，Cordis fiber 卸载时自动 dispose。
- `defineTool` 统一声明 `parameters`（模型可见 JSON Schema）、`output.schema`（强制校验的规范 JSON 值）与 `output.render`（模型看到的文本投影）。
- 每个 `execute(args, exec)` 从 `exec.agent.session.header.cwd` 取会话工作目录；相对路径按该目录解析，绝对路径只接受仍位于工作目录内的路径。containment 与符号链接解析由 `ctx.fs` 后端权威执行（本插件再做一道词法预检）。
- 读经 `ctx.fs.readBytes` 以原始字节到达；写经 `ctx.fs.writeText` 以 UTF-8 文本离开（后端原子落盘）；`overwrite` 默认 `false`，防止误覆盖。
- 生成的包是纯 ASCII 的 STORE 型 zip：规划器为每个 XML 部件做尾部换行填充并做 1 KiB 槽位对齐（跳过每 64 KiB 页的不安全偏移带），使 CRC/大小/偏移字段全部字节安全——这正是真实 Office 文件能以字节一致方式通过官方文本通道的原因。非 ASCII 文本编码为 XML 字符引用。
- 读取接受任意真实包（STORE/DEFLATE，含 zip 炸弹防御）；`word_update`/`excel_update` 适用于全文本部件的包，携带二进制媒体的包会被明确拒绝。
- 图片为链接式：模型完全掌控摆放（x/y/w/h 英寸、contain/cover、alt；PNG/JPG/GIF 头部嗅探出原图尺寸），deck 引用 workspace 图片文件；`ppt_create` 结果回显全部元素落点（英寸坐标 + 画布尺寸 + 每页文本线框图），`ppt_read` 对任意 deck 返回同样的几何信息。

## 构建

```bash
pnpm install
pnpm run check   # typecheck + tests + build
```

构建产物：`lib/index.js`（ESM host bundle，仅打包本插件自有代码——约 116 kB，零运行时依赖）与 `lib/types/**/*.d.ts`；所有 `@deepseek-ai/*`（cordis、dsh 服务、schemastery）保持 external，由 profile 的 node_modules 提供。

## 安装

```bash
# npm（推荐）
dsh plugin --profile web add dsh-office-tools

# GitHub 源码
dsh plugin --profile web add github:kw78/dsh-office-tools

# 本地目录
dsh plugin --profile web add /path/to/dsh-office-tools
```

安装后重启 DSH 服务。模型下一次组装提示词时即可看到 8 个工具。1.0.0 起插件零运行时依赖——不联网、不拉 CDN、无安装脚本，安装即固定源码本身。宿主需提供 `fs` 服务（凡是带内置 read/write 工具的 DSH profile 都有）。

## 配置

插件通过 schemastery 声明 `Config`，由 Loader 在加载时校验。当前只有一个选项：

| 选项 | 类型 | 默认值 | 作用 |
|---|---|---|---|
| `enablePptTools` | boolean | `true` | 注册 `ppt_create` / `ppt_read`。设为 `false` 时本插件只提供 Word/Excel 工具。 |

`enablePptTools: false` 为共存而生：dsh-ppt 等专注演示文稿的插件同样会注册 `ppt_create`，而 DSH 在启动时拒绝同名工具（`tool "ppt_create" is already registered`）。关掉本插件的 PPT 工具对，把演示文稿交给专用插件：

```yaml
# profile 的 cordis.patch.yml
- insert:
    - id: dsh-office-tools
      config:
        enablePptTools: false
```

## 社区索引

- awesome-dsh-plugin / dsh-market 的登记块见 [docs/hub-registration.md](docs/hub-registration.md)。
- 仓库 topics 建议：`dsh`、`dsh-plugin`、`deepseek-harness`、`office`。

## 安全边界

- 所有读写都限制在发起调用的 agent 的会话工作目录内。
- 读取文件上限 50 MiB（压缩后体积）；解压前先校验压缩包自身声明的大小预算（单条目 ≤256 MiB、整包 ≤512 MiB、条目数 ≤100 000），zip 炸弹会被直接拒绝而不是解压；携带 DOCTYPE/ENTITY 声明的 XML 部件一律拒绝。
- 文本/单元格结果有上限并标记 `truncated`。
- 创建/更新有行数、单元格数上限，且默认不覆盖已有文件。
- 不调用 LibreOffice / PowerPoint / Word 等外部进程，所有格式均通过纯 JS 库生成/解析。
- 插件自身代码零文件系统直接访问——`src/` 中没有任何 `node:fs` 导入，所有字节经官方、用户可见的 `ctx.fs` 服务流动。这让第三方商店自动化可以确定性核验全部运行时源码（DSH Store #334：1.0.0 通过完整的自动低风险策略——零运行时依赖、零文件/网络/命令/凭据信号、有界源码、逐版本精确兼容声明）。
- 生成的包是纯 ASCII 的 STORE 型 zip（规划器为每个 XML 部件做尾部填充并做槽位对齐，让 CRC/大小/偏移字段全部字节安全），因此能以字节一致的方式通过官方 UTF-8 文本通道落盘；非 ASCII 文本编码为 XML 字符引用，各 Office 套件均可正常打开。
- `word_update`/`excel_update` 经文本通道重发布：适用于全部部件均为文本的包（本插件生成的文件必然满足；不含二进制媒体的 OOXML 包也满足），携带二进制媒体（内嵌图片/字体）的包会被明确拒绝而非损坏。
- 图片为链接式（非内嵌）：模型完全掌控摆放（英寸坐标 x/y/w/h、contain/cover 裁剪、alt 文本；PNG/JPG/GIF 文件头会被嗅探，省略尺寸时按原图大小），deck 引用 workspace 中的图片文件——移动 deck 时请连同图片文件，这是零二进制包的取舍。
- 版本路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。
