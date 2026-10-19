// @vitest-environment jsdom
/**
 * WP-2.1 acceptance: 1 000 versions load in the history panel in < 200 ms (12 §WP-2.1, 07 §7).
 *
 * The commits go straight into the local database with `insertCommit`: listing needs rows, not
 * snapshots, and this keeps the measurement on the panel's own path (`listCommits` → `layoutTree`
 * → first React render). The machine label is added by the reviewer; the stage numbers are raw.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { insertCommit, listCommits } from "../api/history-repo.js";
import { HistoryPanel } from "../components/HistoryPanel.js";
import { layoutTree } from "../components/layout-tree.js";
import { FIXTURE_PROJECT, FIXTURE_TIME, fakeHistory, makeCommit } from "./panel-fixture.js";

// `import.meta.url` is not a file URL under jsdom; resolve from this file's directory instead.
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../../../../schemas/sqlite/migrations/");
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(resolve(MIGRATIONS_DIR, name), "utf8")]),
  ),
);

const COUNT = 1_000;

afterEach(cleanup);

/** A branch tip every 50 versions, so lane assignment has real work to do. */
function syntheticCommits() {
  const commits = [
    makeCommit({
      id: "cmt_000000",
      parent: null,
      label: "Imported",
      createdAt: FIXTURE_TIME,
      authorKind: "system",
    }),
  ];
  for (let index = 1; index < COUNT; index += 1) {
    const previous = commits[index - 1];
    if (previous === undefined) throw new Error("missing previous commit");
    const parent = index % 50 === 0 ? (commits[index - 25]?.id ?? previous.id) : previous.id;
    commits.push(
      makeCommit({
        id: `cmt_${String(index).padStart(6, "0")}`,
        parent,
        label: `Version ${index}`,
        createdAt: new Date(Date.parse(FIXTURE_TIME) + index * 1_000).toISOString(),
      }),
    );
  }
  return commits;
}

describe("the history panel with 1 000 versions", () => {
  it("lists, lays out and renders in under 200 ms", async () => {
    const platform = await createMemoryPlatform(migrations);
    const timestamp = FIXTURE_TIME;
    await platform.localDb.run(
      "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      [FIXTURE_PROJECT, "History", timestamp, timestamp],
    );
    const commits = syntheticCommits();
    for (const commit of commits) {
      await insertCommit(platform.localDb, commit);
    }

    // Setup (model wasm, the demo document) is not part of the panel's budget.
    const model = await loadTestModel();
    const liveDoc = buildDemoProject(SHORT_DEMO, {
      assetFor: (key) => fakeAssetHash(`perf:${key}`),
      projectId: "PANEL00000000000000000001",
    }).project;

    // Wall time on a shared machine: `pnpm verify` runs other suites and builds alongside this
    // one. The best of three runs is the panel's cost; the others measure the neighbours.
    let best: { listMs: number; layoutMs: number; renderMs: number; totalMs: number } | null = null;
    let rows: Awaited<ReturnType<typeof listCommits>> = [];
    let layout: ReturnType<typeof layoutTree> | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      cleanup();
      const start = performance.now();
      rows = await listCommits(platform.localDb, FIXTURE_PROJECT);
      const afterList = performance.now();
      layout = layoutTree(
        new Map(rows.map((commit) => [commit.id, commit])),
        commits.at(-1)?.id ?? null,
        { expanded: new Set() },
      );
      const afterLayout = performance.now();
      const fake = fakeHistory({ commits: rows, head: commits.at(-1)?.id ?? null, liveDoc });
      const beforeRender = performance.now();
      render(
        <HistoryPanel
          history={fake.history}
          selection={{ kind: "none" }}
          model={model}
          liveDoc={liveDoc}
          onClose={() => {}}
        />,
      );
      const afterRender = performance.now();
      const run = {
        listMs: afterList - start,
        layoutMs: afterLayout - afterList,
        renderMs: afterRender - beforeRender,
        totalMs: afterList - start + (afterLayout - afterList) + (afterRender - beforeRender),
      };
      if (best === null || run.totalMs < best.totalMs) best = run;
    }
    if (best === null || layout === null) throw new Error("no measurement");
    console.info(
      `[perf] Vitest/Node history panel, ${COUNT} versions (best of 3): ` +
        `listCommits ${best.listMs.toFixed(1)} ms, layoutTree ${best.layoutMs.toFixed(1)} ms, ` +
        `first render ${best.renderMs.toFixed(1)} ms, total ${best.totalMs.toFixed(1)} ms ` +
        `(lanes ${layout.laneCount}, rows ${layout.rows.length})`,
    );

    expect(rows).toHaveLength(COUNT);
    expect(layout.rows).toHaveLength(COUNT);
    expect(best.totalMs).toBeLessThan(200);
  });

  it("keeps only the visible rows in the DOM", async () => {
    const commits = syntheticCommits();
    const model = await loadTestModel();
    const liveDoc = buildDemoProject(SHORT_DEMO, {
      assetFor: (key) => fakeAssetHash(`perf-dom:${key}`),
      projectId: "PANEL00000000000000000002",
    }).project;
    const fake = fakeHistory({
      commits,
      head: commits.at(-1)?.id ?? null,
      liveDoc,
    });
    render(
      <HistoryPanel
        history={fake.history}
        selection={{ kind: "none" }}
        model={model}
        liveDoc={liveDoc}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("history-scroller")).toBeTruthy();
    const rendered = document.querySelectorAll('[role="treeitem"]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(80);
    expect(screen.queryByTestId("history-row-cmt_000500")).toBeNull();
  });
});
