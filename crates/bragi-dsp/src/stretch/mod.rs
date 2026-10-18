//! Time-stretch and pitch-shift ([03 §7](../../../specs/03-audio-engine.md)).
//!
//! The engine drives a [`Stretcher`] with a **pull model**: it asks
//! [`Stretcher::input_required`] how many input frames the next
//! [`Stretcher::process`] call consumes, so 128-frame AudioWorklet quanta, 256-frame cpal
//! buffers and the offline renderer all feed the same instance and get the same output.
//!
//! Rules that the implementations here keep and that the contract tests pin down
//! (`crates/bragi-dsp/tests/stretch_contract.rs`):
//!
//! - **Channels go together.** `process` takes every channel at once. Phase propagation and
//!   transient detection are shared across channels, so the stereo image does not drift.
//! - **Allocation is constructor-only.** `new` allocates; `configure`, `process`,
//!   `input_required`, `latency`, `look_ahead` and `reset` never allocate. The `no_alloc`
//!   integration test proves this with a counting global allocator.
//! - **Ratio 1.0, 0 semitones is a bit-exact pass-through** with zero latency, for any block
//!   partition.
//! - **Partition independence.** The output and the amount of input consumed depend only on
//!   the ratio/pitch history, never on how the caller slices its blocks.
//!
//! The chosen implementation is [`PhaseVocoder`], a pure-Rust phase vocoder with identity
//! phase locking and transient phase reset. See
//! [ADR-0002](../../../specs/decisions/ADR-0002-time-stretch.md) for why.
//!
//! # Example
//!
//! ```
//! use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
//!
//! let mut st = PhaseVocoder::new(1, 48_000).unwrap();
//! st.configure(1.12, 0.0, Quality::Preview).unwrap();
//! let mut out = vec![0.0f32; 256];
//! let need = st.input_required(out.len());
//! let input = vec![0.0f32; need];
//! let mut outs: [&mut [f32]; 1] = [&mut out];
//! st.process(&[input.as_slice()], &mut outs);
//! ```

mod vocoder;

pub use vocoder::PhaseVocoder;

use thiserror::Error;

/// Quality tier ([03 §7](../../../specs/03-audio-engine.md)).
///
/// `Preview` is for real-time playback (small FFT, low CPU and latency); `Render` is for
/// offline renders (large FFT, higher latency, better pitch resolution). Both trade a fixed
/// algorithmic latency for quality; the latency depends only on the tier, never on the ratio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Quality {
    /// Real-time, low CPU ([03 §7](../../../specs/03-audio-engine.md)).
    Preview,
    /// Offline renders and render caches ([03 §7](../../../specs/03-audio-engine.md)).
    Render,
}

impl Quality {
    /// The FFT size used by this tier. The algorithmic latency of the vocoder is this many
    /// output frames.
    #[must_use]
    pub const fn fft_size(self) -> usize {
        match self {
            Quality::Preview => 1024,
            Quality::Render => 2048,
        }
    }

    /// The synthesis hop, a quarter of the FFT size (75 % overlap). The transient smearing of
    /// the vocoder — the thing the listening check calls "flamming" — grows with `fft_size ·
    /// |ratio − 1|`, so the window is kept small on purpose ([ADR-0002]).
    ///
    /// [ADR-0002]: ../../../specs/decisions/ADR-0002-time-stretch.md
    #[must_use]
    pub const fn hop(self) -> usize {
        self.fft_size() / 4
    }
}

/// Errors from configuring a [`Stretcher`].
///
/// `configure` validates before it mutates anything, so a rejected call leaves the previous
/// setting in place.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum StretchError {
    /// The ratio was outside [`MIN_RATIO`]..=[`MAX_RATIO`], or was not finite.
    #[error("stretch ratio {0} out of range [{MIN_RATIO}, {MAX_RATIO}]")]
    RatioOutOfRange(f64),
    /// The pitch shift was outside [`MIN_SEMITONES`]..=[`MAX_SEMITONES`], or was not finite.
    #[error("pitch shift {0} semitones out of range [{MIN_SEMITONES}, {MAX_SEMITONES}]")]
    SemitonesOutOfRange(f32),
    /// The constructor got zero channels or more than [`MAX_CHANNELS`].
    #[error("channel count {0} out of range [1, {MAX_CHANNELS}]")]
    ChannelCount(usize),
    /// The constructor got a sample rate outside [`MIN_SAMPLE_RATE`]..=[`MAX_SAMPLE_RATE`].
    #[error("sample rate {0} out of range [{MIN_SAMPLE_RATE}, {MAX_SAMPLE_RATE}]")]
    SampleRate(u32),
}

