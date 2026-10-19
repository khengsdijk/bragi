import type { OpBatch } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import type { StoredCommit } from "../api/history-repo.js";
import { type CommitTreeRow, layoutTree, type TreeRow } from "../components/layout-tree.js";

const PROJECT = "prj_LAYOUT0000000000000001";
const TIME = "2026-10-19T12:00:00.000Z";

function batch(label: string, analysis = false): OpBatch {
  return {
    id: `bat_${label.replace(/\W/gu, "").padEnd(26, "0").slice(0, 26)}`,
    author: analysis ? { kind: "system", reason: "analysis" } : { kind: "user" },
    label,
    ops: analysis
      ? [
          {
            op: "analysis.apply",
            sourceId: "src_test",
            stage: "rhythm",
            blob: "sha256:00",
            effects: [],
          },
        ]
      : [{ op: "project.set_meta", title: label }],
    createdAt: TIME,
  };
}

function commit(
  id: string,
  parent: string | null,
  createdAt: string,
  options: {
    readonly label?: string;
    readonly analysis?: boolean;
    readonly state?: StoredCommit["state"];
    readonly authorKind?: StoredCommit["authorKind"];
  } = {},
): StoredCommit {
  const label = options.label ?? id;
  const analysis = options.analysis ?? false;
  return {
    id,
    projectId: PROJECT,
    parent,
    batch: batch(label, analysis),
    label,
    authorKind: options.authorKind ?? (analysis ? "system" : "user"),
    snapshotHash: `sha256:${id}`,
    state: options.state ?? "committed",
    candidateGroup: null,
    deviceId: "dev_test",
    createdAt,
    seq: null,
  };
}

function map(...commits: StoredCommit[]): Map<string, StoredCommit> {
  return new Map(commits.map((entry) => [entry.id, entry]));
}

function ids(rows: readonly TreeRow[]): string[] {
  return rows.map((row) => (row.kind === "analysis" ? `analysis:${row.id}` : row.id));
}

function byId(rows: readonly TreeRow[], id: string): CommitTreeRow {
  const row = rows.find(
    (entry): entry is CommitTreeRow => entry.kind === "commit" && entry.id === id,
  );
  if (row === undefined) throw new Error(`no row ${id}`);
  return row;
}

const t = (minutes: number): string => new Date(Date.parse(TIME) + minutes * 60_000).toISOString();

