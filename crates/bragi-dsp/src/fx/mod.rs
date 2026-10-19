//! The FX catalogue ([03 §6](../../../specs/03-audio-engine.md)).
//!
//! Every [`FxKind`] in `crates/bragi-dsp/fx_catalog.json` has one [`Effect`] implementation here.
//! The engine owns a chain of boxed effects per track and one for the master, builds them off
//! the audio thread with [`create`], and drives them from the audio thread with
//! [`Effect::set_param`] and [`Effect::process`].
//!
//! Rules every effect keeps (the shared tests in `crates/bragi-dsp/tests/fx_*.rs` pin them down):
//!
//! - **Allocation is constructor-only.** [`create`] allocates (delay lines, oversampling
//!   buffers, the reverb's FDN); `set_param`, `process` and `reset` never do. The `fx_no_alloc`
//!   test proves it for every kind [`create`] can build.
//! - **Stereo in place.** `process` takes the left and right channels as two equal-length
//!   mutable slices and overwrites them. A mono track is fed the same signal on both sides.
//! - **No zipper noise.** `set_param` only sets a *target*. Every continuous parameter glides to
//!   it with a [`Smoothed`] value (or, for filter coefficients, a coefficient update at most
//!   every [`COEFF_UPDATE_FRAMES`] frames from smoothed inputs), so a step never clicks.
//! - **Values are clamped** to the catalogue range in `set_param`, and NaN is ignored. The model's
//!   validator (02 §4.3, invariant 5) already rejects out-of-range documents; the clamp is the
//!   audio thread's own guard.
//! - **No panics** on short or mismatched slices: an effect processes `min(left.len(),
//!   right.len())` frames.
//!
//! Parameters are addressed by **index** into [`FxKind::params`], which lists them in the
//! catalogue's order; the engine resolves names to indices when it compiles a plan, so the audio
//! thread never compares strings. `match_eq`'s `bands` array is flattened to 31 indexed params
//! (`band0` … `band30`) followed by `amount`. `sidechain_duck`'s `sourceTrack` is routing, not a
//! number: the engine feeds the source track's signal through [`FxContext::sidechain`].
//!
//! # Example
//!
//! ```
//! use bragi_dsp::fx::{create, FxContext, FxKind};
//!
//! let mut gain = create(FxKind::Gain, 48_000, 128).unwrap();
//! let db = FxKind::Gain.param_index("db").unwrap();
//! gain.set_param(db, -6.0);
//! let (mut left, mut right) = (vec![0.5f32; 128], vec![0.5f32; 128]);
//! gain.process(&mut left, &mut right, &FxContext::default());
//! assert!(left[127] < 0.5);
//! ```

mod biquad;
mod delay;
mod gain;
mod reverb;
mod sidechain_duck;
mod smooth;

pub use biquad::{Biquad, BiquadCoeffs, StereoBiquad};
pub use delay::Delay;
pub use gain::Gain;
pub use reverb::Reverb;
pub use sidechain_duck::SidechainDuck;
pub use smooth::{DEFAULT_SMOOTHING_MS, Smoothed};

use thiserror::Error;

/// How often an effect may recompute filter coefficients from smoothed parameters, in frames.
/// 16 frames at 48 kHz is 0.33 ms: fine enough that a sweep is not audibly stepped, coarse
/// enough that `cos`/`sin` per coefficient update stays cheap.
pub const COEFF_UPDATE_FRAMES: usize = 16;

/// The largest number of indexed parameters any effect has (`match_eq`: 31 bands + `amount`).
pub const MAX_PARAMS: usize = 32;

/// Number of `match_eq` bands (03 §8.2).
pub const MATCH_EQ_BANDS: usize = 31;

/// One numeric parameter of an effect, as the catalogue declares it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParamSpec {
    /// The catalogue name (`cutoffHz`). `match_eq` bands are `band0` … `band30`.
    pub name: &'static str,
    /// Inclusive lower bound.
    pub min: f32,
    /// Inclusive upper bound.
    pub max: f32,
    /// The value a fresh instance starts at.
    pub default: f32,
}

impl ParamSpec {
    const fn new(name: &'static str, min: f32, max: f32, default: f32) -> Self {
        Self {
            name,
            min,
            max,
            default,
        }
    }

