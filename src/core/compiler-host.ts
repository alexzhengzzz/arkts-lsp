import path from "node:path";

import ts from "typescript";
import {
  ARKTS_INTRINSICS_FILE_NAME,
  getArkTSIntrinsicsSource,
  isArkTSFile,
  isArkTSIntrinsicFile,
  normalizeArkTSSource,
} from "./arkts-language.js";

export interface ArkTSCompilerHostOptions {
  inMemoryFiles?: ReadonlyMap<string, string>;
  system?: ts.System;
}

export interface ArkTSLanguageServiceHostOptions extends ArkTSCompilerHostOptions {
  versions?: ReadonlyMap<string, string>;
  currentDirectory?: string;
}

export function createArkTSCompilerHost(
  compilerOptions: ts.CompilerOptions,
  options: ArkTSCompilerHostOptions = {},
): ts.CompilerHost {
  const system = options.system ?? ts.sys;
  const inMemoryFiles = options.inMemoryFiles ?? new Map<string, string>();
  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalDirectoryExists = host.directoryExists?.bind(host);
  const originalGetDirectories = host.getDirectories?.bind(host);
  const resolutionHost = createModuleResolutionHost(system, inMemoryFiles, currentDirectoryFromSystem(system));

  host.fileExists = (fileName) => {
    return (
      isArkTSIntrinsicFile(fileName) ||
      inMemoryFiles.has(fileName) ||
      system.fileExists(fileName)
    );
  };

  host.readFile = (fileName) => {
    if (isArkTSIntrinsicFile(fileName)) {
      return getArkTSIntrinsicsSource();
    }

    return inMemoryFiles.get(fileName) ?? system.readFile(fileName);
  };

  host.directoryExists = (directoryName) => {
    return (
      hasVirtualDirectory(inMemoryFiles, directoryName) ||
      originalDirectoryExists?.(directoryName) ||
      false
    );
  };

  host.getDirectories = (directoryName) => {
    const systemDirectories = originalGetDirectories?.(directoryName) ?? [];
    const virtualDirectories = getVirtualDirectories(inMemoryFiles, directoryName);

    return [...new Set([...systemDirectories, ...virtualDirectories])];
  };

  host.getSourceFile = (
    fileName,
    languageVersionOrOptions,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    if (isArkTSFile(fileName)) {
      const sourceText = host.readFile(fileName);

      if (sourceText === undefined) {
        onError?.(`Cannot read ArkTS file: ${fileName}`);
        return undefined;
      }

      return ts.createSourceFile(
        fileName,
        normalizeArkTSSource(fileName, sourceText),
        getLanguageVersion(languageVersionOrOptions),
        true,
        ts.ScriptKind.TS,
      );
    }

    if (isArkTSIntrinsicFile(fileName)) {
      return ts.createSourceFile(
        fileName,
        getArkTSIntrinsicsSource(),
        getLanguageVersion(languageVersionOrOptions),
        true,
        ts.ScriptKind.TS,
      );
    }

    return originalGetSourceFile(
      fileName,
      languageVersionOrOptions,
      onError,
      shouldCreateNewSourceFile,
    );
  };

  host.resolveModuleNames = (moduleNames, containingFile) =>
    moduleNames.map((moduleName) =>
      resolveModuleNameWithArkTSFallback(
        moduleName,
        containingFile,
        compilerOptions,
        resolutionHost,
      ),
    );

  return host;
}

export function createArkTSLanguageServiceHost(
  rootNames: readonly string[],
  compilerOptions: ts.CompilerOptions,
  options: ArkTSLanguageServiceHostOptions = {},
): ts.LanguageServiceHost {
  const system = options.system ?? ts.sys;
  const inMemoryFiles = options.inMemoryFiles ?? new Map<string, string>();
  const versions = options.versions ?? new Map<string, string>();
  const currentDirectory = options.currentDirectory ?? system.getCurrentDirectory();
  const scriptFileNames = withArkTSIntrinsics(rootNames);
  const resolutionHost = createModuleResolutionHost(system, inMemoryFiles, currentDirectory);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getCurrentDirectory: () => currentDirectory,
    getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
    getScriptFileNames: () => [...scriptFileNames],
    getScriptVersion: (fileName) => versions.get(fileName) ?? "0",
    getScriptKind: (fileName) =>
      isArkTSFile(fileName) || isArkTSIntrinsicFile(fileName)
        ? ts.ScriptKind.TS
        : inferScriptKind(fileName),
    getScriptSnapshot: (fileName) => {
      const sourceText = readSourceText(fileName, inMemoryFiles, system);
      if (sourceText === undefined) {
        return undefined;
      }

      return ts.ScriptSnapshot.fromString(sourceText);
    },
    fileExists: (fileName) =>
      isArkTSIntrinsicFile(fileName) ||
      inMemoryFiles.has(fileName) ||
      system.fileExists(fileName),
    readFile: (fileName) => readSourceText(fileName, inMemoryFiles, system),
    directoryExists: (directoryName) =>
      hasVirtualDirectory(inMemoryFiles, directoryName) ||
      system.directoryExists?.(directoryName) ||
      false,
    getDirectories: (directoryName) => {
      const systemDirectories = system.getDirectories?.(directoryName) ?? [];
      const virtualDirectories = getVirtualDirectories(inMemoryFiles, directoryName);

      return [...new Set([...systemDirectories, ...virtualDirectories])];
    },
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((moduleName) =>
        resolveModuleNameWithArkTSFallback(
          moduleName,
          containingFile,
          compilerOptions,
          resolutionHost,
        ),
      ),
    readDirectory: system.readDirectory?.bind(system),
    useCaseSensitiveFileNames: () => system.useCaseSensitiveFileNames,
  };

  if (system.realpath) {
    host.realpath = system.realpath.bind(system);
  }

  return host;
}

