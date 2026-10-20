/** One initialisation of `@bragi/model-wasm` for the API process (06 §2, docs/wp/2.6.md §B). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The wasm-bindgen module's shape. */
export type ModelModule = typeof import("@bragi/model-wasm");

let loading: Promise<ModelModule> | null = null;

/**
 * Loads and initialises the wasm package once, from bytes so Node never has to fetch a URL.
 *
 * The handle API (`loadProject`, `applyBatch`, `freeDoc`) is sync after this resolves.
 */
export function loadModelWasm(): Promise<ModelModule> {
  loading ??= (async () => {
    const model = await import("@bragi/model-wasm");
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("@bragi/model-wasm/package.json");
    const wasm = join(dirname(manifest), "generated", "bragi_model_wasm_bg.wasm");
    model.initSync({ module: readFileSync(wasm) });
    return model;
  })();
  return loading;
}
