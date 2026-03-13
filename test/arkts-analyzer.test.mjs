import test from "node:test";
import assert from "node:assert/strict";

import { ArkTSAnalyzer } from "../dist/index.js";

test("collectDiagnostics returns lexical, syntactic, and semantic diagnostics without intrinsic decorator noise", () => {
  const analyzer = new ArkTSAnalyzer({
    rootNames: [
      "/virtual/lexical.ets",
      "/virtual/syntactic.ets",
      "/virtual/semantic.ets",
    ],
  });

  analyzer.setInMemoryFile({
    fileName: "/virtual/lexical.ets",
    content: `@Entry
@Component
struct Home {
  @State title: string = "hello
}
`,
  });

  analyzer.setInMemoryFile({
    fileName: "/virtual/syntactic.ets",
    content: `@Entry
@Component
struct Home {
  build( {
}
`,
  });

  analyzer.setInMemoryFile({
    fileName: "/virtual/semantic.ets",
    content: `@Entry
@Component
struct Home {
  build() {
    const broken: string = 1;
    missingSymbol;
  }
}
`,
  });

  const diagnostics = analyzer.collectDiagnostics();

  assert.ok(diagnostics.some((diagnostic) => diagnostic.category === "lexical"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.category === "syntactic"));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.category === "semantic"));
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.message.includes("Type 'number' is not assignable to type 'string'."),
    ),
  );
  assert.ok(
    diagnostics.every(
      (diagnostic) =>
        !diagnostic.message.includes("Cannot find name 'Entry'") &&
        !diagnostic.message.includes("Cannot find name 'Component'") &&
        !diagnostic.message.includes("Cannot find name 'State'"),
    ),
  );
});

test("findDecoratedComponents identifies entry components and state members from struct declarations", () => {
  const fileName = "/virtual/components.ets";
  const analyzer = new ArkTSAnalyzer({
    rootNames: [fileName],
  });

  analyzer.setInMemoryFile({
    fileName,
    content: `@Entry
@Component
struct Home {
  @State message: string = "hello";
  build() {}
}

@Component
struct PlainComponent {
  build() {}
}

class NonComponent {
  @State value: number = 1;
}
`,
  });

  const components = analyzer.findDecoratedComponents(fileName);

  assert.equal(components.length, 1);
  assert.equal(components[0].name, "Home");
  assert.equal(components[0].isEntry, true);
  assert.deepEqual(components[0].componentDecorators, ["Entry", "Component"]);
  assert.deepEqual(
    components[0].stateMembers.map((member) => member.name),
    ["message"],
  );
});

test("findDefinition resolves local definitions, struct-backed members, aliases, and skips intrinsic decorators", () => {
  const entryFileName = "/virtual/main.ets";
  const helperFileName = "/virtual/helper.ts";
  const analyzer = new ArkTSAnalyzer({
    rootNames: [entryFileName, helperFileName],
  });

  analyzer.setInMemoryFile({
    fileName: helperFileName,
    content: `export const externalValue = 42;
`,
  });

  analyzer.setInMemoryFile({
    fileName: entryFileName,
    content: `import { externalValue as aliasedValue } from "./helper.ts";

@Entry
@Component
struct Home {
  value: number = aliasedValue;

  build() {
    const localValue = this.value;
    return localValue;
  }
}
`,
  });

  const aliasPosition = positionOf(
    analyzer,
    entryFileName,
    "aliasedValue",
    "last",
  );
  const aliasDefinition = analyzer.findDefinition(entryFileName, aliasPosition);
  assert.deepEqual(aliasDefinition?.fileName, helperFileName);
  assert.deepEqual(aliasDefinition?.symbolName, "externalValue");

  const propertyPosition = positionOf(
    analyzer,
    entryFileName,
    "value",
    "last",
  );
  const propertyDefinition = analyzer.findDefinition(entryFileName, propertyPosition);
  assert.equal(propertyDefinition?.fileName, entryFileName);
  assert.equal(propertyDefinition?.symbolName, "value");

  const localPosition = positionOf(
    analyzer,
    entryFileName,
    "localValue",
    "last",
  );
  const localDefinition = analyzer.findDefinition(entryFileName, localPosition);
  assert.equal(localDefinition?.fileName, entryFileName);
  assert.equal(localDefinition?.symbolName, "localValue");

  const entryDecoratorPosition = positionOf(analyzer, entryFileName, "Entry", "first");
  const intrinsicDefinition = analyzer.findDefinition(
    entryFileName,
    entryDecoratorPosition,
  );
  assert.equal(intrinsicDefinition, undefined);
});

function positionOf(analyzer, fileName, text, occurrence) {
  const sourceFile = analyzer.getSourceFile(fileName);
  assert.ok(sourceFile, `Missing source file: ${fileName}`);

  const index =
    occurrence === "last"
      ? sourceFile.text.lastIndexOf(text)
      : sourceFile.text.indexOf(text);
  assert.notEqual(index, -1, `Missing text "${text}" in ${fileName}`);

  return sourceFile.getLineAndCharacterOfPosition(index);
}
