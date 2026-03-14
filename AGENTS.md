# AGENTS.md

## MCP-First Repo Analysis

When the user asks to investigate a repository issue, understand architecture, trace dependencies, or study ArkTS code structure, prefer the local ArkTS MCP tools before direct file reading.

Use this order when it fits the task:

1. `arkts_workspace_overview`
2. `arkts_find_symbol`
3. `arkts_summarize_file`
4. `arkts_get_related_files`
5. `arkts_read_source_excerpt` when exact implementation details matter
6. `arkts_get_evidence_context` when a conclusion needs source-backed proof
7. `arkts_explain_module`
8. `arkts_trace_dependencies`
9. `arkts_analyze_components`
10. `arkts_get_diagnostics`
11. `arkts_find_definition`
12. `arkts_refresh_workspace` when files changed or cache looks stale

## Repo Map

- Package entry exports live in `src/index.ts`.
- MCP stdio server setup and tool registration live in `src/mcp-server.ts`.
- Single-file ArkTS language analysis lives in `src/core/arkts-analyzer.ts`.
- ArkTS compiler/language host glue lives in `src/core/compiler-host.ts` and `src/core/arkts-language.ts`.
- Workspace indexing, snapshot persistence, symbol search, and dependency tracing live in `src/workspace/workspace-service.ts`.
- Shared workspace-facing result types live in `src/workspace/types.ts`.
- Integration and regression coverage live in `test/*.test.mjs`.
- Sample ArkTS fixture workspace for MCP tests lives in `test/fixtures/sample_test`.

## Required Behavior

- Prefer MCP tools for repository-level analysis instead of scanning many files with shell commands.
- Always pass `workspaceRoot` for workspace-scoped ArkTS MCP tools when the repository root is known.
- Use direct file reads only when:
  - MCP results are insufficient
  - line-level confirmation is needed
  - implementation work requires editing specific files
- When using `arkts_find_definition`, remember the position is 1-based `line` and `character`.
- When the user asks for a summary of a repo problem, first build repo context with MCP, then drill into a small number of files.
- Treat `workspace_overview`, `summarize_file`, `get_related_files`, and `trace_dependencies` as valid analysis tools, but prefer `arkts_read_source_excerpt` or `arkts_get_evidence_context` before making precise implementation claims.

## Documentation Sync

- Keep `README.md` aligned with the actual exported server behavior in `src/mcp-server.ts`.
- When adding, removing, or renaming MCP tools, update the README tool list in the same change.
- When changing startup commands, Node version requirements, or package scripts, update the README quick-start section.
- When changing repo-specific agent workflow or preferred analysis order, update this `AGENTS.md` in the same change.
- Use `test/mcp-server.test.mjs` as the source of truth for the expected tool inventory.

## Preferred Investigation Output

- For repository investigations, identify:
  - entry files
  - key modules
  - dependency relationships
  - likely next files to inspect
- When the answer depends on workspace indexing behavior, mention whether the result comes from snapshot data or direct analyzer output.

## Output Preference

- Summarize findings in Chinese unless the user asks for another language.
