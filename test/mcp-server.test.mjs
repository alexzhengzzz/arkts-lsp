import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve(process.cwd(), "dist/mcp-server.js");
const workspaceIndexScriptPath = path.resolve(process.cwd(), "dist/build-workspace-index.js");

test("MCP server lists the required ArkTS tools", async () => {
  await withClient({}, async (client) => {
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name).sort();

    assert.deepEqual(toolNames, [
      "arkts_analyze_components",
      "arkts_document_symbols",
      "arkts_explain_module",
      "arkts_find_definition",
      "arkts_find_implementation",
      "arkts_find_references",
      "arkts_find_symbol",
      "arkts_find_type_definition",
      "arkts_get_diagnostics",
      "arkts_get_evidence_context",
      "arkts_get_related_files",
      "arkts_hover",
      "arkts_read_source_excerpt",
      "arkts_refresh_workspace",
      "arkts_summarize_file",
      "arkts_trace_dependencies",
      "arkts_workspace_overview",
    ]);
    assert.ok(result.tools.every((tool) => tool.annotations?.readOnlyHint === true));
  });
});

test("arkts_analyze_components resolves relative paths, honors overlays, and returns 1-based ranges", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "arkts-mcp-components-"));

  try {
    const targetFile = path.join(tempDir, "main.ets");

    await writeFile(
      targetFile,
      "class Placeholder {}\n",
      "utf8",
    );
    const expectedTargetFile = await realpath(targetFile);

    await withClient({ cwd: tempDir }, async (client) => {
      const result = await client.callTool({
        name: "arkts_analyze_components",
        arguments: {
          targetFile: "main.ets",
          files: [
            {
              fileName: "main.ets",
              content: `@Preview
@Entry
@Component
struct Home {
  @State message: string = "hello";
  @Prop title: string = "Greeting";

  @Watch("message")
  onMessageChange(): void {}

  build() {}
}
`,
            },
          ],
        },
      });
      const data = getStructuredContent(result);

      assert.equal(data.targetFile, expectedTargetFile);
      assert.equal(data.components.length, 1);
      assert.equal(data.components[0].name, "Home");
      assert.equal(data.components[0].fileName, expectedTargetFile);
      assert.deepEqual(data.components[0].componentDecorators, ["Preview", "Entry", "Component"]);
      assert.equal(data.components[0].stateMembers[0].name, "message");
      assert.deepEqual(
        data.components[0].decoratedMembers.map((member) => ({
          name: member.name,
          decorator: member.decorator,
          kind: member.kind,
        })),
        [
          { name: "message", decorator: "State", kind: "state" },
          { name: "title", decorator: "Prop", kind: "prop" },
          { name: "onMessageChange", decorator: "Watch", kind: "other" },
        ],
      );
      assert.deepEqual(data.components[0].stateMembers[0].range.start, {
        line: 5,
        character: 3,
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("arkts_get_diagnostics returns lexical, syntactic, and semantic diagnostics without intrinsic noise", async () => {
  await withClient({}, async (client) => {
    const lexicalResult = await client.callTool({
      name: "arkts_get_diagnostics",
      arguments: {
        targetFile: "virtual/lexical.ets",
        files: [
          {
            fileName: "virtual/lexical.ets",
            content: `@Entry
@Component
struct Home {
  @State title: string = "hello
}
`,
          },
          {
            fileName: "virtual/syntactic.ets",
            content: `@Entry
@Component
struct Broken {
  build( {
}
`,
          },
          {
            fileName: "virtual/helper.ts",
            content: `export const helper = 1;
`,
          },
          {
            fileName: "virtual/semantic.ets",
            content: `@Entry
@Component
struct Home {
  build() {
    const broken: string = 1;
    missingSymbol;
  }
}
`,
          },
        ],
      },
    });
    const lexicalData = getStructuredContent(lexicalResult);

    const syntacticResult = await client.callTool({
      name: "arkts_get_diagnostics",
      arguments: {
        targetFile: "virtual/syntactic.ets",
        files: [
          {
            fileName: "virtual/syntactic.ets",
            content: `@Entry
@Component
struct Broken {
  build( {
}
`,
          },
        ],
      },
    });
    const syntacticData = getStructuredContent(syntacticResult);

    const semanticResult = await client.callTool({
      name: "arkts_get_diagnostics",
      arguments: {
        targetFile: "virtual/semantic.ets",
        files: [
          {
            fileName: "virtual/semantic.ets",
            content: `@Entry
@Component
struct Home {
  build() {
    const broken: string = 1;
    missingSymbol;
  }
}
`,
          },
        ],
      },
    });
    const semanticData = getStructuredContent(semanticResult);

    assert.equal(
      lexicalData.targetFile,
      path.resolve(process.cwd(), "virtual/lexical.ets"),
    );
    assert.ok(
      lexicalData.diagnostics.some((diagnostic) => diagnostic.category === "lexical"),
    );
    assert.ok(
      syntacticData.diagnostics.some(
        (diagnostic) => diagnostic.category === "syntactic",
      ),
    );
    assert.ok(
      semanticData.diagnostics.some((diagnostic) => diagnostic.category === "semantic"),
    );
    assert.ok(
      semanticData.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("Type 'number'"),
      ),
    );
    assert.ok(
      semanticData.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("Cannot find name 'missingSymbol'"),
      ),
    );
    assert.ok(
      [lexicalData, syntacticData, semanticData].every((data) =>
        data.diagnostics.every(
          (diagnostic) =>
            !diagnostic.message.includes("Cannot find name 'Entry'") &&
            !diagnostic.message.includes("Cannot find name 'Component'") &&
            !diagnostic.message.includes("Cannot find name 'State'"),
        ),
      ),
    );
  });
});

test("arkts_get_diagnostics accepts common ArkTS decorator factories", async () => {
  const source = `type Profile = { id: number };

@Preview
@Entry
@Component
struct Dashboard {
  @State title: string = "hello";
  @Prop subtitle: string = "subtitle";
  @Link selectedId: number = 1;
  @ObjectLink profile: Profile = { id: 1 };
  @Provide providedCount: number = 1;
  @Consume consumedCount: number = 0;
  @StorageProp("token") token: string = "";
  @StorageLink("loggedIn") loggedIn: boolean = false;
  @LocalStorageProp("theme") theme: string = "light";
  @LocalStorageLink("locale") locale: string = "en";
  @BuilderParam renderHeader: () => void = () => {};
  @Local localCount: number = 0;

  @Watch("title")
  onTitleChange(): void {
    missingSymbol;
  }

  build() {}
}
`;

  await withClient({}, async (client) => {
    const result = await client.callTool({
      name: "arkts_get_diagnostics",
      arguments: {
        targetFile: "virtual/common.ets",
        files: [
          {
            fileName: "virtual/common.ets",
            content: source,
          },
        ],
      },
    });
    const data = getStructuredContent(result);

    assert.ok(
      data.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("Cannot find name 'missingSymbol'"),
      ),
    );
    assert.ok(
      data.diagnostics.every(
        (diagnostic) =>
          !diagnostic.message.includes("Cannot find name 'Preview'") &&
          !diagnostic.message.includes("Cannot find name 'Prop'") &&
          !diagnostic.message.includes("Cannot find name 'Link'") &&
          !diagnostic.message.includes("Cannot find name 'ObjectLink'") &&
          !diagnostic.message.includes("Cannot find name 'Provide'") &&
          !diagnostic.message.includes("Cannot find name 'Consume'") &&
          !diagnostic.message.includes("Cannot find name 'StorageProp'") &&
          !diagnostic.message.includes("Cannot find name 'StorageLink'") &&
          !diagnostic.message.includes("Cannot find name 'LocalStorageProp'") &&
          !diagnostic.message.includes("Cannot find name 'LocalStorageLink'") &&
          !diagnostic.message.includes("Cannot find name 'BuilderParam'") &&
          !diagnostic.message.includes("Cannot find name 'Local'") &&
          !diagnostic.message.includes("Cannot find name 'Watch'") &&
          !diagnostic.message.includes("This expression is not callable"),
      ),
    );
  });
});

test("arkts_analyze_components recognizes ComponentV2 and V2 member decorators", async () => {
  const source = `@ComponentV2
struct Dashboard {
  @Param @Require title: string;
  @Local count: number = 0;
  @Computed summary: string = "ready";

  build() {}

  @Builder
  buildFooter() {}
}
`;

  await withClient({}, async (client) => {
    const result = await client.callTool({
      name: "arkts_analyze_components",
      arguments: {
        targetFile: "virtual/component-v2.ets",
        files: [
          {
            fileName: "virtual/component-v2.ets",
            content: source,
          },
        ],
      },
    });
    const data = getStructuredContent(result);

    assert.equal(data.components.length, 1);
    assert.deepEqual(data.components[0].componentDecorators, ["ComponentV2"]);
    assert.deepEqual(
      data.components[0].stateMembers.map((member) => `${member.name}:${member.decorator}`),
      ["count:Local"],
    );
    assert.deepEqual(
      data.components[0].decoratedMembers.map((member) => `${member.name}:${member.decorator}:${member.kind}`),
      [
        "title:Param:param",
        "title:Require:require",
        "count:Local:local",
        "summary:Computed:computed",
        "buildFooter:Builder:other",
      ],
    );
  });
});

test("arkts_analyze_components matches Windows overlay paths across slash and drive-letter variants", {
  skip: process.platform !== "win32",
}, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "arkts-mcp-windows-components-"));

  try {
    const source = `@ComponentV2
struct Dashboard {
  @Param @Require title: string;
  @Local count: number = 0;
  @Computed summary: string = "ready";

  build() {}

  @Builder
  buildFooter() {}
}
`;

    await withClient({ cwd: tempDir }, async (client) => {
      const relativeTargetFile = path.join("src", "component-v2.ets");
      const normalizedTargetFile = path.resolve(tempDir, relativeTargetFile);
      const result = await client.callTool({
        name: "arkts_analyze_components",
        arguments: {
          targetFile: relativeTargetFile,
          files: [
            {
              fileName: toMixedWindowsPath(normalizedTargetFile),
              content: source,
            },
          ],
        },
      });
      const data = getStructuredContent(result);

      assert.equal(data.targetFile, normalizedTargetFile);
      assert.equal(data.components.length, 1);
      assert.deepEqual(data.components[0].componentDecorators, ["ComponentV2"]);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("arkts_get_diagnostics accepts AI-OHOSAPP-style ComponentV2 UI DSL without compatibility noise", async () => {
  const source = `import { router, curves } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';

@ObservedV2
class PanelState {
  @Trace count: number = 0;
}

@ComponentV2
struct Dashboard {
  @Param @Require title: string;
  @Local count: number = 0;
  @Computed summary: string = "ready";

  build() {
    Column() {
      Text(this.title)
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
      Button() {
        Text("Go")
          .fontColor(Color.White)
      }
      .type(ButtonType.Capsule)
      .onClick(() => {
        animateTo({ curve: Curve.EaseInOut }, () => {
          this.count += 1;
        });
      })
    }
    .width('100%')
    .backgroundColor($r('app.color.primary'))

    void router;
    void curves;
    void BusinessError;
  }

  @Builder
  buildFooter() {
    Row() {
      Blank();
    }
  }
}
`;

  await withClient({}, async (client) => {
    const result = await client.callTool({
      name: "arkts_get_diagnostics",
      arguments: {
        targetFile: "virtual/component-v2-ui.ets",
        files: [
          {
            fileName: "virtual/component-v2-ui.ets",
            content: source,
          },
        ],
      },
    });
    const data = getStructuredContent(result);

    assert.ok(
      data.diagnostics.every(
        (diagnostic) =>
          !diagnostic.message.includes("Cannot find module '@kit.") &&
          !diagnostic.message.includes("Cannot find name 'ComponentV2'") &&
          !diagnostic.message.includes("Cannot find name 'ObservedV2'") &&
          !diagnostic.message.includes("Cannot find name 'Trace'") &&
          !diagnostic.message.includes("Cannot find name 'Param'") &&
          !diagnostic.message.includes("Cannot find name 'Require'") &&
          !diagnostic.message.includes("Cannot find name 'Computed'") &&
          !diagnostic.message.includes("Cannot find name 'Local'") &&
          !diagnostic.message.includes("Cannot find name 'Builder'") &&
          !diagnostic.message.includes("Cannot find name 'Column'") &&
          !diagnostic.message.includes("Cannot find name 'Row'") &&
          !diagnostic.message.includes("Cannot find name 'Text'") &&
          !diagnostic.message.includes("Cannot find name 'Button'") &&
          !diagnostic.message.includes("Cannot find name '$r'") &&
          !diagnostic.message.includes("Cannot find name 'animateTo'") &&
          !diagnostic.message.includes("Cannot find name 'Color'") &&
          !diagnostic.message.includes("Cannot find name 'FontWeight'") &&
          !diagnostic.message.includes("Cannot find name 'Curve'") &&
          !diagnostic.message.includes("Cannot find name 'ButtonType'"),
      ),
    );
    assert.ok(
      data.diagnostics.every(
        (diagnostic) =>
          diagnostic.confidence === "high" || diagnostic.confidence === "low",
      ),
    );
  });
});

test("arkts_find_definition resolves imported aliases and returns null for intrinsic decorators", async () => {
  const mainSource = `import { externalValue as aliasedValue } from "./helper.ts";

@Entry
@Component
struct Home {
  value: number = aliasedValue;

  build() {
    const localValue = this.value;
    return localValue;
  }
}
`;

  await withClient({}, async (client) => {
    const aliasResult = await client.callTool({
      name: "arkts_find_definition",
      arguments: {
        targetFile: "virtual/main.ets",
        files: [
          {
            fileName: "virtual/main.ets",
            content: mainSource,
          },
          {
            fileName: "virtual/helper.ts",
            content: `export const externalValue = 42;
`,
          },
        ],
        position: positionOf(mainSource, "aliasedValue", "last"),
      },
    });
    const aliasData = getStructuredContent(aliasResult);

    assert.equal(aliasData.definition?.fileName, path.resolve(process.cwd(), "virtual/helper.ts"));
    assert.equal(aliasData.definition?.symbolName, "externalValue");

    const intrinsicResult = await client.callTool({
      name: "arkts_find_definition",
      arguments: {
        targetFile: "virtual/main.ets",
        files: [
          {
            fileName: "virtual/main.ets",
            content: mainSource,
          },
          {
            fileName: "virtual/helper.ts",
            content: `export const externalValue = 42;
`,
          },
        ],
        position: positionOf(mainSource, "Entry", "first"),
      },
    });
    const intrinsicData = getStructuredContent(intrinsicResult);

    assert.equal(intrinsicData.definition, null);
  });
});

test("language-service MCP tools return hover, references, implementations, type definitions, and document symbols", async () => {
  const workspace = await createLanguageServiceWorkspaceFixture("arkts-mcp-language-service-");

  try {
    await withClient({}, async (client) => {
      const hoverResult = await client.callTool({
        name: "arkts_hover",
        arguments: {
          workspaceRoot: workspace.root,
          targetFile: "src/App.ets",
          position: positionOf(workspace.appSource, "useGreeter", "last"),
        },
      });
      const hover = getStructuredContent(hoverResult);
      assert.match(
        hover.hover?.displayText ?? "",
        /useGreeter\(greeter: Greeter\): string/,
      );

      const referencesResult = await client.callTool({
        name: "arkts_find_references",
        arguments: {
          workspaceRoot: workspace.root,
          targetFile: "src/App.ets",
          position: positionOf(workspace.appSource, "useGreeter", "last"),
        },
      });
      const references = getStructuredContent(referencesResult);
      assert.ok(references.references.some((reference) =>
        reference.fileName === workspace.helperFile && reference.isDefinition
      ));
      assert.ok(references.references.some((reference) =>
        reference.fileName === workspace.appFile && !reference.isDefinition
      ));

      const implementationResult = await client.callTool({
        name: "arkts_find_implementation",
        arguments: {
          workspaceRoot: workspace.root,
          targetFile: "src/App.ets",
          position: positionOf(workspace.appSource, "Greeter =", "first"),
        },
      });
      const implementations = getStructuredContent(implementationResult);
      assert.ok(implementations.locations.some((location) =>
        location.fileName === workspace.helperFile && location.symbolName === "ConsoleGreeter"
      ));

      const typeDefinitionResult = await client.callTool({
        name: "arkts_find_type_definition",
        arguments: {
          workspaceRoot: workspace.root,
          targetFile: "src/App.ets",
          position: positionOf(workspace.appSource, "greeter", "last"),
        },
      });
      const typeDefinitions = getStructuredContent(typeDefinitionResult);
      assert.ok(typeDefinitions.locations.some((location) =>
        location.fileName === workspace.helperFile && location.symbolName === "Greeter"
      ));

      const documentSymbolsResult = await client.callTool({
        name: "arkts_document_symbols",
        arguments: {
          workspaceRoot: workspace.root,
          targetFile: "src/App.ets",
        },
      });
      const symbols = getStructuredContent(documentSymbolsResult);
      const homeSymbol =
        symbols.symbols.find((symbol) => symbol.name === "Home") ??
        symbols.symbols
          .flatMap((symbol) => symbol.children)
          .find((symbol) => symbol.name === "Home");
      assert.ok(homeSymbol);
      assert.ok(homeSymbol.children.some((symbol) => symbol.name === "build"));
    });
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("workspace MCP tools build repo maps, honor overlays, and refresh snapshots", async () => {
  const workspace = await createWorkspaceFixture("arkts-mcp-workspace-");
  const cacheDir = path.join(workspace.root, ".cache-test");
  const limitedCacheDir = path.join(workspace.root, ".cache-limited");
  const unlimitedCacheDir = path.join(workspace.root, ".cache-unlimited");

  try {
    await withClient({}, async (client) => {
      const limitedOverviewResult = await client.callTool({
        name: "arkts_workspace_overview",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir: limitedCacheDir,
          maxFiles: 1,
        },
      });
      const limitedOverview = getStructuredContent(limitedOverviewResult);
      assert.equal(limitedOverview.fileCount, 1);
      assert.equal(limitedOverview.truncated, true);

      const unlimitedOverviewResult = await client.callTool({
        name: "arkts_workspace_overview",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir: unlimitedCacheDir,
          maxFiles: null,
        },
      });
      const unlimitedOverview = getStructuredContent(unlimitedOverviewResult);
      assert.equal(unlimitedOverview.fileCount, 4);
      assert.equal(unlimitedOverview.truncated, false);

      const overviewResult = await client.callTool({
        name: "arkts_workspace_overview",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
        },
      });
      const overview = getStructuredContent(overviewResult);
      assert.equal(overview.fileCount, 4);
      assert.ok(overview.hotFiles.length <= 10);

      const summaryResult = await client.callTool({
        name: "arkts_summarize_file",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          targetFile: "src/App.ets",
          files: [
            {
              fileName: "src/App.ets",
              content: `import { Card } from "./Card.ets";
import { greet } from "./utils/helper.ts";

@Preview
@Entry
@Component
struct App {
  @State count: number = 0;
  @Prop subtitle: string = "overlay";
  @State title: string = "overlay";

  @Watch("count")
  onCountChange(): void {}

  build() {
    greet();
    const card = new Card();
    return card;
  }
}
`,
            },
          ],
        },
      });
      const summary = getStructuredContent(summaryResult);
      assert.deepEqual(
        summary.components[0].stateMembers.map((member) => member.name),
        ["count", "title"],
      );
      assert.deepEqual(
        summary.components[0].decoratedMembers.map((member) => ({
          name: member.name,
          decorator: member.decorator,
          kind: member.kind,
        })),
        [
          { name: "count", decorator: "State", kind: "state" },
          { name: "subtitle", decorator: "Prop", kind: "prop" },
          { name: "title", decorator: "State", kind: "state" },
          { name: "onCountChange", decorator: "Watch", kind: "other" },
        ],
      );
      assert.match(summary.summary, /recognized decorated member\(s\)/);

      const symbolResult = await client.callTool({
        name: "arkts_find_symbol",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          query: "greet",
        },
      });
      const symbols = getStructuredContent(symbolResult);
      assert.ok(symbols.matches.some((match) => match.fileName === workspace.helperFile));

      const relatedResult = await client.callTool({
        name: "arkts_get_related_files",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          targetFile: "src/App.ets",
          limit: 4,
        },
      });
      const related = getStructuredContent(relatedResult);
      assert.equal(related.rootFile, workspace.appFile);
      assert.equal(related.provenance, "snapshot");
      assert.ok(
        related.files.some((file) => file.fileName === workspace.helperFile),
      );
      assert.ok(
        related.files.every((file) =>
          typeof file.snippet === "string" &&
          typeof file.snippetTruncated === "boolean" &&
          file.provenance &&
          file.evidenceLevel === "summary" &&
          file.snippetRange
        ),
      );

      const excerptResult = await client.callTool({
        name: "arkts_read_source_excerpt",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          targetFile: "src/utils/helper.ts",
          symbolQuery: "greet",
          maxLines: 20,
        },
      });
      const excerpt = getStructuredContent(excerptResult);
      assert.equal(excerpt.targetFile, workspace.helperFile);
      assert.equal(excerpt.excerpt.provenance, "snapshot");
      assert.equal(excerpt.excerpt.evidenceLevel, "source");
      assert.match(excerpt.excerpt.content, /export function greet/);

      const evidenceResult = await client.callTool({
        name: "arkts_get_evidence_context",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          targetFile: "src/App.ets",
          question: "哪里构造 Card 并调用 helper",
          includeRelated: true,
          snippetCount: 3,
          budgetChars: 4000,
        },
      });
      const evidence = getStructuredContent(evidenceResult);
      assert.equal(evidence.rootFile, workspace.appFile);
      assert.equal(evidence.provenance, "snapshot");
      assert.ok(evidence.snippets.length >= 1);
      assert.ok(evidence.snippets.some((snippet) =>
        snippet.fileName === workspace.appFile &&
        snippet.content.includes("const card = new Card()")
      ));
      assert.ok(evidence.snippets.every((snippet) =>
        snippet.evidenceLevel === "source" &&
        typeof snippet.truncated === "boolean" &&
        snippet.provenance &&
        snippet.range
      ));

      const liveEvidenceResult = await client.callTool({
        name: "arkts_get_evidence_context",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          targetFile: "src/App.ets",
          symbolQuery: "App",
          snippetCount: 2,
          budgetChars: 1200,
          files: [
            {
              fileName: "src/App.ets",
              content: `import { Card } from "./Card.ets";
import { greet } from "./utils/helper.ts";

@Entry
@Component
struct App {
  build() {
    greet();
    return "overlay";
  }
}
`,
            },
          ],
        },
      });
      const liveEvidence = getStructuredContent(liveEvidenceResult);
      assert.equal(liveEvidence.provenance, "live");
      assert.ok(liveEvidence.snippets.some((snippet) =>
        snippet.provenance === "live" && snippet.content.includes('return "overlay"')
      ));

      const traceResult = await client.callTool({
        name: "arkts_trace_dependencies",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          targetFile: "src/App.ets",
          depth: 2,
        },
      });
      const trace = getStructuredContent(traceResult);
      assert.equal(trace.provenance, "snapshot");
      assert.ok(trace.nodes.some((node) => node.fileName === workspace.appFile));
      assert.ok(trace.edges.some((edge) => edge.to === workspace.helperFile));

      await writeFile(
        workspace.helperFile,
        `export function renamedHelper(): string {
  return "updated";
}
`,
        "utf8",
      );

      const refreshResult = await client.callTool({
        name: "arkts_refresh_workspace",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          changedFiles: ["src/utils/helper.ts"],
        },
      });
      const refresh = getStructuredContent(refreshResult);
      assert.equal(refresh.fileCount, 4);
      assert.equal(refresh.refreshMode, "incremental");
      assert.equal(refresh.changedFileCount, 1);
      assert.equal(refresh.reindexedFileCount, 3);
      assert.equal(refresh.reusedFileCount, 1);

      const refreshedSymbolResult = await client.callTool({
        name: "arkts_find_symbol",
        arguments: {
          workspaceRoot: workspace.root,
          cacheDir,
          query: "renamedHelper",
        },
      });
      const refreshedSymbols = getStructuredContent(refreshedSymbolResult);
      assert.equal(refreshedSymbols.matches[0]?.fileName, workspace.helperFile);
    });
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("workspace index CLI builds and refreshes a workspace snapshot", async () => {
  const workspace = await createWorkspaceFixture("arkts-workspace-index-cli-");

  try {
    const result = spawnSync(
      process.execPath,
      [workspaceIndexScriptPath, workspace.root, "--json", "--max-files", "null"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.workspaceRoot, workspace.root);
    assert.equal(data.fileCount, 4);
    assert.equal(data.truncated, false);
    assert.equal(typeof data.refreshMode, "string");
    assert.match(data.overview, /Workspace indexes 4 file\(s\)/);
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
});

async function withClient(options, fn) {
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: options.cwd,
    stderr: "pipe",
  });
  const stderrStream = transport.stderr;
  stderrStream?.setEncoding?.("utf8");
  stderrStream?.on("data", (chunk) => {
    stderr.push(String(chunk));
  });

  const client = new Client(
    {
      name: "arkts-analyzer-test-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  try {
    await client.connect(transport);
    await fn(client);
  } catch (error) {
    if (error instanceof Error && stderr.length > 0) {
      error.message = `${error.message}\nServer stderr:\n${stderr.join("")}`;
    }

    throw error;
  } finally {
    await client.close().catch(() => {});
  }
}

function getStructuredContent(result) {
  assert.ok(!("toolResult" in result), "Expected a standard tool result payload.");
  assert.ok(result.structuredContent, "Expected structuredContent in tool result.");
  return result.structuredContent;
}

function toMixedWindowsPath(fileName) {
  return fileName
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:/, (drive) =>
      drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase(),
    );
}

