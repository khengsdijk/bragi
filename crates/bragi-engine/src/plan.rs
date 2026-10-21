//! The render plan and its compiler.
//!
//! The audio thread never interprets the song document
//! (`specs/03-audio-engine.md` §4). On every load or delta a planner compiles an
//! immutable [`RenderPlan`]: every clip occurrence flattened to absolute output
//! samples, with its source map, fades, gain and (where needed) stretch ratio.
//!
//! ## What becomes samples
//!
//! - Section starts are derived from `lengthTicks` (`bragi_model::section_spans`)
//!   and converted with [`bragi_model::TempoCtx`]. Tick → sample conversion is
//!   the only place the tempo map is read.
//! - `warp: none` plays the asset at its own rate: one segment, ratio 1.
//! - `warp: beatgrid` converts its anchors to absolute output samples and splits
//!   the clip wherever the local rate changes, so each piece has a constant
//!   ratio. Adjacent pieces whose ratio differs by less than
//!   [`RATIO_EPSILON`] are coalesced.
//! - `warp: stretch` uses the clip's ratio directly.
//! - A piece stays on the **direct path** when its ratio is 1, the asset is at
//!   the output rate and no pitch shift is requested. Everything else drives a
//!   `PhaseVocoder` allocated by the renderer's `prepare`, never by `process`.
//!
//! Compilation allocates freely; it runs on the planner side.

use std::collections::HashMap;

use bragi_dsp::fx::{FxKind, create};
use bragi_dsp::stretch::Quality;
use bragi_model::EngineDelta;
use bragi_model::generated::{
    AssetHash, AutomationCurve, Clip, ClipId, FxId, FxInstance, Project, TempoCurve, TempoPoint,
    Track, TrackId, Transition, TransitionKind, Warp,
};
use bragi_model::{AssetIndex, TempoCtx, clip_end_local, derived_id, section_spans};

use crate::error::PlanError;
use crate::fade::{Fade, FadeShape, curve_gain};
use crate::srcmap::SrcMap;
use crate::{BOUNDARY_FADE_MS, RATIO_EPSILON, SAMPLE_RATE};

/// Planner options (`specs/03-audio-engine.md` §4).
///
/// The defaults are the production behaviour; tests use [`PlanOptions`] to
/// compare a render with and without the section-boundary crossfades of §5.5.
///
/// # Examples
///
/// ```
/// use bragi_engine::plan::PlanOptions;
/// assert!(PlanOptions::default().section_fades);
/// let off = PlanOptions { section_fades: false };
/// assert!(!off.section_fades);
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlanOptions {
    /// Apply the centred section-boundary crossfades of
    /// `specs/03-audio-engine.md` §5.5. Contiguous boundaries are never
    /// touched, with or without this flag.
    pub section_fades: bool,
}

impl Default for PlanOptions {
    fn default() -> Self {
        Self {
            section_fades: true,
        }
    }
}

/// A compiled, immutable render plan (`specs/03-audio-engine.md` §4).
#[derive(Clone, Debug)]
pub struct RenderPlan {
    /// Output sample rate. Always equal to the project rate.
    pub sample_rate: u32,
    /// Total arrangement length in output samples.
    pub length_samples: u64,
    /// The tracks, in document order.
    pub tracks: Vec<TrackPlan>,
    /// The master bus.
    pub master: MasterPlan,
    /// Section extents in output samples, in order.
    pub sections: Vec<SectionSpanSamples>,
    /// Monotonic version, bumped on every recompilation.
    pub plan_version: u64,
    /// Clips that were dropped during compilation and why (missing asset,
    /// zero-length window, …), plus fx that could not be built. Never read on
    /// the audio thread.
    pub warnings: Vec<String>,
    /// The document's tempo map, kept so the renderer can report the tempo at a
    /// block start to [`bragi_dsp::fx::FxContext`].
    pub tempo_points: Vec<TempoPoint>,
    /// Pulses per quarter note for [`RenderPlan::tempo_points`].
    pub ppq: i64,
    /// Generated transition overlays (`specs/03-audio-engine.md` §5.5), in section
    /// order. They belong to no track: the renderer mixes them into the master bus
    /// before the master chain, so they sound even when no track crosses the join.
    pub overlays: Vec<Segment>,
}

/// A section's absolute extent in output samples.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SectionSpanSamples {
    /// The section ID.
    pub id: bragi_model::generated::SectionId,
    /// Absolute start sample.
    pub start: u64,
    /// Absolute end sample (exclusive).
    pub end: u64,
}

/// One track's compiled content.
#[derive(Clone, Debug)]
pub struct TrackPlan {
    /// The track ID.
    pub id: TrackId,
    /// The track's display name (debugging and events only).
    pub name: String,
    /// Clip occurrences, sorted by `dst_start`.
    pub segments: Vec<Segment>,
    /// Track gain as a linear factor.
    pub gain: f32,
    /// Pan, `-1..=1`.
    pub pan: f32,
    /// Muted in the document.
    pub mute: bool,
    /// Soloed in the document.
    pub solo: bool,
    /// Gain automation in absolute samples, in dB.
    pub automation: Vec<AutomationLane>,
    /// The track's effect chain, in order (`specs/02-song-model.md` §3.6).
    pub fx: Vec<FxSlot>,
}

/// One effect in a compiled chain.
///
/// Parameters are resolved from catalogue names to indices at compile time, so
/// the audio thread never touches strings. Unknown names are dropped (and
/// reported as a plan warning), and a kind that [`bragi_dsp::fx::create`]
/// cannot build yet is bypassed at runtime, never treated as a plan error.
#[derive(Clone, Debug, PartialEq)]
pub struct FxSlot {
    /// The document's effect ID.
    pub id: FxId,
    /// The catalogue kind.
    pub kind: FxKind,
    /// `(index into [`FxKind::params`], value)` pairs.
    pub params: Vec<(usize, f32)>,
    /// Bypassed in the document (or because the effect cannot run yet).
    pub bypass: bool,
    /// Index of the source track for `sidechain_duck`, resolved from the
    /// document's `sidechainSource` (03 §6 `sourceTrack`). A duck without a
    /// source is bypassed; it behaves as identity.
    pub sidechain_source: Option<usize>,
    /// The effect's algorithmic latency in frames, from
    /// [`Effect::latency`](bragi_dsp::fx::Effect::latency) at compile time
    /// (0 for an unimplemented kind). Used for plugin delay compensation and
    /// to report a compensation delay beyond [`MAX_COMPENSATION_FRAMES`].
    pub latency: usize,
}

/// The largest plugin-delay-compensation delay a track may ask for, in frames
/// (about 171 ms at 48 kHz). A plan that would need more is clamped and warns.
pub const MAX_COMPENSATION_FRAMES: usize = 8192;

/// One side of a centred equal-power crossfade at a section boundary
/// (`specs/03-audio-engine.md` §5.5).
///
/// The planner stores one of these on each segment that touches a
/// discontinuous boundary: `boundary_in` for the fade-in of the incoming
/// segment and `boundary_out` for the fade-out of the outgoing one. The gains of
/// both multiply with each other and with the clip's own fades.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BoundaryFade {
    /// Absolute output sample of the boundary, the centre of the crossfade.
    pub center: u64,
    /// Total crossfade length `L` in output samples.
    pub len_samples: u64,
    /// Whether this side has source material past the boundary. With a handle
    /// the side fades over the full `L`; without one it fades over its own half.
    pub has_handle: bool,
}

