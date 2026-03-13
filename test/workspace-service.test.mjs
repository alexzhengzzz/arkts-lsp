import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceService } from "../dist/index.js";

test("WorkspaceService builds a persisted workspace snapshot and reuses it on the next initialization", async () => {
  const workspace = await createWorkspaceFixture("arkts-workspace-cache-");
  const cacheDir = path.join(workspace.root, ".cache-test");

  try {
    WorkspaceService.resetForTests();
    const service = await WorkspaceService.initialize(workspace.root, {
      cacheDir,
    });
    const overview = service.getOverview();

    assert.equal(overview.fileCount, 4);
    assert.equal(overview.cacheStatus, "rebuilt");
    assert.ok(overview.entryFiles.includes(workspace.appFile));
    assert.ok(overview.hotFiles.some((file) => file.fileName === workspace.appFile));

    const symbolResult = service.findSymbol("greet", { limit: 5 });
    assert.equal(symbolResult.matches[0]?.fileName, workspace.helperFile);

    WorkspaceService.resetForTests();
    const cachedService = await WorkspaceService.initialize(workspace.root, {
      cacheDir,
    });

    assert.equal(cachedService.getOverview().cacheStatus, "hit");
  } finally {
    WorkspaceService.resetForTests();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("WorkspaceService summarizes overlay content, returns related files, and refreshes after on-disk changes", async () => {
  const workspace = await createWorkspaceFixture("arkts-workspace-refresh-");
  const cacheDir = path.join(workspace.root, ".cache-test");

  try {
    WorkspaceService.resetForTests();
    const service = await WorkspaceService.initialize(workspace.root, {
      cacheDir,
    });
    const overlaySummary = await service.summarizeFile("src/App.ets", [
      {
        fileName: "src/App.ets",
        content: `import { Card } from "./Card.ets";
import { greet } from "./utils/helper.ts";

@Entry
@Component
struct App {
  @State count: number = 0;
  @State title: string = "hello";
  build() {
    greet();
    const card = new Card();
    return card;
  }
}
`,
      },
    ]);

    assert.deepEqual(
      overlaySummary.components[0]?.stateMembers.map((member) => member.name),
      ["count", "title"],
    );

    const relatedFiles = await service.getRelatedFiles({
      targetFile: "src/App.ets",
      limit: 4,
    });
    assert.equal(relatedFiles.rootFile, workspace.appFile);
    assert.ok(
      relatedFiles.files.some(
        (file) => file.fileName === workspace.helperFile && file.relation === "imports",
      ),
    );

    await writeFile(
      workspace.helperFile,
      `export function renamedHelper(): string {
  return "updated";
}
`,
      "utf8",
    );
    await service.refresh(["src/utils/helper.ts"]);
    const refreshedSymbols = service.findSymbol("renamedHelper", { limit: 5 });

    assert.equal(refreshedSymbols.matches[0]?.fileName, workspace.helperFile);
  } finally {
    WorkspaceService.resetForTests();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

async function createWorkspaceFixture(prefix) {
  const createdRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = await realpath(createdRoot);
  const srcDir = path.join(root, "src");
  const utilsDir = path.join(srcDir, "utils");
  const ignoredDir = path.join(root, "node_modules", "ignored");
  await mkdir(utilsDir, { recursive: true });
  await mkdir(ignoredDir, { recursive: true });

  const appFile = path.join(srcDir, "App.ets");
  const cardFile = path.join(srcDir, "Card.ets");
  const helperFile = path.join(utilsDir, "helper.ts");
  const barrelFile = path.join(srcDir, "barrel.ts");

  await writeFile(
    appFile,
    `import { Card } from "./Card.ets";
import { greet } from "./utils/helper.ts";

@Entry
@Component
struct App {
  @State count: number = 0;
  build() {
    greet();
    const card = new Card();
    return card;
  }
}
`,
    "utf8",
  );
  await writeFile(
    cardFile,
    `@Component
export struct Card {
  build() {}
}
`,
    "utf8",
  );
  await writeFile(
    helperFile,
    `export const helperValue = 1;

export function greet(): number {
  return helperValue;
}
`,
    "utf8",
  );
  await writeFile(
    barrelFile,
    `export { greet } from "./utils/helper.ts";
`,
    "utf8",
  );
  await writeFile(
    path.join(ignoredDir, "index.ts"),
    `export const ignored = true;
`,
    "utf8",
  );

  return {
    root,
    appFile,
    cardFile,
    helperFile,
    barrelFile,
  };
}
