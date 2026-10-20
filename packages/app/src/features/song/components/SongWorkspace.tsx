/**
 * The Song Canvas feature root: the canvas, its accessible grid and the transport bar, wired to
 * the Song Store and the engine controller (07 §1).
 *
 * Data flows one way: the Song Store holds the document; this component derives the canvas view
 * (`buildCanvasDocument`) and the grid (`buildGridModel`) from it and from the analysis that has
 * arrived. Gestures flow back as op batches into the Song Store, and each commit is forwarded to
 * the engine, so what you see, what a screen reader gets and what you hear are one document.
 */
import { Button } from "@bragi/design";
import type {
  AnalysisView,
  CanvasEvents,
  CanvasHighlight,
  Selection,
  Viewport,
  ZoomLevel,
} from "@bragi/render-canvas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { t } from "../../../i18n/index.js";
import { usePlatform } from "../../../platform-context.js";
import { apiFor } from "../../analysis/api/host.js";
import { AuditionBar } from "../../audition/components/AuditionBar.js";
import {
  type Audition,
  createAudition,
  EMPTY_AUDITION_STORE,
} from "../../audition/state/audition.js";
import type { CandidateSource } from "../../audition/state/candidate-status.js";
import { BrushApplyDialog } from "../../brushes/components/BrushApplyDialog.js";
import { BrushPalette } from "../../brushes/components/BrushPalette.js";
import { usePaintStroke } from "../../brushes/hooks/use-paint-stroke.js";
import { createBrushStore } from "../../brushes/state/brush-store.js";
import { CommandPaletteDialog } from "../../commands/components/CommandPaletteDialog.js";
import { createCommandRegistry } from "../../commands/state/commands.js";
import { SONG_COMMANDS } from "../../commands/state/song-commands.js";
import { HistoryPanel } from "../../history/components/HistoryPanel.js";
import type { History } from "../../history/state/history.js";
import { Inspector } from "../../inspector/components/Inspector.js";
import { ExplainPopover } from "../../planner/components/ExplainPopover.js";
import { PromptBar } from "../../planner/components/PromptBar.js";
import { createPlanner } from "../../planner/state/planner.js";
import type { SettingsStore } from "../../settings/state/settings-store.js";
import { buildGridModel } from "../api/grid-model.js";
import { secondsAtTicks } from "../api/section-time.js";
import { analysisView, buildCanvasDocument } from "../api/view-model.js";
import { useSectionDrag } from "../hooks/use-section-drag.js";
import { dialogSection, useSongActions } from "../hooks/use-song-actions.js";
import type { EngineController } from "../state/engine-controller.js";
import { trackToggleBatch } from "../state/ops.js";
import { resolveSongShortcut } from "../state/shortcuts.js";
import type { ApplyOutcome, SongStore } from "../state/song-store.js";
import { AccessibleGrid, type GridFocus } from "./AccessibleGrid.js";
import { SectionActionDialogs } from "./SectionActionDialogs.js";
import { SectionMenu, type SectionMenuAnchor } from "./SectionMenu.js";
import { SectionResizePopover } from "./SectionResizePopover.js";
import { type SongCanvasHandle, SongCanvasView } from "./SongCanvasView.js";
import { formatTime, TransportBar } from "./TransportBar.js";

/** The analysis data that has arrived (stages come from the document). */
export type AnalysisData = Omit<AnalysisView, "stages">;

export interface SongWorkspaceProps {
  readonly songStore: SongStore;
  readonly controller: EngineController;
  /** The open project's version tree; absent for the demo, which has no project row. */
  readonly history?: History;
  /** Device settings, e.g. smart transitions; the route loads them from `local_settings`. */
  readonly settings: SettingsStore;
  /** Energy, chords and ribbon data; `null` before any of it has arrived (WP-1.10 feeds this). */
  readonly analysis: AnalysisData | null;
  readonly selection: Selection;
  readonly onSelectionChange: (selection: Selection) => void;
  readonly renderer?: "webgpu" | "webgl";
  /** Exposes the canvas on `window.__bragi` for the end-to-end tests. */
  readonly testHooks?: boolean;
  /** Job events for AI candidates (WP-2.6/2.7); the Audition bar works without one. */
  readonly candidateSource?: CandidateSource;
}

/** What the e2e tests reach through `window.__bragi`. */
export interface BragiTestHooks {
  canvas: SongCanvasHandle["canvas"] | null;
  store: SongStore;
  controller: EngineController;
  history: History | null;
  audition: Audition | null;
}

