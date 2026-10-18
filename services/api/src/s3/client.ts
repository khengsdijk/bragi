/**
 * Content-addressed object storage (specs/05-backend-and-jobs.md §6).
 *
 * Layout: `s3://<bucket>/sha256/<aa>/<bb>/<full-hex>`. Blobs are immutable and
 * never public: every byte reaches a client through a short-lived presigned URL
 * scoped to a user who owns (or derived) the asset.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { Config } from "../config.js";
import { hashBytes, hashHex } from "../ids.js";

export interface ObjectStore {
  client: S3Client;
  bucket: string;
  /** Presigned `PUT` (default TTL from config, 05 §2). */
  presignPut(hash: string, mime: string | undefined, ttlSec: number): Promise<string>;
  /** Presigned `GET`. */
  presignGet(hash: string, ttlSec: number): Promise<string>;
  head(hash: string): Promise<{ bytes: number } | undefined>;
  download(hash: string): Promise<Uint8Array>;
  upload(hash: string, body: Uint8Array, mime?: string): Promise<void>;
}

/** `sha256:abcdef…` → `sha256/ab/cd/abcdef…`. */
export function objectKey(hash: string): string {
  const hex = hashHex(hash);
  return `sha256/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}`;
}

/** Creates the S3 client and the helpers that use it. */
export function createObjectStore(config: Config): ObjectStore {
  const client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    forcePathStyle: config.s3ForcePathStyle,
    credentials: {
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey: config.s3SecretAccessKey,
    },
  });
  const bucket = config.s3Bucket;

  return {
    client,
    bucket,
    async presignPut(hash, mime, ttlSec) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey(hash),
          ...(mime === undefined ? {} : { ContentType: mime }),
        }),
        { expiresIn: ttlSec },
      );
    },
    async presignGet(hash, ttlSec) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey(hash) }), {
        expiresIn: ttlSec,
      });
    },
    async head(hash) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: objectKey(hash) }),
        );
        return { bytes: result.ContentLength ?? 0 };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    },
    async download(hash) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: objectKey(hash) }),
      );
      return bodyToBytes(result.Body);
    },
    async upload(hash, body, mime) {
      const computed = hashBytes(body);
      if (computed !== hash) {
        throw new Error(`refusing to upload ${hash}: content hashes to ${computed}`);
      }
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey(hash),
          Body: body,
          ...(mime === undefined ? {} : { ContentType: mime }),
        }),
      );
    },
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "NotFound" || name === "NoSuchKey";
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (body === undefined || body === null) return new Uint8Array();
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
