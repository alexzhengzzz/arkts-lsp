import ts from "typescript";
import { createArkTSCompilerHost } from "./compiler-host.js";
import {
  ARKTS_COMPONENT_DECORATOR,
  ARKTS_ENTRY_DECORATOR,
  ARKTS_INTRINSICS_FILE_NAME,
  ARKTS_STATE_DECORATOR,
  isArkTSIntrinsicFile,
  normalizeArkTSSource,
} from "./arkts-language.js";

export interface ArkTSAnalyzerOptions {
  rootNames?: string[];
  compilerOptions?: ts.CompilerOptions;
  system?: ts.System;
}

export interface AnalyzeTextInput {
  fileName: string;
  content: string;
}

export interface AnalyzerPosition {
  line: number;
  character: number;
}

export interface AnalyzerRange {
  start: AnalyzerPosition;
  end: AnalyzerPosition;
}

export interface AnalyzerDiagnostic {
  fileName: string;
  category: "lexical" | "syntactic" | "semantic";
  code: number;
  message: string;
  range: AnalyzerRange;
}

export interface StateMemberInfo {
  name: string;
  decorator: string;
  range: AnalyzerRange;
}

export interface DecoratedComponentInfo {
  fileName: string;
  name: string;
  range: AnalyzerRange;
  isEntry: boolean;
  componentDecorators: string[];
  stateMembers: StateMemberInfo[];
}

export interface DefinitionLocation {
  fileName: string;
  range: AnalyzerRange;
  symbolName: string;
}

export class ArkTSAnalyzer {
  private readonly system: ts.System;
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly inMemoryFiles = new Map<string, string>();

  private rootNames: string[];
  private host: ts.CompilerHost;
  private program: ts.Program;

  constructor(options: ArkTSAnalyzerOptions = {}) {
    this.system = options.system ?? ts.sys;
    this.compilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowNonTsExtensions: true,
      experimentalDecorators: true,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      ...options.compilerOptions,
    };

