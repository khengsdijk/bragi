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
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[] = MIGRATIONS,
  log: MigrationLogger = console,
): Promise<string[]> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.id));
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const client = await pool.connect();
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
    } finally {
      client.release();
    }
  }
  return ran;
}
