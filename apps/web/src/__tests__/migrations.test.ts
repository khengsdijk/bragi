import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { migrations } from "../migrations.js";

const DIRECTORY = new URL("../../../../packages/schemas/sqlite/migrations/", import.meta.url);

describe("bundled migrations", () => {
  it("bundles exactly the files in packages/schemas/sqlite/migrations", () => {
    const onDisk = readdirSync(DIRECTORY)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(onDisk.length).toBeGreaterThan(0);
    expect(migrations.map((migration) => migration.name).length).toBe(onDisk.length);
    for (const [index, name] of onDisk.entries()) {
      const version = index + 1;
      const expected = readFileSync(new URL(name, DIRECTORY), "utf8");
      const migration = migrations[index];
      expect(migration).toBeDefined();
      expect(migration?.version).toBe(version);
      expect(name).toBe(`${String(version).padStart(3, "0")}_${migration?.name}.sql`);
      // The browser and the desktop must apply byte-identical SQL: the runner
      // stores a hash of it (packages/platform/src/migrations.ts), and
      // apps/desktop/src-tauri/src/migrations.rs asserts the same hash.
      expect(migration?.sql).toBe(expected);
    }
  });

  it("starts at version 1 with no gaps", () => {
    expect(migrations.map((migration) => migration.version)).toEqual(
      migrations.map((_, index) => index + 1),
    );
  });
});
