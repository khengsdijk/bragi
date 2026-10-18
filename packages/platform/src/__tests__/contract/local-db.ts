/**
 * The LocalDB contract. Every implementation that can run under Vitest runs this
 * exact suite; the browser (OPFS) and Tauri (rusqlite) builds are additionally
 * exercised end to end by apps/web/e2e and the desktop selftest.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalDB } from "../../types.js";

export function describeLocalDbContract(name: string, open: () => Promise<LocalDB>): void {
  describe(`LocalDB contract: ${name}`, () => {
    let db: LocalDB;

    beforeEach(async () => {
      db = await open();
      await db.run("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, r REAL, s TEXT)");
    });

    afterEach(async () => {
      await db.close().catch(() => undefined);
    });

    it("round-trips text, integer, real and null by column name", async () => {
      await db.run("INSERT INTO t (id, n, r, s) VALUES (?, ?, ?, ?)", ["a", 42, 1.5, null]);
      const rows = await db.query("SELECT id, n, r, s FROM t");
      expect(rows).toEqual([{ id: "a", n: 42, r: 1.5, s: null }]);
    });

    it("returns plain objects that survive structured cloning and JSON", async () => {
      await db.run("INSERT INTO t (id, n) VALUES ('a', 1)");
      const [row] = await db.query("SELECT id, n FROM t");
      expect(JSON.parse(JSON.stringify(row))).toEqual({ id: "a", n: 1 });
      expect(structuredClone(row)).toEqual({ id: "a", n: 1 });
    });

    it("returns an empty list when nothing matches", async () => {
      expect(await db.query("SELECT * FROM t WHERE id = ?", ["missing"])).toEqual([]);
    });

    it("binds positional parameters as values, never as SQL", async () => {
      const hostile = "x'); DROP TABLE t; --";
      await db.run("INSERT INTO t (id) VALUES (?)", [hostile]);
      expect(await db.query("SELECT id FROM t")).toEqual([{ id: hostile }]);
    });

    it("reports how many rows a write changed", async () => {
      await db.run("INSERT INTO t (id, n) VALUES ('a', 1), ('b', 1), ('c', 2)");
      expect(await db.run("UPDATE t SET s = 'x' WHERE n = ?", [1])).toEqual({ changes: 2 });
      expect(await db.run("DELETE FROM t WHERE id = 'zzz'")).toEqual({ changes: 0 });
    });

    it("applies every step of a transaction", async () => {
      await db.transaction([
        { sql: "INSERT INTO t (id) VALUES (?)", params: ["a"] },
        { sql: "INSERT INTO t (id) VALUES (?)", params: ["b"] },
      ]);
      expect(await db.query("SELECT id FROM t ORDER BY id")).toEqual([{ id: "a" }, { id: "b" }]);
    });

    it("runs a multi-statement script step inside a transaction", async () => {
      await db.transaction([
        {
          sql: "CREATE TABLE u (k TEXT); INSERT INTO u VALUES ('1'); INSERT INTO u VALUES ('2');",
        },
      ]);
      expect(await db.query("SELECT count(*) AS c FROM u")).toEqual([{ c: 2 }]);
    });

    it("rolls back every step when one fails, and rejects", async () => {
      await expect(
        db.transaction([
          { sql: "INSERT INTO t (id) VALUES (?)", params: ["a"] },
          { sql: "CREATE TABLE v (k TEXT)" },
          { sql: "INSERT INTO t (id) VALUES (?)", params: ["a"] }, // duplicate key
        ]),
      ).rejects.toBeInstanceOf(Error);
      expect(await db.query("SELECT id FROM t")).toEqual([]);
      expect(await db.query("SELECT name FROM sqlite_master WHERE name = 'v'")).toEqual([]);
    });

    it("stays usable after a failed transaction", async () => {
      await db.transaction([{ sql: "INSERT INTO nope VALUES (1)" }]).catch(() => undefined);
      await db.transaction([{ sql: "INSERT INTO t (id) VALUES ('ok')" }]);
      expect(await db.query("SELECT id FROM t")).toEqual([{ id: "ok" }]);
    });

    it("rejects invalid SQL and constraint violations with an Error", async () => {
      await expect(db.query("SELEC nonsense")).rejects.toBeInstanceOf(Error);
      await db.run("INSERT INTO t (id) VALUES ('a')");
      await expect(db.run("INSERT INTO t (id) VALUES ('a')")).rejects.toBeInstanceOf(Error);
    });

    it("rejects every call after close", async () => {
      await db.close();
      await expect(db.query("SELECT 1")).rejects.toThrow(/closed/i);
      await expect(db.run("SELECT 1")).rejects.toThrow(/closed/i);
      await expect(db.transaction([])).rejects.toThrow(/closed/i);
    });
  });
}
