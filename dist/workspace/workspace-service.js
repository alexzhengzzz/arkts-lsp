import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { ArkTSAnalyzer, } from "../core/arkts-analyzer.js";
import { ARKTS_INTRINSICS_FILE_NAME, isArkTSFile } from "../core/arkts-language.js";
const WORKSPACE_SNAPSHOT_VERSION = "workspace-snapshot-v1";
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_INCLUDE = [
    "**/*.ets",
    "**/*.ts",
    "**/*.js",
    "**/*.mjs",
    "**/*.cjs",
];
const DEFAULT_EXCLUDE = [
    "**/.git/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/build/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/.arkts-mcp-cache/**",
];
export class WorkspaceService {
    workspaceRoot;
    options;
    static sessions = new Map();
    static async initialize(root, options = {}) {
        const workspaceRoot = await normalizeWorkspaceRoot(root);
        const normalizedOptions = normalizeWorkspaceOptions(workspaceRoot, options);
        const sessionKey = `${workspaceRoot}:${hashString(stableStringify(normalizedOptions))}`;
        const existing = WorkspaceService.sessions.get(sessionKey);
        if (existing) {
            existing.cacheStatus = "memory";
            return existing;
        }
        const service = new WorkspaceService(workspaceRoot, normalizedOptions);
        await service.loadOrBuildSnapshot();
        WorkspaceService.sessions.set(sessionKey, service);
        return service;
    }
    static resetForTests() {
        WorkspaceService.sessions.clear();
    }
    workspaceId;
    optionsHash;
    cacheFile;
    snapshot = null;
    fileStates = [];
    discoveredFiles = [];
    truncated = false;
    cacheStatus = "rebuilt";
    constructor(workspaceRoot, options) {
        this.workspaceRoot = workspaceRoot;
        this.options = options;
        this.workspaceId = hashString(this.workspaceRoot).slice(0, 12);
        this.optionsHash = hashString(stableStringify(this.options));
        this.cacheFile = path.join(this.options.cacheDir, `${this.workspaceId}.json`);
    }
    getOverview() {
        const snapshot = this.requireSnapshot();
        return {
            workspaceId: snapshot.workspaceId,
            workspaceRoot: snapshot.workspaceRoot,
            fileCount: snapshot.fileCount,
            symbolCount: snapshot.symbolCount,
            edgeCount: snapshot.edgeCount,
            truncated: snapshot.truncated,
            entryFiles: [...snapshot.entryFiles],
            hotFiles: [...snapshot.hotFiles],
            cacheStatus: this.cacheStatus,
            overview: snapshot.overviewText,
        };
    }
    async refresh(changedFiles = []) {
        const normalizedChangedFiles = changedFiles.map((fileName) => this.resolveWorkspacePath(fileName));
        await this.rebuildSnapshot();
        return {
            workspaceId: this.workspaceId,
            refreshedFiles: normalizedChangedFiles,
            fileCount: this.requireSnapshot().fileCount,
            symbolCount: this.requireSnapshot().symbolCount,
            edgeCount: this.requireSnapshot().edgeCount,
            cacheStatus: this.cacheStatus,
        };
    }
    async summarizeFile(fileName, overlays = []) {
        const snapshot = this.requireSnapshot();
        const normalizedFileName = this.resolveWorkspacePath(fileName);
        const overlayMap = toOverlayMap(this.workspaceRoot, overlays);
        if (overlayMap.size === 0) {
            const existing = snapshot.files.find((file) => file.fileName === normalizedFileName);
            if (existing) {
                return existing;
            }
        }
        const analysisFiles = dedupePaths([
            ...this.discoveredFiles,
            normalizedFileName,
            ...overlayMap.keys(),
        ]);
        const analyzer = new ArkTSAnalyzer({
            rootNames: analysisFiles,
        });
        for (const [overlayFileName, content] of overlayMap.entries()) {
            analyzer.setInMemoryFile({
                fileName: overlayFileName,
                content,
            });
        }
        return this.createFileSummary(analyzer, normalizedFileName);
    }
    findSymbol(query, options = {}) {
        const snapshot = this.requireSnapshot();
        const normalizedQuery = query.trim().toLowerCase();
        const limit = clamp(options.limit ?? 10, 1, 50);
        const matches = normalizedQuery.length === 0
            ? []
            : [...snapshot.symbols]
                .sort((left, right) => rankSymbolMatch(left.name, normalizedQuery) -
                rankSymbolMatch(right.name, normalizedQuery) ||
                left.name.localeCompare(right.name) ||
                left.fileName.localeCompare(right.fileName))
                .filter((symbol) => symbol.name.toLowerCase().includes(normalizedQuery))
                .slice(0, limit);
        return {
            query,
            matches,
        };
    }
    async getRelatedFiles(options) {
        const snapshot = this.requireSnapshot();
        const limit = clamp(options.limit ?? 6, 1, 20);
        const targetFile = this.resolveTargetFile(options.targetFile, options.symbolQuery);
        const summary = snapshot.files.find((file) => file.fileName === targetFile);
        if (!summary) {
            throw new Error(`Target file is not indexed in workspace: ${targetFile}`);
        }
        const outgoing = snapshot.moduleEdges.filter((edge) => edge.from === targetFile);
        const incoming = snapshot.moduleEdges.filter((edge) => edge.to === targetFile);
        const rankedFiles = new Map();
        rankedFiles.set(targetFile, await this.createContextFile(summary, "self", "Primary target file."));
        for (const edge of outgoing) {
            const dependency = snapshot.files.find((file) => file.fileName === edge.to);
            if (!dependency || rankedFiles.has(dependency.fileName)) {
                continue;
            }
            rankedFiles.set(dependency.fileName, await this.createContextFile(dependency, "imports", `Imported via ${edge.specifier}.`));
            if (rankedFiles.size >= limit) {
                break;
            }
        }
        if (rankedFiles.size < limit) {
            for (const edge of incoming) {
                const importer = snapshot.files.find((file) => file.fileName === edge.from);
                if (!importer || rankedFiles.has(importer.fileName)) {
                    continue;
                }
                rankedFiles.set(importer.fileName, await this.createContextFile(importer, "importedBy", `Imports the target through ${edge.specifier}.`));
                if (rankedFiles.size >= limit) {
                    break;
                }
            }
        }
        if (rankedFiles.size < limit) {
            for (const edge of outgoing) {
                const transitiveEdges = snapshot.moduleEdges.filter((candidate) => candidate.from === edge.to);
                for (const transitiveEdge of transitiveEdges) {
                    const dependency = snapshot.files.find((file) => file.fileName === transitiveEdge.to);
                    if (!dependency || rankedFiles.has(dependency.fileName)) {
                        continue;
                    }
                    rankedFiles.set(dependency.fileName, await this.createContextFile(dependency, "dependency", `Transitively required from ${summary.relativePath}.`));
                    if (rankedFiles.size >= limit) {
                        break;
                    }
                }
                if (rankedFiles.size >= limit) {
                    break;
                }
            }
        }
        return {
            rootFile: summary.fileName,
            reason: options.symbolQuery !== undefined
                ? `Context bundle for symbol query "${options.symbolQuery}".`
                : `Context bundle for ${summary.relativePath}.`,
            files: [...rankedFiles.values()].slice(0, limit),
        };
    }
    async explainModule(fileName, overlays = []) {
        const file = await this.summarizeFile(fileName, overlays);
        const context = await this.getRelatedFiles({
            targetFile: file.fileName,
            limit: 6,
        });
        return {
            file,
            context,
        };
    }
    async traceDependencies(options) {
        const snapshot = this.requireSnapshot();
        const targetFile = this.resolveTargetFile(options.targetFile, options.symbolQuery);
        const depth = clamp(options.depth ?? 2, 1, 5);
        const limit = clamp(options.limit ?? 25, 1, 100);
        const queue = [{ fileName: targetFile, depth: 0 }];
        const visited = new Set();
        const nodes = [];
        const edges = [];
        let truncated = false;
        while (queue.length > 0) {
            const current = queue.shift();
            if (!current || visited.has(current.fileName)) {
                continue;
            }
            visited.add(current.fileName);
            const summary = snapshot.files.find((file) => file.fileName === current.fileName);
            if (!summary) {
                continue;
            }
            nodes.push({
                fileName: summary.fileName,
                relativePath: summary.relativePath,
                role: summary.role,
            });
            if (nodes.length >= limit) {
                truncated = true;
                break;
            }
            if (current.depth >= depth) {
                continue;
            }
            const outgoing = snapshot.moduleEdges.filter((edge) => edge.from === current.fileName);
            for (const edge of outgoing) {
                if (!edges.some((candidate) => isSameEdge(candidate, edge))) {
                    edges.push(edge);
                }
                if (!visited.has(edge.to)) {
                    queue.push({
                        fileName: edge.to,
                        depth: current.depth + 1,
                    });
                }
            }
        }
        return {
            rootFile: targetFile,
            depth,
            truncated,
            nodes,
            edges,
        };
    }
    async loadOrBuildSnapshot() {
        const discovery = await discoverWorkspaceFiles(this.workspaceRoot, this.options);
        this.discoveredFiles = discovery.fileNames;
        this.truncated = discovery.truncated;
        const fileStates = await collectFileStates(this.discoveredFiles);
        if (this.options.freshness === "mtime") {
            const persisted = await this.loadPersistedSnapshot();
            if (persisted &&
                persisted.optionsHash === this.optionsHash &&
                persisted.truncated === this.truncated &&
                areFileStatesEqual(persisted.fileStates, fileStates)) {
                this.snapshot = persisted.snapshot;
                this.fileStates = fileStates;
                this.cacheStatus = "hit";
                return;
            }
        }
        await this.rebuildSnapshot();
    }
    async rebuildSnapshot() {
        const discovery = await discoverWorkspaceFiles(this.workspaceRoot, this.options);
        this.discoveredFiles = discovery.fileNames;
        this.truncated = discovery.truncated;
        const buildResult = await this.buildSnapshot(this.discoveredFiles, this.truncated);
        this.snapshot = buildResult.snapshot;
        this.fileStates = buildResult.fileStates;
        this.cacheStatus = "rebuilt";
        await this.persistSnapshot();
    }
    async buildSnapshot(fileNames, truncated) {
        const analyzer = new ArkTSAnalyzer({
            rootNames: fileNames,
        });
        const fileSummaries = fileNames.map((fileName) => this.createFileSummary(analyzer, fileName));
        const moduleEdges = dedupeModuleEdges(fileSummaries.flatMap((file) => file.imports
            .filter((record) => record.resolvedPath !== null)
            .map((record) => ({
            from: file.fileName,
            to: record.resolvedPath,
            kind: record.kind,
            specifier: record.specifier,
            symbols: record.importedSymbols,
        }))));
        const symbols = fileSummaries
            .flatMap((file) => file.topLevelSymbols.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            fileName: file.fileName,
            relativePath: file.relativePath,
            range: symbol.range,
            exported: symbol.exported,
        })))
            .sort((left, right) => left.name.localeCompare(right.name) ||
            left.fileName.localeCompare(right.fileName));
        const hotFiles = computeHotFiles(fileSummaries, moduleEdges);
        const entryFiles = fileSummaries
            .filter((file) => file.role === "entrypoint")
            .map((file) => file.fileName);
        const fileStates = await collectFileStates(fileNames);
        const timestamp = new Date().toISOString();
        const snapshot = {
            version: WORKSPACE_SNAPSHOT_VERSION,
            workspaceId: this.workspaceId,
            workspaceRoot: this.workspaceRoot,
            createdAt: this.snapshot?.createdAt ?? timestamp,
            updatedAt: timestamp,
            fileCount: fileSummaries.length,
            symbolCount: symbols.length,
            edgeCount: moduleEdges.length,
            truncated,
            maxFiles: this.options.maxFiles,
            include: [...this.options.include],
            exclude: [...this.options.exclude],
            entryFiles,
            hotFiles,
            files: fileSummaries.sort((left, right) => left.fileName.localeCompare(right.fileName)),
            symbols,
            moduleEdges,
            overviewText: createWorkspaceOverviewText(fileSummaries.length, symbols.length, moduleEdges.length, entryFiles.length, truncated),
        };
        return {
            snapshot,
            fileStates,
            truncated,
        };
    }
    createFileSummary(analyzer, fileName) {
        const sourceFile = analyzer.getSourceFile(fileName);
        if (!sourceFile) {
            throw new Error(`Unable to analyze file: ${fileName}`);
        }
        const relativePath = path.relative(this.workspaceRoot, fileName) || path.basename(fileName);
        const normalizedRelativePath = toPosixPath(relativePath);
        const components = analyzer
            .findDecoratedComponents(fileName)
            .map((component) => toComponentSummary(component));
        const fileFacts = extractFileFacts(sourceFile, this.workspaceRoot, fileName);
        const role = classifyFileRole(fileName, components, fileFacts);
        return {
            fileName,
            relativePath: normalizedRelativePath,
            language: detectWorkspaceLanguage(fileName),
            role,
            summary: createFileSummaryText(normalizedRelativePath, role, fileFacts.exports, fileFacts.imports, components),
            imports: fileFacts.imports,
            exports: fileFacts.exports,
            topLevelSymbols: fileFacts.topLevelSymbols,
            components,
        };
    }
    async persistSnapshot() {
        const snapshot = this.requireSnapshot();
        const persisted = {
            version: WORKSPACE_SNAPSHOT_VERSION,
            workspaceId: this.workspaceId,
            workspaceRoot: this.workspaceRoot,
            optionsHash: this.optionsHash,
            fileStates: this.fileStates,
            truncated: this.truncated,
            snapshot,
        };
        await mkdir(this.options.cacheDir, { recursive: true });
        await writeFile(this.cacheFile, JSON.stringify(persisted, null, 2), "utf8");
    }
    async loadPersistedSnapshot() {
        if (!existsSync(this.cacheFile)) {
            return null;
        }
        try {
            const cacheText = await readFile(this.cacheFile, "utf8");
            const parsed = JSON.parse(cacheText);
            if (parsed.version !== WORKSPACE_SNAPSHOT_VERSION ||
                parsed.workspaceId !== this.workspaceId ||
                parsed.workspaceRoot !== this.workspaceRoot) {
                return null;
            }
            return parsed;
        }
        catch {
            return null;
        }
    }
    async createContextFile(summary, relation, reason) {
        return {
            fileName: summary.fileName,
            relativePath: summary.relativePath,
            relation,
            reason,
            summary: summary.summary,
            snippet: await readSnippet(summary.fileName),
        };
    }
    resolveTargetFile(targetFile, symbolQuery) {
        if (targetFile) {
            return this.resolveWorkspacePath(targetFile);
        }
        if (symbolQuery) {
            const match = this.findSymbol(symbolQuery, { limit: 1 }).matches[0];
            if (!match) {
                throw new Error(`No symbol matched query: ${symbolQuery}`);
            }
            return match.fileName;
        }
        throw new Error("Either targetFile or symbolQuery is required.");
    }
    resolveWorkspacePath(fileName) {
        return path.normalize(path.isAbsolute(fileName)
            ? fileName
            : path.resolve(this.workspaceRoot, fileName));
    }
    requireSnapshot() {
        if (!this.snapshot) {
            throw new Error("Workspace snapshot is not initialized.");
        }
        return this.snapshot;
    }
}
async function normalizeWorkspaceRoot(root) {
    const resolvedRoot = path.resolve(root);
    try {
        return await realpath(resolvedRoot);
    }
    catch {
        return resolvedRoot;
    }
}
function normalizeWorkspaceOptions(workspaceRoot, options) {
    const cacheBaseDir = options.cacheDir ??
        path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "arkts-analyzer");
    return {
        include: normalizePatternList(options.include, DEFAULT_INCLUDE),
        exclude: normalizePatternList(options.exclude, DEFAULT_EXCLUDE),
        maxFiles: clamp(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 50_000),
        cacheDir: path.normalize(path.isAbsolute(cacheBaseDir)
            ? cacheBaseDir
            : path.resolve(workspaceRoot, cacheBaseDir)),
        freshness: options.freshness ?? "mtime",
    };
}
function normalizePatternList(patterns, defaults) {
    const sourcePatterns = patterns && patterns.length > 0 ? patterns : defaults;
    return sourcePatterns.map((pattern) => toPosixPath(pattern.trim())).filter(Boolean);
}
async function discoverWorkspaceFiles(workspaceRoot, options) {
    const fileNames = [];
    const queue = [workspaceRoot];
    let truncated = false;
    while (queue.length > 0) {
        const currentDirectory = queue.shift();
        if (!currentDirectory) {
            continue;
        }
        const entries = await readdir(currentDirectory, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const absolutePath = path.join(currentDirectory, entry.name);
            const relativePath = toPosixPath(path.relative(workspaceRoot, absolutePath));
            if (relativePath.length === 0) {
                continue;
            }
            if (entry.isDirectory()) {
                if (matchesAnyPattern(`${relativePath}/`, options.exclude)) {
                    continue;
                }
                queue.push(absolutePath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            if (matchesAnyPattern(relativePath, options.exclude)) {
                continue;
            }
            if (!matchesAnyPattern(relativePath, options.include)) {
                continue;
            }
            fileNames.push(path.normalize(absolutePath));
            if (fileNames.length >= options.maxFiles) {
                truncated = true;
                return {
                    fileNames,
                    truncated,
                };
            }
        }
    }
    return {
        fileNames,
        truncated,
    };
}
async function collectFileStates(fileNames) {
    const states = await Promise.all(fileNames.map(async (fileName) => {
        const fileStat = await stat(fileName);
        return {
            fileName,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
        };
    }));
    return states.sort((left, right) => left.fileName.localeCompare(right.fileName));
}
function areFileStatesEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }
    return left.every((fileState, index) => {
        const other = right[index];
        return (other !== undefined &&
            other.fileName === fileState.fileName &&
            other.size === fileState.size &&
            other.mtimeMs === fileState.mtimeMs);
    });
}
function extractFileFacts(sourceFile, workspaceRoot, fileName) {
    const imports = [];
    const exports = [];
    const topLevelSymbols = [];
    const symbolRecords = [];
    const compilerOptions = createWorkspaceCompilerOptions();
    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
            const specifier = getModuleSpecifierText(statement.moduleSpecifier);
            if (!specifier) {
                continue;
            }
            imports.push({
                specifier,
                resolvedPath: resolveImportPath(specifier, fileName, workspaceRoot, compilerOptions),
                importedSymbols: getImportSymbols(statement),
                kind: "import",
                isTypeOnly: statement.importClause?.isTypeOnly ?? false,
            });
            continue;
        }
        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
            const specifier = getModuleSpecifierText(statement.moduleSpecifier);
            if (!specifier) {
                continue;
            }
            const exportedSymbols = statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((element) => element.name.text)
                : ["*"];
            imports.push({
                specifier,
                resolvedPath: resolveImportPath(specifier, fileName, workspaceRoot, compilerOptions),
                importedSymbols: exportedSymbols,
                kind: "re-export",
                isTypeOnly: statement.isTypeOnly,
            });
            exports.push(...exportedSymbols.map((name) => ({
                name,
                kind: "re-export",
                isDefault: false,
                sourcePath: resolveImportPath(specifier, fileName, workspaceRoot, compilerOptions),
            })));
            continue;
        }
        if (ts.isExportAssignment(statement)) {
            exports.push({
                name: "default",
                kind: "default",
                isDefault: true,
                sourcePath: null,
            });
            continue;
        }
        const symbols = getTopLevelStatementSymbols(sourceFile, statement);
        topLevelSymbols.push(...symbols.topLevelSymbols);
        symbolRecords.push(...symbols.symbolRecords.map((symbol) => ({
            ...symbol,
            relativePath: toPosixPath(path.relative(workspaceRoot, fileName)),
        })));
        exports.push(...symbols.exports);
    }
    return {
        imports,
        exports,
        topLevelSymbols,
        symbolRecords,
    };
}
function getTopLevelStatementSymbols(sourceFile, statement) {
    const topLevelSymbols = [];
    const symbolRecords = [];
    const exports = [];
    const exported = hasExportModifier(statement);
    const defaultExport = hasDefaultModifier(statement);
    const pushSymbol = (name, kind, rangeNode) => {
        const range = toExternalRange(sourceFile, rangeNode.getStart(sourceFile), rangeNode.getEnd());
        topLevelSymbols.push({
            name,
            kind,
            range,
            exported,
        });
        symbolRecords.push({
            name,
            kind,
            fileName: sourceFile.fileName,
            relativePath: "",
            range,
            exported,
        });
        if (exported) {
            exports.push({
                name: defaultExport ? "default" : name,
                kind,
                isDefault: defaultExport,
                sourcePath: null,
            });
        }
    };
    if (ts.isClassDeclaration(statement) && statement.name) {
        pushSymbol(statement.name.text, "class", statement.name);
    }
    else if (ts.isFunctionDeclaration(statement) && statement.name) {
        pushSymbol(statement.name.text, "function", statement.name);
    }
    else if (ts.isInterfaceDeclaration(statement)) {
        pushSymbol(statement.name.text, "interface", statement.name);
    }
    else if (ts.isTypeAliasDeclaration(statement)) {
        pushSymbol(statement.name.text, "type", statement.name);
    }
    else if (ts.isEnumDeclaration(statement)) {
        pushSymbol(statement.name.text, "enum", statement.name);
    }
    else if (ts.isModuleDeclaration(statement)) {
        pushSymbol(statement.name.text, "namespace", statement.name);
    }
    else if (ts.isVariableStatement(statement)) {
        const declarationKind = getVariableDeclarationKind(statement.declarationList);
        for (const declaration of statement.declarationList.declarations) {
            const identifier = getBindingIdentifier(declaration.name);
            if (!identifier) {
                continue;
            }
            pushSymbol(identifier.text, declarationKind, identifier);
        }
    }
    return {
        topLevelSymbols,
        symbolRecords,
        exports,
    };
}
function getBindingIdentifier(name) {
    if (ts.isIdentifier(name)) {
        return name;
    }
    return undefined;
}
function getVariableDeclarationKind(declarationList) {
    if ((declarationList.flags & ts.NodeFlags.Const) !== 0) {
        return "const";
    }
    if ((declarationList.flags & ts.NodeFlags.Let) !== 0) {
        return "let";
    }
    return "var";
}
function hasExportModifier(node) {
    if (!("modifiers" in node)) {
        return false;
    }
    return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
function hasDefaultModifier(node) {
    if (!("modifiers" in node)) {
        return false;
    }
    return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}
function getModuleSpecifierText(node) {
    return ts.isStringLiteral(node) ? node.text : undefined;
}
function getImportSymbols(statement) {
    const importClause = statement.importClause;
    if (!importClause) {
        return [];
    }
    const symbols = [];
    if (importClause.name) {
        symbols.push(importClause.name.text);
    }
    const bindings = importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
        symbols.push(...bindings.elements.map((element) => element.name.text));
    }
    else if (bindings && ts.isNamespaceImport(bindings)) {
        symbols.push(`* as ${bindings.name.text}`);
    }
    return symbols;
}
function createWorkspaceCompilerOptions() {
    return {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        allowNonTsExtensions: true,
        experimentalDecorators: true,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
    };
}
function resolveImportPath(specifier, containingFile, workspaceRoot, compilerOptions) {
    const resolutionHost = {
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        directoryExists: ts.sys.directoryExists?.bind(ts.sys),
        getDirectories: ts.sys.getDirectories?.bind(ts.sys),
        getCurrentDirectory: () => path.dirname(containingFile),
    };
    if (ts.sys.realpath) {
        resolutionHost.realpath = ts.sys.realpath.bind(ts.sys);
    }
    const resolved = ts.resolveModuleName(specifier, containingFile, compilerOptions, resolutionHost).resolvedModule?.resolvedFileName;
    if (!resolved || resolved === ARKTS_INTRINSICS_FILE_NAME) {
        return null;
    }
    const normalized = path.normalize(resolved);
    return isWithinWorkspace(normalized, workspaceRoot) ? normalized : null;
}
function detectWorkspaceLanguage(fileName) {
    if (isArkTSFile(fileName)) {
        return "arkts";
    }
    if (fileName.endsWith(".ts")) {
        return "typescript";
    }
    return "javascript";
}
function classifyFileRole(fileName, components, fileFacts) {
    if (components.some((component) => component.isEntry)) {
        return "entrypoint";
    }
    if (components.length > 0) {
        return "component";
    }
    if (fileFacts.imports.length > 0 || fileFacts.exports.length > 0 || fileName.endsWith(".ts")) {
        return "module";
    }
    return "script";
}
function createFileSummaryText(relativePath, role, exports, imports, components) {
    const parts = [`${relativePath} is a ${role} file`];
    if (components.length > 0) {
        parts.push(`with ${components.length} ArkTS component(s)`);
    }
    if (exports.length > 0) {
        parts.push(`exporting ${exports.slice(0, 3).map((record) => record.name).join(", ")}`);
    }
    if (imports.length > 0) {
        parts.push(`and importing ${imports.length} module(s)`);
    }
    return `${parts.join(" ")}.`;
}
function createWorkspaceOverviewText(fileCount, symbolCount, edgeCount, entryFileCount, truncated) {
    const truncationText = truncated ? " Results are capped by maxFiles." : "";
    return `Workspace indexes ${fileCount} file(s), ${symbolCount} top-level symbol(s), ${edgeCount} internal module edge(s), and ${entryFileCount} entrypoint file(s).${truncationText}`;
}
function computeHotFiles(fileSummaries, moduleEdges) {
    const scores = new Map();
    for (const file of fileSummaries) {
        scores.set(file.fileName, 0);
    }
    for (const edge of moduleEdges) {
        scores.set(edge.from, (scores.get(edge.from) ?? 0) + 1);
        scores.set(edge.to, (scores.get(edge.to) ?? 0) + 1);
    }
    return fileSummaries
        .map((file) => ({
        fileName: file.fileName,
        relativePath: file.relativePath,
        score: scores.get(file.fileName) ?? 0,
    }))
        .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))
        .slice(0, 10);
}
async function readSnippet(fileName, maxLines = 20) {
    try {
        const text = await readFile(fileName, "utf8");
        return text.split(/\r?\n/u).slice(0, maxLines).join("\n");
    }
    catch {
        return "";
    }
}
function toComponentSummary(component) {
    return {
        name: component.name,
        range: toExternalRangeFromAnalyzer(component.range),
        isEntry: component.isEntry,
        componentDecorators: [...component.componentDecorators],
        stateMembers: component.stateMembers.map((member) => ({
            name: member.name,
            decorator: member.decorator,
            range: toExternalRangeFromAnalyzer(member.range),
        })),
    };
}
function toExternalRangeFromAnalyzer(range) {
    return {
        start: {
            line: range.start.line + 1,
            character: range.start.character + 1,
        },
        end: {
            line: range.end.line + 1,
            character: range.end.character + 1,
        },
    };
}
function toExternalRange(sourceFile, start, end) {
    return {
        start: toExternalPosition(sourceFile.getLineAndCharacterOfPosition(start)),
        end: toExternalPosition(sourceFile.getLineAndCharacterOfPosition(Math.max(start, end))),
    };
}
function toExternalPosition(position) {
    return {
        line: position.line + 1,
        character: position.character + 1,
    };
}
function dedupeModuleEdges(edges) {
    const uniqueEdges = new Map();
    for (const edge of edges) {
        const key = `${edge.from}:${edge.to}:${edge.kind}:${edge.specifier}:${edge.symbols.join(",")}`;
        if (!uniqueEdges.has(key)) {
            uniqueEdges.set(key, edge);
        }
    }
    return [...uniqueEdges.values()].sort((left, right) => left.from.localeCompare(right.from) ||
        left.to.localeCompare(right.to) ||
        left.specifier.localeCompare(right.specifier));
}
function isSameEdge(left, right) {
    return (left.from === right.from &&
        left.to === right.to &&
        left.kind === right.kind &&
        left.specifier === right.specifier);
}
function dedupePaths(fileNames) {
    return [...new Set(fileNames)];
}
function toOverlayMap(workspaceRoot, overlays) {
    const map = new Map();
    for (const overlay of overlays) {
        const fileName = path.normalize(path.isAbsolute(overlay.fileName)
            ? overlay.fileName
            : path.resolve(workspaceRoot, overlay.fileName));
        map.set(fileName, overlay.content);
    }
    return map;
}
function rankSymbolMatch(name, normalizedQuery) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === normalizedQuery) {
        return 0;
    }
    if (normalizedName.startsWith(normalizedQuery)) {
        return 1;
    }
    if (normalizedName.includes(normalizedQuery)) {
        return 2;
    }
    return 3;
}
function matchesAnyPattern(value, patterns) {
    return patterns.some((pattern) => globToRegExp(pattern).test(value));
}
function globToRegExp(pattern) {
    const normalizedPattern = toPosixPath(pattern);
    let expression = "^";
    for (let index = 0; index < normalizedPattern.length; index += 1) {
        const character = normalizedPattern[index];
        const nextCharacter = normalizedPattern[index + 1];
        const followingCharacter = normalizedPattern[index + 2];
        if (character === undefined) {
            continue;
        }
        if (character === "*") {
            if (nextCharacter === "*") {
                if (followingCharacter === "/") {
                    expression += "(?:.*/)?";
                    index += 2;
                    continue;
                }
                expression += ".*";
                index += 1;
                continue;
            }
            expression += "[^/]*";
            continue;
        }
        if (character === "?") {
            expression += "[^/]";
            continue;
        }
        expression += escapeRegexCharacter(character);
    }
    return new RegExp(`${expression}$`, "u");
}
function escapeRegexCharacter(value) {
    return /[|\\{}()[\]^$+?.]/u.test(value) ? `\\${value}` : value;
}
function toPosixPath(value) {
    return value.replace(/\\/g, "/");
}
function isWithinWorkspace(fileName, workspaceRoot) {
    const relativePath = path.relative(workspaceRoot, fileName);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
function stableStringify(value) {
    return JSON.stringify(value, (_key, currentValue) => {
        if (currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)) {
            return Object.fromEntries(Object.entries(currentValue).sort(([left], [right]) => left.localeCompare(right)));
        }
        return currentValue;
    });
}
function hashString(value) {
    return createHash("sha1").update(value).digest("hex");
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
//# sourceMappingURL=workspace-service.js.map