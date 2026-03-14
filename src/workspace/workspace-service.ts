import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import ts from "typescript";

import {
  ArkTSAnalyzer,
  type DecoratedComponentInfo,
  type DefinitionLocation,
  type DocumentSymbol,
  type HoverInfo,
  type ReferenceLocation,
  type AnalyzerPosition,
} from "../core/arkts-analyzer.js";
import { ARKTS_INTRINSICS_FILE_NAME, isArkTSFile } from "../core/arkts-language.js";
import type {
  ComponentSummary,
  ContextBundle,
  ContextFile,
  DecoratedMemberSummary,
  DependencyTrace,
  DependencyTraceNode,
  EvidenceContextResult,
  EvidenceLevel,
  EvidenceSnippet,
  ExplainModuleResult,
  ExportRecord,
  ExternalPosition,
  ExternalRange,
  FileSummary,
  FindSymbolOptions,
  FindSymbolResult,
  HotFileRecord,
  ImportRecord,
  ModuleEdge,
  ReadSourceExcerptResult,
  RefreshResult,
  RelatedFilesOptions,
  SourceExcerpt,
  SymbolRecord,
  TopLevelSymbolSummary,
  TraceDependenciesOptions,
  WorkspaceCacheStatus,
  WorkspaceOverview,
  WorkspaceOverlayFile,
  WorkspaceProvenance,
  WorkspaceServiceOptions,
  WorkspaceSnapshot,
  WorkspaceFileLanguage,
  WorkspaceFileRole,
  WorkspaceProgressEvent,
  WorkspaceProgressReporter,
} from "./types.js";

interface NormalizedWorkspaceOptions {
  include: string[];
  exclude: string[];
  maxFiles: number | null;
  cacheDir: string;
  freshness: "mtime" | "always";
}

interface WorkspaceFileState {
  fileName: string;
  size: number;
  mtimeMs: number;
}

interface PersistedWorkspaceSnapshot {
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  optionsHash: string;
  fileStates: WorkspaceFileState[];
  truncated: boolean;
  snapshot: WorkspaceSnapshot;
}

interface DiscoverWorkspaceResult {
  fileNames: string[];
  truncated: boolean;
}

interface ExtractedFileFacts {
  imports: ImportRecord[];
  exports: ExportRecord[];
  topLevelSymbols: TopLevelSymbolSummary[];
  symbolRecords: SymbolRecord[];
}

interface RefreshDiff {
  addedFiles: string[];
  removedFiles: string[];
  modifiedFiles: string[];
}

interface SnippetPreview {
  content: string;
  range: ExternalRange;
  truncated: boolean;
}

interface ExcerptBuildOptions {
  maxLines: number;
  focusRange?: ExternalRange;
  strictRange?: boolean;
  contextBefore?: number;
  contextAfter?: number;
}

interface EvidenceContextOptions {
  targetFile: string;
  question?: string | undefined;
}