impl BoundaryFade {
    /// A fade of `len_samples` centred on `center`.
    #[must_use]
    pub fn new(center: u64, len_samples: u64, has_handle: bool) -> Self {
        Self {
            center,
            len_samples,
            has_handle,
        }
    }

    /// The fade-in gain at absolute output sample `dst`.
    ///
    /// # Examples
    ///
    /// ```
    /// use bragi_engine::plan::BoundaryFade;
    /// let fade = BoundaryFade::new(1_000, 100, true);
    /// assert_eq!(fade.gain_in(950), 0.0);
    /// assert!((fade.gain_in(1_000) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    /// assert_eq!(fade.gain_in(1_050), 1.0);
    /// ```
    #[must_use]
    pub fn gain_in(&self, dst: u64) -> f32 {
        let half = self.len_samples / 2;
        if half == 0 {
            return 1.0;
        }
        let start = if self.has_handle {
            self.center.saturating_sub(half)
        } else {
            self.center
        };
        if dst < start {
            return 0.0;
        }
        let span = if self.has_handle { 2 * half } else { half };
        let x = ((dst - start) as f32 / span as f32).clamp(0.0, 1.0);
        curve_gain(FadeShape::EqualPower, x)
    }

    /// The fade-out gain at absolute output sample `dst`.
    ///
    /// # Examples
    ///
    /// ```
    /// use bragi_engine::plan::BoundaryFade;
    /// let fade = BoundaryFade::new(1_000, 100, true);
    /// assert_eq!(fade.gain_out(950), 1.0);
    /// assert!((fade.gain_out(1_000) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
    /// assert_eq!(fade.gain_out(1_050), 0.0);
    /// ```
    #[must_use]
    pub fn gain_out(&self, dst: u64) -> f32 {
        let half = self.len_samples / 2;
        if half == 0 {
            return 1.0;
        }
        let start = self.center.saturating_sub(half);
        if dst < start {
            return 1.0;
        }
        let span = if self.has_handle { 2 * half } else { half };
        let x = ((dst - start) as f32 / span as f32).clamp(0.0, 1.0);
        curve_gain(FadeShape::EqualPower, 1.0 - x)
    }
}

/// One clip occurrence flattened to absolute output samples.
#[derive(Clone, Debug)]
pub struct Segment {
    /// The clip the segment came from.
    pub clip_id: ClipId,
    /// The asset to read.
    pub asset: AssetHash,
    /// First output sample (absolute, inclusive).
    pub dst_start: u64,
    /// Last output sample (absolute, exclusive).
    pub dst_end: u64,
    /// The clip's own first output sample, before this segment was split.
    pub clip_start: u64,
    /// The clip's own last output sample, before this segment was split.
    pub clip_end: u64,
    /// Index of the section the clip lives in (`RenderPlan::sections`).
    pub section: usize,
    /// First source sample (inclusive).
    pub src_start: u64,
    /// Last source sample (exclusive).
    pub src_end: u64,
    /// Output-offset → source-position map, relative to `dst_start`.
    pub src_map: SrcMap,
    /// Time ratio (output duration / input duration).
    pub ratio: f64,
    /// Pitch shift in semitones.
    pub pitch_semitones: f32,
    /// Clip gain as a linear factor.
    pub gain: f32,
    /// Fade at the clip's start.
    pub fade_in: Fade,
    /// Fade at the clip's end.
    pub fade_out: Fade,
    /// Play the source backwards.
    pub reverse: bool,
    /// Source channel count (1 or 2).
    pub channels: u16,
    /// Source sample rate.
    pub src_rate: u32,
    /// Asset duration in source frames, for boundary-handle bounds.
    pub asset_frames: u64,
    /// Output samples rendered before `dst_start` from the source handle
    /// (a section-boundary crossfade). `0` outside a crossfade.
    pub pre_roll: u64,
    /// Output samples rendered after `dst_end` from the source handle
    /// (a section-boundary crossfade). `0` outside a crossfade.
    pub post_roll: u64,
    /// Fade-in at the incoming section boundary, if this segment is the
    /// incoming side of a discontinuous boundary.
    pub boundary_in: Option<BoundaryFade>,
    /// Fade-out at the outgoing section boundary, if this segment is the
    /// outgoing side of a discontinuous boundary.
    pub boundary_out: Option<BoundaryFade>,
}

impl Segment {
    /// Whether this segment needs the phase vocoder.
    #[must_use]
    pub fn needs_stretcher(&self) -> bool {
        self.pitch_semitones.abs() > f32::EPSILON
            || (self.ratio - 1.0).abs() > RATIO_EPSILON
            || self.src_rate != SAMPLE_RATE
    }

    /// The first output sample this segment renders, including its pre-roll.
    #[must_use]
    pub fn render_start(&self) -> u64 {
        self.dst_start.saturating_sub(self.pre_roll)
    }

    /// The last output sample this segment renders (exclusive), including its
    /// post-roll.
    #[must_use]
    pub fn render_end(&self) -> u64 {
        self.dst_end.saturating_add(self.post_roll)
    }

    /// Frames this segment contributes to an output block starting at
    /// `block_start` of length `block_frames`, as `(offset, frames)` in output
    /// samples, or `None` when it is silent in that block.
    #[must_use]
    pub fn overlap(&self, block_start: u64, block_frames: usize) -> Option<(usize, usize)> {
        let block_end = block_start.saturating_add(block_frames as u64);
        let start = self.render_start().max(block_start);
        let end = self.render_end().min(block_end);
        if end <= start {
            None
        } else {
            Some(((start - block_start) as usize, (end - start) as usize))
        }
    }

    /// The source position (in source samples) this segment plays at output
    /// offset `local` from `dst_start`. Negative offsets are the pre-roll; the
    /// map extrapolates before the window with its first slope.
    ///
    /// # Examples
    ///
    /// ```
    /// # use bragi_engine::fade::Fade;
    /// # use bragi_engine::plan::Segment;
    /// # use bragi_engine::srcmap::SrcMap;
    /// let segment = Segment {
    ///     clip_id: "clp_01".parse().unwrap(),
    ///     asset: format!("sha256:{}", "0".repeat(64)).parse().unwrap(),
    ///     dst_start: 0, dst_end: 100, clip_start: 0, clip_end: 100, section: 0,
    ///     src_start: 200, src_end: 300, src_map: SrcMap::linear(100, 200, 300),
    ///     ratio: 1.0, pitch_semitones: 0.0, gain: 1.0, fade_in: Fade::none(),
    ///     fade_out: Fade::none(), reverse: false, channels: 2, src_rate: 48_000,
    ///     asset_frames: 1_000, pre_roll: 0, post_roll: 0,
    ///     boundary_in: None, boundary_out: None,
    /// };
    /// assert!((segment.source_position(50) - 250.0).abs() < 1e-9);
    /// assert!((segment.source_position(-10) - 190.0).abs() < 1e-9);
    /// ```
    #[must_use]
    pub fn source_position(&self, local: i64) -> f64 {
        let pos = self.src_map.src_at_signed(local);
        if self.reverse {
            let mirrored = self.src_end as f64 - 1.0 - (pos - self.src_start as f64);
            let last = self.asset_frames.saturating_sub(1) as f64;
            mirrored.clamp(0.0, last)
        } else {
            pos
        }
    }

