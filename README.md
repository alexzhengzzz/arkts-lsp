# ArkTS Analyzer MCP Server

一个基于 TypeScript 的 ArkTS 分析与工作区索引服务，提供 15 个只读 MCP 工具，既支持单文件语义分析，也支持面向仓库的符号检索、依赖追踪和上下文摘要。

## 能力概览

- 解析 ArkTS 组件与装饰器成员，识别 `@Entry`、`@Component`、`@State`、`@Prop`、`@Watch` 等结构。
- 收集词法、语法、语义诊断，并过滤 ArkTS 内建装饰器带来的噪声。
- 提供定义、类型定义、实现、引用、hover、文档符号等语言能力。
- 构建可持久化的工作区快照，用于文件摘要、符号搜索、相关文件聚合和依赖图追踪。
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

### 语言服务查询

- `arkts_hover`
- `arkts_find_references`
- `arkts_find_implementation`
- `arkts_find_type_definition`
- `arkts_document_symbols`

## 仓库结构

- `src/index.ts`: 包导出入口。
- `src/mcp-server.ts`: MCP stdio server 与 15 个工具注册。
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
```

常用命令：

```bash
npm run check
npm test
npm run clean
```

`start:mcp` 会通过 stdio 启动 `dist/mcp-server.js`，因此首次运行前需要先执行 `npm run build`。

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
