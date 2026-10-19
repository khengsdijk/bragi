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
  readonly batch: OpBatch;
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
}

export type ApplyOutcome =
  | { readonly ok: true; readonly doc: Project; readonly commit: Commit }
  | { readonly ok: false; readonly errors: readonly ModelError[] };

export interface SongStore {
  readonly store: StoreApi<SongState>;
  /** The model API, so view-model builders can ask the tempo map. */
  readonly model: ModelApi;
  /** The live model handle; valid until {@link SongStore.dispose}. `null` before `load`. */
  handle(): number | null;
  /** Replaces the document (project open). */
  load(project: Project, assets?: readonly AssetMeta[]): void;
  /** Applies an op batch atomically. */
  apply(batch: OpBatch): ApplyOutcome;
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
  const store = createStore<SongState>(() => ({ doc: null, revision: 0, lastCommit: null }));
  let handle: number | null = null;
  let assetMetas: readonly AssetMeta[] = [];

  const free = (): void => {
    if (handle !== null) model.freeDoc(handle);
    handle = null;
  };

  return {
    store,
    model,
    handle: () => handle,
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
    apply(batch) {
      if (handle === null) {
        return { ok: false, errors: [{ opIndex: 0, code: "no_document", message: "no document" }] };
      }
      // A second handle on the same document is the "before" side of the diff.
      const before = model.loadProject(model.documentJson(handle));
      try {
        if (assetMetas.length > 0) model.assetAdd(before, JSON.stringify(assetMetas));
        let nextJson: string;
        try {
          nextJson = model.applyBatch(handle, JSON.stringify(batch));
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
    },
    dispose() {
      free();
      store.setState({ doc: null, lastCommit: null });
    },
  };
}