    /// `value` clamped to `min..=max`, or `None` for NaN.
    #[must_use]
    pub fn clamp(&self, value: f32) -> Option<f32> {
        if value.is_nan() {
            None
        } else {
            Some(value.clamp(self.min, self.max))
        }
    }
}

/// The effect types of the catalogue (`FxType` in `packages/schemas/song/fx.schema.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FxKind {
    /// `gain`.
    Gain,
    /// `eq3`: low shelf, mid bell, high shelf (RBJ biquads).
    Eq3,
    /// `filter`: 24 dB/oct state-variable filter, LP/HP/BP.
    Filter,
    /// `compressor`: feed-forward, RMS/peak blend.
    Compressor,
    /// `saturation`: ×2 oversampled tanh/asymmetric shaper.
    Saturation,
    /// `reverb`: 8-line FDN.
    Reverb,
    /// `delay`: tempo-synced, optional ping-pong.
    Delay,
    /// `width`: mid/side width.
    Width,
    /// `transient`: envelope-difference transient shaper.
    Transient,
    /// `lofi`: bit/rate reduction, wow, noise.
    Lofi,
    /// `chorus`.
    Chorus,
    /// `sidechain_duck`: ducks by an envelope follower on another track.
    SidechainDuck,
    /// `match_eq`: 31-band system EQ for seam smoothing (03 §8.2), not user-facing.
    MatchEq,
    /// `limiter`: master-only look-ahead true-peak limiter.
    Limiter,
}

const GAIN: &[ParamSpec] = &[ParamSpec::new("db", -60.0, 12.0, 0.0)];
const EQ3: &[ParamSpec] = &[
    ParamSpec::new("lowDb", -18.0, 18.0, 0.0),
    ParamSpec::new("midDb", -18.0, 18.0, 0.0),
    ParamSpec::new("highDb", -18.0, 18.0, 0.0),
    ParamSpec::new("lowHz", 40.0, 400.0, 120.0),
    ParamSpec::new("midHz", 300.0, 5000.0, 1000.0),
    ParamSpec::new("highHz", 2000.0, 12000.0, 6000.0),
    ParamSpec::new("midQ", 0.3, 4.0, 0.7),
];
const FILTER: &[ParamSpec] = &[
    ParamSpec::new("mode", 0.0, 2.0, 0.0),
    ParamSpec::new("cutoffHz", 20.0, 20000.0, 20000.0),
    ParamSpec::new("resonance", 0.0, 1.0, 0.2),
];
const COMPRESSOR: &[ParamSpec] = &[
    ParamSpec::new("thresholdDb", -60.0, 0.0, -18.0),
    ParamSpec::new("ratio", 1.0, 20.0, 3.0),
    ParamSpec::new("attackMs", 0.1, 100.0, 10.0),
    ParamSpec::new("releaseMs", 10.0, 1000.0, 120.0),
    ParamSpec::new("makeupDb", 0.0, 24.0, 0.0),
    ParamSpec::new("mix", 0.0, 1.0, 1.0),
];
const SATURATION: &[ParamSpec] = &[
    ParamSpec::new("drive", 0.0, 1.0, 0.2),
    ParamSpec::new("tone", -1.0, 1.0, 0.0),
    ParamSpec::new("mix", 0.0, 1.0, 1.0),
];
const REVERB: &[ParamSpec] = &[
    ParamSpec::new("size", 0.0, 1.0, 0.5),
    ParamSpec::new("decaySec", 0.2, 12.0, 2.0),
    ParamSpec::new("predelayMs", 0.0, 200.0, 20.0),
    ParamSpec::new("damping", 0.0, 1.0, 0.5),
    ParamSpec::new("mix", 0.0, 1.0, 0.2),
];
const DELAY: &[ParamSpec] = &[
    ParamSpec::new("timeBeats", 0.0625, 2.0, 0.25),
    ParamSpec::new("feedback", 0.0, 0.95, 0.35),
    ParamSpec::new("tone", 0.0, 1.0, 0.5),
    ParamSpec::new("pingPong", 0.0, 1.0, 0.0),
    ParamSpec::new("mix", 0.0, 1.0, 0.2),
];
const WIDTH: &[ParamSpec] = &[ParamSpec::new("width", 0.0, 2.0, 1.0)];
const TRANSIENT: &[ParamSpec] = &[
    ParamSpec::new("attack", -1.0, 1.0, 0.0),
    ParamSpec::new("sustain", -1.0, 1.0, 0.0),
];
const LOFI: &[ParamSpec] = &[
    ParamSpec::new("bits", 4.0, 16.0, 16.0),
    ParamSpec::new("rateHz", 2000.0, 48000.0, 48000.0),
    ParamSpec::new("wow", 0.0, 1.0, 0.0),
    ParamSpec::new("noise", 0.0, 1.0, 0.0),
    ParamSpec::new("mix", 0.0, 1.0, 1.0),
];
const CHORUS: &[ParamSpec] = &[
    ParamSpec::new("rateHz", 0.05, 5.0, 0.6),
    ParamSpec::new("depth", 0.0, 1.0, 0.3),
    ParamSpec::new("mix", 0.0, 1.0, 0.3),
];
const SIDECHAIN_DUCK: &[ParamSpec] = &[
    ParamSpec::new("amountDb", 0.0, 24.0, 6.0),
    ParamSpec::new("releaseMs", 20.0, 800.0, 150.0),
];
/// `match_eq` band gains: ±18 dB, like `eq3`'s gains (the catalogue leaves the array untyped).
const MATCH_EQ_BAND_DB: f32 = 18.0;
const MATCH_EQ: &[ParamSpec] = &{
    let mut specs = [ParamSpec::new("amount", 0.0, 1.0, 1.0); MATCH_EQ_BANDS + 1];
    let names = [
        "band0", "band1", "band2", "band3", "band4", "band5", "band6", "band7", "band8", "band9",
        "band10", "band11", "band12", "band13", "band14", "band15", "band16", "band17", "band18",
        "band19", "band20", "band21", "band22", "band23", "band24", "band25", "band26", "band27",
        "band28", "band29", "band30",
    ];
    let mut i = 0;
    while i < MATCH_EQ_BANDS {
        specs[i] = ParamSpec::new(names[i], -MATCH_EQ_BAND_DB, MATCH_EQ_BAND_DB, 0.0);
        i += 1;
    }
    specs
};
const LIMITER: &[ParamSpec] = &[
    ParamSpec::new("ceilingDb", -6.0, 0.0, -1.0),
    ParamSpec::new("releaseMs", 1.0, 500.0, 50.0),
];

