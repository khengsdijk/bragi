/**
 * Compressed bytes -> PCM, for the decoder worker (`specs/03-audio-engine.md` §3.1).
 *
 * This module is deliberately separate from `engine.worker.ts` so it can be tested in Node
 * against the real `bragi-engine` wasm. The worker initialises it with the same
 * `bragi_engine_wasm_bg.wasm` bytes it receives over its port.
 */
import {
  decode_asset as decodeAssetWasm,
  initSync,
} from "../../../../crates/bragi-engine-wasm/pkg/bragi_engine_wasm.js";
import type { EngineAsset, EngineAssetBytes } from "./engine.js";

export { initSync };

/**
 * Decodes one asset to interleaved f32 at 48 kHz.
 *
 * The result's `samples` is a standalone `Float32Array` owned by the caller, so the worker can
 * transfer it to the main thread without copying.
 */
export function decodeAsset(asset: EngineAssetBytes): EngineAsset {
  const pcm = decodeAssetWasm(asset.bytes, asset.mime);
  const channels = pcm.channels();
  const sampleRate = pcm.sample_rate();
  return { hash: asset.hash, samples: pcm.into_samples(), channels, sampleRate };
}
