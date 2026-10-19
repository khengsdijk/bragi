/**
 * Shared test helpers: the real `bragi-model` wasm loaded from bytes in Node, and a loaded demo
 * song. No mocks of the model: the tests exercise the same op application the app ships.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Project } from "@bragi/schemas";

import { buildDemoProject, type DemoSpec, fakeAssetHash, SHORT_DEMO } from "../api/demo-song.js";
import { loadModel, type ModelApi } from "../model/model-api.js";
import { createSongStore, type SongStore } from "../state/song-store.js";

// `import.meta.url` is not a file URL under jsdom, so resolve from this file's directory.
const WASM = resolve(
  import.meta.dirname,
  "../../../../../model-wasm/generated/bragi_model_wasm_bg.wasm",
);

export function loadTestModel(): Promise<ModelApi> {
  return loadModel(readFileSync(WASM));
}

export interface LoadedDemo {
  readonly store: SongStore;
  readonly project: Project;
  readonly model: ModelApi;
}

export async function loadDemo(spec: DemoSpec = SHORT_DEMO): Promise<LoadedDemo> {
  const model = await loadTestModel();
  const built = buildDemoProject(spec, {
    assetFor: (key) => fakeAssetHash(`${spec.title}:${key}`),
  });
  const store = createSongStore(model);
  store.load(built.project, built.assets);
  return { store, project: built.project, model };
}
