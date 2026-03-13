import ts from "typescript";
import {
  createArkTSCompilerHost,
  createArkTSLanguageServiceHost,
} from "./compiler-host.js";
import {
  ARKTS_COMPONENT_DECORATOR,
  ARKTS_CONSUME_DECORATOR,
  ARKTS_ENTRY_DECORATOR,
  ARKTS_INTRINSICS_FILE_NAME,
  ARKTS_LINK_DECORATOR,
  ARKTS_LOCAL_DECORATOR,
  ARKTS_LOCAL_STORAGE_LINK_DECORATOR,
  ARKTS_LOCAL_STORAGE_PROP_DECORATOR,
  ARKTS_OBJECT_LINK_DECORATOR,
  ARKTS_PROP_DECORATOR,
  ARKTS_PROVIDE_DECORATOR,
  ARKTS_STATE_DECORATOR,
  ARKTS_STORAGE_LINK_DECORATOR,
  ARKTS_STORAGE_PROP_DECORATOR,
  ARKTS_BUILDER_PARAM_DECORATOR,
  ARKTS_WATCH_DECORATOR,
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

export type DecoratedMemberKind =
  | "state"
  | "prop"
  | "link"
  | "objectLink"
  | "provide"
  | "consume"
  | "storageProp"
  | "storageLink"
  | "localStorageProp"
  | "localStorageLink"
  | "builderParam"
  | "local"
  | "other";

export interface DecoratedMemberInfo {
  name: string;
  decorator: string;
  kind: DecoratedMemberKind;
  range: AnalyzerRange;
}

export interface DecoratedComponentInfo {
  fileName: string;
  name: string;
  range: AnalyzerRange;
  isEntry: boolean;
  componentDecorators: string[];
  stateMembers: StateMemberInfo[];
  decoratedMembers: DecoratedMemberInfo[];
}

export interface DefinitionLocation {
  fileName: string;
  range: AnalyzerRange;
  symbolName: string;
}

export interface HoverTagInfo {
  name: string;
  text: string;
}

export interface HoverInfo {
  fileName: string;
  range: AnalyzerRange;
  symbolName: string;
  kind: string;
  kindModifiers: string;
  displayText: string;
  documentation: string;
  tags: HoverTagInfo[];
}

export interface ReferenceLocation {
  fileName: string;
  range: AnalyzerRange;
  symbolName: string;
  isDefinition: boolean;
  isWriteAccess: boolean;
}

export interface DocumentSymbol {
  name: string;
  kind: string;
  detail?: string | undefined;
  range: AnalyzerRange;
  selectionRange: AnalyzerRange;
  children: DocumentSymbol[];
}

export class ArkTSAnalyzer {
  private readonly system: ts.System;
  private readonly compilerOptions: ts.CompilerOptions;
  private readonly inMemoryFiles = new Map<string, string>();
  private readonly scriptVersions = new Map<string, string>();

  private rootNames: string[];
  private host: ts.CompilerHost;
  private program: ts.Program;
  private languageService: ts.LanguageService;

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
    this.languageService = this.createLanguageService();
    this.bumpScriptVersions(withArkTSIntrinsics(this.rootNames));
  }

  public setRootNames(rootNames: string[]): void {
    this.rootNames = [...rootNames];
    this.rebuildProgram();
  }

  public setInMemoryFile(input: AnalyzeTextInput): void {
    this.inMemoryFiles.set(input.fileName, input.content);
    this.bumpScriptVersion(input.fileName);

    if (!this.rootNames.includes(input.fileName)) {
      this.rootNames = [...this.rootNames, input.fileName];
    }

    this.rebuildProgram();
  }

  public removeInMemoryFile(fileName: string): void {
    this.inMemoryFiles.delete(fileName);
    this.bumpScriptVersion(fileName);
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
    const symbolContext = this.getResolvedSymbolContext(fileName, position);
    if (!symbolContext) {
      return undefined;
    }

    return this.toDefinitionLocation(symbolContext.symbol, symbolContext.requestingFileName);
  }

  public getHover(
    fileName: string,
    position: AnalyzerPosition,
  ): HoverInfo | undefined {
    const sourceFile = this.program.getSourceFile(fileName);
    const symbolContext = this.getResolvedSymbolContext(fileName, position);
    if (!sourceFile || !symbolContext) {
      return undefined;
    }

    const offset = ts.getPositionOfLineAndCharacter(
      sourceFile,
      position.line,
      position.character,
    );
    const quickInfo = this.languageService.getQuickInfoAtPosition(fileName, offset);
    if (!quickInfo) {
      return undefined;
    }

    return {
      fileName: sourceFile.fileName,
      range: this.toRangeFromBounds(
        sourceFile,
        quickInfo.textSpan.start,
        quickInfo.textSpan.start + quickInfo.textSpan.length,
      ),
      symbolName: symbolContext.symbol.getName(),
      kind: quickInfo.kind,
      kindModifiers: quickInfo.kindModifiers,
      displayText: ts.displayPartsToString(quickInfo.displayParts),
      documentation: ts.displayPartsToString(quickInfo.documentation),
      tags: (quickInfo.tags ?? []).map((tag) => ({
        name: tag.name,
        text: ts.displayPartsToString(tag.text),
      })),
    };
  }

  public findReferences(
    fileName: string,
    position: AnalyzerPosition,
  ): ReferenceLocation[] {
    const sourceFile = this.program.getSourceFile(fileName);
    const symbolContext = this.getResolvedSymbolContext(fileName, position);
    if (!sourceFile || !symbolContext) {
      return [];
    }

    const offset = ts.getPositionOfLineAndCharacter(
      sourceFile,
      position.line,
      position.character,
    );
    const references = this.languageService.getReferencesAtPosition(fileName, offset) ?? [];
    const referenceGroups = this.languageService.findReferences(fileName, offset) ?? [];
    const definitionKeys = new Set<string>();

    for (const group of referenceGroups) {
      if (!this.isSupportedSourceFile(group.definition.fileName)) {
        continue;
      }

      definitionKeys.add(createTextSpanKey(group.definition.fileName, group.definition.textSpan));
    }

    const locations = references
      .filter((reference) => this.isSupportedSourceFile(reference.fileName))
      .map((reference) =>
        this.toReferenceLocation(
          reference,
          symbolContext.symbol.getName(),
          definitionKeys.has(createTextSpanKey(reference.fileName, reference.textSpan)),
        ),
      )
      .filter((reference): reference is ReferenceLocation => reference !== undefined);

    return dedupeReferenceLocations(locations).sort(compareReferenceLocations);
  }

  public findImplementations(
    fileName: string,
    position: AnalyzerPosition,
  ): DefinitionLocation[] {
    return this.findLocationsFromLanguageService(
      fileName,
      position,
      (targetFileName, offset) =>
        this.languageService.getImplementationAtPosition(targetFileName, offset) ?? [],
    );
  }

  public findTypeDefinitions(
    fileName: string,
    position: AnalyzerPosition,
  ): DefinitionLocation[] {
    return this.findLocationsFromLanguageService(
      fileName,
      position,
      (targetFileName, offset) =>
        this.languageService.getTypeDefinitionAtPosition(targetFileName, offset) ?? [],
    );
  }

  public getDocumentSymbols(fileName: string): DocumentSymbol[] {
    const sourceFile = this.program.getSourceFile(fileName);
    if (!sourceFile) {
      return [];
    }

    const navigationTree = this.languageService.getNavigationTree(fileName);
    let rootItems = navigationTree.kind === ts.ScriptElementKind.scriptElement
      ? navigationTree.childItems ?? []
      : [navigationTree];

    if (rootItems.length === 1 && isFileModuleNavigationItem(rootItems[0], sourceFile)) {
      rootItems = rootItems[0]?.childItems ?? [];
    }

    return rootItems
      .map((item) => this.toDocumentSymbol(sourceFile, item))
      .filter((item): item is DocumentSymbol => item !== undefined);
  }

  public rebuildProgram(): void {
    this.host = this.createHost();
    this.program = this.createProgram(this.rootNames);
    this.languageService = this.createLanguageService();
    this.bumpScriptVersions(withArkTSIntrinsics(this.rootNames));
  }

  private createHost(): ts.CompilerHost {
    return createArkTSCompilerHost(this.compilerOptions, {
      inMemoryFiles: this.inMemoryFiles,
      system: this.system,
    });
  }

  private createLanguageService(): ts.LanguageService {
    const host = createArkTSLanguageServiceHost(
      dedupeFileNames([
        ...this.rootNames,
        ...this.inMemoryFiles.keys(),
      ]),
      this.compilerOptions,
      {
        inMemoryFiles: this.inMemoryFiles,
        system: this.system,
        versions: this.scriptVersions,
      },
    );

    return ts.createLanguageService(host);
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

      if (
        classDecorators.includes(ARKTS_COMPONENT_DECORATOR) ||
        classDecorators.includes(ARKTS_ENTRY_DECORATOR)
      ) {
        const decoratedMembers = node.members.flatMap((member) =>
          this.getDecoratedMemberInfos(member, sourceFile),
        );
        const isEntry = classDecorators.includes(ARKTS_ENTRY_DECORATOR);

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
          stateMembers: decoratedMembers
            .filter((member) => member.kind === "state")
            .map((member) => ({
              name: member.name,
              decorator: member.decorator,
              range: member.range,
            })),
          decoratedMembers,
        });
      }
    }

    ts.forEachChild(node, (child) => {
      this.collectDecoratedComponentsFromNode(child, sourceFile, components);
    });
  }

  private getDecoratedMemberInfos(
    member: ts.ClassElement,
    sourceFile: ts.SourceFile,
  ): DecoratedMemberInfo[] {
    const name = getClassElementName(member);
    if (!name) {
      return [];
    }

    const range = this.toRangeFromBounds(
      sourceFile,
      member.getStart(sourceFile),
      member.getEnd(),
    );

    return getDecoratorNames(member, sourceFile)
      .filter((decorator) => isTrackedDecoratedMemberDecorator(decorator))
      .map((decorator) => ({
        name,
        decorator,
        kind: getDecoratedMemberKind(decorator),
        range,
      }));
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

  private getResolvedSymbolContext(
    fileName: string,
    position: AnalyzerPosition,
  ): {
    symbol: ts.Symbol;
    sourceFile: ts.SourceFile;
    offset: number;
    requestingFileName: string;
  } | undefined {
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

    return {
      symbol,
      sourceFile,
      offset,
      requestingFileName: fileName,
    };
  }

  private findLocationsFromLanguageService(
    fileName: string,
    position: AnalyzerPosition,
    getLocations: (
      targetFileName: string,
      offset: number,
    ) => readonly ts.DocumentSpan[],
  ): DefinitionLocation[] {
    const sourceFile = this.program.getSourceFile(fileName);
    const symbolContext = this.getResolvedSymbolContext(fileName, position);
    if (!sourceFile || !symbolContext) {
      return [];
    }

    const locations = getLocations(fileName, symbolContext.offset)
      .filter((location) => this.isSupportedSourceFile(location.fileName))
      .map((location) => this.toDefinitionLocationFromSpan(location))
      .filter((location): location is DefinitionLocation => location !== undefined);

    return dedupeDefinitionLocations(locations).sort(compareDefinitionLocations);
  }

  private toDefinitionLocation(
    symbol: ts.Symbol,
    requestingFileName: string,
  ): DefinitionLocation | undefined {
    const declaration = this.selectDefinitionDeclaration(symbol, requestingFileName);
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

  private toReferenceLocation(
    reference: ts.ReferenceEntry,
    symbolName: string,
    isDefinition: boolean,
  ): ReferenceLocation | undefined {
    const sourceFile = this.program.getSourceFile(reference.fileName);
    if (!sourceFile) {
      return undefined;
    }

    return {
      fileName: sourceFile.fileName,
      range: this.toRangeFromBounds(
        sourceFile,
        reference.textSpan.start,
        reference.textSpan.start + reference.textSpan.length,
      ),
      symbolName,
      isDefinition,
      isWriteAccess: reference.isWriteAccess,
    };
  }

  private toDefinitionLocationFromSpan(
    location: ts.DocumentSpan,
  ): DefinitionLocation | undefined {
    const sourceFile = this.program.getSourceFile(location.fileName);
    if (!sourceFile) {
      return undefined;
    }

    const symbolName = this.getSymbolNameFromTextSpan(sourceFile, location.textSpan);
    return {
      fileName: sourceFile.fileName,
      range: this.toRangeFromBounds(
        sourceFile,
        location.textSpan.start,
        location.textSpan.start + location.textSpan.length,
      ),
      symbolName,
    };
  }

  private getSymbolNameFromTextSpan(
    sourceFile: ts.SourceFile,
    textSpan: ts.TextSpan,
  ): string {
    const node = findInnermostNode(sourceFile, textSpan.start);
    if (node) {
      const symbol = resolveSymbolForNode(this.program.getTypeChecker(), node);
      if (symbol) {
        return symbol.getName();
      }
    }

    return sourceFile.text.slice(
      textSpan.start,
      textSpan.start + textSpan.length,
    );
  }

  private toDocumentSymbol(
    sourceFile: ts.SourceFile,
    item: ts.NavigationTree,
  ): DocumentSymbol | undefined {
    if (item.text === "<global>" || item.spans.length === 0) {
      return undefined;
    }

    const fullSpan = item.spans.reduce(
      (accumulator, span) => ({
        start: Math.min(accumulator.start, span.start),
        end: Math.max(accumulator.end, span.start + span.length),
      }),
      {
        start: item.spans[0]?.start ?? 0,
        end: (item.spans[0]?.start ?? 0) + (item.spans[0]?.length ?? 0),
      },
    );
    const selectionSpan = item.nameSpan ?? item.spans[0];
    if (!selectionSpan) {
      return undefined;
    }

    return {
      name: item.text,
      kind: item.kind,
      detail: item.kindModifiers || undefined,
      range: this.toRangeFromBounds(sourceFile, fullSpan.start, fullSpan.end),
      selectionRange: this.toRangeFromBounds(
        sourceFile,
        selectionSpan.start,
        selectionSpan.start + selectionSpan.length,
      ),
      children: (item.childItems ?? [])
        .map((child) => this.toDocumentSymbol(sourceFile, child))
        .filter((child): child is DocumentSymbol => child !== undefined),
    };
  }

  private isSupportedSourceFile(fileName: string): boolean {
    if (isArkTSIntrinsicFile(fileName)) {
      return false;
    }

    const sourceFile = this.program.getSourceFile(fileName);
    return sourceFile !== undefined && !this.program.isSourceFileDefaultLibrary(sourceFile);
  }

  private bumpScriptVersions(fileNames: readonly string[]): void {
    for (const fileName of fileNames) {
      this.bumpScriptVersion(fileName);
    }
  }

  private bumpScriptVersion(fileName: string): void {
    const currentVersion = Number(this.scriptVersions.get(fileName) ?? "0");
    this.scriptVersions.set(fileName, String(currentVersion + 1));
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

const ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR = {
  [ARKTS_STATE_DECORATOR]: "state",
  [ARKTS_PROP_DECORATOR]: "prop",
  [ARKTS_LINK_DECORATOR]: "link",
  [ARKTS_OBJECT_LINK_DECORATOR]: "objectLink",
  [ARKTS_PROVIDE_DECORATOR]: "provide",
  [ARKTS_CONSUME_DECORATOR]: "consume",
  [ARKTS_STORAGE_PROP_DECORATOR]: "storageProp",
  [ARKTS_STORAGE_LINK_DECORATOR]: "storageLink",
  [ARKTS_LOCAL_STORAGE_PROP_DECORATOR]: "localStorageProp",
  [ARKTS_LOCAL_STORAGE_LINK_DECORATOR]: "localStorageLink",
  [ARKTS_BUILDER_PARAM_DECORATOR]: "builderParam",
  [ARKTS_LOCAL_DECORATOR]: "local",
} as const satisfies Record<string, DecoratedMemberKind>;

const ARKTS_TRACKED_DECORATED_MEMBER_DECORATORS = new Set<string>([
  ...Object.keys(ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR),
  ARKTS_WATCH_DECORATOR,
]);

function isTrackedDecoratedMemberDecorator(decorator: string): boolean {
  return ARKTS_TRACKED_DECORATED_MEMBER_DECORATORS.has(decorator);
}

function getDecoratedMemberKind(decorator: string): DecoratedMemberKind {
  if (decorator in ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR) {
    return ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR[
      decorator as keyof typeof ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR
    ];
  }

  return "other";
}

function dedupeFileNames(fileNames: Iterable<string>): string[] {
  return [...new Set(fileNames)];
}

function dedupeDefinitionLocations(
  locations: readonly DefinitionLocation[],
): DefinitionLocation[] {
  const uniqueLocations = new Map<string, DefinitionLocation>();

  for (const location of locations) {
    const key = [
      location.fileName,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character,
      location.symbolName,
    ].join(":");
    if (!uniqueLocations.has(key)) {
      uniqueLocations.set(key, location);
    }
  }

  return [...uniqueLocations.values()];
}

function dedupeReferenceLocations(
  locations: readonly ReferenceLocation[],
): ReferenceLocation[] {
  const uniqueLocations = new Map<string, ReferenceLocation>();

  for (const location of locations) {
    const key = [
      location.fileName,
      location.range.start.line,
      location.range.start.character,
      location.range.end.line,
      location.range.end.character,
      location.symbolName,
      location.isDefinition,
      location.isWriteAccess,
    ].join(":");
    if (!uniqueLocations.has(key)) {
      uniqueLocations.set(key, location);
    }
  }

  return [...uniqueLocations.values()];
}

function compareDefinitionLocations(
  left: DefinitionLocation,
  right: DefinitionLocation,
): number {
  return (
    left.fileName.localeCompare(right.fileName) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    left.symbolName.localeCompare(right.symbolName)
  );
}

function compareReferenceLocations(
  left: ReferenceLocation,
  right: ReferenceLocation,
): number {
  return (
    left.fileName.localeCompare(right.fileName) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character ||
    Number(right.isDefinition) - Number(left.isDefinition) ||
    left.symbolName.localeCompare(right.symbolName)
  );
}

function createTextSpanKey(fileName: string, textSpan: ts.TextSpan): string {
  return `${fileName}:${textSpan.start}:${textSpan.length}`;
}

function isFileModuleNavigationItem(
  item: ts.NavigationTree | undefined,
  sourceFile: ts.SourceFile,
): boolean {
  if (!item || item.kind !== ts.ScriptElementKind.moduleElement) {
    return false;
  }

  const quotedBaseName = JSON.stringify(getBaseName(sourceFile.fileName));
  return item.text === quotedBaseName;
}

function getBaseName(fileName: string): string {
  return fileName.replace(/^.*[\\/]/u, "");
}
