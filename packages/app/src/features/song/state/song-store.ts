/**
 * The Song Store (01 §5, 13 §3): a Zustand store around a `bragi-model` handle.
 *
 * It is the **only** place a song document changes. UI code builds an {@link OpBatch}, calls
 * {@link SongStore.apply}, and gets back the new document plus the engine delta (`diffDocs`);
 * nothing in TypeScript edits the document object. A rejected batch leaves the document exactly
 * as it was and returns the model's structured errors.
 *
 * State is a plain parsed copy of the document for rendering and for the accessible grid; it is
 * replaced, never mutated, so selectors can compare by reference.
 *
 * Drags never mutate the document (01 §5): {@link SongStore.beginPreview} applies a gesture's steps
 * to a copy, which views render (`preview ?? doc`) and the engine follows, until the gesture
 * commits one batch through the history store or is cancelled.
 */
import type { AssetMeta, OpBatch, Project } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { ModelApi } from "../model/model-api.js";

/** One entry of the array `bragi-model` throws when it rejects a batch (02 §4.3). */
export interface ModelError {
  readonly opIndex: number;
  readonly code: string;
  readonly message: string;
}

/** The change set the engine needs (`bragi_model::EngineDelta`). */
export type EngineDeltaJson = Readonly<Record<string, unknown>>;

export interface Commit {
  /** The batch that produced the document; `null` after a checkout, which runs no ops. */
  readonly batch: OpBatch | null;
  readonly delta: EngineDeltaJson;
  /** The store revision this commit produced. */
  readonly revision: number;
}

export interface SongState {
  /** The current document, or `null` before one is loaded. */
  readonly doc: Project | null;
  /** Counts loads and commits; a cheap "did it change" key. */
  readonly revision: number;
  /** The last applied batch, for the engine bridge and the live region. */
  readonly lastCommit: Commit | null;
  /** The document with a running gesture's uncommitted steps, or `null` when none runs. */
  readonly preview: Project | null;
}

export type ApplyOutcome =
  | { readonly ok: true; readonly doc: Project; readonly commit: Commit }
  | { readonly ok: false; readonly errors: readonly ModelError[] };

/** A running gesture's copy of the document (01 §5). */
export interface Preview {
  /**
   * Applies `batch` on top of the earlier steps. The live document does not change; the
   * outcome's delta takes the engine from the previous step to this one.
   */
  apply(batch: OpBatch): ApplyOutcome;
  /** Whether the copy differs from the live document. */
  changed(): boolean;
  /**
   * Frees the copy and clears `preview`. Returns the delta from the copy back to the live
   * document, for an engine that followed the preview and must return (a cancelled gesture).
   */
  end(): EngineDeltaJson;
}

export interface SongStore {
  readonly store: StoreApi<SongState>;
  /** The model API, so view-model builders can ask the tempo map. */
  readonly model: ModelApi;
  /** The live model handle; valid until {@link SongStore.dispose}. `null` before `load`. */
  handle(): number | null;
  /** Replaces the document (project open). */
  load(project: Project, assets?: readonly AssetMeta[]): void;
  /**
   * Adds metadata for assets an analysis stage introduces (the stems, the
   * residual). `analysis.apply` needs it to validate clip ranges against the
   * asset's length (02 §6).
   */
  addAssets(assets: readonly AssetMeta[]): void;
  /** The asset metadata the live handle validates clips against. */
  assets(): readonly AssetMeta[];
  /** Applies an op batch atomically. */
  apply(batch: OpBatch): ApplyOutcome;
  /**
   * Applies a batch whose ops may read other commits (`region.adopt`), given a
   * `cmt_… → model handle` map (02 §5.4).
   */
  applyWith(batch: OpBatch, commitHandles: Readonly<Record<string, number>>): ApplyOutcome;
  /**
   * Replaces the document without freeing the asset index and returns the
   * engine delta between the old and new documents. Used by history checkout.
   */
  checkout(project: Project): ApplyOutcome;
  /**
   * Starts a preview on a copy of the live document; `null` before `load`. Ends a preview that
   * is still running first: one gesture at a time.
   */
  beginPreview(): Preview | null;
  /** Frees the model handle. */
  dispose(): void;
}

function parseErrors(error: unknown): readonly ModelError[] {
  const text = error instanceof Error ? error.message : String(error);
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((entry: Partial<ModelError>) => ({
        opIndex: entry.opIndex ?? 0,
        code: entry.code ?? "unknown",
        message: entry.message ?? text,
      }));
    }
  } catch {
    // Not the model's JSON error array: report the raw message below.
  }
  return [{ opIndex: 0, code: "unknown", message: text }];
}

