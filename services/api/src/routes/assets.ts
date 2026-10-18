/**
 * Asset endpoints (specs/05 §2, §6).
 *
 * Upload is three steps so the API never proxies audio bytes: the client asks
 * for a presigned PUT, uploads to S3 directly, then asks the server to verify
 * the object's size and SHA-256 before it records ownership. Downloads are
 * presigned GETs, and only for an asset the user owns or derived.
 */
import type { FastifyInstance } from "fastify";

import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { hashBytes, isAssetHash } from "../ids.js";
import { pathParam, requireSession } from "./guards.js";

interface PresignBody {
  hash: string;
  bytes: number;
  mime?: string;
}

interface CompleteBody {
  mime?: string;
}

/** Registers `/v1/assets/*`. */
export function registerAssets(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: PresignBody }>("/v1/assets/presign", async (request) => {
    await requireSession(ctx.auth, request);
    const { hash, bytes, mime } = request.body ?? { hash: "", bytes: 0 };
    if (!isAssetHash(hash)) {
      throw new ApiError("VALIDATION_FAILED", "hash must be sha256:<64 lowercase hex>");
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new ApiError("VALIDATION_FAILED", "bytes must be a non-negative integer");
    }
    const { rowCount } = await ctx.pool.query("SELECT 1 FROM assets WHERE hash = $1", [hash]);
    if (rowCount !== null && rowCount > 0) return { exists: true };

    const uploadUrl = await ctx.store.presignPut(hash, mime, ctx.config.uploadUrlTtlSec);
    return {
      exists: false,
      uploadUrl,
      headers: mime === undefined ? {} : { "content-type": mime },
      expiresIn: ctx.config.uploadUrlTtlSec,
    };
  });

  app.post<{ Body: CompleteBody }>("/v1/assets/:hash/complete", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const hash = pathParam(request, "hash");
    if (!isAssetHash(hash)) {
      throw new ApiError("VALIDATION_FAILED", "hash must be sha256:<64 lowercase hex>");
    }
    const head = await ctx.store.head(hash);
    if (!head) throw new ApiError("NOT_FOUND", "no uploaded object for that hash");

    const bytes = await ctx.store.download(hash);
    const actual = hashBytes(bytes);
    if (actual !== hash) {
      throw new ApiError("ASSET_CORRUPT", "uploaded bytes do not match their hash", {
        expected: hash,
        actual,
      });
    }

    const mime = request.body?.mime ?? null;
    await ctx.pool.query(
      `INSERT INTO assets (hash, mime, bytes) VALUES ($1, $2, $3)
       ON CONFLICT (hash) DO UPDATE SET mime = COALESCE(EXCLUDED.mime, assets.mime), bytes = EXCLUDED.bytes`,
      [hash, mime, bytes.length],
    );
    await ctx.pool.query(
      `INSERT INTO user_assets (user_id, hash, role) VALUES ($1, $2, 'source')
       ON CONFLICT (user_id, hash) DO NOTHING`,
      [session.user.id, hash],
    );
    return { hash, bytes: bytes.length, mime };
  });

  app.get("/v1/assets/:hash/url", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const hash = pathParam(request, "hash");
    if (!isAssetHash(hash)) {
      throw new ApiError("VALIDATION_FAILED", "hash must be sha256:<64 lowercase hex>");
    }
    const { rowCount } = await ctx.pool.query(
      "SELECT 1 FROM user_assets WHERE user_id = $1 AND hash = $2",
      [session.user.id, hash],
    );
    if (rowCount === null || rowCount === 0) {
      throw new ApiError("NOT_FOUND", "asset not found");
    }
    return {
      url: await ctx.store.presignGet(hash, ctx.config.downloadUrlTtlSec),
      expiresIn: ctx.config.downloadUrlTtlSec,
    };
  });
}