    /// The combined fade gain at absolute output sample `dst`: the clip's own
    /// fades and the section-boundary crossfade, multiplied.
    #[must_use]
    pub fn fade_gain(&self, dst: u64) -> f32 {
        let from_in = dst.saturating_sub(self.clip_start);
        let to_out = self.clip_end.saturating_sub(dst);
        let mut gain = self.fade_in.gain_in(from_in) * self.fade_out.gain_out(to_out);
        if let Some(fade) = self.boundary_in {
            gain *= fade.gain_in(dst);
        }
        if let Some(fade) = self.boundary_out {
            gain *= fade.gain_out(dst);
        }
        gain
    }
}

/// The master bus.
#[derive(Clone, Debug)]
pub struct MasterPlan {
    /// Master gain as a linear factor.
    pub gain: f32,
    /// Master gain automation in absolute samples, in dB.
    pub automation: Vec<AutomationLane>,
    /// Safety limiter ceiling as a linear factor (`specs/03-audio-engine.md` §6).
    pub ceiling: f32,
    /// The master effect chain, in order, before the master gain and limiter.
    pub fx: Vec<FxSlot>,
}

/// A gain automation lane, already in absolute output samples.
#[derive(Clone, Debug)]
pub struct AutomationLane {
    /// What the lane drives.
    pub target: AutomationTarget,
    /// Points sorted by sample.
    pub points: Vec<AutoPoint>,
}

/// The parameter an automation lane drives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutomationTarget {
    /// `track:<id>/gainDb`.
    TrackGain,
    /// `master/gainDb` (absolute arrangement ticks in the document).
    MasterGain,
    /// `fx:<fxId>/<param>` (02 §3.8). `slot` indexes the chain that owns the
    /// lane — a track's chain for a lane in that track's section, the master
    /// chain for a master lane — and `index` is the catalogue parameter index.
    FxParam {
        /// Position of the effect in its chain.
        slot: usize,
        /// Index into [`bragi_dsp::fx::FxKind::params`].
        index: usize,
    },
}

/// One automation point, converted to output samples.
#[derive(Clone, Copy, Debug)]
pub struct AutoPoint {
    /// Absolute output sample.
    pub sample: u64,
    /// The value (dB for gain lanes).
    pub value: f64,
    /// Interpolation to the next point.
    pub curve: AutomationCurve,
}

impl AutomationLane {
    /// The value at `sample`, or `None` when the lane has no points.
    ///
    /// - `step` holds the previous point's value;
    /// - `linear` interpolates;
    /// - `exp` interpolates linearly in dB (a documented approximation; an
    ///   exponential amplitude curve on a dB target is not meaningful).
    #[must_use]
    pub fn value_at(&self, sample: u64) -> Option<f64> {
        let first = self.points.first()?;
        if sample <= first.sample {
            return Some(first.value);
        }
        let last = *self.points.last()?;
        if sample >= last.sample {
            return Some(last.value);
        }
        let index = self.points.partition_point(|p| p.sample <= sample);
        let a = self.points[index - 1];
        let b = self.points[index];
        match a.curve {
            AutomationCurve::Step => Some(a.value),
            // `exp` and `linear` both interpolate; the curve type only becomes
            // meaningful once amplitude targets exist (Q29).
            AutomationCurve::Linear | AutomationCurve::Exp => {
                let span = b.sample.saturating_sub(a.sample) as f64;
                if span <= 0.0 {
                    Some(b.value)
                } else {
                    let t = (sample.saturating_sub(a.sample)) as f64 / span;
                    Some(a.value + (b.value - a.value) * t)
                }
            }
        }
    }
}

impl RenderPlan {
    /// Length in seconds.
    #[must_use]
    pub fn duration_seconds(&self) -> f64 {
        self.length_samples as f64 / self.sample_rate as f64
    }

    /// Looks a track up by ID.
    #[must_use]
    pub fn track(&self, id: &TrackId) -> Option<&TrackPlan> {
        self.tracks.iter().find(|track| &track.id == id)
    }

    /// Whether any track is soloed (solo-mutes the rest).
    #[must_use]
    pub fn any_solo(&self) -> bool {
        self.tracks.iter().any(|track| track.solo)
    }

    /// Total number of segment occurrences (for scratch/meter sizing).
    #[must_use]
    pub fn segment_count(&self) -> usize {
        self.tracks.iter().map(|track| track.segments.len()).sum()
    }

    /// The largest source-frames-per-output-frame factor of any segment, used
    /// to size the renderer's source scratch.
    #[must_use]
    pub fn max_source_step(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|track| &track.segments)
            .chain(self.overlays.iter())
            .map(|segment| {
                let map_slope = segment
                    .src_map
                    .points()
                    .windows(2)
                    .map(|pair| {
                        let dst = pair[1].dst.saturating_sub(pair[0].dst).max(1) as f64;
                        (pair[1].src - pair[0].src) / dst
                    })
                    .fold(0.0_f64, f64::max);
                let stretch = if segment.ratio > 0.0 {
                    1.0 / segment.ratio
                } else {
                    1.0
                };
                map_slope.max(stretch).max(1.0)
            })
            .fold(1.0_f64, f64::max)
    }

    /// The tempo in BPM at an absolute output sample, from the document's
    /// tempo map. Used to fill [`bragi_dsp::fx::FxContext::bpm`] per block.
    ///
    /// # Examples
    ///
    /// ```
    /// # use bragi_engine::plan::compile;
    /// # use bragi_model::{AssetIndex, generated::Project};
    /// # let doc: Project = serde_json::from_value(serde_json::json!({
    /// #   "schemaVersion": 1, "id": "prj_01",
    /// #   "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
    /// #   "sources": [], "analyses": {}, "tracks": [],
    /// #   "arrangement": { "timebase": { "ppq": 960,
    /// #       "tempoMap": [{ "tick": 0, "bpm": 90, "curve": "step" }], "timeSignatures": [] },
    /// #       "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
    /// let plan = compile(&doc, &AssetIndex::new(), 48_000, 1).unwrap();
    /// assert!((plan.bpm_at_sample(48_000) - 90.0).abs() < 1e-9);
    /// ```
    #[must_use]
    pub fn bpm_at_sample(&self, sample: u64) -> f64 {
        let Some(first) = self.tempo_points.first() else {
            return 120.0;
        };
        let tempo = TempoCtx::new(&self.tempo_points, self.ppq);
        let tick = tempo.seconds_to_ticks(sample as f64 / self.sample_rate as f64);
        if tick <= first.tick as i64 {
            return first.bpm;
        }
        for (index, point) in self.tempo_points.iter().enumerate() {
            let Some(next) = self.tempo_points.get(index + 1) else {
                return point.bpm;
            };
            if tick < next.tick as i64 {
                if point.curve == TempoCurve::Linear && next.tick > point.tick {
                    let t = (tick - point.tick as i64) as f64 / (next.tick - point.tick) as f64;
                    return point.bpm + (next.bpm - point.bpm) * t;
                }
                return point.bpm;
            }
        }
        self.tempo_points.last().map_or(120.0, |point| point.bpm)
    }
}

