/**
 * Shared fixtures for the history panel tests and the 1 000-version performance check.
 *
 * The panel only reads the Zustand store through {@link History.store}; the fake keeps the same
 * contract while replacing the database and model work with in-memory maps. Checkout, adopt, star
 * and naming still mutate that store, so the same assertions a real store would satisfy work here.
 */
import type { OpBatch, Project, Region } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ApplyOutcome } from "../../song/state/song-store.js";
import type { StoredCommit } from "../api/history-repo.js";
import type { History, HistoryState } from "../state/history.js";

/**
 * jsdom lacks the pointer and observer APIs Radix's menu touches; `@bragi/design` has a setup
 * file for this, but `packages/app` runs Vitest with its defaults, so the stubs live next to the
 * fixtures that need them.
 */
if (!("hasPointerCapture" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    writable: true,
    configurable: true,
    value: () => true,
  });
}
for (const method of ["setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, {
      writable: true,
      configurable: true,
      value: () => {},
    });
  }
}
if (!("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    writable: true,
    configurable: true,
    value: () => {},
  });
}
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  });
}

export const FIXTURE_PROJECT = "prj_PANEL00000000000000001";
export const FIXTURE_TIME = "2026-10-19T12:00:00.000Z";

function syntheticBatch(id: string, label: string, analysis: boolean): OpBatch {
  return {
    id,
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
    createdAt: FIXTURE_TIME,
  };
}

export interface CommitInput {
  readonly id: string;
  readonly parent: string | null;
  readonly label: string;
  readonly createdAt: string;
  readonly analysis?: boolean;
  readonly state?: StoredCommit["state"];
  readonly authorKind?: StoredCommit["authorKind"];
  readonly candidateGroup?: string;
}

export function makeCommit(input: CommitInput): StoredCommit {
  const analysis = input.analysis ?? false;
  return {
    id: input.id,
    projectId: FIXTURE_PROJECT,
    parent: input.parent,
    batch: {
      ...syntheticBatch(`bat_${input.id.slice("cmt_".length)}`, input.label, analysis),
      createdAt: input.createdAt,
    },
    label: input.label,
    authorKind: input.authorKind ?? (analysis ? "system" : "user"),
    snapshotHash: `sha256:${input.id}`,
    state: input.state ?? "committed",
    candidateGroup: input.candidateGroup ?? null,
    deviceId: "dev_test",
    createdAt: input.createdAt,
    seq: null,
  };
}

/** A commit clock in whole minutes after {@link FIXTURE_TIME}. */
export function minutesAfter(minutes: number): string {
  return new Date(Date.parse(FIXTURE_TIME) + minutes * 60_000).toISOString();
}

function indexChildren(commits: ReadonlyMap<string, StoredCommit>): Map<string, readonly string[]> {
  const children = new Map<string, string[]>();
  for (const commit of commits.values()) {
    if (commit.parent === null) continue;
    const list = children.get(commit.parent) ?? [];
    list.push(commit.id);
    children.set(commit.parent, list);
  }
  return children;
}

export function historyState(
  commits: readonly StoredCommit[],
  head: string | null,
  options: {
    readonly branches?: ReadonlyMap<string, string>;
    readonly starred?: ReadonlySet<string>;
  } = {},
): HistoryState {
  const byId = new Map(commits.map((commit) => [commit.id, commit]));
  return {
    commits: byId,
    children: indexChildren(byId),
    head,
    branches: options.branches ?? new Map(),
    starred: options.starred ?? new Set(),
    canUndo: head !== null && (byId.get(head)?.parent ?? null) !== null,
    canRedo: false,
    redo: [],
  };
}

export interface FakeHistory {
  readonly history: History;
  readonly store: StoreApi<HistoryState>;
  readonly calls: {
    readonly checkout: string[];
    readonly adopt: Array<{ readonly region: Region; readonly fromCommit: string }>;
    readonly star: string[];
    readonly unstar: string[];
    readonly nameBranch: Array<{ readonly name: string; readonly id: string | null }>;
  };
}

export interface FakeHistoryOptions {
  readonly commits: readonly StoredCommit[];
  readonly head: string | null;
  readonly liveDoc: Project;
  readonly branches?: ReadonlyMap<string, string>;
  readonly starred?: ReadonlySet<string>;
  /** The document {@link History.readSnapshot} returns per commit. */
  readonly docs?: ReadonlyMap<string, Project>;
}

function ok(doc: Project): ApplyOutcome {
  return {
    ok: true,
    doc,
    commit: { batch: null, delta: {}, revision: 1 },
  };
}

/** A History backed by an in-memory store; it implements every method the panel calls. */
export function fakeHistory(options: FakeHistoryOptions): FakeHistory {
  const state = historyState(options.commits, options.head, {
    ...(options.branches === undefined ? {} : { branches: options.branches }),
    ...(options.starred === undefined ? {} : { starred: options.starred }),
  });
  const store = createStore<HistoryState>(() => state);
  const docs = new Map(options.docs ?? []);
  const calls: FakeHistory["calls"] = {
    checkout: [],
    adopt: [],
    star: [],
    unstar: [],
    nameBranch: [],
  };
  const current = (): HistoryState => store.getState();
  const commitById = (id: string): StoredCommit | undefined => current().commits.get(id);

  const history: History = {
    store,
    deviceId: () => "dev_test",
    load: async () => {},
    commit: async () => {
      throw new Error("commit is not used by the panel tests");
    },
    recordRoot: async () => null,
    undo: async () => null,
    redo: async () => null,
    checkout: async (id) => {
      calls.checkout.push(id);
      const commit = commitById(id);
      if (commit === undefined || commit.state !== "committed") return null;
      store.setState({ head: id, canUndo: commit.parent !== null, redo: [], canRedo: false });
      return ok(options.liveDoc);
    },
    nameBranch: async (name, id) => {
      const target = id ?? current().head;
      calls.nameBranch.push({ name, id: target });
      if (target === null) throw new Error("no HEAD");
      const branches = new Map(current().branches);
      branches.set(name.trim(), target);
      store.setState({ branches });
    },
    renameBranch: async (oldName, newName) => {
      const target = current().branches.get(oldName);
      if (target === undefined) return;
      const branches = new Map(current().branches);
      branches.delete(oldName);
      branches.set(newName.trim(), target);
      store.setState({ branches });
    },
    deleteBranch: async (name) => {
      const branches = new Map(current().branches);
      branches.delete(name);
      store.setState({ branches });
    },
    star: async (id) => {
      calls.star.push(id);
      const starred = new Set(current().starred);
      starred.add(id);
      store.setState({ starred });
    },
    unstar: async (id) => {
      calls.unstar.push(id);
      const starred = new Set(current().starred);
      starred.delete(id);
      store.setState({ starred });
    },
    addCandidates: async () => [],
    accept: async () => null,
    discardGroup: async () => {},
    adoptRegion: async (region, fromCommit) => {
      calls.adopt.push({ region, fromCommit });
      return ok(options.liveDoc);
    },
    readSnapshot: async (id) => docs.get(id) ?? options.liveDoc,
  };

  return { history, store, calls };
}
