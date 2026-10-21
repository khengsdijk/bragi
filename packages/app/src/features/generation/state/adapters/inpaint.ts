/**
 * The `generate.inpaint` adapter: Fill gap after an erase (09 §4.3; 07 §4.8).
 *
 * The erased region is snapped inward to whole bars (06 §3), then rendered as two conditioning
 * sides: `before` ends at the gap's start (up to 15 s, on bar lines) and `after` starts at its end.
 * The job asks for `gapBars + 2 × overlapBars` bars and `n = 3` preview candidates; each result
 * fills the gap through `bragi-model`'s `fillPlacement`, whose `startOffsetSamples` /
 * `endOffsetSamples` skip the left overlap and trim the right one. The candidate's own separation
 * later maps its stems into that range (02 §6.4).
 */
import type {
  AssetMeta,
  GenerateFillResult,
  GenerateInpaintParams,
  OpBatch,
  Region,
} from "@bragi/schemas";
import { validateGenerateFillResult } from "@bragi/schemas";

import { t } from "../../../../i18n/index.js";
import { ulid } from "../../../../lib/ulid.js";
import {
  type GenerationAdapter,
  type GenerationPlan,
  type SessionGeometry,
} from "../generation-session.js";
import {
  gapBars as gapBarsOf,
  rangeEndingAt,
  rangeStartingAt,
  samplesBetween,
  snapRegionToBars,
} from "../context-windows.js";
import { musicalContextForSpan, secondsAtTick } from "../musical-context.js";

/** The most context the model hears on each side (09 §4.3: up to 15 s). */
export const FILL_CONTEXT_SECONDS = 15;
/** The overlap the gate pass splices in on each side (09 §4.3 default). */
export const FILL_OVERLAP_BARS = 1;
/** Preview candidates per request (07 §6: three ideas). */
export const FILL_CANDIDATES = 3;

/** What the chip asks for. */
export interface FillGapRequest {
  /** The erased region; its tracks are the ones the user cleared. */
  readonly region: Region;
  readonly prompt?: string;
}

/** The snapped gap and its bar count, kept between plan and placement. */
interface FillGap {
  readonly gap: { readonly startTick: number; readonly endTick: number };
  readonly gapBars: number;
}

/** The crossfade the clips use at each gap edge: one beat, capped at 500 ms (03 §8.2). */
function crossfadeTicks(geometry: SessionGeometry): number {
  const cap = Number(geometry.model.secondsToTicks(geometry.handle, 0.5));
  return Math.max(0, Math.min(960, cap));
}

/** The gap's span in seconds, for the Audition bar. */
function gapRegion(
  geometry: SessionGeometry,
  gap: { readonly startTick: number; readonly endTick: number },
): { startSec: number; endSec: number } {
  return {
    startSec: secondsAtTick(geometry.model, geometry.handle, gap.startTick),
    endSec: secondsAtTick(geometry.model, geometry.handle, gap.endTick),
  };
}

