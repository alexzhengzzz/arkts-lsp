import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as z from "zod/v4";
export const MCP_CONFIG_FILE_NAME = "arkts-mcp.config.json";
const mcpConfigSchema = z.strictObject({
    workspaceRoot: z.string().min(1).optional(),
    maxFiles: z.union([z.number().int().positive(), z.null()]).optional(),
    cacheDir: z.string().min(1).optional(),
    freshness: z.enum(["mtime", "always"]).optional(),
});
export function resolveMcpServerConfig(cwd = process.cwd(), argv = process.argv.slice(2)) {
    const cliOptions = parseMcpServerArgs(argv);
    const configPath = path.join(cwd, MCP_CONFIG_FILE_NAME);
    const fileOptions = loadMcpConfigFile(configPath);
    const workspaceRoot = resolveWorkspaceRoot(cliOptions.workspaceRoot ?? fileOptions?.workspaceRoot, cwd);
    const serviceOptions = {
        ...(cliOptions.maxFiles !== undefined
            ? { maxFiles: cliOptions.maxFiles }
            : fileOptions?.maxFiles !== undefined
                ? { maxFiles: fileOptions.maxFiles }
                : {}),
        ...(cliOptions.cacheDir !== undefined
            ? { cacheDir: cliOptions.cacheDir }
            : fileOptions?.cacheDir !== undefined
                ? { cacheDir: fileOptions.cacheDir }
                : {}),
        ...(cliOptions.freshness !== undefined
            ? { freshness: cliOptions.freshness }
            : fileOptions?.freshness !== undefined
                ? { freshness: fileOptions.freshness }
                : {}),
    };
    return {
        workspaceRoot,
        serviceOptions,
        ...(fileOptions ? { configPath } : {}),
    };
}
function parseMcpServerArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument) {
            continue;
        }
        if (argument === "--workspace-root") {
            const value = argv[index + 1];
            if (!value) {
                throw new Error("Missing value for --workspace-root.");
            }
            options.workspaceRoot = value;
            index += 1;
            continue;
        }
        if (argument === "--cache-dir") {
            const value = argv[index + 1];
            if (!value) {
                throw new Error("Missing value for --cache-dir.");
            }
            options.cacheDir = value;
            index += 1;
            continue;
        }
        if (argument === "--max-files") {
            const value = argv[index + 1];
            if (!value) {
                throw new Error("Missing value for --max-files.");
            }
            options.maxFiles = parseMaxFiles(value);
            index += 1;
            continue;
        }
        if (argument === "--freshness") {
            const value = argv[index + 1];
            if (value !== "mtime" && value !== "always") {
                throw new Error('Expected "mtime" or "always" after --freshness.');
            }
            options.freshness = value;
            index += 1;
            continue;
        }
        if (argument.startsWith("--")) {
            throw new Error(`Unknown option: ${argument}`);
        }
    }
    return options;
}
function loadMcpConfigFile(configPath) {
    if (!existsSync(configPath)) {
        return undefined;
    }
    let rawConfig;
    try {
        rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid ${MCP_CONFIG_FILE_NAME}: ${message}`);
    }
    const parsed = mcpConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const issuePath = issue && "code" in issue && issue.code === "unrecognized_keys"
            ? String(issue.keys[0] ?? "<root>")
            : issue?.path?.join(".") || "<root>";
        throw new Error(`Invalid ${MCP_CONFIG_FILE_NAME} at ${issuePath}: ${issue?.message ?? "Unknown validation error."}`);
    }
    return parsed.data;
}
function resolveWorkspaceRoot(configuredWorkspaceRoot, cwd) {
    const workspaceRoot = configuredWorkspaceRoot ?? ".";
    return path.resolve(cwd, workspaceRoot);
}
function parseMaxFiles(rawValue) {
    if (rawValue === "null" || rawValue === "unlimited") {
        return null;
    }
    const value = Number(rawValue);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Expected a positive integer or null for --max-files, received "${rawValue}".`);
    }
    return value;
}
//# sourceMappingURL=mcp-config.js.map