/**
 * Analysis submission and status (specs/05 §2, §4.4, 04 §2–§3).
 *
 * `POST /v1/analyses` is the thin HTTP shell around {@link submitAnalysis}: it
 * validates, authorises, then lets the shared helper create the missing stages
 * and publish the ready ones. The call is **idempotent** (finding 4): a stage
 * that is already `queued`, `running` or `done` is never submitted again, so a
 * reload or a retry cannot duplicate work.
 */
import type { FastifyInstance } from "fastify";

import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { isAssetHash } from "../ids.js";
import { type AnalysisProfile, implementedStagesForProfile, PROFILE_STAGES } from "../jobs/dag.js";
import { submitAnalysis } from "../jobs/submit-analysis.js";
import { pathParam, requireSession } from "./guards.js";

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
    const session = await requireSession(ctx.sessions, request);
    const body = request.body ?? { assetHash: "", profile: "quick" as AnalysisProfile };
    if (!isAssetHash(body.assetHash)) {
      throw new ApiError("VALIDATION_FAILED", "assetHash must be sha256:<64 lowercase hex>");
    }
    if (!Object.hasOwn(PROFILE_STAGES, body.profile)) {
      throw new ApiError("VALIDATION_FAILED", "profile must be quick, standard or deep");
    }
    await assertOwns(ctx, session.user.id, body.assetHash);

    await submitAnalysis(ctx, session.user.id, body.assetHash, body.profile);

    const stages = implementedStagesForProfile(body.profile);
    const { rows } = await ctx.pool.query<AnalysisRow>(
      "SELECT stage, status, blob_hash FROM analyses WHERE asset_hash = $1",
      [body.assetHash],
    );
    const byStage = new Map(rows.map((row) => [row.stage, row]));
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
    const session = await requireSession(ctx.sessions, request);
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
