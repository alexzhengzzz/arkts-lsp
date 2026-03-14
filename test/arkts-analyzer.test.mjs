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

test("collectDiagnostics accepts common ArkTS decorators without intrinsic noise", () => {
  const fileName = "/virtual/common-decorators.ets";
  const analyzer = new ArkTSAnalyzer({
    rootNames: [fileName],
  });

  analyzer.setInMemoryFile({
    fileName,
    content: `type Profile = { id: number };

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
`,
  });

  const diagnostics = analyzer.collectDiagnostics(fileName);

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.message.includes("Cannot find name 'missingSymbol'"),
    ),
  );
  assert.ok(
    diagnostics.every(
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

test("collectDiagnostics accepts AI-OHOSAPP-style ComponentV2 UI DSL without compatibility noise", () => {
  const fileName = "/virtual/component-v2.ets";
  const analyzer = new ArkTSAnalyzer({
    rootNames: [fileName],
  });

  analyzer.setInMemoryFile({
    fileName,
    content: `import { router, curves } from '@kit.ArkUI';
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
`,
  });

  const diagnostics = analyzer.collectDiagnostics(fileName);

  assert.ok(
    diagnostics.every(
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
});

test("findDecoratedComponents recognizes ComponentV2 and V2 member decorators", () => {
  const fileName = "/virtual/component-v2-members.ets";
  const analyzer = new ArkTSAnalyzer({
    rootNames: [fileName],
  });

  analyzer.setInMemoryFile({
    fileName,
    content: `@ComponentV2
struct Dashboard {
  @Param @Require title: string;
  @Local count: number = 0;
  @Computed summary: string = "ready";

  build() {}

  @Builder
  buildFooter() {}
}
`,
  });

  const components = analyzer.findDecoratedComponents(fileName);

  assert.equal(components.length, 1);
  assert.deepEqual(components[0].componentDecorators, ["ComponentV2"]);
  assert.deepEqual(
    components[0].stateMembers.map((member) => `${member.name}:${member.decorator}`),
    ["count:Local"],
  );
  assert.deepEqual(
    components[0].decoratedMembers.map((member) => `${member.name}:${member.decorator}:${member.kind}`),
    [
      "title:Param:param",
      "title:Require:require",
      "count:Local:local",
      "summary:Computed:computed",
      "buildFooter:Builder:other",
    ],
  );
});

test("collectDiagnostics resolves extensionless relative .ets imports", () => {
  const entryFileName = "/virtual/main.ets";
  const helperFileName = "/virtual/helper.ets";
  const analyzer = new ArkTSAnalyzer({
    rootNames: [entryFileName, helperFileName],
  });

  analyzer.setInMemoryFile({
    fileName: helperFileName,
    content: `export const message = "hello";
`,
  });

  analyzer.setInMemoryFile({
    fileName: entryFileName,
    content: `import { message } from "./helper";

@ComponentV2
struct Home {
  build() {
    Text(message)
  }
}
`,
  });

  const diagnostics = analyzer.collectDiagnostics(entryFileName);

  assert.ok(
    diagnostics.every(
      (diagnostic) =>
        !diagnostic.message.includes("Cannot find module './helper'"),
    ),
  );
});

test("findDecoratedComponents identifies core component decorators and decorated members", () => {
  const fileName = "/virtual/components.ets";
  const analyzer = new ArkTSAnalyzer({
    rootNames: [fileName],
  });

  analyzer.setInMemoryFile({
    fileName,
    content: `@Preview
@Entry
@Component
struct Home {
  @State message: string = "hello";
  @Prop title: string = "Home";
  @StorageLink("loggedIn") loggedIn: boolean = false;

  @Watch("message")
  onMessageChange(): void {}

  build() {}
}

@Reusable
@Component
struct PlainComponent {
  build() {}
}

@CustomDialog
@Component
struct DialogCard {
  build() {}
}

class NonComponent {
  @State value: number = 1;
}
`,
  });

  const components = analyzer.findDecoratedComponents(fileName);

  assert.equal(components.length, 3);
  assert.deepEqual(
    components.map((component) => component.name),
    ["Home", "PlainComponent", "DialogCard"],
  );
  assert.equal(components[0].isEntry, true);
  assert.deepEqual(components[0].componentDecorators, ["Preview", "Entry", "Component"]);
  assert.deepEqual(
    components[0].stateMembers.map((member) => member.name),
    ["message"],
  );
  assert.deepEqual(
    components[0].decoratedMembers.map((member) => `${member.name}:${member.decorator}:${member.kind}`),
    [
      "message:State:state",
      "title:Prop:prop",
      "loggedIn:StorageLink:storageLink",
      "onMessageChange:Watch:other",
    ],
  );
  assert.deepEqual(components[1].componentDecorators, ["Reusable", "Component"]);
  assert.deepEqual(components[1].decoratedMembers, []);
  assert.deepEqual(components[2].componentDecorators, ["CustomDialog", "Component"]);
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

test("hover, references, implementations, type definitions, and document symbols resolve through the language service", () => {
  const entryFileName = "/virtual/main.ets";
  const helperFileName = "/virtual/helper.ts";
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
  const entrySource = `import { ConsoleGreeter, useGreeter, type Greeter } from "./helper.ts";

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
  const analyzer = new ArkTSAnalyzer({
    rootNames: [entryFileName, helperFileName],
  });

  analyzer.setInMemoryFile({
    fileName: helperFileName,
    content: helperSource,
  });
  analyzer.setInMemoryFile({
    fileName: entryFileName,
    content: entrySource,
  });

  const hover = analyzer.getHover(
    entryFileName,
    positionOf(analyzer, entryFileName, "useGreeter", "last"),
  );
  assert.match(hover?.displayText ?? "", /useGreeter\(greeter: Greeter\): string/);

  const references = analyzer.findReferences(
    entryFileName,
    positionOf(analyzer, entryFileName, "useGreeter", "last"),
  );
  assert.ok(references.some((reference) =>
    reference.fileName === helperFileName && reference.isDefinition
  ));
  assert.ok(references.some((reference) =>
    reference.fileName === entryFileName && !reference.isDefinition
  ));

  const typeDefinitions = analyzer.findTypeDefinitions(
    entryFileName,
    positionOf(analyzer, entryFileName, "greeter", "last"),
  );
  assert.ok(typeDefinitions.some((location) =>
    location.fileName === helperFileName && location.symbolName === "Greeter"
  ));

  const implementations = analyzer.findImplementations(
    entryFileName,
    positionOf(analyzer, entryFileName, "Greeter =", "first"),
  );
  assert.ok(implementations.some((location) =>
    location.fileName === helperFileName && location.symbolName === "ConsoleGreeter"
  ));

  const documentSymbols = analyzer.getDocumentSymbols(entryFileName);
  const homeSymbol =
    documentSymbols.find((symbol) => symbol.name === "Home") ??
    documentSymbols.flatMap((symbol) => symbol.children).find((symbol) => symbol.name === "Home");
  assert.ok(homeSymbol);
  assert.ok(homeSymbol.children.some((symbol) => symbol.name === "build"));
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
