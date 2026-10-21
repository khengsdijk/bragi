/**
 * The `generate.extend` adapter (09 §4.2, §5; 07 §4.2, §6).
 *
 * Extend's behaviour is WP-2.7's: the context is the song edge, 30 s ending on a bar line, the job
 * asks for `bars + 2` bars and `n = 3` preview candidates, and each candidate becomes a new section
 * after (or before) the song through `bragi-model`'s `extendPlacement`. Only the plumbing moved to
 * `generation-session`; the constants, messages and placement are unchanged.
 */
import type { ContextRange } from "@bragi/platform";
import type {
  AssetMeta,
  GenerateExtendParams,
  GenerateExtendResult,
} from "@bragi/schemas";
import { validateGenerateExtendResult } from "@bragi/schemas";

import { t } from "../../../../i18n/index.js";
import {
  type ExtendCandidatePartial,
  type ExtendJob,
  extendCandidateAssets,
  extendCandidateBatch,
} from "../extend-candidates.js";
import {
  type GenerationAdapter,
  type GenerationPlan,
  type SessionGeometry,
} from "../generation-session.js";
import {
  musicalContextFor,
  secondsAtTick,
  ticksPerBarAt,
  totalTicks,
} from "../musical-context.js";

/** How much song the model hears as context (09 §4.2 step 1). */
export const CONTEXT_SECONDS = 30;
/** The overlap the gate pass splices in (09 §4.2 step 2). */
export const OVERLAP_BARS = 2;
/** Preview candidates per request (07 §6: three ideas). */
export const EXTEND_CANDIDATES = 3;
/** The bar counts the popover offers; 8 is the default (07 §4.2). */
export const EXTEND_BARS = [4, 8, 16] as const;
export type ExtendBarCount = (typeof EXTEND_BARS)[number];
export const DEFAULT_EXTEND_BARS: ExtendBarCount = 8;
/** The gate crossfade: one beat, capped at 500 ms (03 §8.2, config/generation_gates.toml). */
export const CROSSFADE_MAX_SEC = 0.5;

export type ExtendDirection = GenerateExtendParams["direction"];

/** What the user asked for in the popover. */
export interface ExtendRequest {
  readonly direction: ExtendDirection;
  readonly bars: ExtendBarCount;
  readonly prompt?: string;
}

/** The gate's crossfade at the splice: one beat, capped at 500 ms (03 §8.2). */
function crossfadeTicks(geometry: SessionGeometry): number {
  const cap = Number(geometry.model.secondsToTicks(geometry.handle, CROSSFADE_MAX_SEC));
  return Math.max(0, Math.min(960, cap));
}

/** The `generate.extend` adapter for the shared flow. */
export function createExtendAdapter(): GenerationAdapter<ExtendRequest, GenerateExtendParams> {
  /** The rendered context of each plan, so placement does not have to re-derive it. */
  const contexts = new WeakMap<
    GenerationPlan<GenerateExtendParams>,
    { contextRange: ContextRange }
  >();

  return {
    capability: "generate.extend",
    async plan({ doc, geometry, request, seed, energy, readBlob }) {
      const contextRange = JSON.parse(
        geometry.model.barAlignedContextRange(
          geometry.handle,
          request.direction === "forward" ? "end" : "start",
          CONTEXT_SECONDS,
        ),
      ) as ContextRange;
      const musical = await musicalContextFor({
        doc,
        model: geometry.model,
        handle: geometry.handle,
        direction: request.direction,
        contextRange,
        bars: request.bars,
        seed,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...(energy === undefined ? {} : { energy }),
        readBlob,
      });
      const params: GenerateExtendParams = {
        context: musical,
        bars: request.bars,
        overlapBars: OVERLAP_BARS,
        direction: request.direction,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        tier: "preview",
        n: EXTEND_CANDIDATES,
      };
      const total = totalTicks(doc);
      const ticksPerBar = ticksPerBarAt(doc, total);
      const startTick = request.direction === "forward" ? contextRange.endTick : 0;
      const endTick =
        request.direction === "forward"
          ? total + request.bars * ticksPerBar
          : request.bars * ticksPerBar;
      const plan: GenerationPlan<GenerateExtendParams> = {
        capability: "generate.extend",
        params,
        assets: [{ key: "context", range: contextRange }],
        region: {
          startSec: secondsAtTick(geometry.model, geometry.handle, startTick),
          endSec: secondsAtTick(geometry.model, geometry.handle, endTick),
        },
        prompt:
          request.prompt ??
          t(
            request.direction === "forward"
              ? "generation.extend.promptForward"
              : "generation.extend.promptBackward",
            { bars: request.bars },
          ),
        candidateCount: EXTEND_CANDIDATES,
        anchorTick: request.direction === "forward" ? total : 0,
        bars: request.bars,
        direction: request.direction,
        ...(musical.sectionKind === undefined ? {} : { sectionKind: musical.sectionKind }),
      };
      contexts.set(plan, { contextRange });
      return plan;
    },
    parse({ json, assetHash, plan, geometry }) {
      if (!validateGenerateExtendResult(json)) return null;
      const result: GenerateExtendResult = json;
      const barSamples = geometry.barSamplesAt(plan.anchorTick);
      // The processed audio starts at the splice offset and covers `bars + overlap` after it
      // (09 §6); the placement helper clamps the clip to this length.
      const durationSamples = Math.max(
        1,
        Math.round(((plan.bars ?? 1) + OVERLAP_BARS) * barSamples + result.spliceOffsetSamples),
      );
      return {
        index: result.index,
        assetHash: result.asset ?? assetHash,
        durationSamples,
        channels: 2,
        qualityWarning: result.qualityWarning,
        seed: result.seed,
        model: result.model,
        modelVersion: result.modelVersion,
        result,
      };
    },
    placement({ plan, candidate, songStore, jobId, geometry, now }) {
      const result = candidate.result as GenerateExtendResult;
      const partial: ExtendCandidatePartial = {
        asset: {
          hash: candidate.assetHash,
          ...(candidate.originalAsset === undefined
            ? {}
            : { originalAsset: candidate.originalAsset }),
          durationSamples: candidate.durationSamples,
          channels: candidate.channels,
        },
        result: {
          spliceOffsetSamples: result.spliceOffsetSamples,
          qualityWarning: result.qualityWarning,
        },
      };
      const job: ExtendJob = {
        group: jobId,
        direction: plan.params.direction,
        bars: plan.bars ?? plan.params.bars,
        contextRange: contexts.get(plan)?.contextRange ?? plan.assets[0]?.range ?? {
          startTick: 0,
          endTick: 0,
        },
        crossfadeTicks: crossfadeTicks(geometry),
        ...(plan.sectionKind === undefined ? {} : { sectionKind: plan.sectionKind }),
        ...(plan.params.prompt === undefined ? {} : { prompt: plan.params.prompt }),
        ...(candidate.model === undefined ? {} : { model: candidate.model }),
        ...(candidate.modelVersion === undefined ? {} : { modelVersion: candidate.modelVersion }),
        jobId,
      };
      const assets: AssetMeta[] = extendCandidateAssets(partial);
      return {
        batch: extendCandidateBatch({ songStore }, job, partial, now().toISOString()),
        assets,
      };
    },
    hq({ plan, candidate, projectId, assets }) {
      return {
        capability: "generate.extend",
        priority: "background",
        projectId,
        assets: { context: assets.context ?? "" },
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
