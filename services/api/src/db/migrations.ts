/**
 * Ordered Postgres migrations (specs/05-backend-and-jobs.md §5).
 *
 * They live in TypeScript rather than `.sql` files so that the compiled output
 * and the source agree without a copy step: the runner is the only reader, and
 * a migration is never hand-applied.
 *
 * `infra/postgres/init/01-extensions.sql` creates the extensions once; the
 * `IF NOT EXISTS` clauses here make the migration safe to run on a database
 * that was initialised differently. The richer indexes (HNSW on `embeddings`)
 * belong to the work packages that populate them.
 */

export interface Migration {
  /** Stable, lexicographically ordered id. Never reuse or rename one. */
  readonly id: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: "001_init",
    sql: `
-- Better Auth core tables (05 §8). Better Auth owns these four; the application
-- adds plan and settings to "user" (05 §5 users(...)). Column names are
-- camelCase because Better Auth addresses them by field name.
CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  plan text DEFAULT 'free',
  settings jsonb
);

CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON session("userId");

CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_user_id_idx ON account("userId");

CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);

-- Assets are content-addressed and immutable (05 §6). Ownership is separate.
CREATE TABLE IF NOT EXISTS assets (
  hash text PRIMARY KEY,
  mime text,
  bytes bigint,
  sample_rate integer,
  channels integer,
  duration_samples bigint,
  derived_from jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_assets (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  hash text NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hash)
);

CREATE TABLE IF NOT EXISTS library_items (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  asset_hash text NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  filename text NOT NULL,
  title text,
  artist text,
  album text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  project_id text,
  hidden boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS library_items_user_idx ON library_items(user_id, imported_at DESC);

-- Analysis results are keyed by asset, not by user (05 §5, 04 §1).
CREATE TABLE IF NOT EXISTS analyses (
  asset_hash text NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  stage text NOT NULL,
  stage_version text NOT NULL,
  status text NOT NULL,
  blob_hash text,
  error jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_hash, stage, stage_version)
);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS commits (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parents text[] NOT NULL DEFAULT '{}',
  batch jsonb NOT NULL,
  snapshot_hash text,
  state text,
  candidate_group text,
  device_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  seq bigserial
);
CREATE INDEX IF NOT EXISTS commits_project_seq_idx ON commits(project_id, seq);

CREATE TABLE IF NOT EXISTS refs (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  commit_id text NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  project_id text,
  capability text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  params jsonb,
  outputs jsonb,
  error jsonb,
  gpu_seconds numeric,
  idempotency_key text,
  input_hash text,
  traceparent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_user_created_idx ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);

-- The result cache, keyed by idempotencyKey (05 §4.3, §9).
CREATE TABLE IF NOT EXISTS job_results (
  idempotency_key text PRIMARY KEY,
  outputs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS embeddings (
  id text PRIMARY KEY,
  asset_hash text NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  scope text NOT NULL,
  scope_ref text,
  model text NOT NULL,
  vec vector(512)
);

CREATE TABLE IF NOT EXISTS library_layouts (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  lens text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  blob_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lens)
);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  job_id text,
  credits numeric NOT NULL DEFAULT 0,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    // WP-1.6 populates `embeddings` (04 §6.1), so it owns the indexes 001 deliberately left out.
    id: "002_embeddings_hnsw",
    sql: `
-- Approximate nearest-neighbour search over the 512-d vectors (05 §5). HNSW with cosine
-- distance matches the L2-normalised CLAP vectors.
CREATE INDEX IF NOT EXISTS embeddings_vec_hnsw_idx
  ON embeddings USING hnsw (vec vector_cosine_ops);

-- Lookup and upsert by (asset, scope, ref, model): the natural key of one vector.
CREATE UNIQUE INDEX IF NOT EXISTS embeddings_identity_idx
  ON embeddings (asset_hash, scope, coalesce(scope_ref, ''), model);
`,
  },
  {
    // WP-2.7 charges generation jobs (09 §2, 05 §9). `001_init` only had the
    // amount and a free-text reason; the allowance is summed by user and day, and
    // the ledger has to say which capability and tier the credits bought.
    id: "003_usage_ledger_cost",
    sql: `
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS capability text;
ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS tier text;

CREATE INDEX IF NOT EXISTS usage_ledger_user_created_idx
  ON usage_ledger (user_id, created_at DESC);
`,
  },
  {
    // WP-2.8 executes a proposed plan by id (06 §5): the plan is stored when it is returned and
    // read back at execute, so the client never posts it back. Rows expire rather than being
    // deleted, so a stale id is a 404 and a live one is untouched.
    id: "004_plans",
    sql: `
CREATE TABLE IF NOT EXISTS plans (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS plans_user_created_idx ON plans (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plans_expires_idx ON plans (expires_at);
`,
  },
];