function positionOf(source, text, occurrence) {
  const index =
    occurrence === "last" ? source.lastIndexOf(text) : source.indexOf(text);
  assert.notEqual(index, -1, `Missing text "${text}" in source.`);

  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  const line = lines.length;
  const lastLine = lines.at(-1) ?? "";

  return {
    line,
    character: lastLine.length + 1,
  };
}

async function createWorkspaceFixture(prefix) {
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await realpath(createdRoot);
  const srcDir = path.join(root, "src");
  const utilsDir = path.join(srcDir, "utils");
  const ignoredDir = path.join(root, "node_modules", "ignored");
  await mkdir(utilsDir, { recursive: true });
  await mkdir(ignoredDir, { recursive: true });

  const appFile = path.join(srcDir, "App.ets");
  const cardFile = path.join(srcDir, "Card.ets");
  const helperFile = path.join(utilsDir, "helper.ts");
  const barrelFile = path.join(srcDir, "barrel.ts");

  await writeFile(
    appFile,
    `import { Card } from "./Card.ets";
import { greet } from "./utils/helper.ts";

@Entry
@Component
struct App {
  @State count: number = 0;
  build() {
    greet();
    const card = new Card();
    return card;
  }
}
`,
    "utf8",
  );
  await writeFile(
    cardFile,
    `@Component
export struct Card {
  build() {}
}
`,
    "utf8",
  );
  await writeFile(
    helperFile,
    `export const helperValue = 1;

export function greet(): number {
  return helperValue;
}
`,
    "utf8",
  );
  await writeFile(
    barrelFile,
    `export { greet } from "./utils/helper.ts";
`,
    "utf8",
  );
  await writeFile(
    path.join(ignoredDir, "index.ts"),
    `export const ignored = true;
`,
    "utf8",
  );

  return {
    root,
    appFile,
    cardFile,
    helperFile,
    barrelFile,
  };
}

async function createLanguageServiceWorkspaceFixture(prefix) {
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await realpath(createdRoot);
  const srcDir = path.join(root, "src");
  await mkdir(srcDir, { recursive: true });

  const appFile = path.join(srcDir, "App.ets");
  const helperFile = path.join(srcDir, "greeter.ts");
  const helperSource = `export interface Greeter {
  greet(name: string): string;
}

export class ConsoleGreeter implements Greeter {
  greet(name: string): string {
    return name.toUpperCase();
  }
}

export function useGreeter(greeter: Greeter): string {
  return greeter.greet("Ada");
}
`;
  const appSource = `import { ConsoleGreeter, useGreeter, type Greeter } from "./greeter.ts";

@Entry
@Component
struct Home {
  greeter: Greeter = new ConsoleGreeter();

  build() {
    const message = useGreeter(this.greeter);
    return message;
  }
}
`;

  await writeFile(appFile, appSource, "utf8");
  await writeFile(helperFile, helperSource, "utf8");

  return {
    root,
    appFile,
    helperFile,
    appSource,
    helperSource,
  };
}
