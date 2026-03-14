import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { ArkTSAnalyzer, } from "./core/arkts-analyzer.js";
import { canonicalizeInternalFileName, dedupeFileNamesByInternalIdentity, } from "./core/compiler-host.js";
import { resolveMcpServerConfig, } from "./mcp-config.js";
import { WorkspaceService } from "./workspace/workspace-service.js";
const serverInfo = {
    name: "arkts-analyzer-mcp",
    version: "0.1.0",
};
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
const analyzerInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or cwd-relative path to the file being analyzed."),
    files: z
        .array(workspaceFileSchema)
        .optional()
        .describe("Optional in-memory file overlays. Later duplicates win."),
});
const emptyInputSchema = z.strictObject({});
const workspaceTargetFileInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or workspace-relative path to the file being analyzed."),
});
const workspaceSymbolInputSchema = z.strictObject({
    query: z.string().min(1).describe("Workspace symbol query."),
});
const relatedFilesInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or workspace-relative path to the file being analyzed."),
    limit: z.number().int().positive().max(20).optional(),
});
const traceDependenciesInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or workspace-relative path to the file being analyzed."),
    depth: z.number().int().positive().max(5).optional(),
});
const workspacePositionInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or workspace-relative path to the file being analyzed."),
    position: positionSchema,
});
const readSourceExcerptInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or workspace-relative path to the file being analyzed."),
    range: rangeSchema,
    maxLines: z.number().int().positive().max(200).optional(),
});
const readSymbolExcerptInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or workspace-relative path to the file being analyzed."),
    symbolQuery: z.string().min(1).describe("Symbol name to locate inside the target file."),
    maxLines: z.number().int().positive().max(200).optional(),
});
const evidenceContextInputSchema = z.strictObject({
    targetFile: z
        .string()
        .min(1)
        .describe("Absolute or workspace-relative path to the file being analyzed."),
    question: z.string().min(1).optional(),
});
const componentOutputSchema = {
    targetFile: z.string(),
    components: z.array(z.object({
        fileName: z.string(),
        name: z.string(),
        range: rangeSchema,
        isEntry: z.boolean(),
        componentDecorators: z.array(z.string()),
        stateMembers: z.array(z.object({
            name: z.string(),
            decorator: z.string(),
            range: rangeSchema,
        })),
        decoratedMembers: z.array(z.object({
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
        })),
    })),
};
const componentSummarySchema = z.object({
    name: z.string(),
    range: rangeSchema,
    isEntry: z.boolean(),
    componentDecorators: z.array(z.string()),
    stateMembers: z.array(z.object({
        name: z.string(),
        decorator: z.string(),
        range: rangeSchema,
    })),
    decoratedMembers: z.array(z.object({
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
    })),
});
const diagnosticsOutputSchema = {
    targetFile: z.string(),
    diagnostics: z.array(z.object({
        fileName: z.string(),
        category: z.enum(["lexical", "syntactic", "semantic"]),
        code: z.number().int(),
        message: z.string(),
        range: rangeSchema,
        confidence: z.enum(["high", "low"]),
        reason: z.string().optional(),
    })),
};
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
};
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
};
const referencesOutputSchema = {
    targetFile: z.string(),
    queryPosition: positionSchema,
    references: z.array(z.object({
        fileName: z.string(),
        range: rangeSchema,
        symbolName: z.string(),
        isDefinition: z.boolean(),
        isWriteAccess: z.boolean(),
    })),
};
const locationListOutputSchema = {
    targetFile: z.string(),
    queryPosition: positionSchema,
    locations: z.array(z.object({
        fileName: z.string(),
        range: rangeSchema,
        symbolName: z.string(),
    })),
};
const documentSymbolSchema = z.lazy(() => z.object({
    name: z.string(),
    kind: z.string(),
    detail: z.string().optional(),
    range: rangeSchema,
    selectionRange: rangeSchema,
    children: z.array(documentSymbolSchema),
}));
const documentSymbolsOutputSchema = {
    targetFile: z.string(),
    symbols: z.array(documentSymbolSchema),
};
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
};
const findSymbolOutputSchema = {
    query: z.string(),
    matches: z.array(z.object({
        name: z.string(),
        kind: z.string(),
        fileName: z.string(),
        relativePath: z.string(),
        range: rangeSchema,
        exported: z.boolean(),
    })),
    provenance: provenanceSchema,
};
const contextBundleOutputSchema = {
    rootFile: z.string(),
    reason: z.string(),
    files: z.array(z.object({
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
    })),
    provenance: provenanceSchema,
};
const explainModuleOutputSchema = {
    file: fileSummarySchema,
    context: z.object(contextBundleOutputSchema),
    provenance: provenanceSchema,
};
const dependencyTraceOutputSchema = {
    rootFile: z.string(),
    depth: z.number().int(),
    truncated: z.boolean(),
    nodes: z.array(z.object({
        fileName: z.string(),
        relativePath: z.string(),
        role: z.enum(["entrypoint", "component", "module", "script"]),
    })),
    edges: z.array(z.object({
        from: z.string(),
        to: z.string(),
        kind: z.enum(["import", "re-export"]),
        specifier: z.string(),
        symbols: z.array(z.string()),
    })),
    provenance: provenanceSchema,
};
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
};
const sourceExcerptSchema = z.object({
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
};
const evidenceSnippetSchema = z.object({
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
};
export function createArkTSMcpServer(serverConfig = resolveMcpServerConfig()) {
    const server = new McpServer(serverInfo);
    const getWorkspaceService = async () => WorkspaceService.initialize(serverConfig.workspaceRoot, serverConfig.serviceOptions);
    server.registerTool("arkts_workspace_overview", {
        title: "Get ArkTS Workspace Overview",
        description: "Build or load a workspace snapshot and return a bounded repo-map overview for LLM code reading.",
        inputSchema: emptyInputSchema,
        outputSchema: workspaceOverviewOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async () => {
        try {
            const service = await getWorkspaceService();
            const overview = service.getOverview();
            return {
                content: [
                    {
                        type: "text",
                        text: overview.overview,
                    },
                ],
                structuredContent: toStructuredContent(overview),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_summarize_file", {
        title: "Summarize ArkTS File",
        description: "Return a structured file summary with imports, exports, top-level symbols, and ArkTS component facts.",
        inputSchema: workspaceTargetFileInputSchema,
        outputSchema: fileSummarySchema.shape,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const file = await service.summarizeFile(input.targetFile);
            return {
                content: [
                    {
                        type: "text",
                        text: file.summary,
                    },
                ],
                structuredContent: toStructuredContent(file),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_find_symbol", {
        title: "Find Workspace Symbol",
        description: "Search the workspace symbol index using a fuzzy symbol name query.",
        inputSchema: workspaceSymbolInputSchema,
        outputSchema: findSymbolOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const result = service.findSymbol(input.query);
            return {
                content: [
                    {
                        type: "text",
                        text: result.matches.length === 0
                            ? `No symbols matched "${input.query}".`
                            : `Found ${result.matches.length} symbol match(es) for "${input.query}".`,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_get_related_files", {
        title: "Get Related Files",
        description: "Return a compact context bundle with the minimum related files around a target file.",
        inputSchema: relatedFilesInputSchema,
        outputSchema: contextBundleOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const result = await service.getRelatedFiles({
                targetFile: input.targetFile,
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `Prepared ${result.files.length} related file(s) for contextual reading.`,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_explain_module", {
        title: "Explain ArkTS Module",
        description: "Return a file summary plus its local dependency neighborhood for quick module comprehension.",
        inputSchema: workspaceTargetFileInputSchema,
        outputSchema: explainModuleOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const result = await service.explainModule(input.targetFile);
            return {
                content: [
                    {
                        type: "text",
                        text: result.file.summary,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_read_source_excerpt", {
        title: "Read ArkTS Source Excerpt",
        description: "Return a precise source excerpt for an explicit file range with line-aware bounds.",
        inputSchema: readSourceExcerptInputSchema,
        outputSchema: readSourceExcerptOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const result = await service.readSourceExcerpt({
                targetFile: input.targetFile,
                range: input.range,
                ...(input.maxLines !== undefined ? { maxLines: input.maxLines } : {}),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `Prepared source excerpt from ${result.excerpt.fileName}:${result.excerpt.range.start.line}:${result.excerpt.range.start.character}.`,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_read_symbol_excerpt", {
        title: "Read ArkTS Symbol Excerpt",
        description: "Return a precise source excerpt around a symbol inside the target file.",
        inputSchema: readSymbolExcerptInputSchema,
        outputSchema: readSourceExcerptOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const result = await service.readSymbolExcerpt({
                targetFile: input.targetFile,
                symbolQuery: input.symbolQuery,
                ...(input.maxLines !== undefined ? { maxLines: input.maxLines } : {}),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `Prepared source excerpt from ${result.excerpt.fileName}:${result.excerpt.range.start.line}:${result.excerpt.range.start.character}.`,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_get_evidence_context", {
        title: "Get ArkTS Evidence Context",
        description: "Return a bounded set of source-backed evidence snippets for high-confidence code understanding.",
        inputSchema: evidenceContextInputSchema,
        outputSchema: evidenceContextOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const result = await service.getEvidenceContext({
                targetFile: input.targetFile,
                ...(input.question ? { question: input.question } : {}),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: result.snippets.length === 0
                            ? "No evidence snippets were produced."
                            : `Prepared ${result.snippets.length} evidence snippet(s).`,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_trace_dependencies", {
        title: "Trace Dependencies",
        description: "Walk the local dependency graph from a target file and return a bounded graph slice.",
        inputSchema: traceDependenciesInputSchema,
        outputSchema: dependencyTraceOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const result = await service.traceDependencies({
                targetFile: input.targetFile,
                ...(input.depth !== undefined ? { depth: input.depth } : {}),
            });
            return {
                content: [
                    {
                        type: "text",
                        text: result.nodes.length === 0
                            ? "Dependency trace produced no nodes."
                            : `Dependency trace captured ${result.nodes.length} node(s) and ${result.edges.length} edge(s).`,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_hover", {
        title: "Get ArkTS Hover",
        description: "Return type/signature/documentation information for the symbol at a 1-based position.",
        inputSchema: workspacePositionInputSchema,
        outputSchema: hoverOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const hover = service.getHover(input.targetFile, toAnalyzerPosition(input.position));
            return {
                content: [
                    {
                        type: "text",
                        text: hover === undefined
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
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_find_references", {
        title: "Find ArkTS References",
        description: "Find workspace references for the symbol at a 1-based position.",
        inputSchema: workspacePositionInputSchema,
        outputSchema: referencesOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const references = service.findReferences(input.targetFile, toAnalyzerPosition(input.position));
            return {
                content: [
                    {
                        type: "text",
                        text: references.length === 0
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
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_find_implementation", {
        title: "Find ArkTS Implementations",
        description: "Find implementation locations for the symbol at a 1-based position.",
        inputSchema: workspacePositionInputSchema,
        outputSchema: locationListOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const locations = service.findImplementations(input.targetFile, toAnalyzerPosition(input.position));
            return {
                content: [
                    {
                        type: "text",
                        text: locations.length === 0
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
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_find_type_definition", {
        title: "Find ArkTS Type Definitions",
        description: "Find type definition locations for the symbol at a 1-based position.",
        inputSchema: workspacePositionInputSchema,
        outputSchema: locationListOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const locations = service.findTypeDefinitions(input.targetFile, toAnalyzerPosition(input.position));
            return {
                content: [
                    {
                        type: "text",
                        text: locations.length === 0
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
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_document_symbols", {
        title: "Get ArkTS Document Symbols",
        description: "Return a hierarchical symbol tree for a target file.",
        inputSchema: workspaceTargetFileInputSchema,
        outputSchema: documentSymbolsOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const service = await getWorkspaceService();
            const symbols = service.getDocumentSymbols(input.targetFile);
            return {
                content: [
                    {
                        type: "text",
                        text: symbols.length === 0
                            ? `No document symbols found for ${input.targetFile}.`
                            : `Found ${symbols.length} top-level document symbol(s).`,
                    },
                ],
                structuredContent: toStructuredContent({
                    targetFile: normalizeInputPath(input.targetFile),
                    symbols: symbols.map(toExternalDocumentSymbol),
                }),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_refresh_workspace", {
        title: "Refresh Workspace Snapshot",
        description: "Invalidate and rebuild the persisted workspace snapshot for the active workspace.",
        inputSchema: emptyInputSchema,
        outputSchema: refreshWorkspaceOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async () => {
        try {
            const service = await getWorkspaceService();
            const result = await service.refresh();
            return {
                content: [
                    {
                        type: "text",
                        text: `Workspace snapshot refreshed for ${result.fileCount} indexed file(s).`,
                    },
                ],
                structuredContent: toStructuredContent(result),
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_analyze_components", {
        title: "Analyze ArkTS Components",
        description: "Analyze the decorated ArkTS component structure for a target file.",
        inputSchema: analyzerInputSchema,
        outputSchema: componentOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
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
                        type: "text",
                        text: components.length === 0
                            ? `No decorated ArkTS components found in ${context.targetFile}.`
                            : `Found ${components.length} decorated ArkTS component(s) in ${context.targetFile}.`,
                    },
                ],
                structuredContent,
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_get_diagnostics", {
        title: "Get ArkTS Diagnostics",
        description: "Collect lexical, syntactic, and semantic diagnostics for a target file.",
        inputSchema: analyzerInputSchema,
        outputSchema: diagnosticsOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
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
                        type: "text",
                        text: diagnostics.length === 0
                            ? `No diagnostics found for ${context.targetFile}.`
                            : `Found ${diagnostics.length} diagnostic(s) for ${context.targetFile}.`,
                    },
                ],
                structuredContent,
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    server.registerTool("arkts_find_definition", {
        title: "Find ArkTS Definition",
        description: "Find the symbol definition at a 1-based line and character in the target file.",
        inputSchema: analyzerInputSchema.extend({
            position: positionSchema,
        }),
        outputSchema: definitionOutputSchema,
        annotations: {
            readOnlyHint: true,
        },
    }, async (input) => {
        try {
            const context = createRequestContext(input);
            const definition = context.analyzer.findDefinition(context.targetFile, toAnalyzerPosition(input.position));
            const structuredContent = {
                targetFile: context.targetFile,
                queryPosition: input.position,
                definition: definition ? toExternalDefinition(definition) : null,
            };
            return {
                content: [
                    {
                        type: "text",
                        text: structuredContent.definition === null
                            ? `No definition found at ${context.targetFile}:${input.position.line}:${input.position.character}.`
                            : `Definition for ${structuredContent.definition.symbolName} found at ${structuredContent.definition.fileName}:${structuredContent.definition.range.start.line}:${structuredContent.definition.range.start.character}.`,
                    },
                ],
                structuredContent,
            };
        }
        catch (error) {
            return toToolErrorResult(error);
        }
    });
    return server;
}
export async function main() {
    const transport = new StdioServerTransport();
    const server = createArkTSMcpServer();
    await server.connect(transport);
    console.error("ArkTS MCP server running on stdio");
}
function createRequestContext(input) {
    const targetFile = normalizeInputPath(input.targetFile);
    const overlayEntries = collectOverlayEntries(input.files);
    const targetFileIdentity = canonicalizeInternalFileName(targetFile);
    const overlayFiles = new Set(overlayEntries.map(([fileName]) => canonicalizeInternalFileName(fileName)));
    if (!overlayFiles.has(targetFileIdentity) && !existsSync(targetFile)) {
        throw new Error(`Target file does not exist: ${targetFile}`);
    }
    const rootNames = dedupePaths([
        targetFile,
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
function collectOverlayEntries(files) {
    const overlays = new Map();
    for (const file of files ?? []) {
        const normalizedFileName = normalizeInputPath(file.fileName);
        overlays.set(canonicalizeInternalFileName(normalizedFileName), [
            normalizedFileName,
            file.content,
        ]);
    }
    return [...overlays.values()];
}
function normalizeInputPath(fileName) {
    const resolvedPath = path.normalize(path.isAbsolute(fileName) ? fileName : path.resolve(process.cwd(), fileName));
    if (!existsSync(resolvedPath)) {
        return resolvedPath;
    }
    try {
        return realpathSync.native?.(resolvedPath) ?? realpathSync(resolvedPath);
    }
    catch {
        return resolvedPath;
    }
}
function dedupePaths(fileNames) {
    return dedupeFileNamesByInternalIdentity(fileNames);
}
function toAnalyzerPosition(position) {
    return {
        line: position.line - 1,
        character: position.character - 1,
    };
}
function toExternalPosition(position) {
    return {
        line: position.line + 1,
        character: position.character + 1,
    };
}
function toExternalRange(range) {
    return {
        start: toExternalPosition(range.start),
        end: toExternalPosition(range.end),
    };
}
function toExternalStateMember(stateMember) {
    return {
        name: stateMember.name,
        decorator: stateMember.decorator,
        range: toExternalRange(stateMember.range),
    };
}
function toExternalDecoratedMember(member) {
    return {
        name: member.name,
        decorator: member.decorator,
        kind: member.kind,
        range: toExternalRange(member.range),
    };
}
function toExternalComponent(component) {
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
function toExternalDiagnostic(diagnostic) {
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
function toExternalDefinition(definition) {
    return {
        fileName: normalizeInputPath(definition.fileName),
        range: toExternalRange(definition.range),
        symbolName: definition.symbolName,
    };
}
function toExternalHoverTag(tag) {
    return {
        name: tag.name,
        text: tag.text,
    };
}
function toExternalHover(hover) {
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
function toExternalReference(reference) {
    return {
        fileName: normalizeInputPath(reference.fileName),
        range: toExternalRange(reference.range),
        symbolName: reference.symbolName,
        isDefinition: reference.isDefinition,
        isWriteAccess: reference.isWriteAccess,
    };
}
function toExternalDocumentSymbol(symbol) {
    return {
        name: symbol.name,
        kind: symbol.kind,
        detail: symbol.detail,
        range: toExternalRange(symbol.range),
        selectionRange: toExternalRange(symbol.selectionRange),
        children: symbol.children.map(toExternalDocumentSymbol),
    };
}
function toToolErrorResult(error) {
    const message = error instanceof Error ? error.message : "Unknown ArkTS MCP server error.";
    return {
        content: [
            {
                type: "text",
                text: message,
            },
        ],
        isError: true,
    };
}
function toStructuredContent(value) {
    return value;
}
function isMainModule() {
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
//# sourceMappingURL=mcp-server.js.map