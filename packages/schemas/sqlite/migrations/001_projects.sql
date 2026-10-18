-- Local projects (05 §5 `projects`, minus `user_id`: the local database belongs to one user).
-- IDs are `prj_` + ULID (02 §2.1). Times are ISO 8601 UTC strings.
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL CHECK (id LIKE 'prj\_%' ESCAPE '\'),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX projects_updated_at ON projects (updated_at);
