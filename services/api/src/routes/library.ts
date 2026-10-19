/**
 * Server library endpoints (specs/05 §2, §5).
 *
 * The library is the user's song list. Importing creates a `library_items` row
 * and enqueues a `quick` analysis (04 §3), so the Universe has something to show
 * before a song is ever opened. The client keeps its own local copy (05 §7); this
 * is the durable replica, not the editor's source of truth.
 */
import type { FastifyInstance } from "fastify";

import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { isAssetHash, newLibraryItemId } from "../ids.js";
import { submitAnalysis } from "../jobs/submit-analysis.js";
import { pathParam, requireSession } from "./guards.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface ImportItem {
  assetHash?: unknown;
  filename?: unknown;
  title?: unknown;
  artist?: unknown;
  album?: unknown;
}

interface ImportBody {
  items?: unknown;
}

interface LibraryRow {
  id: string;
  asset_hash: string;
  filename: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  imported_at: string;
  project_id: string | null;
  hidden: boolean;
}

interface AnalysisStageRow {
  stage: string;
  status: string;
  blob_hash: string | null;
}

/** Registers `/v1/library*`. */
export function registerLibrary(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/library", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const limit = clampLimit(request.query.limit);
    const cursor = request.query.cursor ?? null;

    const { rows } = await ctx.pool.query<LibraryRow>(
      `SELECT id, asset_hash, filename, title, artist, album, imported_at, project_id, hidden
       FROM library_items
       WHERE user_id = $1 AND hidden = false AND ($2::text IS NULL OR imported_at < $2::text)
       ORDER BY imported_at DESC, id DESC
       LIMIT $3`,
      [session.user.id, cursor, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const stagesByAsset = await analysisStages(
      ctx,
      page.map((row) => row.asset_hash),
    );
    return {
      items: page.map((row) => ({
        id: row.id,
        assetHash: row.asset_hash,
        filename: row.filename,
        ...optional("title", row.title),
        ...optional("artist", row.artist),
        ...optional("album", row.album),
        importedAt: row.imported_at,
        ...optional("projectId", row.project_id),
        stages: stagesByAsset.get(row.asset_hash) ?? [],
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.imported_at ?? null) : null,
    };
  });

  app.post<{ Body: ImportBody }>("/v1/library/import", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const raw = request.body?.items;
    if (!Array.isArray(raw)) {
      throw new ApiError("VALIDATION_FAILED", "items must be an array");
    }
    const items = raw.map(validateImportItem);
    if (items.length === 0) throw new ApiError("VALIDATION_FAILED", "items must not be empty");

    const created: string[] = [];
    const enqueued: string[] = [];
    for (const item of items) {
      await assertOwns(ctx, session.user.id, item.assetHash);
      const existing = await ctx.pool.query<{ id: string }>(
        "SELECT id FROM library_items WHERE user_id = $1 AND asset_hash = $2 AND hidden = false LIMIT 1",
        [session.user.id, item.assetHash],
      );
      let id = existing.rows[0]?.id;
      if (id === undefined) {
        id = newLibraryItemId();
        await ctx.pool.query(
          `INSERT INTO library_items (id, user_id, asset_hash, filename, title, artist, album)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            session.user.id,
            item.assetHash,
            item.filename,
            item.title ?? null,
            item.artist ?? null,
            item.album ?? null,
          ],
        );
        created.push(id);
      }
      // Quick analysis: library imports are the many-songs case (04 §3).
      enqueued.push(...(await submitAnalysis(ctx, session.user.id, item.assetHash, "quick")));
    }

    return { items: created, enqueuedStages: [...new Set(enqueued)] };
  });

  app.patch<{ Body: Record<string, unknown> }>("/v1/library/:id", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const id = pathParam(request, "id");
    const body = request.body ?? {};
    const patch: string[] = [];
    const params: (string | boolean | null)[] = [id, session.user.id];
    for (const field of ["title", "artist", "album"] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (value !== null && typeof value !== "string") {
        throw new ApiError("VALIDATION_FAILED", `${field} must be a string or null`);
      }
      params.push(value);
      patch.push(`${field} = $${params.length}`);
    }
    if (typeof body.hidden === "boolean") {
      params.push(body.hidden);
      patch.push(`hidden = $${params.length}`);
    }
    if (patch.length === 0) throw new ApiError("VALIDATION_FAILED", "no updatable fields");

    const { rowCount } = await ctx.pool.query(
      `UPDATE library_items SET ${patch.join(", ")} WHERE id = $1 AND user_id = $2`,
      params,
    );
    if (rowCount === 0) throw new ApiError("NOT_FOUND", "library item not found");
    return { id };
  });

  app.delete("/v1/library/:id", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const id = pathParam(request, "id");
    const { rowCount } = await ctx.pool.query(
      "DELETE FROM library_items WHERE id = $1 AND user_id = $2",
      [id, session.user.id],
    );
    if (rowCount === 0) throw new ApiError("NOT_FOUND", "library item not found");
    return { id, deleted: true };
  });
}

function clampLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

interface ValidImportItem {
  assetHash: string;
  filename: string;
  title?: string;
  artist?: string;
  album?: string;
}

function validateImportItem(item: ImportItem): ValidImportItem {
  if (typeof item.assetHash !== "string" || !isAssetHash(item.assetHash)) {
    throw new ApiError("VALIDATION_FAILED", "assetHash must be sha256:<64 lowercase hex>");
  }
  if (typeof item.filename !== "string" || item.filename === "") {
    throw new ApiError("VALIDATION_FAILED", "filename is required");
  }
  return {
    assetHash: item.assetHash,
    filename: item.filename,
    ...optionalString("title", item.title),
    ...optionalString("artist", item.artist),
    ...optionalString("album", item.album),
  };
}

function optionalString<K extends string>(
  key: K,
  value: unknown,
): Record<K, string> | Record<string, never> {
  return typeof value === "string" && value !== "" ? ({ [key]: value } as Record<K, string>) : {};
}

function optional<K extends string>(key: K, value: string | null): Record<K, string> {
  return value === null ? ({} as Record<K, string>) : ({ [key]: value } as Record<K, string>);
}

async function assertOwns(ctx: AppContext, userId: string, hash: string): Promise<void> {
  const { rowCount } = await ctx.pool.query(
    "SELECT 1 FROM user_assets WHERE user_id = $1 AND hash = $2",
    [userId, hash],
  );
  if (rowCount === null || rowCount === 0) throw new ApiError("NOT_FOUND", "asset not found");
}

/** The analysis status of each asset in a page, keyed by asset hash. */
async function analysisStages(
  ctx: AppContext,
  assetHashes: readonly string[],
): Promise<Map<string, { stage: string; status: string; blob?: string }[]>> {
  const out = new Map<string, { stage: string; status: string; blob?: string }[]>();
  if (assetHashes.length === 0) return out;
  const { rows } = await ctx.pool.query<AnalysisStageRow & { asset_hash: string }>(
    "SELECT asset_hash, stage, status, blob_hash FROM analyses WHERE asset_hash = ANY($1::text[])",
    [assetHashes],
  );
  for (const row of rows) {
    const list = out.get(row.asset_hash) ?? [];
    list.push({
      stage: row.stage,
      status: row.status,
      ...(row.blob_hash === null ? {} : { blob: row.blob_hash }),
    });
    out.set(row.asset_hash, list);
  }
  return out;
}
