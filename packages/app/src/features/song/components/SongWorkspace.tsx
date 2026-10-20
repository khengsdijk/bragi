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
  Selection,
  Viewport,
  ZoomLevel,
} from "@bragi/render-canvas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import { t } from "../../../i18n/index.js";
import { HistoryPanel } from "../../history/components/HistoryPanel.js";
import type { History } from "../../history/state/history.js";
import { Inspector } from "../../inspector/components/Inspector.js";
import { buildGridModel } from "../api/grid-model.js";
import { analysisView, buildCanvasDocument } from "../api/view-model.js";
import type { EngineController } from "../state/engine-controller.js";
import { trackToggleBatch } from "../state/ops.js";
import type { ApplyOutcome, SongStore } from "../state/song-store.js";
import { AccessibleGrid, type GridFocus } from "./AccessibleGrid.js";
import { type SongCanvasHandle, SongCanvasView } from "./SongCanvasView.js";
import { formatTime, TransportBar } from "./TransportBar.js";

/** The analysis data that has arrived (stages come from the document). */
export type AnalysisData = Omit<AnalysisView, "stages">;

export interface SongWorkspaceProps {
  readonly songStore: SongStore;
  readonly controller: EngineController;
  /** The open project's version tree; absent for the demo, which has no project row. */
  readonly history?: History;
  /** Energy, chords and ribbon data; `null` before any of it has arrived (WP-1.10 feeds this). */
  readonly analysis: AnalysisData | null;
  readonly selection: Selection;
  readonly onSelectionChange: (selection: Selection) => void;
  readonly renderer?: "webgpu" | "webgl";
  /** Exposes the canvas on `window.__bragi` for the end-to-end tests. */
  readonly testHooks?: boolean;
}

/** What the e2e tests reach through `window.__bragi`. */
export interface BragiTestHooks {
  canvas: SongCanvasHandle["canvas"] | null;
  store: SongStore;
  controller: EngineController;
  history: History | null;
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

export function SongWorkspace(props: SongWorkspaceProps) {
  const { songStore, controller } = props;
  const doc = useStore(songStore.store, (state) => state.doc);
  const [level, setLevel] = useState<ZoomLevel>("L2");
  const [focus, setFocus] = useState<GridFocus | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /** One side panel at a time: the Inspector or the version tree. */
  const [sidePanel, setSidePanel] = useState<"inspector" | "history" | null>(null);
  const handle = useRef<SongCanvasHandle | null>(null);
  const hovered = useRef<string | null>(null);
  const selection = props.selection;
  const selectedTrack =
    selection.kind === "tracks" && selection.ids.length === 1 ? (selection.ids[0] ?? null) : null;

  // Selecting one ribbon opens the Inspector (07 §4.5). Closing it does not reopen it until
  // another instrument is selected; with nothing selected it stays open as the master inspector.
  useEffect(() => {
    if (selectedTrack !== null) setSidePanel("inspector");
  }, [selectedTrack]);

  const canvasDoc = useMemo(() => {
    const live = songStore.handle();
    if (doc === null || live === null) return null;
    return buildCanvasDocument(songStore.model, live, doc);
    // `doc` is replaced, never mutated, on every load and commit: it is the cache key.
  }, [songStore, doc]);

  const analysis = useMemo<AnalysisView | null>(
    () => (doc === null ? null : analysisView(doc, props.analysis)),
    [doc, props.analysis],
  );
  const grid = useMemo(
    () => (canvasDoc === null ? null : buildGridModel(canvasDoc, analysis)),
    [canvasDoc, analysis],
  );

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

  /** Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z (07 §4); the command is announced for screen readers. */
  const undoOrRedo = useCallback(
    (redo: boolean) => {
      const history = props.history;
      if (history === undefined) return;
      const state = history.store.getState();
      const targetId = redo ? state.redo.at(-1) : (state.head ?? undefined);
      const label = targetId === undefined ? "" : (state.commits.get(targetId)?.label ?? "");
      void (redo ? history.redo() : history.undo())
        .then((outcome) => {
          if (outcome === null || !outcome.ok) return;
          controller.commit(outcome.commit, outcome.doc);
          if (label !== "") {
            setAnnouncement(t(redo ? "history.redo" : "history.undo", { label }));
          }
        })
        .catch((cause: unknown) => {
          console.warn("could not move HEAD", cause);
        });
    },
    [props.history, controller],
  );

  const onCanvasToggle = useCallback(
    (event: CanvasEvents["trackToggle"]) => toggleTrack(event.trackId, event.field, event.value),
    [toggleTrack],
  );

  useEffect(() => {
    if (!props.testHooks) return;
    window.__bragi = {
      get canvas() {
        return handle.current?.canvas ?? null;
      },
      store: songStore,
      controller,
      history: props.history ?? null,
    } as BragiTestHooks;
    return () => {
      window.__bragi = undefined;
    };
  }, [props.testHooks, songStore, controller, props.history]);

  // Global shortcuts (07 §3). The grid handles M and O itself when it has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      // Undo/redo live on the platform modifier; other shortcuts stay unmodified.
      if (event.metaKey || event.ctrlKey) {
        if (!event.altKey && event.key.toLowerCase() === "z" && props.history !== undefined) {
          event.preventDefault();
          undoOrRedo(event.shiftKey);
        }
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
        case "Escape":
          props.onSelectionChange({ kind: "none" });
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller, toggleTrack, undoOrRedo, props.history, props.onSelectionChange]);

  if (canvasDoc === null || grid === null || analysis === null) {
    return <p data-testid="song-loading">{t("song.canvas.loading")}</p>;
  }

  const selectionText =
    selection.kind === "sections"
      ? t("song.selection.parts", { count: selection.ids.length })
      : selection.kind === "tracks"
        ? t("song.selection.instruments", { count: selection.ids.length })
        : t("song.selection.whole");

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
          <SongCanvasView
            document={canvasDoc}
            analysis={analysis}
            selection={selection}
            focus={focus}
            controller={controller}
            {...(props.renderer === undefined ? {} : { renderer: props.renderer })}
            onSelectionChange={props.onSelectionChange}
            onTrackToggle={onCanvasToggle}
            onHoverTrack={(trackId) => {
              hovered.current = trackId;
            }}
            onViewport={(next: ZoomLevel, _viewport: Viewport) => setLevel(next)}
            onReady={(next) => {
              handle.current = next;
            }}
          />
          <AccessibleGrid
            model={grid}
            selection={selection}
            onSelect={props.onSelectionChange}
            onToggle={(trackId, field) => toggleTrack(trackId, field)}
            onFocusChange={setFocus}
          />
          <TransportBar
            controller={controller}
            level={level}
            onZoomIn={() => handle.current?.zoomBy(1.5)}
            onZoomOut={() => handle.current?.zoomBy(1 / 1.5)}
            onFit={() => handle.current?.fit()}
          />
        </div>
        {sidePanel === "history" && props.history !== undefined ? (
          <HistoryPanel
            history={props.history}
            selection={selection}
            model={songStore.model}
            liveDoc={doc}
            onClose={() => setSidePanel(null)}
            onCommitOutcome={followHistory}
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
      <div className="sr-only" role="status" aria-live="polite" data-testid="live-region">
        {announcement}
      </div>
    </div>
  );
}
