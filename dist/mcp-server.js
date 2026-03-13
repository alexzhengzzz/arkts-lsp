import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { ArkTSAnalyzer, } from "./core/arkts-analyzer.js";
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
};
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
    })),
};
const diagnosticsOutputSchema = {
    targetFile: z.string(),
    diagnostics: z.array(z.object({
        fileName: z.string(),
        category: z.enum(["lexical", "syntactic", "semantic"]),
        code: z.number().int(),
        message: z.string(),
        range: rangeSchema,
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
export function createArkTSMcpServer() {
    const server = new McpServer(serverInfo);
    server.registerTool("arkts_analyze_components", {
        title: "Analyze ArkTS Components",
        description: "Analyze the decorated ArkTS component structure for a target file.",
        inputSchema: workspaceInputSchema,
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
        inputSchema: workspaceInputSchema,
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
        inputSchema: {
            ...workspaceInputSchema,
            position: positionSchema,
        },
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
function collectOverlayEntries(files) {
    const overlays = new Map();
    for (const file of files ?? []) {
        overlays.set(normalizeInputPath(file.fileName), file.content);
    }
    return [...overlays.entries()];
}
function normalizeInputPath(fileName) {
    return path.normalize(path.isAbsolute(fileName) ? fileName : path.resolve(process.cwd(), fileName));
}
function dedupePaths(fileNames) {
    return [...new Set(fileNames)];
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
function toExternalComponent(component) {
    return {
        fileName: normalizeInputPath(component.fileName),
        name: component.name,
        range: toExternalRange(component.range),
        isEntry: component.isEntry,
        componentDecorators: component.componentDecorators,
        stateMembers: component.stateMembers.map(toExternalStateMember),
    };
}
function toExternalDiagnostic(diagnostic) {
    return {
        fileName: normalizeInputPath(diagnostic.fileName),
        category: diagnostic.category,
        code: diagnostic.code,
        message: diagnostic.message,
        range: toExternalRange(diagnostic.range),
    };
}
function toExternalDefinition(definition) {
    return {
        fileName: normalizeInputPath(definition.fileName),
        range: toExternalRange(definition.range),
        symbolName: definition.symbolName,
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