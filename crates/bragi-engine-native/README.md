# bragi-engine-native

Desktop glue for [`bragi-engine`](../bragi-engine): cpal output (CoreAudio / WASAPI /
ALSA-PulseAudio-PipeWire), memory-mapped PCM reading and the render thread pool.

Native-only: this crate is **not** expected to compile for `wasm32-unknown-unknown`
([13 §3](../../specs/13-agent-guide.md)), which is why `pnpm build:wasm` names the other four
crates explicitly.

**Status:** **built by WP-1.1.** `pcm_cache.rs` (raw f32 under `<appCache>/pcm/<hash>.f32`,
memory-mapped), `output.rs` (cpal with a lock-free command ring and 60 Hz state publication),
`wav.rs` (the float WAV the conformance harness writes), `service.rs` (the desktop engine host
behind the Tauri commands in `apps/desktop/src-tauri/src/engine.rs`) and `bin/render.rs`
(`bragi-render`, used by `pnpm test:conformance`). Decoding is `bragi_engine::decode` behind the
`decode` feature, so web and desktop share one decoder.
