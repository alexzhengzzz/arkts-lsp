import ts from "typescript";
import { createArkTSCompilerHost, createArkTSLanguageServiceHost, } from "./compiler-host.js";
import { ARKTS_COMPONENT_DECORATOR, ARKTS_CONSUME_DECORATOR, ARKTS_ENTRY_DECORATOR, ARKTS_INTRINSICS_FILE_NAME, ARKTS_LINK_DECORATOR, ARKTS_LOCAL_DECORATOR, ARKTS_LOCAL_STORAGE_LINK_DECORATOR, ARKTS_LOCAL_STORAGE_PROP_DECORATOR, ARKTS_OBJECT_LINK_DECORATOR, ARKTS_PROP_DECORATOR, ARKTS_PROVIDE_DECORATOR, ARKTS_STATE_DECORATOR, ARKTS_STORAGE_LINK_DECORATOR, ARKTS_STORAGE_PROP_DECORATOR, ARKTS_BUILDER_PARAM_DECORATOR, ARKTS_WATCH_DECORATOR, isArkTSIntrinsicFile, normalizeArkTSSource, } from "./arkts-language.js";
export class ArkTSAnalyzer {
    system;
    compilerOptions;
    inMemoryFiles = new Map();
    scriptVersions = new Map();
    rootNames;
    host;
    program;
    languageService;
    constructor(options = {}) {
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
    setRootNames(rootNames) {
        this.rootNames = [...rootNames];
        this.rebuildProgram();
    }
    setInMemoryFile(input) {
        this.inMemoryFiles.set(input.fileName, input.content);
        this.bumpScriptVersion(input.fileName);
        if (!this.rootNames.includes(input.fileName)) {
            this.rootNames = [...this.rootNames, input.fileName];
        }
        this.rebuildProgram();
    }
    removeInMemoryFile(fileName) {
        this.inMemoryFiles.delete(fileName);
        this.bumpScriptVersion(fileName);
        this.rebuildProgram();
    }
    getProgram() {
        return this.program;
    }
    getSourceFile(fileName) {
        return this.program.getSourceFile(fileName);
    }
    collectDiagnostics(fileName) {
        const diagnostics = [];
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
            diagnostics.push(...syntaxDiagnostics.map((diagnostic) => this.toAnalyzerDiagnostic(sourceFile, diagnostic, "syntactic")));
            diagnostics.push(...this.program
                .getSemanticDiagnostics(sourceFile)
                .filter(isDiagnosticWithLocation)
                .map((diagnostic) => this.toAnalyzerDiagnostic(sourceFile, diagnostic, "semantic")));
        }
        return diagnostics;
    }
    findDecoratedComponents(fileName) {
        const components = [];
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
    findDefinition(fileName, position) {
        const symbolContext = this.getResolvedSymbolContext(fileName, position);
        if (!symbolContext) {
            return undefined;
        }
        return this.toDefinitionLocation(symbolContext.symbol, symbolContext.requestingFileName);
    }
    getHover(fileName, position) {
        const sourceFile = this.program.getSourceFile(fileName);
        const symbolContext = this.getResolvedSymbolContext(fileName, position);
        if (!sourceFile || !symbolContext) {
            return undefined;
        }
        const offset = ts.getPositionOfLineAndCharacter(sourceFile, position.line, position.character);
        const quickInfo = this.languageService.getQuickInfoAtPosition(fileName, offset);
        if (!quickInfo) {
            return undefined;
        }
        return {
            fileName: sourceFile.fileName,
            range: this.toRangeFromBounds(sourceFile, quickInfo.textSpan.start, quickInfo.textSpan.start + quickInfo.textSpan.length),
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
    findReferences(fileName, position) {
        const sourceFile = this.program.getSourceFile(fileName);
        const symbolContext = this.getResolvedSymbolContext(fileName, position);
        if (!sourceFile || !symbolContext) {
            return [];
        }
        const offset = ts.getPositionOfLineAndCharacter(sourceFile, position.line, position.character);
        const references = this.languageService.getReferencesAtPosition(fileName, offset) ?? [];
        const referenceGroups = this.languageService.findReferences(fileName, offset) ?? [];
        const definitionKeys = new Set();
        for (const group of referenceGroups) {
            if (!this.isSupportedSourceFile(group.definition.fileName)) {
                continue;
            }
            definitionKeys.add(createTextSpanKey(group.definition.fileName, group.definition.textSpan));
        }
        const locations = references
            .filter((reference) => this.isSupportedSourceFile(reference.fileName))
            .map((reference) => this.toReferenceLocation(reference, symbolContext.symbol.getName(), definitionKeys.has(createTextSpanKey(reference.fileName, reference.textSpan))))
            .filter((reference) => reference !== undefined);
        return dedupeReferenceLocations(locations).sort(compareReferenceLocations);
    }
    findImplementations(fileName, position) {
        return this.findLocationsFromLanguageService(fileName, position, (targetFileName, offset) => this.languageService.getImplementationAtPosition(targetFileName, offset) ?? []);
    }
    findTypeDefinitions(fileName, position) {
        return this.findLocationsFromLanguageService(fileName, position, (targetFileName, offset) => this.languageService.getTypeDefinitionAtPosition(targetFileName, offset) ?? []);
    }
    getDocumentSymbols(fileName) {
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
            .filter((item) => item !== undefined);
    }
    rebuildProgram() {
        this.host = this.createHost();
        this.program = this.createProgram(this.rootNames);
        this.languageService = this.createLanguageService();
        this.bumpScriptVersions(withArkTSIntrinsics(this.rootNames));
    }
    createHost() {
        return createArkTSCompilerHost(this.compilerOptions, {
            inMemoryFiles: this.inMemoryFiles,
            system: this.system,
        });
    }
    createLanguageService() {
        const host = createArkTSLanguageServiceHost(dedupeFileNames([
            ...this.rootNames,
            ...this.inMemoryFiles.keys(),
        ]), this.compilerOptions, {
            inMemoryFiles: this.inMemoryFiles,
            system: this.system,
            versions: this.scriptVersions,
        });
        return ts.createLanguageService(host);
    }
    createProgram(rootNames) {
        return ts.createProgram({
            rootNames: withArkTSIntrinsics(rootNames),
            options: this.compilerOptions,
            host: this.host,
            oldProgram: this.program,
        });
    }
    collectLexicalDiagnostics(fileName) {
        const sourceText = this.readFileText(fileName);
        if (sourceText === undefined) {
            return [];
        }
        const normalizedText = normalizeArkTSSource(fileName, sourceText);
        const lexicalDiagnostics = [];
        const scanner = ts.createScanner(this.compilerOptions.target ?? ts.ScriptTarget.ES2022, true, ts.LanguageVariant.Standard, normalizedText, (message, length) => {
            const start = scanner.getTokenStart();
            lexicalDiagnostics.push({
                fileName,
                category: "lexical",
                code: message.code,
                message: ts.flattenDiagnosticMessageText(message.message, "\n"),
                range: this.toRangeFromBounds(normalizedText, start, start + Math.max(length, 0)),
            });
        });
        for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
            // Exhaust the scanner so onError is invoked for all invalid tokens.
        }
        return lexicalDiagnostics;
    }
    collectDecoratedComponentsFromNode(node, sourceFile, components) {
        if (ts.isClassDeclaration(node) && node.name) {
            const classDecorators = getDecoratorNames(node, sourceFile);
            if (classDecorators.includes(ARKTS_COMPONENT_DECORATOR) ||
                classDecorators.includes(ARKTS_ENTRY_DECORATOR)) {
                const decoratedMembers = node.members.flatMap((member) => this.getDecoratedMemberInfos(member, sourceFile));
                const isEntry = classDecorators.includes(ARKTS_ENTRY_DECORATOR);
                components.push({
                    fileName: sourceFile.fileName,
                    name: node.name.text,
                    range: this.toRangeFromBounds(sourceFile, node.getStart(sourceFile), node.getEnd()),
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
    getDecoratedMemberInfos(member, sourceFile) {
        const name = getClassElementName(member);
        if (!name) {
            return [];
        }
        const range = this.toRangeFromBounds(sourceFile, member.getStart(sourceFile), member.getEnd());
        return getDecoratorNames(member, sourceFile)
            .filter((decorator) => isTrackedDecoratedMemberDecorator(decorator))
            .map((decorator) => ({
            name,
            decorator,
            kind: getDecoratedMemberKind(decorator),
            range,
        }));
    }
    selectDefinitionDeclaration(symbol, requestingFileName) {
        const declarations = symbol.declarations ?? [];
        if (declarations.length === 0) {
            return undefined;
        }
        const eligibleDeclarations = declarations.filter((declaration) => {
            const sourceFile = declaration.getSourceFile();
            return (!isArkTSIntrinsicFile(sourceFile.fileName) &&
                !this.program.isSourceFileDefaultLibrary(sourceFile));
        });
        const rankedDeclarations = eligibleDeclarations.length > 0 ? eligibleDeclarations : declarations;
        rankedDeclarations.sort((left, right) => {
            const leftSourceFile = left.getSourceFile();
            const rightSourceFile = right.getSourceFile();
            const leftScore = getDeclarationRank(leftSourceFile, requestingFileName, this.program);
            const rightScore = getDeclarationRank(rightSourceFile, requestingFileName, this.program);
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
    toAnalyzerDiagnostic(sourceFile, diagnostic, category) {
        return {
            fileName: sourceFile.fileName,
            category,
            code: diagnostic.code,
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
            range: this.toRangeFromBounds(sourceFile, diagnostic.start, diagnostic.start + (diagnostic.length ?? 0)),
        };
    }
    toRangeFromBounds(source, start, end) {
        const getLineAndCharacter = typeof source === "string"
            ? (position) => getLineAndCharacterOfText(source, position)
            : (position) => source.getLineAndCharacterOfPosition(position);
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
    getTargetFileNames(fileName) {
        if (fileName) {
            return isArkTSIntrinsicFile(fileName) ? [] : [fileName];
        }
        const fileNames = new Set();
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
    readFileText(fileName) {
        return this.inMemoryFiles.get(fileName) ?? this.system.readFile(fileName);
    }
    getResolvedSymbolContext(fileName, position) {
        const sourceFile = this.program.getSourceFile(fileName);
        if (!sourceFile) {
            return undefined;
        }
        const offset = ts.getPositionOfLineAndCharacter(sourceFile, position.line, position.character);
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
    findLocationsFromLanguageService(fileName, position, getLocations) {
        const sourceFile = this.program.getSourceFile(fileName);
        const symbolContext = this.getResolvedSymbolContext(fileName, position);
        if (!sourceFile || !symbolContext) {
            return [];
        }
        const locations = getLocations(fileName, symbolContext.offset)
            .filter((location) => this.isSupportedSourceFile(location.fileName))
            .map((location) => this.toDefinitionLocationFromSpan(location))
            .filter((location) => location !== undefined);
        return dedupeDefinitionLocations(locations).sort(compareDefinitionLocations);
    }
    toDefinitionLocation(symbol, requestingFileName) {
        const declaration = this.selectDefinitionDeclaration(symbol, requestingFileName);
        if (!declaration) {
            return undefined;
        }
        const declarationSourceFile = declaration.getSourceFile();
        return {
            fileName: declarationSourceFile.fileName,
            range: this.toRangeFromBounds(declarationSourceFile, declaration.getStart(declarationSourceFile), declaration.getEnd()),
            symbolName: symbol.getName(),
        };
    }
    toReferenceLocation(reference, symbolName, isDefinition) {
        const sourceFile = this.program.getSourceFile(reference.fileName);
        if (!sourceFile) {
            return undefined;
        }
        return {
            fileName: sourceFile.fileName,
            range: this.toRangeFromBounds(sourceFile, reference.textSpan.start, reference.textSpan.start + reference.textSpan.length),
            symbolName,
            isDefinition,
            isWriteAccess: reference.isWriteAccess,
        };
    }
    toDefinitionLocationFromSpan(location) {
        const sourceFile = this.program.getSourceFile(location.fileName);
        if (!sourceFile) {
            return undefined;
        }
        const symbolName = this.getSymbolNameFromTextSpan(sourceFile, location.textSpan);
        return {
            fileName: sourceFile.fileName,
            range: this.toRangeFromBounds(sourceFile, location.textSpan.start, location.textSpan.start + location.textSpan.length),
            symbolName,
        };
    }
    getSymbolNameFromTextSpan(sourceFile, textSpan) {
        const node = findInnermostNode(sourceFile, textSpan.start);
        if (node) {
            const symbol = resolveSymbolForNode(this.program.getTypeChecker(), node);
            if (symbol) {
                return symbol.getName();
            }
        }
        return sourceFile.text.slice(textSpan.start, textSpan.start + textSpan.length);
    }
    toDocumentSymbol(sourceFile, item) {
        if (item.text === "<global>" || item.spans.length === 0) {
            return undefined;
        }
        const fullSpan = item.spans.reduce((accumulator, span) => ({
            start: Math.min(accumulator.start, span.start),
            end: Math.max(accumulator.end, span.start + span.length),
        }), {
            start: item.spans[0]?.start ?? 0,
            end: (item.spans[0]?.start ?? 0) + (item.spans[0]?.length ?? 0),
        });
        const selectionSpan = item.nameSpan ?? item.spans[0];
        if (!selectionSpan) {
            return undefined;
        }
        return {
            name: item.text,
            kind: item.kind,
            detail: item.kindModifiers || undefined,
            range: this.toRangeFromBounds(sourceFile, fullSpan.start, fullSpan.end),
            selectionRange: this.toRangeFromBounds(sourceFile, selectionSpan.start, selectionSpan.start + selectionSpan.length),
            children: (item.childItems ?? [])
                .map((child) => this.toDocumentSymbol(sourceFile, child))
                .filter((child) => child !== undefined),
        };
    }
    isSupportedSourceFile(fileName) {
        if (isArkTSIntrinsicFile(fileName)) {
            return false;
        }
        const sourceFile = this.program.getSourceFile(fileName);
        return sourceFile !== undefined && !this.program.isSourceFileDefaultLibrary(sourceFile);
    }
    bumpScriptVersions(fileNames) {
        for (const fileName of fileNames) {
            this.bumpScriptVersion(fileName);
        }
    }
    bumpScriptVersion(fileName) {
        const currentVersion = Number(this.scriptVersions.get(fileName) ?? "0");
        this.scriptVersions.set(fileName, String(currentVersion + 1));
    }
}
function withArkTSIntrinsics(rootNames) {
    return rootNames.includes(ARKTS_INTRINSICS_FILE_NAME)
        ? [...rootNames]
        : [...rootNames, ARKTS_INTRINSICS_FILE_NAME];
}
function getParseDiagnostics(sourceFile) {
    const diagnosticsSource = sourceFile;
    return diagnosticsSource.parseDiagnostics ?? [];
}
function isDiagnosticWithLocation(diagnostic) {
    return diagnostic.file !== undefined && diagnostic.start !== undefined;
}
function dedupeDiagnostics(diagnostics) {
    const uniqueDiagnostics = new Map();
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
function getDecoratorNames(node, sourceFile) {
    if (!ts.canHaveDecorators(node)) {
        return [];
    }
    const decorators = ts.getDecorators(node) ?? [];
    return decorators
        .map((decorator) => getDecoratorName(decorator, sourceFile))
        .filter((decoratorName) => decoratorName !== undefined);
}
function getLineAndCharacterOfText(text, position) {
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
function computeLineStarts(text) {
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
function getDecoratorName(decorator, sourceFile) {
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
function getClassElementName(member) {
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
function findInnermostNode(node, position) {
    if (position < node.getFullStart() || position >= node.getEnd()) {
        return undefined;
    }
    return ts.forEachChild(node, (child) => findInnermostNode(child, position)) ?? node;
}
function resolveSymbolForNode(checker, node) {
    for (let current = node; current; current = current.parent) {
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
function getDeclarationRank(sourceFile, requestingFileName, program) {
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
};
const ARKTS_TRACKED_DECORATED_MEMBER_DECORATORS = new Set([
    ...Object.keys(ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR),
    ARKTS_WATCH_DECORATOR,
]);
function isTrackedDecoratedMemberDecorator(decorator) {
    return ARKTS_TRACKED_DECORATED_MEMBER_DECORATORS.has(decorator);
}
function getDecoratedMemberKind(decorator) {
    if (decorator in ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR) {
        return ARKTS_DECORATED_MEMBER_KIND_BY_DECORATOR[decorator];
    }
    return "other";
}
function dedupeFileNames(fileNames) {
    return [...new Set(fileNames)];
}
function dedupeDefinitionLocations(locations) {
    const uniqueLocations = new Map();
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
function dedupeReferenceLocations(locations) {
    const uniqueLocations = new Map();
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
function compareDefinitionLocations(left, right) {
    return (left.fileName.localeCompare(right.fileName) ||
        left.range.start.line - right.range.start.line ||
        left.range.start.character - right.range.start.character ||
        left.symbolName.localeCompare(right.symbolName));
}
function compareReferenceLocations(left, right) {
    return (left.fileName.localeCompare(right.fileName) ||
        left.range.start.line - right.range.start.line ||
        left.range.start.character - right.range.start.character ||
        Number(right.isDefinition) - Number(left.isDefinition) ||
        left.symbolName.localeCompare(right.symbolName));
}
function createTextSpanKey(fileName, textSpan) {
    return `${fileName}:${textSpan.start}:${textSpan.length}`;
}
function isFileModuleNavigationItem(item, sourceFile) {
    if (!item || item.kind !== ts.ScriptElementKind.moduleElement) {
        return false;
    }
    const quotedBaseName = JSON.stringify(getBaseName(sourceFile.fileName));
    return item.text === quotedBaseName;
}
function getBaseName(fileName) {
    return fileName.replace(/^.*[\\/]/u, "");
}
//# sourceMappingURL=arkts-analyzer.js.map