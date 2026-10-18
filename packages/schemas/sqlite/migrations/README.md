# Local database migrations

The one migration set for the local SQLite database, shared by the browser (sqlite-wasm on OPFS)
and the desktop app (rusqlite) — [01 §1, §3](../../../../specs/01-architecture.md),
[05 §7](../../../../specs/05-backend-and-jobs.md).

Rules:

- Files are named `NNN_name.sql` (`001_projects.sql`): three digits, starting at `001`, no gaps,
  lowercase snake_case name.
- **Append-only.** Never edit a migration that has shipped: the runner stores a SHA-256 of each
  applied file and refuses to start when one changed. Add a new file instead.
- Plain SQLite SQL that both builds accept. Each file runs in one transaction together with its
  bookkeeping row in `schema_migrations`, so do not put `BEGIN`/`COMMIT` in it.

How they are applied:

- One runner, `runMigrations` in [`@bragi/platform`](../../../platform/src/migrations.ts), runs
  over the `LocalDB` interface on both platforms. `apps/web` bundles the files with Vite's
  `import.meta.glob`; the desktop app loads the same bundle.
- `apps/desktop/src-tauri` also applies every file here through rusqlite in `cargo test`, so SQL
  that only one SQLite build accepts fails the gate.

Owned by WP-0.5 (this directory only; the rest of `packages/schemas` is WP-0.2's).
