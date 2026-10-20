/**
 * The version-tree store (02 §7; 07 §7): every document change is a commit in a
 * local DAG, and HEAD names the commit the editor is showing.
 *
 * It owns no document state. A commit runs through the Song Store first (the
 * only writer of the document), then stores the canonical snapshot and the
 * commit row. Undo, redo and checkout load the target commit's snapshot back
 * into the Song Store and return its `ApplyOutcome`, so callers forward
 * `outcome.commit` to the engine exactly as they do for an edit. The redo stack
 * is deliberately in memory; everything else is in the local database.
 */
import type { Platform } from "@bragi/platform";
import type { CommitState, OpBatch, Project, Region } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import { t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";
import type { ModelApi } from "../../song/model/model-api.js";
import type { ApplyOutcome, SongStore } from "../../song/state/song-store.js";
import {
  branchRef,
  deleteRef,
  getDeviceId,
  headRef,
  insertCommit,
  listCommits,
  listRefs,
  makeCommitId,
  mirrorProjectSnapshot,
  putCommitSnapshot,
  readCommitSnapshot,
  type StoredCommit,
  setCommitState,
  setRef,
  starRef,
} from "../api/history-repo.js";

/** The history state the panel and the shortcuts read. */
export interface HistoryState {
  /** Every commit of this project, by id. */
  readonly commits: ReadonlyMap<string, StoredCommit>;
  /** Commit ids by parent id, so the panel can draw branches without a query. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** The commit the editor is showing, or `null` before the first commit. */
  readonly head: string | null;
  /** Named branches (`branch:<name>`), name → commit. */
  readonly branches: ReadonlyMap<string, string>;
  /** Starred commit ids (`star:<commitId>`). */
  readonly starred: ReadonlySet<string>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The redo stack, oldest first. In memory by design. */
  readonly redo: readonly string[];
}

/** How a commit is labelled and whether it is a candidate (02 §7). */
export interface CommitOptions {
  readonly label?: string;
  readonly state?: CommitState;
  readonly candidateGroup?: string;
}

export interface History {
  readonly store: StoreApi<HistoryState>;
  /** This device's id (`dev_…`), available after {@link History.load}. */
  deviceId(): string | null;
  /** Reads commits and refs; creates the "Imported" root for a pre-2.1 project. */
  load(): Promise<void>;
  /**
   * Applies `batch`, stores a commit and moves HEAD. A rejected batch writes
   * nothing. `region.adopt` reads the source commits from their snapshots.
   */
  commit(batch: OpBatch, options?: CommitOptions): Promise<ApplyOutcome>;
  /**
   * Records a batch that was already applied (the analysis ingest that creates
   * the project row) as the root commit. Does not apply it again.
   */
  recordRoot(batch: OpBatch): Promise<StoredCommit | null>;
  /** Moves HEAD to the parent. Returns `null` when there is nothing to undo. */
  undo(): Promise<ApplyOutcome | null>;
  /** Moves HEAD back along the redo stack. Returns `null` when it is empty. */
  redo(): Promise<ApplyOutcome | null>;
  /** Moves HEAD to any committed commit and clears redo. */
  checkout(id: string): Promise<ApplyOutcome | null>;
  nameBranch(name: string, id?: string | null): Promise<void>;
  renameBranch(oldName: string, newName: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  star(id: string): Promise<void>;
  unstar(id: string): Promise<void>;
  /** Candidate commits for one AI request, all children of HEAD; HEAD does not move. */
  addCandidates(batches: readonly OpBatch[], group: string): Promise<readonly StoredCommit[]>;
  /** Accepts one candidate: it becomes committed, HEAD moves, its siblings are discarded. */
  accept(id: string): Promise<ApplyOutcome | null>;
  /** Marks every candidate of a group discarded; HEAD does not move. */
  discardGroup(group: string): Promise<void>;
  /** "Take this part from…" (02 §5.4): copies `region` from an earlier commit. */
  adoptRegion(region: Region, fromCommit: string): Promise<ApplyOutcome>;
  /**
   * The saved document of a commit, or `null` when the row or its snapshot is gone. The history
   * panel uses this to compare section boundaries before adopting a region (07 §7).
   */
  readSnapshot(id: string): Promise<Project | null>;
}

export interface HistoryOptions {
  readonly platform: Platform;
  readonly songStore: SongStore;
  readonly model: ModelApi;
  readonly projectId: string;
  readonly now?: () => Date;
}

const EMPTY_STATE: HistoryState = {
  commits: new Map(),
  children: new Map(),
  head: null,
  branches: new Map(),
  starred: new Set(),
  canUndo: false,
  canRedo: false,
  redo: [],
};

/** The state before a project is loaded; also the fallback for components without a history. */
export const EMPTY_HISTORY_STATE: HistoryState = EMPTY_STATE;

/** Commit ids grouped by parent, oldest first within a parent. */
function indexChildren(commits: ReadonlyMap<string, StoredCommit>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const commit of commits.values()) {
    if (commit.parent === null) continue;
    const list = children.get(commit.parent) ?? [];
    list.push(commit.id);
    children.set(commit.parent, list);
  }
  return children;
}

function committedOnly(commits: ReadonlyMap<string, StoredCommit>): StoredCommit[] {
  return [...commits.values()].filter((commit) => commit.state === "committed");
}

/** The root batch for a project created before WP-2.1 (02 §7). */
function importedBatch(project: Project): OpBatch {
  return {
    // Deterministic so two racing loads create the same root commit id.
    id: "bat_imported",
    author: { kind: "system", reason: "import" },
    label: t("history.imported"),
    // The schema wants at least one op; a root snapshot of an imported
    // document runs none, so the empty tuple is exact here.
    ops: [] as unknown as OpBatch["ops"],
    createdAt: project.meta.createdAt,
  };
}

/** Creates the history store for one project. Call {@link History.load} before reading it. */
export function createHistory(options: HistoryOptions): History {
  const { platform, songStore, model, projectId } = options;
  const now = options.now ?? (() => new Date());
  const db = platform.localDb;
  const store = createStore<HistoryState>(() => EMPTY_STATE);

  let deviceId: string | null = null;
  let loaded = false;
  let loading: Promise<void> | null = null;
  /** The last `created_at` written, so commits created in one tick still order. */
  let lastCreatedAt = 0;

  const view = (): HistoryState => store.getState();

  /** The tail of the operation queue: see {@link serial}. */
  let tail: Promise<unknown> = Promise.resolve();

  /**
   * Runs `task` after every operation queued before it.
   *
   * Every operation reads HEAD and the live document and then awaits storage, so two
   * overlapping ones (a slider release and a shortcut, or an analysis stage landing during an
   * edit) would both take the same parent and snapshot each other's changes. Queuing keeps the
   * apply order equal to the call order and every parent exact.
   */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  }

  /**
   * The next ISO timestamp. The clock can be coarse or fixed (tests inject one),
   * and the panel orders by `created_at`; this keeps siblings in insertion order.
   */
  function timestamp(): string {
    lastCreatedAt = Math.max(now().getTime(), lastCreatedAt + 1);
    return new Date(lastCreatedAt).toISOString();
  }

  function publish(patch: Partial<HistoryState>): void {
    store.setState(patch);
  }

  function replaceCommits(commits: Map<string, StoredCommit>): void {
    publish({ commits, children: indexChildren(commits) });
  }

  async function moveHead(commit: StoredCommit, redo: readonly string[]): Promise<void> {
    await setRef(db, projectId, headRef(deviceId as string), commit.id, now());
    await mirrorProjectSnapshot(db, projectId, commit.snapshotHash, now());
    publish({
      head: commit.id,
      redo,
      canUndo: commit.parent !== null,
      canRedo: redo.length > 0,
    });
  }

  /** Loads a commit's snapshot into the Song Store; `null` when the snapshot is gone. */
  async function checkOutCommit(commit: StoredCommit): Promise<ApplyOutcome | null> {
    const project = await readCommitSnapshot(platform, commit.snapshotHash);
    return songStore.checkout(project);
  }

  async function openCommitHandles(batch: OpBatch): Promise<Record<string, number>> {
    const handles: Record<string, number> = {};
    for (const op of batch.ops) {
      if (op.op !== "region.adopt" || handles[op.fromCommit] !== undefined) continue;
      const source = view().commits.get(op.fromCommit);
      // An unknown commit is left out on purpose: the model then rejects the
      // batch with its own `unknown_commit` error (02 §5.4).
      if (source === undefined) continue;
      const project = await readCommitSnapshot(platform, source.snapshotHash);
      handles[op.fromCommit] = model.loadProject(JSON.stringify(project));
    }
    return handles;
  }

  function freeHandles(handles: Readonly<Record<string, number>>): void {
    for (const handle of Object.values(handles)) model.freeDoc(handle);
  }

  /** Snapshots the live handle and inserts the commit row. */
  async function storeCommit(batch: OpBatch, options: CommitOptions): Promise<StoredCommit> {
    const handle = songStore.handle();
    if (handle === null) throw new Error("cannot commit without a document");
    const { hash } = await putCommitSnapshot(platform, model, handle);
    const parent = view().head;
    const state = options.state ?? "committed";
    const commit: StoredCommit = {
      id: makeCommitId(model, parent, batch, hash),
      projectId,
      parent,
      batch,
      label: options.label ?? batch.label,
      authorKind: batch.author.kind,
      snapshotHash: hash,
      state,
      candidateGroup: options.candidateGroup ?? null,
      deviceId: deviceId as string,
      createdAt: timestamp(),
      seq: null,
    };
    const committed = state === "committed";
    await insertCommit(db, commit, { mirrorProject: committed });

    const commits = new Map(view().commits);
    commits.set(commit.id, commit);
    replaceCommits(commits);
    if (committed) {
      await setRef(db, projectId, headRef(deviceId as string), commit.id, now());
      publish({ head: commit.id, redo: [], canUndo: parent !== null, canRedo: false });
    }
    return commit;
  }

  async function ensureLoaded(createRoot: boolean): Promise<void> {
    if (loaded) return;
    loading ??= (async () => {
      const [rows, refs, id] = await Promise.all([
        listCommits(db, projectId),
        listRefs(db, projectId),
        getDeviceId(db),
      ]);
      deviceId = id;
      const commits = new Map(rows.map((commit) => [commit.id, commit]));
      for (const commit of commits.values()) {
        lastCreatedAt = Math.max(lastCreatedAt, Date.parse(commit.createdAt) || 0);
      }
      const branches = new Map<string, string>();
      const starred = new Set<string>();
      for (const ref of refs) {
        if (ref.name.startsWith("branch:")) {
          branches.set(ref.name.slice("branch:".length), ref.commitId);
        } else if (ref.name.startsWith("star:")) {
          starred.add(ref.name.slice("star:".length));
        }
      }
      const headFromRef = refs.find((ref) => ref.name === headRef(id))?.commitId ?? null;
      const refCommit = headFromRef === null ? undefined : commits.get(headFromRef);
      const newest = committedOnly(commits).at(-1)?.id ?? null;
      // HEAD only ever names a committed commit; a ref left on a candidate or a
      // discarded branch (an interrupted accept) falls back to the newest.
      const head = refCommit?.state === "committed" ? refCommit.id : newest;
      loaded = true;
      publish({
        commits,
        children: indexChildren(commits),
        head,
        branches,
        starred,
        canUndo: head !== null && (commits.get(head)?.parent ?? null) !== null,
        canRedo: false,
        redo: [],
      });
      if (commits.size === 0 && createRoot) await createImportedRoot();
    })().finally(() => {
      loading = null;
    });
    await loading;
  }

  async function createImportedRoot(): Promise<void> {
    const project = songStore.store.getState().doc;
    const handle = songStore.handle();
    if (project === null || handle === null) return;
    const batch = importedBatch(project);
    const { hash } = await putCommitSnapshot(platform, model, handle);
    const commit: StoredCommit = {
      id: makeCommitId(model, null, batch, hash),
      projectId,
      parent: null,
      batch,
      label: batch.label,
      authorKind: "system",
      snapshotHash: hash,
      state: "committed",
      candidateGroup: null,
      deviceId: deviceId as string,
      createdAt: project.meta.createdAt,
      seq: null,
    };
    await insertCommit(db, commit, { mirrorProject: true });
    await setRef(db, projectId, headRef(deviceId as string), commit.id, now());
    lastCreatedAt = Math.max(lastCreatedAt, Date.parse(commit.createdAt) || 0);
    const commits = new Map(view().commits);
    commits.set(commit.id, commit);
    replaceCommits(commits);
    publish({ head: commit.id, canUndo: false, canRedo: false });
  }

  /** The operations themselves, unqueued; they call each other directly. */
  const direct: Omit<History, "store" | "deviceId"> = {
    async load() {
      await ensureLoaded(true);
    },

    async commit(batch, options = {}) {
      await ensureLoaded(true);
      const handles = await openCommitHandles(batch);
      let outcome: ApplyOutcome;
      try {
        outcome =
          Object.keys(handles).length > 0
            ? songStore.applyWith(batch, handles)
            : songStore.apply(batch);
      } finally {
        freeHandles(handles);
      }
      if (!outcome.ok) return outcome;
      await storeCommit(batch, options);
      return outcome;
    },

    async recordRoot(batch) {
      await ensureLoaded(false);
      const existing = [...view().commits.values()].find((commit) => commit.batch.id === batch.id);
      if (existing !== undefined) return existing;
      const handle = songStore.handle();
      if (handle === null) return null;
      const { hash } = await putCommitSnapshot(platform, model, handle);
      const commit: StoredCommit = {
        id: makeCommitId(model, null, batch, hash),
        projectId,
        parent: null,
        batch,
        label: batch.label,
        authorKind: batch.author.kind,
        snapshotHash: hash,
        state: "committed",
        candidateGroup: null,
        deviceId: deviceId as string,
        createdAt: timestamp(),
        seq: null,
      };
      await insertCommit(db, commit, { mirrorProject: true });
      await setRef(db, projectId, headRef(deviceId as string), commit.id, now());
      const commits = new Map(view().commits);
      commits.set(commit.id, commit);
      replaceCommits(commits);
      publish({ head: commit.id, redo: [], canUndo: false, canRedo: false });
      return commit;
    },

    async undo() {
      await ensureLoaded(true);
      const currentId = view().head;
      const current = currentId === null ? undefined : view().commits.get(currentId);
      const parentId = current?.parent ?? null;
      if (current === undefined || currentId === null || parentId === null) return null;
      const parent = view().commits.get(parentId);
      if (parent === undefined) return null;
      const outcome = await checkOutCommit(parent);
      if (outcome === null || !outcome.ok) return outcome;
      await moveHead(parent, [...view().redo, currentId]);
      return outcome;
    },

    async redo() {
      await ensureLoaded(true);
      const stack = view().redo;
      const id = stack.at(-1);
      if (id === undefined) return null;
      const commit = view().commits.get(id);
      if (commit === undefined) {
        publish({ redo: stack.slice(0, -1), canRedo: stack.length > 1 });
        return null;
      }
      const outcome = await checkOutCommit(commit);
      if (outcome === null || !outcome.ok) return outcome;
      const redo = stack.slice(0, -1);
      await moveHead(commit, redo);
      return outcome;
    },

    async checkout(id) {
      await ensureLoaded(true);
      const commit = view().commits.get(id);
      if (commit === undefined || commit.state !== "committed") return null;
      if (view().head === id) {
        publish({ redo: [], canRedo: false });
        return null;
      }
      const outcome = await checkOutCommit(commit);
      if (outcome === null || !outcome.ok) return outcome;
      await moveHead(commit, []);
      return outcome;
    },

    async nameBranch(name, id) {
      await ensureLoaded(true);
      const target = id ?? view().head;
      if (target === null) throw new Error("cannot name a branch without HEAD");
      const ref = branchRef(name);
      await setRef(db, projectId, ref, target, now());
      const branches = new Map(view().branches);
      branches.set(ref.slice("branch:".length), target);
      publish({ branches });
    },

    async renameBranch(oldName, newName) {
      await ensureLoaded(true);
      const oldRef = branchRef(oldName);
      const target = view().branches.get(oldRef.slice("branch:".length));
      if (target === undefined) return;
      const newRef = branchRef(newName);
      await setRef(db, projectId, newRef, target, now());
      await deleteRef(db, projectId, oldRef);
      const branches = new Map(view().branches);
      branches.delete(oldRef.slice("branch:".length));
      branches.set(newRef.slice("branch:".length), target);
      publish({ branches });
    },

    async deleteBranch(name) {
      await ensureLoaded(true);
      const ref = branchRef(name);
      await deleteRef(db, projectId, ref);
      const branches = new Map(view().branches);
      branches.delete(ref.slice("branch:".length));
      publish({ branches });
    },

    async star(id) {
      await ensureLoaded(true);
      if (!view().commits.has(id)) return;
      await setRef(db, projectId, starRef(id), id, now());
      const starred = new Set(view().starred);
      starred.add(id);
      publish({ starred });
    },

    async unstar(id) {
      await ensureLoaded(true);
      await deleteRef(db, projectId, starRef(id));
      const starred = new Set(view().starred);
      starred.delete(id);
      publish({ starred });
    },

    async addCandidates(batches, group) {
      await ensureLoaded(true);
      const headId = view().head;
      const head = headId === null ? undefined : view().commits.get(headId);
      const base =
        head === undefined
          ? songStore.store.getState().doc
          : await readCommitSnapshot(platform, head.snapshotHash);
      if (base === null) throw new Error("cannot create candidates without a document");
      const assets = songStore.assets();
      const created: StoredCommit[] = [];
      for (const batch of batches) {
        const handles = await openCommitHandles(batch);
        const handle = model.loadProject(JSON.stringify(base));
        try {
          if (assets.length > 0) model.assetAdd(handle, JSON.stringify(assets));
          try {
            if (Object.keys(handles).length > 0) {
              model.applyBatchWith(handle, JSON.stringify(batch), JSON.stringify(handles));
            } else {
              model.applyBatch(handle, JSON.stringify(batch));
            }
          } catch (error) {
            throw new Error(
              `bragi-model rejected a candidate: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const { hash } = await putCommitSnapshot(platform, model, handle);
          const commit: StoredCommit = {
            id: makeCommitId(model, headId, batch, hash),
            projectId,
            parent: headId,
            batch,
            label: batch.label,
            authorKind: batch.author.kind,
            snapshotHash: hash,
            state: "candidate",
            candidateGroup: group,
            deviceId: deviceId as string,
            createdAt: timestamp(),
            seq: null,
          };
          await insertCommit(db, commit);
          created.push(commit);
        } finally {
          model.freeDoc(handle);
          freeHandles(handles);
        }
      }
      const commits = new Map(view().commits);
      for (const commit of created) commits.set(commit.id, commit);
      replaceCommits(commits);
      return created;
    },

    async accept(id) {
      await ensureLoaded(true);
      const commit = view().commits.get(id);
      if (commit === undefined || commit.state !== "candidate") return null;
      const outcome = await checkOutCommit(commit);
      if (outcome === null || !outcome.ok) return outcome;
      const group = commit.candidateGroup;
      const siblings =
        group === null
          ? []
          : [...view().commits.values()].filter(
              (candidate) =>
                candidate.id !== id &&
                candidate.state === "candidate" &&
                candidate.candidateGroup === group,
            );
      await setCommitState(db, [id], "committed");
      if (siblings.length > 0) {
        await setCommitState(
          db,
          siblings.map((candidate) => candidate.id),
          "discarded",
        );
      }
      const commits = new Map(view().commits);
      commits.set(id, { ...commit, state: "committed" });
      for (const sibling of siblings) {
        commits.set(sibling.id, { ...sibling, state: "discarded" });
      }
      replaceCommits(commits);
      await moveHead({ ...commit, state: "committed" }, []);
      return outcome;
    },

    async discardGroup(group) {
      await ensureLoaded(true);
      const discarded = [...view().commits.values()].filter(
        (commit) => commit.state === "candidate" && commit.candidateGroup === group,
      );
      await setCommitState(
        db,
        discarded.map((commit) => commit.id),
        "discarded",
      );
      const commits = new Map(view().commits);
      for (const commit of discarded) commits.set(commit.id, { ...commit, state: "discarded" });
      replaceCommits(commits);
    },

    async adoptRegion(region, fromCommit) {
      await ensureLoaded(true);
      const source = view().commits.get(fromCommit);
      if (source === undefined) throw new Error(`unknown commit ${fromCommit}`);
      const batch: OpBatch = {
        id: `bat_${ulid()}`,
        author: { kind: "user" },
        label: t("history.adoptFrom", { label: source.label }),
        ops: [{ op: "region.adopt", fromCommit, region }],
        createdAt: timestamp(),
      };
      return direct.commit(batch);
    },

    async readSnapshot(id) {
      await ensureLoaded(false);
      const commit = view().commits.get(id);
      if (commit === undefined) return null;
      try {
        return await readCommitSnapshot(platform, commit.snapshotHash);
      } catch {
        return null;
      }
    },
  };

  return {
    store,
    deviceId: () => deviceId,
    load: () => serial(() => direct.load()),
    commit: (batch, options) => serial(() => direct.commit(batch, options)),
    recordRoot: (batch) => serial(() => direct.recordRoot(batch)),
    undo: () => serial(() => direct.undo()),
    redo: () => serial(() => direct.redo()),
    checkout: (id) => serial(() => direct.checkout(id)),
    nameBranch: (name, id) => serial(() => direct.nameBranch(name, id)),
    renameBranch: (oldName, newName) => serial(() => direct.renameBranch(oldName, newName)),
    deleteBranch: (name) => serial(() => direct.deleteBranch(name)),
    star: (id) => serial(() => direct.star(id)),
    unstar: (id) => serial(() => direct.unstar(id)),
    addCandidates: (batches, group) => serial(() => direct.addCandidates(batches, group)),
    accept: (id) => serial(() => direct.accept(id)),
    discardGroup: (group) => serial(() => direct.discardGroup(group)),
    adoptRegion: (region, fromCommit) => serial(() => direct.adoptRegion(region, fromCommit)),
    readSnapshot: (id) => direct.readSnapshot(id),
  };
}

/**
 * Whether a region's section boundaries line up between two commits (07 §7).
 *
 * The region is matched by absolute ticks; when the docs share every section
 * boundary at or inside it, a copied region sounds where it did. A differing
 * boundary is what the UI warns about.
 */
export function regionBoundariesAlign(
  model: ModelApi,
  docA: Project,
  docB: Project,
  region: Region,
): boolean {
  const boundaries = (project: Project): number[] => {
    const handle = model.loadProject(JSON.stringify(project));
    try {
      const spans = JSON.parse(model.sectionSpans(handle)) as {
        startTick: number;
        endTick: number;
      }[];
      return spans.flatMap((span) => [span.startTick, span.endTick]);
    } finally {
      model.freeDoc(handle);
    }
  };
  const within = (values: readonly number[]): number[] =>
    [...new Set(values)]
      .filter((tick) => tick >= region.startTick && tick <= region.endTick)
      .sort((a, b) => a - b);
  const a = within(boundaries(docA));
  const b = within(boundaries(docB));
  return a.length === b.length && a.every((tick, index) => tick === b[index]);
}
