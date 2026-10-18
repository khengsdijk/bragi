# bragi-engine

The audio engine: render plan compiler, scheduler, audio graph, transport state machine, meters,
peak pyramids and the offline renderer ([03-audio-engine.md](../../specs/03-audio-engine.md)).

**Platform-free by construction** — no output device, no filesystem, no threads of its own. That is
what lets the same DSP run in an AudioWorklet and natively, and lets the conformance suite null one
against the other at ≤ −90 dBFS ([01 §3](../../specs/01-architecture.md)).

The engine receives **diffs**, not documents: `bragi-model` computes `EngineDelta`
([01 §5](../../specs/01-architecture.md)).

**Status:** scaffold. Built by **WP-1.1** against the timing targets in
[03 §5.2](../../specs/03-audio-engine.md).
