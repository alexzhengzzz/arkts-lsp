import path from "node:path";

import { WorkspaceService } from "./workspace/workspace-service.js";
import type {
  WorkspaceFreshness,
  WorkspaceProgressEvent,
  WorkspaceServiceOptions,
} from "./workspace/types.js";

interface CliOptions {
  workspaceRoot: string;
  json: boolean;
  help: boolean;
  verbose: boolean;
  serviceOptions: WorkspaceServiceOptions;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const progressLogger = createVerboseProgressLogger(options);
  const serviceOptions: WorkspaceServiceOptions = {
    ...options.serviceOptions,
    progressReporter: (event) => {
      progressLogger(event);
    },
  };

  const startedAt = Date.now();
  logVerbose(options, `Starting workspace index build for ${options.workspaceRoot}`);

  const initializeStartedAt = Date.now();
  logVerbose(options, "Initializing workspace service");
  const service = await WorkspaceService.initialize(
    options.workspaceRoot,
    serviceOptions,
  );
  const initializeDurationMs = Date.now() - initializeStartedAt;
  const initializedOverview = service.getOverview();
  logVerbose(
    options,
    `Initialized in ${initializeDurationMs}ms (cache=${initializedOverview.cacheStatus}, files=${initializedOverview.fileCount})`,
  );

  const refreshStartedAt = Date.now();
  logVerbose(options, "Refreshing workspace snapshot");
  const refresh = await service.refresh();
  const overview = service.getOverview();
  const refreshDurationMs = Date.now() - refreshStartedAt;
  logVerbose(
    options,
    `Refresh completed in ${refreshDurationMs}ms (mode=${refresh.refreshMode}, reindexed=${refresh.reindexedFileCount})`,
  );

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
  logVerbose(options, `Workspace index build finished in ${Date.now() - startedAt}ms`);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Workspace: ${result.workspaceRoot}\n`);
  process.stdout.write(`Workspace ID: ${result.workspaceId}\n`);
  process.stdout.write(`Cache: ${result.cacheStatus}\n`);
  process.stdout.write(`Refresh: ${result.refreshMode}\n`);
  process.stdout.write(
    `Files: ${result.fileCount}, Symbols: ${result.symbolCount}, Edges: ${result.edgeCount}\n`,
  );
  process.stdout.write(
    `Changed: ${result.changedFileCount}, Reindexed: ${result.reindexedFileCount}, Reused: ${result.reusedFileCount}\n`,
  );
  process.stdout.write(`Truncated: ${result.truncated}\n`);
  process.stdout.write(`${result.overview}\n`);
}

function parseArgs(args: string[]): CliOptions {
  let workspaceRoot = process.cwd();
  let json = false;
  let help = false;
  let verbose = false;
  let maxFiles: number | null = null;
  let cacheDir: string | undefined;
  let freshness: WorkspaceFreshness | undefined;

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

    if (argument === "--verbose") {
      verbose = true;
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

  const serviceOptions: WorkspaceServiceOptions = {};
  if (cacheDir !== undefined) {
    serviceOptions.cacheDir = path.resolve(cacheDir);
  }
  serviceOptions.maxFiles = maxFiles;
  if (freshness !== undefined) {
    serviceOptions.freshness = freshness;
  }

  return {
    workspaceRoot: path.resolve(workspaceRoot),
    json,
    help,
    verbose,
    serviceOptions,
  };
}

function parseMaxFiles(rawValue: string): number | null {
  if (rawValue === "null" || rawValue === "unlimited") {
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value)) {
    throw new Error(`Expected an integer for --max-files, received "${rawValue}".`);
  }

  return value;
}

function printHelp(): void {
  process.stdout.write(`Usage: node dist/build-workspace-index.js [workspaceRoot] [options]

Options:
  --json                     Print machine-readable JSON output.
  --verbose                  Print stage-level and file-count progress logs to stderr.
  --cache-dir <path>         Override the workspace snapshot cache directory.
  --max-files <n|null>       Override maxFiles. Defaults to "null" (unlimited) when omitted.
  --freshness <mtime|always> Override cache freshness policy.
  --help, -h                 Show this help text.
`);
}

function logVerbose(options: CliOptions, message: string): void {
  if (!options.verbose) {
    return;
  }

  process.stderr.write(`[workspace:index] ${message}\n`);
}

function createVerboseProgressLogger(options: CliOptions): (event: WorkspaceProgressEvent) => void {
  let lastDiscoveredCount = 0;
  let lastIndexedCount = 0;
  let lastIndexedTotal = 0;
  let lastIndexMode: "full" | "incremental" | null = null;

  return (event) => {
    if (!options.verbose) {
      return;
    }

    if (event.phase === "discover") {
      if (shouldLogProgress(event.discoveredFiles, event.maxFiles)) {
        lastDiscoveredCount = event.discoveredFiles;
        const capText = event.maxFiles === null ? "unlimited" : String(event.maxFiles);
        logVerbose(
          options,
          `Discovered ${event.discoveredFiles} matching workspace files (maxFiles=${capText})`,
        );
      }

      if (event.done && event.discoveredFiles !== lastDiscoveredCount) {
        const suffix = event.truncated ? ", truncated by maxFiles" : "";
        logVerbose(
          options,
          `Discovered ${event.discoveredFiles} matching workspace files${suffix}`,
        );
        lastDiscoveredCount = event.discoveredFiles;
      }

      return;
    }

    if (
      event.mode !== lastIndexMode ||
      event.totalFiles !== lastIndexedTotal ||
      shouldLogProgress(event.processedFiles, event.totalFiles)
    ) {
      lastIndexMode = event.mode;
      lastIndexedTotal = event.totalFiles;
      lastIndexedCount = event.processedFiles;
      logVerbose(
        options,
        `Indexed ${event.processedFiles}/${event.totalFiles} files (${event.mode})`,
      );
      return;
    }

    if (
      event.processedFiles === event.totalFiles &&
      event.processedFiles !== lastIndexedCount
    ) {
      lastIndexedCount = event.processedFiles;
      logVerbose(
        options,
        `Indexed ${event.processedFiles}/${event.totalFiles} files (${event.mode})`,
      );
    }
  };
}

function shouldLogProgress(current: number, total: number | null): boolean {
  if (current <= 0) {
    return false;
  }

  if (total !== null && total <= 20) {
    return true;
  }

  return current === 1 || current % 100 === 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