/// Compiles a whole document into a render plan
/// (`specs/03-audio-engine.md` §4).
///
/// `plan_version` becomes [`RenderPlan::plan_version`]; the host increments it.
///
/// # Errors
/// [`PlanError::UnsupportedSampleRate`] when `sample_rate` is not 48 kHz, and
/// [`PlanError::MissingAsset`] when a clip's asset has no metadata.
///
/// ```
/// # use bragi_engine::plan::compile;
/// # use bragi_model::{AssetIndex, generated::Project};
/// # let doc: Project = serde_json::from_value(serde_json::json!({
/// #   "schemaVersion": 1, "id": "prj_01",
/// #   "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #   "sources": [], "analyses": {}, "tracks": [],
/// #   "arrangement": { "timebase": { "ppq": 960,
/// #       "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
/// #       "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
/// let plan = compile(&doc, &AssetIndex::new(), 48_000, 1).unwrap();
/// assert_eq!(plan.length_samples, 0);
/// ```
pub fn compile(
    doc: &Project,
    assets: &AssetIndex,
    sample_rate: u32,
    plan_version: u64,
) -> Result<RenderPlan, PlanError> {
    compile_with(
        doc,
        assets,
        sample_rate,
        plan_version,
        PlanOptions::default(),
        &HashMap::new(),
    )
}

/// Compiles a document with explicit planner options.
///
/// The only option today is whether to apply the section-boundary crossfades of
/// `specs/03-audio-engine.md` §5.5. [`compile`] enables them; a test can turn
/// them off to show that a discontinuity check has teeth.
///
/// # Errors
/// The same errors as [`compile`].
///
/// # Examples
///
/// ```
/// # use bragi_engine::plan::{compile_with_options, PlanOptions};
/// # use bragi_model::{AssetIndex, generated::Project};
/// # let doc: Project = serde_json::from_value(serde_json::json!({
/// #   "schemaVersion": 1, "id": "prj_01",
/// #   "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #   "sources": [], "analyses": {}, "tracks": [],
/// #   "arrangement": { "timebase": { "ppq": 960,
/// #       "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
/// #       "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
/// let plan = compile_with_options(
///     &doc,
///     &AssetIndex::new(),
///     48_000,
///     1,
///     PlanOptions { section_fades: false },
/// )
/// .unwrap();
/// assert_eq!(plan.length_samples, 0);
/// ```
pub fn compile_with_options(
    doc: &Project,
    assets: &AssetIndex,
    sample_rate: u32,
    plan_version: u64,
    options: PlanOptions,
) -> Result<RenderPlan, PlanError> {
    compile_with(
        doc,
        assets,
        sample_rate,
        plan_version,
        options,
        &HashMap::new(),
    )
}

/// Recompiles only the tracks an [`EngineDelta`] can have changed.
///
/// A structural delta (`requires_full_resync`), a timebase change or any section
/// update recompiles everything, because a clip edit arrives as a whole
/// `SectionInstance` and may move any lane. A pure track update (gain, pan,
/// mute, solo, fx) keeps the other tracks' compiled segments.
///
/// # Errors
/// The same errors as [`compile`].
pub fn compile_delta(
    prev: &RenderPlan,
    doc: &Project,
    assets: &AssetIndex,
    delta: &EngineDelta,
) -> Result<RenderPlan, PlanError> {
    let structural = delta.requires_full_resync
        || delta.timebase_changed
        || !delta.sections_added.is_empty()
        || !delta.sections_removed.is_empty()
        || !delta.sections_updated.is_empty();

    let mut keep = HashMap::new();
    if !structural {
        for track in &prev.tracks {
            keep.insert(track.id.clone(), track.clone());
        }
        for track in &delta.tracks_updated {
            keep.remove(&track.id);
        }
        for track in &delta.tracks_added {
            keep.remove(&track.id);
        }
        for id in &delta.tracks_removed {
            keep.remove(id);
        }
    }

    compile_with(
        doc,
        assets,
        prev.sample_rate,
        prev.plan_version + 1,
        PlanOptions::default(),
        &keep,
    )
}

fn compile_with(
    doc: &Project,
    assets: &AssetIndex,
    sample_rate: u32,
    plan_version: u64,
    options: PlanOptions,
    keep: &HashMap<TrackId, TrackPlan>,
) -> Result<RenderPlan, PlanError> {
    if sample_rate != SAMPLE_RATE {
        return Err(PlanError::UnsupportedSampleRate(sample_rate));
    }
    let tempo = TempoCtx::from_project(doc);
    let spans = section_spans(doc);
    let mut warnings = Vec::new();

    let mut sections = Vec::with_capacity(spans.len());
    for span in &spans {
        let start = tick_to_sample(&tempo, sample_rate, span.start_tick).max(0) as u64;
        let end = tick_to_sample(&tempo, sample_rate, span.end_tick).max(0) as u64;
        sections.push(SectionSpanSamples {
            id: span.id.clone(),
            start,
            end,
        });
    }
    let length_samples = sections.last().map_or(0, |section| section.end);

    let mut unavailable: Vec<&'static str> = Vec::new();
    let mut tracks = Vec::with_capacity(doc.tracks.len());
    for track in &doc.tracks {
        if let Some(kept) = keep.get(&track.id) {
            // Re-apply the cheap scalar fields even for a kept track: a
            // `track.update` that only changes gain must not need a rebuild.
            let mut kept = kept.clone();
            kept.gain = db_to_gain(track.gain_db);
            kept.pan = track.pan as f32;
            kept.mute = track.mute;
            kept.solo = track.solo;
            kept.automation = track_automation(track, doc, &tempo, &spans, sample_rate);
            tracks.push(kept);
            continue;
        }
        tracks.push(compile_track(
            track,
            doc,
            assets,
            &tempo,
            &spans,
            &sections,
            sample_rate,
            length_samples,
            options,
            &mut warnings,
            &mut unavailable,
        )?);
    }

    let master_fx = compile_fx_chain(
        &doc.arrangement.master.fx,
        doc,
        sample_rate,
        "master",
        &mut warnings,
        &mut unavailable,
    );
    let master = MasterPlan {
        gain: db_to_gain(doc.arrangement.master.gain_db),
        automation: master_automation(doc, &tempo, sample_rate),
        // -0.3 dBFS: the safety limiter of `specs/03-audio-engine.md` §6.
        ceiling: 10.0_f32.powf(-0.3 / 20.0),
        fx: master_fx,
    };
    let overlays = compile_overlays(
        doc,
        assets,
        &tempo,
        &spans,
        &sections,
        sample_rate,
        &mut warnings,
    );

    // Plugin delay compensation: the slowest track sets the alignment point.
    // The renderer clamps each per-track delay to `MAX_COMPENSATION_FRAMES`;
    // report the tracks that hit the cap (03 §6, §9).
    let latencies: Vec<usize> = tracks
        .iter()
        .map(|track| chain_latency(&track.fx))
        .collect();
    let max_latency = latencies.iter().copied().max().unwrap_or(0);
    for (track, latency) in tracks.iter().zip(&latencies) {
        let compensation = max_latency.saturating_sub(*latency);
        if compensation > MAX_COMPENSATION_FRAMES {
            warnings.push(format!(
                "track {}: plugin delay compensation of {compensation} frames exceeds the {} frame cap; clamped",
                track.id, MAX_COMPENSATION_FRAMES
            ));
        }
    }

    Ok(RenderPlan {
        sample_rate,
        length_samples,
        tracks,
        master,
        sections,
        plan_version,
        warnings,
        tempo_points: doc.arrangement.timebase.tempo_map.0.clone(),
        ppq: *doc.arrangement.timebase.ppq,
        overlays,
    })
}