impl FxKind {
    /// Every kind, in the schema's enum order.
    pub const ALL: [FxKind; 14] = [
        FxKind::Eq3,
        FxKind::Filter,
        FxKind::Compressor,
        FxKind::Saturation,
        FxKind::Reverb,
        FxKind::Delay,
        FxKind::Width,
        FxKind::Gain,
        FxKind::Transient,
        FxKind::Lofi,
        FxKind::Chorus,
        FxKind::SidechainDuck,
        FxKind::MatchEq,
        FxKind::Limiter,
    ];

    /// The catalogue / schema name (`sidechain_duck`).
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            FxKind::Gain => "gain",
            FxKind::Eq3 => "eq3",
            FxKind::Filter => "filter",
            FxKind::Compressor => "compressor",
            FxKind::Saturation => "saturation",
            FxKind::Reverb => "reverb",
            FxKind::Delay => "delay",
            FxKind::Width => "width",
            FxKind::Transient => "transient",
            FxKind::Lofi => "lofi",
            FxKind::Chorus => "chorus",
            FxKind::SidechainDuck => "sidechain_duck",
            FxKind::MatchEq => "match_eq",
            FxKind::Limiter => "limiter",
        }
    }

    /// The kind for a catalogue / schema name.
    #[must_use]
    pub fn from_name(name: &str) -> Option<FxKind> {
        FxKind::ALL.into_iter().find(|kind| kind.name() == name)
    }

    /// The indexed numeric parameters, in catalogue order.
    #[must_use]
    pub const fn params(self) -> &'static [ParamSpec] {
        match self {
            FxKind::Gain => GAIN,
            FxKind::Eq3 => EQ3,
            FxKind::Filter => FILTER,
            FxKind::Compressor => COMPRESSOR,
            FxKind::Saturation => SATURATION,
            FxKind::Reverb => REVERB,
            FxKind::Delay => DELAY,
            FxKind::Width => WIDTH,
            FxKind::Transient => TRANSIENT,
            FxKind::Lofi => LOFI,
            FxKind::Chorus => CHORUS,
            FxKind::SidechainDuck => SIDECHAIN_DUCK,
            FxKind::MatchEq => MATCH_EQ,
            FxKind::Limiter => LIMITER,
        }
    }

    /// The index of the parameter called `name`, for plan compilation (never the audio thread).
    #[must_use]
    pub fn param_index(self, name: &str) -> Option<usize> {
        self.params().iter().position(|spec| spec.name == name)
    }

    /// Whether the effect may only sit on the master chain (`limiter`).
    #[must_use]
    pub const fn master_only(self) -> bool {
        matches!(self, FxKind::Limiter)
    }

    /// Whether the effect is system-generated and hidden from users (`match_eq`).
    #[must_use]
    pub const fn system(self) -> bool {
        matches!(self, FxKind::MatchEq)
    }
}

