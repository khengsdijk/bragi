-- Local library and project snapshots (05 §5, §7; finding 8).
--
-- A project document now has a home between sessions: `snapshot_hash` is the
-- content address of the document in the BlobCache, and `asset_hash` is the
-- uploaded audio it was analysed from. Both are null until ingest lands.
--
-- `library_items` is the local copy of the server's library table; the desktop
-- and the web app share this schema (05 §7). Times are ISO 8601 UTC strings.

ALTER TABLE projects ADD COLUMN snapshot_hash TEXT;
ALTER TABLE projects ADD COLUMN asset_hash TEXT;

CREATE INDEX projects_asset_hash ON projects (asset_hash);

CREATE TABLE library_items (
  id TEXT PRIMARY KEY NOT NULL CHECK (id LIKE 'lib\_%' ESCAPE '\'),
  asset_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  title TEXT,
  artist TEXT,
  album TEXT,
  imported_at TEXT NOT NULL,
  project_id TEXT REFERENCES projects (id) ON DELETE SET NULL,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
);

CREATE INDEX library_items_imported_at ON library_items (imported_at DESC);

-- One visible library row per uploaded asset; a hidden row may be re-imported.
CREATE UNIQUE INDEX library_items_asset ON library_items (asset_hash) WHERE hidden = 0;
