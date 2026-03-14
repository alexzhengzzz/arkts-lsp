import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import {
  ArkTSAnalyzer,
  type AnalyzerDiagnostic,
  type AnalyzerPosition,
  type AnalyzerRange,
  type DecoratedComponentInfo,
  type DecoratedMemberInfo,
  type DefinitionLocation,
  type DocumentSymbol,
  type HoverInfo,
  type HoverTagInfo,
  type ReferenceLocation,
  type StateMemberInfo,
} from "./core/arkts-analyzer.js";
import { WorkspaceService } from "./workspace/workspace-service.js";

interface WorkspaceFileInput {
  fileName: string;
  content: string;
}

interface WorkspaceToolInput {
  targetFile: string;
  rootNames?: string[] | undefined;
  files?: WorkspaceFileInput[] | undefined;
}

interface DefinitionToolInput extends WorkspaceToolInput {
  position: ExternalPosition;
}

interface WorkspacePositionToolInput extends WorkspaceScopedToolInput {
  targetFile: string;
  position: ExternalPosition;
}

interface WorkspaceServiceInput {
  workspaceRoot?: string | undefined;
  include?: string[] | undefined;
  exclude?: string[] | undefined;
  maxFiles?: number | undefined;
  cacheDir?: string | undefined;
  freshness?: "mtime" | "always" | undefined;
}

interface WorkspaceScopedToolInput extends WorkspaceServiceInput {
  files?: WorkspaceFileInput[] | undefined;
}

interface WorkspaceFileToolInput extends WorkspaceScopedToolInput {
  targetFile: string;
}

interface WorkspaceSymbolToolInput extends WorkspaceScopedToolInput {
  query: string;
  limit?: number | undefined;
}

interface RelatedFilesToolInput extends WorkspaceScopedToolInput {
  targetFile?: string | undefined;
  symbolQuery?: string | undefined;
  limit?: number | undefined;
}

interface TraceDependenciesToolInput extends RelatedFilesToolInput {
  depth?: number | undefined;
}

interface RefreshWorkspaceToolInput extends WorkspaceServiceInput {
  changedFiles?: string[] | undefined;
}

interface ReadSourceExcerptToolInput extends WorkspaceScopedToolInput {
  targetFile: string;
  range?: ExternalRange | undefined;
  symbolQuery?: string | undefined;
  maxLines?: number | undefined;
}

interface EvidenceContextToolInput extends WorkspaceScopedToolInput {
  targetFile?: string | undefined;
  symbolQuery?: string | undefined;
  question?: string | undefined;
  includeRelated?: boolean | undefined;
  snippetCount?: number | undefined;
  budgetChars?: number | undefined;
}

interface ExternalPosition {
  line: number;
  character: number;
}

interface ExternalRange {
  start: ExternalPosition;
  end: ExternalPosition;
}

interface ExternalStateMemberInfo {
  name: string;
  decorator: string;
  range: ExternalRange;
}

interface ExternalDecoratedMemberInfo {
  name: string;
  decorator: string;
  kind:
    | "state"
    | "prop"
    | "param"
    | "require"
    | "trace"
    | "computed"
    | "observed"
    | "observedV2"
    | "link"
    | "objectLink"
    | "provide"
    | "consume"
    | "storageProp"
    | "storageLink"
    | "localStorageProp"
    | "localStorageLink"
    | "builderParam"
    | "local"
    | "other";
  range: ExternalRange;
}

interface ExternalComponentInfo {
  fileName: string;
  name: string;
  range: ExternalRange;
  isEntry: boolean;
  componentDecorators: string[];
  stateMembers: ExternalStateMemberInfo[];
  decoratedMembers: ExternalDecoratedMemberInfo[];
}

interface ExternalDiagnostic {
  fileName: string;
  category: "lexical" | "syntactic" | "semantic";
  code: number;
  message: string;
  range: ExternalRange;
  confidence: "high" | "low";
  reason?: string | undefined;
}

interface ExternalDefinitionLocation {
  fileName: string;
  range: ExternalRange;
  symbolName: string;
}

interface ExternalHoverTagInfo {
  name: string;
  text: string;
}

interface ExternalHoverInfo {
  fileName: string;
  range: ExternalRange;
  symbolName: string;
  kind: string;
  kindModifiers: string;
  displayText: string;
  documentation: string;
  tags: ExternalHoverTagInfo[];
}

