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

  return host;
}
function getLanguageVersion(
  value: ts.ScriptTarget | ts.CreateSourceFileOptions,
): ts.ScriptTarget {
  return typeof value === "number" ? value : value.languageVersion;
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
