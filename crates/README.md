# crates/

The Cargo workspace: the song model and the audio engine, written once in Rust and run as WASM in
the browser and natively on desktop ([ADR-0001](../specs/decisions/ADR-0001-tech-stack.md)).

| Crate | What it is | Filled by |
|---|---|---|
| [`bragi-model/`](bragi-model) | Song model types, op application, validation, diff, time mapping | WP-0.3 |
| [`bragi-dsp/`](bragi-dsp) | DSP primitives: stretch, pitch, filters, dynamics, reverb, loudness, crossfades | WP-0.4, WP-2.3 |
| [`bragi-engine/`](bragi-engine) | Audio graph, scheduler, renderer, playback state machine (platform-free) | WP-1.1 |
| [`bragi-engine-wasm/`](bragi-engine-wasm) | `wasm-bindgen` + AudioWorklet glue | WP-1.1 |
| [`bragi-engine-native/`](bragi-engine-native) | cpal output, mmap file reading, thread pool | WP-1.1 |

House rules ([13 §1, §3](../specs/13-agent-guide.md)):

- **The audio thread is sacred.** No allocation, locks, I/O, logging or panics in `process()`.
- Library crates compile for `wasm32-unknown-unknown` unless they are explicitly `*-native`.
- `thiserror` in libraries, no `unwrap()` outside tests, `clippy -D warnings`, `rustfmt`.
- Public functions in `bragi-model` and `bragi-engine` carry doc comments with an example.