interface ExternalReferenceLocation {
  fileName: string;
  range: ExternalRange;
  symbolName: string;
  isDefinition: boolean;
  isWriteAccess: boolean;
}

interface ExternalDocumentSymbol {
  name: string;
  kind: string;
  detail?: string | undefined;
  range: ExternalRange;
  selectionRange: ExternalRange;
  children: ExternalDocumentSymbol[];
}

interface ExternalSourceExcerpt {
  fileName: string;
  relativePath: string;
  range: ExternalRange;
  content: string;
  truncated: boolean;
  provenance: "snapshot" | "live";
  evidenceLevel: "source";
  symbolName?: string | undefined;
  whySelected?: string | undefined;
}

interface ExternalEvidenceSnippet {
  fileName: string;
  relativePath: string;
  range: ExternalRange;
  content: string;
  purpose: string;
  truncated: boolean;
  provenance: "snapshot" | "live";
  evidenceLevel: "source";
  whySelected?: string | undefined;
}

interface RequestContext {
  analyzer: ArkTSAnalyzer;
  targetFile: string;
}

const serverInfo = {
  name: "arkts-analyzer-mcp",
  version: "0.1.0",
} as const;

const positionSchema = z.object({
  line: z.number().int().positive().describe("1-based line number."),
  character: z.number().int().positive().describe("1-based character number."),
});

const rangeSchema = z.object({
  start: positionSchema,
  end: positionSchema,
});

const provenanceSchema = z.enum(["snapshot", "live"]);
const evidenceLevelSchema = z.enum(["summary", "source"]);

const workspaceFileSchema = z.object({
  fileName: z.string().min(1).describe("Absolute or cwd-relative file path."),
  content: z.string().describe("Unsaved in-memory file contents."),
});

const workspaceInputSchema = {
  targetFile: z
    .string()
    .min(1)
    .describe("Absolute or cwd-relative path to the file being analyzed."),
  rootNames: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional extra root files to include in the analysis program."),
  files: z
    .array(workspaceFileSchema)
    .optional()
    .describe("Optional in-memory file overlays. Later duplicates win."),
} as const;

const workspaceServiceInputSchema = {
  workspaceRoot: z
    .string()
    .min(1)
    .optional()
    .describe("Workspace root path. Defaults to the current working directory."),
  include: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional include globs for workspace discovery."),
  exclude: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional exclude globs for workspace discovery."),
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of workspace files to index."),
  cacheDir: z
    .string()
    .min(1)
    .optional()
    .describe("Optional cache directory for persisted workspace snapshots."),
  freshness: z
    .enum(["mtime", "always"])
    .optional()
    .describe("Cache freshness policy. 'mtime' reuses cache until file metadata changes."),
} as const;

const workspaceScopedInputSchema = {
  ...workspaceServiceInputSchema,
  files: z
    .array(workspaceFileSchema)
    .optional()
    .describe("Optional in-memory file overlays for query-time analysis."),
} as const;

const componentOutputSchema = {
  targetFile: z.string(),
  components: z.array(
    z.object({
      fileName: z.string(),
      name: z.string(),
      range: rangeSchema,
      isEntry: z.boolean(),
      componentDecorators: z.array(z.string()),
      stateMembers: z.array(
        z.object({
          name: z.string(),
          decorator: z.string(),
          range: rangeSchema,
        }),
      ),
      decoratedMembers: z.array(
        z.object({
          name: z.string(),
          decorator: z.string(),
          kind: z.enum([
            "state",
            "prop",
            "param",
            "require",
            "trace",
            "computed",
            "observed",
            "observedV2",
            "link",
            "objectLink",
            "provide",
            "consume",
            "storageProp",
            "storageLink",
            "localStorageProp",
            "localStorageLink",
            "builderParam",
            "local",
            "other",
          ]),
          range: rangeSchema,
        }),
      ),
    }),
  ),
} as const;

const componentSummarySchema = z.object({
  name: z.string(),
  range: rangeSchema,
  isEntry: z.boolean(),
  componentDecorators: z.array(z.string()),
  stateMembers: z.array(
    z.object({
      name: z.string(),
      decorator: z.string(),
      range: rangeSchema,
    }),
  ),
  decoratedMembers: z.array(
    z.object({
      name: z.string(),
      decorator: z.string(),
      kind: z.enum([
        "state",
        "prop",
        "param",
        "require",
        "trace",
        "computed",
        "observed",
        "observedV2",
        "link",
        "objectLink",
        "provide",
        "consume",
        "storageProp",
        "storageLink",
        "localStorageProp",
        "localStorageLink",
        "builderParam",
        "local",
        "other",
      ]),
      range: rangeSchema,
    }),
  ),
});

