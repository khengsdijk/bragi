/**
 * Stage input wiring for the analysis DAG (specs/04 §2, 05 §4.4, Q33).
 *
 * A worker declares the inputs it reads by name: `separation` reads
 * `assets.mix`, `harmony` reads `assets.stem_<role>` (falling back to `mix`
 * then `source`), `structure` reads `blobs.rhythm`, `tag` reads
 * `blobs.embed_full`, and so on. The orchestrator used to hand every stage the
 * same `assets.source = <upload>` and nothing else, which left `separation`
 * without a mix and every downstream stage without its stems or blobs.
 *
 * {@link resolveStageInputs} is the pure function that builds one stage's
 * `assets`/`blobs` from the finished stages' outputs. It is deliberately free of
 * NATS and Postgres: {@link loadStageResults} is the only database-facing piece,
 * and it just shapes two queries into {@link StageResults}.
 */
import type { Pool } from "pg";

/** A stage's produced assets (e.g. `ingest` → `{ workingAsset }`). */
export type StageAssets = Readonly<Record<string, string>>;

/** The outputs the resolver reads: produced assets per stage, result blob per stage. */
export interface StageResults {
  /**
   * Assets produced by each finished stage, keyed by stage. `separation` →
   * `{ residual, stem_vocals, … }`, `ingest` → `{ workingAsset }`.
   */
  readonly assets: ReadonlyMap<string, StageAssets>;
  /** The result blob of each finished stage, keyed by stage (e.g. `rhythm` → `sha256:…`). */
  readonly blobs: ReadonlyMap<string, string>;
}

/** An empty result set: only `ingest` can run, and only from the upload. */
export function emptyStageResults(): StageResults {
  return { assets: new Map(), blobs: new Map() };
}

/**
 * Adds a stage's outputs to a result set.
 *
 * The caller passes the raw `JobEvent.outputs` (05 §4.2); {@link resultBlob}
 * picks the stage's result blob out of it. Returns a new value so callers can
 * keep accumulating without aliasing.
 */
export function withOutputs(
  results: StageResults,
  stage: string,
  outputs: { assets?: StageAssets; blobs?: StageAssets } | undefined,
): StageResults {
  const assets = new Map(results.assets);
  const blobs = new Map(results.blobs);
  if (outputs?.assets !== undefined && Object.keys(outputs.assets).length > 0) {
    assets.set(stage, outputs.assets);
  }
  const blob = resultBlob(stage, outputs);
  if (blob !== undefined) blobs.set(stage, blob);
  return { assets, blobs };
}

/** Where each stage names its result blob in `JobOutputs.blobs` (04 §3–§6). */
export const STAGE_BLOB_KEY: Readonly<Record<string, string>> = {
  ingest: "result",
  rhythm: "result",
  structure: "result",
  loudness_energy: "result",
  separation: "separation",
  harmony: "harmony",
  stem_activity: "stem_activity",
  embed_full: "embed_full",
  section_embed: "section_embed",
  stem_embed: "stem_embed",
  tag: "tag",
};

/**
 * The stage's result blob: the named blob when the worker published one, else
 * the first blob or asset. `ingest` is the awkward case — it publishes the
 * working asset *and* the `IngestResult` — which is why the named key wins.
 */
export function resultBlob(
  stage: string,
  outputs: { assets?: StageAssets; blobs?: StageAssets } | undefined,
): string | undefined {
  const named = STAGE_BLOB_KEY[stage];
  if (named !== undefined) {
    const value = outputs?.blobs?.[named];
    if (value !== undefined) return value;
  }
  for (const source of [outputs?.blobs, outputs?.assets]) {
    const entry = source === undefined ? undefined : Object.values(source)[0];
    if (entry !== undefined) return entry;
  }
  return undefined;
}

/**
 * The blob inputs each stage reads: worker input key → producing stage (04 §5–§6).
 * The key the worker reads equals the producing stage's name, which is not a
 * coincidence: the analysis stages and the blob names are the same vocabulary.
 */
const BLOB_INPUTS: Readonly<Record<string, readonly string[]>> = {
  structure: ["rhythm"],
  harmony: ["rhythm", "structure"],
  stem_activity: ["structure"],
  section_embed: ["structure"],
  stem_embed: ["stem_activity"],
  tag: ["embed_full"],
};

/** The asset keys `separation` publishes that later stages read (`04 §4`). */
function isSeparationAsset(key: string): boolean {
  return key === "residual" || key.startsWith("stem_");
}

/**
 * Builds the `inputs` for one analysis stage.
 *
 * - `ingest` runs on the upload itself (`assets.source`).
 * - Every other stage runs on the **working asset** (`ingest`'s output, or the
 *   upload when `ingest` has not finished — the fallback keeps a re-run of a
 *   single stage possible). It is passed both as `source` (what the DSP stages
 *   read) and as `mix` (`separation`, and the fallback in `harmony`/
 *   `stem_activity`).
 * - Once `separation` is done, its stems and residual are attached, so
 *   `harmony`/`stem_activity`/`stem_embed` read them instead of the mix.
 * - The blob inputs of {@link BLOB_INPUTS} are attached when their stage is done.
 *
 * @param uploadHash the source asset the user uploaded (`sha256:…`)
 * @param stage the stage being submitted
 * @param results the finished stages' outputs (see {@link loadStageResults})
 */
export function resolveStageInputs(
  uploadHash: string,
  stage: string,
  results: StageResults,
): { assets: Record<string, string>; blobs: Record<string, string> } {
  const assets: Record<string, string> = {};
  const blobs: Record<string, string> = {};

  if (stage === "ingest") {
    assets.source = uploadHash;
    return { assets, blobs };
  }

  const working = results.assets.get("ingest")?.workingAsset ?? uploadHash;
  assets.source = working;
  assets.mix = working;

  const separation = results.assets.get("separation");
  if (separation !== undefined) {
    for (const [key, hash] of Object.entries(separation)) {
      if (isSeparationAsset(key)) assets[key] = hash;
    }
  }

  for (const producer of BLOB_INPUTS[stage] ?? []) {
    const hash = results.blobs.get(producer);
    if (hash !== undefined) blobs[producer] = hash;
  }

  return { assets, blobs };
}

/**
 * Reads the finished stages for one asset out of Postgres.
 *
 * Result blobs live in `analyses.blob_hash`; produced assets live in the
 * completed jobs' `outputs`. A stage that ran but failed has neither, so it
 * simply does not appear.
 */
export async function loadStageResults(pool: Pool, assetHash: string): Promise<StageResults> {
  const { rows: analysisRows } = await pool.query<{ stage: string; blob_hash: string | null }>(
    "SELECT stage, blob_hash FROM analyses WHERE asset_hash = $1 AND status = 'done'",
    [assetHash],
  );
  const blobs = new Map<string, string>();
  for (const row of analysisRows) {
    if (row.blob_hash !== null) blobs.set(row.stage, row.blob_hash);
  }

  const { rows: jobRows } = await pool.query<{ stage: string | null; outputs: unknown }>(
    `SELECT params->>'stage' AS stage, outputs FROM jobs
     WHERE capability LIKE 'analysis.%' AND params->>'assetHash' = $1 AND outputs IS NOT NULL`,
    [assetHash],
  );
  const assets = new Map<string, StageAssets>();
  for (const row of jobRows) {
    if (row.stage === null) continue;
    const outputs = row.outputs as { assets?: StageAssets } | null;
    if (outputs?.assets !== undefined && Object.keys(outputs.assets).length > 0) {
      assets.set(row.stage, outputs.assets);
    }
  }
  return { assets, blobs };
}
