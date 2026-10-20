/**
 * A demo song with a real history store, for the brush-model tests.
 *
 * The model is the real `bragi-model` wasm (no mock), so a brush batch is applied exactly as the
 * app applies it and undo restores a real snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { Project } from "@bragi/schemas";

import { createHistory, type History } from "../../history/state/history.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import type { ModelApi } from "../../song/model/model-api.js";
import { createSongStore, type SongStore } from "../../song/state/song-store.js";

export const NOW = new Date("2026-10-19T12:00:00.000Z");
export const PROJECT_ID = "prj_BRUSHTEST00000000000001";
/** One bar of the short demo: 4/4 at PPQ 960. */
export const BAR = 3840;

// `import.meta.url` is not a file URL under jsdom, so resolve from this file's directory.
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../../../../schemas/sqlite/migrations");

export interface BrushFixture {
  readonly platform: Platform;
  readonly model: ModelApi;
  readonly store: SongStore;
  readonly history: History;
  readonly project: Project;
}

export async function openBrushFixture(): Promise<BrushFixture> {
  const migrations = parseMigrations(
    Object.fromEntries(
      readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .map((name) => [name, readFileSync(resolve(MIGRATIONS_DIR, name), "utf8")]),
    ),
  );
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`brushes:${key}`),
    projectId: PROJECT_ID.slice("prj_".length),
  });
  await platform.localDb.run(
    `INSERT OR IGNORE INTO projects (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [built.project.id, built.project.meta.title, built.project.meta.createdAt, NOW.toISOString()],
  );
  const store = createSongStore(model);
  store.load(built.project, built.assets);
  const history = createHistory({
    platform,
    songStore: store,
    model,
    projectId: built.project.id,
    now: () => NOW,
  });
  return { platform, model, store, history, project: built.project };
}

export function documentOf(fixture: BrushFixture): Project {
  const doc = fixture.store.store.getState().doc;
  if (doc === null) throw new Error("no document");
  return doc;
}
