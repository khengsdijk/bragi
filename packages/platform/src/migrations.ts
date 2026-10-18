/**
 * The one migration runner for both platforms. The SQL lives in
 * `packages/schemas/sqlite/migrations/NNN_name.sql` (05 §7); the host build
 * hands the files to {@link parseMigrations}, and {@link runMigrations} applies
 * them through the LocalDB interface, so the browser (sqlite-wasm) and the
 * desktop (rusqlite) apply identical SQL with identical bookkeeping.
 */
import { blobHashOf } from "./blob-hash.js";
import type { LocalDB, Migration } from "./types.js";

const FILE_NAME = /(?:^|\/)(\d{3})_([a-z0-9][a-z0-9_]*)\.sql$/;

const label = (m: Pick<Migration, "version" | "name">) =>
  `${String(m.version).padStart(3, "0")}_${m.name}`;

/**
 * Turns `{ path: sql }` (e.g. from Vite's `import.meta.glob`) into an ordered,
 * validated migration list. Versions must start at 001 and have no gaps, so a
 * missing file is caught at build time rather than as a half-migrated database.
 */
export function parseMigrations(files: Readonly<Record<string, string>>): Migration[] {
  const migrations: Migration[] = [];
  for (const [path, sql] of Object.entries(files)) {
    const match = FILE_NAME.exec(path);
    if (!match?.[1] || !match[2]) {
      throw new Error(`Migration file ${JSON.stringify(path)} is not named NNN_name.sql`);
    }
    migrations.push({ version: Number(match[1]), name: match[2], sql });
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    if (migrations[index - 1]?.version === migration.version) {
      throw new Error(`Migration version ${label(migration)} appears twice`);
    }
    if (migration.version !== index + 1) {
      throw new Error(`Migration ${String(index + 1).padStart(3, "0")} is missing`);
    }
  });
  return migrations;
}

const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

const checksumOf = (sql: string) => blobHashOf(new TextEncoder().encode(sql));

/**
 * Applies every migration newer than the database, each in its own
 * transaction together with its bookkeeping row. Returns the versions applied.
 *
 * Refuses to run when an already-applied migration's SQL has changed (history
 * must be append-only) or when the database was written by a newer app.
 */
export async function runMigrations(
  db: LocalDB,
  migrations: readonly Migration[],
): Promise<number[]> {
  await db.run(BOOKKEEPING);
  const appliedRows = await db.query(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  );
  const known = new Map(migrations.map((m) => [m.version, m]));

  for (const row of appliedRows) {
    const version = Number(row.version);
    const migration = known.get(version);
    if (!migration) {
      throw new Error(
        `The local database is at migration ${version}, newer than this app knows. Update Bragi.`,
      );
    }
    if (row.checksum !== (await checksumOf(migration.sql))) {
      throw new Error(`Migration ${label(migration)} was changed after it was applied`);
    }
  }

  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const newlyApplied: number[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    try {
      await db.transaction([
        { sql: migration.sql },
        {
          sql: "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          params: [
            migration.version,
            migration.name,
            await checksumOf(migration.sql),
            new Date().toISOString(),
          ],
        },
      ]);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Migration ${label(migration)} failed: ${reason}`, { cause });
    }
    newlyApplied.push(migration.version);
  }
  return newlyApplied;
}
