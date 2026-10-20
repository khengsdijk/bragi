/**
 * The decoder/offline worker for the browser engine
 * (specs/03-audio-engine.md §3.1, §9).
 *
 * It owns a second instance of the wasm engine for offline work (`Render`
 * stretch quality) and waveform pyramids, and it does the **decoding** for the
 * AudioWorklet: compressed bytes come in, interleaved f32 (`Float32Array`) goes
 * out transferred. The worklet only copies that PCM into its own memory
 * (`add_asset_pcm`), so it never runs symphonia on the audio thread.
 *
 * Messages are the `request`/response shape of `web/engine.ts`'s `request()`:
 * `{ id, type, … }` in, `{ id, ok, result }` out. The initial `wasm` message is
 * answered with `{ type: "ready" }` and has no id.
 *
 * `render` runs the engine's export (WP-1.11): the wasm module encodes WAV/FLAC
 * mixdowns and stems and returns one binary export frame, which `postMessage`
 * transfers back as a `RenderResult`.
 */
import {
  EngineWasm,
  initSync,
} from "../../../../crates/bragi-engine-wasm/pkg/bragi_engine_wasm.js";
import { decodeExportFrame, jobFormat, pyramidLevel } from "../engine/codec.js";
import type { AssetHash, PeakLevel, RenderJob } from "../engine/types.js";
import { decodeAsset } from "./decode.js";
import type { EngineAsset, EngineAssetBytes } from "./engine.js";

type EngineRequest =
  | {
      readonly id: number;
      readonly type: "load";
      readonly doc: unknown;
      readonly assets: readonly EngineAssetBytes[];
    }
  | {
      readonly id: number;
      readonly type: "decode";
      readonly assets: readonly EngineAssetBytes[];
    }
  | {
      readonly id: number;
      readonly type: "render";
      readonly job: RenderJob;
    }
  | {
      readonly id: number;
      readonly type: "peaks";
      readonly asset: AssetHash;
      readonly level: PeakLevel;
    };

interface WasmMessage {
  readonly type: "wasm";
  readonly bytes: Uint8Array;
}

interface WasmEngine {
  add_asset(hash: string, bytes: Uint8Array, mime: string): void;
  load_project(json: string): void;
  render(start: bigint, frames: bigint, block: number): Float32Array;
  export_frame(jobJson: string): Uint8Array;
  peaks(hash: string): Uint8Array;
  length_samples(): bigint;
}

let engine: WasmEngine | null = null;

function instance(): WasmEngine {
  if (engine === null) throw new Error("the engine worker was not initialised");
  return engine;
}

async function handle(request: EngineRequest): Promise<unknown> {
  switch (request.type) {
    case "decode":
      // No engine handle needed: decoding is Symphonia only.
      return request.assets.map(decodeAsset);
    case "load": {
      const wasm = instance();
      for (const asset of request.assets) {
        wasm.add_asset(asset.hash, asset.bytes, asset.mime);
      }
      wasm.load_project(JSON.stringify(request.doc));
      return Number(wasm.length_samples());
    }
    case "render": {
      // The wasm engine encodes WAV/FLAC with the same code as the desktop and
      // returns one export frame.
      const frame = instance().export_frame(JSON.stringify(request.job));
      const decoded = decodeExportFrame(frame, jobFormat(request.job));
      // Give each file its own buffer so `postMessage` can transfer them
      // instead of structured-cloning the whole frame once per view.
      return {
        ...decoded,
        files: decoded.files.map((file) => ({ ...file, bytes: file.bytes.slice() })),
      };
    }
    case "peaks":
      return pyramidLevel(instance().peaks(request.asset), request.level);
    default:
      return null;
  }
}

/** `self` as a dedicated worker, whichever lib the build type-checks against. */
const workerScope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

self.addEventListener("message", (event: MessageEvent<EngineRequest | WasmMessage>) => {
  const message = event.data;
  if (message.type === "wasm") {
    try {
      initSync({ module: message.bytes });
      engine = new EngineWasm(512);
      workerScope.postMessage({ type: "ready" });
    } catch (error: unknown) {
      workerScope.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  const request = message;
  void handle(request)
    .then((result) =>
      workerScope.postMessage({ id: request.id, ok: true, result }, transferables(result)),
    )
    .catch((error: unknown) =>
      self.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
});

/** Buffers a result can hand over without copying: decoded PCM or export files. */
function transferables(result: unknown): Transferable[] {
  if (Array.isArray(result)) {
    return result.flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null || !("samples" in item)) return [];
      const samples = (item as EngineAsset).samples;
      const buffer = samples.buffer;
      return buffer instanceof ArrayBuffer ? [buffer] : [];
    });
  }
  if (typeof result !== "object" || result === null || !("files" in result)) return [];
  const files = (result as { files: { bytes: Uint8Array }[] }).files;
  return files.map((file) => file.bytes.buffer);
}
