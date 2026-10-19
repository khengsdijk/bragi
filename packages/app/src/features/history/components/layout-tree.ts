/**
 * Turns the commit DAG into the flat rows the history panel draws (07 §7).
 *
 * Rows are newest first, so a parent row always sits below its children. Each commit gets a lane:
 * the chain from HEAD back to the root is lane 0, every other branch tip takes the next free
 * lane, and a commit keeps its tip's lane until the chain meets an already-laned ancestor. The
 * panel draws one connector per row from the row to its parent, so graph facts stay in this pure
 * function and the React component only positions lines.
 *
 * A maximal run of consecutive analysis commits on one chain collapses into a single analysis
 * row. Expanding it keeps the summary row and shows the individual stages below it; that is what
 * gives the summary row its `aria-expanded` state. The "Imported" root is a `system` batch too,
 * but its reason is `import`, so it never joins an analysis run.
 */
import type { StoredCommit } from "../api/history-repo.js";

/** The parent edge a row draws: the row index (not the commit id) and the lane to join. */
export interface TreeParent {
  readonly row: number;
  readonly lane: number;
}

/** A single version. `depth` is 1 for a stage inside an expanded analysis run. */
export interface CommitTreeRow {
  readonly kind: "commit";
  readonly id: string;
  readonly commit: StoredCommit;
  readonly lane: number;
  readonly depth: number;
  readonly isHead: boolean;
  readonly branchNames: readonly string[];
  readonly starred: boolean;
  readonly parent: TreeParent | null;
}

/** One collapsed analysis run. `id` is the first (newest) commit of the run. */
export interface AnalysisTreeRow {
  readonly kind: "analysis";
  readonly id: string;
  readonly commits: readonly StoredCommit[];
  readonly lane: number;
  readonly depth: 0;
  readonly expanded: boolean;
  readonly isHead: boolean;
  readonly branchNames: readonly string[];
  readonly starred: boolean;
  readonly parent: TreeParent | null;
}

export type TreeRow = CommitTreeRow | AnalysisTreeRow;

export interface TreeLayout {
  readonly rows: readonly TreeRow[];
  /** One more than the highest lane in use; 0 for an empty history. */
  readonly laneCount: number;
}

export interface TreeLayoutOptions {
  /** Analysis runs whose first commit id is here are shown stage by stage. */
  readonly expanded: ReadonlySet<string>;
  /** The store's `branch:<name>` refs, name → commit. */
  readonly branches?: ReadonlyMap<string, string>;
  /** The store's `star:<commitId>` refs. */
  readonly starred?: ReadonlySet<string>;
}

interface Run {
  readonly id: string;
  readonly commits: readonly StoredCommit[];
}

/** Newest first, then id descending, so equal clock ticks still order deterministically. */
function newestFirst(a: StoredCommit, b: StoredCommit): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/** `analysis.apply` batches from the upload flow, not the `import` root (07 §7). */
function isAnalysisCommit(commit: StoredCommit): boolean {
  if (commit.authorKind !== "system") return false;
  if (commit.batch.author.kind === "system" && commit.batch.author.reason === "analysis") {
    return true;
  }
  return commit.batch.ops.some((op) => op.op === "analysis.apply");
}

/**
 * Assigns a lane to every commit in O(n).
 *
 * START at HEAD (or the newest tip when there is no HEAD), then give every remaining tip the next
 * free lane. Walking stops at the first already-laned ancestor, which is exactly where a branch
 * joins the trunk.
 */
function assignLanes(
  commits: ReadonlyMap<string, StoredCommit>,
  ordered: readonly StoredCommit[],
  head: string | null,
): { lanes: ReadonlyMap<string, number>; laneCount: number } {
  const lanes = new Map<string, number>();
  const parentOf = (id: string): string | null => commits.get(id)?.parent ?? null;

  const walk = (start: string, lane: number): void => {
    let current: string | null = start;
    while (current !== null && !lanes.has(current)) {
      if (!commits.has(current)) return;
      lanes.set(current, lane);
      current = parentOf(current);
    }
  };

  const hasHead = head !== null && commits.has(head);
  if (hasHead) walk(head, 0);

  // A tip has no child in the whole DAG, including candidates and discarded branches.
  const hasChild = new Set<string>();
  for (const commit of commits.values()) {
    if (commit.parent !== null) hasChild.add(commit.parent);
  }
  let nextLane = hasHead ? 1 : 0;
  for (const commit of ordered) {
    if (hasChild.has(commit.id) || lanes.has(commit.id)) continue;
    walk(commit.id, nextLane);
    nextLane += 1;
  }

  // A malformed row whose parent is missing would otherwise have no lane.
  for (const commit of ordered) {
    if (!lanes.has(commit.id)) {
      walk(commit.id, nextLane);
      nextLane += 1;
    }
  }

  let laneCount = 0;
  for (const lane of lanes.values()) laneCount = Math.max(laneCount, lane + 1);
  return { lanes, laneCount };
}

/**
 * Collects analysis-only chains. A commit belongs to one run; a branch in the middle of a run
 * splits it, which keeps every row honest about which parent it joins.
 */
