import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ResolvedMcpServerConfig } from "./mcp-config.js";
export declare function createArkTSMcpServer(serverConfig?: ResolvedMcpServerConfig): McpServer;
export declare function main(): Promise<void>;
