import ts from "typescript";

export const ARKTS_INTRINSICS_FILE_NAME = "__arkts_intrinsics__.d.ts";

export const ARKTS_COMPONENT_DECORATOR = "Component";
export const ARKTS_COMPONENT_V2_DECORATOR = "ComponentV2";
export const ARKTS_ENTRY_DECORATOR = "Entry";
export const ARKTS_STATE_DECORATOR = "State";
export const ARKTS_PREVIEW_DECORATOR = "Preview";
export const ARKTS_CUSTOM_DIALOG_DECORATOR = "CustomDialog";
export const ARKTS_REUSABLE_DECORATOR = "Reusable";
export const ARKTS_PROP_DECORATOR = "Prop";
export const ARKTS_LINK_DECORATOR = "Link";
export const ARKTS_OBJECT_LINK_DECORATOR = "ObjectLink";
export const ARKTS_PROVIDE_DECORATOR = "Provide";
export const ARKTS_CONSUME_DECORATOR = "Consume";
export const ARKTS_STORAGE_PROP_DECORATOR = "StorageProp";
export const ARKTS_STORAGE_LINK_DECORATOR = "StorageLink";
export const ARKTS_LOCAL_STORAGE_PROP_DECORATOR = "LocalStorageProp";
export const ARKTS_LOCAL_STORAGE_LINK_DECORATOR = "LocalStorageLink";
export const ARKTS_BUILDER_PARAM_DECORATOR = "BuilderParam";
export const ARKTS_LOCAL_DECORATOR = "Local";
export const ARKTS_WATCH_DECORATOR = "Watch";
export const ARKTS_BUILDER_DECORATOR = "Builder";
export const ARKTS_PARAM_DECORATOR = "Param";
export const ARKTS_REQUIRE_DECORATOR = "Require";
export const ARKTS_TRACE_DECORATOR = "Trace";
export const ARKTS_COMPUTED_DECORATOR = "Computed";
export const ARKTS_OBSERVED_DECORATOR = "Observed";
export const ARKTS_OBSERVED_V2_DECORATOR = "ObservedV2";

export const ARKTS_COMPONENT_CLASS_DECORATORS = [
  ARKTS_ENTRY_DECORATOR,
  ARKTS_COMPONENT_DECORATOR,
  ARKTS_COMPONENT_V2_DECORATOR,
  ARKTS_PREVIEW_DECORATOR,
  ARKTS_CUSTOM_DIALOG_DECORATOR,
  ARKTS_REUSABLE_DECORATOR,
] as const;

export const ARKTS_CLASS_DECORATORS = [
  ...ARKTS_COMPONENT_CLASS_DECORATORS,
  ARKTS_OBSERVED_DECORATOR,
  ARKTS_OBSERVED_V2_DECORATOR,
] as const;

export const ARKTS_PROPERTY_DECORATORS = [
  ARKTS_STATE_DECORATOR,
  ARKTS_PROP_DECORATOR,
  ARKTS_LINK_DECORATOR,
  ARKTS_OBJECT_LINK_DECORATOR,
  ARKTS_PROVIDE_DECORATOR,
  ARKTS_CONSUME_DECORATOR,
  ARKTS_STORAGE_PROP_DECORATOR,
  ARKTS_STORAGE_LINK_DECORATOR,
  ARKTS_LOCAL_STORAGE_PROP_DECORATOR,
  ARKTS_LOCAL_STORAGE_LINK_DECORATOR,
  ARKTS_BUILDER_PARAM_DECORATOR,
  ARKTS_LOCAL_DECORATOR,
  ARKTS_PARAM_DECORATOR,
  ARKTS_REQUIRE_DECORATOR,
  ARKTS_TRACE_DECORATOR,
  ARKTS_COMPUTED_DECORATOR,
] as const;

export const ARKTS_METHOD_DECORATORS = [
  ARKTS_WATCH_DECORATOR,
  ARKTS_BUILDER_DECORATOR,
] as const;

export const ARKTS_INTRINSIC_DECORATORS = [
  ...ARKTS_CLASS_DECORATORS,
  ...ARKTS_PROPERTY_DECORATORS,
  ...ARKTS_METHOD_DECORATORS,
] as const;

export const ARKTS_UI_COMPONENT_NAMES = [
  "Blank",
  "Button",
  "Circle",
  "Column",
  "Divider",
  "ForEach",
  "Image",
  "List",
  "ListItem",
  "ListItemGroup",
  "LoadingProgress",
  "LongPressGesture",
  "PanGesture",
  "RichText",
  "Row",
  "Scroll",
  "Scroller",
  "Slider",
  "Stack",
  "TapGesture",
  "Text",
  "TextArea",
  "TextInput",
  "Toggle",
] as const;

const ARKTS_UI_BLOCK_COMPONENT_NAMES = new Set<string>([
  "Button",
  "Column",
  "List",
  "ListItem",
  "ListItemGroup",
  "PanGesture",
  "Row",
  "Scroll",
  "Stack",
]);

