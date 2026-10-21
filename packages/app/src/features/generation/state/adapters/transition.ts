/**
 * The `generate.transition` adapter: ✨ Smooth with AI on a section boundary (09 §4.4; 07 §4.1).
 *
 * After a move or a remove leaves a new boundary, the chip asks for a short bridge. The contexts are
 * up to 8 bars ending at the boundary (`before`) and starting at it (`after`), the job asks for
 * `lengthBars` (1–2 in this UI, default 1) and `n = 3` preview candidates, and each result becomes a
 * `Transition { kind: "generated", asset, lengthTicks }` on the incoming section through
 * `bragi-model`'s `transitionPlacement`. The engine plays it as an overlay centred on the boundary
 * (03 §5.5); the generated source gets no lane clip.
 */
import type {
  AssetMeta,
  GenerateFillResult,
  GenerateTransitionParams,
  OpBatch,
  Project,
} from "@bragi/schemas";
import { validateGenerateFillResult } from "@bragi/schemas";

import { t } from "../../../../i18n/index.js";
import { ulid } from "../../../../lib/ulid.js";
import {
  type GenerationAdapter,
  type GenerationPlan,
} from "../generation-session.js";
import { barsEndingAt, barsStartingAt } from "../context-windows.js";
import { musicalContextForSpan, secondsAtTick, ticksPerBarAt } from "../musical-context.js";
import { sectionStartTick } from "../../../song/state/section-ops.js";

/** The most context each side hears (09 §4.4: up to 8 bars). */
export const SMOOTH_CONTEXT_BARS = 8;
/** The bridge lengths the chip offers; one bar is the default (09 §4.4: 1–4). */
export const SMOOTH_BARS = [1, 2] as const;
export type SmoothBarCount = (typeof SMOOTH_BARS)[number];
export const DEFAULT_SMOOTH_BARS: SmoothBarCount = 1;
/** Preview candidates per request (07 §6: three ideas). */
export const SMOOTH_CANDIDATES = 3;

/** What the chip asks for. */
export interface SmoothRequest {
  /** The section whose `transitionIn` the bridge replaces (never the first). */
  readonly sectionId: string;
  readonly lengthBars: SmoothBarCount;
  readonly prompt?: string;
}

/** The boundary and bridge length, kept between plan and placement. */
interface SmoothBoundary {
  readonly boundaryTick: number;
  readonly lengthTicks: number;
}

/** The section's absolute start tick, or `null` when it is not in the song. */
export function boundaryFor(doc: Project, sectionId: string): number | null {
  const index = doc.arrangement.sections.findIndex((section) => section.id === sectionId);
  if (index <= 0) return null;
  return sectionStartTick(doc, index);
}

/** The `generate.transition` adapter for the shared flow. */
export function createTransitionAdapter(): GenerationAdapter<SmoothRequest, GenerateTransitionParams> {
  const boundaries = new WeakMap<GenerationPlan<GenerateTransitionParams>, SmoothBoundary>();

  return {
    capability: "generate.transition",
    async plan({ doc, geometry, request, seed, energy, readBlob }) {
      const boundary = boundaryFor(doc, request.sectionId);
      if (boundary === null) throw new Error("the first section has no boundary to smooth");
      const lengthTicks = request.lengthBars * ticksPerBarAt(doc, boundary);
      const before = barsEndingAt(doc, boundary, SMOOTH_CONTEXT_BARS);
      const after = barsStartingAt(doc, boundary, SMOOTH_CONTEXT_BARS);
      if (before.startTick >= boundary || after.endTick <= boundary) {
        throw new Error("a transition needs audio on both sides of its boundary");
      }
      const musical = await musicalContextForSpan({
        doc,
        model: geometry.model,
        handle: geometry.handle,
        span: { startTick: boundary, endTick: boundary + lengthTicks },
        sectionId: request.sectionId,
        seed,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        ...(energy === undefined ? {} : { energy }),
        readBlob,
      });
      const params: GenerateTransitionParams = {
        context: musical,
        lengthBars: request.lengthBars,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        tier: "preview",
        n: SMOOTH_CANDIDATES,
      };
      const half = Math.round(lengthTicks / 2);
      const plan: GenerationPlan<GenerateTransitionParams> = {
        capability: "generate.transition",
        params,
        assets: [
          { key: "before", range: before },
          { key: "after", range: after },
        ],
        region: {
          startSec: secondsAtTick(geometry.model, geometry.handle, Math.max(0, boundary - half)),
          endSec: secondsAtTick(
            geometry.model,
            geometry.handle,
            boundary + lengthTicks - half,
          ),
        },
        prompt: request.prompt ?? t("generation.smooth.prompt"),
        candidateCount: SMOOTH_CANDIDATES,
        anchorTick: boundary,
        bars: request.lengthBars,
        lengthTicks,
        ...(musical.sectionKind === undefined ? {} : { sectionKind: musical.sectionKind }),
      };
      boundaries.set(plan, { boundaryTick: boundary, lengthTicks });
      return plan;
    },
    parse({ json, plan, geometry }) {
      if (!validateGenerateFillResult(json)) return null;
      const result: GenerateFillResult = json;
      const bars = plan.params.lengthBars;
      return {
        index: result.index,
        assetHash: result.asset,
        // Placement only needs a non-empty window; the engine fits the asset to `lengthTicks`.
        durationSamples: Math.max(
          1,
          Math.round(bars * geometry.barSamplesAt(plan.anchorTick)),
        ),
        channels: 2,
        qualityWarning: result.qualityWarning,
        seed: result.seed,
        model: result.model,
        modelVersion: result.modelVersion,
        result,
      };
    },
    placement({ plan, candidate, songStore, geometry, jobId, now }) {
      const known = boundaries.get(plan);
      const doc = songStore.store.getState().doc;
      if (doc === null) throw new Error("a transition needs a loaded project");
      if (known === undefined) throw new Error("a transition needs its boundary");
      const target = sectionAtBoundary(doc, known.boundaryTick);
      if (target === null) throw new Error("the boundary's section is gone");
      const createdAt = now().toISOString();
      const request = {
        sectionId: target,
        candidate: {
          sourceId: `src_${ulid()}`,
          originalAsset: candidate.originalAsset ?? candidate.assetHash,
          workingAsset: candidate.assetHash,
          durationSamples: candidate.durationSamples,
          channels: candidate.channels,
          label: t("generation.smooth.source"),
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
        lengthTicks: known.lengthTicks,
        batchId: `bat_${ulid()}`,
        label: t("generation.smooth.candidate"),
        createdAt,
      };
      const batch = JSON.parse(
        songStore.model.transitionPlacement(geometry.handle, JSON.stringify(request)),
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
        capability: "generate.transition",
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

/** A transition's target section: the one that starts at `boundaryTick`. */
export function sectionAtBoundary(doc: Project, boundaryTick: number): string | null {
  for (const [index, section] of doc.arrangement.sections.entries()) {
    if (index > 0 && sectionStartTick(doc, index) === boundaryTick) return section.id;
  }
  return null;
}
