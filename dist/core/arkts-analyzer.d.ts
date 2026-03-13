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
export declare class ArkTSAnalyzer {
    private readonly system;
    private readonly compilerOptions;
    private readonly inMemoryFiles;
    private rootNames;
    private host;
    private program;
    constructor(options?: ArkTSAnalyzerOptions);
    setRootNames(rootNames: string[]): void;
    setInMemoryFile(input: AnalyzeTextInput): void;
    removeInMemoryFile(fileName: string): void;
    getProgram(): ts.Program;
    getSourceFile(fileName: string): ts.SourceFile | undefined;
    collectDiagnostics(fileName?: string): AnalyzerDiagnostic[];
    findDecoratedComponents(fileName?: string): DecoratedComponentInfo[];
    findDefinition(fileName: string, position: AnalyzerPosition): DefinitionLocation | undefined;
    rebuildProgram(): void;
    private createHost;
    private createProgram;
    private collectLexicalDiagnostics;
    private collectDecoratedComponentsFromNode;
    private getStateMemberInfo;
    private selectDefinitionDeclaration;
    private toAnalyzerDiagnostic;
    private toRangeFromBounds;
    private getTargetFileNames;
    private readFileText;
}