const diagnosticsOutputSchema = {
  targetFile: z.string(),
  diagnostics: z.array(
    z.object({
      fileName: z.string(),
      category: z.enum(["lexical", "syntactic", "semantic"]),
      code: z.number().int(),
      message: z.string(),
      range: rangeSchema,
      confidence: z.enum(["high", "low"]),
      reason: z.string().optional(),
    }),
  ),
} as const;

const definitionOutputSchema = {
  targetFile: z.string(),
  queryPosition: positionSchema,
  definition: z
    .object({
      fileName: z.string(),
      range: rangeSchema,
      symbolName: z.string(),
    })
    .nullable(),
} as const;

const hoverTagSchema = z.object({
  name: z.string(),
  text: z.string(),
});

const hoverOutputSchema = {
  targetFile: z.string(),
  queryPosition: positionSchema,
  hover: z
    .object({
      fileName: z.string(),
      range: rangeSchema,
      symbolName: z.string(),
      kind: z.string(),
      kindModifiers: z.string(),
      displayText: z.string(),
      documentation: z.string(),
      tags: z.array(hoverTagSchema),
    })
    .nullable(),
} as const;

const referencesOutputSchema = {
  targetFile: z.string(),
  queryPosition: positionSchema,
  references: z.array(
    z.object({
      fileName: z.string(),
      range: rangeSchema,
      symbolName: z.string(),
      isDefinition: z.boolean(),
      isWriteAccess: z.boolean(),
    }),
  ),
} as const;

const locationListOutputSchema = {
  targetFile: z.string(),
  queryPosition: positionSchema,
  locations: z.array(
    z.object({
      fileName: z.string(),
      range: rangeSchema,
      symbolName: z.string(),
    }),
  ),
} as const;

const documentSymbolSchema: z.ZodType<ExternalDocumentSymbol> = z.lazy(() =>
  z.object({
    name: z.string(),
    kind: z.string(),
    detail: z.string().optional(),
    range: rangeSchema,
    selectionRange: rangeSchema,
    children: z.array(documentSymbolSchema),
  }),
);

const documentSymbolsOutputSchema = {
  targetFile: z.string(),
  symbols: z.array(documentSymbolSchema),
} as const;

const importRecordSchema = z.object({
  specifier: z.string(),
  resolvedPath: z.string().nullable(),
  importedSymbols: z.array(z.string()),
  kind: z.enum(["import", "re-export"]),
  isTypeOnly: z.boolean(),
});

const exportRecordSchema = z.object({
  name: z.string(),
  kind: z.string(),
  isDefault: z.boolean(),
  sourcePath: z.string().nullable().optional(),
});

const topLevelSymbolSchema = z.object({
  name: z.string(),
  kind: z.string(),
  range: rangeSchema,
  exported: z.boolean(),
});

const fileSummarySchema = z.object({
  fileName: z.string(),
  relativePath: z.string(),
  language: z.enum(["arkts", "typescript", "javascript"]),
  role: z.enum(["entrypoint", "component", "module", "script"]),
  provenance: provenanceSchema,
  summary: z.string(),
  imports: z.array(importRecordSchema),
  exports: z.array(exportRecordSchema),
  topLevelSymbols: z.array(topLevelSymbolSchema),
  components: z.array(componentSummarySchema),
});

const hotFileSchema = z.object({
  fileName: z.string(),
  relativePath: z.string(),
  score: z.number().int(),
});

const workspaceOverviewOutputSchema = {
  workspaceId: z.string(),
  workspaceRoot: z.string(),
  fileCount: z.number().int(),
  symbolCount: z.number().int(),
  edgeCount: z.number().int(),
  truncated: z.boolean(),
  entryFiles: z.array(z.string()),
  hotFiles: z.array(hotFileSchema),
  cacheStatus: z.enum(["memory", "hit", "rebuilt"]),
  provenance: provenanceSchema,
  overview: z.string(),
} as const;

const findSymbolOutputSchema = {
  query: z.string(),
  matches: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      fileName: z.string(),
      relativePath: z.string(),
      range: rangeSchema,
      exported: z.boolean(),
    }),
  ),
  provenance: provenanceSchema,
} as const;