#[allow(clippy::too_many_arguments)]
fn compile_track(
    track: &Track,
    doc: &Project,
    assets: &AssetIndex,
    tempo: &TempoCtx<'_>,
    spans: &[bragi_model::SectionSpan],
    sections: &[SectionSpanSamples],
    sample_rate: u32,
    length_samples: u64,
    options: PlanOptions,
    warnings: &mut Vec<String>,
    unavailable: &mut Vec<&'static str>,
) -> Result<TrackPlan, PlanError> {
    let mut segments = Vec::new();
    for (section_index, (section, span)) in doc.arrangement.sections.iter().zip(spans).enumerate() {
        let Some(lane) = section.lanes.get(&track.id) else {
            continue;
        };
        for clip in &lane.clips {
            compile_clip(
                clip,
                section_index,
                span.start_tick,
                span.end_tick,
                assets,
                tempo,
                sample_rate,
                length_samples,
                &mut segments,
                warnings,
            )?;
        }
    }
    segments.sort_by_key(|segment| segment.dst_start);
    apply_section_boundaries(
        &mut segments,
        doc,
        tempo,
        spans,
        sections,
        sample_rate,
        options,
        warnings,
    );
    Ok(TrackPlan {
        id: track.id.clone(),
        name: track.name.clone(),
        segments,
        gain: db_to_gain(track.gain_db),
        pan: track.pan as f32,
        mute: track.mute,
        solo: track.solo,
        automation: track_automation(track, doc, tempo, spans, sample_rate),
        fx: compile_fx_chain(
            &track.fx,
            doc,
            sample_rate,
            &format!("track {}", track.id),
            warnings,
            unavailable,
        ),
    })
}

/// Applies the section-boundary crossfades of `specs/03-audio-engine.md` §5.5
/// to one track's compiled segments.
///
/// A boundary is left alone when the outgoing and incoming segment are
/// contiguous: the same asset and the same source position at the boundary
/// (within one source sample, after warp and ratio). Every other pair gets a
/// centred equal-power fade; the segment keeps its own window (`dst_start` /
/// `dst_end`), and `pre_roll` / `post_roll` only extend what the renderer reads.
#[allow(clippy::too_many_arguments)]
fn apply_section_boundaries(
    segments: &mut [Segment],
    doc: &Project,
    tempo: &TempoCtx<'_>,
    spans: &[bragi_model::SectionSpan],
    sections: &[SectionSpanSamples],
    sample_rate: u32,
    options: PlanOptions,
    warnings: &mut Vec<String>,
) {
    if !options.section_fades {
        return;
    }
    for index in 1..sections.len() {
        let boundary = sections[index].start;
        if boundary == 0 {
            continue;
        }
        let previous = &sections[index - 1];
        let current = &sections[index];
        let Some(section) = doc.arrangement.sections.get(index) else {
            continue;
        };
        let Some(span) = spans.get(index) else {
            continue;
        };

        let outgoing: Vec<usize> = segments
            .iter()
            .enumerate()
            .filter(|(_, segment)| segment.dst_end == boundary)
            .map(|(index, _)| index)
            .collect();
        let incoming: Vec<usize> = segments
            .iter()
            .enumerate()
            .filter(|(_, segment)| segment.dst_start == boundary)
            .map(|(index, _)| index)
            .collect();
        if outgoing.is_empty() && incoming.is_empty() {
            continue;
        }
        if outgoing.len() == 1
            && incoming.len() == 1
            && contiguous(&segments[outgoing[0]], &segments[incoming[0]])
        {
            continue;
        }

        let transition = &section.transition_in;
        if transition.kind == TransitionKind::Generated && transition.asset.is_none() {
            warnings.push(format!(
                "section {}: generated transition has no asset; rendering the crossfade placeholder",
                section.id
            ));
        }
        let mut len_samples = transition_len_samples(tempo, sample_rate, span, transition);
        // Never reach past half of either neighbouring section (03 §5.5).
        len_samples = len_samples
            .min((previous.end - previous.start) / 2)
            .min((current.end - current.start) / 2);
        let half = len_samples / 2;
        if half == 0 {
            continue;
        }

        // A handle only matters when there is something to crossfade with: a
        // track that is silent on one side fades over its own half, so no
        // material leaks into the neighbouring section.
        let crossfade = !outgoing.is_empty() && !incoming.is_empty();
        for &index in &outgoing {
            let has_handle = crossfade && handle_after(&segments[index], half);
            segments[index].post_roll = if has_handle { half } else { 0 };
            segments[index].boundary_out =
                Some(BoundaryFade::new(boundary, len_samples, has_handle));
        }
        for &index in &incoming {
            let has_handle = crossfade && handle_before(&segments[index], half);
            segments[index].pre_roll = if has_handle { half } else { 0 };
            segments[index].boundary_in =
                Some(BoundaryFade::new(boundary, len_samples, has_handle));
        }
    }
}

/// The boundary crossfade length a transition asks for, before the half-section clamp
/// (`specs/03-audio-engine.md` §5.5).
fn transition_len_samples(
    tempo: &TempoCtx<'_>,
    sample_rate: u32,
    span: &bragi_model::SectionSpan,
    transition: &Transition,
) -> u64 {
    match transition.kind {
        TransitionKind::Cut => (BOUNDARY_FADE_MS * sample_rate as f32 / 1000.0).round() as u64,
        TransitionKind::Crossfade | TransitionKind::Generated => {
            duration_samples(tempo, sample_rate, span.start_tick, transition.length_ticks)
        }
    }
}

/// The gain of a generated transition overlay at absolute output sample `dst`
/// (`specs/03-audio-engine.md` §5.5).
///
/// Zero outside `[center − L/2, center + L/2]`, an equal-power ramp over the first and last
/// quarter, and unity over the middle half — the same envelope the overlay segment's own fades
/// produce. Exposed so the tests and the spec's law can be checked sample by sample.
///
/// # Examples
///
/// ```
/// use bragi_engine::plan::overlay_gain;
/// assert_eq!(overlay_gain(1_000, 400, 800), 0.0);
/// assert_eq!(overlay_gain(1_000, 400, 1_000), 1.0);
/// assert!((overlay_gain(1_000, 400, 850) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
/// ```
#[must_use]
pub fn overlay_gain(center: u64, len_samples: u64, dst: u64) -> f32 {
    let half = len_samples / 2;
    let span = 2 * half;
    if span == 0 {
        return 0.0;
    }
    let start = center.saturating_sub(half);
    if dst < start || dst >= start.saturating_add(span) {
        return 0.0;
    }
    let x = (dst - start) as f32 / span as f32;
    let quarter = 0.25;
    if x < quarter {
        curve_gain(FadeShape::EqualPower, x / quarter)
    } else if x > 1.0 - quarter {
        curve_gain(FadeShape::EqualPower, (1.0 - x) / quarter)
    } else {
        1.0
    }
}

