import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { localDbFromEngine, toRow } from "../sync-engine.js";
import type { LocalDB, SqlValue } from "../types.js";

/**
 * An in-memory LocalDB on Node's built-in SQLite — the fake for unit tests.
 * Real SQLite, so the shared migrations and queries run unchanged; it passes
 * the same contract suite as the shipping adapters.
 */
export function createNodeSqliteDb(): LocalDB {
  const db = new DatabaseSync(":memory:");
  const bind = (params: readonly SqlValue[]): SQLInputValue[] => [...params];
  return localDbFromEngine({
    all: (sql, params) =>
      db
        .prepare(sql)
        .all(...bind(params))
        .map(toRow),
    run: (sql, params) => Number(db.prepare(sql).run(...bind(params)).changes),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  });
}
