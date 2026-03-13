import ts from "typescript";
export interface ArkTSCompilerHostOptions {
    inMemoryFiles?: ReadonlyMap<string, string>;
    system?: ts.System;
}
export declare function createArkTSCompilerHost(compilerOptions: ts.CompilerOptions, options?: ArkTSCompilerHostOptions): ts.CompilerHost;