/// Compiles the generated transition overlays of `specs/03-audio-engine.md` §5.5.
///
/// A section whose `transitionIn` is `generated` with an asset plays that asset centred on its
/// boundary for the transition's length, over the normal boundary crossfade. The asset is fitted
/// to the window linearly, so its first and last quarter fade away exactly as the crossfade under
/// it runs; a tempo drift between the candidate and the grid (09 §6 conforms it to ≤ 4 %) shows up
/// as a sub-percent ratio. A generated transition without an asset, or whose asset is not in the
/// index, keeps the crossfade placeholder and warns.
fn compile_overlays(
    doc: &Project,
    assets: &AssetIndex,
    tempo: &TempoCtx<'_>,
    spans: &[bragi_model::SectionSpan],
    sections: &[SectionSpanSamples],
    sample_rate: u32,
    warnings: &mut Vec<String>,
) -> Vec<Segment> {
    let mut overlays = Vec::new();
    for index in 1..sections.len() {
        let Some((section, span)) = doc.arrangement.sections.get(index).zip(spans.get(index))
        else {
            continue;
        };
        let transition = &section.transition_in;
        if transition.kind != TransitionKind::Generated {
            continue;
        }
        let Some(asset) = &transition.asset else {
            continue;
        };
        let Some(meta) = assets.get(asset) else {
            warnings.push(format!(
                "section {}: transition asset {} is not in the index",
                section.id, asset
            ));
            continue;
        };
        // Never reach past half of either neighbouring section, like the crossfade (03 §5.5).
        let previous = &sections[index - 1];
        let current = &sections[index];
        let len_samples = transition_len_samples(tempo, sample_rate, span, transition)
            .min((previous.end - previous.start) / 2)
            .min((current.end - current.start) / 2);
        let half = len_samples / 2;
        let span_samples = 2 * half;
        if span_samples == 0 || meta.duration_samples == 0 {
            continue;
        }
        let center = current.start;
        let dst_start = center.saturating_sub(half);
        let dst_end = dst_start.saturating_add(span_samples);
        let quarter = (span_samples / 4).max(1);
        let shape = FadeShape::EqualPower;
        let Some(clip_id) = derived_id("clp_", section.id.as_str(), "transition")
            .parse::<ClipId>()
            .ok()
        else {
            warnings.push(format!(
                "section {}: cannot derive the transition clip id",
                section.id
            ));
            continue;
        };
        let src_rate = u32::try_from(meta.sample_rate.get()).unwrap_or(SAMPLE_RATE);
        overlays.push(Segment {
            clip_id,
            asset: asset.clone(),
            dst_start,
            dst_end,
            clip_start: dst_start,
            clip_end: dst_end,
            section: index,
            src_start: 0,
            src_end: meta.duration_samples,
            src_map: SrcMap::linear(span_samples, 0, meta.duration_samples),
            ratio: segment_ratio(span_samples, meta.duration_samples, src_rate, sample_rate),
            pitch_semitones: 0.0,
            gain: 1.0,
            fade_in: Fade::new(quarter, shape),
            fade_out: Fade::new(quarter, shape),
            reverse: false,
            channels: u16::try_from(meta.channels.get()).unwrap_or(2).clamp(1, 2),
            src_rate,
            asset_frames: meta.duration_samples,
            pre_roll: 0,
            post_roll: 0,
            boundary_in: None,
            boundary_out: None,
        });
    }
    overlays
}

/// Whether two segments are the same material at a boundary: same asset and a
/// source position within one source sample.
fn contiguous(outgoing: &Segment, incoming: &Segment) -> bool {
    if outgoing.asset != incoming.asset {
        return false;
    }
    let length = (outgoing.dst_end - outgoing.dst_start) as i64;
    let at_boundary = outgoing.source_position(length);
    let at_start = incoming.source_position(0);
    at_boundary.is_finite() && at_start.is_finite() && (at_boundary - at_start).abs() <= 1.0
}

/// Whether `segment` has source material to keep playing for `extra` output
/// samples after its window.
fn handle_after(segment: &Segment, extra: u64) -> bool {
    if extra == 0 {
        return false;
    }
    let length = (segment.dst_end - segment.dst_start) as i64;
    let from = segment.source_position(length);
    let to = segment.source_position(length + extra as i64);
    handle_is_inside(from, to, segment.asset_frames)
}

/// Whether `segment` has source material to start `extra` output samples before
/// its window.
fn handle_before(segment: &Segment, extra: u64) -> bool {
    if extra == 0 {
        return false;
    }
    let from = segment.source_position(0);
    let to = segment.source_position(-(extra as i64));
    handle_is_inside(from, to, segment.asset_frames)
}

/// Whether every source sample between `from` and `to` exists in an asset of
/// `frames` frames. A segment's map is monotone, so checking the endpoints
/// covers the whole extension, forward or reversed.
fn handle_is_inside(from: f64, to: f64, frames: u64) -> bool {
    if !from.is_finite() || !to.is_finite() || frames == 0 {
        return false;
    }
    let last = frames.saturating_sub(1) as f64;
    if from < 0.0 || from > frames as f64 {
        return false;
    }
    if to >= from { to <= last } else { to >= 0.0 }
}

/// Compiles a document chain into indexed slots.
///
/// Names are resolved here (never on the audio thread). A kind that `create`
/// cannot build yet bypasses at runtime; it is reported once per plan so a
/// partly landed catalogue is audible rather than fatal.
fn compile_fx_chain(
    chain: &[FxInstance],
    doc: &Project,
    sample_rate: u32,
    scope: &str,
    warnings: &mut Vec<String>,
    unavailable: &mut Vec<&'static str>,
) -> Vec<FxSlot> {
    let mut slots = Vec::with_capacity(chain.len());
    for instance in chain {
        let Some(kind) = FxKind::from_name(&instance.type_.to_string()) else {
            warnings.push(format!(
                "{scope}: fx {} has unsupported type {}",
                instance.id, instance.type_
            ));
            continue;
        };
        let latency = match create(kind, sample_rate, crate::QUANTUM_FRAMES) {
            Ok(effect) => effect.latency(),
            Err(_) => {
                if !unavailable.contains(&kind.name()) {
                    unavailable.push(kind.name());
                    warnings.push(format!(
                        "{scope}: fx type {} is not implemented yet; its instances are bypassed",
                        kind.name()
                    ));
                }
                0
            }
        };

        let mut params = Vec::with_capacity(instance.params.len());
        for (name, value) in instance.params.iter() {
            match kind.param_index(name) {
                Some(index) => params.push((index, *value as f32)),
                None => warnings.push(format!(
                    "{scope}: fx {} has no parameter named {name}; dropped",
                    instance.id
                )),
            }
        }

        // `sidechainSource` is a routing field outside `params` (02 §3.7). The
        // validator rejects a missing or self-referencing track; resolving it
        // here keeps the audio thread free of IDs.
        let sidechain_source = instance
            .sidechain_source
            .as_ref()
            .and_then(|id| doc.tracks.iter().position(|track| &track.id == id));
        let mut bypass = instance.bypass;
        if kind == FxKind::SidechainDuck
            && instance.sidechain_source.is_some()
            && sidechain_source.is_none()
        {
            warnings.push(format!(
                "{scope}: fx {} sidechain_duck source is not a track; bypassed",
                instance.id
            ));
            bypass = true;
        }

        slots.push(FxSlot {
            id: instance.id.clone(),
            kind,
            params,
            bypass,
            sidechain_source,
            latency,
        });
    }
    slots
}

