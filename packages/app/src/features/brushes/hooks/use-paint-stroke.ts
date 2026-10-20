/**
 * The canvas paint tool's controller (07 §4.4, 01 §5): four pointer events in, one commit out.
 *
 * While the pointer is down the stroke is previewed on the Song Store's copy through one gesture;
 * the engine follows, but the document does not change. The first preview starts the gesture, and
 * every later one **replaces** it with a fresh `brushBatch` in a single delta, so a long stroke
 * never stacks brush steps and never sends the engine back to the document. The fx ids of each
 * preview are aligned with the previous one ({@link alignFxIds}), so a Space or Warmth instance
 * keeps playing its tail instead of being removed and re-added several times a second. The live
 * preview is refreshed at most every {@link PREVIEW_INTERVAL_MS}; the final batch is previewed and
 * committed on release on the same gesture, so exactly one history commit exists per stroke.
 * Escape or a cancelled pointer drops the preview and records nothing.
 */
import type { CanvasEvents } from "@bragi/render-canvas";
import type { OpBatch, Project } from "@bragi/schemas";
import { useCallback, useEffect, useRef } from "react";

import { t } from "../../../i18n/index.js";
import { type Gesture, startGesture } from "../../history/state/gesture.js";
import type { History } from "../../history/state/history.js";
import { ticksAtSeconds } from "../../song/api/section-time.js";
import type { ModelApi } from "../../song/model/model-api.js";
import type { EngineController } from "../../song/state/engine-controller.js";
import type { SongStore } from "../../song/state/song-store.js";
import { alignFxIds } from "../align.js";
import { brushBatch } from "../batches.js";
import type { BrushStore } from "../state/brush-store.js";
import { strokeRegion, strokeStrength } from "../stroke.js";
import type { PointerType, Stroke, StrokePoint } from "../types.js";

/** The live preview's refresh interval; the final stroke is always previewed on release. */
export const PREVIEW_INTERVAL_MS = 120;

/** Strength changes below this are the same preview (the plan's 0.05 rounding). */
const STRENGTH_STEP = 0.05;

export interface PaintStrokeOptions {
  readonly songStore: SongStore;
  readonly controller: EngineController;
  readonly model: ModelApi;
  readonly brushes: BrushStore;
  readonly history?: History;
  readonly onAnnounce: (message: string) => void;
  /** Injectable clock for the tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface PaintStrokeController {
  readonly onPaintStart: (event: CanvasEvents["paintStart"]) => void;
  readonly onPaintMove: (event: CanvasEvents["paintMove"]) => void;
  readonly onPaintEnd: (event: CanvasEvents["paintEnd"]) => void;
  readonly onPaintCancel: (event: CanvasEvents["paintCancel"]) => void;
}

interface Session {
  readonly preStrokeDoc: Project;
  readonly handle: number;
  readonly points: StrokePoint[];
  pointerType: PointerType;
  wheelDelta: number;
  gesture: Gesture | null;
  /** The aligned batch the preview shows now; the next one reuses its fx ids. */
  lastBatch: OpBatch | null;
  /** `region + rounded strength`; an unchanged key needs no new preview. */
  lastKey: string;
  lastPreviewAt: number;
}

function roundStrength(strength: number): number {
  return Math.round(strength / STRENGTH_STEP) * STRENGTH_STEP;
}

/** Whether two previews carry the same ops, so the release needs no extra replace. */
function sameOps(previous: OpBatch | null, next: OpBatch): boolean {
  return previous !== null && JSON.stringify(previous.ops) === JSON.stringify(next.ops);
}

