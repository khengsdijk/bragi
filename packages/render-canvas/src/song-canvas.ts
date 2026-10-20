/**
 * The Song Canvas: one PixiJS stage (07 §1, §9).
 *
 * Layers, bottom to top (07 §9): beat grid, skyline, section blocks, harmony strip, ribbons, then
 * overlays (selection, focus, shimmer) and the playhead. The label gutter sits above the
 * scrolling lanes so panned content never shows under the ribbon names.
 *
 * Rendering strategy:
 *
 * - **Meshes in world space.** Ribbons and the skyline are built once per level of detail, in a
 *   fixed world scale, and panning/zooming only moves and scales their container. They are rebuilt
 *   when the zoom leaves a factor-of-two band around the build scale or the viewport leaves the
 *   built window (the viewport plus one screen either side), and at most `REBUILD_BUDGET` ribbons
 *   per frame so a hard zoom never costs a long frame.
 * - **Cheap layers are redrawn on change.** The grid, section blocks, harmony strip and labels are
 *   a few dozen shapes; they are redrawn whenever the viewport, document, analysis or selection
 *   change, with pooled `Text`.
 * - **Render on demand.** The loop only runs while playing, animating or dirty, so an idle song
 *   costs nothing.
 *
 * The class holds no document and never mutates one: solo/mute leave as `trackToggle` events.
 * Framework-agnostic by rule (13 §3): no React here.
 */

import { roleTokenOf, sectionFamilyOf } from "@bragi/design/tokens";
// The page runs under a strict CSP without 'unsafe-eval' (01 §10); this patches Pixi's shader
// uniform sync so it does not compile code with `new Function`.
import "pixi.js/unsafe-eval";
import {
  Application,
  BufferImageSource,
  Container,
  FillGradient,
  Graphics,
  Mesh,
  MeshGeometry,
  Texture,
} from "pixi.js";

import {
  advanceSectionDrag,
  barDeltaLabel,
  beginSectionDrag,
  dropSlotAt,
  IDLE_DRAG,
  resizeTargetBars,
  type SectionDragState,
} from "./drag.js";
import {
  activityMask,
  buildRibbonStrip,
  buildWaveformStrip,
  type CullWindow,
  cullWindow,
  gridLines,
  type RibbonStrip,
  resampleCurve,
  ribbonTexturePixels,
  skylineOutline,
  windowCovers,
} from "./geometry.js";
import { LabelPool } from "./label-pool.js";
import {
  computeLayout,
  hitTest,
  type Layout,
  type Rect,
  sectionAtPoint,
  sectionHitAt,
} from "./layout.js";
import { chordFill, mixColors, numberToRgb, type Palette, readableOn } from "./palette.js";
import {
  appeared,
  type LayerName,
  type LayerState,
  layerStates,
  shimmerPhase,
} from "./progressive.js";
import { clickSelection, isSelected, NO_SELECTION } from "./selection.js";
import type {
  AnalysisView,
  CanvasDocument,
  CanvasEventName,
  CanvasEvents,
  CanvasTrack,
  Curve,
  Selection,
  Viewport,
  ZoomLevel,
} from "./types.js";
import {
  clampViewport,
  fitSong,
  lodBinsPerSecond,
  panBy,
  pxPerSecond,
  revealTime,
  timeToX,
  xToTime,
  zoomAt,
  zoomLevel,
} from "./viewport.js";

/** Strings the canvas draws itself; the app supplies them from `en.json` (13 §3). */
export interface CanvasStrings {
  readonly mute: string;
  readonly solo: string;
  /** "+8 bars" for the resize ghost; the app pluralises it. */
  readonly barsLonger: (bars: number) => string;
  /** "−2 bars" for the resize ghost. */
  readonly barsShorter: (bars: number) => string;
}

export interface SongCanvasOptions {
  /** Where the `<canvas>` is appended. */
  readonly container: HTMLElement;
  readonly palette: Palette;
  readonly strings: CanvasStrings;
  /** `webgl` forces the WebGL2 renderer (13 §6 "WebGPU off"); default tries WebGPU first. */
  readonly renderer?: "webgpu" | "webgl";
  /** Text size multiplier; lanes grow with it (11 §6.4). */
  readonly uiScale?: number;
  /** Reduced motion (11 §3): no shimmer sweep, no unweave, no glow. */
  readonly reducedMotion?: boolean;
  readonly width?: number;
  /** Device pixel ratio; default `devicePixelRatio`. Fixed by the snapshot tests. */
  readonly resolution?: number;
}

type Handler<K extends CanvasEventName> = (event: CanvasEvents[K]) => void;

/** Render statistics for the performance budget (07 §9). */
export interface CanvasStats {
  readonly renderer: "webgpu" | "webgl" | "canvas";
  readonly frames: number;
  /** CPU time of the last `renderer.render` call, in ms. */
  readonly lastRenderMs: number;
  /** Worst CPU render time over the last 120 frames, in ms. */
  readonly worstRenderMs: number;
  /** Mean CPU render time over the last 120 frames, in ms. */
  readonly meanRenderMs: number;
  readonly ribbonRebuilds: number;
}

const REBUILD_BUDGET = 3;
const APPEAR_MS = 600;
const MAX_BINS = 8000;
const GHOST_LANES = 4;
const GHOST_PREFIX = "__pending_";

interface RibbonView {
  readonly trackId: string;
  readonly container: Container;
  mesh: Mesh | null;
  texture: Texture | null;
  geometry: MeshGeometry | null;
  /** The world scale (px per second) the mesh was built at. */
  builtPps: number;
  builtWindow: CullWindow | null;
  builtKey: string;
  builtLevel: ZoomLevel;
  readonly glow: Graphics;
}

interface Anim {
  readonly start: number;
}

/** What the canvas draws while a section is being moved or resized (07 §4.1–4.2). */
interface DragVisual {
  readonly sectionId: string;
  readonly mode: "move" | "resize";
  /** The span the block had when the drag started. */
  readonly startSec: number;
  readonly endSec: number;
  /** The block's length in whole bars at drag start. */
  readonly bars: number;
  /** Pointer offset into the block, so a move does not jump to the pointer. */
  readonly grabOffsetX: number;
  pointerX: number;
  /** The target length in whole bars, for the resize ghost. */
  targetBars: number;
}

export class SongCanvas {
  private readonly app: Application;
  private readonly options: SongCanvasOptions;
  private readonly listeners = new Map<CanvasEventName, Set<(event: never) => void>>();

  private readonly gridG = new Graphics();
  private readonly skylineWorld = new Container();
  private skylineG = new Graphics();
  private readonly targetG = new Graphics();
  private readonly sectionsG = new Graphics();
  private readonly harmonyG = new Graphics();
  private readonly ribbonsLayer = new Container();
  private readonly gutterG = new Graphics();
  private readonly overlayG = new Graphics();
  private readonly playheadG = new Graphics();
  private readonly labelsLayer = new Container();
  private readonly sectionLabels: LabelPool;
  private readonly harmonyLabels: LabelPool;
  private readonly gutterLabels: LabelPool;
  private readonly rulerLabels: LabelPool;

  private palette: Palette;
  private doc: CanvasDocument | null = null;
  private analysis: AnalysisView | null = null;
  private selection: Selection = NO_SELECTION;
  private focus: { kind: "section" | "track"; id: string } | null = null;
  private viewport: Viewport = { pxPerBeat: 8, originSec: 0 };
  private layout: Layout;
  private width: number;
  private uiScale: number;
  private reducedMotion: boolean;
  private playheadSec = 0;
  private playing = false;
  private follow = true;
  private meters: Readonly<Record<string, number>> = {};
  private hoverTrack: string | null = null;
  private hoverSection: string | null = null;

  /** Click-versus-drag state (11 §6.4) and the visuals drawn while it is active. */
  private dragState: SectionDragState = IDLE_DRAG;
  private dragVisual: DragVisual | null = null;
  /** The arrangement at drag start, so the drop slot does not move under the preview. */
  private dragDoc: CanvasDocument | null = null;

