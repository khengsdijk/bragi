/**
 * Section drags on the Song Canvas (07 §4.1–4.2): reorder, Alt-duplicate and right-edge resize.
 *
 * The renderer reports pointer steps; this hook turns them into preview steps on the Song Store's
 * copy (01 §5: "drags never mutate the document"), one commit on release, and nothing on Escape.
 * Reorder steps are plain `section.move` ops; the smart transitions are appended in one last step
 * on release, so the committed batch is exactly one move plus its `section.set_transition` ops.
 */
import type { CanvasEvents } from "@bragi/render-canvas";
import type { Op, OpBatch, Project, SectionResizeMode } from "@bragi/schemas";
import { useCallback, useRef, useState } from "react";

import { t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";
import { type Gesture, startGesture } from "../../history/state/gesture.js";
import type { History } from "../../history/state/history.js";
import type { SettingsStore } from "../../settings/state/settings-store.js";
import type { EngineController } from "../state/engine-controller.js";
import { duplicateSectionBatch, moveSectionBatch, sectionBars } from "../state/section-ops.js";
import type { SongStore } from "../state/song-store.js";

/** The resize question a right-edge release opens (07 §4.2; the AI choices arrive with WP-2.7). */
export interface ResizePrompt {
  readonly sectionId: string;
  /** The target length in whole bars, already snapped and clamped by the renderer. */
  readonly bars: number;
  /** The length before the drag, which says whether this is Loop/Stretch or Trim. */
  readonly currentBars: number;
  readonly clientX: number;
  readonly clientY: number;
  /** Where focus returns when the popover closes (the canvas, or a grid cell). */
  readonly returnFocus: HTMLElement | null;
}

export interface SectionDragOptions {
  readonly songStore: SongStore;
  readonly controller: EngineController;
  readonly settings: SettingsStore;
  readonly history?: History;
  readonly onAnnounce: (message: string) => void;
  /** `useSongActions.resize`: one `section.resize` batch through history, forwarded to the engine. */
  readonly onResize: (sectionId: string, bars: number, mode: SectionResizeMode) => void;
}

/** The canvas events this hook handles. */
export interface SectionDragHandlers {
  readonly onSectionDragStart: (event: CanvasEvents["sectionDragStart"]) => void;
  readonly onSectionDragMove: (event: CanvasEvents["sectionDragMove"]) => void;
  readonly onSectionDragEnd: (event: CanvasEvents["sectionDragEnd"]) => void;
  readonly onSectionDragCancel: (event: CanvasEvents["sectionDragCancel"]) => void;
  readonly onSectionResizeStart: (event: CanvasEvents["sectionResizeStart"]) => void;
  readonly onSectionResizeMove: (event: CanvasEvents["sectionResizeMove"]) => void;
  readonly onSectionResizeEnd: (event: CanvasEvents["sectionResizeEnd"]) => void;
  readonly onSectionResizeCancel: (event: CanvasEvents["sectionResizeCancel"]) => void;
}

export interface SectionDragController extends SectionDragHandlers {
  readonly resizePrompt: ResizePrompt | null;
  readonly closeResizePrompt: () => void;
  readonly chooseResizeMode: (mode: SectionResizeMode) => void;
}

interface MoveSession {
  readonly kind: "move";
  readonly sectionId: string;
  /** The block's index before the drag; the renderer's slot counts this block too. */
  readonly startIndex: number;
  readonly preDragDoc: Project;
  readonly gesture: Gesture;
  lastIndex: number;
}

interface DuplicateSession {
  readonly kind: "duplicate";
  readonly sectionId: string;
  /** The copy exists once and is then moved, so its id is fixed at drag start. */
  readonly newId: string;
  readonly preDragDoc: Project;
  readonly gesture: Gesture;
  readonly label: string;
  lastSlot: number;
}

type Session = MoveSession | DuplicateSession;

interface ResizeSession {
  readonly sectionId: string;
  readonly startBars: number;
}

/** The final index of a moved block from an insertion slot that still counts it. */
function moveIndex(slot: number, startIndex: number): number {
  return slot > startIndex ? slot - 1 : slot;
}

function focusCanvas(): void {
  globalThis.document?.querySelector<HTMLElement>('[data-testid="song-canvas"]')?.focus();
}

export function useSectionDrag(options: SectionDragOptions): SectionDragController {
  const { songStore, controller, settings, onAnnounce, onResize } = options;
  const session = useRef<Session | null>(null);
  const resizeSession = useRef<ResizeSession | null>(null);
  const [resizePrompt, setResizePrompt] = useState<ResizePrompt | null>(null);

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

  const applyDrag = useCallback(
    (event: CanvasEvents["sectionDragMove"]): void => {
      const active = session.current;
      if (active === null) return;
      const preview = songStore.store.getState().preview ?? active.preDragDoc;

      if (active.kind === "move") {
        const toIndex = moveIndex(event.dropIndex, active.startIndex);
        if (toIndex === active.lastIndex) return;
        const step = moveSectionBatch(preview, active.sectionId, toIndex, { smooth: false });
        if (step === null) return;
        if (active.gesture.step(step).ok) active.lastIndex = toIndex;
        return;
      }

      const slot = event.dropIndex;
      if (slot === active.lastSlot) return;
      const from = preview.arrangement.sections.findIndex((section) => section.id === active.newId);
      if (from < 0) return;
      if (from === slot) {
        active.lastSlot = slot;
        return;
      }
      const step = moveSectionBatch(preview, active.newId, slot, { smooth: false });
      if (step === null) return;
      if (active.gesture.step(step).ok) active.lastSlot = slot;
    },
    [songStore],
  );

  const finish = useCallback(
    (gesture: Gesture, label: string): void => {
      void gesture
        .commit(label)
        .then((outcome) => {
          if (outcome === null) return;
          if (outcome.ok) {
            if (label !== "") onAnnounce(label);
          } else {
            onAnnounce(t("song.live.rejected"));
          }
        })
        .catch((cause: unknown) => {
          console.warn("could not commit a section drag", cause);
          onAnnounce(t("song.live.rejected"));
        });
    },
    [onAnnounce],
  );

  const onSectionDragStart = useCallback(
    (event: CanvasEvents["sectionDragStart"]): void => {
      const doc = songStore.store.getState().doc;
      if (doc === null) return;
      const startIndex = doc.arrangement.sections.findIndex(
        (section) => section.id === event.sectionId,
      );
      if (startIndex < 0) return;

      // A pointercancel or a second pointer can leave a gesture running; never stack two.
      session.current?.gesture.cancel();
      const gesture = start();
      if (gesture === null) return;

      if (event.altKey) {
        const newId = `sec_${ulid()}`;
        const first = duplicateSectionBatch(doc, event.sectionId, event.dropIndex, newId);
        if (first === null || !gesture.step(first).ok) {
          gesture.cancel();
          return;
        }
        session.current = {
          kind: "duplicate",
          sectionId: event.sectionId,
          newId,
          preDragDoc: doc,
          gesture,
          label: first.label,
          lastSlot: event.dropIndex,
        };
        return;
      }

      session.current = {
        kind: "move",
        sectionId: event.sectionId,
        startIndex,
        preDragDoc: doc,
        gesture,
        lastIndex: startIndex,
      };
    },
    [songStore, start],
  );

  const onSectionDragMove = useCallback(
    (event: CanvasEvents["sectionDragMove"]): void => {
      applyDrag(event);
    },
    [applyDrag],
  );

  const onSectionDragEnd = useCallback(
    (event: CanvasEvents["sectionDragEnd"]): void => {
      const active = session.current;
      if (active === null) return;
      // Apply the final slot first: a release without a last move still lands where it was dropped.
      applyDrag(event);
      session.current = null;

      if (active.kind === "duplicate") {
        finish(active.gesture, active.label);
        return;
      }

      const finalIndex = moveIndex(event.dropIndex, active.startIndex);
      if (finalIndex === active.startIndex) {
        // Back where it started: `commit` sees an unchanged preview and records nothing.
        finish(active.gesture, "");
        return;
      }
      const batch = moveSectionBatch(active.preDragDoc, active.sectionId, finalIndex, {
        smooth: settings.store.getState().smartTransitions,
      });
      if (batch === null) {
        finish(active.gesture, "");
        return;
      }
      // The move already happened step by step; only the smart joins are new at release.
      const joins = batch.ops.filter((op) => op.op !== "section.move");
      if (joins.length > 0) {
        const transitionStep: OpBatch = { ...batch, ops: joins as [Op, ...Op[]] };
        active.gesture.step(transitionStep);
      }
      finish(active.gesture, batch.label);
    },
    [applyDrag, finish, settings],
  );

  const onSectionDragCancel = useCallback((_event: CanvasEvents["sectionDragCancel"]): void => {
    const active = session.current;
    session.current = null;
    active?.gesture.cancel();
  }, []);

  const onSectionResizeStart = useCallback(
    (event: CanvasEvents["sectionResizeStart"]): void => {
      const doc = songStore.store.getState().doc;
      if (doc === null) return;
      const section = doc.arrangement.sections.find(
        (candidate) => candidate.id === event.sectionId,
      );
      if (section === undefined) return;
      resizeSession.current = {
        sectionId: section.id,
        startBars: sectionBars(doc, section),
      };
    },
    [songStore],
  );

  const onSectionResizeMove = useCallback((_event: CanvasEvents["sectionResizeMove"]): void => {
    // The renderer owns the ghost; the document (and audio) do not change during a resize.
  }, []);

  const onSectionResizeEnd = useCallback((event: CanvasEvents["sectionResizeEnd"]): void => {
    const active = resizeSession.current;
    resizeSession.current = null;
    if (active === null || event.bars === active.startBars) return;
    const focused = globalThis.document?.activeElement;
    setResizePrompt({
      sectionId: active.sectionId,
      bars: event.bars,
      currentBars: active.startBars,
      clientX: event.clientX,
      clientY: event.clientY,
      returnFocus: focused instanceof HTMLElement ? focused : null,
    });
  }, []);

  const onSectionResizeCancel = useCallback((_event: CanvasEvents["sectionResizeCancel"]): void => {
    resizeSession.current = null;
  }, []);

  const restoreFocus = useCallback((target: HTMLElement | null): void => {
    setTimeout(() => {
      if (target?.isConnected === true) target.focus();
      else focusCanvas();
    }, 0);
  }, []);

  const closeResizePrompt = useCallback((): void => {
    const prompt = resizePrompt;
    setResizePrompt(null);
    restoreFocus(prompt?.returnFocus ?? null);
  }, [resizePrompt, restoreFocus]);

  const chooseResizeMode = useCallback(
    (mode: SectionResizeMode): void => {
      const prompt = resizePrompt;
      if (prompt === null) return;
      setResizePrompt(null);
      restoreFocus(prompt.returnFocus);
      onResize(prompt.sectionId, prompt.bars, mode);
    },
    [onResize, resizePrompt, restoreFocus],
  );

  return {
    onSectionDragStart,
    onSectionDragMove,
    onSectionDragEnd,
    onSectionDragCancel,
    onSectionResizeStart,
    onSectionResizeMove,
    onSectionResizeEnd,
    onSectionResizeCancel,
    resizePrompt,
    closeResizePrompt,
    chooseResizeMode,
  };
}
