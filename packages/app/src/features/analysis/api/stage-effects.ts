/**
 * Analysis blob -> `analysis.apply` effects (specs/02 §6, 04 §5–§6).
 *
 * `bragi-model` never reads blobs (it has no I/O), so the producer projects the
 * facts the arrangement is built from into a typed `effects[]`. This module is
 * that producer. Each stage owns at most one effect kind and stages that change
 * no arrangement carry an empty list.
 *
 * The blobs are validated against `packages/schemas/analysis/*` before use, so a
 * worker that drifted from its contract is a clear failure here rather than a
 * subtly wrong document.
 */
import {
  type AnalysisEffect,
  type AnalysisStage,
  validateDescriptionResult,
  validateRhythmResult,
  validateSeparationResult,
  validateStructureResult,
  validateTagResult,
} from "@bragi/schemas";

/** One beat's worth of ticks at the model's 960 PPQ (02 §2.2). */
export const PPQ = 960;

/** A blob that does not match its stage's schema. */
export class StageBlobError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message);
    this.name = "StageBlobError";
  }
}

function invalid(stage: string, validate: { errors?: unknown }): StageBlobError {
  const detail = Array.isArray(validate.errors)
    ? validate.errors
        .map((error: unknown) => {
          const entry = error as { instancePath?: string; message?: string };
          return `${entry.instancePath ?? ""} ${entry.message ?? ""}`.trim();
        })
        .join("; ")
    : "schema mismatch";
  return new StageBlobError(stage, `${stage} blob is not valid: ${detail}`);
}

/**
 * Projects one stage's result blob into the effects `analysis.apply` records.
 *
 * @param stage the stage name (`analysis.apply`'s `AnalysisStage`)
 * @param blob the parsed result blob
 * @throws {StageBlobError} when the blob does not match its schema
 */
export function effectsForStage(stage: AnalysisStage | string, blob: unknown): AnalysisEffect[] {
  switch (stage) {
    case "ingest":
      // The source itself is created by the client from the IngestResult; the op
      // only starts the block, so its effects list is empty (02 §6).
      return [];
    case "rhythm":
      return [tempoEffect(stage, blob)];
    case "structure":
      return [sectionsEffect(stage, blob)];
    case "separation":
      return [separationEffect(stage, blob)];
    case "tag":
      return [tagsEffect(stage, blob)];
    case "describe":
      return descriptionEffect(stage, blob);
    default:
      // harmony, loudness_energy, energy_stems, stem_activity, preview, embed_*,
      // section_embed, stem_embed, drum_split, transcribe, lyrics: no
      // arrangement change (02 §6).
      return [];
  }
}

function tempoEffect(stage: string, blob: unknown): AnalysisEffect {
  if (!validateRhythmResult(blob)) throw invalid(stage, validateRhythmResult);
  const result = blob;
  return {
    kind: "tempo",
    // The v1 workers report a global bpm and a beat curve; the document stores a
    // tempo map in ticks. A single step point is exact for a stable tempo and a
    // safe baseline otherwise (the beat anchors drive the clip warp).
    tempoMap: [{ tick: 0, bpm: result.bpm, curve: "step" }],
    timeSignatures: [
      {
        bar: 0,
        numerator: result.timeSignature.numerator,
        denominator: result.timeSignature.denominator,
      },
    ],
  };
}

function sectionsEffect(stage: string, blob: unknown): AnalysisEffect {
  if (!validateStructureResult(blob)) throw invalid(stage, validateStructureResult);
  const result = blob;
  return { kind: "sections", sections: result.sections };
}

function separationEffect(stage: string, blob: unknown): AnalysisEffect {
  if (!validateSeparationResult(blob)) {
    throw invalid(stage, validateSeparationResult);
  }
  const result = blob;
  return { kind: "separation", stems: result.stems, residual: result.residual };
}

function tagsEffect(stage: string, blob: unknown): AnalysisEffect {
  if (!validateTagResult(blob)) throw invalid(stage, validateTagResult);
  const result = blob;
  // Scores stay in the blob (02 §6); the document keeps the label lists.
  return {
    kind: "tags",
    genres: result.genres.map((entry) => entry.label),
    moods: result.moods.map((entry) => entry.label),
  };
}

/** `describe` arrives with WP-1.7; the projection is ready for it. */
function descriptionEffect(_stage: string, blob: unknown): AnalysisEffect[] {
  if (!validateDescriptionResult(blob)) return [];
  const result = blob;
  return [{ kind: "description", description: result.summary }];
}

/** The `AnalysisStage` a stage name is, or `undefined` when it is not one. */
export function asAnalysisStage(stage: string): AnalysisStage | undefined {
  switch (stage) {
    case "ingest":
    case "rhythm":
    case "structure":
    case "separation":
    case "tag":
    case "describe":
    case "harmony":
    case "loudness_energy":
    case "energy_stems":
    case "stem_activity":
    case "preview":
    case "embed_full":
    case "section_embed":
    case "stem_embed":
    case "drum_split":
    case "transcribe":
    case "lyrics":
      return stage;
    default:
      return undefined;
  }
}