interface EvidenceCandidate {
  fileName: string;
  purpose: string;
  priority: number;
  focusRange?: ExternalRange;
  symbolName?: string;
  whySelected?: string;
  specifier?: string;
}

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
  private static readonly sessions = new Map<string, WorkspaceService>();

  public static async initialize(
    root: string,
    options: WorkspaceServiceOptions = {},
  ): Promise<WorkspaceService> {
    const workspaceRoot = await normalizeWorkspaceRoot(root);
    const normalizedOptions = normalizeWorkspaceOptions(workspaceRoot, options);
    const sessionKey = `${workspaceRoot}:${hashString(stableStringify(normalizedOptions))}`;
    const existing = WorkspaceService.sessions.get(sessionKey);

    if (existing) {
      existing.cacheStatus = "memory";
      existing.progressReporter = options.progressReporter;
      return existing;
    }

    const service = new WorkspaceService(
      workspaceRoot,
      normalizedOptions,
      options.progressReporter,
    );
    await service.loadOrBuildSnapshot();
    WorkspaceService.sessions.set(sessionKey, service);
    return service;
  }

  public static resetForTests(): void {
    WorkspaceService.sessions.clear();
  }

  private readonly workspaceId: string;
  private readonly optionsHash: string;
  private readonly cacheFile: string;
  private progressReporter: WorkspaceProgressReporter | undefined;

  private snapshot: WorkspaceSnapshot | null = null;
  private baseAnalyzer: ArkTSAnalyzer | null = null;
  private fileStates: WorkspaceFileState[] = [];
  private discoveredFiles: string[] = [];
  private truncated = false;
  private cacheStatus: WorkspaceCacheStatus = "rebuilt";
  private readonly filesByName = new Map<string, FileSummary>();
  private readonly symbolsByFile = new Map<string, SymbolRecord[]>();
  private readonly outgoingEdgesByFile = new Map<string, ModuleEdge[]>();
  private readonly incomingEdgesByFile = new Map<string, ModuleEdge[]>();

  private constructor(
    private readonly workspaceRoot: string,
    private readonly options: NormalizedWorkspaceOptions,
    progressReporter?: WorkspaceProgressReporter,
  ) {
    this.workspaceId = hashString(this.workspaceRoot).slice(0, 12);
    this.optionsHash = hashString(stableStringify(this.options));
    this.cacheFile = path.join(this.options.cacheDir, `${this.workspaceId}.json`);
    this.progressReporter = progressReporter;
  }

  public getOverview(): WorkspaceOverview {
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
      provenance: "snapshot",
      overview: snapshot.overviewText,
    };
  }

  public async refresh(changedFiles: string[] = []): Promise<RefreshResult> {
    const normalizedChangedFiles = dedupePaths(
      changedFiles.map((fileName) => this.resolveWorkspacePath(fileName)),
    );
    const discovery = await discoverWorkspaceFiles(
      this.workspaceRoot,
      this.options,
      (event) => {
        this.reportProgress(event);
      },
    );

    if (
      this.baseAnalyzer === null ||
      (normalizedChangedFiles.length === 0 && (this.truncated || discovery.truncated))
    ) {
      await this.rebuildSnapshot(discovery);
      return this.createRefreshResult({
        refreshedFiles: normalizedChangedFiles,
        refreshMode: "full",
        changedFileCount: normalizedChangedFiles.length,
        reindexedFileCount: this.requireSnapshot().fileCount,
        reusedFileCount: 0,
      });
    }

    const nextDiscoveredFiles = discovery.fileNames;
    const nextFileStates = await collectFileStates(nextDiscoveredFiles);
    const diff = normalizedChangedFiles.length > 0
      ? diffChangedWorkspaceFiles(
          normalizedChangedFiles,
          this.discoveredFiles,
          nextDiscoveredFiles,
        )
      : diffWorkspaceFileStates(this.fileStates, nextFileStates);
    const changedFileSet = dedupePaths([
      ...diff.addedFiles,
      ...diff.removedFiles,
      ...diff.modifiedFiles,
    ]);

    this.discoveredFiles = nextDiscoveredFiles;
    this.truncated = discovery.truncated;
    this.fileStates = nextFileStates;

    if (changedFileSet.length === 0) {
      return this.createRefreshResult({
        refreshedFiles: normalizedChangedFiles.length > 0 ? normalizedChangedFiles : changedFileSet,
        refreshMode: "incremental",
        changedFileCount: 0,
        reindexedFileCount: 0,
        reusedFileCount: this.discoveredFiles.length,
      });
    }

    const reindexedFiles = this.collectAffectedFiles(changedFileSet)
      .filter((fileName) => this.discoveredFiles.includes(fileName));

    this.baseAnalyzer.syncWorkspaceFiles({
      rootNames: this.discoveredFiles,
      changedFiles: [...diff.addedFiles, ...diff.modifiedFiles],
      removedFiles: diff.removedFiles,
    });

    this.removeIndexedFiles([...diff.removedFiles, ...reindexedFiles]);
    const totalReindexedFiles = reindexedFiles.length;
    for (const [index, fileName] of reindexedFiles.entries()) {
      this.indexFileSummary(this.createFileSummary(this.baseAnalyzer, fileName));
      this.reportProgress({
        phase: "index",
        mode: "incremental",
        processedFiles: index + 1,
        totalFiles: totalReindexedFiles,
        fileName,
      });
    }

    this.rebuildIncomingEdgesIndex();
    this.setSnapshot(this.createSnapshotFromIndexes());
    this.cacheStatus = "rebuilt";
    await this.persistSnapshot();

    return this.createRefreshResult({
      refreshedFiles: normalizedChangedFiles.length > 0 ? normalizedChangedFiles : changedFileSet,
      refreshMode: "incremental",
      changedFileCount: changedFileSet.length,
      reindexedFileCount: reindexedFiles.length,
      reusedFileCount: Math.max(this.discoveredFiles.length - reindexedFiles.length, 0),
    });
  }

  public async summarizeFile(
    fileName: string,
    overlays: WorkspaceOverlayFile[] = [],
  ): Promise<FileSummary> {
    const snapshot = this.requireSnapshot();
    const normalizedFileName = this.resolveWorkspacePath(fileName);
    const overlayMap = toOverlayMap(this.workspaceRoot, overlays);

    if (overlayMap.size === 0) {
      const existing = snapshot.files.find((file) => file.fileName === normalizedFileName);
      if (existing) {
        return {
          ...existing,
          provenance: "snapshot",
        };
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

    return this.createFileSummary(
      analyzer,
      normalizedFileName,
      overlayMap.has(normalizedFileName) ? "live" : "snapshot",
    );
  }

  public findSymbol(
    query: string,
    options: FindSymbolOptions = {},
  ): FindSymbolResult {
    const snapshot = this.requireSnapshot();
    const normalizedQuery = query.trim().toLowerCase();
    const limit = clamp(options.limit ?? 10, 1, 50);
    const matches = normalizedQuery.length === 0
      ? []
      : [...snapshot.symbols]
          .sort((left, right) =>
            rankSymbolMatch(left.name, normalizedQuery) -
            rankSymbolMatch(right.name, normalizedQuery) ||
            left.name.localeCompare(right.name) ||
            left.fileName.localeCompare(right.fileName),
          )
          .filter((symbol) => symbol.name.toLowerCase().includes(normalizedQuery))
          .slice(0, limit);

    return {
      query,
      matches,
      provenance: "snapshot",
    };
  }

  public async getRelatedFiles(
    options: RelatedFilesOptions,
    overlays: WorkspaceOverlayFile[] = [],
  ): Promise<ContextBundle> {
    const limit = clamp(options.limit ?? 6, 1, 20);
    const targetFile = this.resolveWorkspacePath(options.targetFile);
    const overlayMap = toOverlayMap(this.workspaceRoot, overlays);
    const summary = await this.getFileSummaryForPath(targetFile, overlayMap);
    if (!summary) {
      throw new Error(`Target file is not indexed in workspace: ${targetFile}`);
    }
    const outgoing = this.outgoingEdgesByFile.get(targetFile) ?? [];
    const incoming = this.incomingEdgesByFile.get(targetFile) ?? [];
    const rankedFiles = new Map<string, ContextFile>();

    rankedFiles.set(
      targetFile,
      await this.createContextFile(summary, "self", "Primary target file.", {
        overlayMap,
        whySelected: "Selected as the primary file for contextual reading.",
      }),
    );

    for (const edge of outgoing) {
      const dependency = await this.getFileSummaryForPath(edge.to, overlayMap);
      if (!dependency || rankedFiles.has(dependency.fileName)) {
        continue;
      }

      rankedFiles.set(
        dependency.fileName,
        await this.createContextFile(
          dependency,
          "imports",
          `Imported via ${edge.specifier}.`,
          {
            overlayMap,
            specifier: edge.specifier,
            whySelected: `Direct dependency imported from ${summary.relativePath}.`,
          },
        ),
      );

      if (rankedFiles.size >= limit) {
        break;
      }
    }

    if (rankedFiles.size < limit) {
      for (const edge of incoming) {
        const importer = await this.getFileSummaryForPath(edge.from, overlayMap);
        if (!importer || rankedFiles.has(importer.fileName)) {
          continue;
        }

        rankedFiles.set(
          importer.fileName,
          await this.createContextFile(
            importer,
            "importedBy",
            `Imports the target through ${edge.specifier}.`,
            {
              overlayMap,
              specifier: edge.specifier,
              whySelected: `Direct importer of ${summary.relativePath}.`,
            },
          ),
        );

        if (rankedFiles.size >= limit) {
          break;
        }
      }
    }

    if (rankedFiles.size < limit) {
      for (const edge of outgoing) {
        const transitiveEdges = this.outgoingEdgesByFile.get(edge.to) ?? [];
        for (const transitiveEdge of transitiveEdges) {
          const dependency = await this.getFileSummaryForPath(transitiveEdge.to, overlayMap);
          if (!dependency || rankedFiles.has(dependency.fileName)) {
            continue;
          }

          rankedFiles.set(
            dependency.fileName,
            await this.createContextFile(
              dependency,
              "dependency",
              `Transitively required from ${summary.relativePath}.`,
              {
                overlayMap,
                specifier: transitiveEdge.specifier,
                whySelected: `Transitive dependency reachable from ${summary.relativePath}.`,
              },
            ),
          );

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
      reason: `Context bundle for ${summary.relativePath}.`,
      files: [...rankedFiles.values()].slice(0, limit),
      provenance: overlayMap.size > 0 ? "live" : "snapshot",
    };
  }

  public async explainModule(
    fileName: string,
    overlays: WorkspaceOverlayFile[] = [],
  ): Promise<ExplainModuleResult> {
    const file = await this.summarizeFile(fileName, overlays);
    const context = await this.getRelatedFiles({
      targetFile: file.fileName,
      limit: 6,
    }, overlays);

    return {
      file,
      context,
      provenance: overlays.length > 0 ? "live" : "snapshot",
    };
  }

  public getHover(
    fileName: string,
    position: AnalyzerPosition,
    overlays: WorkspaceOverlayFile[] = [],
  ): HoverInfo | undefined {
    const normalizedFileName = this.resolveWorkspacePath(fileName);
    const analyzer = this.getQueryAnalyzer(normalizedFileName, overlays);
    return analyzer.getHover(normalizedFileName, position);
  }

  public findReferences(
    fileName: string,
    position: AnalyzerPosition,
    overlays: WorkspaceOverlayFile[] = [],
  ): ReferenceLocation[] {
    const normalizedFileName = this.resolveWorkspacePath(fileName);
    const analyzer = this.getQueryAnalyzer(normalizedFileName, overlays);
    return analyzer.findReferences(normalizedFileName, position);
  }

  public findImplementations(
    fileName: string,
    position: AnalyzerPosition,
    overlays: WorkspaceOverlayFile[] = [],
  ): DefinitionLocation[] {
    const normalizedFileName = this.resolveWorkspacePath(fileName);
    const analyzer = this.getQueryAnalyzer(normalizedFileName, overlays);
    return analyzer.findImplementations(normalizedFileName, position);
  }

  public findTypeDefinitions(
    fileName: string,
    position: AnalyzerPosition,
    overlays: WorkspaceOverlayFile[] = [],
  ): DefinitionLocation[] {
    const normalizedFileName = this.resolveWorkspacePath(fileName);
    const analyzer = this.getQueryAnalyzer(normalizedFileName, overlays);
    return analyzer.findTypeDefinitions(normalizedFileName, position);
  }

  public getDocumentSymbols(
    fileName: string,
    overlays: WorkspaceOverlayFile[] = [],
  ): DocumentSymbol[] {
    const normalizedFileName = this.resolveWorkspacePath(fileName);
    const analyzer = this.getQueryAnalyzer(normalizedFileName, overlays);
    return analyzer.getDocumentSymbols(normalizedFileName);
  }

  public async readSourceExcerpt(
    input: {
      targetFile: string;
      range: ExternalRange;
      maxLines?: number;
    },
    overlays: WorkspaceOverlayFile[] = [],
  ): Promise<ReadSourceExcerptResult> {
    const normalizedFileName = this.resolveWorkspacePath(input.targetFile);
    const maxLines = clamp(input.maxLines ?? 60, 1, 200);
    const overlayMap = toOverlayMap(this.workspaceRoot, overlays);
    const summary = await this.getFileSummaryForPath(normalizedFileName, overlayMap);

    if (!summary) {
      throw new Error(`Target file is not indexed in workspace: ${normalizedFileName}`);
    }

    const excerpt = await this.buildSourceExcerpt(summary, overlayMap, {
      maxLines,
      focusRange: input.range,
      strictRange: true,
      contextBefore: 0,
      contextAfter: 0,
    }, {
      whySelected: "Returned the explicitly requested source range.",
    });

    return {
      targetFile: normalizedFileName,
      excerpt,
    };
  }

  public async readSymbolExcerpt(
    input: {
      targetFile: string;
      symbolQuery: string;
      maxLines?: number;
    },
    overlays: WorkspaceOverlayFile[] = [],
  ): Promise<ReadSourceExcerptResult> {
    const normalizedFileName = this.resolveWorkspacePath(input.targetFile);
    const maxLines = clamp(input.maxLines ?? 60, 1, 200);
    const overlayMap = toOverlayMap(this.workspaceRoot, overlays);
    const summary = await this.getFileSummaryForPath(normalizedFileName, overlayMap);

    if (!summary) {
      throw new Error(`Target file is not indexed in workspace: ${normalizedFileName}`);
    }

    const focusRange = this.findPreferredRange(summary, input.symbolQuery);
    if (!focusRange) {
      throw new Error(`No symbol matched query in target file: ${input.symbolQuery}`);
    }

    const excerpt = await this.buildSourceExcerpt(summary, overlayMap, {
      maxLines,
      focusRange,
      contextBefore: 3,
      contextAfter: 3,
    }, {
      symbolName: input.symbolQuery,
      whySelected: `Returned the source excerpt surrounding "${input.symbolQuery}".`,
    });

    return {
      targetFile: normalizedFileName,
      excerpt,
    };
  }

  public async getEvidenceContext(
    options: EvidenceContextOptions,
    overlays: WorkspaceOverlayFile[] = [],
  ): Promise<EvidenceContextResult> {
    const targetFile = this.resolveWorkspacePath(options.targetFile);
    const overlayMap = toOverlayMap(this.workspaceRoot, overlays);
    const rootSummary = await this.getFileSummaryForPath(targetFile, overlayMap);

    if (!rootSummary) {
      throw new Error(`Target file is not indexed in workspace: ${targetFile}`);
    }

    const snippetCount = 4;
    const budgetChars = 6000;
    const includeRelated = true;
    const candidates = await this.collectEvidenceCandidates({
      rootSummary,
      includeRelated,
      overlayMap,
      ...(options.question ? { question: options.question } : {}),
    });
    const snippets: EvidenceSnippet[] = [];
    const seen = new Set<string>();
    let consumedChars = 0;
    let truncated = false;

    for (const candidate of candidates) {
      if (snippets.length >= snippetCount) {
        truncated = true;
        break;
      }

      const key = `${candidate.fileName}:${candidate.focusRange?.start.line ?? 0}:${candidate.purpose}`;
      if (seen.has(key)) {
        continue;
      }

      const summary = await this.getFileSummaryForPath(candidate.fileName, overlayMap);
      if (!summary) {
        continue;
      }

      const initialFocusRange = candidate.focusRange ?? this.findPreferredRange(summary, candidate.symbolName);
      let excerpt = await this.buildSourceExcerpt(summary, overlayMap, {
        maxLines: 40,
        ...(initialFocusRange ? { focusRange: initialFocusRange } : {}),
        contextBefore: 3,
        contextAfter: 3,
      }, {
        ...(candidate.symbolName ? { symbolName: candidate.symbolName } : {}),
        ...(candidate.whySelected ? { whySelected: candidate.whySelected } : {}),
      });

      const remainingBudget = budgetChars - consumedChars;
      if (remainingBudget <= 0) {
        truncated = true;
        break;
      }

      if (excerpt.content.length > remainingBudget) {
        if (snippets.length > 0) {
          truncated = true;
          continue;
        }

        const reducedFocusRange = candidate.focusRange ?? this.findPreferredRange(summary, candidate.symbolName);
        excerpt = await this.buildSourceExcerpt(summary, overlayMap, {
          maxLines: clamp(Math.max(Math.floor(remainingBudget / 80), 6), 1, 40),
          ...(reducedFocusRange ? { focusRange: reducedFocusRange } : {}),
          contextBefore: 1,
          contextAfter: 1,
        }, {
          ...(candidate.symbolName ? { symbolName: candidate.symbolName } : {}),
          ...(candidate.whySelected ? { whySelected: candidate.whySelected } : {}),
        });
      }

      snippets.push({
        fileName: excerpt.fileName,
        relativePath: excerpt.relativePath,
        range: excerpt.range,
        content: excerpt.content,
        purpose: candidate.purpose,
        truncated: excerpt.truncated,
        provenance: excerpt.provenance,
        evidenceLevel: "source",
        ...(candidate.whySelected ? { whySelected: candidate.whySelected } : {}),
      });
      consumedChars += excerpt.content.length;
      seen.add(key);
    }

    return {
      rootFile: rootSummary.fileName,
      snippets,
      truncated,
      provenance: overlayMap.size > 0 ? "live" : "snapshot",
    };
  }

  public async traceDependencies(
    options: TraceDependenciesOptions,
  ): Promise<DependencyTrace> {
    const targetFile = this.resolveWorkspacePath(options.targetFile);
    const depth = clamp(options.depth ?? 2, 1, 5);
    const limit = 25;
    const queue: Array<{ fileName: string; depth: number }> = [{ fileName: targetFile, depth: 0 }];
    const visited = new Set<string>();
    const nodes: DependencyTraceNode[] = [];
    const edges: ModuleEdge[] = [];
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current.fileName)) {
        continue;
      }

      visited.add(current.fileName);
      const summary = this.filesByName.get(current.fileName);
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

      const outgoing = this.outgoingEdgesByFile.get(current.fileName) ?? [];
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
      provenance: "snapshot",
    };
  }

  private async loadOrBuildSnapshot(): Promise<void> {
    const discovery = await discoverWorkspaceFiles(this.workspaceRoot, this.options);
    this.discoveredFiles = discovery.fileNames;
    this.truncated = discovery.truncated;
    const fileStates = await collectFileStates(this.discoveredFiles);

    if (this.options.freshness === "mtime") {
      const persisted = await this.loadPersistedSnapshot();
      if (
        persisted &&
        persisted.optionsHash === this.optionsHash &&
        persisted.truncated === this.truncated &&
        areFileStatesEqual(persisted.fileStates, fileStates)
      ) {
        this.setSnapshot(persisted.snapshot);
        this.fileStates = fileStates;
        this.baseAnalyzer = this.createBaseAnalyzer(this.discoveredFiles);
        this.cacheStatus = "hit";
        return;
      }
    }

    await this.rebuildSnapshot(discovery);
  }

  private async rebuildSnapshot(discovery?: DiscoverWorkspaceResult): Promise<void> {
    const nextDiscovery =
      discovery ??
      await discoverWorkspaceFiles(this.workspaceRoot, this.options, (event) => {
        this.reportProgress(event);
      });
    this.discoveredFiles = nextDiscovery.fileNames;
    this.truncated = nextDiscovery.truncated;
    this.baseAnalyzer = this.createBaseAnalyzer(this.discoveredFiles);
    const fileSummaries: FileSummary[] = [];
    const totalDiscoveredFiles = this.discoveredFiles.length;
    for (const [index, fileName] of this.discoveredFiles.entries()) {
      fileSummaries.push(
        this.createFileSummary(this.baseAnalyzer as ArkTSAnalyzer, fileName),
      );
      this.reportProgress({
        phase: "index",
        mode: "full",
        processedFiles: index + 1,
        totalFiles: totalDiscoveredFiles,
        fileName,
      });
    }
    this.setSnapshot(this.createSnapshotFromFileSummaries(fileSummaries));
    this.fileStates = await collectFileStates(this.discoveredFiles);
    this.cacheStatus = "rebuilt";
    await this.persistSnapshot();
  }

  private reportProgress(event: WorkspaceProgressEvent): void {
    this.progressReporter?.(event);
  }

  private createSnapshotFromFileSummaries(fileSummaries: FileSummary[]): WorkspaceSnapshot {
    const sortedFiles = [...fileSummaries].sort((left, right) =>
      left.fileName.localeCompare(right.fileName),
    );
    const moduleEdges = dedupeModuleEdges(
      sortedFiles.flatMap((file) => this.createModuleEdges(file)),
    ).sort((left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.specifier.localeCompare(right.specifier) ||
      left.kind.localeCompare(right.kind),
    );
    const symbols = sortedFiles
      .flatMap((file) => this.createSymbolRecords(file))
      .sort((left, right) =>
        left.name.localeCompare(right.name) ||
        left.fileName.localeCompare(right.fileName),
      );
    const hotFiles = computeHotFiles(sortedFiles, moduleEdges);
    const entryFiles = sortedFiles
      .filter((file) => file.role === "entrypoint")
      .map((file) => file.fileName);
    const timestamp = new Date().toISOString();

    return {
      version: WORKSPACE_SNAPSHOT_VERSION,
      workspaceId: this.workspaceId,
      workspaceRoot: this.workspaceRoot,
      createdAt: this.snapshot?.createdAt ?? timestamp,
      updatedAt: timestamp,
      fileCount: sortedFiles.length,
      symbolCount: symbols.length,
      edgeCount: moduleEdges.length,
      truncated: this.truncated,
      maxFiles: this.options.maxFiles,
      include: [...this.options.include],
      exclude: [...this.options.exclude],
      entryFiles,
      hotFiles,
      files: sortedFiles,
      symbols,
      moduleEdges,
      overviewText: createWorkspaceOverviewText(
        sortedFiles.length,
        symbols.length,
        moduleEdges.length,
        entryFiles.length,
        this.truncated,
      ),
    };
  }

  private createSnapshotFromIndexes(): WorkspaceSnapshot {
    return this.createSnapshotFromFileSummaries([...this.filesByName.values()]);
  }

  private createBaseAnalyzer(fileNames: string[]): ArkTSAnalyzer {
    return new ArkTSAnalyzer({
      rootNames: fileNames,
    });
  }

  private createRefreshResult(input: {
    refreshedFiles: string[];
    refreshMode: "full" | "incremental";
    changedFileCount: number;
    reindexedFileCount: number;
    reusedFileCount: number;
  }): RefreshResult {
    const snapshot = this.requireSnapshot();
    return {
      workspaceId: this.workspaceId,
      refreshedFiles: input.refreshedFiles,
      fileCount: snapshot.fileCount,
      symbolCount: snapshot.symbolCount,
      edgeCount: snapshot.edgeCount,
      cacheStatus: this.cacheStatus,
      refreshMode: input.refreshMode,
      changedFileCount: input.changedFileCount,
      reindexedFileCount: input.reindexedFileCount,
      reusedFileCount: input.reusedFileCount,
      provenance: "snapshot",
    };
  }

  private setSnapshot(snapshot: WorkspaceSnapshot): void {
    this.snapshot = snapshot;
    this.filesByName.clear();
    this.symbolsByFile.clear();
    this.outgoingEdgesByFile.clear();
    this.incomingEdgesByFile.clear();

    for (const file of snapshot.files) {
      this.filesByName.set(file.fileName, file);
    }

    for (const symbol of snapshot.symbols) {
      const symbols = this.symbolsByFile.get(symbol.fileName) ?? [];
      symbols.push(symbol);
      this.symbolsByFile.set(symbol.fileName, symbols);
    }

    for (const edge of snapshot.moduleEdges) {
      const outgoing = this.outgoingEdgesByFile.get(edge.from) ?? [];
      outgoing.push(edge);
      this.outgoingEdgesByFile.set(edge.from, outgoing);

      const incoming = this.incomingEdgesByFile.get(edge.to) ?? [];
      incoming.push(edge);
      this.incomingEdgesByFile.set(edge.to, incoming);
    }
  }

  private createSymbolRecords(file: FileSummary): SymbolRecord[] {
    return file.topLevelSymbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      fileName: file.fileName,
      relativePath: file.relativePath,
      range: symbol.range,
      exported: symbol.exported,
    }));
  }

  private createModuleEdges(file: FileSummary): ModuleEdge[] {
    return file.imports
      .filter((record) => record.resolvedPath !== null)
      .map((record) => ({
        from: file.fileName,
        to: record.resolvedPath as string,
        kind: record.kind,
        specifier: record.specifier,
        symbols: record.importedSymbols,
      }));
  }

  private removeIndexedFiles(fileNames: string[]): void {
    for (const fileName of dedupePaths(fileNames)) {
      this.filesByName.delete(fileName);
      this.symbolsByFile.delete(fileName);
      this.outgoingEdgesByFile.delete(fileName);
    }
  }

  private indexFileSummary(fileSummary: FileSummary): void {
    this.filesByName.set(fileSummary.fileName, fileSummary);
    this.symbolsByFile.set(fileSummary.fileName, this.createSymbolRecords(fileSummary));
    this.outgoingEdgesByFile.set(fileSummary.fileName, this.createModuleEdges(fileSummary));
  }

  private rebuildIncomingEdgesIndex(): void {
    this.incomingEdgesByFile.clear();
    for (const outgoingEdges of this.outgoingEdgesByFile.values()) {
      for (const edge of outgoingEdges) {
        const incoming = this.incomingEdgesByFile.get(edge.to) ?? [];
        incoming.push(edge);
        this.incomingEdgesByFile.set(edge.to, incoming);
      }
    }
  }

  private collectAffectedFiles(changedFiles: readonly string[]): string[] {
    const queue = [...changedFiles];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) {
        continue;
      }

      visited.add(current);
      for (const edge of this.incomingEdgesByFile.get(current) ?? []) {
        if (!visited.has(edge.from)) {
          queue.push(edge.from);
        }
      }
    }

    return [...visited].sort((left, right) => left.localeCompare(right));
  }

  private createFileSummary(
    analyzer: ArkTSAnalyzer,
    fileName: string,
    provenance: WorkspaceProvenance = "snapshot",
  ): FileSummary {
    const sourceFile = analyzer.getSourceFile(fileName);
    if (!sourceFile) {
      throw new Error(`Unable to analyze file: ${fileName}`);
    }

    const relativePath = path.relative(this.workspaceRoot, fileName) || path.basename(fileName);
    const normalizedRelativePath = toPosixPath(relativePath);
    const components = analyzer
      .findDecoratedComponents(fileName)
      .map((component) => toComponentSummary(component));
    const fileFacts = extractFileFacts(
      sourceFile,
      this.workspaceRoot,
      fileName,
    );
    const role = classifyFileRole(fileName, components, fileFacts);

    return {
      fileName,
      relativePath: normalizedRelativePath,
      language: detectWorkspaceLanguage(fileName),
      role,
      provenance,
      summary: createFileSummaryText(
        normalizedRelativePath,
        role,
        fileFacts.exports,
        fileFacts.imports,
        components,
      ),
      imports: fileFacts.imports,
      exports: fileFacts.exports,
      topLevelSymbols: fileFacts.topLevelSymbols,
      components,
    };
  }

  private createAnalyzer(
    overlays: WorkspaceOverlayFile[] = [],
    extraFiles: string[] = [],
  ): ArkTSAnalyzer {
    const overlayMap = toOverlayMap(this.workspaceRoot, overlays);
    const analysisFiles = dedupePaths([
      ...this.discoveredFiles,
      ...extraFiles.map((fileName) => this.resolveWorkspacePath(fileName)),
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

    return analyzer;
  }

  private getQueryAnalyzer(
    normalizedFileName: string,
    overlays: WorkspaceOverlayFile[],
  ): ArkTSAnalyzer {
    if (
      overlays.length === 0 &&
      this.baseAnalyzer &&
      this.discoveredFiles.includes(normalizedFileName)
    ) {
      return this.baseAnalyzer;
    }

    return this.createAnalyzer(overlays, [normalizedFileName]);
  }

  private async persistSnapshot(): Promise<void> {
    const snapshot = this.requireSnapshot();
    const persisted: PersistedWorkspaceSnapshot = {
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

  private async loadPersistedSnapshot(): Promise<PersistedWorkspaceSnapshot | null> {
    if (!existsSync(this.cacheFile)) {
      return null;
    }

    try {
      const cacheText = await readFile(this.cacheFile, "utf8");
      const parsed = JSON.parse(cacheText) as PersistedWorkspaceSnapshot;
      if (
        parsed.version !== WORKSPACE_SNAPSHOT_VERSION ||
        parsed.workspaceId !== this.workspaceId ||
        parsed.workspaceRoot !== this.workspaceRoot
      ) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  private async createContextFile(
    summary: FileSummary,
    relation: ContextFile["relation"],
    reason: string,
    options: {
      overlayMap?: ReadonlyMap<string, string>;
      symbolQuery?: string;
      specifier?: string;
      whySelected?: string;
    } = {},
  ): Promise<ContextFile> {
    const overlayMap = options.overlayMap ?? new Map<string, string>();
    const snippet = await this.readSummarySnippet(summary, overlayMap, {
      maxLines: 20,
      ...(options.symbolQuery ? { symbolQuery: options.symbolQuery } : {}),
      ...(options.specifier ? { specifier: options.specifier } : {}),
    });

    return {
      fileName: summary.fileName,
      relativePath: summary.relativePath,
      relation,
      reason,
      summary: summary.summary,
      snippet: snippet.content,
      snippetRange: snippet.range,
      snippetTruncated: snippet.truncated,
      provenance: overlayMap.has(summary.fileName) ? "live" : "snapshot",
      evidenceLevel: "summary",
      ...(options.whySelected ? { whySelected: options.whySelected } : {}),
    };
  }

  private resolveWorkspacePath(fileName: string): string {
    return path.normalize(
      path.isAbsolute(fileName)
        ? fileName
        : path.resolve(this.workspaceRoot, fileName),
    );
  }

  private requireSnapshot(): WorkspaceSnapshot {
    if (!this.snapshot) {
      throw new Error("Workspace snapshot is not initialized.");
    }

    return this.snapshot;
  }

  private async getFileSummaryForPath(
    fileName: string,
    overlayMap: ReadonlyMap<string, string>,
  ): Promise<FileSummary | undefined> {
    if (overlayMap.has(fileName)) {
      return this.summarizeFile(fileName, toOverlayFiles(overlayMap));
    }

    const summary = this.filesByName.get(fileName);
    if (summary) {
      return {
        ...summary,
        provenance: "snapshot",
      };
    }

    if (this.discoveredFiles.includes(fileName)) {
      return this.summarizeFile(fileName);
    }

    return undefined;
  }

  private findPreferredRange(
    summary: FileSummary,
    symbolQuery: string | undefined,
  ): ExternalRange | undefined {
    const normalizedQuery = symbolQuery?.trim().toLowerCase();

    if (normalizedQuery) {
      const topLevelMatch = summary.topLevelSymbols.find((symbol) =>
        symbol.name.toLowerCase() === normalizedQuery,
      ) ?? summary.topLevelSymbols.find((symbol) =>
        symbol.name.toLowerCase().includes(normalizedQuery),
      );
      if (topLevelMatch) {
        return topLevelMatch.range;
      }

      const componentMatch = summary.components.find((component) =>
        component.name.toLowerCase() === normalizedQuery,
      ) ?? summary.components.find((component) =>
        component.name.toLowerCase().includes(normalizedQuery),
      );
      if (componentMatch) {
        return componentMatch.range;
      }
    }

    return summary.components[0]?.range ?? summary.topLevelSymbols[0]?.range;
  }

  private async readSummarySnippet(
    summary: FileSummary,
    overlayMap: ReadonlyMap<string, string>,
    options: {
      maxLines: number;
      symbolQuery?: string;
      specifier?: string;
    },
  ): Promise<SnippetPreview> {
    const text = await this.readWorkspaceText(summary.fileName, overlayMap);
    if (text === undefined) {
      return {
        content: "",
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 1 },
        },
        truncated: false,
      };
    }

    const focusRange = this.findPreferredRange(summary, options.symbolQuery) ??
      findSpecifierRange(text, options.specifier) ??
      summary.components[0]?.range ??
      summary.topLevelSymbols[0]?.range;

    return createSnippetPreviewFromText(text, {
      maxLines: options.maxLines,
      ...(focusRange ? { focusRange } : {}),
      contextBefore: 2,
      contextAfter: 2,
    });
  }

  private async buildSourceExcerpt(
    summary: FileSummary,
    overlayMap: ReadonlyMap<string, string>,
    options: ExcerptBuildOptions,
    meta: {
      symbolName?: string;
      whySelected?: string;
    } = {},
  ): Promise<SourceExcerpt> {
    const text = await this.readWorkspaceText(summary.fileName, overlayMap);
    if (text === undefined) {
      throw new Error(`Unable to read source for ${summary.fileName}.`);
    }

    const preview = createSnippetPreviewFromText(text, options);
    return {
      fileName: summary.fileName,
      relativePath: summary.relativePath,
      range: preview.range,
      content: preview.content,
      truncated: preview.truncated,
      provenance: overlayMap.has(summary.fileName) ? "live" : summary.provenance,
      evidenceLevel: "source",
      ...(meta.symbolName ? { symbolName: meta.symbolName } : {}),
      ...(meta.whySelected ? { whySelected: meta.whySelected } : {}),
    };
  }

  private async readWorkspaceText(
    fileName: string,
    overlayMap: ReadonlyMap<string, string>,
  ): Promise<string | undefined> {
    if (overlayMap.has(fileName)) {
      return overlayMap.get(fileName);
    }

    try {
      return await readFile(fileName, "utf8");
    } catch {
      return undefined;
    }
  }

  private async collectEvidenceCandidates(input: {
    rootSummary: FileSummary;
    symbolQuery?: string;
    question?: string;
    includeRelated: boolean;
    overlayMap: ReadonlyMap<string, string>;
  }): Promise<EvidenceCandidate[]> {
    const candidates: EvidenceCandidate[] = [];
    const rootRange = this.findPreferredRange(input.rootSummary, input.symbolQuery);
    const rootSymbolName = input.symbolQuery;
    candidates.push({
      fileName: input.rootSummary.fileName,
      purpose: rootSymbolName
        ? `Target definition for ${rootSymbolName}`
        : "Primary source excerpt for the target file",
      priority: 0,
      ...(rootRange ? { focusRange: rootRange } : {}),
      ...(rootSymbolName ? { symbolName: rootSymbolName } : {}),
      whySelected: rootSymbolName
        ? `Primary definition candidate for "${rootSymbolName}".`
        : input.question
          ? `Primary excerpt for answering: ${input.question}`
          : "Primary source evidence from the target file.",
    });

    if (rootRange && rootSymbolName) {
      const analyzer = this.getQueryAnalyzer(
        input.rootSummary.fileName,
        toOverlayFiles(input.overlayMap),
      );
      const references = analyzer.findReferences(
        input.rootSummary.fileName,
        {
          line: Math.max(rootRange.start.line - 1, 0),
          character: Math.max(rootRange.start.character - 1, 0),
        },
      );

      for (const reference of references.filter((candidate) => !candidate.isDefinition).slice(0, 2)) {
        candidates.push({
          fileName: reference.fileName,
          purpose: `Direct reference to ${rootSymbolName}`,
          priority: 1,
          focusRange: toExternalRangeFromAnalyzer(reference.range),
          symbolName: rootSymbolName,
          whySelected: `Direct usage site for "${rootSymbolName}".`,
        });
      }
    }

    if (input.includeRelated) {
      for (const edge of (this.outgoingEdgesByFile.get(input.rootSummary.fileName) ?? []).slice(0, 2)) {
        candidates.push({
          fileName: edge.to,
          purpose: `Direct dependency imported via ${edge.specifier}`,
          priority: 2,
          ...(edge.symbols[0] ? { symbolName: edge.symbols[0] } : {}),
          whySelected: `Imported directly by ${input.rootSummary.relativePath}.`,
          specifier: edge.specifier,
        });
      }

      for (const edge of (this.incomingEdgesByFile.get(input.rootSummary.fileName) ?? []).slice(0, 2)) {
        candidates.push({
          fileName: edge.from,
          purpose: `Direct importer through ${edge.specifier}`,
          priority: 3,
          whySelected: `Imports ${input.rootSummary.relativePath} directly.`,
          specifier: edge.specifier,
        });
      }
    }

    return candidates.sort((left, right) =>
      left.priority - right.priority ||
      left.fileName.localeCompare(right.fileName) ||
      left.purpose.localeCompare(right.purpose),
    );
  }
}

function toOverlayFiles(
  overlayMap: ReadonlyMap<string, string>,
): WorkspaceOverlayFile[] {
  return [...overlayMap.entries()].map(([fileName, content]) => ({
    fileName,
    content,
  }));
}

async function normalizeWorkspaceRoot(root: string): Promise<string> {
  const resolvedRoot = path.resolve(root);
  try {
    return await realpath(resolvedRoot);
  } catch {
    return resolvedRoot;
  }
}

function normalizeWorkspaceOptions(
  workspaceRoot: string,
  options: WorkspaceServiceOptions,
): NormalizedWorkspaceOptions {
  const cacheBaseDir =
    options.cacheDir ??
    path.join(
      process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
      "arkts-analyzer",
    );

  return {
    include: normalizePatternList(options.include, DEFAULT_INCLUDE),
    exclude: normalizePatternList(options.exclude, DEFAULT_EXCLUDE),
    maxFiles: normalizeMaxFilesOption(options.maxFiles),
    cacheDir: path.normalize(
      path.isAbsolute(cacheBaseDir)
        ? cacheBaseDir
        : path.resolve(workspaceRoot, cacheBaseDir),
    ),
    freshness: options.freshness ?? "mtime",
  };
}

function normalizeMaxFilesOption(maxFiles: number | null | undefined): number | null {
  if (maxFiles === undefined) {
    return DEFAULT_MAX_FILES;
  }

  if (maxFiles === null || !Number.isFinite(maxFiles)) {
    return null;
  }

  const normalized = Math.trunc(maxFiles);
  if (normalized <= 0) {
    return null;
  }

  return Math.min(normalized, Number.MAX_SAFE_INTEGER);
}

function normalizePatternList(
  patterns: string[] | undefined,
  defaults: string[],
): string[] {
  const sourcePatterns = patterns && patterns.length > 0 ? patterns : defaults;
  return [...new Set(
    sourcePatterns.map((pattern) => toPosixPath(pattern.trim())).filter(Boolean),
  )].sort();
}

async function discoverWorkspaceFiles(
  workspaceRoot: string,
  options: NormalizedWorkspaceOptions,
  progressReporter?: WorkspaceProgressReporter,
): Promise<DiscoverWorkspaceResult> {
  const fileNames: string[] = [];
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
      progressReporter?.({
        phase: "discover",
        discoveredFiles: fileNames.length,
        maxFiles: options.maxFiles,
        done: false,
        truncated: false,
      });
      if (options.maxFiles !== null && fileNames.length >= options.maxFiles) {
        truncated = true;
        progressReporter?.({
          phase: "discover",
          discoveredFiles: fileNames.length,
          maxFiles: options.maxFiles,
          done: true,
          truncated,
        });
        return {
          fileNames,
          truncated,
        };
      }
    }
  }

  progressReporter?.({
    phase: "discover",
    discoveredFiles: fileNames.length,
    maxFiles: options.maxFiles,
    done: true,
    truncated,
  });

  return {
    fileNames,
    truncated,
  };
}

async function collectFileStates(fileNames: string[]): Promise<WorkspaceFileState[]> {
  const states = await Promise.all(
    fileNames.map(async (fileName) => {
      const fileStat = await stat(fileName);
      return {
        fileName,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      };
    }),
  );

  return states.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function areFileStatesEqual(
  left: WorkspaceFileState[],
  right: WorkspaceFileState[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((fileState, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      other.fileName === fileState.fileName &&
      other.size === fileState.size &&
      other.mtimeMs === fileState.mtimeMs
    );
  });
}

function diffWorkspaceFileStates(
  previousStates: WorkspaceFileState[],
  nextStates: WorkspaceFileState[],
): RefreshDiff {
  const previousByFile = new Map(previousStates.map((state) => [state.fileName, state]));
  const nextByFile = new Map(nextStates.map((state) => [state.fileName, state]));
  const addedFiles = [...nextByFile.keys()].filter((fileName) => !previousByFile.has(fileName));
  const removedFiles = [...previousByFile.keys()].filter((fileName) => !nextByFile.has(fileName));
  const modifiedFiles = [...nextByFile.entries()]
    .filter(([fileName, nextState]) => {
      const previousState = previousByFile.get(fileName);
      return (
        previousState !== undefined &&
        (
          previousState.size !== nextState.size ||
          previousState.mtimeMs !== nextState.mtimeMs
        )
      );
    })
    .map(([fileName]) => fileName);

  return {
    addedFiles: addedFiles.sort((left, right) => left.localeCompare(right)),
    removedFiles: removedFiles.sort((left, right) => left.localeCompare(right)),
    modifiedFiles: modifiedFiles.sort((left, right) => left.localeCompare(right)),
  };
}

function diffChangedWorkspaceFiles(
  changedFiles: readonly string[],
  previousFiles: readonly string[],
  nextFiles: readonly string[],
): RefreshDiff {
  const previousSet = new Set(previousFiles);
  const nextSet = new Set(nextFiles);
  const addedFiles: string[] = [];
  const removedFiles: string[] = [];
  const modifiedFiles: string[] = [];

  for (const fileName of dedupePaths(changedFiles)) {
    if (nextSet.has(fileName) && !previousSet.has(fileName)) {
      addedFiles.push(fileName);
    } else if (!nextSet.has(fileName) && previousSet.has(fileName)) {
      removedFiles.push(fileName);
    } else if (nextSet.has(fileName)) {
      modifiedFiles.push(fileName);
    }
  }

  return {
    addedFiles,
    removedFiles,
    modifiedFiles,
  };
}

function extractFileFacts(
  sourceFile: ts.SourceFile,
  workspaceRoot: string,
  fileName: string,
): ExtractedFileFacts {
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  const topLevelSymbols: TopLevelSymbolSummary[] = [];
  const symbolRecords: SymbolRecord[] = [];
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
      exports.push(
        ...exportedSymbols.map((name) => ({
          name,
          kind: "re-export",
          isDefault: false,
          sourcePath: resolveImportPath(specifier, fileName, workspaceRoot, compilerOptions),
        })),
      );
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

function getTopLevelStatementSymbols(
  sourceFile: ts.SourceFile,
  statement: ts.Statement,
): {
  topLevelSymbols: TopLevelSymbolSummary[];
  symbolRecords: SymbolRecord[];
  exports: ExportRecord[];
} {
  const topLevelSymbols: TopLevelSymbolSummary[] = [];
  const symbolRecords: SymbolRecord[] = [];
  const exports: ExportRecord[] = [];
  const exported = hasExportModifier(statement);
  const defaultExport = hasDefaultModifier(statement);

  const pushSymbol = (name: string, kind: string, rangeNode: ts.Node): void => {
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
  } else if (ts.isFunctionDeclaration(statement) && statement.name) {
    pushSymbol(statement.name.text, "function", statement.name);
  } else if (ts.isInterfaceDeclaration(statement)) {
    pushSymbol(statement.name.text, "interface", statement.name);
  } else if (ts.isTypeAliasDeclaration(statement)) {
    pushSymbol(statement.name.text, "type", statement.name);
  } else if (ts.isEnumDeclaration(statement)) {
    pushSymbol(statement.name.text, "enum", statement.name);
  } else if (ts.isModuleDeclaration(statement)) {
    pushSymbol(statement.name.text, "namespace", statement.name);
  } else if (ts.isVariableStatement(statement)) {
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

function getBindingIdentifier(name: ts.BindingName): ts.Identifier | undefined {
  if (ts.isIdentifier(name)) {
    return name;
  }

  return undefined;
}

function getVariableDeclarationKind(
  declarationList: ts.VariableDeclarationList,
): "const" | "let" | "var" {
  if ((declarationList.flags & ts.NodeFlags.Const) !== 0) {
    return "const";
  }

  if ((declarationList.flags & ts.NodeFlags.Let) !== 0) {
    return "let";
  }

  return "var";
}

function hasExportModifier(node: ts.Node): boolean {
  if (!("modifiers" in node)) {
    return false;
  }

  return (ts.getModifiers(node as ts.HasModifiers) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!("modifiers" in node)) {
    return false;
  }

  return (ts.getModifiers(node as ts.HasModifiers) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function getModuleSpecifierText(node: ts.Expression): string | undefined {
  return ts.isStringLiteral(node) ? node.text : undefined;
}

function getImportSymbols(statement: ts.ImportDeclaration): string[] {
  const importClause = statement.importClause;
  if (!importClause) {
    return [];
  }

  const symbols: string[] = [];
  if (importClause.name) {
    symbols.push(importClause.name.text);
  }

  const bindings = importClause.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    symbols.push(...bindings.elements.map((element) => element.name.text));
  } else if (bindings && ts.isNamespaceImport(bindings)) {
    symbols.push(`* as ${bindings.name.text}`);
  }

  return symbols;
}

function createWorkspaceCompilerOptions(): ts.CompilerOptions {
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

function resolveImportPath(
  specifier: string,
  containingFile: string,
  workspaceRoot: string,
  compilerOptions: ts.CompilerOptions,
): string | null {
  const resolutionHost: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists?.bind(ts.sys),
    getDirectories: ts.sys.getDirectories?.bind(ts.sys),
    getCurrentDirectory: () => path.dirname(containingFile),
  };
  if (ts.sys.realpath) {
    resolutionHost.realpath = ts.sys.realpath.bind(ts.sys);
  }
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    compilerOptions,
    resolutionHost,
  ).resolvedModule?.resolvedFileName;

  if (!resolved || resolved === ARKTS_INTRINSICS_FILE_NAME) {
    return null;
  }

  const normalized = path.normalize(resolved);
  return isWithinWorkspace(normalized, workspaceRoot) ? normalized : null;
}

function detectWorkspaceLanguage(fileName: string): WorkspaceFileLanguage {
  if (isArkTSFile(fileName)) {
    return "arkts";
  }

  if (fileName.endsWith(".ts")) {
    return "typescript";
  }

  return "javascript";
}

function classifyFileRole(
  fileName: string,
  components: ComponentSummary[],
  fileFacts: ExtractedFileFacts,
): WorkspaceFileRole {
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

function createFileSummaryText(
  relativePath: string,
  role: WorkspaceFileRole,
  exports: ExportRecord[],
  imports: ImportRecord[],
  components: ComponentSummary[],
): string {
  const parts = [`${relativePath} is a ${role} file`];
  const decoratedMemberCount = components.reduce(
    (count, component) => count + component.decoratedMembers.length,
    0,
  );

  if (components.length > 0) {
    parts.push(`with ${components.length} ArkTS component(s)`);
  }

  if (decoratedMemberCount > 0) {
    parts.push(`including ${decoratedMemberCount} recognized decorated member(s)`);
  }

  if (exports.length > 0) {
    parts.push(`exporting ${exports.slice(0, 3).map((record) => record.name).join(", ")}`);
  }

  if (imports.length > 0) {
    parts.push(`and importing ${imports.length} module(s)`);
  }

  return `${parts.join(" ")}.`;
}

function createWorkspaceOverviewText(
  fileCount: number,
  symbolCount: number,
  edgeCount: number,
  entryFileCount: number,
  truncated: boolean,
): string {
  const truncationText = truncated ? " Results are capped by maxFiles." : "";
  return `Workspace indexes ${fileCount} file(s), ${symbolCount} top-level symbol(s), ${edgeCount} internal module edge(s), and ${entryFileCount} entrypoint file(s).${truncationText}`;
}

function computeHotFiles(
  fileSummaries: FileSummary[],
  moduleEdges: ModuleEdge[],
): HotFileRecord[] {
  const scores = new Map<string, number>();
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
    .sort((left, right) =>
      right.score - left.score || left.relativePath.localeCompare(right.relativePath),
    )
    .slice(0, 10);
}

function createSnippetPreviewFromText(
  text: string,
  options: ExcerptBuildOptions,
): SnippetPreview {
  const lines = text.split(/\r?\n/u);
  const totalLines = Math.max(lines.length, 1);
  const focusStart = clamp(options.focusRange?.start.line ?? 1, 1, totalLines);
  const focusEnd = clamp(options.focusRange?.end.line ?? focusStart, focusStart, totalLines);
  const requestedLineCount = focusEnd - focusStart + 1;
  const maxLines = clamp(options.maxLines, 1, 200);
  let startLine = focusStart;
  let endLine = focusEnd;

  if (options.strictRange) {
    endLine = Math.min(startLine + maxLines - 1, totalLines);
  } else {
    const contextBefore = options.contextBefore ?? 0;
    const contextAfter = options.contextAfter ?? 0;
    startLine = Math.max(focusStart - contextBefore, 1);
    endLine = Math.min(
      Math.max(focusEnd + contextAfter, startLine) + Math.max(maxLines - requestedLineCount - contextBefore - contextAfter, 0),
      totalLines,
    );

    if (endLine - startLine + 1 > maxLines) {
      endLine = startLine + maxLines - 1;
    }
  }

  const content = lines.slice(startLine - 1, endLine).join("\n");
  const lastLineText = lines[endLine - 1] ?? "";

  return {
    content,
    range: {
      start: { line: startLine, character: 1 },
      end: { line: endLine, character: lastLineText.length + 1 },
    },
    truncated:
      options.strictRange
        ? requestedLineCount > maxLines
        : startLine > 1 || endLine < totalLines,
  };
}

function findSpecifierRange(
  text: string,
  specifier: string | undefined,
): ExternalRange | undefined {
  if (!specifier) {
    return undefined;
  }

  const lines = text.split(/\r?\n/u);
  const lineIndex = lines.findIndex((line) => line.includes(specifier));
  if (lineIndex === -1) {
    return undefined;
  }

  const column = lines[lineIndex]?.indexOf(specifier) ?? 0;
  return {
    start: {
      line: lineIndex + 1,
      character: column + 1,
    },
    end: {
      line: lineIndex + 1,
      character: column + specifier.length + 1,
    },
  };
}

function toComponentSummary(component: DecoratedComponentInfo): ComponentSummary {
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
    decoratedMembers: component.decoratedMembers.map(toDecoratedMemberSummary),
  };
}

function toDecoratedMemberSummary(
  member: DecoratedComponentInfo["decoratedMembers"][number],
): DecoratedMemberSummary {
  return {
    name: member.name,
    decorator: member.decorator,
    kind: member.kind,
    range: toExternalRangeFromAnalyzer(member.range),
  };
}

function toExternalRangeFromAnalyzer(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): ExternalRange {
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

function toExternalRange(
  sourceFile: ts.SourceFile,
  start: number,
  end: number,
): ExternalRange {
  return {
    start: toExternalPosition(sourceFile.getLineAndCharacterOfPosition(start)),
    end: toExternalPosition(sourceFile.getLineAndCharacterOfPosition(Math.max(start, end))),
  };
}

function toExternalPosition(position: ts.LineAndCharacter): ExternalPosition {
  return {
    line: position.line + 1,
    character: position.character + 1,
  };
}

function dedupeModuleEdges(edges: ModuleEdge[]): ModuleEdge[] {
  const uniqueEdges = new Map<string, ModuleEdge>();
  for (const edge of edges) {
    const key = `${edge.from}:${edge.to}:${edge.kind}:${edge.specifier}:${edge.symbols.join(",")}`;
    if (!uniqueEdges.has(key)) {
      uniqueEdges.set(key, edge);
    }
  }

  return [...uniqueEdges.values()].sort((left, right) =>
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.specifier.localeCompare(right.specifier),
  );
}

function isSameEdge(left: ModuleEdge, right: ModuleEdge): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.kind === right.kind &&
    left.specifier === right.specifier
  );
}

function dedupePaths(fileNames: Iterable<string>): string[] {
  return [...new Set(fileNames)];
}

function toOverlayMap(
  workspaceRoot: string,
  overlays: WorkspaceOverlayFile[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const overlay of overlays) {
    const fileName = path.normalize(
      path.isAbsolute(overlay.fileName)
        ? overlay.fileName
        : path.resolve(workspaceRoot, overlay.fileName),
    );
    map.set(fileName, overlay.content);
  }

  return map;
}

function rankSymbolMatch(name: string, normalizedQuery: string): number {
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

function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
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

function escapeRegexCharacter(value: string): string {
  return /[|\\{}()[\]^$+?.]/u.test(value) ? `\\${value}` : value;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isWithinWorkspace(fileName: string, workspaceRoot: string): boolean {
  const relativePath = path.relative(workspaceRoot, fileName);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (currentValue && typeof currentValue === "object" && !Array.isArray(currentValue)) {
      return Object.fromEntries(
        Object.entries(currentValue as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }

    return currentValue;
  });
}

function hashString(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
