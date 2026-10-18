import type { BindingSpec, Database } from "@sqlite.org/sqlite-wasm";

import { type SyncSqlEngine, toRow } from "../sync-engine.js";
import type { SqlValue } from "../types.js";

const bind = (params: readonly SqlValue[]): BindingSpec | undefined =>
  params.length > 0 ? [...params] : undefined;

/**
 * Adapts an sqlite-wasm OO1 database to {@link SyncSqlEngine}. The same code
 * runs in the browser worker (on the OPFS VFS) and in Vitest (in memory).
 */
export function sqliteWasmEngine(db: Database): SyncSqlEngine {
  return {
    all: (sql, params) => {
      const spec = bind(params);
      const rows = spec === undefined ? db.selectObjects(sql) : db.selectObjects(sql, spec);
      return rows.map(toRow);
    },
    run: (sql, params) => {
      const spec = bind(params);
      if (spec === undefined) db.exec(sql);
      else db.exec(sql, { bind: spec });
      return Number(db.changes());
    },
    exec: (sql) => {
      db.exec(sql);
    },
    close: () => {
      db.close();
    },
  };
}
