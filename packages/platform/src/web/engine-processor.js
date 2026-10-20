// @ts-nocheck -- AudioWorkletProcessor/registerProcessor are AudioWorklet-global
// and are not in the DOM lib tsconfig.test.json typechecks with; this file is
// loaded by URL as a worklet module (bundled by the host app's bundler).
/**
 * The AudioWorklet processor for the browser engine
 * (specs/03-audio-engine.md §3.1).
 *
 * `AudioWorkletGlobalScope` has no `fetch`, no dynamic `import()` and no `TextDecoder`, so this
 * module is a *static* graph: the polyfill first, then the generated wasm-bindgen package, which
 * the host bundler inlines. The wasm bytes arrive over the port (the main thread fetches them) and
 * are instantiated synchronously.
 *
 * Protocol with `web/engine.ts` (all messages are structured-cloneable):
 *
 * - `{ type: "wasm", bytes }`   instantiate the engine; answered with `{ type: "ready" }`.
 * - `{ type: "state", state }`  a *shared* `Uint32Array` (`StateBlock`) the worklet writes.
 * - `{ type: "commands", words }` packed transport words (see `engine/codec.ts`), as strings.
 * - `{ type: "load", doc, assets }` register decoded PCM, then compile the project; answered
 *   with `{ type: "loaded", tracks }` so the host can size the state block. Each asset is
 *   `{ hash, samples, channels, sampleRate }`; the decoder worker produced it off this thread.
 *
 * `add_asset_pcm`/`load_project` run in message handlers, never inside `process`. Decoding used
 * to happen here (a v1 shortcut, docs/wp/1.9.md); it now happens in `engine.worker.ts`, so the
 * audio thread only copies PCM into wasm memory. The host sends each hash once.
 */
import "./worklet-polyfill.js";
import {
  EngineWasm,
  initSync,
} from "../../../../crates/bragi-engine-wasm/pkg/bragi_engine_wasm.js";

const OP_PLAY = 0;
const OP_PAUSE = 1;
const OP_STOP = 2;
const OP_SEEK = 3;
const OP_LOOP = 4;
const OP_LOOP_CLEAR = 5;
const OP_AUDITION = 6;
const OP_LOOP_END = 7;
const PAYLOAD_MASK = 0x00ff_ffff_ffff_ffffn;
const HEADER_WORDS = 8;
/** Publish the state block every n-th quantum: ~2.7 ms each, so ~21 ms between publishes. */
const PUBLISH_EVERY = 8;

class BragiEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.state = null;
    this.loopStart = 0;
    this.quantum = 0;
    this.port.onmessage = (event) => this.handle(event.data);
  }

  handle(message) {
    switch (message.type) {
      case "wasm":
        initSync({ module: message.bytes });
        this.engine = new EngineWasm(128);
        this.port.postMessage({ type: "ready" });
        break;
      case "state":
        this.state = message.state;
        break;
      case "commands":
        for (const word of message.words) this.command(BigInt(word));
        break;
      case "load":
        this.load(message);
        break;
      default:
        break;
    }
  }

  load(message) {
    if (!this.engine) return;
    try {
      for (const asset of message.assets ?? []) {
        this.engine.add_asset_pcm(asset.hash, asset.samples, asset.channels, asset.sampleRate);
      }
      this.engine.load_project(JSON.stringify(message.doc));
      const words = this.engine.publish_state().length;
      this.port.postMessage({
        type: "loaded",
        tracks: Math.max(0, (words - HEADER_WORDS - 2) / 2),
        lengthSamples: Number(this.engine.length_samples()),
      });
    } catch (error) {
      this.port.postMessage({ type: "error", message: String(error?.message ?? error) });
    }
  }

  command(word) {
    if (!this.engine) return;
    const opcode = Number(word >> 56n);
    const payload = Number(word & PAYLOAD_MASK);
    switch (opcode) {
      case OP_PLAY:
        this.engine.transport(0, 0, 0);
        break;
      case OP_PAUSE:
        this.engine.transport(1, 0, 0);
        break;
      case OP_STOP:
        this.engine.transport(2, 0, 0);
        break;
      case OP_SEEK:
        this.engine.transport(3, payload, 0);
        break;
      case OP_LOOP:
        this.loopStart = payload;
        break;
      case OP_LOOP_END:
        this.engine.transport(4, this.loopStart, payload);
        break;
      case OP_LOOP_CLEAR:
        this.engine.transport(5, 0, 0);
        break;
      case OP_AUDITION:
        this.engine.transport(6, payload, 0);
        break;
      default:
        break;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    if (!this.engine) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }
    this.engine.process(left, right);
    this.quantum += 1;
    if (this.state && this.quantum % PUBLISH_EVERY === 0) {
      const words = this.engine.publish_state();
      const count = Math.min(words.length, this.state.length);
      for (let index = 0; index < count; index += 1) Atomics.store(this.state, index, words[index]);
    }
    return true;
  }
}

registerProcessor("bragi-engine", BragiEngineProcessor);