/// Smallest accepted time ratio (output duration / input duration).
pub const MIN_RATIO: f64 = 0.25;
/// Largest accepted time ratio.
pub const MAX_RATIO: f64 = 4.0;
/// Smallest accepted pitch shift, in semitones.
pub const MIN_SEMITONES: f32 = -24.0;
/// Largest accepted pitch shift, in semitones.
pub const MAX_SEMITONES: f32 = 24.0;
/// Largest accepted channel count. Bragi's assets are mono or stereo; the ceiling is generous.
pub const MAX_CHANNELS: usize = 8;
/// Smallest accepted sample rate, in Hz.
pub const MIN_SAMPLE_RATE: u32 = 8_000;
/// Largest accepted sample rate, in Hz.
pub const MAX_SAMPLE_RATE: u32 = 384_000;

/// A time-stretch / pitch-shift processor ([03 §7](../../../specs/03-audio-engine.md)).
///
/// **Ratio direction:** `ratio` is *time ratio = output duration / input duration*. `ratio > 1`
/// makes the audio longer (slower); `ratio < 1` makes it shorter. `semitones` shifts pitch
/// without changing duration. The two are independent: `ratio` stretches time, `semitones`
/// resamples the spectrum.
///
/// **Pull model:** `process` consumes exactly `input_required(out_frames)` input frames per
/// channel and writes exactly `out_frames` output frames per channel. Feeding silence past the
/// end of the source is the caller's job.
///
/// **Audio-thread safety:** only the constructor allocates. Every other method is allocation-
/// free and panic-free on mismatched buffer shapes (it treats missing channels as silence).
pub trait Stretcher: Send {
    /// Sets the time ratio and pitch shift, and restarts the stream.
    ///
    /// `ratio` is output/input duration ([`MIN_RATIO`]..=[`MAX_RATIO`]); `semitones` is
    /// [`MIN_SEMITONES`]..=[`MAX_SEMITONES`]. `quality` picks the tier. On error the previous
    /// configuration is kept. Allocation-free.
    ///
    /// # Errors
    /// [`StretchError::RatioOutOfRange`] or [`StretchError::SemitonesOutOfRange`].
    fn configure(
        &mut self,
        ratio: f64,
        semitones: f32,
        quality: Quality,
    ) -> Result<(), StretchError>;

    /// How many input frames the next `process(out_frames)` call consumes. Depends only on the
    /// ratio/pitch history and the requested output length, never on earlier block sizes.
    fn input_required(&self, out_frames: usize) -> usize;

    /// Transforms `input` (one slice per channel) into `out` (one mutable slice per channel).
    ///
    /// The first `input_required(out[0].len())` frames of each input channel are consumed. If
    /// fewer channels or frames are supplied than configured, the missing samples are silence,
    /// and extra samples are ignored — never a panic. Allocation-free.
    fn process(&mut self, input: &[&[f32]], out: &mut [&mut [f32]]);

    /// Algorithmic latency in output frames: a click at input frame `t` appears at output frame
    /// `latency() + ratio·t`. Zero for the bit-exact pass-through case.
    fn latency(&self) -> usize;

    /// Upper bound on the number of input frames the vocoder reads ahead of the output it has
    /// produced. Callers that prefetch can use it to know how much audio to keep available.
    fn look_ahead(&self) -> usize;

    /// Forgets all stream state, returning to the state of a freshly configured instance.
    /// Allocation-free.
    fn reset(&mut self);

    /// The current time ratio.
    fn ratio(&self) -> f64;
}