describe("layoutTree", () => {
  it("lays a linear chain out newest first in lane 0", () => {
    const commits = map(
      commit("cmt_1", null, t(0), { label: "Imported", authorKind: "system" }),
      commit("cmt_2", "cmt_1", t(1), { label: "Mute Bass" }),
      commit("cmt_3", "cmt_2", t(2), { label: "Quiet pads" }),
    );
    const layout = layoutTree(commits, "cmt_3", { expanded: new Set() });

    expect(ids(layout.rows)).toEqual(["cmt_3", "cmt_2", "cmt_1"]);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map((row) => row.isHead)).toEqual([true, false, false]);
    expect(layout.rows[0]?.parent).toEqual({ row: 1, lane: 0 });
    expect(layout.rows[1]?.parent).toEqual({ row: 2, lane: 0 });
    expect(layout.rows[2]?.parent).toBeNull();
  });

  it("gives a branch from a non-tip its own lane and joins at the ancestor", () => {
    const commits = map(
      commit("cmt_1", null, t(0)),
      commit("cmt_2", "cmt_1", t(1)),
      commit("cmt_3", "cmt_1", t(2)),
    );
    const layout = layoutTree(commits, "cmt_3", { expanded: new Set() });

    expect(ids(layout.rows)).toEqual(["cmt_3", "cmt_2", "cmt_1"]);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 1, 0]);
    expect(layout.laneCount).toBe(2);
    expect(layout.rows[1]?.parent).toEqual({ row: 2, lane: 0 });
  });

  it("moves lane 0 to HEAD when HEAD sits on a side branch", () => {
    const commits = map(
      commit("cmt_1", null, t(0)),
      commit("cmt_2", "cmt_1", t(1)),
      commit("cmt_3", "cmt_1", t(2)),
      commit("cmt_4", "cmt_2", t(3)),
    );
    const layout = layoutTree(commits, "cmt_4", { expanded: new Set() });

    expect(ids(layout.rows)).toEqual(["cmt_4", "cmt_3", "cmt_2", "cmt_1"]);
    expect(layout.rows.map((row) => row.lane)).toEqual([0, 1, 0, 0]);
    expect(layout.rows[0]?.parent).toEqual({ row: 2, lane: 0 });
    expect(layout.rows[1]?.parent).toEqual({ row: 3, lane: 0 });
  });

  it("collapses a consecutive analysis run, but not the imported root", () => {
    const commits = map(
      commit("cmt_1", null, t(0), {
        label: "Imported",
        authorKind: "system",
      }),
      commit("cmt_2", "cmt_1", t(1), { label: "Analysis: rhythm", analysis: true }),
      commit("cmt_3", "cmt_2", t(2), { label: "Analysis: structure", analysis: true }),
      commit("cmt_4", "cmt_3", t(3), { label: "Mute Bass" }),
    );
    const layout = layoutTree(commits, "cmt_4", { expanded: new Set() });

    expect(ids(layout.rows)).toEqual(["cmt_4", "analysis:cmt_3", "cmt_1"]);
    const summary = layout.rows[1];
    expect(summary?.kind).toBe("analysis");
    if (summary?.kind !== "analysis") throw new Error("expected an analysis row");
    expect(summary.commits.map((entry) => entry.id)).toEqual(["cmt_3", "cmt_2"]);
    expect(summary.expanded).toBe(false);
    expect(layout.rows[0]?.parent).toEqual({ row: 1, lane: 0 });
    expect(summary.parent).toEqual({ row: 2, lane: 0 });
  });

  it("shows the stages below an expanded analysis row", () => {
    const commits = map(
      commit("cmt_1", null, t(0), { label: "Imported", authorKind: "system" }),
      commit("cmt_2", "cmt_1", t(1), { label: "Analysis: rhythm", analysis: true }),
      commit("cmt_3", "cmt_2", t(2), { label: "Analysis: structure", analysis: true }),
      commit("cmt_4", "cmt_3", t(3), { label: "Mute Bass" }),
    );
    const layout = layoutTree(commits, "cmt_4", { expanded: new Set(["cmt_3"]) });

    expect(ids(layout.rows)).toEqual(["cmt_4", "analysis:cmt_3", "cmt_3", "cmt_2", "cmt_1"]);
    const summary = layout.rows[1];
    if (summary?.kind !== "analysis") throw new Error("expected an analysis row");
    expect(summary.expanded).toBe(true);
    expect(layout.rows[2]?.depth).toBe(1);
    expect(layout.rows[3]?.depth).toBe(1);
    expect(layout.rows[0]?.parent).toEqual({ row: 2, lane: 0 });
    expect(layout.rows[2]?.parent).toEqual({ row: 3, lane: 0 });
    expect(layout.rows[3]?.parent).toEqual({ row: 4, lane: 0 });
    // The summary keeps the run's connection to the rest of the tree.
    expect(summary.parent).toEqual({ row: 4, lane: 0 });
  });

  it("keeps candidates and discarded versions, with their flags", () => {
    const commits = map(
      commit("cmt_1", null, t(0)),
      commit("cmt_2", "cmt_1", t(1), { state: "candidate" }),
      commit("cmt_3", "cmt_1", t(2), { state: "discarded" }),
    );
    const layout = layoutTree(commits, "cmt_1", {
      expanded: new Set(),
      starred: new Set(["cmt_3"]),
      branches: new Map([["Club version", "cmt_2"]]),
    });

    expect(byId(layout.rows, "cmt_2").commit.state).toBe("candidate");
    expect(byId(layout.rows, "cmt_3").commit.state).toBe("discarded");
    expect(byId(layout.rows, "cmt_3").starred).toBe(true);
    expect(byId(layout.rows, "cmt_2").branchNames).toEqual(["Club version"]);
    expect(byId(layout.rows, "cmt_1").isHead).toBe(true);
    expect(byId(layout.rows, "cmt_2").isHead).toBe(false);
  });

  it("orders equal timestamps deterministically by id", () => {
    const commits = map(
      commit("cmt_1", null, TIME),
      commit("cmt_2", "cmt_1", TIME),
      commit("cmt_3", "cmt_2", TIME),
    );
    const first = layoutTree(commits, "cmt_3", { expanded: new Set() });
    const second = layoutTree(commits, "cmt_3", { expanded: new Set() });

    expect(ids(first.rows)).toEqual(["cmt_3", "cmt_2", "cmt_1"]);
    expect(ids(second.rows)).toEqual(ids(first.rows));
  });
});
