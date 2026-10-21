/**
 * The slice of `@bragi/model-wasm` the Song Store uses, and the one place that initialises it.
 *
 * `bragi-model` is the only code allowed to change a document (13 §1 rule 4). The app reaches it
 * through this interface so a test can hand in the real wasm (loaded from bytes in Node) and the
 * browser can let wasm-bindgen fetch it.
 */
import type * as ModelWasm from "@bragi/model-wasm";

export interface ModelApi {
  readonly loadProject: typeof ModelWasm.loadProject;
  readonly assetAdd: typeof ModelWasm.assetAdd;
  readonly validateDoc: typeof ModelWasm.validateDoc;
  readonly applyBatch: typeof ModelWasm.applyBatch;
  readonly applyBatchWith: typeof ModelWasm.applyBatchWith;
  readonly documentJson: typeof ModelWasm.documentJson;
  readonly canonicalJson: typeof ModelWasm.canonicalJson;
  readonly commitId: typeof ModelWasm.commitId;
  readonly diffDocs: typeof ModelWasm.diffDocs;
  /** Builds the candidate batch that places an accepted extend (09 §4.2). */
  readonly extendPlacement: typeof ModelWasm.extendPlacement;
  /** Builds the candidate batch that fills an erased gap (09 §4.3). */
  readonly fillPlacement: typeof ModelWasm.fillPlacement;
  /** Builds the batch that sets a generated transition on a section (09 §4.4). */
  readonly transitionPlacement: typeof ModelWasm.transitionPlacement;
  /** The bar-aligned context span at one song edge (03 §9). */
  readonly barAlignedContextRange: typeof ModelWasm.barAlignedContextRange;
  readonly freeDoc: typeof ModelWasm.freeDoc;
  /** How many handles are live; the tests use it to prove nothing leaks. */
  readonly docCount: typeof ModelWasm.docCount;
  readonly sectionSpans: typeof ModelWasm.sectionSpans;
  readonly ticksToSeconds: typeof ModelWasm.ticksToSeconds;
  readonly secondsToTicks: typeof ModelWasm.secondsToTicks;
}

let loading: Promise<ModelApi> | null = null;

/**
 * Initialises the wasm once and returns the API. Pass `wasm` bytes where `fetch` is not an
 * option (Node tests); in the browser leave it out and wasm-bindgen fetches the file next to its
 * glue, which the bundler serves.
 */
export function loadModel(wasm?: BufferSource): Promise<ModelApi> {
  loading ??= (async () => {
    const module = await import("@bragi/model-wasm");
    await module.default(wasm === undefined ? undefined : { module_or_path: wasm });
    return module;
  })();
  return loading;
}
