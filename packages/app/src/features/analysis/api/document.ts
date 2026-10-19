/**
 * The document side of the upload flow: the initial project (created when
 * `ingest` lands, finding 11) and the `analysis.apply` batches (02 §6).
 *
 * TypeScript never *edits* a document: the initial document is created once from
 * the `IngestResult` and then every change is an op batch applied by
 * `bragi-model` (13 §1 rule 4). The initial shape is validated by the model when
 * it is loaded.
 */

import type { BlobHash } from "@bragi/platform";
import type {
  AnalysisEffect,
  AnalysisStage,
  AssetMeta,
  IngestResult,
  OpBatch,
  Project,
} from "@bragi/schemas";

import { ulid } from "../../../lib/ulid.js";

export const PPQ = 960;
export const SAMPLE_RATE = 48_000;

/** A deterministic source id from the upload hash, so a re-open keeps the same document. */
export function sourceIdFor(assetHash: string): string {
  return `src_${assetHash.slice("sha256:".length, "sha256:".length + 16)}`;
}

/** `bat_` + ULID. */
export function newBatchId(): `bat_${string}` {
  return `bat_${ulid()}`;
}

export interface InitialProjectInput {
  readonly projectId: string;
  readonly title: string;
  readonly assetHash: string;
  readonly ingest: IngestResult;
  readonly createdAt?: string;
}

export interface InitialProject {
  readonly project: Project;
  readonly assets: readonly AssetMeta[];
  readonly sourceId: string;
}

/**
 * The smallest valid document that `ingest` can be applied to: one source with
 * the working asset and its duration, an empty arrangement and an empty analysis
 * ref. `analysis.apply` then adds the full-mix track and the "Song" section.
 */
export function createInitialProject(input: InitialProjectInput): InitialProject {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const sourceId = sourceIdFor(input.assetHash);
  const durationSamples = Math.max(1, Math.round(input.ingest.durationSec * SAMPLE_RATE));

  const project: Project = {
    schemaVersion: 1,
    id: input.projectId,
    meta: { title: input.title, createdAt, tags: [] },
    sources: [
      {
        id: sourceId,
        kind: "upload",
        originalAsset: input.assetHash,
        workingAsset: input.ingest.workingAsset,
        durationSamples,
        channels: 2,
        label: input.title,
      },
    ],
    analyses: {
      [sourceId]: {
        profile: "standard",
        status: {},
        blobs: {},
      },
    },
    tracks: [],
    arrangement: {
      timebase: {
        ppq: PPQ,
        tempoMap: [{ tick: 0, bpm: 120, curve: "step" }],
        timeSignatures: [{ bar: 0, numerator: 4, denominator: 4 }],
      },
      sections: [],
      master: { fx: [], automation: [], gainDb: 0 },
    },
  };

  const assets: AssetMeta[] = [
    {
      hash: input.ingest.workingAsset,
      mime: "audio/flac",
      bytes: 0,
      sampleRate: SAMPLE_RATE,
      channels: 2,
      durationSamples,
    },
  ];

  return { project, assets, sourceId };
}

/**
 * One `analysis.apply` batch, authored by `system` (02 §6). Every merge the
 * client makes goes through this, so the document only ever changes under
 * `bragi-model`.
 */
export function analysisBatch(
  sourceId: string,
  stage: AnalysisStage,
  blob: BlobHash,
  effects: readonly AnalysisEffect[],
  now: Date = new Date(),
): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "system", reason: "analysis" },
    label: `Analysis: ${stage}`,
    ops: [
      {
        op: "analysis.apply",
        sourceId,
        stage,
        blob,
        effects: [...effects],
      },
    ],
    createdAt: now.toISOString(),
  };
}