export function usePaintStroke(options: PaintStrokeOptions): PaintStrokeController {
  const { songStore, controller, model, brushes, onAnnounce } = options;
  const now = options.now ?? (() => Date.now());
  const session = useRef<Session | null>(null);

  /** The gesture's commit sink: history in the app, a direct apply on the demo (as the Inspector). */
  const start = useCallback((): Gesture | null => {
    const commit =
      options.history?.commit ?? ((batch: OpBatch) => Promise.resolve(songStore.apply(batch)));
    return startGesture({
      songStore,
      history: { commit },
      engine: (value, doc) => controller.commit(value, doc),
    });
  }, [controller, options.history, songStore]);

  /** Appends the points the previous event did not carry, converting seconds to ticks once. */
  const absorb = useCallback(
    (active: Session, event: CanvasEvents["paintStart"]): void => {
      const convert = (point: CanvasEvents["paintStart"]["points"][number]): StrokePoint => ({
        tick: ticksAtSeconds(model, active.handle, point.sec),
        trackId: point.trackId,
        pressure: point.pressure,
      });
      const last = event.points.length - 1;
      if (last >= 0 && event.points.length === active.points.length) {
        // A pen resting in place updates only the last point's pressure (07 §4.4).
        const point = event.points[last];
        if (point !== undefined) active.points[last] = convert(point);
      } else {
        for (let index = active.points.length; index < event.points.length; index += 1) {
          const point = event.points[index];
          if (point !== undefined) active.points.push(convert(point));
        }
      }
      active.wheelDelta = event.wheelDelta;
      active.pointerType = event.pointerType;
    },
    [model],
  );

  const strokeOf = useCallback(
    (active: Session): Stroke => {
      const state = brushes.store.getState();
      return {
        points: [...active.points],
        wheelDelta: active.wheelDelta,
        sizeStrength: state.sizeStrength,
        pointerType: active.pointerType,
      };
    },
    [brushes],
  );

  /**
   * Previews the stroke: the first batch starts the gesture, every later one replaces it.
   *
   * Replacing (rather than cancelling and starting again) keeps the engine on one plan, and
   * {@link alignFxIds} keeps the fx instances the first preview created (03 §6).
   */
  const preview = useCallback(
    (active: Session, force: boolean): void => {
      const stroke = strokeOf(active);
      const region = strokeRegion(stroke);
      if (region === null) return;
      const strength = strokeStrength(stroke);
      const tracks = region.tracks === "all" ? "*" : region.tracks.join(",");
      const key = `${region.startTick}:${region.endTick}:${tracks}:${roundStrength(strength)}`;
      if (!force && key === active.lastKey) return;
      const timestamp = now();
      if (!force && timestamp - active.lastPreviewAt < PREVIEW_INTERVAL_MS) return;
      active.lastKey = key;
      active.lastPreviewAt = timestamp;

      const state = brushes.store.getState();
      const built = brushBatch(
        active.preStrokeDoc,
        state.brush,
        {
          region,
          strength,
          ...(state.brush === "filterSweep" ? { direction: state.direction } : {}),
        },
        model,
      );
      const batch = built === null ? null : alignFxIds(built, active.lastBatch);
      if (batch === null) {
        // Nothing to paint right now (for example zero strength): drop the preview, but keep
        // `lastBatch` so the next move reuses its ids instead of re-creating the instances.
        active.gesture?.cancel();
        active.gesture = null;
        active.lastKey = "";
        return;
      }
      if (active.gesture === null) {
        const gesture = start();
        if (gesture === null) return;
        if (!gesture.step(batch).ok) {
          gesture.cancel();
          return;
        }
        active.gesture = gesture;
      } else if (!active.gesture.replace(batch).ok) {
        return;
      }
      active.lastBatch = batch;
    },
    [brushes, model, now, start, strokeOf],
  );

  /** Finishes the preview and commits the final batch (exactly one when it changes the doc). */
  const finish = useCallback(
    (active: Session): void => {
      const stroke = strokeOf(active);
      const region = strokeRegion(stroke);
      if (region === null) {
        active.gesture?.cancel();
        onAnnounce(t("brush.live.nothing"));
        return;
      }
      const state = brushes.store.getState();
      const built = brushBatch(
        active.preStrokeDoc,
        state.brush,
        {
          region,
          strength: strokeStrength(stroke),
          ...(state.brush === "filterSweep" ? { direction: state.direction } : {}),
        },
        model,
      );
      if (built === null) {
        active.gesture?.cancel();
        onAnnounce(t("brush.live.nothing"));
        return;
      }
      const batch = alignFxIds(built, active.lastBatch);
      const commit = (gesture: Gesture): void => {
        void gesture
          .commit(batch.label)
          .then((outcome) => {
            if (outcome === null) return;
            onAnnounce(outcome.ok ? batch.label : t("song.live.rejected"));
          })
          .catch((cause: unknown) => {
            console.warn("could not commit a paint stroke", cause);
            onAnnounce(t("song.live.rejected"));
          });
      };

      const gesture = active.gesture;
      if (gesture === null) {
        const fresh = start();
        if (fresh === null) return;
        if (!fresh.step(batch).ok) {
          fresh.cancel();
          onAnnounce(t("song.live.rejected"));
          return;
        }
        commit(fresh);
        return;
      }
      if (!sameOps(active.lastBatch, batch) && !gesture.replace(batch).ok) {
        gesture.cancel();
        onAnnounce(t("song.live.rejected"));
        return;
      }
      commit(gesture);
    },
    [brushes, model, onAnnounce, start, strokeOf],
  );

  const onPaintStart = useCallback(
    (event: CanvasEvents["paintStart"]): void => {
      const doc = songStore.store.getState().doc;
      const handle = songStore.handle();
      if (doc === null || handle === null) return;
      // A pointercancel can leave a preview running; never stack two strokes.
      session.current?.gesture?.cancel();
      const active: Session = {
        preStrokeDoc: doc,
        handle,
        points: [],
        pointerType: event.pointerType,
        wheelDelta: 0,
        gesture: null,
        lastBatch: null,
        lastKey: "",
        lastPreviewAt: 0,
      };
      session.current = active;
      absorb(active, event);
      preview(active, true);
    },
    [absorb, preview, songStore],
  );

  const onPaintMove = useCallback(
    (event: CanvasEvents["paintMove"]): void => {
      const active = session.current;
      if (active === null) return;
      absorb(active, event);
      preview(active, false);
    },
    [absorb, preview],
  );

  const onPaintEnd = useCallback(
    (event: CanvasEvents["paintEnd"]): void => {
      const active = session.current;
      session.current = null;
      if (active === null) return;
      absorb(active, event);
      finish(active);
    },
    [absorb, finish],
  );

  const onPaintCancel = useCallback((_event: CanvasEvents["paintCancel"]): void => {
    const active = session.current;
    session.current = null;
    active?.gesture?.cancel();
  }, []);

  useEffect(() => {
    return () => {
      const active = session.current;
      session.current = null;
      active?.gesture?.cancel();
    };
  }, []);

  return { onPaintStart, onPaintMove, onPaintEnd, onPaintCancel };
}
