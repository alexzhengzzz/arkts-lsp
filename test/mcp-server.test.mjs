import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = path.resolve(process.cwd(), "dist/mcp-server.js");

test("MCP server lists the required ArkTS tools", async () => {
  await withClient({}, async (client) => {
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name).sort();

    assert.deepEqual(toolNames, [
      "arkts_analyze_components",
      "arkts_find_definition",
      "arkts_get_diagnostics",
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
              content: `@Entry
@Component
struct Home {
  @State message: string = "hello";
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
      assert.deepEqual(data.components[0].componentDecorators, ["Entry", "Component"]);
      assert.equal(data.components[0].stateMembers[0].name, "message");
      assert.deepEqual(data.components[0].stateMembers[0].range.start, {
        line: 4,
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