const contextBundleOutputSchema = {
  rootFile: z.string(),
  reason: z.string(),
  files: z.array(
    z.object({
      fileName: z.string(),
      relativePath: z.string(),
      relation: z.enum(["self", "imports", "importedBy", "dependency"]),
      reason: z.string(),
      summary: z.string(),
      snippet: z.string(),
      snippetRange: rangeSchema.optional(),
      snippetTruncated: z.boolean().optional(),
      provenance: provenanceSchema.optional(),
      evidenceLevel: evidenceLevelSchema.optional(),
      whySelected: z.string().optional(),
    }),
  ),
  provenance: provenanceSchema,
} as const;

const explainModuleOutputSchema = {
  file: fileSummarySchema,
  context: z.object(contextBundleOutputSchema),
  provenance: provenanceSchema,
} as const;

const dependencyTraceOutputSchema = {
  rootFile: z.string(),
  depth: z.number().int(),
  truncated: z.boolean(),
  nodes: z.array(
    z.object({
      fileName: z.string(),
      relativePath: z.string(),
      role: z.enum(["entrypoint", "component", "module", "script"]),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: z.enum(["import", "re-export"]),
      specifier: z.string(),
      symbols: z.array(z.string()),
    }),
  ),
  provenance: provenanceSchema,
} as const;

const refreshWorkspaceOutputSchema = {
  workspaceId: z.string(),
  refreshedFiles: z.array(z.string()),
  fileCount: z.number().int(),
  symbolCount: z.number().int(),
  edgeCount: z.number().int(),
  cacheStatus: z.enum(["memory", "hit", "rebuilt"]),
  refreshMode: z.enum(["full", "incremental"]),
  changedFileCount: z.number().int(),
  reindexedFileCount: z.number().int(),
  reusedFileCount: z.number().int(),
  provenance: provenanceSchema,
} as const;

const sourceExcerptSchema: z.ZodType<ExternalSourceExcerpt> = z.object({
  fileName: z.string(),
  relativePath: z.string(),
  range: rangeSchema,
  content: z.string(),
  truncated: z.boolean(),
  provenance: provenanceSchema,
  evidenceLevel: z.literal("source"),
  symbolName: z.string().optional(),
  whySelected: z.string().optional(),
});

const readSourceExcerptOutputSchema = {
  targetFile: z.string(),
  excerpt: sourceExcerptSchema,
} as const;

const evidenceSnippetSchema: z.ZodType<ExternalEvidenceSnippet> = z.object({
  fileName: z.string(),
  relativePath: z.string(),
  range: rangeSchema,
  content: z.string(),
  purpose: z.string(),
  truncated: z.boolean(),
  provenance: provenanceSchema,
  evidenceLevel: z.literal("source"),
  whySelected: z.string().optional(),
});

const evidenceContextOutputSchema = {
  rootFile: z.string(),
  snippets: z.array(evidenceSnippetSchema),
  truncated: z.boolean(),
  provenance: provenanceSchema,
} as const;

