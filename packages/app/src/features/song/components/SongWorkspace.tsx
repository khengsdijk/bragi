/**
 * The Song Canvas feature root: the canvas, its accessible grid and the transport bar, wired to
 * the Song Store and the engine controller (07 §1).
 *
 * Data flows one way: the Song Store holds the document; this component derives the canvas view
 * (`buildCanvasDocument`) and the grid (`buildGridModel`) from it and from the analysis that has
 * arrived. Gestures flow back as op batches into the Song Store, and each commit is forwarded to
 * the engine, so what you see, what a screen reader gets and what you hear are one document.
 */
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
import { buildGridModel } from "../api/grid-model.js";
import { analysisView, buildCanvasDocument } from "../api/view-model.js";
import type { EngineController } from "../state/engine-controller.js";
import { trackToggleBatch } from "../state/ops.js";
import type { SongStore } from "../state/song-store.js";
import { AccessibleGrid, type GridFocus } from "./AccessibleGrid.js";
import { type SongCanvasHandle, SongCanvasView } from "./SongCanvasView.js";
import { formatTime, TransportBar } from "./TransportBar.js";

/** The analysis data that has arrived (stages come from the document). */
export type AnalysisData = Omit<AnalysisView, "stages">;

export interface SongWorkspaceProps {
  readonly songStore: SongStore;
  readonly controller: EngineController;
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
  const handle = useRef<SongCanvasHandle | null>(null);
  const hovered = useRef<string | null>(null);
  const selection = props.selection;

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

  const toggleTrack = useCallback(
    (trackId: string, field: "mute" | "solo", value?: boolean) => {
      const current = songStore.store.getState().doc;
      if (current === null) return;
      const track = current.tracks.find((candidate) => candidate.id === trackId);
      if (!track) return;
      const batch = trackToggleBatch(current, trackId, field, value ?? !track[field]);
      if (batch === null) return;
      const outcome = songStore.apply(batch);
      if (outcome.ok) {
        controller.commit(outcome.commit, outcome.doc);
        setAnnouncement(batch.label);
      } else {
        setAnnouncement(t("song.live.rejected"));
      }
    },
    [songStore, controller],
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
    } as BragiTestHooks;
    return () => {
      window.__bragi = undefined;
    };
  }, [props.testHooks, songStore, controller]);

  // Global shortcuts (07 §3). The grid handles M and O itself when it has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
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
  }, [controller, toggleTrack, props.onSelectionChange]);

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
      </header>
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
      <div className="sr-only" role="status" aria-live="polite" data-testid="live-region">
        {announcement}
      </div>
    </div>
  );
}