    this.rootNames = options.rootNames ?? [];
    this.host = this.createHost();
    this.program = this.createProgram(this.rootNames);
  }

  public setRootNames(rootNames: string[]): void {
    this.rootNames = [...rootNames];
    this.rebuildProgram();
  }

  public setInMemoryFile(input: AnalyzeTextInput): void {
    this.inMemoryFiles.set(input.fileName, input.content);

    if (!this.rootNames.includes(input.fileName)) {
      this.rootNames = [...this.rootNames, input.fileName];
    }

    this.rebuildProgram();
  }

  public removeInMemoryFile(fileName: string): void {
    this.inMemoryFiles.delete(fileName);
    this.rebuildProgram();
  }

  public getProgram(): ts.Program {
    return this.program;
  }

  public getSourceFile(fileName: string): ts.SourceFile | undefined {
    return this.program.getSourceFile(fileName);
  }

  public collectDiagnostics(fileName?: string): AnalyzerDiagnostic[] {
    const diagnostics: AnalyzerDiagnostic[] = [];

    for (const targetFileName of this.getTargetFileNames(fileName)) {
      diagnostics.push(...this.collectLexicalDiagnostics(targetFileName));

      const sourceFile = this.program.getSourceFile(targetFileName);
      if (!sourceFile) {
        continue;
      }

      const parseDiagnostics = getParseDiagnostics(sourceFile);
      const syntaxDiagnostics = dedupeDiagnostics([
        ...parseDiagnostics,
        ...this.program
          .getSyntacticDiagnostics(sourceFile)
          .filter(isDiagnosticWithLocation),
      ]);
      diagnostics.push(
        ...syntaxDiagnostics.map((diagnostic) =>
          this.toAnalyzerDiagnostic(sourceFile, diagnostic, "syntactic"),
        ),
      );
      diagnostics.push(
        ...this.program
          .getSemanticDiagnostics(sourceFile)
          .filter(isDiagnosticWithLocation)
          .map((diagnostic) =>
            this.toAnalyzerDiagnostic(sourceFile, diagnostic, "semantic"),
          ),
      );
    }

    return diagnostics;
  }

  public findDecoratedComponents(fileName?: string): DecoratedComponentInfo[] {
    const components: DecoratedComponentInfo[] = [];

    for (const targetFileName of this.getTargetFileNames(fileName)) {
      const sourceFile = this.program.getSourceFile(targetFileName);
      if (!sourceFile) {
        continue;
      }

      ts.forEachChild(sourceFile, (node) => {
        this.collectDecoratedComponentsFromNode(node, sourceFile, components);
      });
    }

    return components;
  }

  public findDefinition(
    fileName: string,
    position: AnalyzerPosition,
  ): DefinitionLocation | undefined {
    const sourceFile = this.program.getSourceFile(fileName);
    if (!sourceFile) {
      return undefined;
    }

    const offset = ts.getPositionOfLineAndCharacter(
      sourceFile,
      position.line,
      position.character,
    );
    const node = findInnermostNode(sourceFile, offset);
    if (!node) {
      return undefined;
    }

    const checker = this.program.getTypeChecker();
    const symbol = resolveSymbolForNode(checker, node);
    if (!symbol) {
      return undefined;
    }

    const declaration = this.selectDefinitionDeclaration(symbol, fileName);
    if (!declaration) {
      return undefined;
    }

    const declarationSourceFile = declaration.getSourceFile();
    return {
      fileName: declarationSourceFile.fileName,
      range: this.toRangeFromBounds(
        declarationSourceFile,
        declaration.getStart(declarationSourceFile),
        declaration.getEnd(),
      ),
      symbolName: symbol.getName(),
    };
  }

  public rebuildProgram(): void {
    this.host = this.createHost();
    this.program = this.createProgram(this.rootNames);
  }

  private createHost(): ts.CompilerHost {
    return createArkTSCompilerHost(this.compilerOptions, {
      inMemoryFiles: this.inMemoryFiles,
      system: this.system,
    });
  }

  private createProgram(rootNames: string[]): ts.Program {
    return ts.createProgram({
      rootNames: withArkTSIntrinsics(rootNames),
      options: this.compilerOptions,
      host: this.host,
      oldProgram: this.program,
    });
  }

  private collectLexicalDiagnostics(fileName: string): AnalyzerDiagnostic[] {
    const sourceText = this.readFileText(fileName);
    if (sourceText === undefined) {
      return [];
    }

    const normalizedText = normalizeArkTSSource(fileName, sourceText);
    const lexicalDiagnostics: AnalyzerDiagnostic[] = [];
    const scanner = ts.createScanner(
      this.compilerOptions.target ?? ts.ScriptTarget.ES2022,
      true,
      ts.LanguageVariant.Standard,
      normalizedText,
      (message, length) => {
        const start = scanner.getTokenStart();
        lexicalDiagnostics.push({
          fileName,
          category: "lexical",
          code: message.code,
          message: ts.flattenDiagnosticMessageText(message.message, "\n"),
          range: this.toRangeFromBounds(
            normalizedText,
            start,
            start + Math.max(length, 0),
          ),
        });
      },
    );

    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      // Exhaust the scanner so onError is invoked for all invalid tokens.
    }

    return lexicalDiagnostics;
  }

  private collectDecoratedComponentsFromNode(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    components: DecoratedComponentInfo[],
  ): void {
    if (ts.isClassDeclaration(node) && node.name) {
      const classDecorators = getDecoratorNames(node, sourceFile);

      if (classDecorators.includes(ARKTS_COMPONENT_DECORATOR)) {
        const stateMembers = node.members
          .map((member) => this.getStateMemberInfo(member, sourceFile))
          .filter((member): member is StateMemberInfo => member !== undefined);
        const isEntry = classDecorators.includes(ARKTS_ENTRY_DECORATOR);

        if (isEntry || stateMembers.length > 0) {
          components.push({
            fileName: sourceFile.fileName,
            name: node.name.text,
            range: this.toRangeFromBounds(
              sourceFile,
              node.getStart(sourceFile),
              node.getEnd(),
            ),
            isEntry,
            componentDecorators: classDecorators,
            stateMembers,
          });
        }
      }
    }

    ts.forEachChild(node, (child) => {
      this.collectDecoratedComponentsFromNode(child, sourceFile, components);
    });
  }

  private getStateMemberInfo(
    member: ts.ClassElement,
    sourceFile: ts.SourceFile,
  ): StateMemberInfo | undefined {
    const decoratorNames = getDecoratorNames(member, sourceFile);
    if (!decoratorNames.includes(ARKTS_STATE_DECORATOR)) {
      return undefined;
    }

    const name = getClassElementName(member);
    if (!name) {
      return undefined;
    }

    return {
      name,
      decorator: ARKTS_STATE_DECORATOR,
      range: this.toRangeFromBounds(
        sourceFile,
        member.getStart(sourceFile),
        member.getEnd(),
      ),
    };
  }

  private selectDefinitionDeclaration(
    symbol: ts.Symbol,
    requestingFileName: string,
  ): ts.Declaration | undefined {
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) {
      return undefined;
    }

    const eligibleDeclarations = declarations.filter((declaration) => {
      const sourceFile = declaration.getSourceFile();
      return (
        !isArkTSIntrinsicFile(sourceFile.fileName) &&
        !this.program.isSourceFileDefaultLibrary(sourceFile)
      );
    });
    const rankedDeclarations =
      eligibleDeclarations.length > 0 ? eligibleDeclarations : declarations;

    rankedDeclarations.sort((left, right) => {
      const leftSourceFile = left.getSourceFile();
      const rightSourceFile = right.getSourceFile();
      const leftScore = getDeclarationRank(
        leftSourceFile,
        requestingFileName,
        this.program,
      );
      const rightScore = getDeclarationRank(
        rightSourceFile,
        requestingFileName,
        this.program,
      );

      if (leftScore !== rightScore) {
        return leftScore - rightScore;
      }

      return left.getStart(leftSourceFile) - right.getStart(rightSourceFile);
    });

    const selectedDeclaration = rankedDeclarations[0];
    if (!selectedDeclaration) {
      return undefined;
    }

    const selectedSourceFile = selectedDeclaration.getSourceFile();
    if (isArkTSIntrinsicFile(selectedSourceFile.fileName)) {
      return undefined;
    }

    return selectedDeclaration;
  }

  private toAnalyzerDiagnostic(
    sourceFile: ts.SourceFile,
    diagnostic: ts.DiagnosticWithLocation,
    category: AnalyzerDiagnostic["category"],
  ): AnalyzerDiagnostic {
    return {
      fileName: sourceFile.fileName,
      category,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      range: this.toRangeFromBounds(
        sourceFile,
        diagnostic.start,
        diagnostic.start + (diagnostic.length ?? 0),
      ),
    };
  }

  private toRangeFromBounds(
    source: ts.SourceFile | string,
    start: number,
    end: number,
  ): AnalyzerRange {
    const getLineAndCharacter =
      typeof source === "string"
        ? (position: number) => getLineAndCharacterOfText(source, position)
        : (position: number) => source.getLineAndCharacterOfPosition(position);
    const normalizedEnd = Math.max(start, end);
    const startPosition = getLineAndCharacter(start);
    const endPosition = getLineAndCharacter(normalizedEnd);

    return {
      start: {
        line: startPosition.line,
        character: startPosition.character,
      },
      end: {
        line: endPosition.line,
        character: endPosition.character,
      },
    };
  }

  private getTargetFileNames(fileName?: string): string[] {
    if (fileName) {
      return isArkTSIntrinsicFile(fileName) ? [] : [fileName];
    }

    const fileNames = new Set<string>();

    for (const rootName of this.rootNames) {
      if (!isArkTSIntrinsicFile(rootName)) {
        fileNames.add(rootName);
      }
    }

    for (const inMemoryFileName of this.inMemoryFiles.keys()) {
      if (!isArkTSIntrinsicFile(inMemoryFileName)) {
        fileNames.add(inMemoryFileName);
      }
    }

    return [...fileNames];
  }

  private readFileText(fileName: string): string | undefined {
    return this.inMemoryFiles.get(fileName) ?? this.system.readFile(fileName);
  }
}

