/**
 * The section actions shared by the keyboard, the context menu and the command palette (07 §4).
 *
 * Each action builds one batch with `section-ops`, commits it through the history store (or the
 * Song Store in the demo, which has no version tree), forwards the outcome to the engine and
 * announces the result in the workspace's live region (11 §6.3). The hook also owns the small
 * dialogs (rename, type, length) that some actions open.
 */

import type { Selection } from "@bragi/render-canvas";
import type {
  OpBatch,
  Project,
  SectionInstance,
  SectionKind,
  SectionResizeMode,
} from "@bragi/schemas";
import { useCallback, useMemo, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import { type MessageKey, t } from "../../../i18n/index.js";
import type { CommandContext } from "../../commands/state/commands.js";
import type { History, HistoryState } from "../../history/state/history.js";
import { EMPTY_HISTORY_STATE } from "../../history/state/history.js";
import type { SettingsStore } from "../../settings/state/settings-store.js";
import { sectionAtTick, sectionSpanSec, sectionSpansSec } from "../api/section-time.js";
import type { ModelApi } from "../model/model-api.js";
import type { EngineController } from "../state/engine-controller.js";
import {
  duplicateSectionBatch,
  lockSectionBatch,
  moveSectionBatch,
  removeSectionBatch,
  renameSectionBatch,
  resizeSectionBatch,
  sectionBars,
  setSectionKindBatch,
  splitPoint,
  splitSectionBatch,
} from "../state/section-ops.js";
import type { ApplyOutcome, SongStore } from "../state/song-store.js";

/** The dialog one action can open; the workspace renders it. */
export type SectionDialog =
  | { readonly kind: "rename"; readonly sectionId: string; readonly label: string }
  | { readonly kind: "changeKind"; readonly sectionId: string; readonly sectionKind: SectionKind }
  | {
      readonly kind: "resize";
      readonly sectionId: string;
      readonly direction: "longer" | "shorter";
      readonly mode: SectionResizeMode;
      readonly bars: number;
      readonly currentBars: number;
    };

export interface SongActionsOptions {
  readonly songStore: SongStore;
  readonly controller: EngineController;
  readonly settings: SettingsStore;
  readonly history?: History;
  readonly model: ModelApi;
  readonly selection: Selection;
  readonly focus: { readonly kind: "section" | "track"; readonly id: string } | null;
  readonly historyOpen: boolean;
  readonly onToggleHistory: () => void;
  readonly onAnnounce: (message: string) => void;
}

export interface SongActions {
  readonly context: CommandContext;
  readonly dialog: SectionDialog | null;
  readonly closeDialog: () => void;
  readonly setSmartTransitions: (value: boolean) => void;
  readonly rename: (sectionId: string, label: string) => void;
  readonly changeKind: (sectionId: string, kind: SectionKind) => void;
  readonly resize: (sectionId: string, bars: number, mode: SectionResizeMode) => void;
  /** One-bar keyboard resize: Loop when it grows, Trim when it shrinks (11 §6.2). */
  readonly resizeByBar: (sectionId: string, delta: -1 | 1) => void;
}

/** A history store with nothing in it, for the demo (no version tree). */
const NO_HISTORY = createStore<HistoryState>(() => EMPTY_HISTORY_STATE);

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

export function useSongActions(options: SongActionsOptions): SongActions {
  const { songStore, controller, settings, model, selection, focus, onAnnounce } = options;
  const doc = useStore(songStore.store, (state) => state.doc);
  const smartTransitions = useStore(settings.store, (state) => state.smartTransitions);
  const playing = useStore(controller.store, (state) => state.playing);
  const historyStore = options.history?.store ?? NO_HISTORY;
  const canUndo = useStore(historyStore, (state) => state.canUndo);
  const canRedo = useStore(historyStore, (state) => state.canRedo);
  const [dialog, setDialog] = useState<SectionDialog | null>(null);

  const selectedSection =
    selection.kind === "sections" && selection.ids.length === 1 ? (selection.ids[0] ?? null) : null;
  const sectionId = selectedSection ?? (focus?.kind === "section" ? focus.id : null);
  const sectionIndex =
    doc === null || sectionId === null
      ? -1
      : doc.arrangement.sections.findIndex((section) => section.id === sectionId);
  const section = sectionIndex >= 0 ? (doc?.arrangement.sections[sectionIndex] ?? null) : null;
  const bars = doc !== null && section !== null ? sectionBars(doc, section) : 1;

  const current = useCallback((): Project | null => songStore.store.getState().doc, [songStore]);

  const follow = useCallback(
    (outcome: ApplyOutcome, message: string): void => {
      if (outcome.ok) {
        controller.commit(outcome.commit, outcome.doc);
        onAnnounce(message);
      } else {
        onAnnounce(t("song.live.rejected"));
      }
    },
    [controller, onAnnounce],
  );

  /** Commits one action's batch; `message` is the past-tense live-region announcement. */
  const runBatch = useCallback(
    (batch: OpBatch | null, message?: string): void => {
      if (batch === null) return;
      const history = options.history;
      if (history === undefined) {
        follow(songStore.apply(batch), message ?? batch.label);
        return;
      }
      void history
        .commit(batch)
        .then((outcome) => follow(outcome, message ?? batch.label))
        .catch((cause: unknown) => {
          console.warn("could not commit a section action", cause);
          onAnnounce(t("song.live.rejected"));
        });
    },
    [follow, onAnnounce, options.history, songStore],
  );

  const moveSection = useCallback(
    (id: string, delta: -1 | 1): void => {
      const live = current();
      if (live === null) return;
      const index = live.arrangement.sections.findIndex((candidate) => candidate.id === id);
      const moved = live.arrangement.sections[index];
      if (moved === undefined) return;
      const toIndex = clampIndex(index + delta, live.arrangement.sections.length);
      if (toIndex === index) return;
      const batch = moveSectionBatch(live, id, toIndex, { smooth: smartTransitions });
      if (batch === null) return;
      const final = live.arrangement.sections.filter((candidate) => candidate.id !== id);
      final.splice(toIndex, 0, moved);
      const after = toIndex === 0 ? undefined : final[toIndex - 1];
      runBatch(
        batch,
        after === undefined
          ? t("song.announce.movedStart", { label: moved.label })
          : t("song.announce.movedAfter", { label: moved.label, after: after.label }),
      );
    },
    [current, runBatch, smartTransitions],
  );

  const duplicateSection = useCallback(
    (id: string): void => {
      const live = current();
      if (live === null) return;
      const index = live.arrangement.sections.findIndex((candidate) => candidate.id === id);
      const source = live.arrangement.sections[index];
      if (source === undefined) return;
      const batch = duplicateSectionBatch(live, id, index + 1);
      if (batch !== null) runBatch(batch, t("song.announce.duplicated", { label: source.label }));
    },
    [current, runBatch],
  );

  const removeSection = useCallback(
    (id: string): void => {
      const live = current();
      if (live === null) return;
      const sectionToRemove = live.arrangement.sections.find((candidate) => candidate.id === id);
      if (sectionToRemove === undefined) return;
      const batch = removeSectionBatch(live, id, { smooth: smartTransitions });
      if (batch !== null) {
        runBatch(batch, t("song.announce.removed", { label: sectionToRemove.label }));
      }
    },
    [current, runBatch, smartTransitions],
  );

  const rename = useCallback(
    (id: string, label: string): void => {
      const live = current();
      if (live === null) return;
      const previous = live.arrangement.sections.find((candidate) => candidate.id === id);
      const batch = renameSectionBatch(live, id, label);
      if (batch !== null && previous !== undefined) {
        runBatch(batch, t("song.announce.renamed", { old: previous.label, name: label.trim() }));
      }
    },
    [current, runBatch],
  );

  const changeKind = useCallback(
    (id: string, kind: SectionKind): void => {
      const live = current();
      if (live === null) return;
      const target = live.arrangement.sections.find((candidate) => candidate.id === id);
      const batch = setSectionKindBatch(live, id, kind);
      if (batch !== null && target !== undefined) {
        runBatch(
          batch,
          t("song.announce.kindChanged", {
            label: target.label,
            kind: t(`song.sectionKind.${kind}` as MessageKey),
          }),
        );
      }
    },
    [current, runBatch],
  );

  const setLocked = useCallback(
    (id: string, locked: boolean): void => {
      const live = current();
      if (live === null) return;
      const target = live.arrangement.sections.find((candidate) => candidate.id === id);
      const batch = lockSectionBatch(live, id, locked);
      if (batch !== null && target !== undefined) {
        runBatch(
          batch,
          t(locked ? "song.announce.locked" : "song.announce.unlocked", { label: target.label }),
        );
      }
    },
    [current, runBatch],
  );

  const resize = useCallback(
    (id: string, targetBars: number, mode: SectionResizeMode): void => {
      const live = current();
      if (live === null) return;
      const target = live.arrangement.sections.find((candidate) => candidate.id === id);
      const batch = resizeSectionBatch(live, id, targetBars, mode);
      if (batch !== null && target !== undefined) {
        runBatch(batch, t("song.announce.resized", { label: target.label, bars: targetBars }));
      }
    },
    [current, runBatch],
  );

  const resizeByBar = useCallback(
    (id: string, delta: -1 | 1): void => {
      const live = current();
      const target = live?.arrangement.sections.find((candidate) => candidate.id === id);
      if (live === null || target === undefined) return;
      const targetBars = sectionBars(live, target) + delta;
      if (targetBars < 1 || targetBars > 64) return;
      resize(id, targetBars, delta > 0 ? "loop" : "trim");
    },
    [current, resize],
  );

  const loopSection = useCallback(
    (id: string): void => {
      const handle = songStore.handle();
      if (handle === null) return;
      const span = sectionSpanSec(model, handle, id);
      const target = current()?.arrangement.sections.find((candidate) => candidate.id === id);
      if (span === null || target === undefined) return;
      const active = controller.store.getState();
      const sameRange =
        active.loop &&
        active.loopRange !== null &&
        Math.abs(active.loopRange.startSec - span.startSec) < 1e-6 &&
        Math.abs(active.loopRange.endSec - span.endSec) < 1e-6;
      if (sameRange) {
        controller.setLoopRange(null);
        onAnnounce(t("song.announce.loopOff"));
        return;
      }
      controller.setLoopRange({ startSec: span.startSec, endSec: span.endSec });
      onAnnounce(t("song.announce.looping", { label: target.label }));
    },
    [controller, current, model, onAnnounce, songStore],
  );

  const splitAtPlayhead = useCallback((): void => {
    const handle = songStore.handle();
    const live = current();
    if (handle === null || live === null) return;
    const tick = Number(model.secondsToTicks(handle, controller.store.getState().positionSec));
    const spans = sectionSpansSec(model, handle);
    const span = sectionAtTick(spans, tick);
    if (span === null) {
      onAnnounce(t("song.announce.noSection"));
      return;
    }
    const point = splitPoint(live, span.id, tick);
    const batch = splitSectionBatch(live, span.id, tick);
    if (point === null || batch === null) {
      onAnnounce(t("song.announce.noSplit"));
      return;
    }
    const target = live.arrangement.sections.find((candidate) => candidate.id === span.id);
    runBatch(
      batch,
      t("song.announce.split", {
        label: target?.label ?? batch.label,
        bar: point.bar,
      }),
    );
  }, [controller, current, model, onAnnounce, runBatch, songStore]);

  const openRename = useCallback(
    (id: string): void => {
      const target = current()?.arrangement.sections.find((candidate) => candidate.id === id);
      if (target !== undefined) {
        setDialog({ kind: "rename", sectionId: id, label: target.label });
      }
    },
    [current],
  );

  const openKind = useCallback(
    (id: string): void => {
      const target = current()?.arrangement.sections.find((candidate) => candidate.id === id);
      if (target !== undefined) {
        setDialog({ kind: "changeKind", sectionId: id, sectionKind: target.kind });
      }
    },
    [current],
  );

  const openResize = useCallback(
    (id: string, direction: "longer" | "shorter"): void => {
      const live = current();
      const target = live?.arrangement.sections.find((candidate) => candidate.id === id);
      if (live === null || target === undefined) return;
      const currentBars = sectionBars(live, target);
      setDialog({
        kind: "resize",
        sectionId: id,
        direction,
        mode: direction === "longer" ? "loop" : "trim",
        bars: direction === "longer" ? Math.min(64, currentBars + 4) : Math.max(1, currentBars - 4),
        currentBars,
      });
    },
    [current],
  );

  const undo = useCallback((): void => {
    const history = options.history;
    if (history === undefined) return;
    const state = history.store.getState();
    const targetId = state.head ?? undefined;
    const label = targetId === undefined ? "" : (state.commits.get(targetId)?.label ?? "");
    void history
      .undo()
      .then((outcome) => {
        if (outcome === null || !outcome.ok) return;
        controller.commit(outcome.commit, outcome.doc);
        if (label !== "") onAnnounce(t("history.undo", { label }));
      })
      .catch((cause: unknown) => console.warn("could not undo", cause));
  }, [controller, onAnnounce, options.history]);

  const redo = useCallback((): void => {
    const history = options.history;
    if (history === undefined) return;
    const state = history.store.getState();
    const targetId = state.redo.at(-1);
    const label = targetId === undefined ? "" : (state.commits.get(targetId)?.label ?? "");
    void history
      .redo()
      .then((outcome) => {
        if (outcome === null || !outcome.ok) return;
        controller.commit(outcome.commit, outcome.doc);
        if (label !== "") onAnnounce(t("history.redo", { label }));
      })
      .catch((cause: unknown) => console.warn("could not redo", cause));
  }, [controller, onAnnounce, options.history]);

  const actions = useMemo(
    () => ({
      moveSection,
      duplicateSection,
      removeSection,
      openRename,
      openKind,
      setLocked,
      loopSection,
      openResize,
      splitAtPlayhead,
      undo,
      redo,
      toggleHistory: options.onToggleHistory,
      togglePlay: () => {
        void controller.toggle();
      },
    }),
    [
      controller,
      duplicateSection,
      loopSection,
      moveSection,
      openKind,
      openRename,
      openResize,
      options.onToggleHistory,
      redo,
      removeSection,
      setLocked,
      splitAtPlayhead,
      undo,
    ],
  );

  const context = useMemo<CommandContext>(
    () => ({
      section,
      sectionIndex: Math.max(-1, sectionIndex),
      sectionCount: doc?.arrangement.sections.length ?? 0,
      sectionBars: bars,
      smartTransitions,
      canUndo,
      canRedo,
      hasHistory: options.history !== undefined,
      historyOpen: options.historyOpen,
      playing,
      actions,
    }),
    [
      actions,
      bars,
      canRedo,
      canUndo,
      doc,
      options.history,
      options.historyOpen,
      playing,
      section,
      sectionIndex,
      smartTransitions,
    ],
  );

  const setSmartTransitions = useCallback(
    (value: boolean): void => {
      void settings.setSmartTransitions(value);
      onAnnounce(t(value ? "song.announce.smoothOn" : "song.announce.smoothOff"));
    },
    [onAnnounce, settings],
  );

  return {
    context,
    dialog,
    closeDialog: () => setDialog(null),
    setSmartTransitions,
    rename,
    changeKind,
    resize,
    resizeByBar,
  };
}

/** Exposed for the dialog component: the section a dialog refers to. */
export function dialogSection(
  doc: Project | null,
  dialog: SectionDialog | null,
): SectionInstance | null {
  if (doc === null || dialog === null) return null;
  return doc.arrangement.sections.find((section) => section.id === dialog.sectionId) ?? null;
}
