# v0.6.0 规格说明「工程化与生态」

> 依据 [docs/ROADMAP.md](ROADMAP.md) v0.6.0 规划与 0.5.0 发布后的实测现状撰写。本文是 0.6.0 的需求分析与实施规格,实施结果以 CHANGELOG 与本文「验收」节为准。

## 1. 需求分析(现状证据 → 需求)

ROADMAP 为 v0.6.0 列了六项需求。逐项核实当前状态:

| # | 需求(ROADMAP 原文) | 现状实测(2026-09-01) | 结论 |
|---|---|---|---|
| R1 | README 演示 GIF + 示例 prompt("一句话生成季度报告三件套") | README 无演示章节;仅本机未跟踪的 `tests/demo-integration.spec.ts` 覆盖过 demo 文件 | 需要在仓库内落地:示例 prompt + 可渲染演示图 + 可跟踪的集成测试 |
| R2 | CI 矩阵 node 20/22 | `ci.yml` 只测 node 22;`engines` 声称 `>=20` | 声称与验证脱节,需矩阵化 |
| R3 | npm provenance + 发布工作流 | npm 上 `latest = 0.2.0`,GitHub 已到 0.5.0——0.3.0/0.4.0/0.5.0 三版只发 GitHub 未发 npm;发布是纯手工(`DEVELOPMENT.md` §10.2),且历史上两个 npm token 已因进 shell 历史需 revoke(§11) | 手工发布是发布滞后与 token 卫生问题的共同根因;需要 GitHub Actions OIDC 发布 + `--provenance` |
| R4 | dsh-hub / Atlas 提交 | 材料在 `docs/hub-registration.md`,版本停在 0.1.0,一直未提交 | 仓库内能做的是把材料刷新到 0.6.0 并补 provenance 事实;实际提交需维护者账号,属仓库外动作 |
| R5 | peer 依赖实测刷新 | 本机 DSH 运行时 = `dsh 0.1.1-rc.2`(`@deepseek-ai/dsh-tools` 0.1.1-rc.2、cordis 4.0.2);插件声明 `^0.1.0-rc.6`。用 node-semver 实测:`semver.satisfies('0.1.1-rc.2', '^0.1.0-rc.6') === false`——semver 规定预发布版本只能满足与其 [major.minor.patch] 元组相同的比较器,`^0.1.0-rc.6` 只认 0.1.0 元组的预发布。**当前声明与运行时不匹配**。cordis `^4.0.1` 覆盖 4.0.2,无需改 | 需要放宽四个 `dsh-*` 范围 |
| R6 | 开关泛化 `enableWordTools`/`enableExcelTools`(可选) | ROADMAP 自身条件:「仅当有用户提出同类共存需求再做」;尚无用户提出 | 本版不做,决策记录在案 |
| R7 | DSH Store(AI-Scarlett)字节上限(0.6.0 追加) | 其 #334 自动审查:提交的运行时文件单文件 ≤262,144 B、总量 ≤2,097,152 B,超限即更新暂缓;我们内联架构的 `lib/index.js` 2,479,019 B 单文件超 8.4 倍 | 去内联化:Office 库移回 `dependencies`,`lib/index.js` 只含自有代码 |

另按 ROADMAP「持续卫生」核对(2026-09-01):SheetJS CDN 仍以 0.20.3 为最新(0.20.5 tarball 404);docx 9.7.1 / jszip 3.10.1 / pptxgenjs 4.0.1 均为 npm 最新且与 lockfile 一致——依赖无需升级。

## 2. 目标与非目标

**目标**

1. R1–R5 全部在仓库内落地;`pnpm run check` 全绿。
2. 发布路径从「手工 npm publish + 长期 token」变为「GitHub Release 触发 + OIDC provenance」,token 面收缩到(可撤销的)单 secret,包页带构建来源。
3. peer 声明重新覆盖实际运行时(0.1.1-rc.2),且本地测试改跑在与运行时一致的依赖版本上。

**非目标(明确不做)**

- `ppt_update`、PDF 导出、OLE 旧格式、`word_update` 模板替换——远期候选,见 ROADMAP。
- 开关泛化(R6):无用户需求,不做;`enablePptTools` 保持唯一开关。
- dsh-hub / Atlas 的实际提交:需要维护者在外部仓库操作,本版只交付刷新后的材料与步骤。
- 真正录屏 GIF:需要一次真实的终端录制会话(模型侧无法代录);本版交付等价的 SVG 演示图,GIF 作为后续可选增强。

## 3. 设计

### 3.1 CI 矩阵(R2)

`ci.yml` 的 `test` job 增加 `strategy.matrix.node-version: [20, 22]`(`fail-fast: false`,一个版本挂了不影响另一个的报告)。选 20/22 而非更多:`engines` 只声称 `>=20`,20 是声称的下限(必须测),22 是当前开发/运行版本(必须测);再往上(24)未声称,不测。缓存键 pnpm 已由 `cache: pnpm` 处理,矩阵下天然按 job 隔离。

