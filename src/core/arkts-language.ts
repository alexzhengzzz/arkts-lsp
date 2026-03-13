import ts from "typescript";

export const ARKTS_INTRINSICS_FILE_NAME = "__arkts_intrinsics__.d.ts";

export const ARKTS_COMPONENT_DECORATOR = "Component";
export const ARKTS_ENTRY_DECORATOR = "Entry";
export const ARKTS_STATE_DECORATOR = "State";

export const ARKTS_INTRINSIC_DECORATORS = [
  ARKTS_ENTRY_DECORATOR,
  ARKTS_COMPONENT_DECORATOR,
  ARKTS_STATE_DECORATOR,
] as const;

const ARKTS_INTRINSICS_SOURCE = `
declare const Entry: ClassDecorator;
declare const Component: ClassDecorator;
declare const State: PropertyDecorator;
`;

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
