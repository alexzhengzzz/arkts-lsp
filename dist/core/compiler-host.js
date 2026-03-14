import path from "node:path";
import ts from "typescript";
import { ARKTS_INTRINSICS_FILE_NAME, getArkTSIntrinsicsSource, isArkTSFile, isArkTSIntrinsicFile, normalizeArkTSSource, } from "./arkts-language.js";
export function createArkTSCompilerHost(compilerOptions, options = {}) {
    const system = options.system ?? ts.sys;
    const inMemoryFiles = options.inMemoryFiles ?? new Map();
    const useCaseSensitiveFileNames = system.useCaseSensitiveFileNames;
    const inMemoryFileEntries = indexEntriesByInternalFileName(inMemoryFiles, useCaseSensitiveFileNames);
    const host = ts.createCompilerHost(compilerOptions, true);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const originalDirectoryExists = host.directoryExists?.bind(host);
    const originalGetDirectories = host.getDirectories?.bind(host);
    const resolutionHost = createModuleResolutionHost(system, inMemoryFiles, currentDirectoryFromSystem(system));
    host.fileExists = (fileName) => {
        return (isArkTSIntrinsicFile(fileName) ||
            inMemoryFileEntries.has(canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames)) ||
            system.fileExists(fileName));
    };
    host.readFile = (fileName) => {
        if (isArkTSIntrinsicFile(fileName)) {
            return getArkTSIntrinsicsSource();
        }
        return (inMemoryFileEntries.get(canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames))?.value ?? system.readFile(fileName));
    };
    host.directoryExists = (directoryName) => {
        return (hasVirtualDirectory(inMemoryFileEntries.values(), directoryName, useCaseSensitiveFileNames) ||
            originalDirectoryExists?.(directoryName) ||
            false);
    };
    host.getDirectories = (directoryName) => {
        const systemDirectories = originalGetDirectories?.(directoryName) ?? [];
        const virtualDirectories = getVirtualDirectories(inMemoryFileEntries.values(), directoryName, useCaseSensitiveFileNames);
        return [...new Set([...systemDirectories, ...virtualDirectories])];
    };
    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (isArkTSFile(fileName)) {
            const sourceText = host.readFile(fileName);
            if (sourceText === undefined) {
                onError?.(`Cannot read ArkTS file: ${fileName}`);
                return undefined;
            }
            return ts.createSourceFile(fileName, normalizeArkTSSource(fileName, sourceText), getLanguageVersion(languageVersionOrOptions), true, ts.ScriptKind.TS);
        }
        if (isArkTSIntrinsicFile(fileName)) {
            return ts.createSourceFile(fileName, getArkTSIntrinsicsSource(), getLanguageVersion(languageVersionOrOptions), true, ts.ScriptKind.TS);
        }
        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    };
    host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => resolveModuleNameWithArkTSFallback(moduleName, containingFile, compilerOptions, resolutionHost));
    return host;
}
export function createArkTSLanguageServiceHost(rootNames, compilerOptions, options = {}) {
    const system = options.system ?? ts.sys;
    const inMemoryFiles = options.inMemoryFiles ?? new Map();
    const versions = options.versions ?? new Map();
    const useCaseSensitiveFileNames = system.useCaseSensitiveFileNames;
    const inMemoryFileEntries = indexEntriesByInternalFileName(inMemoryFiles, useCaseSensitiveFileNames);
    const versionEntries = indexEntriesByInternalFileName(versions, useCaseSensitiveFileNames);
    const currentDirectory = options.currentDirectory ?? system.getCurrentDirectory();
    const scriptFileNames = withArkTSIntrinsics(rootNames);
    const resolutionHost = createModuleResolutionHost(system, inMemoryFiles, currentDirectory);
    const host = {
        getCompilationSettings: () => compilerOptions,
        getCurrentDirectory: () => currentDirectory,
        getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
        getScriptFileNames: () => [...scriptFileNames],
        getScriptVersion: (fileName) => versionEntries.get(canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames))?.value ?? "0",
        getScriptKind: (fileName) => isArkTSFile(fileName) || isArkTSIntrinsicFile(fileName)
            ? ts.ScriptKind.TS
            : inferScriptKind(fileName),
        getScriptSnapshot: (fileName) => {
            const sourceText = readSourceText(fileName, inMemoryFiles, system, useCaseSensitiveFileNames);
            if (sourceText === undefined) {
                return undefined;
            }
            return ts.ScriptSnapshot.fromString(sourceText);
        },
        fileExists: (fileName) => isArkTSIntrinsicFile(fileName) ||
            inMemoryFileEntries.has(canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames)) ||
            system.fileExists(fileName),
        readFile: (fileName) => readSourceText(fileName, inMemoryFiles, system, useCaseSensitiveFileNames),
        directoryExists: (directoryName) => hasVirtualDirectory(inMemoryFileEntries.values(), directoryName, useCaseSensitiveFileNames) ||
            system.directoryExists?.(directoryName) ||
            false,
        getDirectories: (directoryName) => {
            const systemDirectories = system.getDirectories?.(directoryName) ?? [];
            const virtualDirectories = getVirtualDirectories(inMemoryFileEntries.values(), directoryName, useCaseSensitiveFileNames);
            return [...new Set([...systemDirectories, ...virtualDirectories])];
        },
        resolveModuleNames: (moduleNames, containingFile) => moduleNames.map((moduleName) => resolveModuleNameWithArkTSFallback(moduleName, containingFile, compilerOptions, resolutionHost)),
        readDirectory: system.readDirectory?.bind(system),
        useCaseSensitiveFileNames: () => system.useCaseSensitiveFileNames,
    };
    if (system.realpath) {
        host.realpath = system.realpath.bind(system);
    }
    return host;
}
function getLanguageVersion(value) {
    return typeof value === "number" ? value : value.languageVersion;
}
function withArkTSIntrinsics(rootNames) {
    return rootNames.includes(ARKTS_INTRINSICS_FILE_NAME)
        ? [...rootNames]
        : [...rootNames, ARKTS_INTRINSICS_FILE_NAME];
}
function readSourceText(fileName, inMemoryFiles, system, useCaseSensitiveFileNames = system.useCaseSensitiveFileNames) {
    if (isArkTSIntrinsicFile(fileName)) {
        return getArkTSIntrinsicsSource();
    }
    const sourceText = indexEntriesByInternalFileName(inMemoryFiles, useCaseSensitiveFileNames).get(canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames))?.value ?? system.readFile(fileName);
    if (sourceText === undefined) {
        return undefined;
    }
    return normalizeArkTSSource(fileName, sourceText);
}
function inferScriptKind(fileName) {
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
function createModuleResolutionHost(system, inMemoryFiles, currentDirectory) {
    const useCaseSensitiveFileNames = system.useCaseSensitiveFileNames;
    const inMemoryFileEntries = indexEntriesByInternalFileName(inMemoryFiles, useCaseSensitiveFileNames);
    const host = {
        fileExists: (fileName) => isArkTSIntrinsicFile(fileName) ||
            inMemoryFileEntries.has(canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames)) ||
            system.fileExists(fileName),
        readFile: (fileName) => readSourceText(fileName, inMemoryFiles, system, useCaseSensitiveFileNames),
        directoryExists: (directoryName) => hasVirtualDirectory(inMemoryFileEntries.values(), directoryName, useCaseSensitiveFileNames) ||
            system.directoryExists?.(directoryName) ||
            false,
        getDirectories: (directoryName) => {
            const systemDirectories = system.getDirectories?.(directoryName) ?? [];
            const virtualDirectories = getVirtualDirectories(inMemoryFileEntries.values(), directoryName, useCaseSensitiveFileNames);
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
function resolveModuleNameWithArkTSFallback(moduleName, containingFile, compilerOptions, resolutionHost) {
    const resolved = ts.resolveModuleName(moduleName, containingFile, compilerOptions, resolutionHost).resolvedModule;
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
        const resolvedModule = {
            resolvedFileName: candidate,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
        };
        return resolvedModule;
    }
    return undefined;
}
function currentDirectoryFromSystem(system) {
    return system.getCurrentDirectory();
}
function hasVirtualDirectory(inMemoryFiles, directoryName, useCaseSensitiveFileNames) {
    const normalizedDirectoryName = canonicalizeInternalFileName(directoryName, useCaseSensitiveFileNames);
    for (const file of inMemoryFiles) {
        const normalizedFileName = canonicalizeInternalFileName(file.fileName, useCaseSensitiveFileNames);
        if (isSameOrWithinDirectory(normalizedFileName, normalizedDirectoryName)) {
            return true;
        }
    }
    return false;
}
function getVirtualDirectories(inMemoryFiles, directoryName, useCaseSensitiveFileNames) {
    const normalizedDirectoryName = canonicalizeInternalFileName(directoryName, useCaseSensitiveFileNames);
    const directories = new Set();
    for (const file of inMemoryFiles) {
        const normalizedFileName = canonicalizeInternalFileName(file.fileName, useCaseSensitiveFileNames);
        if (!isSameOrWithinDirectory(normalizedFileName, normalizedDirectoryName)) {
            continue;
        }
        const remainder = normalizedDirectoryName === "/"
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
export function canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames) {
    if (isArkTSIntrinsicFile(fileName)) {
        return ARKTS_INTRINSICS_FILE_NAME;
    }
    const normalizedPath = path.normalize(fileName).replace(/\\/g, "/") || "/";
    const root = getPathRoot(normalizedPath);
    const canonicalPath = normalizedPath.length > root.length
        ? normalizedPath.replace(/\/+$/, "")
        : normalizedPath;
    return useCaseSensitiveFileNames ? canonicalPath : canonicalPath.toLowerCase();
}
export function dedupeFileNamesByInternalIdentity(fileNames, useCaseSensitiveFileNames = ts.sys.useCaseSensitiveFileNames) {
    return [...indexEntriesByInternalFileName(fileNames.map((fileName) => [fileName, fileName]), useCaseSensitiveFileNames).values()].map((entry) => entry.fileName);
}
function getPathRoot(fileName) {
    const uncRoot = fileName.match(/^\/\/[^/]+\/[^/]+\/?/u)?.[0];
    if (uncRoot) {
        return uncRoot;
    }
    const driveRoot = fileName.match(/^[A-Za-z]:\/?/u)?.[0];
    if (driveRoot) {
        return driveRoot.endsWith("/") ? driveRoot : `${driveRoot}/`;
    }
    return fileName.startsWith("/") ? "/" : "";
}
function indexEntriesByInternalFileName(entries, useCaseSensitiveFileNames) {
    const indexedEntries = new Map();
    for (const [fileName, value] of entries) {
        indexedEntries.set(canonicalizeInternalFileName(fileName, useCaseSensitiveFileNames), {
            fileName,
            value,
        });
    }
    return indexedEntries;
}
function joinNormalizedPath(directoryName, segment) {
    return directoryName === "/" ? `/${segment}` : `${directoryName}/${segment}`;
}
function isSameOrWithinDirectory(fileName, directoryName) {
    if (fileName === directoryName) {
        return true;
    }
    return directoryName === "/"
        ? fileName.startsWith("/")
        : fileName.startsWith(`${directoryName}/`);
}
//# sourceMappingURL=compiler-host.js.map