import { readdirSync, readFileSync } from "node:fs";

import { parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import { describe, expect, it } from "vitest";

import { readSetting, readSmartTransitions, SMART_TRANSITIONS_KEY } from "../api/settings-repo.js";
import { createSettingsStore } from "../state/settings-store.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

describe("device settings", () => {
  it("defaults smart transitions on and persists a change in local_settings", async () => {
    const platform = await createMemoryPlatform(migrations);
    expect(await readSmartTransitions(platform.localDb)).toBe(true);

    const store = createSettingsStore(platform.localDb);
    expect(store.store.getState()).toEqual({ smartTransitions: true, loaded: false });

    await store.setSmartTransitions(false);
    expect(store.store.getState()).toMatchObject({ smartTransitions: false, loaded: false });
    expect(await readSetting(platform.localDb, SMART_TRANSITIONS_KEY)).toBe("false");

    // A fresh store (a reload) reads the stored value.
    const reloaded = createSettingsStore(platform.localDb);
    await reloaded.load();
    expect(reloaded.store.getState()).toEqual({ smartTransitions: false, loaded: true });
  });

  it("works without a database, using the default for the session", async () => {
    const store = createSettingsStore();
    await store.load();
    expect(store.store.getState()).toEqual({ smartTransitions: true, loaded: true });
    await store.setSmartTransitions(false);
    expect(store.store.getState().smartTransitions).toBe(false);
  });
});
