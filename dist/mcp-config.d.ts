import type { WorkspaceServiceOptions } from "./workspace/types.js";
export declare const MCP_CONFIG_FILE_NAME = "arkts-mcp.config.json";
export interface ResolvedMcpServerConfig {
    workspaceRoot: string;
    serviceOptions: WorkspaceServiceOptions;
    configPath?: string | undefined;
}
export declare function resolveMcpServerConfig(cwd?: string, argv?: string[]): ResolvedMcpServerConfig;
