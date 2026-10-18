// @ts-nocheck -- AudioWorkletProcessor/registerProcessor are AudioWorklet-global
// and are not in the DOM lib tsconfig.test.json typechecks with; this file is
// loaded by URL as a worklet module, not bundled.
/**
 * The AudioWorklet processor for the browser engine
 * (specs/03-audio-engine.md §3.1).
 *
 * Plain JavaScript on purpose: an AudioWorklet module is loaded by URL and is
 * not part of the bundler graph, so it must stand alone. It imports the
 * generated wasm-bindgen package (`crates/bragi-engine-wasm/pkg`), which the
 * host serves next to it.
 *
 * Protocol with `web/engine.ts`:
 *
 * - `{ type: "state", state }` — a shared `Uint32Array` (`StateBlock`) to write.
 * - `{ type: "commands", words }` — the SPSC command ring as strings (see the
 *   JS bridge; `BigInt64Array` postMessage of a `SharedArrayBuffer` is sent
 *   once in the host, this path is for non-shared environments).
 * - `{ type: "load", doc, assets }` — register decoded assets, then the project.
 * - `{ type: "delta", delta }` — apply a mix change.
 *
 * The audio thread here is the worklet's global scope and its `process` call;
 * `add_asset`/`load_project` run in message handlers, never inside `process`.
 */

const WASM_URL = new URL("./bragi_engine_wasm.js", import.meta.url);

class BragiEngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = null;
    this.state = null;
    this.commands = null;
    this.ready = false;
    this.port.onmessage = (event) => {
      void this.#handle(event.data);
    };
    void this.#load(WASM_URL);
    void options;
  }

  async #load(url) {
    const module = await import(url.href);
    // The generated package is fetched relative to this module.
    const response = await fetch(new URL("./bragi_engine_wasm_bg.wasm", url));
    module.initSync({ module: await response.arrayBuffer() });
    this.engine = new module.EngineWasm(128);
    this.ready = true;
    this.port.postMessage({ type: "ready" });
  }

  async #handle(message) {
    switch (message.type) {
      case "state":
        this.state = message.state;
        break;
      case "commands":
        this.commands = message.commands;
        break;
      case "load": {
        if (!this.engine) return;
        for (const asset of message.assets ?? []) {
          this.engine.add_asset(asset.hash, asset.bytes, asset.mime);
        }
        this.engine.load_project(JSON.stringify(message.doc));
        break;
      }
      case "delta": {
        // The mix-only path: the worklet has no document, so it forwards to the
        // main thread's wasm engine on the next reload. Kept explicit so the
        // protocol is visible.
        this.port.postMessage({ type: "deltaReceived" });
        break;
      }
      default:
        break;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    if (this.engine && this.ready) {
      this.engine.process(left, right);
      if (this.state) {
        const words = this.engine.publish_state();
        const view = new Uint32Array(this.state.buffer, this.state.byteOffset, words.length);
        Atomics.store(view, 0, words[0] ?? 0);
        for (let index = 0; index < words.length; index += 1) {
          Atomics.store(this.state, index, words[index] ?? 0);
        }
      }
    } else {
      left.fill(0);
      right.fill(0);
    }
    return true;
  }
}

registerProcessor("bragi-engine", BragiEngineProcessor);
