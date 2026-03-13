import ts from "typescript";
import { createArkTSCompilerHost } from "./compiler-host.js";
import { ARKTS_COMPONENT_DECORATOR, ARKTS_ENTRY_DECORATOR, ARKTS_INTRINSICS_FILE_NAME, ARKTS_STATE_DECORATOR, isArkTSIntrinsicFile, normalizeArkTSSource, } from "./arkts-language.js";
export class ArkTSAnalyzer {
    system;
    compilerOptions;
    inMemoryFiles = new Map();
    rootNames;
    host;
    program;
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
    }
    setRootNames(rootNames) {
        this.rootNames = [...rootNames];
        this.rebuildProgram();
    }
    setInMemoryFile(input) {
        this.inMemoryFiles.set(input.fileName, input.content);
        if (!this.rootNames.includes(input.fileName)) {
            this.rootNames = [...this.rootNames, input.fileName];
        }
        this.rebuildProgram();
    }
    removeInMemoryFile(fileName) {
        this.inMemoryFiles.delete(fileName);
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
        const declarationSourceFile = declaration.getSourceFile();
        return {
            fileName: declarationSourceFile.fileName,
            range: this.toRangeFromBounds(declarationSourceFile, declaration.getStart(declarationSourceFile), declaration.getEnd()),
            symbolName: symbol.getName(),
        };
    }
    rebuildProgram() {
        this.host = this.createHost();
        this.program = this.createProgram(this.rootNames);
    }
    createHost() {
        return createArkTSCompilerHost(this.compilerOptions, {
            inMemoryFiles: this.inMemoryFiles,
            system: this.system,
        });
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
            if (classDecorators.includes(ARKTS_COMPONENT_DECORATOR)) {
                const stateMembers = node.members
                    .map((member) => this.getStateMemberInfo(member, sourceFile))
                    .filter((member) => member !== undefined);
                const isEntry = classDecorators.includes(ARKTS_ENTRY_DECORATOR);
                if (isEntry || stateMembers.length > 0) {
                    components.push({
                        fileName: sourceFile.fileName,
                        name: node.name.text,
                        range: this.toRangeFromBounds(sourceFile, node.getStart(sourceFile), node.getEnd()),
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
    getStateMemberInfo(member, sourceFile) {
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
            range: this.toRangeFromBounds(sourceFile, member.getStart(sourceFile), member.getEnd()),
        };
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
//# sourceMappingURL=arkts-analyzer.js.map