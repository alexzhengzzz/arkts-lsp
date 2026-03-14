# ArkTS Analyzer MCP Server

一个基于 TypeScript 的 ArkTS 分析与工作区索引服务，提供 17 个只读 MCP 工具，既支持单文件语义分析，也支持面向仓库的符号检索、依赖追踪、上下文摘要和源码证据提取。

## 能力概览

- 解析 ArkTS 组件与装饰器成员，识别 `@Entry`、`@Component`、`@State`、`@Prop`、`@Watch` 等结构。
- 收集词法、语法、语义诊断，并过滤 ArkTS 内建装饰器带来的噪声。
- 提供定义、类型定义、实现、引用、hover、文档符号等语言能力。
- 构建可持久化的工作区快照，用于文件摘要、符号搜索、相关文件聚合和依赖图追踪。
- 区分 summary 型结果与 source 型证据结果，支持带行号范围的源码片段提取。
- 支持 in-memory overlays，适合编辑器或 agent 在未落盘内容上做分析。

## 工具分组

### 单文件分析

- `arkts_analyze_components`
- `arkts_get_diagnostics`
- `arkts_find_definition`

### 工作区索引与上下文

- `arkts_workspace_overview`
- `arkts_summarize_file`
- `arkts_find_symbol`
- `arkts_get_related_files`
- `arkts_explain_module`
- `arkts_trace_dependencies`
- `arkts_refresh_workspace`

### 源码证据

- `arkts_read_source_excerpt`
- `arkts_get_evidence_context`

### 语言服务查询

- `arkts_hover`
- `arkts_find_references`
- `arkts_find_implementation`
- `arkts_find_type_definition`
- `arkts_document_symbols`

## 仓库结构

- `src/index.ts`: 包导出入口。
- `src/mcp-server.ts`: MCP stdio server 与 17 个工具注册。
- `src/build-workspace-index.ts`: 本地一次性触发工作区索引构建的 CLI。
- `src/core/arkts-analyzer.ts`: 单文件 ArkTS 分析核心。
- `src/core/compiler-host.ts`: TypeScript compiler host / language service host 适配。
- `src/core/arkts-language.ts`: ArkTS 装饰器和内建语义定义。
- `src/workspace/workspace-service.ts`: 工作区扫描、快照缓存、符号索引、依赖追踪。
- `src/workspace/types.ts`: 对外结果类型定义。
- `test/*.test.mjs`: MCP server 与 workspace service 的回归测试。
- `test/fixtures/sample_test`: 用于集成测试的最小 ArkTS 工作区。

## 环境要求

- Node.js `>= 20`
- npm

## 开发与运行

```bash
npm install
npm run build
npm run start:mcp
npm run workspace:index -- .
```

常用命令：

```bash
npm run check
npm test
npm run clean
npm run workspace:index -- /absolute/path/to/workspace
```

`start:mcp` 会通过 stdio 启动 `dist/mcp-server.js`，因此首次运行前需要先执行 `npm run build`。
`workspace:index` 会为目标目录执行一次工作区初始化并立刻 `refresh()`，用来快速触发全仓索引构建或增量刷新；默认目标目录是当前工作目录，也支持 `--json`、`--verbose`、`--cache-dir`、`--max-files`、`--freshness`。其中 `--verbose` 会把阶段日志、已发现文件数和索引进度输出到 `stderr`。

### 建索引命令示例

```bash
# 对当前仓库触发一次索引构建/刷新
npm run workspace:index -- .

# 对指定目录触发一次索引构建/刷新，并输出 JSON
npm run workspace:index -- /absolute/path/to/workspace --json

# 对当前仓库触发一次索引构建/刷新，并关闭 maxFiles 上限
npm run workspace:index -- . --max-files null

# 对当前仓库触发一次索引构建/刷新，并显示阶段日志与文件进度
npm run workspace:index -- . --verbose
```

## MCP 配置示例

将构建产物接入支持 MCP 的客户端时，可使用类似配置：

```json
{
  "mcpServers": {
    "arkts-analyzer": {
      "command": "node",
      "args": ["/absolute/path/to/lsp_arkts/dist/mcp-server.js"]
    }
  }
}
```

## 适合的使用场景

- 让 agent 先拿到仓库级 ArkTS 概览，再决定读哪些文件。
- 在未保存的 `.ets` / `.ts` 内容上做组件分析或诊断。
- 从入口组件出发追踪本地模块依赖关系。
- 为编辑器、脚本或自动化流程提供只读 ArkTS 代码智能能力。
- 让 agent 先用 summary 工具做定位和结构理解，再用源码证据工具确认实现细节、bug 位置和修改影响。

## 路径兼容约定

为避免 Windows 与 POSIX 平台上的路径拼写差异导致分析结果不一致，仓库内的文件处理遵循以下规则：

- 文件身份比较不能直接使用原始路径字符串，必须先做内部 canonicalization。
- canonicalization 规则：
  - 先做绝对化和 `path.normalize()`
  - 将分隔符统一为 `/`
  - 在大小写不敏感的平台上统一转为小写
  - `__arkts_intrinsics__.d.ts` 作为特殊内建文件单独处理
- 内部文件身份与对外返回路径分离：
  - 内部匹配、去重、索引、overlay 命中使用 canonical key
  - 对外结果保留实际 `sourceFile.fileName` 或平台原生路径
- `inMemoryFiles`、`rootNames`、`scriptVersions`、`program.getSourceFile()`、模块解析结果必须共用同一套文件身份规则。
- 扩展名省略导入如 `./helper` 的解析结果，必须映射回实际已登记的 overlay 文件名，不能直接信任解析器临时生成的路径拼写。
- 处理虚拟文件时，路径解析要按文件自身风格选择 `path.posix` 或 `path.win32`，不能默认套用宿主平台路径语义。
- 已存在的真实文件在对外返回时优先使用 `realpath`，避免测试和客户端看到不同的等价路径。

新增或修改路径相关逻辑时，至少要补一条 Windows 回归测试；涉及 MCP 路径归一化时，也要同步验证 `test/mcp-server.test.mjs` 中的相对路径和 overlay 场景。