/// The chain latency of compiled slots: the sum of every non-bypassed effect's
/// algorithmic latency. A bypassed slot contributes none.
fn chain_latency(slots: &[FxSlot]) -> usize {
    slots
        .iter()
        .filter(|slot| !slot.bypass)
        .map(|slot| slot.latency)
        .sum()
}

#[allow(clippy::too_many_arguments)]
fn compile_clip(
    clip: &Clip,
    section_index: usize,
    section_start_tick: i64,
    section_end_tick: i64,
    assets: &AssetIndex,
    tempo: &TempoCtx<'_>,
    sample_rate: u32,
    length_samples: u64,
    out: &mut Vec<Segment>,
    warnings: &mut Vec<String>,
) -> Result<(), PlanError> {
    // Clip-level fx (02 §3.6) are out of scope for WP-2.3 and not compiled.
    if clip.fx.as_ref().is_some_and(|fx| !fx.is_empty()) {
        warnings.push(format!(
            "clip {}: clip-level fx are not supported by the engine yet; ignored",
            clip.id
        ));
    }
    let Some(meta) = assets.get(&clip.asset) else {
        warnings.push(format!(
            "clip {}: asset {} is not in the index",
            clip.id, clip.asset
        ));
        return Err(PlanError::MissingAsset(clip.asset.to_string()));
    };
    let src_rate = u32::try_from(meta.sample_rate.get()).unwrap_or(SAMPLE_RATE);
    let channels = u16::try_from(meta.channels.get()).unwrap_or(2).clamp(1, 2);
    let src_end = clip
        .src_end
        .min(meta.duration_samples)
        .max(clip.src_start.saturating_add(1));
    if src_end <= clip.src_start {
        warnings.push(format!("clip {}: empty source window", clip.id));
        return Ok(());
    }

    let abs_start_tick = section_start_tick.saturating_add(clip.start);
    let Some(end_local) = clip_end_local(clip, tempo, assets, section_start_tick) else {
        warnings.push(format!("clip {}: warp does not resolve", clip.id));
        return Ok(());
    };
    let abs_end_tick = section_start_tick.saturating_add(end_local);

    let clip_start = tick_to_sample(tempo, sample_rate, abs_start_tick).max(0) as u64;
    // Content is windowed by its section: a clip may not bleed into the next
    // section's audio (the document is the arrangement, 02 §3.5).
    let clip_end = tick_to_sample(tempo, sample_rate, abs_end_tick)
        .max(0)
        .min(tick_to_sample(tempo, sample_rate, section_end_tick).max(0))
        .min(length_samples as i64)
        .max(0) as u64;
    if clip_end <= clip_start {
        warnings.push(format!("clip {}: outside its section", clip.id));
        return Ok(());
    }

    let shape = FadeShape::from(clip.fade_curve);
    let fade_in = Fade::new(
        duration_samples(tempo, sample_rate, abs_start_tick, clip.fade_in_ticks),
        shape,
    );
    let fade_out = Fade::new(
        duration_samples(
            tempo,
            sample_rate,
            abs_end_tick.saturating_sub(clip.fade_out_ticks as i64),
            clip.fade_out_ticks,
        ),
        shape,
    );
    let gain = db_to_gain(clip.gain_db);
    let pitch = clip.pitch_semitones as f32;
    let reverse = clip.reverse.unwrap_or(false);
    if reverse && (pitch.abs() > f32::EPSILON || !matches!(&clip.warp, Warp::None(_))) {
        warnings.push(format!(
            "clip {}: reverse with stretch/pitch is rendered as varispeed",
            clip.id
        ));
    }

    let base = Segment {
        clip_id: clip.id.clone(),
        asset: clip.asset.clone(),
        dst_start: clip_start,
        dst_end: clip_end,
        clip_start,
        clip_end,
        section: section_index,
        src_start: clip.src_start,
        src_end,
        src_map: SrcMap::constant(clip.src_start as f64),
        ratio: 1.0,
        pitch_semitones: pitch,
        gain,
        fade_in,
        fade_out,
        reverse,
        channels,
        src_rate,
        asset_frames: meta.duration_samples,
        pre_roll: 0,
        post_roll: 0,
        boundary_in: None,
        boundary_out: None,
    };

    match &clip.warp {
        Warp::None(_) => {
            let mut segment = base;
            segment.src_map = SrcMap::linear(clip_end - clip_start, clip.src_start, src_end);
            segment.ratio = segment_ratio(
                clip_end - clip_start,
                src_end - clip.src_start,
                src_rate,
                sample_rate,
            );
            out.push(segment);
        }
        Warp::Stretch(stretch) => {
            let mut segment = base;
            let ratio = if stretch.ratio.is_finite() && stretch.ratio > 0.0 {
                stretch.ratio
            } else {
                1.0
            };
            segment.ratio = ratio;
            segment.src_map = SrcMap::linear(clip_end - clip_start, clip.src_start, src_end);
            out.push(segment);
        }
        Warp::Beatgrid(beatgrid) => {
            let pieces = beatgrid_pieces(
                &beatgrid.anchors,
                clip.src_start,
                src_end,
                section_start_tick,
                tempo,
                sample_rate,
                src_rate,
            );
            if pieces.is_empty() {
                warnings.push(format!("clip {}: beatgrid has no usable anchors", clip.id));
                return Ok(());
            }
            for piece in pieces {
                if piece.dst_start >= clip_end || piece.dst_end <= clip_start {
                    continue;
                }
                out.push(Segment {
                    dst_start: piece.dst_start.max(clip_start),
                    dst_end: piece.dst_end.min(clip_end),
                    src_start: piece.src_start,
                    src_end: piece.src_end,
                    src_map: SrcMap::linear(
                        piece.dst_end - piece.dst_start,
                        piece.src_start,
                        piece.src_end,
                    ),
                    ratio: piece.ratio,
                    ..base.clone()
                });
            }
            out.retain(|segment| segment.dst_end > segment.dst_start);
        }
    }
    Ok(())
}

/// One constant-ratio piece of a beatgrid clip.
#[derive(Clone, Copy, Debug)]
struct Piece {
    dst_start: u64,
    dst_end: u64,
    src_start: u64,
    src_end: u64,
    ratio: f64,
}

/// Splits a beatgrid clip into constant-ratio pieces and coalesces equal rates.
fn beatgrid_pieces(
    anchors: &[bragi_model::generated::WarpAnchor],
    src_start: u64,
    src_end: u64,
    section_start_tick: i64,
    tempo: &TempoCtx<'_>,
    sample_rate: u32,
    src_rate: u32,
) -> Vec<Piece> {
    let mut points: Vec<(u64, u64)> = anchors
        .iter()
        .filter(|anchor| anchor.src_sample <= src_end)
        .map(|anchor| {
            (
                anchor.src_sample,
                tick_to_sample(
                    tempo,
                    sample_rate,
                    section_start_tick.saturating_add(anchor.tick),
                )
                .max(0) as u64,
            )
        })
        .collect();
    if points.len() < 2 {
        return Vec::new();
    }
    // Interpolate the window edges from the anchors (extrapolating the outer
    // slopes), mirroring `bragi_model::clipmath`'s tick math in samples.
    let start_dst = sample_at_source(&points, src_start);
    let end_dst = sample_at_source(&points, src_end);
    points.retain(|(src, _)| *src > src_start && *src < src_end);
    points.push((src_start, start_dst));
    points.push((src_end, end_dst));
    points.sort_by_key(|(src, _)| *src);
    points.dedup_by_key(|(src, _)| *src);

    let mut pieces: Vec<Piece> = Vec::with_capacity(points.len().saturating_sub(1));
    for pair in points.windows(2) {
        let (src_a, dst_a) = pair[0];
        let (src_b, dst_b) = pair[1];
        if src_b <= src_a || dst_b <= dst_a {
            continue;
        }
        let ratio = segment_ratio(dst_b - dst_a, src_b - src_a, src_rate, sample_rate);
        if let Some(last) = pieces.last_mut()
            && (last.ratio - ratio).abs() <= RATIO_EPSILON
            && last.dst_end == dst_a
        {
            last.dst_end = dst_b;
            last.src_end = src_b;
            last.ratio = ratio;
            continue;
        }
        pieces.push(Piece {
            dst_start: dst_a,
            dst_end: dst_b,
            src_start: src_a,
            src_end: src_b,
            ratio,
        });
    }
    pieces
}

