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

@Preview
@Entry
@Component
struct App {
  @State count: number = 0;
  @Prop subtitle: string = "hello";
  @State title: string = "hello";

  @Watch("count")
  onCountChange(): void {}

  build() {
    greet();
    const card = new Card();
    return card;
  }
}
`,
      },
    ]);
    const initialDocumentSymbols = service.getDocumentSymbols("src/App.ets");
    const overlayDocumentSymbols = service.getDocumentSymbols("src/App.ets", [
      {
        fileName: "src/App.ets",
        content: `import { Card } from "./Card.ets";
import { greet } from "./utils/helper.ts";

@Preview
@Entry
@Component
struct App {
  @State count: number = 0;

  build() {
    greet();
    const card = new Card();
    return card;
  }

  footer(): string {
    return "footer";
  }
}
`,
      },
    ]);
    const finalDocumentSymbols = service.getDocumentSymbols("src/App.ets");

    assert.deepEqual(
      overlaySummary.components[0]?.stateMembers.map((member) => member.name),
      ["count", "title"],
    );
    assert.deepEqual(
      overlaySummary.components[0]?.decoratedMembers.map((member) => ({
        name: member.name,
        decorator: member.decorator,
        kind: member.kind,
      })),
      [
        { name: "count", decorator: "State", kind: "state" },
        { name: "subtitle", decorator: "Prop", kind: "prop" },
        { name: "title", decorator: "State", kind: "state" },
        { name: "onCountChange", decorator: "Watch", kind: "other" },
      ],
    );
    assert.match(overlaySummary.summary, /recognized decorated member\(s\)/);
    assert.notDeepEqual(overlayDocumentSymbols, initialDocumentSymbols);
    assert.deepEqual(finalDocumentSymbols, initialDocumentSymbols);

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
    const refreshResult = await service.refresh(["src/utils/helper.ts"]);
    const refreshedSymbols = service.findSymbol("renamedHelper", { limit: 5 });

    assert.equal(refreshResult.refreshMode, "incremental");
    assert.equal(refreshResult.changedFileCount, 1);
    assert.equal(refreshResult.reindexedFileCount, 3);
    assert.equal(refreshResult.reusedFileCount, 1);
    assert.equal(refreshedSymbols.matches[0]?.fileName, workspace.helperFile);
  } finally {
    WorkspaceService.resetForTests();
    await rm(workspace.root, { recursive: true, force: true });
  }
});

test("WorkspaceService incrementally diffs workspace changes when refresh is called without explicit changed files", async () => {
  const workspace = await createWorkspaceFixture("arkts-workspace-diff-refresh-");
  const cacheDir = path.join(workspace.root, ".cache-test");
  const newHelperFile = path.join(workspace.root, "src", "utils", "new-helper.ts");

  try {
    WorkspaceService.resetForTests();
    const service = await WorkspaceService.initialize(workspace.root, {
      cacheDir,
    });

    await writeFile(
      workspace.appFile,
      `import { Card } from "./Card.ets";
import { featureFlag } from "./utils/new-helper.ts";

@Entry
@Component
struct App {
  @State count: number = featureFlag;
  build() {
    const card = new Card();
    return card;
  }
}
`,
      "utf8",
    );
    await writeFile(
      newHelperFile,
      `export const featureFlag = 2;
`,
      "utf8",
    );
    await writeFile(
      workspace.barrelFile,
      `export { featureFlag } from "./utils/new-helper.ts";
`,
      "utf8",
    );
    await rm(workspace.helperFile, { force: true });

    const refreshResult = await service.refresh();
    const featureSymbols = service.findSymbol("featureFlag", { limit: 5 });
    const greetSymbols = service.findSymbol("greet", { limit: 5 });
    const trace = await service.traceDependencies({
      targetFile: "src/App.ets",
      depth: 2,
    });

    assert.equal(refreshResult.refreshMode, "incremental");
    assert.equal(refreshResult.changedFileCount, 4);
    assert.equal(refreshResult.reindexedFileCount, 3);
    assert.equal(refreshResult.reusedFileCount, 1);
    assert.equal(service.getOverview().fileCount, 4);
    assert.equal(featureSymbols.matches[0]?.fileName, newHelperFile);
    assert.equal(greetSymbols.matches.length, 0);
    assert.ok(trace.edges.some((edge) => edge.to === newHelperFile));
    assert.ok(trace.edges.every((edge) => edge.to !== workspace.helperFile));
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
