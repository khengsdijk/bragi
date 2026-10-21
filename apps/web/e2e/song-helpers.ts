/**
 * Helpers shared by the Song Canvas specs: open a demo song, reach the canvas through the test
 * hooks the app exposes on `window.__bragi` (only with `?e2e=1`), and know where things are on
 * the canvas from the renderer's own layout rather than from pixel guesses.
 */
import type { Page } from "@playwright/test";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProjectLike {
  tracks: {
    id: string;
    name: string;
    mute: boolean;
    solo: boolean;
    role?: string;
    hidden?: boolean;
  }[];
  sources?: {
    id: string;
    kind: string;
    workingAsset: string;
    originalAsset?: string;
    placement?: { sectionId: string; range?: { startTick: number; endTick: number } };
  }[];
  arrangement: {
    timebase?: {
      ppq: number;
      tempoMap: { tick: number; bpm: number }[];
      timeSignatures: { bar: number; numerator: number; denominator: number }[];
    };
    sections: {
      id: string;
      label: string;
      kind?: string;
      lengthTicks: number;
      lanes?: Record<string, { clips: { id: string; asset: string; start?: number }[] }>;
      transitionIn?: { kind: string; asset?: string; lengthTicks: number };
    }[];
  };
}

export interface CommitLike {
  batch: {
    label: string;
    ops: { op: string; sectionId?: string; toIndex?: number; mode?: string }[];
  };
  revision: number;
}

export interface CanvasHook {
  readonly rendererName: string;
  stats(): {
    renderer: string;
    frames: number;
    lastRenderMs: number;
    worstRenderMs: number;
    meanRenderMs: number;
    ribbonRebuilds: number;
  };
  resetStats(): void;
  settle(): void;
  renderNow(): void;
  coverage(): number | null;
  layerStates(): Record<string, string> | null;
  getLayout(): {
    gutter: number;
    height: number;
    sections: Rect;
    harmony: Rect;
    skyline: Rect;
    ribbons: { trackId: string; rect: Rect; mute: Rect; solo: Rect }[];
  };
  getViewport(): { pxPerBeat: number; originSec: number };
  sectionAt(x: number, y: number): string | null;
  /** The centre of a ribbon at an arrangement time, in canvas CSS px. */
  ribbonPoint(trackId: string, sec: number): { x: number; y: number } | null;
  getLevel(): string;
  setViewport(viewport: { pxPerBeat: number; originSec: number }): void;
  zoomBy(factor: number, anchorX?: number): void;
  panByPx(dx: number): void;
  fit(): void;
  /** The region drawn for the prompt bar (07 §4.3). */
  getLassoRegion(): {
    startSec: number;
    endSec: number;
    trackIds: readonly string[];
  } | null;
  /** The Explanation highlights drawn now (06 §8). */
  getHighlights(): readonly {
    region: { startSec: number; endSec: number; trackIds: readonly string[] };
    label: string;
  }[];
}

export interface Hooks {
  readonly canvas: CanvasHook | null;
  readonly store: {
    store: {
      getState(): {
        doc: ProjectLike | null;
        preview: ProjectLike | null;
        revision: number;
        lastCommit: CommitLike | null;
      };
    };
  };
  readonly controller: {
    store: {
      getState(): {
        status: string;
        playing: boolean;
        positionSec: number;
        underruns: number;
        meters: Record<string, number>;
        error: string | null;
        auditionSlot: number;
      };
    };
    seek(sec: number): void;
    play(): Promise<void>;
    toggle(): Promise<void>;
  };
  /** The extend flow; `null` on a canvas without a generation host. */
  readonly extend?: {
    store: {
      getState(): { phase: string; candidates: number; message?: string };
    };
  } | null;
  /** Fill gap and Smooth with AI; `null` on a canvas without a generation host. */
  readonly fill?: {
    store: {
      getState(): { phase: string; candidates: number; message?: string };
    };
  } | null;
  readonly smooth?: {
    store: {
      getState(): { phase: string; candidates: number; message?: string };
    };
  } | null;
  /** The chips' state: the erased gap and the re-joined boundaries. */
  readonly offers?: {
    store: {
      getState(): {
        fill: { region: { startTick: number; endTick: number }; label: string } | null;
        smooth: readonly { sectionId: string; boundaryTick: number }[];
      };
    };
  } | null;
  /** The planner's execute path. */
  readonly plannerGeneration?: { group(): string | null } | null;
  /** The audition bar, when a stored song has one. */
  readonly audition?: {
    store: {
      getState(): {
        group: {
          id: string;
          kind: string;
          candidates: { id: string; label: string; slot: number; status: { kind: string } }[];
        } | null;
        selected: number;
        warm: number[];
      };
    };
  } | null;
  readonly history?: {
    store: {
      getState(): {
        commits: Map<
          string,
          { id: string; state: string; label?: string; candidateGroup?: string }
        >;
        head: string | null;
      };
    };
  } | null;
}