function collectRuns(
  commits: ReadonlyMap<string, StoredCommit>,
  ordered: readonly StoredCommit[],
): { runOf: ReadonlyMap<string, Run>; runs: readonly Run[] } {
  const analysis = new Set(
    ordered.filter((commit) => isAnalysisCommit(commit)).map((commit) => commit.id),
  );
  const hasAnalysisChild = new Set<string>();
  for (const id of analysis) {
    const parent = commits.get(id)?.parent ?? null;
    if (parent !== null && analysis.has(parent)) hasAnalysisChild.add(parent);
  }

  const runOf = new Map<string, Run>();
  const runs: Run[] = [];
  const visited = new Set<string>();
  for (const commit of ordered) {
    if (!analysis.has(commit.id) || hasAnalysisChild.has(commit.id) || visited.has(commit.id)) {
      continue;
    }
    const members: StoredCommit[] = [];
    let current: StoredCommit | undefined = commit;
    while (current !== undefined && analysis.has(current.id) && !visited.has(current.id)) {
      members.push(current);
      visited.add(current.id);
      current = current.parent === null ? undefined : commits.get(current.parent);
    }
    if (members.length === 0) continue;
    const run: Run = { id: members[0]?.id ?? commit.id, commits: members };
    runs.push(run);
    for (const member of members) runOf.set(member.id, run);
  }
  return { runOf, runs };
}

/**
 * Lays out every commit, newest first.
 *
 * The output is a flat list because the panel virtualises it. `parent.row` indexes into `rows`,
 * not into `commits`, so a connector can point at the collapsed analysis summary that represents
 * an older stage.
 */
export function layoutTree(
  commits: ReadonlyMap<string, StoredCommit>,
  head: string | null,
  options: TreeLayoutOptions,
): TreeLayout {
  const ordered = [...commits.values()].sort(newestFirst);
  const { lanes, laneCount } = assignLanes(commits, ordered, head);
  const { runOf } = collectRuns(commits, ordered);

  const branchNames = new Map<string, string[]>();
  for (const [name, commitId] of options.branches ?? []) {
    const names = branchNames.get(commitId) ?? [];
    names.push(name);
    branchNames.set(commitId, names);
  }
  const starred = options.starred ?? new Set<string>();

  /** The row each commit is drawn in; analysis members share their summary when collapsed. */
  const rowOfCommit = new Map<string, number>();
  const pending: Array<{
    readonly row: CommitTreeRow | AnalysisTreeRow;
    readonly parentId: string | null;
  }> = [];
  const rows: TreeRow[] = [];

  const push = (row: CommitTreeRow | AnalysisTreeRow, parentId: string | null): void => {
    pending.push({ row, parentId });
    rows.push(row);
  };

  const emittedRuns = new Set<string>();
  for (const commit of ordered) {
    const run = runOf.get(commit.id);
    if (run !== undefined) {
      if (emittedRuns.has(run.id)) continue;
      emittedRuns.add(run.id);
      const lane = lanes.get(commit.id) ?? 0;
      const expanded = options.expanded.has(run.id);
      const names = run.commits.flatMap((member) => branchNames.get(member.id) ?? []);
      const index = rows.length;
      push(
        {
          kind: "analysis",
          id: run.id,
          commits: run.commits,
          lane,
          depth: 0,
          expanded,
          isHead: head !== null && run.commits.some((member) => member.id === head),
          branchNames: names,
          starred: run.commits.some((member) => starred.has(member.id)),
          parent: null,
        },
        run.commits.at(-1)?.parent ?? null,
      );
      for (const member of run.commits) rowOfCommit.set(member.id, index);
      if (expanded) {
        for (const member of run.commits) {
          const childIndex = rows.length;
          push(
            {
              kind: "commit",
              id: member.id,
              commit: member,
              lane: lanes.get(member.id) ?? lane,
              depth: 1,
              // The summary carries `aria-current` for the whole run; a second current row would
              // make the tree announce HEAD twice.
              isHead: false,
              branchNames: branchNames.get(member.id) ?? [],
              starred: starred.has(member.id),
              parent: null,
            },
            member.parent,
          );
          rowOfCommit.set(member.id, childIndex);
        }
      }
      continue;
    }

    const index = rows.length;
    push(
      {
        kind: "commit",
        id: commit.id,
        commit,
        lane: lanes.get(commit.id) ?? 0,
        depth: 0,
        isHead: commit.id === head,
        branchNames: branchNames.get(commit.id) ?? [],
        starred: starred.has(commit.id),
        parent: null,
      },
      commit.parent,
    );
    rowOfCommit.set(commit.id, index);
  }

  // Second pass: parent rows and lanes. A parent inside the same collapsed summary is a self-edge
  // and is not drawn.
  for (const [index, entry] of pending.entries()) {
    const parentRow = entry.parentId === null ? undefined : rowOfCommit.get(entry.parentId);
    if (parentRow === undefined || parentRow === index) continue;
    const parent = rows[parentRow];
    if (parent === undefined) continue;
    (entry.row as { parent: TreeParent | null }).parent = {
      row: parentRow,
      lane: parent.lane,
    };
  }

  return { rows, laneCount };
}
