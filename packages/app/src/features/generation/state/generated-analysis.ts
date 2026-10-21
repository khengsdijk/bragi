/**
 * Analysis of a generated source: one history batch per arriving stage (02 §6, 09 §4.2).
 *
 * The upload flow owns the original source. A generated source is placed by
 * `extend-candidates.ts`; when `standard` analysis of its asset reports a stage, this controller
 * routes it through the same `analysis.apply` op. `bragi-model` maps a finished `separation` onto
 * the existing stem tracks and removes the mix-only generated lane (02 §6).
 */

import type { BlobHash } from "@bragi/platform";
import type {
  AnalysisStage,
  AssetMeta,
  OpBatch,
  Project,
  SeparationResult,
  Source,
} from "@bragi/schemas";
import { validateSeparationResult } from "@bragi/schemas";

import { t } from "../../../i18n/index.js";
import { analysisBatch } from "../../analysis/api/document.js";
import { asAnalysisStage, effectsForStage } from "../../analysis/api/stage-effects.js";
import type { History } from "../../history/state/history.js";
import type { ApplyOutcome, SongStore } from "../../song/state/song-store.js";

/** One analysis stage result for a generated asset, as it arrives from the job feed. */
export interface GeneratedAnalysisInput {
  /** The asset the stage ran on; the source's working or original asset hash. */
  readonly assetHash: string;
  /** The stage name from the capability (`separation`, `structure`, …). */
  readonly stage: string;
  /** The result blob's content address. */
  readonly blob: string;
  /** The parsed result blob. */
  readonly json: unknown;
}

export interface GeneratedAnalysisDependencies {
  readonly songStore: SongStore;
  readonly history: History;
  /**
   * Puts a stem or residual asset in the BlobCache before the engine hears about the new tracks.
   * The upload flow passes its `ensureAsset`; tests may omit it.
   */
  readonly ensureAsset?: (hash: string) => Promise<void>;
  /** Injected in tests. */
  readonly now?: () => Date;
}

/** The generated source whose audio `assetHash` is, if the document has one. */
export function generatedSourceFor(doc: Project, assetHash: string): Source | undefined {
  return doc.sources.find(
    (source) =>
      source.kind === "generated" &&
      (source.workingAsset === assetHash || source.originalAsset === assetHash),
  );
}

/** The AssetIndex metadata a generated source's stems need before its separation batch. */
export function generatedStemAssets(separation: SeparationResult, source: Source): AssetMeta[] {
  return [separation.residual, ...separation.stems.map((stem) => stem.asset)].map((hash) => ({
    hash,
    mime: "audio/flac",
    bytes: 0,
    sampleRate: 48_000,
    channels: 2,
    durationSamples: Math.max(1, source.durationSamples),
  }));
}

/**
 * Applies one analysis stage of a generated source, as one labelled history commit.
 *
 * The source is found by its asset hash, so a job event only needs to name the audio. A
 * `separation` result adds the stem and residual metadata (and warms the cache) before the
 * commit, because `analysis.apply` validates clip ranges against those assets (02 §6).
 *
 * @throws when no generated source owns `assetHash`, or when the stage name is unknown.
 */
export async function applyGeneratedAnalysis(
  deps: GeneratedAnalysisDependencies,
  input: GeneratedAnalysisInput,
): Promise<ApplyOutcome> {
  const stage: AnalysisStage | undefined = asAnalysisStage(input.stage);
  if (stage === undefined) throw new Error(`unknown analysis stage ${input.stage}`);

  const doc = deps.songStore.store.getState().doc;
  if (doc === null) throw new Error("generated analysis needs a loaded project");
  const source = generatedSourceFor(doc, input.assetHash);
  if (source === undefined) {
    throw new Error(`no generated source owns asset ${input.assetHash}`);
  }

  const effects = effectsForStage(stage, input.json);
  const separation =
    stage === "separation" && validateSeparationResult(input.json) ? input.json : null;
  if (separation !== null) {
    deps.songStore.addAssets(generatedStemAssets(separation, source));
    if (deps.ensureAsset !== undefined) {
      await deps.ensureAsset(separation.residual);
      for (const stem of separation.stems) await deps.ensureAsset(stem.asset);
    }
  }

  const batch: OpBatch = analysisBatch(
    source.id,
    stage,
    input.blob as BlobHash,
    effects,
    deps.now?.(),
  );
  return deps.history.commit(batch, {
    label: t("generation.analysis.label", { stage }),
  });
}
