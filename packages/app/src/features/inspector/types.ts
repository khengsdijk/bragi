/**
 * The small edit surface the Inspector's controls share.
 *
 * A slider reports every step while it moves and the final value when it settles. Pointer drags
 * become one gesture (preview + one commit); a keyboard step has no drag and is committed as one
 * edit immediately. Both paths end in the same document change.
 */
import type { OpBatch, Project } from "@bragi/schemas";

/** Builds the batch for `value` from the document the control is reading (preview or live). */
export type BatchBuilder = (doc: Project) => OpBatch | null;

export interface GestureEdit {
  /** A drag step while a gesture runs. Starts the gesture on the first step. */
  step(value: number, build: BatchBuilder): void;
  /** The final value; a drag commits once, a keyboard step commits directly. */
  finish(value: number, build: BatchBuilder): void;
}