/// Per-block context the engine hands every effect.
#[derive(Debug, Clone, Copy)]
pub struct FxContext<'a> {
    /// The tempo at the start of the block, in BPM (`delay` syncs to it).
    pub bpm: f64,
    /// The key signal for `sidechain_duck`: the source track's left and right channels for this
    /// block, post-fader. `None` when the effect has no source or the source is silent/missing.
    pub sidechain: Option<(&'a [f32], &'a [f32])>,
}

impl Default for FxContext<'_> {
    fn default() -> Self {
        Self {
            bpm: 120.0,
            sidechain: None,
        }
    }
}

/// An audio effect from the catalogue.
///
/// Built by [`create`] (allocating), then driven from the audio thread. See the module docs for
/// the rules every implementation keeps.
pub trait Effect: Send {
    /// Which catalogue entry this is.
    fn kind(&self) -> FxKind;

    /// Sets the target of parameter `index` (an index into [`FxKind::params`]). Out-of-range
    /// indices and NaN are ignored; values are clamped. Allocation-free.
    fn set_param(&mut self, index: usize, value: f32);

    /// Jumps every parameter to its target and clears all internal state (delay lines, envelopes,
    /// filter memories). Used on seek and on a fresh plan. Allocation-free.
    fn reset(&mut self);

    /// Processes one block in place. Allocation-free and panic-free.
    fn process(&mut self, left: &mut [f32], right: &mut [f32], ctx: &FxContext<'_>);

    /// The algorithmic latency in frames (the limiter's look-ahead); 0 for most effects.
    fn latency(&self) -> usize {
        0
    }

    /// The tail after the input goes silent, in frames (reverb/delay ring-out); used by offline
    /// renders to decide how long to keep processing. 0 when the effect has no tail.
    fn tail(&self) -> usize {
        0
    }
}

/// Errors from [`create`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FxError {
    /// The kind exists in the catalogue but has no implementation yet.
    #[error("fx type {0} is not implemented")]
    NotImplemented(&'static str),
    /// The sample rate is outside 8 kHz..=384 kHz.
    #[error("sample rate {0} out of range")]
    SampleRate(u32),
    /// `max_block` is zero.
    #[error("max block size must be positive")]
    MaxBlock,
}

/// Builds an effect at its catalogue defaults. Allocates; call it off the audio thread.
///
/// `max_block` is the largest block `process` will be called with (the engine's render quantum);
/// effects that need scratch space size it from this.
///
/// # Errors
/// [`FxError::NotImplemented`] for a kind with no implementation yet, [`FxError::SampleRate`] /
/// [`FxError::MaxBlock`] for unusable arguments.
pub fn create(
    kind: FxKind,
    sample_rate: u32,
    max_block: usize,
) -> Result<Box<dyn Effect>, FxError> {
    if !(8_000..=384_000).contains(&sample_rate) {
        return Err(FxError::SampleRate(sample_rate));
    }
    if max_block == 0 {
        return Err(FxError::MaxBlock);
    }
    match kind {
        FxKind::Gain => Ok(Box::new(Gain::new(sample_rate))),
        FxKind::Reverb => Ok(Box::new(Reverb::new(sample_rate, max_block))),
        FxKind::Delay => Ok(Box::new(Delay::new(sample_rate, max_block))),
        FxKind::SidechainDuck => Ok(Box::new(SidechainDuck::new(sample_rate, max_block))),
        other => Err(FxError::NotImplemented(other.name())),
    }
}

/// Converts decibels to a linear amplitude factor.
#[must_use]
pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

/// Converts a linear amplitude factor to decibels (−∞ for 0).
#[must_use]
pub fn lin_to_db(lin: f32) -> f32 {
    20.0 * lin.log10()
}