  private readonly ribbons = new Map<string, RibbonView>();
  private clipsByTrack = new Map<string, { startSec: number; endSec: number }[]>();
  private visibleTracks: CanvasTrack[] = [];
  private sectionEnergy = new Map<string, number>();
  private repeatGlyphs = new Map<string, number>();
  private readonly graveyard: { destroy(arg?: boolean): void }[] = [];
  private readonly appearing = new Map<string, Anim>();
  private previousIds: readonly string[] = [];

  private skylineBuilt: { pps: number; window: CullWindow; key: string; level: ZoomLevel } | null =
    null;
  private skylineGradient: FillGradient | null = null;

  private docVersion = 0;
  private analysisVersion = 0;
  private layoutDirty = true;
  private chromeDirty = true;
  private raf = 0;
  private destroyed = false;
  private fitPending = true;

  private frames = 0;
  private lastRenderMs = 0;
  private readonly recent: number[] = [];
  private rebuilds = 0;
  private readonly dispose: (() => void)[] = [];

  private constructor(app: Application, options: SongCanvasOptions) {
    this.app = app;
    this.options = options;
    this.palette = options.palette;
    this.width = options.width ?? 960;
    this.uiScale = options.uiScale ?? 1;
    this.reducedMotion = options.reducedMotion ?? false;
    this.layout = computeLayout({
      width: this.width,
      trackIds: [],
      level: "L2",
      uiScale: this.uiScale,
    });
    const resolution = app.renderer.resolution;
    this.sectionLabels = new LabelPool(this.labelsLayer, this.palette.fontSans, resolution);
    this.harmonyLabels = new LabelPool(this.labelsLayer, this.palette.fontSans, resolution);
    this.gutterLabels = new LabelPool(this.labelsLayer, this.palette.fontSans, resolution);
    this.rulerLabels = new LabelPool(this.labelsLayer, this.palette.fontSans, resolution);
    this.skylineWorld.addChild(this.skylineG);
    const stage = app.stage;
    stage.addChild(
      this.gridG,
      this.skylineWorld,
      this.targetG,
      this.sectionsG,
      this.harmonyG,
      this.ribbonsLayer,
      this.gutterG,
      this.overlayG,
      this.labelsLayer,
      this.playheadG,
    );
    this.attachInput();
  }

  /** Creates the stage. Async because Pixi initialises the GPU backend. */
  static async create(options: SongCanvasOptions): Promise<SongCanvas> {
    const app = new Application();
    const preference = options.renderer === "webgl" ? ["webgl"] : ["webgpu", "webgl"];
    await app.init({
      width: options.width ?? 960,
      height: 320,
      preference: preference as ("webgl" | "webgpu")[],
      antialias: true,
      background: options.palette.canvas,
      resolution: options.resolution ?? globalThis.devicePixelRatio ?? 1,
      autoDensity: true,
      autoStart: false,
      sharedTicker: false,
      powerPreference: "high-performance",
    });
    app.ticker.stop();
    const element = app.canvas;
    element.style.display = "block";
    element.style.touchAction = "pan-y";
    element.setAttribute("aria-hidden", "true");
    options.container.append(element);
    return new SongCanvas(app, options);
  }

  /** Which backend actually rendered: the answer to "was WebGPU on?" in the snapshot tests. */
  get rendererName(): "webgpu" | "webgl" | "canvas" {
    const name = this.app.renderer.name;
    return name === "webgpu" || name === "webgl" ? name : "canvas";
  }

  /** The `<canvas>` element, for screenshots and tests. */
  get element(): HTMLCanvasElement {
    return this.app.canvas;
  }

  // ---- data in -----------------------------------------------------------------------------

  /** Sets the arrangement. Cheap to call on every document change. */
  setDocument(doc: CanvasDocument): void {
    const previousDoc = this.doc;
    this.doc = doc;
    this.docVersion += 1;
    this.visibleTracks = doc.tracks.filter((track) => !track.hidden);
    this.clipsByTrack = new Map();
    for (const clip of doc.clips) {
      const list = this.clipsByTrack.get(clip.trackId) ?? [];
      list.push({ startSec: clip.startSec, endSec: clip.endSec });
      this.clipsByTrack.set(clip.trackId, list);
    }
    this.repeatGlyphs = new Map();
    for (const section of doc.sections) {
      if (section.repeatGroup !== undefined && !this.repeatGlyphs.has(section.repeatGroup)) {
        this.repeatGlyphs.set(section.repeatGroup, this.repeatGlyphs.size % 3);
      }
    }
    const ids = [
      ...doc.sections.map((s) => s.id),
      ...doc.tracks.filter((t) => !t.hidden).map((t) => t.id),
    ];
    if (previousDoc !== null && !this.reducedMotion) {
      const now = performance.now();
      for (const id of appeared(this.previousIds, ids)) this.appearing.set(id, { start: now });
    }
    this.previousIds = ids;
    this.recomputeSectionEnergy();
    this.syncRibbonViews();
    if (this.fitPending && doc.durationSec > 0) {
      this.viewport = fitSong(doc.bpm, doc.durationSec, this.timeWidth());
      this.fitPending = false;
      this.emitViewport();
    } else {
      this.viewport = clampViewport(this.viewport, doc.bpm, doc.durationSec, this.timeWidth());
    }
    this.layoutDirty = true;
    this.chromeDirty = true;
    this.schedule();
  }

  /** Sets the analysis that has arrived so far. */
  setAnalysis(analysis: AnalysisView | null): void {
    this.analysis = analysis;
    this.analysisVersion += 1;
    this.recomputeSectionEnergy();
    this.layoutDirty = true;
    this.chromeDirty = true;
    this.schedule();
  }

  /** The playhead, in seconds. Cheap: moves one line. */
  setPlayhead(sec: number): void {
    this.playheadSec = sec;
    if (this.playing && this.follow && this.doc) {
      const next = revealTime(
        this.viewport,
        this.doc.bpm,
        this.doc.durationSec,
        this.timeWidth(),
        sec,
      );
      if (next !== this.viewport) this.applyViewport(next);
    }
    this.schedule();
  }

  /** Playing keeps the render loop running and the view following the playhead. */
  setPlaying(playing: boolean): void {
    this.playing = playing;
    this.schedule();
  }

  /** Live meter levels by track id, 0..1: the ribbon glow at the playhead (07 §2). */
  setMeters(levels: Readonly<Record<string, number>>): void {
    this.meters = levels;
    this.schedule();
  }

  setSelection(selection: Selection): void {
    this.selection = selection;
    this.chromeDirty = true;
    this.schedule();
  }

  /** The element with keyboard focus in the accessible grid; drawn as a focus ring (11 §6.1). */
  setFocus(focus: { kind: "section" | "track"; id: string } | null): void {
    this.focus = focus;
    this.chromeDirty = true;
    this.schedule();
  }

  setPalette(palette: Palette): void {
    this.palette = palette;
    this.app.renderer.background.color = palette.canvas;
    this.skylineGradient = null;
    this.skylineBuilt = null;
    this.invalidateRibbons();
    this.chromeDirty = true;
    this.schedule();
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.appearing.clear();
    this.schedule();
  }

  setUiScale(scale: number): void {
    this.uiScale = scale;
    this.layoutDirty = true;
    this.chromeDirty = true;
    this.schedule();
  }

  /** Resizes to a CSS width; the height follows from the number of ribbons. */
  resize(width: number): void {
    if (width <= 0 || width === this.width) return;
    this.width = width;
    if (this.doc) {
      this.viewport = clampViewport(
        this.viewport,
        this.doc.bpm,
        this.doc.durationSec,
        this.timeWidth(),
      );
    }
    this.layoutDirty = true;
    this.chromeDirty = true;
    this.schedule();
  }

  // ---- viewport ----------------------------------------------------------------------------

  getViewport(): Viewport {
    return this.viewport;
  }

  getLevel(): ZoomLevel {
    return zoomLevel(this.viewport.pxPerBeat);
  }

  setViewport(viewport: Viewport): void {
    if (!this.doc) return;
    this.applyViewport(
      clampViewport(viewport, this.doc.bpm, this.doc.durationSec, this.timeWidth()),
    );
  }

