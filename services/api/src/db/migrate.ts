/**
 * A tiny ordered migration runner (specs/05-backend-and-jobs.md §5).
 *
 * It is deliberately small: one transaction per migration, the applied ids in
 * `schema_migrations`, re-runs are no-ops. Anything more (downs, squashing) is
 * not needed while the only writer is this service.
 */
import type { Pool } from "pg";

import { MIGRATIONS, type Migration } from "./migrations.js";

export interface MigrationLogger {
  info(message: string): void;
}

/**
 * Applies every migration that has not been applied yet, in order.
 *
 * @param pool the pool to run against
 * @param migrations ordered migrations (defaults to the bundled set)
 * @param log receives one line per applied migration
 * @returns the ids that were applied in this run
 */
/** Two int4 halves of the advisory lock key that serializes migrations ("bragi-migr"). */
const MIGRATION_LOCK = [0x62726167, 0x6d696772] as const;

export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[] = MIGRATIONS,
  log: MigrationLogger = console,
): Promise<string[]> {
  // One client holds a session advisory lock for the whole run. The API server
  // and the orchestrator both boot and migrate in the local integration test, so
  // without the lock they can race the same migration on a clean volume: the
  // loser blocks until the winner commits, then sees every id already applied.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [...MIGRATION_LOCK]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.id));
    const ran: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      try {
        await client.query("BEGIN");
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [migration.id]);
        await client.query("COMMIT");
        ran.push(migration.id);
        log.info(`migration applied: ${migration.id}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