function withArkTSIntrinsics(rootNames: readonly string[]): string[] {
  return rootNames.includes(ARKTS_INTRINSICS_FILE_NAME)
    ? [...rootNames]
    : [...rootNames, ARKTS_INTRINSICS_FILE_NAME];
}

function getParseDiagnostics(
  sourceFile: ts.SourceFile,
): readonly ts.DiagnosticWithLocation[] {
  const diagnosticsSource = sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
  };

  return diagnosticsSource.parseDiagnostics ?? [];
}

function isDiagnosticWithLocation(
  diagnostic: ts.Diagnostic,
): diagnostic is ts.DiagnosticWithLocation {
  return diagnostic.file !== undefined && diagnostic.start !== undefined;
}

function dedupeDiagnostics(
  diagnostics: readonly ts.DiagnosticWithLocation[],
): ts.DiagnosticWithLocation[] {
  const uniqueDiagnostics = new Map<string, ts.DiagnosticWithLocation>();

  for (const diagnostic of diagnostics) {
    const fileName = diagnostic.file?.fileName ?? "";
    const start = diagnostic.start ?? -1;
    const length = diagnostic.length ?? 0;
    const key = `${fileName}:${start}:${length}:${diagnostic.code}`;

    if (!uniqueDiagnostics.has(key)) {
      uniqueDiagnostics.set(key, diagnostic);
    }
  }

  return [...uniqueDiagnostics.values()];
}

