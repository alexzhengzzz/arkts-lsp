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
  type DefinitionLocation,
  type StateMemberInfo,
} from "./core/arkts-analyzer.js";

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

interface ExternalComponentInfo {
  fileName: string;
  name: string;
  range: ExternalRange;
  isEntry: boolean;
  componentDecorators: string[];
  stateMembers: ExternalStateMemberInfo[];
}

interface ExternalDiagnostic {
  fileName: string;
  category: "lexical" | "syntactic" | "semantic";
  code: number;
  message: string;
  range: ExternalRange;
}

interface ExternalDefinitionLocation {
  fileName: string;
  range: ExternalRange;
  symbolName: string;
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
    }),
  ),
} as const;

const diagnosticsOutputSchema = {
  targetFile: z.string(),
  diagnostics: z.array(
    z.object({
      fileName: z.string(),
      category: z.enum(["lexical", "syntactic", "semantic"]),
      code: z.number().int(),
      message: z.string(),
      range: rangeSchema,
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

export function createArkTSMcpServer(): McpServer {
  const server = new McpServer(serverInfo);

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
  };
}

function toExternalDiagnostic(diagnostic: AnalyzerDiagnostic): ExternalDiagnostic {
  return {
    fileName: normalizeInputPath(diagnostic.fileName),
    category: diagnostic.category,
    code: diagnostic.code,
    message: diagnostic.message,
    range: toExternalRange(diagnostic.range),
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
