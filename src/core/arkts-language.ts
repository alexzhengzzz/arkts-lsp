import ts from "typescript";

export const ARKTS_INTRINSICS_FILE_NAME = "__arkts_intrinsics__.d.ts";

export const ARKTS_COMPONENT_DECORATOR = "Component";
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

export const ARKTS_CLASS_DECORATORS = [
  ARKTS_ENTRY_DECORATOR,
  ARKTS_COMPONENT_DECORATOR,
  ARKTS_PREVIEW_DECORATOR,
  ARKTS_CUSTOM_DIALOG_DECORATOR,
  ARKTS_REUSABLE_DECORATOR,
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
] as const;

export const ARKTS_METHOD_DECORATORS = [ARKTS_WATCH_DECORATOR] as const;

export const ARKTS_INTRINSIC_DECORATORS = [
  ...ARKTS_CLASS_DECORATORS,
  ...ARKTS_PROPERTY_DECORATORS,
  ...ARKTS_METHOD_DECORATORS,
] as const;

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

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    sourceText,
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
    return sourceText;
  }

  let normalizedText = sourceText;

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
  ];

  return `\n${lines.join("\n")}\n`;
}
