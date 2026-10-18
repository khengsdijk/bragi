# ADR-0001 — Tech stack: Tauri 2 + TypeScript/React + Rust core (WASM/native) + Python model services

- **Status:** Accepted
- **Date:** 2026-10-18
- **Decider:** Koen

## Context

Bragi must run as a desktop app (macOS, Windows, Linux) **and** in the browser. It needs:
- a GPU-heavy, 60 fps visual UI (zoomable canvases, 100k-point maps)
- real-time audio playback with low latency, plus deterministic offline rendering
- heavy ML inference (stem separation, analysis, generation), which realistically lives in Python on GPUs
- one codebase, maintained by one person plus coding agents

## Options considered

| # | Stack | Summary verdict |
|---|---|---|
| 1 | **Tauri 2 + TS/React + Rust (WASM in browser, native on desktop) + Python GPU services** | **Chosen** |
| 2 | Electron + TS/React + WASM DSP + Python | Most predictable rendering, but heavy and with weaker native audio |
| 3 | Web-first PWA (SvelteKit) with a wrapper later | Fastest start, but desktop becomes second-class |
| 4 | JUCE 8 (C++) + WebView UI + Emscripten web build | Best pro audio, but the web build is fragile and C++ is costly |
| 5 | .NET Avalonia / Blazor Hybrid | Plays to existing skills, but has a weak audio and GPU ecosystem |

## Decision

Option 1. The UI is one React/TypeScript app. The song-model logic and the audio engine are written **once in Rust**. The model runs as WASM in every UI, and the engine runs as WASM in an AudioWorklet in browsers and natively inside the Tauri process on desktop. ML runs in Python workers behind an event bus.

## Consequences

**Positive**
- A single implementation of the song model and DSP gives behavioural parity between web and desktop.
- Small desktop binaries, native audio and native filesystem access on desktop.
- Agents can work on clearly separated layers (TS UI, Rust core, Python ML) with JSON Schema contracts between them.

**Negative / mitigations**
- *Webview divergence (especially WebGPU on Linux WebKitGTK):* every renderer must support WebGL2 fallback, and the CI e2e matrix covers all three OSes.
- *Rust learning curve:* the Rust surface is kept focused (model + DSP + engine), with heavy use of snapshot tests.
- *WASM vs native build parity:* the engine crate is platform-free, and the platform glue lives in two thin crates. A conformance test renders the same fixture project on both targets and compares output (null test, ≤ −90 dBFS residual).
- *Cross-origin isolation required in the browser* (SharedArrayBuffer): COOP/COEP headers are set and the CDN config is tested in CI.

## Related decisions (to be written when reached)
- ADR-0002: Time-stretch/pitch-shift library (spike in WP-0.4)
- ADR-0003: Event bus (NATS JetStream vs Kafka), currently NATS
- ADR-0004: Generation model selection per capability
- ADR-0005: GPU hosting provider
