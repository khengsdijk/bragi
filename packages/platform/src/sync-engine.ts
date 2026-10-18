import { closedError, toError } from "./errors.js";
import type { LocalDB, Row, RunResult, SqlValue, Statement } from "./types.js";

/**
 * The few synchronous primitives a SQLite binding must provide. sqlite-wasm
 * (in the browser worker) and `node:sqlite` (the test fake) both implement it,
 * so the transaction and close semantics in {@link localDbFromEngine} are
 * written — and tested — once.
 */
export interface SyncSqlEngine {
  /** Runs one statement, returns its rows. */
  all(sql: string, params: readonly SqlValue[]): Row[];
  /** Runs one statement, returns `sqlite3_changes()`. */
  run(sql: string, params: readonly SqlValue[]): number;
  /** Runs a script of zero or more statements without parameters. */
  exec(sql: string): void;
  close(): void;
}

/** Wraps a synchronous engine in the async {@link LocalDB} contract. */
export function localDbFromEngine(engine: SyncSqlEngine): LocalDB {
  let closed = false;

  const guard = <T>(work: () => T): Promise<T> => {
    if (closed) return Promise.reject(closedError());
    try {
      return Promise.resolve(work());
    } catch (cause) {
      return Promise.reject(toError(cause, "LocalDB"));
    }
  };

  return {
    query: (sql, params = []) => guard(() => engine.all(sql, params)),
    run: (sql, params = []) => guard((): RunResult => ({ changes: engine.run(sql, params) })),
    transaction: (steps: readonly Statement[]) =>
      guard(() => {
        engine.exec("BEGIN IMMEDIATE");
        try {
          for (const step of steps) {
            if (step.params === undefined) engine.exec(step.sql);
            else engine.run(step.sql, step.params);
          }
          engine.exec("COMMIT");
        } catch (cause) {
          engine.exec("ROLLBACK");
          throw cause;
        }
      }),
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return guard(() => engine.close()).catch(() => undefined);
    },
  };
}

/**
 * Converts a driver value into a {@link SqlValue}. Integers beyond the safe
 * range are refused rather than silently rounded.
 */
export function toSqlValue(value: unknown, column: string): SqlValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number(value);
    }
    throw new RangeError(`Column ${column}: integer ${value} is outside the safe JS range`);
  }
  throw new TypeError(`Column ${column}: unsupported value type (blobs belong in the BlobCache)`);
}

/** Copies a driver row into a plain object of {@link SqlValue}s. */
export function toRow(raw: Readonly<Record<string, unknown>>): Row {
  const row: Record<string, SqlValue> = {};
  for (const [column, value] of Object.entries(raw)) row[column] = toSqlValue(value, column);
  return row;
}
