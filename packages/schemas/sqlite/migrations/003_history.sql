-- The local version DAG (02 §7; 05 §5, §7).
--
-- Every commit stores the batch that produced it and a content-addressed
-- snapshot of the document after it, so checkout is O(1). v1 has at most one
-- parent; branches are natural siblings and `region.adopt` replaces true
-- merges. Refs use the 05 §5 names: `head:<deviceId>`, `branch:<name>` and
-- `star:<commitId>`.
--
-- `local_settings` holds this device's identity, and `outbox` is the sync queue
-- filled now and drained by WP-2.9. Times are ISO 8601 UTC strings.

CREATE TABLE commits (
  id TEXT PRIMARY KEY NOT NULL CHECK (id LIKE 'cmt\_%' ESCAPE '\'),
  project_id TEXT NOT NULL REFERENCES projects (id),
  parent TEXT NULL,
  batch TEXT NOT NULL,
  label TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'ai', 'system')),
  snapshot_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('committed', 'candidate', 'discarded')),
  candidate_group TEXT,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NULL
);

CREATE INDEX commits_project_created ON commits (project_id, created_at);

CREATE TABLE refs (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, name)
);

CREATE TABLE local_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE outbox (
  commit_id TEXT PRIMARY KEY NOT NULL
);
