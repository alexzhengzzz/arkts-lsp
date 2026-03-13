import ts from "typescript";
import { getArkTSIntrinsicsSource, isArkTSFile, isArkTSIntrinsicFile, normalizeArkTSSource, } from "./arkts-language.js";
export function createArkTSCompilerHost(compilerOptions, options = {}) {
    const system = options.system ?? ts.sys;
    const inMemoryFiles = options.inMemoryFiles ?? new Map();
    const host = ts.createCompilerHost(compilerOptions, true);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const originalDirectoryExists = host.directoryExists?.bind(host);
    const originalGetDirectories = host.getDirectories?.bind(host);
    host.fileExists = (fileName) => {
        return (isArkTSIntrinsicFile(fileName) ||
            inMemoryFiles.has(fileName) ||
            system.fileExists(fileName));
    };
    host.readFile = (fileName) => {
        if (isArkTSIntrinsicFile(fileName)) {
            return getArkTSIntrinsicsSource();
        }
        return inMemoryFiles.get(fileName) ?? system.readFile(fileName);
    };
    host.directoryExists = (directoryName) => {
        return (hasVirtualDirectory(inMemoryFiles, directoryName) ||
            originalDirectoryExists?.(directoryName) ||
            false);
    };
    host.getDirectories = (directoryName) => {
        const systemDirectories = originalGetDirectories?.(directoryName) ?? [];
        const virtualDirectories = getVirtualDirectories(inMemoryFiles, directoryName);
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
    return host;
}
function getLanguageVersion(value) {
    return typeof value === "number" ? value : value.languageVersion;
}
function hasVirtualDirectory(inMemoryFiles, directoryName) {
    const normalizedDirectoryName = normalizePath(directoryName);
    for (const fileName of inMemoryFiles.keys()) {
        const normalizedFileName = normalizePath(fileName);
        if (isSameOrWithinDirectory(normalizedFileName, normalizedDirectoryName)) {
            return true;
        }
    }
    return false;
}
function getVirtualDirectories(inMemoryFiles, directoryName) {
    const normalizedDirectoryName = normalizePath(directoryName);
    const directories = new Set();
    for (const fileName of inMemoryFiles.keys()) {
        const normalizedFileName = normalizePath(fileName);
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
function normalizePath(fileName) {
    return fileName.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
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