### 3.2 发布工作流(R3)

新增 `.github/workflows/publish.yml`:

- **触发**:`release: types: [published]`。发布动作收敛为「打 tag + 建 GitHub Release」,与 ROADMAP 0.3.0 起的发版流程(tag → publish → Release)对齐,且 Release 草稿可见、可回滚(删 Release 重发)。
- **权限**:`contents: read` + `id-token: write`(provenance 的 OIDC 令牌)。
- **版本一致性门禁**:job 内校验 `package.json` 的 `version` 与 Release tag(`v*` 前缀)严格相等,不等即 fail——防止「tag v0.6.0 发出 0.5.0 的包」这类错位;tag 不匹配 `v*` 直接拒绝。
- **质量门禁**:发布前完整跑 `pnpm install --frozen-lockfile` + `pnpm run check`(typecheck + 全部测试 + build),绿了才 publish——与本地纪律一致。
- **发布**:`npm publish --provenance`(node 22 自带 npm ≥10,满足 provenance 要求;`publishConfig.access: public` 已就绪)。认证用 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`,只需一个 granular publish token,配合 provenance 后包页显示构建来源徽章。
- **前置条件(文档化,不在 yaml 内)**:npm 侧把 `kw78` 账号对该包开启 provenance;GitHub 仓库配 `NPM_TOKEN` secret。这两步是维护者一次性动作,写进 DEVELOPMENT.md §10.2。

不采用 push tag 触发:tag 可重打而 Release 是显式的发布意图;不采用 `workflow_dispatch`:缺 audit trail。

### 3.3 peer 依赖放宽(R5)

- 四个 `@deepseek-ai/dsh-*` 的 `peerDependencies` 与 `devDependencies` 从 `^0.1.0-rc.6` 放宽为 **`^0.1.0-rc.6 || ^0.1.1-rc.0`**。
- 依据(实测,semver 规则):该并集恰好覆盖 `0.1.0-rc.6/7/8`、`0.1.0`、`0.1.1-rc.*`、`0.1.1`(npm 上现存的 0.1.x 全部稳定版与 rc),且**排除** `0.1.2-alpha.*` 与 `0.2.0`(次版本不自动兼容)。备选方案逐一否决:`>=0.1.0-rc.6 <0.2.0` 实测不满足 0.1.1-rc.2(同样的预发布元组规则);单写 `^0.1.1-rc.0` 会丢掉 0.1.0 稳定版宿主。
- cordis 维持 `^4.0.1`(实测覆盖运行时 4.0.2;抬高下限反而伤害 4.0.1 宿主)。
- `devDependencies` 同步放宽后 lockfile 解析到 0.1.1-rc.2(npm 上满足范围的最高稳定候选),本地 typecheck/测试从此与真实运行时同版本——这本身就是 R5 要的「实测」的持续化。
- 后续 0.1.2-rc 出现时按同一手法追加 `|| ^0.1.2-rc.0`;升级到 0.2.0 是破坏性变更,走 minor 以上版本另评。

### 3.4 演示:示例 prompt + SVG + 三件套测试(R1)

三件套(README 章节 `Demo` / `演示`、双语对齐):

1. **示例 prompt**(README 内嵌,可直接复制):

   > 用 dsh-office-tools 生成 Q3 季度报告三件套:`report.docx`(标题、两段摘要、三个要点、一张指标表)、`budget.xlsx`(Budget/Summary 两个 sheet,Budget 含 =SUM 与 =B2/B5 占比公式)、`deck.pptx`(标题页 + 3 页正文,含演讲者备注)。

   并列出模型实际会走的工具序列(word_create → excel_create → ppt_create)与产物要点。
2. **演示图** `docs/demo/session.svg`:终端风格卡片(暗底、提示符、逐行工具调用与产物体积、绿色对勾),README 以 `<img>` 引用。SVG 是静态矢量、GitHub 原生渲染、无脚本依赖(经 camo 代理安全),是 GIF 的可维护替身;数据来自 3 的真实运行输出,不是虚构截图。
3. **集成测试** `tests/demo-trio.spec.ts`(仓库内、无绝对路径,替代本机专属 demo 测试在 CI 里的空缺):一次挂载后依次 `word_create`/`excel_create`(带公式)/`ppt_create`(带备注),随后三件全部回读断言——word_read markdown 含标题层级与表格、excel_read 回读 `=SUM(B2:B4)` 公式串(无缓存值语义,0.5.0)、ppt_read 回读页数与 notes;三件产物均为 `PK` zip 签名。README 的演示主张从此有测试钉住。

### 3.5 hub 材料刷新(R4 仓库内部分)

`docs/hub-registration.md`:`version` 0.1.0 → 0.6.0;`risk.facts` 补 `provenance: true` 与 `ciMatrix: node 20/22`;维护者步骤补「先发 npm(经 publish.yml),Registry 条目以 npm 版本为准」。实际提交动作(Atlas 建条目 → `registry:vendor` → PR)不变,仍由维护者执行。

### 3.6 DSH Store 字节上限(R7,0.6.0 追加)

- **实测排除内联变体**:未压缩 `lib/index.js` 2,479,019 B;esbuild minify 后 1,319,961 B——总量可过 2 MiB 但单文件仍超 256 KiB 达 5 倍;xlsx 单模块压缩后即超 256 KiB,任何打包器都不能把一个模块拆进多个文件,故**内联架构与单文件上限数学上不相容**,压缩/拆分路线整体死亡。
- **方案**:docx/jszip/pptxgenjs 移回 npm `dependencies`,xlsx 保持 CDN 0.20.3 tarball URL 依赖;`build.mjs` 把四库 external 化并删除为内联 xlsx 服务的 `createRequire` banner;`lib/index.js` 只含自有代码 + schemastery。
- **风险控制**:测试套件本就按非内联解析运行(vitest 直接走 node_modules,bundle 只是发布产物),等于运行时依赖模式已被 55 例全量验证;另做纯 Node ESM `import` 冒烟(external 依赖真实解析)。jszip 维持 `^3.10.1`——守卫读的 `_data` 字段若在未来版本消失,行为是按条目静默跳过(降级为 50 MiB 压缩上限)而非崩溃。
- **代价**:推翻 0.2.0「tarball 零依赖自包含」性质,安装需联网拉 ~15–20 MB 依赖(含 cdn.sheetjs.com,当前网络实测可达);npm 包 550 kB → 31.8 kB。

### 3.7 版本化与文档同步

- `package.json` + `dsh.plugin.json` → `0.6.0`;CHANGELOG 新增 0.6.0(Added: 发布工作流/CI 矩阵/演示章节+trio 测试;Changed: peer 放宽附实测依据;Docs: hub 材料)。
- ROADMAP 0.6.0 节标记已实施,记录与原规划的偏差(GIF→SVG、hub 提交仍待外部动作、R6 维持不做)。
- DEVELOPMENT.md:§6 生态状态表更新(npm 由 workflow 发、provenance);§10.2 发布手册改为 Release 触发流程 + 前置条件;§4 增补 peer 范围语义说明。
- AGENTS.md(本机,不提交)同步。

## 4. 验收标准

1. `pnpm run check` 全绿(typecheck + 测试 + build);跟踪套件由 46 例增至 47 例(+trio),本机另跑未跟踪的 demo 集成 8 例(合计 55)也全绿。
2. `node_modules/@deepseek-ai/dsh-tools` 实装 0.1.1-rc.2 且 `semver.satisfies` 对四个 dsh-* peer 范围为 true——peer 声明重新覆盖运行时。
3. `ci.yml` 含 node 20/22 矩阵;`publish.yml` 通过 YAML 解析,权限块含 `id-token: write`,版本门禁与 check 步骤齐备(实际触发待维护者配置 secret 后首次验证)。
4. README 双语均含 Demo 章节与 SVG 引用;`docs/demo/session.svg` 存在且被两份 README 引用;`tests/demo-trio.spec.ts` 进仓库并通过。
5. `hub-registration.md` 条目版本 = 0.6.0。
6. `package.json`、`dsh.plugin.json`、CHANGELOG 三处版本一致 = 0.6.0;`lib/` 由本次源码状态重建。
7. 运行时文件满足 DSH Store 上限(实测):最大 `.js` = 90,592 B ≤ 262,144;`lib/` 内 js+d.ts 总量 = 101,588 B ≤ 2,097,152;`node --input-type=module` 导入 `lib/index.js` 冒烟通过(name/inject/apply/Config 均可解析)。
8. 发版卫生四文档(CHANGELOG/README/DEVELOPMENT/AGENTS)同步完成。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| devDeps 升到 0.1.1-rc.2 后 API/类型不兼容 | `pnpm run check` 全绿即证明兼容;不兼容则记录差异并在 spec/CHANGELOG 降级处理 |
| publish.yml 首次运行才暴露配置问题(secret 未配、npm 侧 provenance 未开) | yaml 内步骤保持最小、无外部 action 依赖;前置条件写进 DEVELOPMENT.md 清单;Release 可删除重发,可重试 |
| SVG 演示图与真实输出漂移 | 图内数字取自 trio 测试的一次真实运行;trio 测试进 CI,行为漂移会在图失效前先红 |
| peer 放宽后宿主解析到未测过的 0.1.1-rc.1 | devDeps/lockfile 固定 0.1.1-rc.2(实测版本);0.1.1-rc.1 与 rc.2 同线,风险接受 |
| npm 端 0.2.0 → 0.6.0 跨版本发布 | 语义化版本允许;CHANGELOG 0.3.0–0.5.0 记录完整,发布说明引用之 |
