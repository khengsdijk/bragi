/**
 * The decoder/offline worker for the browser engine
 * (specs/03-audio-engine.md §3.1, §9).
 *
 * It owns a second instance of the wasm engine for offline work (`Render`
 * stretch quality) and waveform pyramids, so a mixdown never blocks the
 * AudioWorklet. Messages are the `request`/response shape of
 * `web/engine.ts`'s `request()`: `{ id, type, … }` in, `{ id, ok, result }` out.
 *
 * The bytes `render` returns are raw interleaved f32; encoding to WAV/FLAC/MP3
 * is the export work package (WP-1.11), and the `format` field records what was
 * asked for.
 */
import { float32ToBytes, pyramidLevel } from "../engine/codec.js";
import type { AssetHash, AudioFormat, PeakLevel, RenderResult } from "../engine/types.js";

type EngineRequest =
  | {
      readonly id: number;
      readonly type: "load";
      readonly doc: unknown;
      readonly assets: readonly EngineAssetMessage[];
    }
  | {
      readonly id: number;
      readonly type: "render";
      readonly start: number;
      readonly frames: number;
      readonly format: AudioFormat;
    }
  | {
      readonly id: number;
      readonly type: "peaks";
      readonly asset: AssetHash;
      readonly level: PeakLevel;
    };

interface EngineAssetMessage {
  readonly hash: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
}

interface WasmEngine {
  add_asset(hash: string, bytes: Uint8Array, mime: string): void;
  load_project(json: string): void;
  render(start: bigint, frames: bigint, block: number): Float32Array;
  peaks(hash: string): Uint8Array;
  length_samples(): bigint;
}

interface WasmModule {
  readonly EngineWasm: new (block: number) => WasmEngine;
  initSync(options: { module: ArrayBuffer }): void;
}

let modulePromise: Promise<WasmModule> | null = null;
let engine: WasmEngine | null = null;

async function wasm(): Promise<WasmModule> {
  modulePromise ??= (async () => {
    // Served next to the worklet and this worker (see scripts/build-engine-wasm.mjs).
    const url = new URL("./bragi_engine_wasm.js", import.meta.url);
    const module = (await import(/* @vite-ignore */ url.href)) as WasmModule;
    const response = await fetch(new URL("bragi_engine_wasm_bg.wasm", url));
    module.initSync({ module: await response.arrayBuffer() });
    return module;
  })();
  return modulePromise;
}

async function ensureEngine(): Promise<WasmEngine> {
  if (!engine) engine = new (await wasm()).EngineWasm(512);
  return engine;
}

async function handle(request: EngineRequest): Promise<unknown> {
  const instance = await ensureEngine();
  switch (request.type) {
    case "load": {
      for (const asset of request.assets) {
        instance.add_asset(asset.hash, asset.bytes, asset.mime);
      }
      instance.load_project(JSON.stringify(request.doc));
      return Number(instance.length_samples());
    }
    case "render": {
      const samples = instance.render(BigInt(request.start), BigInt(request.frames), 512);
      const result: RenderResult = {
        channels: 2,
        sampleRate: 48000,
        format: request.format,
        bytes: float32ToBytes(samples),
        frames: samples.length / 2,
      };
      return result;
    }
    case "peaks":
      return pyramidLevel(instance.peaks(request.asset), request.level);
    default:
      return null;
  }
}

self.addEventListener("message", (event: MessageEvent<EngineRequest>) => {
  const request = event.data;
  void handle(request)
    .then((result) => self.postMessage({ id: request.id, ok: true, result }))
    .catch((error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
});