/**
 * Runs `fn` in the page with the app's test hooks (`window.__bragi`) and an optional JSON
 * argument. `fn` is serialised, so it may not close over anything.
 */
export async function withHooks<R, A = undefined>(
  page: Page,
  fn: (hooks: Hooks, arg: A) => R,
  arg?: A,
): Promise<Awaited<R>> {
  // JSHandle.evaluate runs `fn` through the protocol, not as page script, so the app's strict CSP
  // (no 'unsafe-eval') stays in force during the tests.
  const hooks = await page.evaluateHandle(() => (window as unknown as { __bragi: Hooks }).__bragi);
  try {
    return (await hooks.evaluate(
      fn as (hooks: Hooks, arg: unknown) => R,
      arg as unknown,
    )) as Awaited<R>;
  } finally {
    await hooks.dispose();
  }
}

export interface OpenOptions {
  readonly renderer?: "webgl" | "webgpu";
  readonly minutes?: number;
  readonly tracks?: number;
  readonly audio?: boolean;
  readonly stages?: string;
  readonly sel?: string;
}

/** Opens the demo song and waits until the canvas has drawn its first frame. Returns ms taken. */
export async function openDemo(page: Page, options: OpenOptions = {}): Promise<number> {
  const params = new URLSearchParams({ e2e: "1" });
  if (options.renderer) params.set("renderer", options.renderer);
  if (options.minutes !== undefined) params.set("minutes", String(options.minutes));
  if (options.tracks !== undefined) params.set("tracks", String(options.tracks));
  if (options.audio === false) params.set("audio", "0");
  if (options.stages !== undefined) params.set("stages", options.stages);
  if (options.sel !== undefined) params.set("sel", options.sel);
  const start = Date.now();
  await page.goto(`/#/demo?${params}`);
  await waitForFrame(page);
  return Date.now() - start;
}

/** Page coordinates of a point given in canvas coordinates. */
export async function canvasPoint(
  page: Page,
  x: number,
  y: number,
): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("song-canvas").locator("canvas").boundingBox();
  if (!box) throw new Error("the canvas has no box");
  return { x: box.x + x, y: box.y + y };
}

export function layout(page: Page) {
  return withHooks(page, (hooks) => {
    if (!hooks.canvas) throw new Error("no canvas");
    return hooks.canvas.getLayout();
  });
}

/** Page coordinates of the centre of a ribbon at an arrangement time. */
export async function ribbonPoint(
  page: Page,
  trackId: string,
  sec: number,
): Promise<{ x: number; y: number }> {
  const point = await withHooks(
    page,
    (hooks, arg) => {
      const canvas = hooks.canvas;
      if (!canvas) throw new Error("no canvas");
      return canvas.ribbonPoint(arg.trackId, arg.sec);
    },
    { trackId, sec },
  );
  if (point === null) throw new Error(`no ribbon ${trackId} at ${sec}s`);
  return canvasPoint(page, point.x, point.y);
}

export function currentDoc(page: Page): Promise<ProjectLike> {
  return withHooks(page, (hooks) => {
    const doc = hooks.store.store.getState().doc;
    if (!doc) throw new Error("no document");
    return JSON.parse(JSON.stringify(doc)) as ProjectLike;
  });
}

/** Waits until the canvas has drawn at least one frame. */
export async function waitForFrame(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const hooks = (window as unknown as { __bragi?: Hooks }).__bragi;
      return (hooks?.canvas?.stats().frames ?? 0) > 0;
    },
    undefined,
    { timeout: 30_000 },
  );
}
