/**
 * Generation extend candidates: job partials → placement batches → candidate commits
 * (09 §4.2, 02 §7, 07 §6).
 *
 * One partial is one finished candidate (`asset` + the gate `result`). Each becomes a history
 * candidate whose batch places it through `bragi-model`'s `extendPlacement`; the Audition bar then
 * offers the group as usual. Nothing here touches the document directly: the model builds the ops
 * and `history.addCandidates` stores the candidate snapshots.
 */
import type { AssetMeta, OpBatch, SectionKind } from "@bragi/schemas";

import { t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";
import type { StoredCommit } from "../../history/api/history-repo.js";
import type { History } from "../../history/state/history.js";
import type { SongStore } from "../../song/state/song-store.js";

/** The audio one candidate offers. */
export interface ExtendCandidateAsset {
  /** The 48 kHz working asset the clip plays. */
  readonly hash: string;
  /** The bytes the model returned, when they differ from the working copy. */
  readonly originalAsset?: string;
  readonly durationSamples: number;
  readonly channels: 1 | 2;
  readonly label?: string;
}

/** The gate result the caller needs for placement (09 §6). */
export interface ExtendCandidateResult {
  /**
   * Where the processed audio starts relative to the context edge, in samples. Negative starts
   * inside the overlap, which is the usual forward case (`GateResult.splice_offset_samples`).
   */
  readonly spliceOffsetSamples: number;
  /** `qualityWarning` from the gates; the UI shows the warning, placement is unchanged. */
  readonly qualityWarning?: boolean;
}

/** One finished candidate: the job partial shape `{ asset, result }`. */
export interface ExtendCandidatePartial {
  readonly asset: ExtendCandidateAsset;
  readonly result: ExtendCandidateResult;
}

/** What the user asked for and the context the model was given. */
export interface ExtendJob {
  /** The audition candidate group (02 §7). */
  readonly group: string;
  readonly direction: "forward" | "backward";
  readonly bars: number;
  /** The bar-aligned context range the engine rendered (03 §9), in absolute ticks. */
  readonly contextRange: { readonly startTick: number; readonly endTick: number };
  /** The gate crossfade at the splice, in ticks. */
  readonly crossfadeTicks: number;
  /** `outro` when the user asked for an ending (09 §4.2). */
  readonly sectionKind?: SectionKind;
  readonly prompt?: string;
  readonly model?: string;
  readonly modelVersion?: string;
  readonly jobId?: string;
}

export interface ExtendCandidateDependencies {
  readonly songStore: SongStore;
  readonly history: History;
  /** Injected in tests. */
  readonly now?: () => Date;
}

/** The `src_…` id of a generated source. A ULID keeps two jobs with the same audio apart. */
export function generatedSourceId(): string {
  return `src_${ulid()}`;
}

/** The asset metadata the candidate index needs before a batch can reference the audio. */
export function extendAssetMeta(
  asset: ExtendCandidateAsset,
  channels: 1 | 2 = asset.channels,
): AssetMeta {
  return {
    hash: asset.hash,
    mime: "audio/flac",
    bytes: 0,
    sampleRate: 48_000,
    channels,
    durationSamples: asset.durationSamples,
  };
}

/**
 * Turns the partials of one job into candidate commits, in arrival order.
 *
 * The asset metadata is added to the Song Store first: `history.addCandidates` applies each
 * batch against the HEAD snapshot and validates clip ranges against that index (02 §6).
 * Returns the stored candidates; the caller opens the audition group with `job.group`.
 */
export async function addExtendCandidates(
  deps: ExtendCandidateDependencies,
  job: ExtendJob,
  partials: readonly ExtendCandidatePartial[],
): Promise<readonly StoredCommit[]> {
  if (partials.length === 0) return [];
  const handle = deps.songStore.handle();
  if (handle === null) throw new Error("an extend needs a loaded project");

  const now = deps.now ?? (() => new Date());
  const assets = partials.flatMap((partial) => {
    const metas = [extendAssetMeta(partial.asset)];
    if (
      partial.asset.originalAsset !== undefined &&
      partial.asset.originalAsset !== partial.asset.hash
    ) {
      metas.push({
        ...extendAssetMeta(partial.asset),
        hash: partial.asset.originalAsset,
      });
    }
    return metas;
  });
  deps.songStore.addAssets(assets);

  const batches: OpBatch[] = partials.map((partial) => {
    const createdAt = now().toISOString();
    const sourceId = generatedSourceId();
    const request = {
      direction: job.direction,
      contextRange: job.contextRange,
      candidate: {
        sourceId,
        originalAsset: partial.asset.originalAsset ?? partial.asset.hash,
        workingAsset: partial.asset.hash,
        durationSamples: partial.asset.durationSamples,
        channels: partial.asset.channels,
        label:
          partial.asset.label ??
          t(
            job.direction === "forward"
              ? "generation.extend.sourceOutro"
              : "generation.extend.sourceIntro",
          ),
        provenance: {
          kind: "generation" as const,
          createdAt,
          ...(job.jobId === undefined ? {} : { jobId: job.jobId }),
          ...(job.model === undefined ? {} : { model: job.model }),
          ...(job.modelVersion === undefined ? {} : { modelVersion: job.modelVersion }),
          ...(job.prompt === undefined ? {} : { prompt: job.prompt }),
        },
      },
      spliceOffset: partial.result.spliceOffsetSamples,
      bars: job.bars,
      crossfadeTicks: job.crossfadeTicks,
      ...(job.sectionKind === undefined ? {} : { sectionKind: job.sectionKind }),
      batchId: `bat_${ulid()}`,
      label: t("generation.extend.candidate", { bars: job.bars }),
      createdAt,
    };
    return JSON.parse(
      deps.songStore.model.extendPlacement(handle, JSON.stringify(request)),
    ) as OpBatch;
  });

  return deps.history.addCandidates(batches, job.group);
}