const ARKTS_GLOBAL_VALUE_NAMES = [
  "$r",
  "AlertDialog",
  "Alignment",
  "AnimationPresets",
  "AnimationType",
  "AppStorage",
  "AudioChannel",
  "AudioEncodingType",
  "AudioSampleFormat",
  "AudioSamplingRate",
  "AudioState",
  "AvoidAreaType",
  "Axis",
  "BarState",
  "ButtonType",
  "Color",
  "CopyOptions",
  "Curve",
  "EdgeEffect",
  "FlexAlign",
  "FontWeight",
  "GestureEvent",
  "HitTestMode",
  "HorizontalAlign",
  "ImageFit",
  "InputType",
  "ItemAlign",
  "NestedScrollMode",
  "OpenMode",
  "PanDirection",
  "PlayMode",
  "RequestMethod",
  "SafeAreaEdge",
  "SafeAreaType",
  "ScrollAlign",
  "ScrollDirection",
  "TextAlign",
  "TextOverflow",
  "ThemeMode",
  "ToggleType",
  "TouchType",
  "TransitionDirection",
  "TransitionEffect",
  "TransitionType",
  "VerticalAlign",
  "Visibility",
  "WordBreak",
  "animateTo",
  "getContext",
] as const;

const ARKTS_KIT_MODULE_EXPORTS = {
  "@kit.AbilityKit": [
    "AbilityConstant",
    "Configuration",
    "ConfigurationConstant",
    "UIAbility",
    "Want",
    "abilityAccessCtrl",
    "common",
  ],
  "@kit.ArkData": ["preferences"],
  "@kit.ArkUI": [
    "SimpleAnimationManager",
    "SimpleAnimationPresets",
    "SimpleAnimationUtils",
    "curves",
    "display",
    "promptAction",
    "router",
    "window",
  ],
  "@kit.AudioKit": ["audio"],
  "@kit.BasicServicesKit": ["BusinessError", "pasteboard", "systemDateTime"],
  "@kit.CoreFileKit": ["BackupExtensionAbility", "BundleVersion", "fileIo", "picker"],
  "@kit.CoreSpeechKit": ["speechRecognizer", "textToSpeech"],
  "@kit.IMEKit": ["inputMethod"],
  "@kit.LocalizationKit": ["resourceManager"],
  "@kit.NetworkKit": ["http", "webSocket"],
  "@kit.PerformanceAnalysisKit": ["hilog"],
  "@kit.SensorServiceKit": ["vibrator"],
} as const;

const ARKTS_DECORATOR_LIKE_TYPE_NAME = "ArkTSDecoratorLike";
const ARKTS_INTRINSICS_SOURCE = createArkTSIntrinsicsSource();

export function isArkTSFile(fileName: string): boolean {
  return fileName.endsWith(".ets");
}

export function isArkTSIntrinsicFile(fileName: string): boolean {
  return fileName === ARKTS_INTRINSICS_FILE_NAME;
}

export function getArkTSIntrinsicsSource(): string {
  return ARKTS_INTRINSICS_SOURCE;
}

export function normalizeArkTSSource(fileName: string, sourceText: string): string {
  if (!isArkTSFile(fileName)) {
    return sourceText;
  }

  const blockNormalizedText = normalizeArkTSComponentBlocks(sourceText);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    blockNormalizedText,
  );
  const replacements: Array<{ start: number; end: number }> = [];

  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token === ts.SyntaxKind.Identifier &&
      scanner.getTokenText() === "struct" &&
      isStructDeclarationKeyword(scanner)
    ) {
      replacements.push({
        start: scanner.getTokenStart(),
        end: scanner.getTokenEnd(),
      });
    }
  }

  if (replacements.length === 0) {
    return blockNormalizedText;
  }

  let normalizedText = blockNormalizedText;

  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    if (!replacement) {
      continue;
    }

    normalizedText =
      normalizedText.slice(0, replacement.start) +
      "class " +
      normalizedText.slice(replacement.end);
  }

  return normalizedText;
}

function isStructDeclarationKeyword(scanner: ts.Scanner): boolean {
  const lookahead = scanner.lookAhead(() => {
    const nameToken = scanner.scan();

    if (nameToken !== ts.SyntaxKind.Identifier) {
      return false;
    }

    const nextToken = scanner.scan();
    return nextToken === ts.SyntaxKind.OpenBraceToken;
  });

  return lookahead;
}

