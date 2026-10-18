/**
 * Analysis submission and status (specs/05 §2, §4.4, 04 §2–§3).
 *
 * `POST /v1/analyses` is where the DAG becomes work: cached stages return
 * immediately, and the stages whose dependencies are satisfied are published as
 * jobs. The orchestrator enqueues the dependents of each stage as it completes.
 */
import type { FastifyInstance } from "fastify";

import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { isAssetHash } from "../ids.js";
import {
  type AnalysisProfile,
  PROFILE_STAGES,
  readyStages,
  stagesForProfile,
} from "../jobs/dag.js";
import { submitJob } from "../jobs/service.js";
import { pathParam, requireSession } from "./guards.js";

/**
 * Placeholder stage version. Every analysis stage has its own real version
 * (`separation@htdemucs_6s-1`, 04 §1) once the stage exists in WP-1.2+.
 */
export const STAGE_VERSION = "v0";

interface AnalysesBody {
  assetHash: string;
  profile: AnalysisProfile;
}

interface AnalysisRow {
  stage: string;
  status: string;
  blob_hash: string | null;
}

interface StageStatus {
  stage: string;
  status: string;
  blob?: string;
}

/** Registers `/v1/analyses*`. */
export function registerAnalyses(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: AnalysesBody }>("/v1/analyses", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const body = request.body ?? { assetHash: "", profile: "quick" as AnalysisProfile };
    if (!isAssetHash(body.assetHash)) {
      throw new ApiError("VALIDATION_FAILED", "assetHash must be sha256:<64 lowercase hex>");
    }
    if (!Object.hasOwn(PROFILE_STAGES, body.profile)) {
      throw new ApiError("VALIDATION_FAILED", "profile must be quick, standard or deep");
    }
    await assertOwns(ctx, session.user.id, body.assetHash);

    const stages = stagesForProfile(body.profile);
    const { rows } = await ctx.pool.query<AnalysisRow>(
      "SELECT stage, status, blob_hash FROM analyses WHERE asset_hash = $1",
      [body.assetHash],
    );
    const byStage = new Map(rows.map((row) => [row.stage, row]));

    const completed = new Set(stages.filter((stage) => byStage.get(stage)?.status === "done"));
    const pending = stages.filter((stage) => !completed.has(stage));
    const ready = readyStages(completed, pending);

    for (const stage of pending) {
      await ctx.pool.query(
        `INSERT INTO analyses (asset_hash, stage, stage_version, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (asset_hash, stage, stage_version)
         DO UPDATE SET updated_at = now()
         WHERE analyses.status NOT IN ('done', 'running')`,
        [body.assetHash, stage, STAGE_VERSION],
      );
    }

    for (const stage of ready) {
      await submitJob(ctx, session.user.id, {
        capability: `analysis.${stage}`,
        priority: "interactive",
        assets: { source: body.assetHash },
        params: { assetHash: body.assetHash, stage, profile: body.profile },
      });
      await ctx.pool.query(
        `UPDATE analyses SET status = 'queued', updated_at = now()
         WHERE asset_hash = $1 AND stage = $2 AND stage_version = $3`,
        [body.assetHash, stage, STAGE_VERSION],
      );
      byStage.set(stage, { stage, status: "queued", blob_hash: null });
    }

    return {
      assetHash: body.assetHash,
      profile: body.profile,
      stages: stages.map((stage): StageStatus => {
        const row = byStage.get(stage);
        const status = row?.status ?? "pending";
        const blob = row?.blob_hash ?? undefined;
        return blob === undefined ? { stage, status } : { stage, status, blob };
      }),
    };
  });

  app.get("/v1/analyses/:assetHash", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const assetHash = pathParam(request, "assetHash");
    if (!isAssetHash(assetHash)) {
      throw new ApiError("VALIDATION_FAILED", "assetHash must be sha256:<64 lowercase hex>");
    }
    await assertOwns(ctx, session.user.id, assetHash);
    const { rows } = await ctx.pool.query<AnalysisRow>(
      "SELECT stage, status, blob_hash FROM analyses WHERE asset_hash = $1",
      [assetHash],
    );
    return {
      assetHash,
      stages: rows.map((row): StageStatus => {
        const blob = row.blob_hash ?? undefined;
        return blob === undefined
          ? { stage: row.stage, status: row.status }
          : { stage: row.stage, status: row.status, blob };
      }),
    };
  });
}

async function assertOwns(ctx: AppContext, userId: string, hash: string): Promise<void> {
  const { rowCount } = await ctx.pool.query(
    "SELECT 1 FROM user_assets WHERE user_id = $1 AND hash = $2",
    [userId, hash],
  );
  if (rowCount === null || rowCount === 0) throw new ApiError("NOT_FOUND", "asset not found");
}