function getLanguageVersion(
  value: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.ScriptTarget {
  return typeof value === "number" ? value : value.languageVersion;
}

function withArkTSIntrinsics(rootNames: readonly string[]): string[] {
  return rootNames.includes(ARKTS_INTRINSICS_FILE_NAME)
    ? [...rootNames]
    : [...rootNames, ARKTS_INTRINSICS_FILE_NAME];
}

function readSourceText(
  fileName: string,
  inMemoryFiles: ReadonlyMap<string, string>,
  system: ts.System,
): string | undefined {
  if (isArkTSIntrinsicFile(fileName)) {
    return getArkTSIntrinsicsSource();
  }

  const sourceText = inMemoryFiles.get(fileName) ?? system.readFile(fileName);
  if (sourceText === undefined) {
    return undefined;
  }

  return normalizeArkTSSource(fileName, sourceText);
}

function inferScriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (fileName.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }

  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }

  if (fileName.endsWith(".json")) {
    return ts.ScriptKind.JSON;
  }

  return ts.ScriptKind.TS;
}

function createModuleResolutionHost(
  system: ts.System,
  inMemoryFiles: ReadonlyMap<string, string>,
  currentDirectory: string,
): ts.ModuleResolutionHost {
  const host: ts.ModuleResolutionHost = {
    fileExists: (fileName) =>
      isArkTSIntrinsicFile(fileName) ||
      inMemoryFiles.has(fileName) ||
      system.fileExists(fileName),
    readFile: (fileName) => readSourceText(fileName, inMemoryFiles, system),
    directoryExists: (directoryName) =>
      hasVirtualDirectory(inMemoryFiles, directoryName) ||
      system.directoryExists?.(directoryName) ||
      false,
    getDirectories: (directoryName) => {
      const systemDirectories = system.getDirectories?.(directoryName) ?? [];
      const virtualDirectories = getVirtualDirectories(inMemoryFiles, directoryName);

      return [...new Set([...systemDirectories, ...virtualDirectories])];
    },
    useCaseSensitiveFileNames: system.useCaseSensitiveFileNames,
    getCurrentDirectory: () => currentDirectory,
  };

  if (system.realpath) {
    host.realpath = system.realpath.bind(system);
  }

  return host;
}

function resolveModuleNameWithArkTSFallback(
  moduleName: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
  resolutionHost: ts.ModuleResolutionHost,
): ts.ResolvedModule | undefined {
  const resolved = ts.resolveModuleName(
    moduleName,
    containingFile,
    compilerOptions,
    resolutionHost,
  ).resolvedModule;

  if (resolved) {
    return resolved;
  }

  if (!moduleName.startsWith(".")) {
    return undefined;
  }

  const containingDirectory = path.dirname(containingFile);
  const resolvedBase = path.resolve(containingDirectory, moduleName);
  const candidates = [
    `${resolvedBase}.ets`,
    `${resolvedBase}.ts`,
    path.join(resolvedBase, "index.ets"),
    path.join(resolvedBase, "index.ts"),
  ];

  for (const candidate of candidates) {
    if (!resolutionHost.fileExists(candidate)) {
      continue;
    }

    const resolvedModule: ts.ResolvedModuleFull = {
      resolvedFileName: candidate,
      extension: ts.Extension.Ts,
      isExternalLibraryImport: false,
    };

    return resolvedModule;
  }

  return undefined;
}

function currentDirectoryFromSystem(system: ts.System): string {
  return system.getCurrentDirectory();
}

function hasVirtualDirectory(
  inMemoryFiles: ReadonlyMap<string, string>,
  directoryName: string,
): boolean {
  const normalizedDirectoryName = normalizePath(directoryName);

  for (const fileName of inMemoryFiles.keys()) {
    const normalizedFileName = normalizePath(fileName);

    if (isSameOrWithinDirectory(normalizedFileName, normalizedDirectoryName)) {
      return true;
    }
  }

  return false;
}

function getVirtualDirectories(
  inMemoryFiles: ReadonlyMap<string, string>,
  directoryName: string,
): string[] {
  const normalizedDirectoryName = normalizePath(directoryName);
  const directories = new Set<string>();

  for (const fileName of inMemoryFiles.keys()) {
    const normalizedFileName = normalizePath(fileName);
    if (!isSameOrWithinDirectory(normalizedFileName, normalizedDirectoryName)) {
      continue;
    }

    const remainder =
      normalizedDirectoryName === "/"
        ? normalizedFileName.slice(1)
        : normalizedFileName.slice(normalizedDirectoryName.length + 1);
    const nextSegment = remainder.split("/")[0];
    if (!nextSegment) {
      continue;
    }

    directories.add(joinNormalizedPath(normalizedDirectoryName, nextSegment));
  }

  return [...directories];
}

function normalizePath(fileName: string): string {
  return fileName.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

function joinNormalizedPath(directoryName: string, segment: string): string {
  return directoryName === "/" ? `/${segment}` : `${directoryName}/${segment}`;
}

function isSameOrWithinDirectory(fileName: string, directoryName: string): boolean {
  if (fileName === directoryName) {
    return true;
  }

  return directoryName === "/"
    ? fileName.startsWith("/")
    : fileName.startsWith(`${directoryName}/`);
}
