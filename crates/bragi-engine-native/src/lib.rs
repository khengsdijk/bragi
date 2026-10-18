//! Desktop glue for `bragi_engine`: the mmap PCM cache, cpal audio output and
//! the conformance render binary.
//!
//! Native-only — this crate is **not** expected to compile for
//! `wasm32-unknown-unknown` (`specs/13-agent-guide.md` §3).
//!
//! Why native audio on desktop rather than WASM in the webview: lower and more
//! stable latency, no background-tab throttling, no WebKitGTK AudioWorklet
//! quirks on Linux, multithreaded rendering, and memory-mapped access to large
//! files (`specs/01-architecture.md` §3).
//!
//! | Module | Contents |
//! |---|---|
//! | [`pcm_cache`] | `<appCache>/pcm/<hash>.f32`, raw interleaved f32 at 48 kHz, memory-mapped |
//! | [`output`] | cpal output, an SPSC command ring, 60 Hz state publication |
//! | [`wav`] | the float WAV reader/writer the conformance harness uses |
//!
//! Decoding lives in `bragi_engine::decode` behind the `decode` feature, so web
//! and desktop share one decoder.

pub mod output;
pub mod pcm_cache;
pub mod service;
pub mod wav;

pub use output::{NativePlayer, OutputError};
pub use pcm_cache::{MmapPcmCache, PcmCache};
pub use service::{EngineService, ServiceError};
pub use wav::{WavData, read_wav, write_f32_wav};

/// Builds an [`AssetMeta`](bragi_model::generated::AssetMeta) for a decoded
/// asset, which is what the planner and the cache need.
///
/// # Errors
/// When the hash does not parse or the channel/frame counts are zero.
pub fn asset_meta(
    hash: &str,
    mime: &str,
    bytes: u64,
    channels: u16,
    sample_rate: u32,
    frames: u64,
) -> Result<bragi_model::generated::AssetMeta, bragi_model::generated::error::ConversionError> {
    use std::num::NonZeroU64;
    Ok(bragi_model::generated::AssetMeta {
        bytes,
        channels: NonZeroU64::new(u64::from(channels.max(1))).unwrap_or(NonZeroU64::MIN),
        derived_from: None,
        duration_samples: frames,
        hash: hash.parse()?,
        mime: mime.parse()?,
        sample_rate: NonZeroU64::new(u64::from(sample_rate.max(1))).unwrap_or(NonZeroU64::MIN),
    })
}
