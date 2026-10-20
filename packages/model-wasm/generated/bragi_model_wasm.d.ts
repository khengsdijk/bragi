/* tslint:disable */
/* eslint-disable */

/**
 * Applies an op batch to the handle's document and returns the new document JSON.
 *
 * The stored document is replaced on success. On failure the stored document is unchanged and the
 * error is the JSON array of `{ opIndex, code, message }`.
 */
export function applyBatch(handle: number, batch_json: string): string;

/**
 * Applies an op batch that may read other commits to the handle's document and returns the new
 * document JSON.
 *
 * `commit_handles_json` is a JSON object `{ "cmt_…": <document handle> }`; the commit's document is
 * cloned out of the cache before the target handle is updated, so a commit may be the target's own
 * handle. The stored document is replaced on success, exactly like [`apply_batch`]; on failure it
 * is unchanged and the error is the JSON array of `{ opIndex, code, message }`.
 */
export function applyBatchWith(handle: number, batch_json: string, commit_handles_json: string): string;

/**
 * Adds asset metadata (a JSON array of `AssetMeta`) to a handle's index.
 */
export function assetAdd(handle: number, assets_json: string): void;

/**
 * The canonical JSON of the handle's document.
 */
export function canonicalJson(handle: number): string;

/**
 * The commit ID for `(parents, batch, snapshotHash)`, all as JSON/strings.
 */
export function commitId(parents_json: string, batch_json: string, snapshot_hash: string): string;

/**
 * The engine delta between two loaded documents, as JSON.
 */
export function diffDocs(prev: number, next: number): string;

/**
 * How many documents are currently loaded (used by the tests to prove `freeDoc` works).
 */
export function docCount(): number;

/**
 * The handle's document as JSON.
 */
export function documentJson(handle: number): string;

/**
 * Drops a handle. Returns whether it existed.
 */
export function freeDoc(handle: number): boolean;

/**
 * Loads a project document (JSON) and returns its handle.
 *
 * The caller owns the handle and must call [`free_doc`]. The asset index starts empty and is
 * filled with [`asset_add`].
 */
export function loadProject(json: string): number;

/**
 * Resolves a region (JSON) into section- and track-aligned slices, as JSON.
 */
export function resolveRegion(handle: number, region_json: string): string;

/**
 * The tick at which `seconds` has elapsed, using the handle's tempo map.
 */
export function secondsToTicks(handle: number, seconds: number): bigint;

/**
 * The absolute span of every section, as JSON.
 */
export function sectionSpans(handle: number): string;

/**
 * The compact LLM context for the handle's document (`specs/06-ai-planner.md` §2).
 *
 * `focus_json` is a `SummaryFocus` (`{}` or an empty string means the whole song); the result is
 * the line-oriented data block the planner puts in its prompt. A stale focus ID is reported as the
 * same JSON array of `{ opIndex, code, message }` the op API uses.
 */
export function summarizeForLlm(handle: number, focus_json: string): string;

/**
 * Seconds elapsed at `ticks`, using the handle's tempo map.
 */
export function ticksToSeconds(handle: number, ticks: bigint): number;

/**
 * Validates the handle's document; returns `null` when valid, else a JSON error array.
 */
export function validateDoc(handle: number): string | undefined;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly applyBatch: (a: number, b: number, c: number) => [number, number, number, number];
    readonly applyBatchWith: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly assetAdd: (a: number, b: number, c: number) => [number, number];
    readonly canonicalJson: (a: number) => [number, number, number, number];
    readonly commitId: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly diffDocs: (a: number, b: number) => [number, number, number, number];
    readonly docCount: () => number;
    readonly documentJson: (a: number) => [number, number, number, number];
    readonly freeDoc: (a: number) => number;
    readonly loadProject: (a: number, b: number) => [number, number, number];
    readonly resolveRegion: (a: number, b: number, c: number) => [number, number, number, number];
    readonly secondsToTicks: (a: number, b: number) => [bigint, number, number];
    readonly sectionSpans: (a: number) => [number, number, number, number];
    readonly summarizeForLlm: (a: number, b: number, c: number) => [number, number, number, number];
    readonly ticksToSeconds: (a: number, b: bigint) => [number, number, number];
    readonly validateDoc: (a: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
