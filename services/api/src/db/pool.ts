/** Postgres connection pool (specs/05-backend-and-jobs.md §5). */
import { Pool } from "pg";

import type { Config } from "../config.js";

/** Creates the shared `pg` pool. The caller owns `pool.end()`. */
export function createPool(config: Config): Pool {
  return new Pool({ connectionString: config.databaseUrl, max: 10 });
}
