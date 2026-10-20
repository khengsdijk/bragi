/**
 * A drag or slider gesture: live preview while it runs, one commit when it ends (01 §5, 07 §4).
 *
 * Each step goes to the Song Store's preview copy, and its delta to the engine, so the canvas and
 * the audio follow the gesture while the document stays as it was. A gesture that is really a
 * series of whole-state previews (a paint stroke) calls {@link Gesture.replace} instead: the copy
 * is rebuilt from the live document and the engine gets one delta from the previous preview to
 * the new one. `commit` folds the steps into one batch (`coalesceBatches`) and commits it through
 * the history store; the batch reuses the steps' ids, so an effect a preview created keeps its
 * live instance and tail.
 */
import type { OpBatch, Project } from "@bragi/schemas";

import type { ApplyOutcome, Commit, SongStore } from "../../song/state/song-store.js";
import { coalesceBatches } from "./coalesce.js";
import type { History } from "./history.js";

export interface GestureOptions {
  readonly songStore: SongStore;
  /** The commit sink (the history store in the app, or a direct apply in the demo). */
  readonly history: Pick<History, "commit">;
  /** Where engine deltas go: the workspace's `EngineController.commit`. */
  readonly engine: (commit: Commit, doc: Project) => void;
  readonly now?: () => Date;
}

export interface Gesture {
  /** Previews `batch` on top of the earlier steps. A rejected step changes nothing. */
  step(batch: OpBatch): ApplyOutcome;
  /**
   * Replaces the earlier steps with just `batch`. The preview rebuilds the copy from the live
   * document, and the engine gets one delta from the old preview state to the new one, so it
   * never hears a revert first. A rejected batch leaves the preview and the engine untouched.
   */
  replace(batch: OpBatch): ApplyOutcome;
  /**
   * Commits the steps as one batch labelled `label`. Returns `null` when the gesture changed
   * nothing (a drag back to where it started), which records no commit.
   */
  commit(label: string): Promise<ApplyOutcome | null>;
  /** Drops the steps and returns the engine to the document. */
  cancel(): void;
}

/** Starts a gesture on the current document; `null` before one is loaded. */
export function startGesture(options: GestureOptions): Gesture | null {
  const { songStore, history, engine } = options;
  const preview = songStore.beginPreview();
  if (preview === null) return null;
  const steps: OpBatch[] = [];
  let open = true;

  /** Sends the engine back from the preview to the live document. */
  const revert = (): void => {
    const delta = preview.end();
    const { doc, revision } = songStore.store.getState();
    if (doc !== null) engine({ batch: null, delta, revision }, doc);
  };

  return {
    step(batch) {
      if (!open) {
        return { ok: false, errors: [{ opIndex: 0, code: "gesture_ended", message: "ended" }] };
      }
      const outcome = preview.apply(batch);
      if (outcome.ok) {
        steps.push(batch);
        engine(outcome.commit, outcome.doc);
      }
      return outcome;
    },
    replace(batch) {
      if (!open) {
        return { ok: false, errors: [{ opIndex: 0, code: "gesture_ended", message: "ended" }] };
      }
      const outcome = preview.reset(batch);
      if (outcome.ok) {
        steps.length = 0;
        steps.push(batch);
        engine(outcome.commit, outcome.doc);
      }
      return outcome;
    },
    async commit(label) {
      if (!open) return null;
      open = false;
      const batch = coalesceBatches(steps, label, options.now?.());
      if (batch === null || !preview.changed()) {
        revert();
        return null;
      }
      // The engine already plays the preview. The commit's delta carries absolute track and
      // section states, so it takes the engine to the same place; `back` is only for a rejection.
      const back = preview.end();
      const outcome = await history.commit(batch);
      if (outcome.ok) {
        engine(outcome.commit, outcome.doc);
      } else {
        const { doc, revision } = songStore.store.getState();
        if (doc !== null) engine({ batch: null, delta: back, revision }, doc);
      }
      return outcome;
    },
    cancel() {
      if (!open) return;
      open = false;
      revert();
    },
  };
}