/** The `generate.inpaint` adapter for the shared flow. */
export function createFillAdapter(): GenerationAdapter<FillGapRequest, GenerateInpaintParams> {
  const candidates = new WeakMap<GenerationPlan<GenerateInpaintParams>, FillGap>();

  return {
    capability: "generate.inpaint",
    async plan({ doc, geometry, request, seed, energy, readBlob }) {
      const gap = snapRegionToBars(doc, request.region);
      const before = rangeEndingAt(doc, geometry, gap.startTick, FILL_CONTEXT_SECONDS);
      const after = rangeStartingAt(doc, geometry, gap.endTick, FILL_CONTEXT_SECONDS);
      if (before.startTick >= before.endTick || after.endTick <= after.startTick) {
        throw new Error("a gap needs audio on both sides");
      }
      const bars = gapBarsOf(doc, gap);
      const musical = await musicalContextForSpan({
        doc,
        model: geometry.model,
        handle: geometry.handle,
        span: gap,
        seed,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...(energy === undefined ? {} : { energy }),
        readBlob,
      });
      const params: GenerateInpaintParams = {
        context: musical,
        gapBars: bars,
        overlapBars: FILL_OVERLAP_BARS,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        tier: "preview",
        n: FILL_CANDIDATES,
      };
      const plan: GenerationPlan<GenerateInpaintParams> = {
        capability: "generate.inpaint",
        params,
        assets: [
          { key: "before", range: before },
          { key: "after", range: after },
        ],
        region: gapRegion(geometry, gap),
        prompt:
          request.prompt ??
          t("generation.fill.prompt", { bars }),
        candidateCount: FILL_CANDIDATES,
        anchorTick: gap.startTick,
        lengthTicks: gap.endTick - gap.startTick,
        ...(musical.sectionKind === undefined ? {} : { sectionKind: musical.sectionKind }),
      };
      candidates.set(plan, { gap, gapBars: bars });
      return plan;
    },
    parse({ json, plan, geometry }) {
      if (!validateGenerateFillResult(json)) return null;
      const result: GenerateFillResult = json;
      const known = candidates.get(plan);
      const gap = known?.gap ?? { startTick: plan.anchorTick, endTick: plan.anchorTick };
      const bars = plan.params.gapBars;
      const overlaps = plan.params.overlapBars ?? FILL_OVERLAP_BARS;
      // The worker returns `overlap + gap + overlap` bars; the clips read from the offset the
      // gates chose. `fillPlacement` checks that the audio covers the gap.
      const gapSamples = samplesBetween(geometry, gap.startTick, gap.endTick);
      const covered =
        gapSamples + Math.abs(result.startOffsetSamples) + Math.max(0, result.endOffsetSamples);
      const durationSamples = Math.max(
        covered + 1,
        Math.round((bars + 2 * overlaps) * geometry.barSamplesAt(plan.anchorTick)),
      );
      candidates.set(plan, { gap, gapBars: bars });
      return {
        index: result.index,
        assetHash: result.asset,
        durationSamples,
        channels: 2,
        qualityWarning: result.qualityWarning,
        seed: result.seed,
        model: result.model,
        modelVersion: result.modelVersion,
        result,
      };
    },
    placement({ plan, candidate, songStore, geometry, jobId, now }) {
      const result = candidate.result as GenerateFillResult;
      const known = candidates.get(plan);
      const createdAt = now().toISOString();
      const sourceId = `src_${ulid()}`;
      const request = {
        gapRange: known?.gap ?? {
          startTick: plan.anchorTick,
          endTick: plan.anchorTick + (plan.lengthTicks ?? 0),
        },
        candidate: {
          sourceId,
          originalAsset: candidate.originalAsset ?? candidate.assetHash,
          workingAsset: candidate.assetHash,
          durationSamples: candidate.durationSamples,
          channels: candidate.channels,
          label: t("generation.fill.source"),
          provenance: {
            kind: "generation" as const,
            createdAt,
            jobId,
            ...(candidate.model === undefined ? {} : { model: candidate.model }),
            ...(candidate.modelVersion === undefined
              ? {}
              : { modelVersion: candidate.modelVersion }),
            ...(plan.params.prompt === undefined ? {} : { prompt: plan.params.prompt }),
          },
        },
        startOffsetSamples: result.startOffsetSamples,
        endOffsetSamples: result.endOffsetSamples,
        crossfadeTicks: crossfadeTicks(geometry),
        batchId: `bat_${ulid()}`,
        label: t("generation.fill.candidate", { bars: known?.gapBars ?? plan.params.gapBars }),
        createdAt,
      };
      const batch = JSON.parse(
        songStore.model.fillPlacement(geometry.handle, JSON.stringify(request)),
      ) as OpBatch;
      const assets: AssetMeta[] = [
        {
          hash: candidate.assetHash,
          mime: "audio/flac",
          bytes: 0,
          sampleRate: 48_000,
          channels: candidate.channels,
          durationSamples: candidate.durationSamples,
        },
      ];
      return { batch, assets };
    },
    hq({ plan, candidate, projectId, assets }) {
      return {
        capability: "generate.inpaint",
        priority: "background",
        projectId,
        assets: { before: assets.before ?? "", after: assets.after ?? "" },
        params: {
          ...plan.params,
          context: { ...plan.params.context, seed: candidate.seed },
          seed: candidate.seed,
          tier: "hq",
          n: 1,
        },
      };
    },
  };
}
