# dsh-office-tools

[![npm version](https://img.shields.io/npm/v/dsh-office-tools)](https://www.npmjs.com/package/dsh-office-tools) [![ci](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/kw78/dsh-office-tools/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![已收录于 awesome-dsh-plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

> **如果你觉得本项目好用的话，请给个 ⭐ Star —— 谢谢！**

为 DeepSeek Harness 提供 8 个模型可调用的 Office 文件工具：在会话工作区内创建、读取、更新 Word（`.docx`）、Excel（`.xlsx`）、PowerPoint（`.pptx`）。零运行时依赖 —— 文件由插件自带的 OOXML 引擎生成与解析，所有字节都经官方 `ctx.fs` 服务传输。

**边界：** 这是文件生成器，不是编辑器。它创建文件并追加内容（`word_update` 只追加；没有 `ppt_update`），`word_create` 与每次 `word_update` 最多写入一张表；PPT 图片是**链接式**而非内嵌，因为工作区写入通道只支持文本。

## 工具

| 工具 | 作用 |
|---|---|
| `word_create` | 创建 `.docx`（标题、段落、项目符号、一个表格） |
| `word_read` | 提取文本；`format: "markdown"` 结构化渲染 |
| `word_update` | 向现有文档追加段落、项目符号和/或表格 |
| `excel_create` | 创建多 sheet 的 `.xlsx` |
| `excel_read` | 读取 sheet 为行；公式返回缓存值或 `'=…'` 串 |
| `excel_update` | 替换/新建整张 sheet，或按 A1 地址写单元格 |
| `ppt_create` | 创建 16:9 `.pptx`（幻灯片、要点、备注、链接式图片） |
| `ppt_read` | 提取文本、备注、表格与每个形状的几何信息 |

以 `=` 开头的字符串单元格会写成真正的 Excel 公式。

## 演示

一句话，季度报告三件套：

<img src="docs/demo/session.svg" alt="一句话生成 report.docx、budget.xlsx、deck.pptx" width="780">

## 定位

这是无界面的 OOXML 工具箱，不是可视化办公套件：解包后约 160 KB，零运行时 npm 依赖（全部打包进产物），没有本地服务、不需要浏览器、不收集遥测。所有写入都经 DSH 文件系统服务，因此桌面会话与 CI 中的行为完全一致。

| | dsh-office-tools | 可视化办公套件（如基于 Univer 的插件） |
|---|---|---|
| 产物 | 标准 `.docx` / `.xlsx` / `.pptx` 文件 | 原生文档模型，再导出为 Office 格式 |
| 运行时 | 仅需 Node ≥ 20 | 本地网关服务 + 无头 Chromium |
| 安装体积 | 解包约 160 KB | 数百 MB |
| 审阅方式 | 工具结果、Markdown、线框图 | 实时画布预览与审批卡片 |

需要逐处查看、逐项批准修改时选可视化套件；需要 agent 批量产出标准 Office 文件、不想引入额外运行时，选本插件。

## 安装

```bash
dsh plugin --profile web add dsh-office-tools              # npm（推荐）
dsh plugin --profile web add github:kw78/dsh-office-tools  # 源码
```

安装后重启 DSH。宿主需提供 `fs` 服务（凡带内置 read/write 工具的 profile 都有）。

## 注意事项

- 所有路径限制在会话工作目录内；`overwrite` 默认 `false`。
- 读取接受任意真实包（STORE/DEFLATE），带 zip 炸弹防御；更新遇到含二进制部件的包会明确拒绝而非损坏它。
- PPT 图片为**链接式**（非内嵌）：官方 `ctx.fs` 写入通道只支持 UTF-8 文本，包内无法携带二进制图片部件。移动 deck 时请连同图片文件；另注意 PowerPoint 默认阻止外部内容——链接图片会显示为"已阻止自动下载此图片"占位符，需手动启用外部内容（文件 → 信息 → 启用内容，或把目录加入信任中心的可信位置）后才会显示。这是 PowerPoint 的安全策略，不是包结构缺陷。
- `ppt_create` 回显每个元素的落点坐标；`ppt_read` 对任意 deck 返回同样的几何信息。

## 配置

只有一个选项：`enablePptTools`（默认 `true`）——与 dsh-ppt 等专用演示插件共存时设为 `false`：

```yaml
- insert:
    - id: dsh-office-tools
      config:
        enablePptTools: false
```

## 开发

```bash
pnpm install && pnpm run check   # typecheck + tests + build
pnpm run test:e2e                # 真实组合 E2E（sandbox-policy + fs-sandbox + tools）
```

<!-- compatibility:start -->
兼容性：`^0.1.0-rc.6 || ^0.1.1-rc.0 || ^0.1.2-alpha.0 || ^0.1.5-alpha.0 || ^0.2.0-rc.1 || ^0.2.1-rc.3`；逐版本的实测记录见 `package.json`（`dsh.compatibility.dshReleases`）。CI 验证 0.1.2-rc.1、0.2.0-rc.1、0.2.1-rc.3，尚未声明支持 DSH 0.3.x。
<!-- compatibility:end -->

生成文件最多 50 MiB；PPT 最多 200 页（包含可选封面）。图片仍为外部链接。分层架构与真实图片嵌入的迁移方案见 [架构分析](docs/ARCHITECTURE.zh.md)。

更多文档：[DEVELOPMENT.md](docs/DEVELOPMENT.md) · [ROADMAP.md](docs/ROADMAP.md) · [hub-registration.md](docs/hub-registration.md) · MIT [License](LICENSE)
