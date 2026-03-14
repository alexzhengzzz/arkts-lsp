import path from "node:path";
import { WorkspaceService } from "./workspace/workspace-service.js";
async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const service = await WorkspaceService.initialize(options.workspaceRoot, options.serviceOptions);
    const refresh = await service.refresh();
    const overview = service.getOverview();
    const result = {
        workspaceRoot: overview.workspaceRoot,
        workspaceId: overview.workspaceId,
        cacheStatus: overview.cacheStatus,
        refreshMode: refresh.refreshMode,
        fileCount: overview.fileCount,
        symbolCount: overview.symbolCount,
        edgeCount: overview.edgeCount,
        truncated: overview.truncated,
        changedFileCount: refresh.changedFileCount,
        reindexedFileCount: refresh.reindexedFileCount,
        reusedFileCount: refresh.reusedFileCount,
        overview: overview.overview,
    };
    if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    process.stdout.write(`Workspace: ${result.workspaceRoot}\n`);
    process.stdout.write(`Workspace ID: ${result.workspaceId}\n`);
    process.stdout.write(`Cache: ${result.cacheStatus}\n`);
    process.stdout.write(`Refresh: ${result.refreshMode}\n`);
    process.stdout.write(`Files: ${result.fileCount}, Symbols: ${result.symbolCount}, Edges: ${result.edgeCount}\n`);
    process.stdout.write(`Changed: ${result.changedFileCount}, Reindexed: ${result.reindexedFileCount}, Reused: ${result.reusedFileCount}\n`);
    process.stdout.write(`Truncated: ${result.truncated}\n`);
    process.stdout.write(`${result.overview}\n`);
}
function parseArgs(args) {
    let workspaceRoot = process.cwd();
    let json = false;
    let help = false;
    let maxFiles;
    let cacheDir;
    let freshness;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (!argument) {
            continue;
        }
        if (argument === "--json") {
            json = true;
            continue;
        }
        if (argument === "--help" || argument === "-h") {
            help = true;
            continue;
        }
        if (argument === "--cache-dir") {
            const nextValue = args[index + 1];
            if (!nextValue) {
                throw new Error("Missing value for --cache-dir.");
            }
            cacheDir = nextValue;
            index += 1;
            continue;
        }
        if (argument === "--max-files") {
            const nextValue = args[index + 1];
            if (!nextValue) {
                throw new Error("Missing value for --max-files.");
            }
            maxFiles = parseMaxFiles(nextValue);
            index += 1;
            continue;
        }
        if (argument === "--freshness") {
            const nextValue = args[index + 1];
            if (nextValue !== "mtime" && nextValue !== "always") {
                throw new Error('Expected "mtime" or "always" after --freshness.');
            }
            freshness = nextValue;
            index += 1;
            continue;
        }
        if (argument.startsWith("--")) {
            throw new Error(`Unknown option: ${argument}`);
        }
        workspaceRoot = path.resolve(argument);
    }
    const serviceOptions = {};
    if (cacheDir !== undefined) {
        serviceOptions.cacheDir = path.resolve(cacheDir);
    }
    if (maxFiles !== undefined) {
        serviceOptions.maxFiles = maxFiles;
    }
    if (freshness !== undefined) {
        serviceOptions.freshness = freshness;
    }
    return {
        workspaceRoot: path.resolve(workspaceRoot),
        json,
        help,
        serviceOptions,
    };
}
function parseMaxFiles(rawValue) {
    if (rawValue === "null" || rawValue === "unlimited") {
        return null;
    }
    const value = Number(rawValue);
    if (!Number.isInteger(value)) {
        throw new Error(`Expected an integer for --max-files, received "${rawValue}".`);
    }
    return value;
}
function printHelp() {
    process.stdout.write(`Usage: node dist/build-workspace-index.js [workspaceRoot] [options]

Options:
  --json                     Print machine-readable JSON output.
  --cache-dir <path>         Override the workspace snapshot cache directory.
  --max-files <n|null>       Override maxFiles. Use "null" or "unlimited" for no cap.
  --freshness <mtime|always> Override cache freshness policy.
  --help, -h                 Show this help text.
`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
});
//# sourceMappingURL=build-workspace-index.js.map