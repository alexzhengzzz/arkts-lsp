export declare const ARKTS_INTRINSICS_FILE_NAME = "__arkts_intrinsics__.d.ts";
export declare const ARKTS_COMPONENT_DECORATOR = "Component";
export declare const ARKTS_ENTRY_DECORATOR = "Entry";
export declare const ARKTS_STATE_DECORATOR = "State";
export declare const ARKTS_INTRINSIC_DECORATORS: readonly ["Entry", "Component", "State"];
export declare function isArkTSFile(fileName: string): boolean;
export declare function isArkTSIntrinsicFile(fileName: string): boolean;
export declare function getArkTSIntrinsicsSource(): string;
export declare function normalizeArkTSSource(fileName: string, sourceText: string): string;
