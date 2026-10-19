//! The Bragi audio engine: render plan compiler, scheduler, audio graph,
//! transport state machine and offline renderer.
//!
//! Platform-free by construction — no output device, no filesystem, no threads
//! of its own. The two thin glue crates `bragi-engine-wasm` and
//! `bragi-engine-native` provide those, so that the same DSP runs in an
//! AudioWorklet and natively on desktop and a conformance test can null one
//! against the other (`specs/01-architecture.md` §3,
//! `specs/03-audio-engine.md`).
//!
//! The crate must compile for `wasm32-unknown-unknown`.
//!
//! # Layout
//!
//! - [`plan`] — the immutable [`RenderPlan`] and its compiler. Compilation is
//!   off the audio thread; the audio thread only reads the plan.
//! - [`transport`] — the state machine and the per-block schedule (play, pause,
//!   seek, loop with a 5 ms crossfade, scrub, audition).
//! - [`render`] — the mixer. [`Renderer::process`] is allocation-free.
//! - [`pcm`] — the [`PcmSource`] trait every host implements (memory, chunk
//!   pool, mmap).
//! - [`chunkpool`] — the browser's bounded 2-second chunk pool.
//! - [`peaks`] — waveform min/max pyramids.
//! - [`meters`] — per-track peak/RMS and the fixed-word state snapshot.
//! - [`offline`] — deterministic mixdown.
//! - [`rt`] — lock-free glue for the hosts (SPSC ring, state block, the
//!   allocator guard).
//! - [`preview`] — transient drag state applied to a shadow plan.
//!
//! # Example
//!
//! A one-second, one-track render of a generated sine:
//!
//! ```
//! use bragi_engine::pcm::{MemoryPcm, PcmBuffer, PcmSource};
//! use bragi_engine::plan::{compile, RenderPlan};
//! use bragi_engine::offline::{render, OfflineOptions};
//! use bragi_model::AssetIndex;
//! # let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
//! #   "schemaVersion": 1, "id": "prj_01",
//! #   "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
//! #   "sources": [], "analyses": {},
//! #   "tracks": [{ "id": "trk_01", "name": "Tone", "role": "full_mix", "color": "#8A8F98",
//! #                "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
//! #   "arrangement": { "timebase": { "ppq": 960,
//! #       "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
//! #       "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
//! #       "sections": [{ "id": "sec_01", "kind": "intro", "label": "A", "lengthTicks": 3840,
//! #         "lanes": { "trk_01": { "clips": [{ "id": "clp_01",
//! #             "asset": format!("sha256:{}", "0".repeat(64)),
//! #             "srcStart": 0, "srcEnd": 48000, "start": 0, "warp": { "mode": "none" },
//! #             "gainDb": 0, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
//! #             "fadeCurve": "equal_power",
//! #             "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" } }],
//! #             "automation": [] } }, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
//! #       "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
//! # let hash = bragi_model::generated::AssetHash::try_from(format!("sha256:{}", "0".repeat(64))).unwrap();
//! # let meta: bragi_model::generated::AssetMeta = serde_json::from_value(serde_json::json!({
//! #   "hash": hash, "mime": "audio/wav", "bytes": 1, "sampleRate": 48000,
//! #   "channels": 2, "durationSamples": 48000 })).unwrap();
//! # let assets = AssetIndex::from_metas([meta]);
//! let plan: RenderPlan = compile(&doc, &assets, 48_000, 1).unwrap();
//! let mut pcm = MemoryPcm::new();
//! pcm.insert(hash, PcmBuffer::silent(48_000, 2, 48_000));
//! let out = render(&plan, &pcm, &OfflineOptions::default());
//! assert_eq!(out.frames, 96_000);
//! assert_eq!(out.channels, 2);
//! ```

#![warn(missing_docs)]

pub mod chunkpool;
#[cfg(feature = "decode")]
pub mod decode;
pub mod engine;
pub mod error;
pub mod export;
pub mod fade;
pub mod meters;
pub mod offline;
pub mod pcm;
pub mod peaks;
pub mod plan;
pub mod preview;
pub mod render;
pub mod rt;
pub mod srcmap;
pub mod transport;

pub use engine::{Engine, EngineEvent};
pub use error::{EngineError, PlanError};
pub use plan::{RenderPlan, Segment, TrackPlan, compile};
pub use render::{RenderStats, Renderer};
pub use transport::{Transport, TransportState};

/// The engine crate's version, for diagnostics and cache invalidation.
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The project's internal sample rate (`specs/02-song-model.md` §2.2).
pub const SAMPLE_RATE: u32 = 48_000;

/// The browser AudioWorklet render quantum (`specs/03-audio-engine.md` §3.1).
pub const QUANTUM_FRAMES: usize = 128;

/// The desktop cpal buffer default (`specs/03-audio-engine.md` §3.2).
pub const NATIVE_BUFFER_FRAMES: usize = 256;

/// Length of the crossfade at a loop point, in milliseconds (`specs/03-audio-engine.md` §5.2).
pub const LOOP_FADE_MS: f32 = 5.0;

/// Ramp length for mute/solo changes, in milliseconds (`specs/03-audio-engine.md` §5.2).
pub const MUTE_RAMP_MS: f32 = 5.0;

/// Ramp length for gain/pan/fx parameter changes, in milliseconds
/// (`specs/03-audio-engine.md` §4: "smoothed over 10 ms").
pub const PARAM_RAMP_MS: f32 = 10.0;

/// Time ratio tolerance inside which a segment stays on the bit-exact direct path.
pub const RATIO_EPSILON: f64 = 1e-6;