declare global {
  interface Window {
    __bragi?: BragiTestHooks | undefined;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * Panels, dialogs and menus own their keys: the section shortcuts must not fire from the
 * Inspector's sliders, the version tree, an open palette or a dialog (task B note).
 */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      '[data-testid="inspector-panel"], [data-testid="history-panel"], [role="dialog"], [role="menu"], [role="listbox"]',
    ) !== null
  );
}

export function SongWorkspace(props: SongWorkspaceProps) {
  const { songStore, controller } = props;
  const doc = useStore(songStore.store, (state) => state.doc);
  /** A running drag's copy (01 §5): the canvas and the grid show it while the document waits. */
  const preview = useStore(songStore.store, (state) => state.preview);
  const [announcement, setAnnouncement] = useState("");
  const history = props.history;
  const candidateSource = props.candidateSource;
  /** The open candidate group or comparison (07 §6); needs a version tree. */
  const audition = useMemo(
    () =>
      history === undefined
        ? null
        : createAudition({
            controller,
            history,
            document: () => songStore.store.getState().doc,
            ...(candidateSource === undefined ? {} : { source: candidateSource }),
            onOutcome: (outcome, message) => {
              if (outcome?.ok) {
                controller.commit(outcome.commit, outcome.doc);
                setAnnouncement(message);
              } else {
                setAnnouncement(t("song.live.rejected"));
              }
            },
            onAnnounce: setAnnouncement,
          }),
    [controller, history, songStore, candidateSource],
  );
  useEffect(() => () => audition?.dispose(), [audition]);
  const platform = usePlatform();
  const api = useMemo(() => apiFor(platform), [platform]);
  /** The latest analysis for the planner, without recreating it when a stage lands. */
  const analysisRef = useRef(props.analysis);
  analysisRef.current = props.analysis;
  const planner = useMemo(
    () =>
      createPlanner({
        client: api,
        songStore,
        model: songStore.model,
        analysis: () => analysisRef.current,
        ...(history === undefined ? {} : { history }),
        ...(audition === null ? {} : { audition }),
        onAnnounce: setAnnouncement,
      }),
    [api, audition, history, songStore],
  );
  useEffect(() => () => planner.dispose(), [planner]);
  const plannerOpen = useStore(planner.store, (state) => state.open);
  const plannerPhase = useStore(planner.store, (state) => state.phase);
  const plannerTarget = useStore(planner.store, (state) => state.target);
  const explanation = useStore(planner.store, (state) => state.explanation);
  const [explainMode, setExplainMode] = useState(false);
  /** The selected candidate's document: the canvas draws what is audible (07 §6). */
  const auditionDoc = useStore(audition?.store ?? EMPTY_AUDITION_STORE, (state) =>
    state.selected === 0
      ? null
      : (state.group?.candidates.find((candidate) => candidate.slot === state.selected)?.doc ??
        null),
  );
  const viewDoc = auditionDoc ?? preview ?? doc;
  const [level, setLevel] = useState<ZoomLevel>("L2");
  const [focus, setFocus] = useState<GridFocus | null>(null);
  /** One side panel at a time: the Inspector or the version tree. */
  const [sidePanel, setSidePanel] = useState<"inspector" | "history" | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<SectionMenuAnchor | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const handle = useRef<SongCanvasHandle | null>(null);
  const hovered = useRef<string | null>(null);
  const selection = props.selection;
  const smartTransitions = useStore(props.settings.store, (state) => state.smartTransitions);
  const brushes = useMemo(() => createBrushStore(), []);
  const brushTool = useStore(brushes.store, (state) => state.tool);
  const brush = useStore(brushes.store, (state) => state.brush);
  const brushStrength = useStore(brushes.store, (state) => state.sizeStrength);
  const brushDirection = useStore(brushes.store, (state) => state.direction);
  const selectedTrack =
    selection.kind === "tracks" && selection.ids.length === 1 ? (selection.ids[0] ?? null) : null;

  // Selecting one ribbon opens the Inspector (07 §4.5). Closing it does not reopen it until
  // another instrument is selected; with nothing selected it stays open as the master inspector.
  useEffect(() => {
    if (selectedTrack !== null) setSidePanel("inspector");
  }, [selectedTrack]);

  const canvasDoc = useMemo(() => {
    if (viewDoc === null) return null;
    if (viewDoc === auditionDoc) {
      // A candidate is not loaded in the store: read its spans from a short-lived handle.
      const detached = songStore.detachedHandle(viewDoc);
      try {
        return buildCanvasDocument(songStore.model, detached, viewDoc);
      } finally {
        songStore.model.freeDoc(detached);
      }
    }
    // The spans come from the matching model handle: the preview's own copy during a drag.
    const handle = viewDoc === doc ? songStore.handle() : songStore.previewHandle();
    if (handle === null) return null;
    return buildCanvasDocument(songStore.model, handle, viewDoc);
    // `doc`/`preview` are replaced, never mutated, on every load and step: they are the cache key.
  }, [auditionDoc, doc, songStore, viewDoc]);

  const analysis = useMemo<AnalysisView | null>(
    () => (viewDoc === null ? null : analysisView(viewDoc, props.analysis)),
    [viewDoc, props.analysis],
  );
  const grid = useMemo(
    () => (canvasDoc === null ? null : buildGridModel(canvasDoc, analysis)),
    [canvasDoc, analysis],
  );
  const canvasLasso = useMemo(
    () =>
      plannerTarget === null
        ? null
        : {
            startSec: plannerTarget.startSec,
            endSec: plannerTarget.endSec,
            trackIds: plannerTarget.trackIds,
          },
    [plannerTarget],
  );
  const canvasHighlights = useMemo<CanvasHighlight[]>(() => {
    if (explanation?.status !== "done") return [];
    const songHandle = songStore.handle();
    if (songHandle === null || doc === null) return [];
    const allTracks = doc.tracks.filter((track) => !track.hidden).map((track) => track.id);
    return explanation.highlights.map((highlight) => ({
      region: {
        startSec: secondsAtTicks(songStore.model, songHandle, highlight.region.startTick),
        endSec: secondsAtTicks(songStore.model, songHandle, highlight.region.endTick),
        trackIds: highlight.region.tracks === "all" ? allTracks : [...highlight.region.tracks],
      },
      label: highlight.label,
    }));
  }, [doc, explanation, songStore]);

  const follow = useCallback(
    (outcome: ApplyOutcome, label: string) => {
      if (outcome.ok) {
        controller.commit(outcome.commit, outcome.doc);
        setAnnouncement(label);
      } else {
        setAnnouncement(t("song.live.rejected"));
      }
    },
    [controller],
  );

  /** The history panel's checkout/adopt result: forward it to the engine and announce it. */
  const followHistory = useCallback(
    (outcome: ApplyOutcome | null, message: string) => {
      if (outcome?.ok) {
        controller.commit(outcome.commit, outcome.doc);
        setAnnouncement(message);
      } else {
        setAnnouncement(t("song.live.rejected"));
      }
    },
    [controller],
  );

  const toggleTrack = useCallback(
    (trackId: string, field: "mute" | "solo", value?: boolean) => {
      const current = songStore.store.getState().doc;
      if (current === null) return;
      const track = current.tracks.find((candidate) => candidate.id === trackId);
      if (!track) return;
      const batch = trackToggleBatch(current, trackId, field, value ?? !track[field]);
      if (batch === null) return;
      if (props.history === undefined) {
        follow(songStore.apply(batch), batch.label);
        return;
      }
      void props.history
        .commit(batch)
        .then((outcome) => follow(outcome, batch.label))
        .catch((cause: unknown) => {
          console.warn("could not commit the track toggle", cause);
          setAnnouncement(t("song.live.rejected"));
        });
    },
    [songStore, props.history, follow],
  );

  const toggleHistory = useCallback(() => {
    setSidePanel((panel) => (panel === "history" ? null : "history"));
  }, []);

  /** "Ask AI…" acts on the current selection, or the whole song with its label (07 §5). */
  const askAi = useCallback(() => {
    planner.openForSelection(selection);
  }, [planner, selection]);

  const toggleExplain = useCallback(() => {
    const next = !explainMode;
    setExplainMode(next);
    if (next) {
      brushes.setTool("select");
      planner.close();
      setAnnouncement(t("planner.explainOn"));
    } else {
      setAnnouncement(t("planner.explainOff"));
    }
  }, [brushes, explainMode, planner]);

  const toggleLasso = useCallback(() => {
    const next = brushes.store.getState().tool === "lasso" ? "select" : "lasso";
    setExplainMode(false);
    brushes.setTool(next);
    setAnnouncement(t(next === "lasso" ? "planner.lassoOn" : "planner.lassoOff"));
  }, [brushes]);

  const onLassoStart = useCallback((): void => {
    planner.close();
    planner.closeExplanation();
  }, [planner]);

  const onLassoEnd = useCallback(
    (event: CanvasEvents["lassoEnd"]): void => {
      planner.openForLasso({
        startSec: event.region.startSec,
        endSec: event.region.endSec,
        trackIds: event.region.trackIds,
        altKey: event.altKey,
      });
    },
    [planner],
  );

  const onExplainAt = useCallback(
    (event: CanvasEvents["explainAt"]): void => {
      if (!explainMode) return;
      void planner.explainAt(event.sectionId, { x: event.clientX, y: event.clientY });
    },
    [explainMode, planner],
  );

  const actions = useSongActions({
    songStore,
    controller,
    settings: props.settings,
    ...(props.history === undefined ? {} : { history: props.history }),
    model: songStore.model,
    selection,
    focus,
    historyOpen: sidePanel === "history",
    explainMode,
    onToggleHistory: toggleHistory,
    onAskAi: askAi,
    onToggleExplain: toggleExplain,
    onAnnounce: setAnnouncement,
  });
  const drag = useSectionDrag({
    songStore,
    controller,
    settings: props.settings,
    ...(props.history === undefined ? {} : { history: props.history }),
    onAnnounce: setAnnouncement,
    onResize: actions.resize,
  });
  const paint = usePaintStroke({
    songStore,
    controller,
    model: songStore.model,
    brushes,
    ...(props.history === undefined ? {} : { history: props.history }),
    onAnnounce: setAnnouncement,
  });
  const commandRegistry = useMemo(() => createCommandRegistry(SONG_COMMANDS), []);

  /** Right-click or Shift+F10: select the part and open the shared menu at that point. */
  const openSectionMenu = useCallback(
    (sectionId: string, x: number, y: number, returnFocus: HTMLElement | null) => {
      // The grid's focus doubles as the fallback context when a view (the stored song) does not
      // keep a selection in the URL.
      setFocus({ kind: "section", id: sectionId });
      props.onSelectionChange({ kind: "sections", ids: [sectionId] });
      setMenuAnchor({ x, y, returnFocus });
    },
    [props.onSelectionChange],
  );

  const onSectionContextMenu = useCallback(
    (event: CanvasEvents["sectionContextMenu"]) => {
      const focused = document.activeElement;
      openSectionMenu(
        event.sectionId,
        event.clientX,
        event.clientY,
        focused instanceof HTMLElement ? focused : null,
      );
    },
    [openSectionMenu],
  );

  const onGridContextMenu = useCallback(
    (sectionId: string, element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      openSectionMenu(sectionId, rect.left + Math.min(64, rect.width / 2), rect.bottom, element);
    },
    [openSectionMenu],
  );

  const onCanvasToggle = useCallback(
    (event: CanvasEvents["trackToggle"]) => toggleTrack(event.trackId, event.field, event.value),
    [toggleTrack],
  );

  // The canvas owns pointer handling; React only tells it which tool and strength are active.
  useEffect(() => {
    handle.current?.canvas.setTool(explainMode ? "select" : brushTool);
    handle.current?.canvas.setPaintStrength(brushStrength);
  }, [brushTool, brushStrength, explainMode]);

  useEffect(() => {
    if (!props.testHooks) return;
    window.__bragi = {
      get canvas() {
        return handle.current?.canvas ?? null;
      },
      store: songStore,
      controller,
      history: props.history ?? null,
      audition,
    } as BragiTestHooks;
    return () => {
      window.__bragi = undefined;
    };
  }, [props.testHooks, songStore, controller, props.history, audition]);

  // Global shortcuts (07 §3, 11 §6.2). The grid handles M and O itself when it has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target) || ownsKeys(event.target)) return;
      const shortcut = resolveSongShortcut(event);
      if (shortcut !== null) {
        const context = actions.context;
        const target = context.section;
        if (shortcut.kind === "move" || shortcut.kind === "resize" || shortcut.kind === "remove") {
          event.preventDefault();
          if (target === null) {
            setAnnouncement(t("song.announce.noSection"));
            return;
          }
          if (shortcut.kind === "move") {
            context.actions.moveSection(target.id, shortcut.delta);
          } else if (shortcut.kind === "resize") {
            actions.resizeByBar(target.id, shortcut.delta);
          } else {
            context.actions.removeSection(target.id);
          }
          return;
        }
        event.preventDefault();
        if (shortcut.kind === "palette") setPaletteOpen(true);
        else if (shortcut.kind === "undo") context.actions.undo();
        else context.actions.redo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        askAi();
        return;
      }
      if (event.altKey) return;
      const onButton = event.target instanceof HTMLButtonElement;
      switch (event.key) {
        case " ":
          if (onButton) return;
          event.preventDefault();
          void controller.toggle();
          break;
        case "+":
        case "=":
          handle.current?.zoomBy(1.5);
          break;
        case "-":
        case "_":
          handle.current?.zoomBy(1 / 1.5);
          break;
        case "f":
        case "F":
          handle.current?.fit();
          break;
        case "m":
        case "M":
          if (hovered.current) toggleTrack(hovered.current, "mute");
          break;
        case "o":
        case "O":
          if (hovered.current) toggleTrack(hovered.current, "solo");
          break;
        case "t":
        case "T": {
          const state = controller.store.getState();
          setAnnouncement(
            t(state.playing ? "transport.announce.playing" : "transport.announce.paused", {
              position: formatTime(state.positionSec),
            }),
          );
          break;
        }
        case "b":
        case "B":
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          setExplainMode(false);
          brushes.togglePaint();
          setAnnouncement(
            t(
              brushes.store.getState().tool === "paint"
                ? "brush.announce.on"
                : "brush.announce.off",
            ),
          );
          break;
        case "l":
        case "L":
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          toggleLasso();
          break;
        case "?":
          event.preventDefault();
          toggleExplain();
          break;
        case "/":
          event.preventDefault();
          askAi();
          break;
        case "Escape":
          if (plannerOpen) planner.close();
          else if (explanation !== null) planner.closeExplanation();
          else props.onSelectionChange({ kind: "none" });
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    actions,
    askAi,
    brushes,
    controller,
    explanation,
    planner,
    plannerOpen,
    toggleExplain,
    toggleLasso,
    toggleTrack,
    props.onSelectionChange,
  ]);

  if (canvasDoc === null || grid === null || analysis === null) {
    return <p data-testid="song-loading">{t("song.canvas.loading")}</p>;
  }

  const selectionText =
    selection.kind === "sections"
      ? t("song.selection.parts", { count: selection.ids.length })
      : selection.kind === "tracks"
        ? t("song.selection.instruments", { count: selection.ids.length })
        : t("song.selection.whole");

  const brushDialog = actions.dialog?.kind === "brush" ? actions.dialog : null;
  const brushSection = dialogSection(doc, brushDialog);
  const brushTracks =
    brushSection === null || doc === null
      ? []
      : doc.tracks
          .filter((track) => brushSection.lanes[track.id] !== undefined)
          .map((track) => ({ id: track.id, name: track.name }));
  const promptAnchor =
    canvasLasso === null ? null : (handle.current?.canvas.regionRect(canvasLasso) ?? null);

  return (
    <div className="song-workspace" data-testid="song-workspace">
      <header className="song-workspace__header">
        <h1 data-testid="song-title">{canvasDoc.title}</h1>
        <p className="song-workspace__selection" data-testid="selection-summary">
          {selectionText}
        </p>
        <div
          style={{
            display: "flex",
            gap: "var(--space-1)",
            marginInlineStart: "auto",
          }}
        >
          <Button variant="secondary" size="sm" onClick={askAi}>
            {t("commands.planner.ask")}
          </Button>
          <Button
            variant={explainMode ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={explainMode}
            onClick={toggleExplain}
          >
            {t("commands.planner.explain")}
          </Button>
          <Button
            variant={sidePanel === "inspector" ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={sidePanel === "inspector"}
            onClick={() => setSidePanel((panel) => (panel === "inspector" ? null : "inspector"))}
          >
            {t("inspector.open")}
          </Button>
          {props.history === undefined ? null : (
            <Button
              variant={sidePanel === "history" ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={sidePanel === "history"}
              onClick={() => setSidePanel((panel) => (panel === "history" ? null : "history"))}
            >
              {t("history.panel.open")}
            </Button>
          )}
        </div>
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            sidePanel === null ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(18rem, 22rem)",
          gap: 12,
          alignItems: "start",
        }}
      >
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {audition === null ? null : <AuditionBar audition={audition} />}
          <div style={{ position: "relative", minWidth: 0 }}>
            <SongCanvasView
              document={canvasDoc}
              analysis={analysis}
              selection={selection}
              focus={focus}
              controller={controller}
              {...(props.renderer === undefined ? {} : { renderer: props.renderer })}
              onSelectionChange={props.onSelectionChange}
              onTrackToggle={onCanvasToggle}
              onSectionContextMenu={onSectionContextMenu}
              onSectionDragStart={drag.onSectionDragStart}
              onSectionDragMove={drag.onSectionDragMove}
              onSectionDragEnd={drag.onSectionDragEnd}
              onSectionDragCancel={drag.onSectionDragCancel}
              onSectionResizeStart={drag.onSectionResizeStart}
              onSectionResizeMove={drag.onSectionResizeMove}
              onSectionResizeEnd={drag.onSectionResizeEnd}
              onSectionResizeCancel={drag.onSectionResizeCancel}
              onPaintStart={paint.onPaintStart}
              onPaintMove={paint.onPaintMove}
              onPaintEnd={paint.onPaintEnd}
              onPaintCancel={paint.onPaintCancel}
              onLassoStart={onLassoStart}
              onLassoMove={onLassoStart}
              onLassoEnd={onLassoEnd}
              onLassoCancel={onLassoStart}
              onExplainAt={onExplainAt}
              explainMode={explainMode}
              lassoRegion={plannerOpen ? canvasLasso : null}
              lassoWaiting={plannerOpen && plannerPhase === "waiting"}
              highlights={canvasHighlights}
              onHoverTrack={(trackId) => {
                hovered.current = trackId;
              }}
              onViewport={(next: ZoomLevel, _viewport: Viewport) => setLevel(next)}
              onReady={(next) => {
                handle.current = next;
                next?.canvas.setTool(explainMode ? "select" : brushes.store.getState().tool);
                next?.canvas.setPaintStrength(brushes.store.getState().sizeStrength);
              }}
            />
            <PromptBar planner={planner} anchor={promptAnchor} />
          </div>
          <AccessibleGrid
            model={grid}
            selection={selection}
            onSelect={props.onSelectionChange}
            onToggle={(trackId, field) => toggleTrack(trackId, field)}
            onContextMenu={onGridContextMenu}
            onFocusChange={setFocus}
          />
          <TransportBar
            controller={controller}
            level={level}
            onZoomIn={() => handle.current?.zoomBy(1.5)}
            onZoomOut={() => handle.current?.zoomBy(1 / 1.5)}
            onFit={() => handle.current?.fit()}
          />
          <BrushPalette store={brushes} />
        </div>
        {sidePanel === "history" && props.history !== undefined ? (
          <HistoryPanel
            history={props.history}
            selection={selection}
            model={songStore.model}
            liveDoc={doc}
            onClose={() => setSidePanel(null)}
            onCommitOutcome={followHistory}
            {...(audition === null
              ? {}
              : { onCompare: (a: string, b: string) => void audition.openCompare(a, b) })}
          />
        ) : null}
        {sidePanel === "inspector" ? (
          <Inspector
            songStore={songStore}
            {...(props.history === undefined ? {} : { history: props.history })}
            onCommit={controller.commit}
            selection={selection}
            onClose={() => setSidePanel(null)}
            onAnnounce={setAnnouncement}
          />
        ) : null}
      </div>
      <ExplainPopover explanation={explanation} onClose={() => planner.closeExplanation()} />
      <SectionMenu
        anchor={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        commands={commandRegistry.list()}
        context={actions.context}
        smartTransitions={smartTransitions}
        onSmartTransitionsChange={actions.setSmartTransitions}
      />
      <CommandPaletteDialog
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        commands={commandRegistry.list()}
        context={actions.context}
      />
      <SectionActionDialogs
        dialog={actions.dialog}
        onClose={actions.closeDialog}
        onRename={actions.rename}
        onChangeKind={actions.changeKind}
        onResize={actions.resize}
      />
      {brushDialog !== null && brushSection !== null ? (
        <BrushApplyDialog
          key={`brush:${brushDialog.sectionId}`}
          section={brushSection}
          tracks={brushTracks}
          brush={brush}
          strength={brushStrength}
          direction={brushDirection}
          onClose={actions.closeDialog}
          onApply={(result) => {
            actions.applyBrush(
              brushDialog.sectionId,
              result.brush,
              result.trackIds,
              result.strength,
              result.direction,
            );
            actions.closeDialog();
          }}
        />
      ) : null}
      <SectionResizePopover
        prompt={drag.resizePrompt}
        onClose={drag.closeResizePrompt}
        onChoose={drag.chooseResizeMode}
      />
      <div className="sr-only" role="status" aria-live="polite" data-testid="live-region">
        {announcement}
      </div>
    </div>
  );
}
