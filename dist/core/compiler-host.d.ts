import ts from "typescript";
export interface ArkTSCompilerHostOptions {
    inMemoryFiles?: ReadonlyMap<string, string>;
    system?: ts.System;
}
export interface ArkTSLanguageServiceHostOptions extends ArkTSCompilerHostOptions {
    versions?: ReadonlyMap<string, string>;
    currentDirectory?: string;
}
export declare function createArkTSCompilerHost(compilerOptions: ts.CompilerOptions, options?: ArkTSCompilerHostOptions): ts.CompilerHost;
export declare function createArkTSLanguageServiceHost(rootNames: readonly string[], compilerOptions: ts.CompilerOptions, options?: ArkTSLanguageServiceHostOptions): ts.LanguageServiceHost;