function createArkTSIntrinsicsSource(): string {
  const lines = [
    `type ${ARKTS_DECORATOR_LIKE_TYPE_NAME}<TDecorator> = TDecorator & ((...args: unknown[]) => TDecorator);`,
    "interface ArkTSChainable {",
    "  [member: string]: any;",
    "}",
    "type ArkTSComponentFactory = (...args: unknown[]) => ArkTSChainable;",
    ...ARKTS_CLASS_DECORATORS.map(
      (decorator) =>
        `declare const ${decorator}: ${ARKTS_DECORATOR_LIKE_TYPE_NAME}<ClassDecorator>;`,
    ),
    ...ARKTS_PROPERTY_DECORATORS.map(
      (decorator) =>
        `declare const ${decorator}: ${ARKTS_DECORATOR_LIKE_TYPE_NAME}<PropertyDecorator>;`,
    ),
    ...ARKTS_METHOD_DECORATORS.map(
      (decorator) =>
        `declare const ${decorator}: ${ARKTS_DECORATOR_LIKE_TYPE_NAME}<MethodDecorator>;`,
    ),
    ...ARKTS_UI_COMPONENT_NAMES.map(
      (name) => `declare const ${name}: ArkTSComponentFactory;`,
    ),
    ...ARKTS_GLOBAL_VALUE_NAMES.map(
      (name) =>
        name === "$r"
          ? "declare function $r(...args: unknown[]): any;"
          : name === "animateTo" || name === "getContext"
            ? `declare function ${name}(...args: unknown[]): any;`
            : `declare const ${name}: any;`,
    ),
    ...Object.entries(ARKTS_KIT_MODULE_EXPORTS).flatMap(([moduleName, exports]) => [
      `declare module "${moduleName}" {`,
      ...exports.map((name) => `  export const ${name}: any;`),
      "}",
    ]),
  ];

  return `\n${lines.join("\n")}\n`;
}

function normalizeArkTSComponentBlocks(sourceText: string): string {
  const blockOpenings = collectArkTSComponentBlockOpenings(sourceText);
  if (blockOpenings.length === 0) {
    return sourceText;
  }

  const bracePairs = collectBracePairs(
    sourceText,
    new Set(blockOpenings.map((opening) => opening.openBrace)),
  );
  if (bracePairs.size === 0) {
    return sourceText;
  }

  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const opening of blockOpenings) {
    if (!bracePairs.has(opening.openBrace)) {
      continue;
    }

    replacements.push({
      start: opening.closeParen,
      end: opening.openBrace + 1,
      text: opening.hasArguments ? ", () => {" : "() => {",
    });
    replacements.push({
      start: bracePairs.get(opening.openBrace) ?? opening.openBrace,
      end: (bracePairs.get(opening.openBrace) ?? opening.openBrace) + 1,
      text: "})",
    });
  }

  replacements.sort((left, right) => left.start - right.start);
  let normalized = "";
  let cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) {
      continue;
    }

    normalized += sourceText.slice(cursor, replacement.start);
    normalized += replacement.text;
    cursor = replacement.end;
  }
  normalized += sourceText.slice(cursor);

  return normalized;
}

function collectArkTSComponentBlockOpenings(
  sourceText: string,
): Array<{ openBrace: number; closeParen: number; hasArguments: boolean }> {
  const blockOpenings: Array<{ openBrace: number; closeParen: number; hasArguments: boolean }> = [];
  let lineStart = 0;

  while (lineStart < sourceText.length) {
    let lineEnd = sourceText.indexOf("\n", lineStart);
    if (lineEnd === -1) {
      lineEnd = sourceText.length;
    }

    const lineText = sourceText.slice(lineStart, lineEnd);
    const trimmedLine = lineText.trim();
    if (trimmedLine.endsWith("{")) {
      const identifierMatch = trimmedLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
      const lineOpenBrace = lineText.lastIndexOf("{");
      const lineCloseParen = lineText.lastIndexOf(")", lineOpenBrace);
      if (
        identifierMatch?.[1] &&
        lineOpenBrace >= 0 &&
        lineCloseParen >= 0 &&
        ARKTS_UI_BLOCK_COMPONENT_NAMES.has(identifierMatch[1])
      ) {
        const hasArguments = hasCallArguments(lineText, lineCloseParen);
        blockOpenings.push({
          openBrace: lineStart + lineOpenBrace,
          closeParen: lineStart + lineCloseParen,
          hasArguments,
        });
      }
    }

    lineStart = lineEnd + 1;
  }

  return blockOpenings;
}

function collectBracePairs(
  sourceText: string,
  openBracePositions: ReadonlySet<number>,
): Map<number, number> {
  const pairs = new Map<number, number>();
  for (const openBrace of openBracePositions) {
    let depth = 0;

    for (let index = openBrace; index < sourceText.length; index += 1) {
      const character = sourceText[index];
      if (character === "{") {
        depth += 1;
        continue;
      }

      if (character !== "}") {
        continue;
      }

      depth -= 1;
      if (depth === 0) {
        pairs.set(openBrace, index);
        break;
      }
    }
  }

  return pairs;
}

function hasCallArguments(lineText: string, closeParen: number): boolean {
  for (let index = closeParen - 1; index >= 0; index -= 1) {
    const character = lineText[index];
    if (character === undefined || /\s/.test(character)) {
      continue;
    }

    return character !== "(";
  }

  return false;
}
