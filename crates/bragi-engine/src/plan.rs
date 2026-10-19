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
    Track, TrackId, Warp,
};
use bragi_model::{AssetIndex, TempoCtx, clip_end_local, section_spans};

use crate::error::PlanError;
use crate::fade::{Fade, FadeShape};
use crate::srcmap::SrcMap;
use crate::{RATIO_EPSILON, SAMPLE_RATE};

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
    /// Index of the source track for `sidechain_duck`.
    ///
    /// `None` because the document schema's `FxParams` is numeric-only and
    /// cannot carry the `TrackId` that 03 §6 calls for; see the spec gap in
    /// `docs/wp/2.3.md`. A duck without a source is bypassed.
    pub sidechain_source: Option<usize>,
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
}

impl Segment {
    /// Whether this segment needs the phase vocoder.
    #[must_use]
    pub fn needs_stretcher(&self) -> bool {
        self.pitch_semitones.abs() > f32::EPSILON
            || (self.ratio - 1.0).abs() > RATIO_EPSILON
            || self.src_rate != SAMPLE_RATE
    }

    /// Frames this segment contributes to an output block starting at
    /// `block_start` of length `block_frames`, as `(offset, frames)` in output
    /// samples, or `None` when it is silent in that block.
    #[must_use]
    pub fn overlap(&self, block_start: u64, block_frames: usize) -> Option<(usize, usize)> {
        let block_end = block_start.saturating_add(block_frames as u64);
        let start = self.dst_start.max(block_start);
        let end = self.dst_end.min(block_end);
        if end <= start {
            None
        } else {
            Some(((start - block_start) as usize, (end - start) as usize))
        }
    }

    /// The combined fade gain at absolute output sample `dst`.
    #[must_use]
    pub fn fade_gain(&self, dst: u64) -> f32 {
        let from_in = dst.saturating_sub(self.clip_start);
        let to_out = self.clip_end.saturating_sub(dst);
        self.fade_in.gain_in(from_in) * self.fade_out.gain_out(to_out)
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
    compile_with(doc, assets, sample_rate, plan_version, &HashMap::new())
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

    compile_with(doc, assets, prev.sample_rate, prev.plan_version + 1, &keep)
}

fn compile_with(
    doc: &Project,
    assets: &AssetIndex,
    sample_rate: u32,
    plan_version: u64,
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
            sample_rate,
            length_samples,
            &mut warnings,
            &mut unavailable,
        )?);
    }

    let master_fx = compile_fx_chain(
        &doc.arrangement.master.fx,
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
    })
}

#[allow(clippy::too_many_arguments)]
fn compile_track(
    track: &Track,
    doc: &Project,
    assets: &AssetIndex,
    tempo: &TempoCtx<'_>,
    spans: &[bragi_model::SectionSpan],
    sample_rate: u32,
    length_samples: u64,
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
            sample_rate,
            &format!("track {}", track.id),
            warnings,
            unavailable,
        ),
    })
}

/// Compiles a document chain into indexed slots.
///
/// Names are resolved here (never on the audio thread). A kind that `create`
/// cannot build yet bypasses at runtime; it is reported once per plan so a
/// partly landed catalogue is audible rather than fatal.
fn compile_fx_chain(
    chain: &[FxInstance],
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
        if create(kind, sample_rate, crate::QUANTUM_FRAMES).is_err()
            && !unavailable.contains(&kind.name())
        {
            unavailable.push(kind.name());
            warnings.push(format!(
                "{scope}: fx type {} is not implemented yet; its instances are bypassed",
                kind.name()
            ));
        }

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

        // `sidechain_duck.sourceTrack` is a TrackId in 03 §6, but the schema's
        // `FxParams` is numeric-only (`specs/02-song-model.md` §3.7), so there is
        // nowhere to store it. A duck without a source is bypassed (the gap is
        // recorded in `docs/wp/2.3.md`).
        let mut bypass = instance.bypass;
        if kind == FxKind::SidechainDuck {
            bypass = true;
            warnings.push(format!(
                "{scope}: fx {} is sidechain_duck, but sourceTrack cannot be stored in FxParams; bypassed",
                instance.id
            ));
        }

        slots.push(FxSlot {
            id: instance.id.clone(),
            kind,
            params,
            bypass,
            sidechain_source: None,
        });
    }
    slots
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