/** Creates a Song Store over `model`. */
export function createSongStore(model: ModelApi): SongStore {
  const store = createStore<SongState>(() => ({
    doc: null,
    revision: 0,
    lastCommit: null,
    preview: null,
  }));
  let handle: number | null = null;
  let assetMetas: readonly AssetMeta[] = [];
  let endPreview: (() => EngineDeltaJson) | null = null;

  /** A second handle holding the same document and asset index as `source`. */
  const copyOf = (source: number): number => {
    const copy = model.loadProject(model.documentJson(source));
    if (assetMetas.length > 0) model.assetAdd(copy, JSON.stringify(assetMetas));
    return copy;
  };

  const free = (): void => {
    if (handle !== null) model.freeDoc(handle);
    handle = null;
  };

  /** Applies `batch` to the live handle and turns the change into an outcome. */
  const run = (
    batch: OpBatch,
    commitHandles: Readonly<Record<string, number>> | null,
  ): ApplyOutcome => {
    if (handle === null) {
      return { ok: false, errors: [{ opIndex: 0, code: "no_document", message: "no document" }] };
    }
    // A second handle on the same document is the "before" side of the diff.
    const before = copyOf(handle);
    try {
      let nextJson: string;
      try {
        nextJson =
          commitHandles === null
            ? model.applyBatch(handle, JSON.stringify(batch))
            : model.applyBatchWith(handle, JSON.stringify(batch), JSON.stringify(commitHandles));
      } catch (error) {
        return { ok: false, errors: parseErrors(error) };
      }
      const delta = JSON.parse(model.diffDocs(before, handle)) as EngineDeltaJson;
      const doc = JSON.parse(nextJson) as Project;
      const revision = store.getState().revision + 1;
      const commit: Commit = { batch, delta, revision };
      store.setState({ doc, revision, lastCommit: commit });
      return { ok: true, doc, commit };
    } finally {
      model.freeDoc(before);
    }
  };

  return {
    store,
    model,
    handle: () => handle,
    assets: () => assetMetas,
    load(project, assets = []) {
      free();
      assetMetas = assets;
      handle = model.loadProject(JSON.stringify(project));
      if (assets.length > 0) model.assetAdd(handle, JSON.stringify(assets));
      store.setState((state) => ({
        doc: JSON.parse(model.documentJson(handle as number)) as Project,
        revision: state.revision + 1,
        lastCommit: null,
      }));
    },
    addAssets(assets) {
      if (handle === null) return;
      const known = new Set(assetMetas.map((asset) => asset.hash));
      const fresh = assets.filter((asset) => !known.has(asset.hash));
      if (fresh.length === 0) return;
      model.assetAdd(handle, JSON.stringify(fresh));
      assetMetas = [...assetMetas, ...fresh];
    },
    apply(batch) {
      return run(batch, null);
    },
    applyWith(batch, commitHandles) {
      return run(batch, commitHandles);
    },
    checkout(project) {
      if (handle === null) {
        // No previous document: behave like `load`, with an empty delta.
        handle = model.loadProject(JSON.stringify(project));
        if (assetMetas.length > 0) model.assetAdd(handle, JSON.stringify(assetMetas));
        const doc = JSON.parse(model.documentJson(handle)) as Project;
        const revision = store.getState().revision + 1;
        const commit: Commit = { batch: null, delta: {}, revision };
        store.setState({ doc, revision, lastCommit: commit });
        return { ok: true, doc, commit };
      }
      const before = model.loadProject(model.documentJson(handle));
      let next: number | null = null;
      try {
        // Load first, then swap: a malformed snapshot leaves the old document intact.
        next = model.loadProject(JSON.stringify(project));
        if (assetMetas.length > 0) model.assetAdd(next, JSON.stringify(assetMetas));
        const delta = JSON.parse(model.diffDocs(before, next)) as EngineDeltaJson;
        model.freeDoc(handle);
        handle = next;
        next = null;
        const doc = JSON.parse(model.documentJson(handle)) as Project;
        const revision = store.getState().revision + 1;
        const commit: Commit = { batch: null, delta, revision };
        store.setState({ doc, revision, lastCommit: commit });
        return { ok: true, doc, commit };
      } finally {
        model.freeDoc(before);
        if (next !== null) model.freeDoc(next);
      }
    },
    beginPreview() {
      endPreview?.();
      if (handle === null) return null;
      let copy: number | null = copyOf(handle);
      const end = (): EngineDeltaJson => {
        if (copy === null) return {};
        const delta =
          handle === null ? {} : (JSON.parse(model.diffDocs(copy, handle)) as EngineDeltaJson);
        model.freeDoc(copy);
        copy = null;
        if (endPreview === end) endPreview = null;
        store.setState({ preview: null });
        return delta;
      };
      endPreview = end;
      return {
        apply(batch) {
          if (copy === null) {
            return { ok: false, errors: [{ opIndex: 0, code: "no_preview", message: "ended" }] };
          }
          const before = copyOf(copy);
          try {
            let nextJson: string;
            try {
              nextJson = model.applyBatch(copy, JSON.stringify(batch));
            } catch (error) {
              return { ok: false, errors: parseErrors(error) };
            }
            const delta = JSON.parse(model.diffDocs(before, copy)) as EngineDeltaJson;
            const doc = JSON.parse(nextJson) as Project;
            store.setState({ preview: doc });
            return { ok: true, doc, commit: { batch, delta, revision: store.getState().revision } };
          } finally {
            model.freeDoc(before);
          }
        },
        changed() {
          if (copy === null || handle === null) return false;
          return model.canonicalJson(copy) !== model.canonicalJson(handle);
        },
        end,
      };
    },
    dispose() {
      endPreview?.();
      free();
      store.setState({ doc: null, lastCommit: null });
    },
  };
}