/// The destination sample at which source sample `src` plays, given anchor
/// pairs sorted by source sample. Extrapolates with the outer slopes.
fn sample_at_source(points: &[(u64, u64)], src: u64) -> u64 {
    let Some(first) = points.first() else {
        return 0;
    };
    let Some(last) = points.last() else {
        return 0;
    };
    if src <= first.0 {
        let slope = if points.len() >= 2 && points[1].0 > first.0 {
            (points[1].1 as f64 - first.1 as f64) / (points[1].0 - first.0) as f64
        } else {
            1.0
        };
        return (first.1 as f64 + slope * (src as f64 - first.0 as f64)).max(0.0) as u64;
    }
    for pair in points.windows(2) {
        let (src_a, dst_a) = pair[0];
        let (src_b, dst_b) = pair[1];
        if src <= src_b && src_b > src_a {
            let slope = (dst_b as f64 - dst_a as f64) / (src_b - src_a) as f64;
            return (dst_a as f64 + slope * (src as f64 - src_a as f64)).max(0.0) as u64;
        }
    }
    let (src_a, dst_a) = points[points.len() - 2];
    let (src_b, dst_b) = *last;
    let slope = if src_b > src_a {
        (dst_b as f64 - dst_a as f64) / (src_b - src_a) as f64
    } else {
        1.0
    };
    (dst_b as f64 + slope * (src as f64 - src_b as f64)).max(0.0) as u64
}

fn segment_ratio(dst_frames: u64, src_frames: u64, src_rate: u32, out_rate: u32) -> f64 {
    if src_frames == 0 {
        return 1.0;
    }
    let out_seconds = dst_frames as f64 / out_rate as f64;
    let src_seconds = src_frames as f64 / src_rate as f64;
    if src_seconds <= 0.0 {
        1.0
    } else {
        out_seconds / src_seconds
    }
}

fn track_automation(
    track: &Track,
    doc: &Project,
    tempo: &TempoCtx<'_>,
    spans: &[bragi_model::SectionSpan],
    sample_rate: u32,
) -> Vec<AutomationLane> {
    let mut lanes = Vec::new();
    for (section, span) in doc.arrangement.sections.iter().zip(spans) {
        let Some(lane) = section.lanes.get(&track.id) else {
            continue;
        };
        for automation in lane.automation.iter() {
            let target = if automation.target.ends_with("/gainDb") {
                parse_track_target(&automation.target, &track.id)
            } else {
                parse_fx_target(&automation.target)
                    .and_then(|(fx_id, param)| fx_target(&track.fx, fx_id, param))
            };
            let Some(target) = target else {
                continue;
            };
            lanes.push(AutomationLane {
                target,
                points: automation
                    .points
                    .iter()
                    .map(|point| AutoPoint {
                        sample: tick_to_sample(
                            tempo,
                            sample_rate,
                            span.start_tick.saturating_add(point.tick),
                        )
                        .max(0) as u64,
                        value: point.value,
                        curve: point.curve,
                    })
                    .collect(),
            });
        }
    }
    lanes
}

fn parse_track_target(target: &str, track: &TrackId) -> Option<AutomationTarget> {
    let rest = target.strip_prefix("track:")?;
    let (id, param) = rest.split_once('/')?;
    (param == "gainDb" && id == track.as_str()).then_some(AutomationTarget::TrackGain)
}

/// Splits `fx:<fxId>/<param>` (02 §3.8).
fn parse_fx_target(target: &str) -> Option<(&str, &str)> {
    let rest = target.strip_prefix("fx:")?;
    rest.split_once('/')
}

/// Resolves an fx target against a document chain to its compiled slot.
fn fx_target(chain: &[FxInstance], fx_id: &str, param: &str) -> Option<AutomationTarget> {
    let (slot, instance) = chain
        .iter()
        .enumerate()
        .find(|(_, instance)| instance.id.as_str() == fx_id)?;
    let kind = FxKind::from_name(&instance.type_.to_string())?;
    let index = kind.param_index(param)?;
    Some(AutomationTarget::FxParam { slot, index })
}

fn master_automation(doc: &Project, tempo: &TempoCtx<'_>, sample_rate: u32) -> Vec<AutomationLane> {
    let mut lanes = Vec::new();
    for automation in doc.arrangement.master.automation.iter() {
        let target = if automation.target.as_str() == "master/gainDb" {
            Some(AutomationTarget::MasterGain)
        } else {
            parse_fx_target(&automation.target)
                .and_then(|(fx_id, param)| fx_target(&doc.arrangement.master.fx, fx_id, param))
        };
        let Some(target) = target else {
            continue;
        };
        lanes.push(AutomationLane {
            target,
            points: automation
                .points
                .iter()
                .map(|point| AutoPoint {
                    sample: tick_to_sample(tempo, sample_rate, point.tick).max(0) as u64,
                    value: point.value,
                    curve: point.curve,
                })
                .collect(),
        });
    }
    lanes
}

/// Converts an absolute tick to an output sample, rounding to nearest.
#[must_use]
pub fn tick_to_sample(tempo: &TempoCtx<'_>, sample_rate: u32, tick: i64) -> i64 {
    let seconds = tempo.ticks_to_seconds(tick);
    if !seconds.is_finite() {
        return 0;
    }
    (seconds * sample_rate as f64).round() as i64
}

/// The number of output samples in `ticks`, starting at `from_tick`.
#[must_use]
pub fn duration_samples(tempo: &TempoCtx<'_>, sample_rate: u32, from_tick: i64, ticks: u64) -> u64 {
    if ticks == 0 {
        return 0;
    }
    let start = tempo.ticks_to_seconds(from_tick);
    let end = tempo.ticks_to_seconds(from_tick.saturating_add(ticks as i64));
    ((end - start).max(0.0) * sample_rate as f64).round() as u64
}

/// Converts decibels to a linear gain. `-inf` and NaN map to silence.
#[must_use]
pub fn db_to_gain(db: f64) -> f32 {
    if !db.is_finite() {
        return if db == f64::NEG_INFINITY { 0.0 } else { 1.0 };
    }
    10.0_f64.powf(db / 20.0) as f32
}

/// The stretch quality tier a plan should be rendered at.
#[must_use]
pub fn quality_for(offline: bool) -> Quality {
    if offline {
        Quality::Render
    } else {
        Quality::Preview
    }
}
