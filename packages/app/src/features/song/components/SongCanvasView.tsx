/**
 * React's one job for the canvas (13 §3): mount the framework-agnostic {@link SongCanvas}, hand it
 * data, and turn its events back into callbacks. There is no React in the render loop
 * (07 §9): the playhead and meters are pushed from the transport store straight into the canvas,
 * not through component state.
 */
import {
  type AnalysisView,
  type CanvasDocument,
  type CanvasEvents,
  paletteFromReader,
  type Selection,
  SongCanvas,
  type Viewport,
  type ZoomLevel,
} from "@bragi/render-canvas";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { t } from "../../../i18n/index.js";
import type { EngineController } from "../state/engine-controller.js";

export interface SongCanvasHandle {
  readonly zoomBy: (factor: number) => void;
  readonly fit: () => void;
  readonly canvas: SongCanvas;
}

export interface SongCanvasViewProps {
  readonly document: CanvasDocument;
  readonly analysis: AnalysisView | null;
  readonly selection: Selection;
  readonly focus: { kind: "section" | "track"; id: string } | null;
  readonly controller: EngineController;
  /** `webgl` forces the WebGL2 renderer (13 §6 "WebGPU off"). */
  readonly renderer?: "webgpu" | "webgl";
  readonly onSelectionChange: (selection: Selection) => void;
  readonly onTrackToggle: (event: CanvasEvents["trackToggle"]) => void;
  readonly onSectionContextMenu: (event: CanvasEvents["sectionContextMenu"]) => void;
  readonly onSectionDragStart: (event: CanvasEvents["sectionDragStart"]) => void;
  readonly onSectionDragMove: (event: CanvasEvents["sectionDragMove"]) => void;
  readonly onSectionDragEnd: (event: CanvasEvents["sectionDragEnd"]) => void;
  readonly onSectionDragCancel: (event: CanvasEvents["sectionDragCancel"]) => void;
  readonly onSectionResizeStart: (event: CanvasEvents["sectionResizeStart"]) => void;
  readonly onSectionResizeMove: (event: CanvasEvents["sectionResizeMove"]) => void;
  readonly onSectionResizeEnd: (event: CanvasEvents["sectionResizeEnd"]) => void;
  readonly onSectionResizeCancel: (event: CanvasEvents["sectionResizeCancel"]) => void;
  readonly onPaintStart: (event: CanvasEvents["paintStart"]) => void;
  readonly onPaintMove: (event: CanvasEvents["paintMove"]) => void;
  readonly onPaintEnd: (event: CanvasEvents["paintEnd"]) => void;
  readonly onPaintCancel: (event: CanvasEvents["paintCancel"]) => void;
  readonly onHoverTrack: (trackId: string | null) => void;
  readonly onViewport: (level: ZoomLevel, viewport: Viewport) => void;
  /** Receives the live canvas once it exists (and `null` when it is destroyed). */
  readonly onReady?: (handle: SongCanvasHandle | null) => void;
}

function readTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function readsReducedMotion(): boolean {
  return (
    document.documentElement.dataset.motion === "reduced" ||
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** A rem-based text scale so lanes grow with the user's text size (11 §6.4). */
function readUiScale(): number {
  const px = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(px) && px > 0 ? Math.max(1, px / 16) : 1;
}

function buildPalette() {
  const style = getComputedStyle(document.documentElement);
  const fontSans = style.getPropertyValue("--font-sans").trim() || "system-ui, sans-serif";
  return paletteFromReader((name) => style.getPropertyValue(name), readTheme(), fontSans);
}

async function fontsReady(): Promise<void> {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load("500 12px Geist"),
        document.fonts.load("400 12px Geist"),
        document.fonts.ready,
      ]),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
  } catch {
    // No font loading API: the fallback font is used, which is fine.
  }
}

