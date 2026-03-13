# AGENTS.md

## MCP-First Repo Analysis

When the user asks to investigate a repository issue, understand architecture, trace dependencies, or study ArkTS code structure, prefer the local ArkTS MCP tools before direct file reading.

Use this order when it fits the task:

1. `arkts_workspace_overview`
2. `arkts_find_symbol`
3. `arkts_summarize_file`
4. `arkts_get_related_files`
5. `arkts_explain_module`
6. `arkts_trace_dependencies`
7. `arkts_analyze_components`
8. `arkts_get_diagnostics`
9. `arkts_find_definition`
10. `arkts_refresh_workspace` when files changed or cache looks stale

## Required Behavior

- Prefer MCP tools for repository-level analysis instead of scanning many files with shell commands.
- Always pass `workspaceRoot` for workspace-scoped ArkTS MCP tools when the repository root is known.
- Use direct file reads only when:
  - MCP results are insufficient
  - line-level confirmation is needed
  - implementation work requires editing specific files
- When using `arkts_find_definition`, remember the position is 1-based `line` and `character`.
- When the user asks for a summary of a repo problem, first build repo context with MCP, then drill into a small number of files.

## Output Preference

- Summarize findings in Chinese unless the user asks for another language.
- For repository investigations, report:
  - entry files
  - key modules
  - dependency relationships
  - likely next files to inspect
