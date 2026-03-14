import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspaceRoot = path.resolve(repoRoot, "test/fixtures/sample_test");
const buildScriptPath = path.resolve(repoRoot, "dist/build-workspace-index.js");

async function main() {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "arkts-workspace-cache-"));

  try {
    assertBuildOutputPresent();
    console.log(`Workspace: ${workspaceRoot}`);
    console.log(`Cache dir: ${cacheDir}`);

    const firstRun = runWorkspaceIndex(cacheDir);
    const firstData = parseRunResult("first run", firstRun);
    const cacheFilesAfterFirstRun = await readdir(cacheDir);
    assertCondition(firstData.cacheStatus === "rebuilt", [
      `Expected first run cacheStatus to be "rebuilt", received "${firstData.cacheStatus}".`,
      formatRawResult("first run", firstRun),
    ]);
    assertCondition(firstData.fileCount > 0, [
      `Expected first run fileCount to be > 0, received ${firstData.fileCount}.`,
      formatRawResult("first run", firstRun),
    ]);
    assertCondition(
      cacheFilesAfterFirstRun.some((fileName) => fileName.endsWith(".json")),
      [
        `Expected cache directory to contain a .json snapshot after first run, found: ${cacheFilesAfterFirstRun.join(", ") || "(empty)"}.`,
        formatRawResult("first run", firstRun),
      ],
    );

    const secondRun = runWorkspaceIndex(cacheDir);
    const secondData = parseRunResult("second run", secondRun);
    assertCondition(secondData.cacheStatus === "hit", [
      `Expected second run cacheStatus to be "hit", received "${secondData.cacheStatus}".`,
      formatRawResult("second run", secondRun),
    ]);
    assertCondition(secondData.fileCount === firstData.fileCount, [
      `Expected second run fileCount (${secondData.fileCount}) to match first run (${firstData.fileCount}).`,
      formatRawResult("first run", firstRun),
      formatRawResult("second run", secondRun),
    ]);
    assertCondition(secondData.symbolCount === firstData.symbolCount, [
      `Expected second run symbolCount (${secondData.symbolCount}) to match first run (${firstData.symbolCount}).`,
      formatRawResult("first run", firstRun),
      formatRawResult("second run", secondRun),
    ]);
    assertCondition(secondData.edgeCount === firstData.edgeCount, [
      `Expected second run edgeCount (${secondData.edgeCount}) to match first run (${firstData.edgeCount}).`,
      formatRawResult("first run", firstRun),
      formatRawResult("second run", secondRun),
    ]);
    assertCondition(secondData.reindexedFileCount === 0, [
      `Expected second run reindexedFileCount to be 0, received ${secondData.reindexedFileCount}.`,
      formatRawResult("second run", secondRun),
    ]);
    assertCondition(secondData.reusedFileCount === secondData.fileCount, [
      `Expected second run reusedFileCount (${secondData.reusedFileCount}) to equal fileCount (${secondData.fileCount}).`,
      formatRawResult("second run", secondRun),
    ]);

    printRunSummary("first run", firstData);
    printRunSummary("second run", secondData);
    console.log("PASS: workspace snapshot cache is generated and hit on the second process run.");
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

function assertBuildOutputPresent() {
  const result = spawnSync(process.execPath, [buildScriptPath, "--help"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      `Missing build output at ${buildScriptPath}. Run "npm run build" before verifying workspace cache.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `Unable to execute ${buildScriptPath}. Run "npm run build" before verifying workspace cache.`,
        formatRawResult("build output check", result),
      ].join("\n"),
    );
  }
}

function runWorkspaceIndex(cacheDir) {
  return spawnSync(
    process.execPath,
    [
      buildScriptPath,
      workspaceRoot,
      "--json",
      "--cache-dir",
      cacheDir,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
}

function parseRunResult(label, result) {
  if (result.error) {
    throw new Error(
      [`${label} failed to spawn.`, formatRawResult(label, result)].join("\n"),
    );
  }
  if (result.status !== 0) {
    throw new Error(
      [`${label} exited with code ${result.status}.`, formatRawResult(label, result)].join("\n"),
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        `${label} returned invalid JSON: ${detail}`,
        formatRawResult(label, result),
      ].join("\n"),
    );
  }
}

function printRunSummary(label, data) {
  console.log(
    `${label}: cacheStatus=${data.cacheStatus}, refreshMode=${data.refreshMode}, fileCount=${data.fileCount}, reindexedFileCount=${data.reindexedFileCount}, reusedFileCount=${data.reusedFileCount}`,
  );
}

function assertCondition(condition, lines) {
  if (!condition) {
    throw new Error(lines.join("\n"));
  }
}

function formatRawResult(label, result) {
  return [
    `${label} stdout:`,
    result.stdout?.trim() || "(empty)",
    `${label} stderr:`,
    result.stderr?.trim() || "(empty)",
  ].join("\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
});