export function createArkTSMcpServer(): McpServer {
  const server = new McpServer(serverInfo);

  server.registerTool(
    "arkts_workspace_overview",
    {
      title: "Get ArkTS Workspace Overview",
      description:
        "Build or load a workspace snapshot and return a bounded repo-map overview for LLM code reading.",
      inputSchema: workspaceServiceInputSchema,
      outputSchema: workspaceOverviewOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspaceServiceInput) => {
      try {
        const service = await createWorkspaceService(input);
        const overview = service.getOverview();

        return {
          content: [
            {
              type: "text" as const,
              text: overview.overview,
            },
          ],
          structuredContent: toStructuredContent(overview),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_summarize_file",
    {
      title: "Summarize ArkTS File",
      description:
        "Return a structured file summary with imports, exports, top-level symbols, and ArkTS component facts.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
      },
      outputSchema: fileSummarySchema.shape,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspaceFileToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const file = await service.summarizeFile(input.targetFile, input.files);

        return {
          content: [
            {
              type: "text" as const,
              text: file.summary,
            },
          ],
          structuredContent: toStructuredContent(file),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_find_symbol",
    {
      title: "Find Workspace Symbol",
      description:
        "Search the workspace symbol index using a fuzzy symbol name query.",
      inputSchema: {
        ...workspaceServiceInputSchema,
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      },
      outputSchema: findSymbolOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspaceSymbolToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const result = service.findSymbol(input.query, {
          limit: input.limit,
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                result.matches.length === 0
                  ? `No symbols matched "${input.query}".`
                  : `Found ${result.matches.length} symbol match(es) for "${input.query}".`,
            },
          ],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_get_related_files",
    {
      title: "Get Related Files",
      description:
        "Return a compact context bundle with the minimum related files around a target file or symbol query.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1).optional(),
        symbolQuery: z.string().min(1).optional(),
        limit: z.number().int().positive().max(20).optional(),
      },
      outputSchema: contextBundleOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: RelatedFilesToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const result = await service.getRelatedFiles({
          ...(input.targetFile ? { targetFile: input.targetFile } : {}),
          ...(input.symbolQuery ? { symbolQuery: input.symbolQuery } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }, input.files);

        return {
          content: [
            {
              type: "text" as const,
              text: `Prepared ${result.files.length} related file(s) for contextual reading.`,
            },
          ],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_explain_module",
    {
      title: "Explain ArkTS Module",
      description:
        "Return a file summary plus its local dependency neighborhood for quick module comprehension.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
      },
      outputSchema: explainModuleOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspaceFileToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const result = await service.explainModule(input.targetFile, input.files);

        return {
          content: [
            {
              type: "text" as const,
              text: result.file.summary,
            },
          ],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_read_source_excerpt",
    {
      title: "Read ArkTS Source Excerpt",
      description:
        "Return a precise source excerpt for a file range or symbol query with line-aware bounds.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
        range: rangeSchema.optional(),
        symbolQuery: z.string().min(1).optional(),
        maxLines: z.number().int().positive().max(200).optional(),
      },
      outputSchema: readSourceExcerptOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: ReadSourceExcerptToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const result = await service.readSourceExcerpt({
          targetFile: input.targetFile,
          ...(input.range ? { range: input.range } : {}),
          ...(input.symbolQuery ? { symbolQuery: input.symbolQuery } : {}),
          ...(input.maxLines !== undefined ? { maxLines: input.maxLines } : {}),
        }, input.files);

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Prepared source excerpt from ${result.excerpt.fileName}:${result.excerpt.range.start.line}:${result.excerpt.range.start.character}.`,
            },
          ],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_get_evidence_context",
    {
      title: "Get ArkTS Evidence Context",
      description:
        "Return a bounded set of source-backed evidence snippets for high-confidence code understanding.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1).optional(),
        symbolQuery: z.string().min(1).optional(),
        question: z.string().min(1).optional(),
        includeRelated: z.boolean().optional(),
        snippetCount: z.number().int().positive().max(6).optional(),
        budgetChars: z.number().int().positive().max(40000).optional(),
      },
      outputSchema: evidenceContextOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: EvidenceContextToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const result = await service.getEvidenceContext({
          ...(input.targetFile ? { targetFile: input.targetFile } : {}),
          ...(input.symbolQuery ? { symbolQuery: input.symbolQuery } : {}),
          ...(input.question ? { question: input.question } : {}),
          ...(input.includeRelated !== undefined ? { includeRelated: input.includeRelated } : {}),
          ...(input.snippetCount !== undefined ? { snippetCount: input.snippetCount } : {}),
          ...(input.budgetChars !== undefined ? { budgetChars: input.budgetChars } : {}),
        }, input.files);

        return {
          content: [
            {
              type: "text" as const,
              text:
                result.snippets.length === 0
                  ? "No evidence snippets were produced."
                  : `Prepared ${result.snippets.length} evidence snippet(s).`,
            },
          ],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_trace_dependencies",
    {
      title: "Trace Dependencies",
      description:
        "Walk the local dependency graph from a target file or symbol and return a bounded graph slice.",
      inputSchema: {
        ...workspaceServiceInputSchema,
        targetFile: z.string().min(1).optional(),
        symbolQuery: z.string().min(1).optional(),
        depth: z.number().int().positive().max(5).optional(),
        limit: z.number().int().positive().max(100).optional(),
      },
      outputSchema: dependencyTraceOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: TraceDependenciesToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const result = await service.traceDependencies({
          ...(input.targetFile ? { targetFile: input.targetFile } : {}),
          ...(input.symbolQuery ? { symbolQuery: input.symbolQuery } : {}),
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                result.nodes.length === 0
                  ? "Dependency trace produced no nodes."
                  : `Dependency trace captured ${result.nodes.length} node(s) and ${result.edges.length} edge(s).`,
            },
          ],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_hover",
    {
      title: "Get ArkTS Hover",
      description:
        "Return type/signature/documentation information for the symbol at a 1-based position.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
        position: positionSchema,
      },
      outputSchema: hoverOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspacePositionToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const hover = service.getHover(
          input.targetFile,
          toAnalyzerPosition(input.position),
          input.files,
        );

        return {
          content: [
            {
              type: "text" as const,
              text:
                hover === undefined
                  ? `No hover information found at ${input.targetFile}:${input.position.line}:${input.position.character}.`
                  : `Hover information for ${hover.symbolName} resolved from ${hover.fileName}.`,
            },
          ],
          structuredContent: toStructuredContent({
            targetFile: normalizeInputPath(input.targetFile),
            queryPosition: input.position,
            hover: hover ? toExternalHover(hover) : null,
          }),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_find_references",
    {
      title: "Find ArkTS References",
      description:
        "Find workspace references for the symbol at a 1-based position.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
        position: positionSchema,
      },
      outputSchema: referencesOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspacePositionToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const references = service.findReferences(
          input.targetFile,
          toAnalyzerPosition(input.position),
          input.files,
        );

        return {
          content: [
            {
              type: "text" as const,
              text:
                references.length === 0
                  ? `No references found at ${input.targetFile}:${input.position.line}:${input.position.character}.`
                  : `Found ${references.length} reference(s).`,
            },
          ],
          structuredContent: toStructuredContent({
            targetFile: normalizeInputPath(input.targetFile),
            queryPosition: input.position,
            references: references.map(toExternalReference),
          }),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_find_implementation",
    {
      title: "Find ArkTS Implementations",
      description:
        "Find implementation locations for the symbol at a 1-based position.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
        position: positionSchema,
      },
      outputSchema: locationListOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspacePositionToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const locations = service.findImplementations(
          input.targetFile,
          toAnalyzerPosition(input.position),
          input.files,
        );

        return {
          content: [
            {
              type: "text" as const,
              text:
                locations.length === 0
                  ? `No implementations found at ${input.targetFile}:${input.position.line}:${input.position.character}.`
                  : `Found ${locations.length} implementation location(s).`,
            },
          ],
          structuredContent: toStructuredContent({
            targetFile: normalizeInputPath(input.targetFile),
            queryPosition: input.position,
            locations: locations.map(toExternalDefinition),
          }),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_find_type_definition",
    {
      title: "Find ArkTS Type Definitions",
      description:
        "Find type definition locations for the symbol at a 1-based position.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
        position: positionSchema,
      },
      outputSchema: locationListOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspacePositionToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const locations = service.findTypeDefinitions(
          input.targetFile,
          toAnalyzerPosition(input.position),
          input.files,
        );

        return {
          content: [
            {
              type: "text" as const,
              text:
                locations.length === 0
                  ? `No type definitions found at ${input.targetFile}:${input.position.line}:${input.position.character}.`
                  : `Found ${locations.length} type definition location(s).`,
            },
          ],
          structuredContent: toStructuredContent({
            targetFile: normalizeInputPath(input.targetFile),
            queryPosition: input.position,
            locations: locations.map(toExternalDefinition),
          }),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_document_symbols",
    {
      title: "Get ArkTS Document Symbols",
      description:
        "Return a hierarchical symbol tree for a target file.",
      inputSchema: {
        ...workspaceScopedInputSchema,
        targetFile: z.string().min(1),
      },
      outputSchema: documentSymbolsOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspaceFileToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const symbols = service.getDocumentSymbols(input.targetFile, input.files);

        return {
          content: [
            {
              type: "text" as const,
              text:
                symbols.length === 0
                  ? `No document symbols found for ${input.targetFile}.`
                  : `Found ${symbols.length} top-level document symbol(s).`,
            },
          ],
          structuredContent: toStructuredContent({
            targetFile: normalizeInputPath(input.targetFile),
            symbols: symbols.map(toExternalDocumentSymbol),
          }),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_refresh_workspace",
    {
      title: "Refresh Workspace Snapshot",
      description:
        "Invalidate and rebuild the persisted workspace snapshot, optionally tagging changed files in the response.",
      inputSchema: {
        ...workspaceServiceInputSchema,
        changedFiles: z.array(z.string().min(1)).optional(),
      },
      outputSchema: refreshWorkspaceOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: RefreshWorkspaceToolInput) => {
      try {
        const service = await createWorkspaceService(input);
        const result = await service.refresh(input.changedFiles);

        return {
          content: [
            {
              type: "text" as const,
              text: `Workspace snapshot refreshed for ${result.fileCount} indexed file(s).`,
            },
          ],
          structuredContent: toStructuredContent(result),
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_analyze_components",
    {
      title: "Analyze ArkTS Components",
      description:
        "Analyze the decorated ArkTS component structure for a target file.",
      inputSchema: workspaceInputSchema,
      outputSchema: componentOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspaceToolInput) => {
      try {
        const context = createRequestContext(input);
        const components = context.analyzer
          .findDecoratedComponents(context.targetFile)
          .map(toExternalComponent);
        const structuredContent = {
          targetFile: context.targetFile,
          components,
        };

        return {
          content: [
            {
              type: "text" as const,
              text:
                components.length === 0
                  ? `No decorated ArkTS components found in ${context.targetFile}.`
                  : `Found ${components.length} decorated ArkTS component(s) in ${context.targetFile}.`,
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_get_diagnostics",
    {
      title: "Get ArkTS Diagnostics",
      description:
        "Collect lexical, syntactic, and semantic diagnostics for a target file.",
      inputSchema: workspaceInputSchema,
      outputSchema: diagnosticsOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: WorkspaceToolInput) => {
      try {
        const context = createRequestContext(input);
        const diagnostics = context.analyzer
          .collectDiagnostics(context.targetFile)
          .map(toExternalDiagnostic);
        const structuredContent = {
          targetFile: context.targetFile,
          diagnostics,
        };

        return {
          content: [
            {
              type: "text" as const,
              text:
                diagnostics.length === 0
                  ? `No diagnostics found for ${context.targetFile}.`
                  : `Found ${diagnostics.length} diagnostic(s) for ${context.targetFile}.`,
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "arkts_find_definition",
    {
      title: "Find ArkTS Definition",
      description:
        "Find the symbol definition at a 1-based line and character in the target file.",
      inputSchema: {
        ...workspaceInputSchema,
        position: positionSchema,
      },
      outputSchema: definitionOutputSchema,
      annotations: {
        readOnlyHint: true,
      },
    },
    async (input: DefinitionToolInput) => {
      try {
        const context = createRequestContext(input);
        const definition = context.analyzer.findDefinition(
          context.targetFile,
          toAnalyzerPosition(input.position),
        );
        const structuredContent = {
          targetFile: context.targetFile,
          queryPosition: input.position,
          definition: definition ? toExternalDefinition(definition) : null,
        };

        return {
          content: [
            {
              type: "text" as const,
              text:
                structuredContent.definition === null
                  ? `No definition found at ${context.targetFile}:${input.position.line}:${input.position.character}.`
                  : `Definition for ${structuredContent.definition.symbolName} found at ${structuredContent.definition.fileName}:${structuredContent.definition.range.start.line}:${structuredContent.definition.range.start.character}.`,
            },
          ],
          structuredContent,
        };
      } catch (error) {
        return toToolErrorResult(error);
      }
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = createArkTSMcpServer();

  await server.connect(transport);
  console.error("ArkTS MCP server running on stdio");
}

function createRequestContext(input: WorkspaceToolInput): RequestContext {
  const targetFile = normalizeInputPath(input.targetFile);
  const overlayEntries = collectOverlayEntries(input.files);
  const overlayFiles = new Set(overlayEntries.map(([fileName]) => fileName));

  if (!overlayFiles.has(targetFile) && !existsSync(targetFile)) {
    throw new Error(`Target file does not exist: ${targetFile}`);
  }

  const rootNames = dedupePaths([
    targetFile,
    ...(input.rootNames ?? []).map(normalizeInputPath),
    ...overlayEntries.map(([fileName]) => fileName),
  ]);
  const analyzer = new ArkTSAnalyzer({
    rootNames,
  });

  for (const [fileName, content] of overlayEntries) {
    analyzer.setInMemoryFile({
      fileName,
      content,
    });
  }

  return {
    analyzer,
    targetFile,
  };
}

async function createWorkspaceService(
  input: WorkspaceServiceInput,
): Promise<WorkspaceService> {
  return WorkspaceService.initialize(
    normalizeInputPath(input.workspaceRoot ?? process.cwd()),
    {
      include: input.include,
      exclude: input.exclude,
      maxFiles: input.maxFiles,
      cacheDir: input.cacheDir,
      freshness: input.freshness,
    },
  );
}

function collectOverlayEntries(
  files: WorkspaceFileInput[] | undefined,
): Array<[string, string]> {
  const overlays = new Map<string, string>();

  for (const file of files ?? []) {
    overlays.set(normalizeInputPath(file.fileName), file.content);
  }

  return [...overlays.entries()];
}

function normalizeInputPath(fileName: string): string {
  return path.normalize(
    path.isAbsolute(fileName) ? fileName : path.resolve(process.cwd(), fileName),
  );
}

function dedupePaths(fileNames: string[]): string[] {
  return [...new Set(fileNames)];
}

function toAnalyzerPosition(position: ExternalPosition): AnalyzerPosition {
  return {
    line: position.line - 1,
    character: position.character - 1,
  };
}

function toExternalPosition(position: AnalyzerPosition): ExternalPosition {
  return {
    line: position.line + 1,
    character: position.character + 1,
  };
}

function toExternalRange(range: AnalyzerRange): ExternalRange {
  return {
    start: toExternalPosition(range.start),
    end: toExternalPosition(range.end),
  };
}

function toExternalStateMember(
  stateMember: StateMemberInfo,
): ExternalStateMemberInfo {
  return {
    name: stateMember.name,
    decorator: stateMember.decorator,
    range: toExternalRange(stateMember.range),
  };
}

function toExternalDecoratedMember(
  member: DecoratedMemberInfo,
): ExternalDecoratedMemberInfo {
  return {
    name: member.name,
    decorator: member.decorator,
    kind: member.kind,
    range: toExternalRange(member.range),
  };
}

function toExternalComponent(
  component: DecoratedComponentInfo,
): ExternalComponentInfo {
  return {
    fileName: normalizeInputPath(component.fileName),
    name: component.name,
    range: toExternalRange(component.range),
    isEntry: component.isEntry,
    componentDecorators: component.componentDecorators,
    stateMembers: component.stateMembers.map(toExternalStateMember),
    decoratedMembers: component.decoratedMembers.map(toExternalDecoratedMember),
  };
}

function toExternalDiagnostic(diagnostic: AnalyzerDiagnostic): ExternalDiagnostic {
  return {
    fileName: normalizeInputPath(diagnostic.fileName),
    category: diagnostic.category,
    code: diagnostic.code,
    message: diagnostic.message,
    range: toExternalRange(diagnostic.range),
    confidence: diagnostic.confidence,
    reason: diagnostic.reason,
  };
}

function toExternalDefinition(
  definition: DefinitionLocation,
): ExternalDefinitionLocation {
  return {
    fileName: normalizeInputPath(definition.fileName),
    range: toExternalRange(definition.range),
    symbolName: definition.symbolName,
  };
}

function toExternalHoverTag(tag: HoverTagInfo): ExternalHoverTagInfo {
  return {
    name: tag.name,
    text: tag.text,
  };
}

function toExternalHover(hover: HoverInfo): ExternalHoverInfo {
  return {
    fileName: normalizeInputPath(hover.fileName),
    range: toExternalRange(hover.range),
    symbolName: hover.symbolName,
    kind: hover.kind,
    kindModifiers: hover.kindModifiers,
    displayText: hover.displayText,
    documentation: hover.documentation,
    tags: hover.tags.map(toExternalHoverTag),
  };
}

function toExternalReference(
  reference: ReferenceLocation,
): ExternalReferenceLocation {
  return {
    fileName: normalizeInputPath(reference.fileName),
    range: toExternalRange(reference.range),
    symbolName: reference.symbolName,
    isDefinition: reference.isDefinition,
    isWriteAccess: reference.isWriteAccess,
  };
}

function toExternalDocumentSymbol(
  symbol: DocumentSymbol,
): ExternalDocumentSymbol {
  return {
    name: symbol.name,
    kind: symbol.kind,
    detail: symbol.detail,
    range: toExternalRange(symbol.range),
    selectionRange: toExternalRange(symbol.selectionRange),
    children: symbol.children.map(toExternalDocumentSymbol),
  };
}

function toToolErrorResult(error: unknown) {
  const message =
    error instanceof Error ? error.message : "Unknown ArkTS MCP server error.";

  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    isError: true,
  };
}

function toStructuredContent<T>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;
}

if (isMainModule()) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`ArkTS MCP server failed: ${message}`);
    process.exit(1);
  });
}
