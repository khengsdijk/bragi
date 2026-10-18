/**
 * The shared SQLite migrations, bundled into the page.
 *
 * The SQL itself lives in `packages/schemas/sqlite/migrations` (05 §7) and is
 * owned by both hosts: this glob hands the same bytes to the browser's
 * sqlite-wasm and — because the desktop app loads this very bundle — to the
 * desktop's rusqlite. `parseMigrations` refuses a gap or a misnamed file at
 * startup rather than half-applying a database.
 */
import { type Migration, parseMigrations } from "@bragi/platform";

const files = import.meta.glob("../../../packages/schemas/sqlite/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every migration, oldest first. Parsed once, at module load. */
export const migrations: readonly Migration[] = parseMigrations(files);
