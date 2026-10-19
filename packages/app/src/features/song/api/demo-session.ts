/**
 * Opens a generated demo song: builds the document and (optionally) its audio, loads it into a
 * Song Store and a fresh engine controller, and derives the analysis data the canvas shows.
 *
 * This is the stand-in for "open a project" until WP-1.10 wires uploads: the canvas only ever
 * sees a Song Store, an `EngineController` and an {@link AnalysisData}, so the real flow replaces
 * this file and nothing else.
 */
import type { Platform } from "@bragi/platform";
import type { AnalysisStageName, StageStatus } from "@bragi/render-canvas";
import type { AnalysisData } from "../components/SongWorkspace.js";
import { loadModel, type ModelApi } from "../model/model-api.js";
import { createEngineController, type EngineController } from "../state/engine-controller.js";
import { createSongStore, type SongStore } from "../state/song-store.js";
import { syntheticAnalysis } from "./demo-analysis.js";
import { encodeWav16, renderStem } from "./demo-audio.js";
import {
  benchmarkSpec,
  buildDemoProject,
  type DemoSpec,
  fakeAssetHash,
  progressiveSpec,
  SHORT_DEMO,
} from "./demo-song.js";
import { buildCanvasDocument } from "./view-model.js";

export interface DemoParams {
  /** `true` synthesises the audio and puts it in the blob cache (short demo only). */
  readonly audio: boolean;
  /** Benchmark song length in minutes; omitted for the short demo. */
  readonly minutes?: number | undefined;
  readonly tracks?: number | undefined;
  /** Analysis stages that have arrived; omitted means all of them. */
  readonly stages?: readonly AnalysisStageName[] | undefined;
}

export interface DemoSession {
  readonly songStore: SongStore;
  readonly controller: EngineController;
  readonly analysis: AnalysisData | null;
  readonly spec: DemoSpec;
  /** When the session finished opening, `performance.now()`. */
  readonly openedAt: number;
}

const ALL_STAGES: readonly AnalysisStageName[] = [
  "ingest",
  "rhythm",
  "loudness_energy",
  "structure",
  "separation",
  "harmony",
  "tag",
  "describe",
];

export async function createDemoSession(
  platform: Platform,
  params: DemoParams,
  model?: ModelApi,
): Promise<DemoSession> {
  const api = model ?? (await loadModel());
  const done = new Set<string>(params.stages ?? ALL_STAGES);
  const full: DemoSpec =
    params.minutes === undefined ? SHORT_DEMO : benchmarkSpec(params.minutes, params.tracks ?? 12);
  const spec = progressiveSpec(full, done);

  const hashes = new Map<string, `sha256:${string}`>();
  const audible =
    params.audio && params.minutes === undefined && platform.createEngine !== undefined;
  if (audible) {
    for (const stem of spec.stems) {
      const bytes = encodeWav16(renderStem(spec, stem.key));
      hashes.set(stem.key, await platform.blobCache.put(bytes));
    }
  }
  const stages: Record<string, StageStatus> = {};
  for (const stage of ALL_STAGES) stages[stage] = done.has(stage) ? "done" : "pending";

  const built = buildDemoProject(spec, {
    assetFor: (key) => hashes.get(key) ?? fakeAssetHash(`${spec.title}:${key}`),
    stages,
    projectId: "DEMO0000000000000000000001",
  });

  const songStore = createSongStore(api);
  songStore.load(built.project, built.assets);

  const controller = createEngineController({
    createEngine: audible ? platform.createEngine : undefined,
    document: () => songStore.store.getState().doc,
    durationSec: () => built.durationSec,
  });

  // Synthetic analysis, but only for the stages that have "arrived".
  const handle = songStore.handle();
  const doc = songStore.store.getState().doc;
  let analysis: AnalysisData | null = null;
  if (handle !== null && doc !== null) {
    const canvasDoc = buildCanvasDocument(api, handle, doc);
    const all = syntheticAnalysis(canvasDoc, {});
    analysis = {
      ...(done.has("loudness_energy") && all.energy ? { energy: all.energy } : {}),
      ...(done.has("harmony") && all.chords ? { chords: all.chords } : {}),
      ...(all.ribbons && done.has("loudness_energy") ? { ribbons: all.ribbons } : {}),
      ...(all.peaks && done.has("loudness_energy") ? { peaks: all.peaks } : {}),
    };
  }
  return { songStore, controller, analysis, spec, openedAt: performance.now() };
}
