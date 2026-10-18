import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseMigrations, runMigrations } from "../migrations.js";
import { createNodeSqliteDb } from "../testing/node-sqlite-db.js";

const SHARED_DIR = new URL("../../../schemas/sqlite/migrations/", import.meta.url);

function sharedMigrationFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(SHARED_DIR).filter((file) => file.endsWith(".sql"))) {
    files[`/packages/schemas/sqlite/migrations/${name}`] = readFileSync(
      new URL(name, SHARED_DIR),
      "utf8",
    );
  }
  return files;
}

describe("parseMigrations", () => {
  it("orders files by their NNN prefix, whatever the path", () => {
    expect(
      parseMigrations({
        "x/002_second.sql": "B",
        "/a/b/001_first.sql": "A",
      }),
    ).toEqual([
      { version: 1, name: "first", sql: "A" },
      { version: 2, name: "second", sql: "B" },
    ]);
  });

  it.each([["1_short.sql"], ["001-dash.sql"], ["001_.sql"], ["001_Upper.sql"], ["001_ok.txt"]])(
    "rejects a file not named NNN_name.sql: %s",
    (file) => {
      expect(() => parseMigrations({ [file]: "" })).toThrow(/NNN_name\.sql/);
    },
  );

  it("rejects duplicate and missing versions", () => {
    expect(() => parseMigrations({ "001_a.sql": "", "001_b.sql": "" })).toThrow(/twice/);
    expect(() => parseMigrations({ "001_a.sql": "", "003_c.sql": "" })).toThrow(/002/);
  });
});

describe("runMigrations", () => {
  const v1 = { version: 1, name: "one", sql: "CREATE TABLE one (id TEXT PRIMARY KEY);" };
  const v2 = {
    version: 2,
    name: "two",
    sql: "CREATE TABLE two (id TEXT); CREATE INDEX i ON two(id);",
  };

  it("applies pending migrations in order and records them", async () => {
    const db = createNodeSqliteDb();
    expect(await runMigrations(db, [v1, v2])).toEqual([1, 2]);
    const recorded = await db.query("SELECT version, name FROM schema_migrations ORDER BY version");
    expect(recorded).toEqual([
      { version: 1, name: "one" },
      { version: 2, name: "two" },
    ]);
    expect(
      await db.query(
        "SELECT name FROM sqlite_master WHERE name IN ('one','two','i') ORDER BY name",
      ),
    ).toEqual([{ name: "i" }, { name: "one" }, { name: "two" }]);
  });

  it("is idempotent and only applies what is new", async () => {
    const db = createNodeSqliteDb();
    expect(await runMigrations(db, [v1])).toEqual([1]);
    expect(await runMigrations(db, [v1])).toEqual([]);
    expect(await runMigrations(db, [v1, v2])).toEqual([2]);
  });

  it("refuses to run when an applied migration was edited", async () => {
    const db = createNodeSqliteDb();
    await runMigrations(db, [v1]);
    const edited = { ...v1, sql: `${v1.sql} -- changed` };
    await expect(runMigrations(db, [edited])).rejects.toThrow(/001_one.*changed/);
  });

  it("refuses a database written by a newer app", async () => {
    const db = createNodeSqliteDb();
    await runMigrations(db, [v1, v2]);
    await expect(runMigrations(db, [v1])).rejects.toThrow(/newer/);
  });

  it("rolls a failing migration back completely and records nothing", async () => {
    const db = createNodeSqliteDb();
    const broken = {
      version: 1,
      name: "broken",
      sql: "CREATE TABLE ok (id TEXT); CREATE TABLE ok (id TEXT);",
    };
    await expect(runMigrations(db, [broken])).rejects.toThrow(/001_broken/);
    expect(await db.query("SELECT name FROM sqlite_master WHERE name = 'ok'")).toEqual([]);
    expect(await db.query("SELECT * FROM schema_migrations")).toEqual([]);
  });

  it("applies the shared migrations from packages/schemas/sqlite/migrations", async () => {
    const migrations = parseMigrations(sharedMigrationFiles());
    expect(migrations.length).toBeGreaterThan(0);
    const db = createNodeSqliteDb();
    expect(await runMigrations(db, migrations)).toEqual(migrations.map((m) => m.version));
    const columns = await db.query("SELECT name FROM pragma_table_info('projects') ORDER BY cid");
    expect(columns.map((c) => c.name)).toEqual([
      "id",
      "title",
      "created_at",
      "updated_at",
      "deleted_at",
    ]);
  });
});
