import ts from "typescript";
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
    confidence: "high" | "low";
    reason?: string | undefined;
}
export interface StateMemberInfo {
    name: string;
    decorator: string;
    range: AnalyzerRange;
}
export type DecoratedMemberKind = "state" | "prop" | "param" | "require" | "trace" | "computed" | "observed" | "observedV2" | "link" | "objectLink" | "provide" | "consume" | "storageProp" | "storageLink" | "localStorageProp" | "localStorageLink" | "builderParam" | "local" | "other";
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
export declare class ArkTSAnalyzer {
    private readonly system;
    private readonly compilerOptions;
    private readonly inMemoryFiles;
    private readonly inMemoryFileNames;
    private readonly programFileNames;
    private readonly scriptVersions;
    private rootNames;
    private host;
    private program;
    private languageService;
    constructor(options?: ArkTSAnalyzerOptions);
    setRootNames(rootNames: string[]): void;
    setInMemoryFile(input: AnalyzeTextInput): void;
    removeInMemoryFile(fileName: string): void;
    syncWorkspaceFiles(input: {
        rootNames: string[];
        changedFiles?: readonly string[];
        removedFiles?: readonly string[];
    }): void;
    getProgram(): ts.Program;
    getSourceFile(fileName: string): ts.SourceFile | undefined;
    collectDiagnostics(fileName?: string): AnalyzerDiagnostic[];
    findDecoratedComponents(fileName?: string): DecoratedComponentInfo[];
    findDefinition(fileName: string, position: AnalyzerPosition): DefinitionLocation | undefined;
    getHover(fileName: string, position: AnalyzerPosition): HoverInfo | undefined;
    findReferences(fileName: string, position: AnalyzerPosition): ReferenceLocation[];
    findImplementations(fileName: string, position: AnalyzerPosition): DefinitionLocation[];
    findTypeDefinitions(fileName: string, position: AnalyzerPosition): DefinitionLocation[];
    getDocumentSymbols(fileName: string): DocumentSymbol[];
    rebuildProgram(changedFileNames?: readonly string[]): void;
    private createHost;
    private createLanguageService;
    private createProgram;
    private collectLexicalDiagnostics;
    private collectDecoratedComponentsFromNode;
    private getDecoratedMemberInfos;
    private selectDefinitionDeclaration;
    private toAnalyzerDiagnostic;
    private toRangeFromBounds;
    private getTargetFileNames;
    private readFileText;
    private getResolvedSymbolContext;
    private findLocationsFromLanguageService;
    private toDefinitionLocation;
    private toReferenceLocation;
    private toDefinitionLocationFromSpan;
    private getSymbolNameFromTextSpan;
    private toDocumentSymbol;
    private isSupportedSourceFile;
    private bumpScriptVersions;
    private bumpScriptVersion;
    private refreshProgramFileNames;
    private resolveKnownFileName;
    private findRootNameByIdentity;
    private dedupeFileNames;
    private getFileIdentity;
}