  zoomBy(factor: number, anchorX?: number): void {
    if (!this.doc) return;
    const anchor = anchorX ?? this.timeWidth() / 2;
    this.applyViewport(
      zoomAt(this.viewport, this.doc.bpm, this.doc.durationSec, this.timeWidth(), factor, anchor),
    );
  }

  panByPx(dx: number): void {
    if (!this.doc) return;
    this.applyViewport(
      panBy(this.viewport, this.doc.bpm, this.doc.durationSec, this.timeWidth(), dx),
    );
  }

  /** Fits the whole song (key `F`). */
  fit(): void {
    if (!this.doc) return;
    this.applyViewport(fitSong(this.doc.bpm, this.doc.durationSec, this.timeWidth()));
  }

  // ---- events ------------------------------------------------------------------------------

  on<K extends CanvasEventName>(name: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(handler as (event: never) => void);
    return () => set.delete(handler as (event: never) => void);
  }

  private emit<K extends CanvasEventName>(name: K, event: CanvasEvents[K]): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const handler of set) (handler as Handler<K>)(event);
  }

  // ---- rendering ---------------------------------------------------------------------------

  /** Renders one frame now. The snapshot and performance tests call this directly. */
  renderNow(): void {
    if (this.destroyed) return;
    this.update(performance.now());
    const start = performance.now();
    this.app.render();
    const elapsed = performance.now() - start;
    this.lastRenderMs = elapsed;
    this.recent.push(elapsed);
    if (this.recent.length > 120) this.recent.shift();
    this.frames += 1;
    this.emptyGraveyard();
  }

  /** Rebuilds every pending piece of geometry (not just the per-frame budget) and renders. */
  settle(): void {
    for (let i = 0; i < 64; i += 1) {
      this.renderNow();
      if (!this.needsMoreRebuilds()) break;
    }
  }

  stats(): CanvasStats {
    const sum = this.recent.reduce((a, b) => a + b, 0);
    return {
      renderer: this.rendererName,
      frames: this.frames,
      lastRenderMs: this.lastRenderMs,
      worstRenderMs: this.recent.length === 0 ? 0 : Math.max(...this.recent),
      meanRenderMs: this.recent.length === 0 ? 0 : sum / this.recent.length,
      ribbonRebuilds: this.rebuilds,
    };
  }

  resetStats(): void {
    this.recent.length = 0;
    this.frames = 0;
  }

  /**
   * Diagnostic for the tests: the share of pixels that differ from the background colour, or
   * `null` when the backend cannot read pixels back synchronously. A blank canvas is 0.
   */
  coverage(): number | null {
    try {
      this.renderNow();
      const { pixels } = this.app.renderer.extract.pixels(this.app.stage);
      const [r, g, b] = numberToRgb(this.palette.canvas);
      let different = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          Math.abs((pixels[index] ?? 0) - r) > 6 ||
          Math.abs((pixels[index + 1] ?? 0) - g) > 6 ||
          Math.abs((pixels[index + 2] ?? 0) - b) > 6
        ) {
          different += 1;
        }
      }
      return different / (pixels.length / 4);
    } catch {
      return null;
    }
  }

  /** Which progressive layers are live, pending or failed right now (07 §8). */
  layerStates(): Record<LayerName, LayerState> | null {
    return this.doc ? layerStates(this.doc, this.analysis) : null;
  }

  /** The current layout, so the DOM overlay can position things from the renderer's coordinates. */
  getLayout(): Layout {
    return this.layout;
  }

  /** The section under a point in canvas CSS pixels, or `null`. */
  sectionAt(x: number, y: number): string | null {
    if (!this.doc) return null;
    return sectionAtPoint(this.layout, this.viewport, this.doc, x, y);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const undo of this.dispose) undo();
    for (const view of this.ribbons.values()) this.destroyRibbonMesh(view);
    this.sectionLabels.destroy();
    this.harmonyLabels.destroy();
    this.gutterLabels.destroy();
    this.rulerLabels.destroy();
    this.app.destroy({ removeView: true }, { children: true, texture: true });
  }

  // ---- internals ---------------------------------------------------------------------------

  private timeWidth(): number {
    return Math.max(1, this.width - this.layout.gutter);
  }

  private applyViewport(next: Viewport): void {
    if (next.pxPerBeat === this.viewport.pxPerBeat && next.originSec === this.viewport.originSec) {
      return;
    }
    if (zoomLevel(next.pxPerBeat) !== zoomLevel(this.viewport.pxPerBeat)) this.layoutDirty = true;
    this.viewport = next;
    this.chromeDirty = true;
    this.emitViewport();
    this.schedule();
  }

  private emitViewport(): void {
    this.emit("viewportChange", {
      viewport: this.viewport,
      level: zoomLevel(this.viewport.pxPerBeat),
    });
  }

  private schedule(): void {
    if (this.destroyed || this.raf) return;
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      this.frame(now);
    });
  }

  private frame(now: number): void {
    const animating = this.update(now);
    const start = performance.now();
    this.app.render();
    const elapsed = performance.now() - start;
    this.lastRenderMs = elapsed;
    this.recent.push(elapsed);
    if (this.recent.length > 120) this.recent.shift();
    this.frames += 1;
    this.emptyGraveyard();
    if (this.playing || animating || this.needsMoreRebuilds()) this.schedule();
  }

  /** Per-frame work. Returns whether animation needs another frame. */
  private update(now: number): boolean {
    const doc = this.doc;
    let animating = false;
    for (const [id, anim] of this.appearing) {
      if (now - anim.start >= APPEAR_MS) this.appearing.delete(id);
      else animating = true;
    }
    if (!doc) {
      this.app.renderer.resize(this.width, this.layout.height);
      return false;
    }
    if (this.layoutDirty) {
      this.layoutDirty = false;
      this.relayout();
    }
    const states = layerStates(doc, this.analysis);
    const shimmering = !this.reducedMotion && this.anyPending(states);
    if (this.chromeDirty || animating || shimmering) {
      this.chromeDirty = false;
      this.drawChrome(now, states);
    }
    this.updateWorld(states);
    this.drawPlayhead();
    return animating || shimmering;
  }

  private anyPending(states: Record<LayerName, LayerState>): boolean {
    return Object.values(states).some((state) => state === "pending");
  }

  private relayout(): void {
    const doc = this.doc;
    if (!doc) return;
    const states = layerStates(doc, this.analysis);
    const ids = this.visibleTracks.map((track) => track.id);
    if (states.stems === "pending") {
      for (let index = 0; index < GHOST_LANES; index += 1) ids.push(`${GHOST_PREFIX}${index}`);
    }
    const level = zoomLevel(this.viewport.pxPerBeat);
    const next = computeLayout({
      width: this.width,
      trackIds: ids,
      level,
      uiScale: this.uiScale,
    });
    const heightChanged = Math.round(next.height) !== Math.round(this.layout.height);
    this.layout = next;
    this.app.renderer.resize(this.width, next.height);
    if (heightChanged) this.emit("contentHeight", { px: next.height });
    this.skylineBuilt = null;
    this.invalidateRibbons();
  }

  private syncRibbonViews(): void {
    const wanted = new Set(this.visibleTracks.map((track) => track.id));
    for (const [id, view] of this.ribbons) {
      if (!wanted.has(id)) {
        this.destroyRibbonMesh(view);
        view.container.destroy({ children: true });
        this.ribbons.delete(id);
      }
    }
    for (const track of this.visibleTracks) {
      if (this.ribbons.has(track.id)) continue;
      const container = new Container();
      const glow = new Graphics();
      glow.blendMode = "add";
      container.addChild(glow);
      this.ribbonsLayer.addChild(container);
      this.ribbons.set(track.id, {
        trackId: track.id,
        container,
        mesh: null,
        texture: null,
        geometry: null,
        builtPps: 0,
        builtWindow: null,
        builtKey: "",
        builtLevel: "L2",
        glow,
      });
    }
    this.invalidateRibbons();
  }

  private invalidateRibbons(): void {
    for (const view of this.ribbons.values()) view.builtKey = "";
  }

  private destroyRibbonMesh(view: RibbonView): void {
    if (view.mesh) {
      view.container.removeChild(view.mesh);
      view.mesh.destroy();
      view.mesh = null;
    }
    // Textures still bound in the last frame's bind groups are destroyed after the next render.
    if (view.geometry) this.graveyard.push(view.geometry);
    if (view.texture) this.graveyard.push(view.texture);
    view.geometry = null;
    view.texture = null;
  }

  private emptyGraveyard(): void {
    for (const item of this.graveyard) item.destroy(true);
    this.graveyard.length = 0;
  }

  private recomputeSectionEnergy(): void {
    this.sectionEnergy = new Map();
    const energy = this.analysis?.energy;
    if (!energy || !this.doc) return;
    for (const section of this.doc.sections) {
      this.sectionEnergy.set(section.id, meanOfCurve(energy, section.startSec, section.endSec));
    }
  }

  private needsMoreRebuilds(): boolean {
    if (!this.doc) return false;
    const key = this.ribbonKey();
    for (const view of this.ribbons.values()) {
      if (view.builtKey !== key) return true;
    }
    return false;
  }

  private ribbonKey(): string {
    return `${this.docVersion}:${this.analysisVersion}:${this.palette.theme}:${this.layout.height}`;
  }

  // ---- world meshes (ribbons + skyline) ------------------------------------------------------

  private updateWorld(states: Record<LayerName, LayerState>): void {
    const doc = this.doc;
    if (!doc) return;
    const pps = pxPerSecond(this.viewport.pxPerBeat, doc.bpm);
    const visibleSec = this.timeWidth() / pps;
    const level = zoomLevel(this.viewport.pxPerBeat);
    const key = this.ribbonKey();
    let budget = REBUILD_BUDGET;

    // Skyline
    if (states.skyline === "live" && this.analysis?.energy) {
      const built = this.skylineBuilt;
      const stale =
        !built ||
        built.key !== key ||
        pps / built.pps >= 2 ||
        pps / built.pps < 0.5 ||
        !windowCovers(built.window, this.viewport.originSec, visibleSec, doc.durationSec);
      if (stale) this.buildSkyline(this.analysis.energy, pps, visibleSec, key, level);
      const active = this.skylineBuilt;
      if (active) {
        this.skylineWorld.visible = true;
        this.skylineWorld.position.set(
          this.layout.gutter + (active.window.startSec - this.viewport.originSec) * pps,
          this.layout.skyline.y,
        );
        this.skylineWorld.scale.x = pps / active.pps;
      }
    } else {
      this.skylineWorld.visible = false;
    }

    // Ribbons
    const lanes = new Map(this.layout.ribbons.map((lane) => [lane.trackId, lane]));
    const soloActive = doc.tracks.some((track) => track.solo);
    for (const track of this.visibleTracks) {
      const view = this.ribbons.get(track.id);
      const lane = lanes.get(track.id);
      if (!view || !lane) continue;
      const built = view.builtWindow;
      const stale =
        view.builtKey !== key ||
        view.builtLevel !== level ||
        built === null ||
        view.builtPps === 0 ||
        pps / view.builtPps >= 2 ||
        pps / view.builtPps < 0.5 ||
        !windowCovers(built, this.viewport.originSec, visibleSec, doc.durationSec);
      if (stale && budget > 0) {
        budget -= 1;
        this.buildRibbon(view, track, lane.rect, pps, visibleSec, key, level);
      }
      const audible = !track.mute && (!soloActive || track.solo);
      view.container.alpha = audible ? 1 : 0.32;
      const centreY = lane.rect.y + lane.rect.h / 2;
      if (view.mesh && view.builtWindow) {
        view.mesh.position.set(
          this.layout.gutter + (view.builtWindow.startSec - this.viewport.originSec) * pps,
          centreY,
        );
        view.mesh.scale.x = pps / view.builtPps;
      }
      this.drawGlow(view, track, lane.rect, pps);
    }
  }

  private drawGlow(view: RibbonView, track: CanvasTrack, rect: Rect, pps: number): void {
    const glow = view.glow;
    glow.clear();
    if (this.reducedMotion || !this.doc) return;
    const level = this.meters[track.id] ?? 0;
    if (level <= 0.01) return;
    const x = this.layout.gutter + (this.playheadSec - this.viewport.originSec) * pps;
    if (x < this.layout.gutter - 20 || x > this.width + 20) return;
    const colour = this.palette.roles[roleTokenOf(track.role)];
    const radius = 10 + level * 14;
    glow.circle(x, rect.y + rect.h / 2, radius).fill({ color: colour, alpha: 0.18 + level * 0.4 });
  }

  private buildSkyline(
    energy: Curve,
    pps: number,
    visibleSec: number,
    key: string,
    level: ZoomLevel,
  ): void {
    const doc = this.doc;
    if (!doc) return;
    const window = cullWindow(this.viewport.originSec, visibleSec, doc.durationSec);
    const binsPerSecond = lodBinsPerSecond(pps * 0.5, 1 / energy.hopSec);
    const count = Math.max(
      2,
      Math.min(MAX_BINS, Math.ceil((window.endSec - window.startSec) * binsPerSecond)),
    );
    const values = resampleCurve(energy, window.startSec, binsPerSecond, count);
    const height = this.layout.skyline.h;
    const outline = skylineOutline(values, binsPerSecond, pps, height, 4);
    const top = outline.top;
    const points: number[] = [0, height];
    for (let index = 0; index < top.length; index += 1) points.push(top[index] ?? 0);
    points.push(top[top.length - 2] ?? 0, height);
    this.skylineG.clear();
    this.skylineG.poly(points, true).fill(this.gradient(height));
    this.skylineBuilt = { pps, window, key, level };
  }

  private gradient(height: number): FillGradient {
    // Warm at the top (high energy), cool at the bottom (07 §2).
    const stops = this.palette.energy;
    const gradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: height },
      colorStops: stops
        .map((color, index) => ({
          offset: 1 - index / Math.max(1, stops.length - 1),
          color,
        }))
        .reverse(),
      textureSpace: "global",
    });
    this.skylineGradient?.destroy();
    this.skylineGradient = gradient;
    return gradient;
  }

  private buildRibbon(
    view: RibbonView,
    track: CanvasTrack,
    rect: Rect,
    pps: number,
    visibleSec: number,
    key: string,
    level: ZoomLevel,
  ): void {
    const doc = this.doc;
    if (!doc) return;
    const window = cullWindow(this.viewport.originSec, visibleSec, doc.durationSec);
    const data = this.analysis?.ribbons?.[track.id];
    const dataBins = data ? 1 / data.rms.hopSec : 20;
    const wantWaveform = level === "L3" && this.analysis?.peaks !== undefined;
    const binsPerSecond = lodBinsPerSecond(pps, wantWaveform ? 1500 : dataBins);
    let count = Math.ceil((window.endSec - window.startSec) * binsPerSecond);
    let effective = window;
    if (count > MAX_BINS) {
      count = MAX_BINS;
      effective = {
        startSec: window.startSec,
        endSec: window.startSec + MAX_BINS / binsPerSecond,
      };
    }
    count = Math.max(2, count);
    const half = Math.max(2, (rect.h - 8) / 2);
    const role = this.palette.roles[roleTokenOf(track.role)];
    const rgb = numberToRgb(role);
    const clips = this.clipsByTrack.get(track.id) ?? [];
    const active = activityMask(clips, effective.startSec, binsPerSecond, count);

    let strip: RibbonStrip;
    let pixels: Uint8Array;
    const peaks = wantWaveform
      ? this.analysis?.peaks?.(track.id, effective.startSec, effective.endSec, count)
      : null;
    if (peaks && peaks.max.length > 1) {
      strip = buildWaveformStrip(peaks, binsPerSecond, pps, half, 0);
      pixels = ribbonTexturePixels(rgb, {
        thickness: new Float32Array(peaks.max.length),
        active: activityMask(clips, effective.startSec, binsPerSecond, peaks.max.length),
        brightness: undefined,
      });
    } else {
      const thickness = data
        ? resampleCurve(data.rms, effective.startSec, binsPerSecond, count)
        : new Float32Array(count).fill(0.5);
      const brightness = data?.brightness
        ? resampleCurve(data.brightness, effective.startSec, binsPerSecond, count)
        : undefined;
      const noisiness = data?.noisiness
        ? resampleCurve(data.noisiness, effective.startSec, binsPerSecond, count)
        : undefined;
      strip = buildRibbonStrip({
        thickness,
        brightness,
        noisiness,
        active,
        firstBin: Math.round(effective.startSec * binsPerSecond),
        binsPerSecond,
        worldPxPerSec: pps,
        halfHeightPx: half,
        offsetPx: 0,
      });
      pixels = ribbonTexturePixels(rgb, { thickness, brightness, active });
    }

    // Premultiply for the GPU (the source is declared premultiplied).
    const premultiplied = new Uint8Array(pixels.length);
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = (pixels[index + 3] ?? 255) / 255;
      premultiplied[index] = Math.round((pixels[index] ?? 0) * alpha);
      premultiplied[index + 1] = Math.round((pixels[index + 1] ?? 0) * alpha);
      premultiplied[index + 2] = Math.round((pixels[index + 2] ?? 0) * alpha);
      premultiplied[index + 3] = pixels[index + 3] ?? 255;
    }

    this.destroyRibbonMesh(view);
    const texture = new Texture({
      source: new BufferImageSource({
        resource: premultiplied,
        width: strip.bins,
        height: 3,
        format: "rgba8unorm",
        alphaMode: "premultiplied-alpha",
        scaleMode: "linear",
        addressMode: "clamp-to-edge",
      }),
    });
    const geometry = new MeshGeometry({
      positions: strip.positions,
      uvs: strip.uvs,
      indices: strip.indices,
    });
    const mesh = new Mesh({ geometry, texture });
    view.container.addChildAt(mesh, 0);
    view.mesh = mesh;
    view.geometry = geometry;
    view.texture = texture;
    view.builtPps = pps;
    view.builtWindow = effective;
    view.builtKey = key;
    view.builtLevel = level;
    this.rebuilds += 1;
  }

  // ---- chrome: grid, sections, harmony, gutter, overlays ------------------------------------

  private drawChrome(now: number, states: Record<LayerName, LayerState>): void {
    const doc = this.doc;
    if (!doc) return;
    const palette = this.palette;
    const layout = this.layout;
    const vp = this.viewport;
    const pps = pxPerSecond(vp.pxPerBeat, doc.bpm);
    const left = layout.gutter;
    const right = this.width;
    const toX = (sec: number): number => left + (sec - vp.originSec) * pps;
    const sec0 = vp.originSec;
    const sec1 = vp.originSec + this.timeWidth() / pps;
    const bottom = layout.height;
    const level = zoomLevel(vp.pxPerBeat);
    const fontSize = Math.round(12 * Math.min(this.uiScale, 2));

    // Beat grid + ruler -------------------------------------------------------------------
    const grid = this.gridG;
    grid.clear();
    this.rulerLabels.begin();
    if (states.grid === "live") {
      const lines = gridLines(doc.beatTimesSec, doc.beatsPerBar, sec0, sec1, vp.pxPerBeat);
      const gridTop = layout.skyline.y;
      for (let i = 0; i < lines.indices.length; i += 1) {
        const index = lines.indices[i] ?? 0;
        const bar = lines.isBar[i] === true;
        const x = Math.round(toX(doc.beatTimesSec[index] ?? 0));
        if (x < left || x > right) continue;
        grid
          .rect(
            x,
            bar ? layout.ruler.y + layout.ruler.h - 8 : layout.ruler.y + layout.ruler.h - 4,
            1,
            bar ? 8 : 4,
          )
          .fill({ color: palette.lineStrong, alpha: bar ? 0.9 : 0.6 });
        grid
          .rect(x, gridTop, 1, bottom - gridTop)
          .fill({ color: palette.line, alpha: bar ? 0.55 : 0.25 });
      }
      // Bar numbers where there is room for them.
      const barPx = vp.pxPerBeat * doc.beatsPerBar;
      let stepBars = 1;
      while (barPx * stepBars < 56) stepBars *= 2;
      for (let i = 0; i < lines.indices.length; i += 1) {
        if (lines.isBar[i] !== true) continue;
        const index = lines.indices[i] ?? 0;
        const barNumber = Math.floor(index / doc.beatsPerBar);
        if (barNumber % stepBars !== 0) continue;
        const x = toX(doc.beatTimesSec[index] ?? 0);
        if (x < left - 1 || x > right - 24) continue;
        this.rulerLabels.place(
          String(barNumber + 1),
          x + 5,
          layout.ruler.y + layout.ruler.h / 2 - 2,
          { fill: palette.textMuted, fontSize: Math.max(10, fontSize - 1) },
        );
      }
    } else {
      this.shimmerBar(grid, layout.ruler, now, states.grid === "pending", 0.6);
    }
    this.rulerLabels.end();

    // Skyline placeholder ---------------------------------------------------------------------
    const target = this.targetG;
    target.clear();
    if (states.skyline === "pending") {
      this.shimmerBar(target, layout.skyline, now, true, 1);
    } else if (states.skyline === "failed") {
      target.rect(left, layout.skyline.y + layout.skyline.h - 2, this.timeWidth(), 1).fill({
        color: palette.lineStrong,
        alpha: 0.6,
      });
    } else if (states.skyline === "live" && this.analysis?.energyTarget) {
      this.drawEnergyTarget(target, this.analysis.energyTarget, toX, pps);
    }

    // Sections ---------------------------------------------------------------------------------
    const sg = this.sectionsG;
    sg.clear();
    this.sectionLabels.begin();
    const s = layout.sections;
    const energyAvailable = this.sectionEnergy.size > 0;
    for (const section of doc.sections) {
      // The lifted block is drawn under the pointer instead (07 §4.1: "the block lifts").
      if (this.dragVisual?.mode === "move" && this.dragVisual.sectionId === section.id) continue;
      const x0 = toX(section.startSec);
      const x1 = toX(section.endSec);
      if (x1 < left || x0 > right) continue;
      const anim = this.appearing.get(section.id);
      const progress = anim ? Math.min(1, (now - anim.start) / APPEAR_MS) : 1;
      const eased = 1 - (1 - progress) ** 3;
      const gap = 1 * eased;
      const cx0 = Math.max(left, x0 + gap);
      const cx1 = Math.min(right, x1 - gap);
      if (cx1 - cx0 < 0.5) continue;
      const base = palette.sectionFill[sectionFamilyOf(section.kind)];
      const energy = energyAvailable ? (this.sectionEnergy.get(section.id) ?? 0.5) : 0.7;
      const fill = mixColors(palette.canvas, base, 0.55 + 0.45 * energy);
      sg.roundRect(cx0, s.y, cx1 - cx0, s.h, 4).fill({ color: fill, alpha: 0.6 + 0.4 * eased });
      if (progress < 1) {
        // The "crack": a bright seam that fades as the block settles (07 §8).
        sg.rect(Math.round(x0), s.y - 2, 2, s.h + 4).fill({
          color: palette.text,
          alpha: 0.9 * (1 - eased),
        });
      }
      const label = readableOn(fill);
      const width = x1 - x0;
      const labelStyle = { fill: label, fontSize, fontWeight: "500" } as const;
      let textX = Math.max(left, x0) + 8;
      if (section.repeatGroup !== undefined && width > 44) {
        const glyph = this.repeatGlyphs.get(section.repeatGroup) ?? 0;
        this.drawGlyph(sg, glyph, textX + 5, s.y + s.h / 2, label);
        textX += 16;
      }
      if (section.locked && width > 44) {
        this.drawPadlock(sg, Math.min(cx1 - 14, textX + 0), s.y + s.h / 2, label, section.locked);
      }
      const text = level === "L2-far" ? section.label : section.label;
      const room = cx1 - textX - (section.locked ? 18 : 6);
      if (room > 26 && this.sectionLabels.measure(text, labelStyle) <= room) {
        this.sectionLabels.place(text, textX, s.y + s.h / 2, labelStyle);
      }
    }
    if (states.sections === "pending") this.shimmerBar(sg, s, now, true, 0.5);
    this.drawDragVisual(sg, toX, pps, fontSize);
    this.sectionLabels.end();

    // Harmony strip ---------------------------------------------------------------------------
    const hg = this.harmonyG;
    hg.clear();
    this.harmonyLabels.begin();
    const h = layout.harmony;
    if (states.harmony === "live" && this.analysis?.chords) {
      const chordLabelStyle = (fillColor: number) =>
        ({ fill: readableOn(fillColor), fontSize: Math.max(10, fontSize - 2) }) as const;
      for (const chord of this.analysis.chords) {
        const x0 = toX(chord.startSec);
        const x1 = toX(chord.endSec);
        if (x1 < left || x0 > right) continue;
        const fill = chordFill(chord, palette.theme);
        const cx0 = Math.max(left, x0) + 0.5;
        const cx1 = Math.min(right, x1) - 0.5;
        if (cx1 - cx0 < 0.5) continue;
        hg.roundRect(cx0, h.y, cx1 - cx0, h.h, 3).fill(fill);
        if (chord.tension > 0.55) {
          hg.roundRect(cx0, h.y, cx1 - cx0, h.h, 3).stroke({
            width: 1.5,
            color: palette.text,
            alpha: 0.35 + 0.5 * chord.tension,
            alignment: 1,
          });
        }
        // Labels: always at L2-near and above (07 §2.1), otherwise only when they fit.
        const text = chord.label;
        const style = chordLabelStyle(fill);
        const fits = cx1 - cx0 > this.harmonyLabels.measure(text, style) + 6;
        if (fits) this.harmonyLabels.place(text, cx0 + 4, h.y + h.h / 2, style);
      }
    } else if (states.harmony === "pending") {
      this.shimmerBar(hg, h, now, true, 1);
    } else if (states.harmony === "failed") {
      hg.rect(left, h.y + h.h / 2, this.timeWidth(), 1).fill({
        color: palette.lineStrong,
        alpha: 0.5,
      });
    }
    this.harmonyLabels.end();

    // Gutter: ribbon names, solo/mute ------------------------------------------------------------
    const gg = this.gutterG;
    gg.clear();
    gg.rect(0, 0, left, bottom).fill(palette.canvas);
    this.gutterLabels.begin();
    const soloActive = doc.tracks.some((track) => track.solo);
    const byId = new Map(doc.tracks.map((track) => [track.id, track]));
    for (const lane of layout.ribbons) {
      const cy = lane.rect.y + lane.rect.h / 2;
      if (lane.trackId.startsWith(GHOST_PREFIX)) {
        this.shimmerBar(gg, { x: 8, y: cy - 6, w: left - 20, h: 12 }, now, true, 1);
        this.shimmerBar(
          gg,
          { x: left, y: lane.rect.y + 6, w: this.timeWidth(), h: lane.rect.h - 12 },
          now,
          true,
          1,
        );
        continue;
      }
      const track = byId.get(lane.trackId);
      if (!track) continue;
      const role = palette.roles[roleTokenOf(track.role)];
      gg.roundRect(8, cy - 5, 4, 10, 2).fill(role);
      const audible = !track.mute && (!soloActive || track.solo);
      this.gutterLabels.place(track.name, 18, cy, {
        fill: audible ? palette.text : palette.textMuted,
        fontSize,
        fontWeight: "500",
      });
      this.drawToggle(
        gg,
        lane.mute,
        track.mute,
        palette.warning,
        this.options.strings.mute,
        fontSize,
      );
      this.drawToggle(
        gg,
        lane.solo,
        track.solo,
        palette.accent,
        this.options.strings.solo,
        fontSize,
      );
    }
    this.gutterLabels.end();

    // Overlays: hover, selection, focus ----------------------------------------------------------
    const og = this.overlayG;
    og.clear();
    this.drawOverlays(og, toX);
  }

  private drawToggle(
    g: Graphics,
    rect: Rect,
    on: boolean,
    onColor: number,
    letter: string,
    fontSize: number,
  ): void {
    const palette = this.palette;
    g.roundRect(rect.x, rect.y, rect.w, rect.h, 5).fill(on ? onColor : palette.surfaceRaised);
    g.roundRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, 5).stroke({
      width: 1,
      color: on ? onColor : palette.lineStrong,
      alpha: 1,
    });
    this.gutterLabels.place(
      letter,
      rect.x + rect.w / 2,
      rect.y + rect.h / 2,
      { fill: on ? readableOn(onColor) : palette.text, fontSize, fontWeight: "600" },
      0.5,
      0.5,
    );
  }

  private drawGlyph(g: Graphics, glyph: number, cx: number, cy: number, color: number): void {
    // 07 §2: repeats share a small glyph (diamond, circle, triangle).
    if (glyph === 0) {
      g.poly([cx, cy - 5, cx + 5, cy, cx, cy + 5, cx - 5, cy]).fill(color);
    } else if (glyph === 1) {
      g.circle(cx, cy, 4.5).fill(color);
    } else {
      g.poly([cx, cy - 5, cx + 5, cy + 4, cx - 5, cy + 4]).fill(color);
    }
  }

  private drawPadlock(g: Graphics, x: number, cy: number, color: number, _locked: boolean): void {
    g.roundRect(x, cy - 1, 10, 7, 1.5).fill(color);
    g.arc(x + 5, cy - 1, 3.2, Math.PI, 0).stroke({ width: 1.5, color });
  }

  private shimmerBar(
    g: Graphics,
    rect: Rect,
    now: number,
    animate: boolean,
    strength: number,
  ): void {
    // A placeholder, never a spinner (07 §8): a faint band with a slow sweep.
    const segments = Math.max(1, Math.ceil(rect.w / 24));
    const segW = rect.w / segments;
    for (let i = 0; i < segments; i += 1) {
      const phase = animate ? shimmerPhase(now, rect.x + i * segW, this.reducedMotion) : 0.5;
      g.rect(rect.x + i * segW, rect.y + 2, segW + 0.5, Math.max(2, rect.h - 4)).fill({
        color: this.palette.lineStrong,
        alpha: (0.1 + 0.16 * phase) * strength,
      });
    }
  }

  private drawEnergyTarget(
    g: Graphics,
    curve: Curve,
    toX: (sec: number) => number,
    pps: number,
  ): void {
    const s = this.layout.skyline;
    const step = 6;
    const startX = this.layout.gutter;
    for (let x = startX; x < this.width; x += step * 2) {
      const sec = xToTime(this.viewport, this.doc?.bpm ?? 120, x - this.layout.gutter);
      const index = Math.min(curve.values.length - 1, Math.max(0, Math.round(sec / curve.hopSec)));
      const value = curve.values[index] ?? 0;
      g.rect(x, s.y + s.h - value * s.h - 1, step, 2).fill({
        color: this.palette.text,
        alpha: 0.8,
      });
    }
    void toX;
    void pps;
  }

  /**
   * The lifted block of a move (shadow, slight offset, following the pointer) or the ghost end of
   * a resize with its bar count (07 §4.1–4.2). Everything else on the lane is drawn from the
   * document the app supplies, which is its preview while the drag runs.
   */
  private drawDragVisual(
    g: Graphics,
    toX: (sec: number) => number,
    pps: number,
    fontSize: number,
  ): void {
    const drag = this.dragVisual;
    const doc = this.doc;
    if (drag === null || doc === null) return;
    const section = doc.sections.find((candidate) => candidate.id === drag.sectionId);
    if (section === undefined) return;
    const lane = this.layout.sections;
    const palette = this.palette;

    if (drag.mode === "move") {
      const width = Math.max(2, (drag.endSec - drag.startSec) * pps);
      const x = drag.pointerX - drag.grabOffsetX;
      const y = lane.y - 3;
      // Shadow first, then the block a few pixels higher: it reads as lifted.
      g.roundRect(x + 4, y + 6, width, lane.h, 4).fill({ color: 0x000000, alpha: 0.35 });
      const base = palette.sectionFill[sectionFamilyOf(section.kind)];
      const energy = this.sectionEnergy.get(section.id) ?? 0.7;
      const fill = mixColors(palette.canvas, base, 0.55 + 0.45 * energy);
      g.roundRect(x, y, width, lane.h, 4).fill({ color: fill, alpha: 0.97 });
      g.roundRect(x, y, width, lane.h, 4).stroke({
        width: 2,
        color: palette.accent,
        alpha: 1,
      });
      const style = { fill: readableOn(fill), fontSize, fontWeight: "500" } as const;
      if (width > 26 && this.sectionLabels.measure(section.label, style) <= width - 16) {
        this.sectionLabels.place(section.label, x + 8, y + lane.h / 2, style);
      }
      return;
    }

    // Resize: a ghost of the new end and the signed bar count (snapped to whole bars).
    const startX = toX(drag.startSec);
    const oldEndX = toX(drag.endSec);
    const barPx = drag.bars > 0 ? (oldEndX - startX) / drag.bars : 0;
    if (barPx <= 0) return;
    const newEndX = startX + drag.targetBars * barPx;
    const from = Math.min(oldEndX, newEndX);
    const to = Math.max(oldEndX, newEndX);
    if (to - from >= 1) {
      g.rect(from, lane.y, to - from, lane.h).fill({ color: palette.accent, alpha: 0.16 });
    }
    g.rect(newEndX - 1, lane.y - 2, 2, lane.h + 4).fill({
      color: palette.accent,
      alpha: 0.95,
    });
    const label = barDeltaLabel(
      drag.targetBars,
      drag.bars,
      this.options.strings.barsLonger,
      this.options.strings.barsShorter,
    );
    if (label === "") return;
    const pillW = label.length * 7 + 12;
    const pillX = Math.min(
      this.width - pillW - 4,
      Math.max(this.layout.gutter, newEndX - pillW / 2),
    );
    const pillY = lane.y - 22;
    g.roundRect(pillX, pillY, pillW, 18, 4).fill({ color: palette.surfaceRaised, alpha: 0.97 });
    g.roundRect(pillX, pillY, pillW, 18, 4).stroke({ width: 1, color: palette.lineStrong });
    this.sectionLabels.place(
      label,
      pillX + pillW / 2,
      pillY + 9,
      { fill: palette.text, fontSize: Math.max(10, fontSize - 1), fontWeight: "600" },
      0.5,
      0.5,
    );
  }

  private drawOverlays(g: Graphics, toX: (sec: number) => number): void {
    const doc = this.doc;
    if (!doc) return;
    const palette = this.palette;
    const left = this.layout.gutter;
    const lanes = new Map(this.layout.ribbons.map((lane) => [lane.trackId, lane]));
    // Hover
    if (this.hoverTrack) {
      const lane = lanes.get(this.hoverTrack);
      if (lane) {
        g.rect(lane.rect.x, lane.rect.y, lane.rect.w, lane.rect.h).fill({
          color: palette.text,
          alpha: 0.05,
        });
      }
    }
    // Selection
    for (const section of doc.sections) {
      const selected = isSelected(this.selection, "sections", section.id);
      const focused = this.focus?.kind === "section" && this.focus.id === section.id;
      if (!selected && !focused && this.hoverSection !== section.id) continue;
      const x0 = Math.max(left, toX(section.startSec));
      const x1 = Math.min(this.width, toX(section.endSec));
      if (x1 <= x0) continue;
      const s = this.layout.sections;
      if (this.hoverSection === section.id && !selected) {
        g.roundRect(x0, s.y, x1 - x0, s.h, 4).stroke({ width: 1, color: palette.text, alpha: 0.5 });
      }
      if (selected) {
        g.roundRect(x0 - 1, s.y - 1, x1 - x0 + 2, s.h + 2, 5).stroke({
          width: 2,
          color: palette.accent,
          alpha: 1,
        });
        // The selected section also frames the lanes below it.
        const bottom = this.layout.height - 4;
        g.rect(x0, s.y + s.h, 1, bottom - (s.y + s.h)).fill({ color: palette.accent, alpha: 0.5 });
        g.rect(x1 - 1, s.y + s.h, 1, bottom - (s.y + s.h)).fill({
          color: palette.accent,
          alpha: 0.5,
        });
      }
      if (focused) {
        g.roundRect(x0 - 3, s.y - 3, x1 - x0 + 6, s.h + 6, 7).stroke({
          width: 2,
          color: palette.focus,
          alpha: 1,
        });
      }
    }
    for (const track of this.visibleTracks) {
      const lane = lanes.get(track.id);
      if (!lane) continue;
      const selected = isSelected(this.selection, "tracks", track.id);
      const focused = this.focus?.kind === "track" && this.focus.id === track.id;
      if (selected) {
        g.roundRect(lane.rect.x + 1, lane.rect.y + 1, lane.rect.w - 2, lane.rect.h - 2, 6).stroke({
          width: 2,
          color: palette.accent,
          alpha: 1,
        });
      }
      if (focused) {
        g.roundRect(lane.rect.x + 3, lane.rect.y + 3, lane.rect.w - 6, lane.rect.h - 6, 7).stroke({
          width: 2,
          color: palette.focus,
          alpha: 1,
        });
      }
    }
    if (this.selection.kind === "region") {
      // Regions are in ticks; the app converts them to seconds for display, so a region selection
      // is shown only as a banner here until the lasso tool (07 §3) lands.
    }
  }

  private drawPlayhead(): void {
    const doc = this.doc;
    const g = this.playheadG;
    g.clear();
    if (!doc) return;
    const pps = pxPerSecond(this.viewport.pxPerBeat, doc.bpm);
    const x = Math.round(this.layout.gutter + (this.playheadSec - this.viewport.originSec) * pps);
    if (x < this.layout.gutter || x > this.width) return;
    const top = this.layout.ruler.y;
    g.rect(x - 1, top, 2, this.layout.height - top).fill({ color: this.palette.text, alpha: 0.95 });
    g.poly([x - 5, top, x + 5, top, x, top + 8]).fill(this.palette.text);
  }

  // ---- input -------------------------------------------------------------------------------

  private attachInput(): void {
    const element = this.app.canvas;
    let drag: { startX: number; lastX: number; moved: boolean; scrub: boolean } | null = null;

    const point = (event: MouseEvent): { x: number; y: number } => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const hit = (x: number, y: number) =>
      this.doc ? hitTest(this.layout, this.viewport, this.doc, x, y) : ({ kind: "none" } as const);

    /** Pointer x in content coordinates: px from the time area's left edge. */
    const contentX = (x: number): number => x - this.layout.gutter;

    /** The insertion slot under `x` in the arrangement as it was at drag start. */
    const dropIndexAt = (x: number): number => {
      const doc = this.dragDoc;
      if (doc === null) return 0;
      const sec = xToTime(this.viewport, doc.bpm, Math.max(0, contentX(x)));
      return dropSlotAt(doc.sections, sec);
    };

    const resetDrag = (): void => {
      this.dragState = IDLE_DRAG;
      this.dragVisual = null;
      this.dragDoc = null;
      this.chromeDirty = true;
      this.schedule();
    };

    const onWheel = (event: WheelEvent): void => {
      if (!this.doc) return;
      const { x } = point(event);
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
        this.zoomBy(factor, x - this.layout.gutter);
      } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        event.preventDefault();
        this.panByPx(-(event.shiftKey ? event.deltaY : event.deltaX));
      }
    };

    const onDown = (event: PointerEvent): void => {
      if (!this.doc || event.button !== 0) return;
      const { x, y } = point(event);
      const target = hit(x, y);
      if (target.kind === "toggle") {
        if (target.trackId.startsWith(GHOST_PREFIX)) return;
        const track = this.doc.tracks.find((candidate) => candidate.id === target.trackId);
        if (!track) return;
        this.emit("trackToggle", {
          trackId: track.id,
          field: target.field,
          value: !track[target.field],
        });
        return;
      }

      // Section bodies drag and their right edge resizes; both start as a click (11 §6.4).
      const sectionHit = sectionHitAt(this.layout, this.viewport, this.doc, x, y);
      if (sectionHit !== null) {
        const additive = event.shiftKey || event.metaKey || event.ctrlKey;
        this.emit(
          "selectionChange",
          clickSelection(this.selection, "sections", sectionHit.sectionId, additive),
        );
        const section = this.doc.sections.find(
          (candidate) => candidate.id === sectionHit.sectionId,
        );
        if (section === undefined) return;
        const pps = pxPerSecond(this.viewport.pxPerBeat, this.doc.bpm);
        const startX = this.layout.gutter + (section.startSec - this.viewport.originSec) * pps;
        const mode = sectionHit.kind === "rightEdge" ? "resize" : "move";
        this.dragDoc = this.doc;
        this.dragState = beginSectionDrag(section.id, mode, x, y, event.altKey);
        this.dragVisual = {
          sectionId: section.id,
          mode,
          startSec: section.startSec,
          endSec: section.endSec,
          bars: section.bars,
          grabOffsetX: x - startX,
          pointerX: x,
          targetBars: section.bars,
        };
        element.setPointerCapture(event.pointerId);
        element.style.cursor = "grabbing";
        this.chromeDirty = true;
        this.schedule();
        return;
      }

      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (target.kind === "ruler") {
        element.setPointerCapture(event.pointerId);
        drag = { startX: x, lastX: x, moved: true, scrub: true };
        this.emit("seek", { sec: clampSec(target.sec, this.doc.durationSec) });
        return;
      }
      if (target.kind === "ribbon") {
        if (target.trackId.startsWith(GHOST_PREFIX)) return;
        this.emit(
          "selectionChange",
          clickSelection(this.selection, "tracks", target.trackId, additive),
        );
      } else if (target.kind === "none" || target.kind === "skyline" || target.kind === "harmony") {
        if (this.selection.kind !== "none") this.emit("selectionChange", NO_SELECTION);
      }
      element.setPointerCapture(event.pointerId);
      drag = { startX: x, lastX: x, moved: false, scrub: false };
    };

    const emitDragMove = (event: PointerEvent, mode: "move" | "resize", start: boolean): void => {
      const doc = this.doc;
      const visual = this.dragVisual;
      if (doc === null || visual === null) return;
      const { x } = point(event);
      if (mode === "move") {
        const payload = {
          sectionId: visual.sectionId,
          pointerX: contentX(x),
          dropIndex: dropIndexAt(x),
          altKey: this.dragState.phase === "dragging" ? this.dragState.altKey : false,
        };
        if (start) this.emit("sectionDragStart", payload);
        this.emit("sectionDragMove", payload);
        return;
      }
      const pps = pxPerSecond(this.viewport.pxPerBeat, doc.bpm);
      const barPx = (60 / doc.bpm) * doc.beatsPerBar * pps;
      const edgeX = this.layout.gutter + (visual.endSec - this.viewport.originSec) * pps;
      visual.targetBars = resizeTargetBars(visual.bars, x - edgeX, barPx);
      const payload = {
        sectionId: visual.sectionId,
        pointerX: contentX(x),
        bars: visual.targetBars,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (start) this.emit("sectionResizeStart", payload);
      this.emit("sectionResizeMove", payload);
    };

    const onMove = (event: PointerEvent): void => {
      if (!this.doc) return;
      const { x, y } = point(event);

      if (this.dragState.phase !== "idle") {
        const previous = this.dragState;
        const next = advanceSectionDrag(this.dragState, x, y, event.altKey);
        this.dragState = next;
        if (next.phase === "dragging" && this.dragVisual !== null) {
          this.dragVisual.pointerX = x;
          emitDragMove(event, next.mode, previous.phase === "pending");
          this.chromeDirty = true;
          this.schedule();
        }
        return;
      }

      if (drag) {
        if (drag.scrub) {
          const sec = xToTime(this.viewport, this.doc.bpm, x - this.layout.gutter);
          this.emit("seek", { sec: clampSec(sec, this.doc.durationSec) });
          return;
        }
        if (Math.abs(x - drag.startX) > 4) drag.moved = true;
        if (drag.moved) {
          this.panByPx(x - drag.lastX);
          drag.lastX = x;
        }
        return;
      }
      const target = hit(x, y);
      const track = target.kind === "ribbon" || target.kind === "toggle" ? target.trackId : null;
      const section = target.kind === "section" ? target.id : null;
      const trackId = track !== null && !track.startsWith(GHOST_PREFIX) ? track : null;
      if (trackId !== this.hoverTrack) {
        this.hoverTrack = trackId;
        this.emit("hoverTrack", { trackId });
        this.chromeDirty = true;
        this.schedule();
      }
      if (section !== this.hoverSection) {
        this.hoverSection = section;
        this.chromeDirty = true;
        this.schedule();
      }
      const sectionHit = sectionHitAt(this.layout, this.viewport, this.doc, x, y);
      element.style.cursor =
        sectionHit === null
          ? target.kind === "toggle" || target.kind === "ribbon" || target.kind === "ruler"
            ? "pointer"
            : "default"
          : sectionHit.kind === "rightEdge"
            ? "ew-resize"
            : "grab";
    };

    const onUp = (event: PointerEvent): void => {
      if (this.dragState.phase !== "idle") {
        const state = this.dragState;
        if (state.phase === "dragging" && this.dragVisual !== null) {
          if (state.mode === "move") {
            const { x } = point(event);
            this.emit("sectionDragEnd", {
              sectionId: state.sectionId,
              pointerX: contentX(x),
              dropIndex: dropIndexAt(x),
              altKey: state.altKey,
            });
          } else {
            const { x } = point(event);
            this.emit("sectionResizeEnd", {
              sectionId: state.sectionId,
              pointerX: contentX(x),
              bars: this.dragVisual.targetBars,
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }
        }
        if (element.hasPointerCapture(event.pointerId)) {
          element.releasePointerCapture(event.pointerId);
        }
        element.style.cursor = "default";
        resetDrag();
        return;
      }
      if (drag && element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      drag = null;
    };

    const onCancel = (event: PointerEvent): void => {
      if (this.dragState.phase === "dragging") {
        const state = this.dragState;
        this.emit(state.mode === "move" ? "sectionDragCancel" : "sectionResizeCancel", {
          sectionId: state.sectionId,
        });
      }
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      element.style.cursor = "default";
      resetDrag();
      drag = null;
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || this.dragState.phase === "idle") return;
      const state = this.dragState;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.phase === "dragging") {
        this.emit(state.mode === "move" ? "sectionDragCancel" : "sectionResizeCancel", {
          sectionId: state.sectionId,
        });
      }
      element.style.cursor = "default";
      resetDrag();
    };

    const onLeave = (): void => {
      if (this.hoverTrack !== null || this.hoverSection !== null) {
        this.hoverTrack = null;
        this.hoverSection = null;
        this.emit("hoverTrack", { trackId: null });
        this.chromeDirty = true;
        this.schedule();
      }
    };

    const onContextMenu = (event: MouseEvent): void => {
      const { x, y } = point(event);
      const sectionId = this.sectionAt(x, y);
      if (sectionId === null) return;
      event.preventDefault();
      this.emit("sectionContextMenu", {
        sectionId,
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onCancel);
    element.addEventListener("pointerleave", onLeave);
    element.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);
    this.dispose.push(() => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onCancel);
      element.removeEventListener("pointerleave", onLeave);
      element.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
    });
    void timeToX;
  }
}

function clampSec(sec: number, durationSec: number): number {
  return Math.min(Math.max(0, sec), durationSec);
}

/** Mean of a curve over `[startSec, endSec)`. */
export function meanOfCurve(curve: Curve, startSec: number, endSec: number): number {
  const n = curve.values.length;
  if (n === 0) return 0;
  const from = Math.max(0, Math.floor(startSec / curve.hopSec));
  const to = Math.min(n - 1, Math.max(from, Math.ceil(endSec / curve.hopSec) - 1));
  let sum = 0;
  for (let index = from; index <= to; index += 1) sum += curve.values[index] ?? 0;
  return sum / (to - from + 1);
}
