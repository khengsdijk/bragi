/* @ts-self-types="./bragi_model_wasm.d.ts" */

/**
 * Applies an op batch to the handle's document and returns the new document JSON.
 *
 * The stored document is replaced on success. On failure the stored document is unchanged and the
 * error is the JSON array of `{ opIndex, code, message }`.
 * @param {number} handle
 * @param {string} batch_json
 * @returns {string}
 */
export function applyBatch(handle, batch_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(batch_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.applyBatch(handle, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Applies an op batch that may read other commits to the handle's document and returns the new
 * document JSON.
 *
 * `commit_handles_json` is a JSON object `{ "cmt_…": <document handle> }`; the commit's document is
 * cloned out of the cache before the target handle is updated, so a commit may be the target's own
 * handle. The stored document is replaced on success, exactly like [`apply_batch`]; on failure it
 * is unchanged and the error is the JSON array of `{ opIndex, code, message }`.
 * @param {number} handle
 * @param {string} batch_json
 * @param {string} commit_handles_json
 * @returns {string}
 */
export function applyBatchWith(handle, batch_json, commit_handles_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(batch_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(commit_handles_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.applyBatchWith(handle, ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Adds asset metadata (a JSON array of `AssetMeta`) to a handle's index.
 * @param {number} handle
 * @param {string} assets_json
 */
export function assetAdd(handle, assets_json) {
    const ptr0 = passStringToWasm0(assets_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.assetAdd(handle, ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * A bar-aligned context range of about `seconds` seconds at one song edge, as JSON
 * (`{ startTick, endTick }`).
 *
 * `edge` is `"start"` (an intro) or `"end"` (a continuation). Generation always speaks bars, so
 * the UI asks the model for the bar lines instead of doing the arithmetic in TypeScript
 * (`specs/03-audio-engine.md` §9, `specs/09-generation.md` §4.2).
 * @param {number} handle
 * @param {string} edge
 * @param {number} seconds
 * @returns {string}
 */
export function barAlignedContextRange(handle, edge, seconds) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(edge, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.barAlignedContextRange(handle, ptr0, len0, seconds);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The canonical JSON of the handle's document.
 * @param {number} handle
 * @returns {string}
 */
export function canonicalJson(handle) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.canonicalJson(handle);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * The tick-accurate changed spans between two loaded documents, as JSON
 * (`specs/06-ai-planner.md` §7).
 *
 * The two documents must have the same section set, order and lengths; a different set is
 * reported section-wide per track. The asset indexes of both handles are merged, because a
 * document that added a clip may know an asset the other does not.
 * @param {number} prev
 * @param {number} next
 * @returns {string}
 */
export function changedSpans(prev, next) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.changedSpans(prev, next);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * The commit ID for `(parents, batch, snapshotHash)`, all as JSON/strings.
 * @param {string} parents_json
 * @param {string} batch_json
 * @param {string} snapshot_hash
 * @returns {string}
 */
export function commitId(parents_json, batch_json, snapshot_hash) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(parents_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(batch_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(snapshot_hash, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.commitId(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * The engine delta between two loaded documents, as JSON.
 * @param {number} prev
 * @param {number} next
 * @returns {string}
 */
export function diffDocs(prev, next) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.diffDocs(prev, next);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * How many documents are currently loaded (used by the tests to prove `freeDoc` works).
 * @returns {number}
 */
export function docCount() {
    const ret = wasm.docCount();
    return ret >>> 0;
}

/**
 * The handle's document as JSON.
 * @param {number} handle
 * @returns {string}
 */
export function documentJson(handle) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.documentJson(handle);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Builds the op batch that places one accepted extend candidate (09 §4.2).
 *
 * The request is JSON (`ExtendPlacementRequest`); the batch is JSON (`OpBatch`). The handle's
 * document is not changed: the caller commits the batch, so placement is undoable (02 §7).
 * @param {number} handle
 * @param {string} request_json
 * @returns {string}
 */
export function extendPlacement(handle, request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.extendPlacement(handle, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Builds the op batch that fills an erased gap with a generated candidate (09 §4.3).
 *
 * The request is JSON (`FillPlacementRequest`); the batch is JSON (`OpBatch`). The handle's
 * document is not changed: the caller commits the batch, so placement is undoable (02 §7).
 * @param {number} handle
 * @param {string} request_json
 * @returns {string}
 */
export function fillPlacement(handle, request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.fillPlacement(handle, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Drops a handle. Returns whether it existed.
 * @param {number} handle
 * @returns {boolean}
 */
export function freeDoc(handle) {
    const ret = wasm.freeDoc(handle);
    return ret !== 0;
}

/**
 * Loads a project document (JSON) and returns its handle.
 *
 * The caller owns the handle and must call [`free_doc`]. The asset index starts empty and is
 * filled with [`asset_add`].
 * @param {string} json
 * @returns {number}
 */
export function loadProject(json) {
    const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.loadProject(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}

/**
 * Resolves a region (JSON) into section- and track-aligned slices, as JSON.
 * @param {number} handle
 * @param {string} region_json
 * @returns {string}
 */
export function resolveRegion(handle, region_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(region_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.resolveRegion(handle, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The tick at which `seconds` has elapsed, using the handle's tempo map.
 * @param {number} handle
 * @param {number} seconds
 * @returns {bigint}
 */
export function secondsToTicks(handle, seconds) {
    const ret = wasm.secondsToTicks(handle, seconds);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * The absolute span of every section, as JSON.
 * @param {number} handle
 * @returns {string}
 */
export function sectionSpans(handle) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.sectionSpans(handle);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * The compact LLM context for the handle's document (`specs/06-ai-planner.md` §2).
 *
 * `focus_json` is a `SummaryFocus` (`{}` or an empty string means the whole song); the result is
 * the line-oriented data block the planner puts in its prompt. A stale focus ID is reported as the
 * same JSON array of `{ opIndex, code, message }` the op API uses.
 * @param {number} handle
 * @param {string} focus_json
 * @returns {string}
 */
export function summarizeForLlm(handle, focus_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(focus_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.summarizeForLlm(handle, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Seconds elapsed at `ticks`, using the handle's tempo map.
 * @param {number} handle
 * @param {bigint} ticks
 * @returns {number}
 */
export function ticksToSeconds(handle, ticks) {
    const ret = wasm.ticksToSeconds(handle, ticks);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Builds the op batch that gives a section a generated transition (09 §4.4).
 *
 * The request is JSON (`TransitionPlacementRequest`); the batch is JSON (`OpBatch`). The handle's
 * document is not changed: the caller commits the batch, so the transition is undoable (02 §7).
 * @param {number} handle
 * @param {string} request_json
 * @returns {string}
 */
export function transitionPlacement(handle, request_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transitionPlacement(handle, ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Validates the handle's document; returns `null` when valid, else a JSON error array.
 * @param {number} handle
 * @returns {string | undefined}
 */
export function validateDoc(handle) {
    const ret = wasm.validateDoc(handle);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    let v1;
    if (ret[0] !== 0) {
        v1 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./bragi_model_wasm_bg.js": import0,
    };
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('bragi_model_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
