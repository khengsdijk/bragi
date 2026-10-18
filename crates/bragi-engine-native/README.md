# bragi-engine-native

Desktop glue for [`bragi-engine`](../bragi-engine): cpal output (CoreAudio / WASAPI /
ALSA-PulseAudio-PipeWire), memory-mapped PCM reading and the render thread pool.

Native-only: this crate is **not** expected to compile for `wasm32-unknown-unknown`
([13 §3](../../specs/13-agent-guide.md)), which is why `pnpm build:wasm` names the other four
crates explicitly.

**Status:** scaffold. Built by **WP-1.1**.