function getDecoratorNames(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  if (!ts.canHaveDecorators(node)) {
    return [];
  }

  const decorators = ts.getDecorators(node) ?? [];
  return decorators
    .map((decorator) => getDecoratorName(decorator, sourceFile))
    .filter((decoratorName): decoratorName is string => decoratorName !== undefined);
}

function getLineAndCharacterOfText(
  text: string,
  position: number,
): ts.LineAndCharacter {
  const lineStarts = computeLineStarts(text);
  const clampedPosition = Math.max(0, Math.min(position, text.length));
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle] ?? 0;
    const nextLineStart = lineStarts[middle + 1] ?? text.length + 1;

    if (clampedPosition < lineStart) {
      high = middle - 1;
      continue;
    }

    if (clampedPosition >= nextLineStart) {
      low = middle + 1;
      continue;
    }

    return {
      line: middle,
      character: clampedPosition - lineStart,
    };
  }

  const lastLine = Math.max(0, lineStarts.length - 1);
  const lastLineStart = lineStarts[lastLine] ?? 0;
  return {
    line: lastLine,
    character: clampedPosition - lastLineStart,
  };
}

function computeLineStarts(text: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);

    if (character === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        index += 1;
      }

      lineStarts.push(index + 1);
      continue;
    }

    if (character === 10) {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function getDecoratorName(
  decorator: ts.Decorator,
  sourceFile: ts.SourceFile,
): string | undefined {
  const expression = decorator.expression;

  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isIdentifier(callee)) {
      return callee.text;
    }
  }

  return expression.getText(sourceFile).replace(/^@/, "");
}

function getClassElementName(member: ts.ClassElement): string | undefined {
  const name = member.name;
  if (!name) {
    return undefined;
  }

  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }

  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function findInnermostNode(node: ts.Node, position: number): ts.Node | undefined {
  if (position < node.getFullStart() || position >= node.getEnd()) {
    return undefined;
  }

  return ts.forEachChild(node, (child) => findInnermostNode(child, position)) ?? node;
}

function resolveSymbolForNode(
  checker: ts.TypeChecker,
  node: ts.Node,
): ts.Symbol | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol) {
      continue;
    }

    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      return checker.getAliasedSymbol(symbol);
    }

    return symbol;
  }

  return undefined;
}

function getDeclarationRank(
  sourceFile: ts.SourceFile,
  requestingFileName: string,
  program: ts.Program,
): number {
  if (sourceFile.fileName === requestingFileName) {
    return 0;
  }

  if (!sourceFile.isDeclarationFile) {
    return 1;
  }

  if (!program.isSourceFileDefaultLibrary(sourceFile)) {
    return 2;
  }

  return 3;
}