export function SongCanvasView(props: SongCanvasViewProps): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<SongCanvas | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  // Create and destroy. `alive` guards React StrictMode's double mount and a slow GPU init.
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let alive = true;
    let created: SongCanvas | null = null;
    const observers: (() => void)[] = [];
    void (async () => {
      await fontsReady();
      if (!alive) return;
      try {
        const next = await SongCanvas.create({
          container,
          palette: buildPalette(),
          strings: {
            mute: t("song.canvas.muteLetter"),
            solo: t("song.canvas.soloLetter"),
            barsLonger: (bars) =>
              t(bars === 1 ? "song.canvas.barsLonger.one" : "song.canvas.barsLonger.other", {
                count: bars,
              }),
            barsShorter: (bars) =>
              t(bars === 1 ? "song.canvas.barsShorter.one" : "song.canvas.barsShorter.other", {
                count: bars,
              }),
          },
          ...(latest.current.renderer === undefined ? {} : { renderer: latest.current.renderer }),
          width: Math.max(320, container.clientWidth),
          uiScale: readUiScale(),
          reducedMotion: readsReducedMotion(),
        });
        if (!alive) {
          next.destroy();
          return;
        }
        created = next;
        observers.push(
          next.on("selectionChange", (selection) => latest.current.onSelectionChange(selection)),
          next.on("seek", ({ sec }) => latest.current.controller.seek(sec)),
          next.on("trackToggle", (event) => latest.current.onTrackToggle(event)),
          next.on("sectionContextMenu", (event) => {
            // Focus the canvas first, so closing the menu returns focus here.
            host.current?.focus();
            latest.current.onSectionContextMenu(event);
          }),
          next.on("sectionDragStart", (event) => latest.current.onSectionDragStart(event)),
          next.on("sectionDragMove", (event) => latest.current.onSectionDragMove(event)),
          next.on("sectionDragEnd", (event) => latest.current.onSectionDragEnd(event)),
          next.on("sectionDragCancel", (event) => latest.current.onSectionDragCancel(event)),
          next.on("sectionResizeStart", (event) => latest.current.onSectionResizeStart(event)),
          next.on("sectionResizeMove", (event) => latest.current.onSectionResizeMove(event)),
          next.on("sectionResizeEnd", (event) => latest.current.onSectionResizeEnd(event)),
          next.on("sectionResizeCancel", (event) => latest.current.onSectionResizeCancel(event)),
          next.on("paintStart", (event) => latest.current.onPaintStart(event)),
          next.on("paintMove", (event) => latest.current.onPaintMove(event)),
          next.on("paintEnd", (event) => latest.current.onPaintEnd(event)),
          next.on("paintCancel", (event) => latest.current.onPaintCancel(event)),
          next.on("hoverTrack", ({ trackId }) => latest.current.onHoverTrack(trackId)),
          next.on("viewportChange", ({ level, viewport }) =>
            latest.current.onViewport(level, viewport),
          ),
        );
        const resize = new ResizeObserver(() => next.resize(Math.max(320, container.clientWidth)));
        resize.observe(container);
        observers.push(() => resize.disconnect());
        const motion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
        const onMotion = (): void => next.setReducedMotion(readsReducedMotion());
        motion?.addEventListener("change", onMotion);
        observers.push(() => motion?.removeEventListener("change", onMotion));
        setCanvas(next);
        latest.current.onReady?.({
          canvas: next,
          zoomBy: (factor) => next.zoomBy(factor),
          fit: () => next.fit(),
        });
      } catch (error) {
        console.error("could not start the song canvas", error);
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      for (const undo of observers) undo();
      latest.current.onReady?.(null);
      created?.destroy();
      setCanvas(null);
    };
  }, []);

  useEffect(() => {
    canvas?.setDocument(props.document);
  }, [canvas, props.document]);
  useEffect(() => {
    canvas?.setAnalysis(props.analysis);
  }, [canvas, props.analysis]);
  useEffect(() => {
    canvas?.setSelection(props.selection);
  }, [canvas, props.selection]);
  useEffect(() => {
    canvas?.setFocus(props.focus);
  }, [canvas, props.focus]);

  // The playhead and meters bypass React state: the store pushes straight into the canvas.
  useEffect(() => {
    if (!canvas) return;
    const apply = (state: ReturnType<typeof props.controller.store.getState>): void => {
      canvas.setPlaying(state.playing);
      canvas.setPlayhead(state.positionSec);
      canvas.setMeters(state.meters);
    };
    apply(props.controller.store.getState());
    return props.controller.store.subscribe(apply);
  }, [canvas, props.controller]);

  return (
    <div
      className="song-canvas"
      ref={host}
      data-testid="song-canvas"
      tabIndex={-1}
      onPointerDown={() => host.current?.focus()}
    >
      {failed ? (
        <p role="alert" data-testid="song-canvas-failed">
          {t("song.canvas.failed")} {t("song.canvas.fallback")}
        </p>
      ) : null}
    </div>
  );
}
