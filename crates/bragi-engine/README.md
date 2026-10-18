# bragi-engine

The audio engine: render plan compiler, scheduler, audio graph, transport state machine, meters,
peak pyramids and the offline renderer ([03-audio-engine.md](../../specs/03-audio-engine.md)).

**Platform-free by construction** — no output device, no filesystem, no threads of its own. That is
what lets the same DSP run in an AudioWorklet and natively, and lets the conformance suite null one
against the other at ≤ −90 dBFS ([01 §3](../../specs/01-architecture.md)).

The engine receives **diffs**, not documents: `bragi-model` computes `EngineDelta`
([01 §5](../../specs/01-architecture.md)).

**Status:** **built by WP-1.1**. Render-plan compiler (`plan.rs`), piecewise-linear source map
(`srcmap.rs`), transport state machine (`transport.rs`), allocation-free mixer with direct and
phase-vocoder paths (`render.rs`), bounded chunk pool (`chunkpool.rs`), peak pyramids (`peaks.rs`),
meters (`meters.rs`), deterministic offline mixdown (`offline.rs`), preview shadow plan
(`preview.rs`), the engine facade (`engine.rs`), symphonia decoding behind the `decode` feature
(`decode.rs`) and the real-time primitives (`rt.rs`: SPSC ring, state block, allocator guard).

Proof lives in `tests/`: `timing.rs` (03 §5.2), `no_alloc.rs` (zero audio-thread allocations),
`stress.rs` (12 tracks, 0 underruns), `render.rs`, `fuzz.rs`. Plan: [`docs/wp/1.1.md`](../../docs/wp/1.1.md).
