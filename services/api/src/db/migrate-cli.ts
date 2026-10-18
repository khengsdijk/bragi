/** `node dist/db/migrate-cli.js` — apply migrations and exit. */
import { loadConfig } from "../config.js";
import { runMigrations } from "./migrate.js";
import { createPool } from "./pool.js";

const config = loadConfig();
const pool = createPool(config);
try {
  const applied = await runMigrations(pool);
  console.log(applied.length > 0 ? `applied ${applied.length} migration(s)` : "already up to date");
} finally {
  await pool.end();
}
