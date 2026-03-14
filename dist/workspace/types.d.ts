export interface ExternalPosition {
    line: number;
    character: number;
}
export interface ExternalRange {
    start: ExternalPosition;
    end: ExternalPosition;
}
export type WorkspaceFreshness = "mtime" | "always";
export type WorkspaceCacheStatus = "memory" | "hit" | "rebuilt";
export type WorkspaceProvenance = "snapshot" | "live";
export type EvidenceLevel = "summary" | "source";
export type WorkspaceFileLanguage = "arkts" | "typescript" | "javascript";
export type WorkspaceFileRole = "entrypoint" | "component" | "module" | "script";
export type ContextRelation = "self" | "imports" | "importedBy" | "dependency";
export interface WorkspaceOverlayFile {
    fileName: string;
    content: string;
}
export interface WorkspaceServiceOptions {
    include?: string[] | undefined;
    exclude?: string[] | undefined;
    maxFiles?: number | undefined;
    cacheDir?: string | undefined;
    freshness?: WorkspaceFreshness | undefined;
}
export interface StateMemberSummary {
    name: string;
    decorator: string;
    range: ExternalRange;
}
export type DecoratedMemberSummaryKind = "state" | "prop" | "param" | "require" | "trace" | "computed" | "observed" | "observedV2" | "link" | "objectLink" | "provide" | "consume" | "storageProp" | "storageLink" | "localStorageProp" | "localStorageLink" | "builderParam" | "local" | "other";
export interface DecoratedMemberSummary {
    name: string;
    decorator: string;
    kind: DecoratedMemberSummaryKind;
    range: ExternalRange;
}
export interface ComponentSummary {
    name: string;
    range: ExternalRange;
    isEntry: boolean;
    componentDecorators: string[];
    stateMembers: StateMemberSummary[];
    decoratedMembers: DecoratedMemberSummary[];
}
export interface ImportRecord {
    specifier: string;
    resolvedPath: string | null;
    importedSymbols: string[];
    kind: "import" | "re-export";
    isTypeOnly: boolean;
}
export interface ExportRecord {
    name: string;
    kind: string;
    isDefault: boolean;
    sourcePath?: string | null | undefined;
}
export interface TopLevelSymbolSummary {
    name: string;
    kind: string;
    range: ExternalRange;
    exported: boolean;
}
export interface FileSummary {
    fileName: string;
    relativePath: string;
    language: WorkspaceFileLanguage;
    role: WorkspaceFileRole;
    provenance: WorkspaceProvenance;
    summary: string;
    imports: ImportRecord[];
    exports: ExportRecord[];
    topLevelSymbols: TopLevelSymbolSummary[];
    components: ComponentSummary[];
}
export interface SymbolRecord {
    name: string;
    kind: string;
    fileName: string;
    relativePath: string;
    range: ExternalRange;
    exported: boolean;
}
export interface ModuleEdge {
    from: string;
    to: string;
    kind: "import" | "re-export";
    specifier: string;
    symbols: string[];
}
export interface HotFileRecord {
    fileName: string;
    relativePath: string;
    score: number;
}
export interface WorkspaceSnapshot {
    version: string;
    workspaceId: string;
    workspaceRoot: string;
    createdAt: string;
    updatedAt: string;
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    truncated: boolean;
    maxFiles: number;
    include: string[];
    exclude: string[];
    entryFiles: string[];
    hotFiles: HotFileRecord[];
    files: FileSummary[];
    symbols: SymbolRecord[];
    moduleEdges: ModuleEdge[];
    overviewText: string;
}
export interface WorkspaceOverview {
    workspaceId: string;
    workspaceRoot: string;
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    truncated: boolean;
    entryFiles: string[];
    hotFiles: HotFileRecord[];
    cacheStatus: WorkspaceCacheStatus;
    provenance: WorkspaceProvenance;
    overview: string;
}
export interface FindSymbolOptions {
    limit?: number | undefined;
}
export interface FindSymbolResult {
    query: string;
    matches: SymbolRecord[];
    provenance: WorkspaceProvenance;
}
export interface ContextFile {
    fileName: string;
    relativePath: string;
    relation: ContextRelation;
    reason: string;
    summary: string;
    snippet: string;
    snippetRange?: ExternalRange;
    snippetTruncated?: boolean;
    provenance?: WorkspaceProvenance;
    evidenceLevel?: EvidenceLevel;
    whySelected?: string;
}
export interface ContextBundle {
    rootFile: string;
    reason: string;
    files: ContextFile[];
    provenance: WorkspaceProvenance;
}
export interface RelatedFilesOptions {
    targetFile?: string | undefined;
    symbolQuery?: string | undefined;
    limit?: number | undefined;
}
export interface ExplainModuleResult {
    file: FileSummary;
    context: ContextBundle;
    provenance: WorkspaceProvenance;
}
export interface TraceDependenciesOptions {
    targetFile?: string | undefined;
    symbolQuery?: string | undefined;
    depth?: number | undefined;
    limit?: number | undefined;
}
export interface DependencyTraceNode {
    fileName: string;
    relativePath: string;
    role: WorkspaceFileRole;
}
export interface DependencyTrace {
    rootFile: string;
    depth: number;
    truncated: boolean;
    nodes: DependencyTraceNode[];
    edges: ModuleEdge[];
    provenance: WorkspaceProvenance;
}
export interface RefreshResult {
    workspaceId: string;
    refreshedFiles: string[];
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    cacheStatus: WorkspaceCacheStatus;
    refreshMode: "full" | "incremental";
    changedFileCount: number;
    reindexedFileCount: number;
    reusedFileCount: number;
    provenance: WorkspaceProvenance;
}
export interface SourceExcerpt {
    fileName: string;
    relativePath: string;
    range: ExternalRange;
    content: string;
    truncated: boolean;
    provenance: WorkspaceProvenance;
    evidenceLevel: EvidenceLevel;
    symbolName?: string;
    whySelected?: string;
}
export interface ReadSourceExcerptResult {
    targetFile: string;
    excerpt: SourceExcerpt;
}
export interface EvidenceSnippet {
    fileName: string;
    relativePath: string;
    range: ExternalRange;
    content: string;
    purpose: string;
    truncated: boolean;
    provenance: WorkspaceProvenance;
    evidenceLevel: EvidenceLevel;
    whySelected?: string;
}
export interface EvidenceContextResult {
    rootFile: string;
    snippets: EvidenceSnippet[];
    truncated: boolean;
    provenance: WorkspaceProvenance;
}
