/**
 * Boot-time configuration (specs/01-architecture.md §8).
 *
 * Every value comes from an environment variable and every one has a working
 * default for local development, so the API boots with no `.env` at all. The
 * schema is zod, so a bad value fails the process at start instead of deep
 * inside a request. No secret lives in the repository
 * (specs/13-agent-guide.md §1).
 */
import { z } from "zod";

const booleanish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((value) => value === true || value === "true" || value === "1" || value === "yes");

export const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  /** Bind address for `api-http`. */
  apiHost: z.string().min(1).default("0.0.0.0"),
  apiPort: z.coerce.number().int().min(0).max(65535).default(8080),
  /** Public origin: Better Auth's `baseURL` and the magic-link target. */
  publicUrl: z.string().url().default("http://127.0.0.1:8080"),

  databaseUrl: z.string().min(1).default("postgres://bragi:bragi@127.0.0.1:5432/bragi"),
  natsUrl: z.string().min(1).default("nats://127.0.0.1:4222"),

  s3Endpoint: z.string().url().default("http://127.0.0.1:9000"),
  /**
   * Endpoint clients reach MinIO on, used only to *sign* presigned URLs. When the
   * API runs in Docker, `S3_ENDPOINT` is the internal network name (`minio:9000`)
   * which an out-of-network client cannot resolve, so presigned URLs must use a
   * public address. Defaults to `s3Endpoint`.
   */
  s3PublicEndpoint: z.string().url().optional(),
  s3Region: z.string().min(1).default("us-east-1"),
  s3Bucket: z.string().min(1).default("bragi-blobs"),
  s3AccessKeyId: z.string().min(1).default("bragi"),
  s3SecretAccessKey: z.string().min(1).default("bragi-dev-secret"),
  /** MinIO needs path-style addressing; real S3 uses virtual-host style. */
  s3ForcePathStyle: booleanish.default(true),

  /** SMTP endpoint for magic-link email. Locally this is Mailpit. */
  smtpUrl: z.string().min(1).default("smtp://127.0.0.1:1025"),
  mailFrom: z.string().min(1).default("Bragi <bragi@localhost>"),

  /**
   * `single-user` resolves every request to one owner account; `multi-user` is
   * Better Auth (ADR-0014, 05 §8). Multi-user stays the default for compose and
   * any hosted deployment.
   */
  authMode: z.enum(["single-user", "multi-user"]).default("multi-user"),
  /** The owner account `ensureOwner` creates and single-user mode signs every request in as. */
  ownerEmail: z.string().email().default("owner@bragi.local"),
  ownerName: z.string().min(1).default("Owner"),
  /**
   * Single-user mode refuses a non-loopback `apiHost` unless this is set: anyone
   * who can reach the API would act as the owner. A container binds `0.0.0.0`,
   * so compose single-user needs it (ADR-0014).
   */
  allowRemoteSingleUser: booleanish.default(false),

  authSecret: z.string().min(1).default("dev-only-insecure-auth-secret-change-me"),
  /** Empty disables the provider (the integration test never uses GitHub). */
  githubClientId: z.string().default(""),
  githubClientSecret: z.string().default(""),

  /**
   * Origins the API answers CORS for (comma-separated, 05 §8, finding 9). The
   * web app is same-origin through the Vite proxy, so this mainly serves the
   * desktop webview (`tauri://localhost`) and a direct dev-server origin.
   */
  corsOrigins: z
    .string()
    .default("tauri://localhost,http://localhost:5173,http://127.0.0.1:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ""),
    ),

  otelEnabled: booleanish.default(true),
  /** OTLP/HTTP collector base URL; `/v1/traces` is appended by the exporter. */
  otelEndpoint: z.string().url().default("http://127.0.0.1:4318"),
  otelServiceName: z.string().min(1).default("bragi-api"),

  /** Presigned upload TTL, 05 §2: 15 minutes. */
  uploadUrlTtlSec: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  /** Presigned download TTL, 05 §2: 1 hour. */
  downloadUrlTtlSec: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60),
});

export type Config = z.infer<typeof configSchema>;
type ConfigInput = z.input<typeof configSchema>;

/** Environment variable per configuration field. */
const ENV_KEYS: Record<keyof ConfigInput, string> = {
  nodeEnv: "NODE_ENV",
  apiHost: "API_HOST",
  apiPort: "API_PORT",
  publicUrl: "PUBLIC_URL",
  databaseUrl: "DATABASE_URL",
  natsUrl: "NATS_URL",
  s3Endpoint: "S3_ENDPOINT",
  s3PublicEndpoint: "S3_PUBLIC_ENDPOINT",
  s3Region: "S3_REGION",
  s3Bucket: "S3_BUCKET",
  s3AccessKeyId: "S3_ACCESS_KEY_ID",
  s3SecretAccessKey: "S3_SECRET_ACCESS_KEY",
  s3ForcePathStyle: "S3_FORCE_PATH_STYLE",
  smtpUrl: "SMTP_URL",
  mailFrom: "MAIL_FROM",
  authMode: "BRAGI_AUTH_MODE",
  ownerEmail: "BRAGI_OWNER_EMAIL",
  ownerName: "BRAGI_OWNER_NAME",
  allowRemoteSingleUser: "BRAGI_ALLOW_REMOTE_SINGLE_USER",
  authSecret: "AUTH_SECRET",
  githubClientId: "GITHUB_CLIENT_ID",
  githubClientSecret: "GITHUB_CLIENT_SECRET",
  corsOrigins: "CORS_ORIGINS",
  otelEnabled: "OTEL_ENABLED",
  otelEndpoint: "OTEL_EXPORTER_OTLP_ENDPOINT",
  otelServiceName: "OTEL_SERVICE_NAME",
  uploadUrlTtlSec: "UPLOAD_URL_TTL_SEC",
  downloadUrlTtlSec: "DOWNLOAD_URL_TTL_SEC",
};

/**
 * Reads configuration from an environment record.
 *
 * @param env environment to read (defaults to `process.env`)
 * @returns the validated configuration
 * @throws Error listing every invalid field when validation fails
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, unknown> = {};
  for (const [field, key] of Object.entries(ENV_KEYS)) {
    const value = env[key];
    if (value !== undefined && value !== "") raw[field] = value;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid configuration: ${detail}`);
  }
  return parsed.data;
}
