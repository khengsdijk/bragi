//! The mixer: plan + transport + PCM → interleaved stereo.
//!
//! Everything here runs on the audio thread. [`Renderer::process`] enters the
//! allocator guard, uses only scratch buffers allocated by [`Renderer::new`],
//! never locks, never does I/O and never panics on a valid plan. Missing PCM is
//! silence plus an underrun counter — the documented behaviour of
//! `specs/03-audio-engine.md` §3.1.
//!
//! ```
//! use std::sync::Arc;
//! use bragi_engine::render::Renderer;
//! use bragi_engine::pcm::MemoryPcm;
//! # fn plan() -> bragi_engine::plan::RenderPlan {
//! #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
//! #     "schemaVersion": 1, "id": "prj_01",
//! #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
//! #     "sources": [], "analyses": {}, "tracks": [],
//! #     "arrangement": { "timebase": { "ppq": 960,
//! #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
//! #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
//! #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
//! # }
//! let mut renderer = Renderer::new(Arc::new(plan()), 128);
//! renderer.transport_mut().set_length(128);
//! renderer.transport_mut().play();
//! let pcm = MemoryPcm::new();
//! let mut left = [0.0f32; 128];
//! let mut right = [0.0f32; 128];
//! let stats = renderer.process(&pcm, &mut [&mut left, &mut right]);
//! assert_eq!(stats.frames, 128);
//! ```

use std::collections::VecDeque;
use std::sync::Arc;

use bragi_dsp::fx::{Effect, FxContext, FxKind, create};
use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
use bragi_model::generated::AutomationCurve;

use crate::AUDITION_FADE_MS;
use crate::LOOP_FADE_MS;
use crate::MAX_WARM_PLANS;
use crate::MUTE_RAMP_MS;
use crate::PARAM_RAMP_MS;
use crate::meters::Meters;
use crate::pcm::PcmSource;
use crate::plan::AutomationTarget;
use crate::plan::{
    AutomationLane, FxSlot, MAX_COMPENSATION_FRAMES, RenderPlan, Segment, TrackPlan, db_to_gain,
};
use crate::rt::alloc_guard;
use crate::transport::{BlockSchedule, Transport, TransportState};

/// The largest source-frames-per-output-frame factor a segment may have. Plans
/// above this are clamped; the scratch buffers are sized once.
const MAX_SOURCE_FACTOR: f64 = 8.0;

/// Track capacity of the shared sidechain scratch. A warm candidate may have
/// more tracks than the main plan, and warming never allocates, so the buffers
/// are pre-sized for the common upper bound. A main plan above this grows them
/// on a control-side `set_prepared`.
const MAX_MIX_TRACKS: usize = 64;

/// Counters and warnings produced by a block of rendering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RenderStats {
    /// Output frames rendered by the last [`Renderer::process`] call.
    pub frames: usize,
    /// PCM reads that found no data (a missing chunk, an evicted mmap page, …).
    pub underruns: u64,
    /// Blocks rendered since the renderer was created.
    pub blocks: u64,
}

/// A plan plus the mutable per-segment stream state a renderer needs.
///
/// `PreparedPlan` is built on the planner side (allocation allowed) and can be
/// swapped into a running [`Renderer`] without touching the audio thread.
pub struct PreparedPlan {
    /// The immutable plan.
    pub plan: Arc<RenderPlan>,
    /// One runtime per segment, flattened in plan track/segment order.
    pub runtimes: Vec<SegmentRuntime>,
    /// Prefix offsets into `runtimes`, one entry per track plus the end.
    offsets: Vec<usize>,
    /// Live effect chains, parallel to `plan.tracks[i].fx`.
    fx: Vec<Vec<FxRuntime>>,
    /// The master chain, parallel to `plan.master.fx`.
    master_fx: Vec<FxRuntime>,
    /// Track indices in a sidechain-safe order (a duck's source runs first).
    order: Vec<usize>,
    /// Frames each track is delayed so every track reaches the master with the
    /// same total chain latency (`max_track_latency - own_latency`, clamped to
    /// [`MAX_COMPENSATION_FRAMES`]).
    compensation: Vec<usize>,
    /// One pre-allocated stereo delay line per track
    /// ([`MAX_COMPENSATION_FRAMES`] frames each).
    delays: Vec<DelayLine>,
    /// The largest non-bypassed track-chain latency, in frames.
    max_track_latency: usize,
    /// The master chain's latency, in frames.
    master_latency: usize,
    /// Stretch quality tier.
    pub quality: Quality,
}

/// A fixed-capacity stereo delay line for plugin delay compensation.
///
/// The buffer is interleaved (`[L, R, L, R, …]`) and allocated in
/// [`PreparedPlan::new`] / [`PreparedPlan::carry_delays_from`] moves it, never in
/// `process`. A change in compensation depth keeps the buffer contents; the
/// resulting jump is accepted (the alternative would be a click on every plan
/// swap that changes a chain's latency).
struct DelayLine {
    /// Interleaved stereo history at the fixed cap.
    buffer: Vec<f32>,
    /// Next write frame.
    pos: usize,
}

impl DelayLine {
    fn new(frames: usize) -> Self {
        Self {
            buffer: vec![0.0; frames.max(1) * 2],
            pos: 0,
        }
    }

    /// Delays an interleaved stereo block by `delay` frames in place.
    ///
    /// `delay == 0` is a no-op; a delay past the buffer is clamped. The read
    /// index is relative to the write cursor, so changing `delay` does not
    /// reorder the history.
    fn process(&mut self, block: &mut [f32], delay: usize) {
        let capacity = self.buffer.len() / 2;
        let delay = delay.min(capacity);
        if delay == 0 || block.len() < 2 {
            return;
        }
        for frame in block.chunks_mut(2) {
            let read = (self.pos + capacity - delay) % capacity;
            let left = self.buffer[read * 2];
            let right = self.buffer[read * 2 + 1];
            self.buffer[self.pos * 2] = frame[0];
            self.buffer[self.pos * 2 + 1] = frame.get(1).copied().unwrap_or(0.0);
            frame[0] = left;
            if let Some(sample) = frame.get_mut(1) {
                *sample = right;
            }
            self.pos = (self.pos + 1) % capacity;
        }
    }

    /// Clears the history and rewinds the cursor.
    fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.pos = 0;
    }
}

impl std::fmt::Debug for PreparedPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedPlan")
            .field("plan_version", &self.plan.plan_version)
            .field("runtimes", &self.runtimes.len())
            .field("order", &self.order)
            .finish()
    }
}

/// The live state of one compiled [`FxSlot`].
pub struct FxRuntime {
    /// The effect, or `None` when the slot is bypassed or not implemented.
    effect: Option<Box<dyn Effect>>,
    /// Whether `process` must skip this slot.
    bypassed: bool,
    /// The compiled kind (kept for matching across plan swaps and debugging).
    kind: FxKind,
}

impl std::fmt::Debug for FxRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FxRuntime")
            .field("kind", &self.kind.name())
            .field("bypassed", &self.bypassed)
            .field("has_effect", &self.effect.is_some())
            .finish()
    }
}

/// Mutable stream state for one segment. Allocation happens in
/// [`PreparedPlan::new`]; `process` only reads and writes these fields.
#[derive(Default)]
pub struct SegmentRuntime {
    /// The vocoder, when the segment needs one.
    pub stretcher: Option<Box<PhaseVocoder>>,
    /// The next absolute source frame to feed the vocoder.
    pub feed_cursor: u64,
    /// The local destination offset the next rendered block must start at for
    /// the stream state to be continuous. Signed, because a section-boundary
    /// pre-roll starts before the segment's `dst_start`.
    pub next_offset: i64,
    /// Whether the vocoder has been primed for this activation.
    pub primed: bool,
}

impl std::fmt::Debug for SegmentRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SegmentRuntime")
            .field("has_stretcher", &self.stretcher.is_some())
            .field("feed_cursor", &self.feed_cursor)
            .field("next_offset", &self.next_offset)
            .field("primed", &self.primed)
            .finish()
    }
}

impl PreparedPlan {
    /// Prepares `plan` for rendering at the given stretch quality, building the
    /// live effect chains for blocks of at most `block_size`.
    ///
    /// All of this allocates, so it runs on the planner/control side, never on
    /// the audio thread. A kind [`create`] cannot build is bypassed, and a
    /// `sidechain_duck` whose source would form a cycle is bypassed too.
    ///
    /// # Examples
    ///
    /// ```
    /// use std::sync::Arc;
    /// use bragi_engine::plan::quality_for;
    /// use bragi_engine::render::PreparedPlan;
    /// # fn plan() -> bragi_engine::plan::RenderPlan {
    /// #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
    /// #     "schemaVersion": 1, "id": "prj_01",
    /// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
    /// #     "sources": [], "analyses": {}, "tracks": [],
    /// #     "arrangement": { "timebase": { "ppq": 960,
    /// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
    /// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
    /// #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
    /// # }
    /// let prepared = PreparedPlan::new(Arc::new(plan()), quality_for(false), 128);
    /// assert!(prepared.runtimes().is_empty());
    /// ```
    #[must_use]
    pub fn new(plan: Arc<RenderPlan>, quality: Quality, block_size: usize) -> Self {
        let block_size = block_size.max(1);
        let mut offsets = Vec::with_capacity(plan.tracks.len() + 1);
        let mut runtimes = Vec::with_capacity(plan.segment_count());
        offsets.push(0);
        for track in &plan.tracks {
            for segment in &track.segments {
                runtimes.push(runtime_for(segment, quality, plan.sample_rate));
            }
            offsets.push(runtimes.len());
        }
        let mut fx: Vec<Vec<FxRuntime>> = plan
            .tracks
            .iter()
            .map(|track| {
                track
                    .fx
                    .iter()
                    .map(|slot| build_slot(slot, plan.sample_rate, block_size))
                    .collect()
            })
            .collect();
        let master_fx: Vec<FxRuntime> = plan
            .master
            .fx
            .iter()
            .map(|slot| build_slot(slot, plan.sample_rate, block_size))
            .collect();
        let order = processing_order(&plan, &mut fx);
        let latencies: Vec<usize> = plan
            .tracks
            .iter()
            .zip(fx.iter())
            .map(|(track, chain)| live_chain_latency(&track.fx, chain))
            .collect();
        let max_track_latency = latencies.iter().copied().max().unwrap_or(0);
        let compensation: Vec<usize> = latencies
            .iter()
            .map(|latency| {
                max_track_latency
                    .saturating_sub(*latency)
                    .min(MAX_COMPENSATION_FRAMES)
            })
            .collect();
        let delays = plan
            .tracks
            .iter()
            .map(|_| DelayLine::new(MAX_COMPENSATION_FRAMES))
            .collect();
        let master_latency = live_chain_latency(&plan.master.fx, &master_fx);
        Self {
            plan,
            runtimes,
            offsets,
            fx,
            master_fx,
            order,
            compensation,
            delays,
            max_track_latency,
            master_latency,
            quality,
        }
    }

    /// The total latency the renderer adds to the timeline, in frames:
    /// `max_track_latency + master_chain_latency`.
    ///
    /// Realtime playback does not compensate for this (it is at most a few
    /// milliseconds); the transport may use it later to shift the playhead or
    /// the metronome. Offline renders trim exactly this many leading frames
    /// (03 §9).
    ///
    /// # Examples
    ///
    /// ```
    /// # use std::sync::Arc;
    /// # use bragi_engine::plan::quality_for;
    /// # use bragi_engine::render::PreparedPlan;
    /// # fn plan() -> bragi_engine::plan::RenderPlan {
    /// #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
    /// #     "schemaVersion": 1, "id": "prj_01",
    /// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
    /// #     "sources": [], "analyses": {}, "tracks": [],
    /// #     "arrangement": { "timebase": { "ppq": 960,
    /// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
    /// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
    /// #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
    /// # }
    /// let prepared = PreparedPlan::new(Arc::new(plan()), quality_for(false), 128);
    /// assert_eq!(prepared.output_latency_frames(), 0);
    /// ```
    #[must_use]
    pub fn output_latency_frames(&self) -> usize {
        self.max_track_latency.saturating_add(self.master_latency)
    }

    /// The largest `tail()` of any live effect across all chains, in frames.
    ///
    /// Offline renders keep processing for this long after the arrangement so a
    /// reverb or delay is not cut (03 §9).
    ///
    /// # Examples
    ///
    /// ```
    /// # use std::sync::Arc;
    /// # use bragi_engine::plan::quality_for;
    /// # use bragi_engine::render::PreparedPlan;
    /// # fn plan() -> bragi_engine::plan::RenderPlan {
    /// #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
    /// #     "schemaVersion": 1, "id": "prj_01",
    /// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
    /// #     "sources": [], "analyses": {}, "tracks": [],
    /// #     "arrangement": { "timebase": { "ppq": 960,
    /// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
    /// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
    /// #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
    /// # }
    /// let prepared = PreparedPlan::new(Arc::new(plan()), quality_for(true), 512);
    /// assert_eq!(prepared.max_tail_frames(), 0);
    /// ```
    #[must_use]
    pub fn max_tail_frames(&self) -> usize {
        self.fx
            .iter()
            .flatten()
            .chain(self.master_fx.iter())
            .filter_map(|runtime| runtime.effect.as_ref())
            .map(|effect| effect.tail())
            .max()
            .unwrap_or(0)
    }

    /// Applies every slot's parameters to its live effect.
    ///
    /// New effects have already snapped to them in [`build_slot`]; a carried
    /// effect receives them as *targets*, so an `fx.update` glides (03 §4).
    fn apply_all_params(&mut self) {
        for (index, track) in self.plan.tracks.iter().enumerate() {
            let Some(chain) = self.fx.get_mut(index) else {
                continue;
            };
            apply_params(&track.fx, chain);
        }
        apply_params(&self.plan.master.fx, &mut self.master_fx);
    }

    /// Moves every surviving effect from `previous` into `self` (same
    /// [`FxId`](bragi_model::generated::FxId) and kind), so an `fx.update`
    /// neither resets audio state nor clicks.
    fn carry_fx_from(&mut self, previous: &mut PreparedPlan) {
        for (index, track) in self.plan.tracks.iter().enumerate() {
            let Some(old_index) = previous
                .plan
                .tracks
                .iter()
                .position(|old| old.id == track.id)
            else {
                continue;
            };
            let (Some(old_track), Some(old_chain), Some(chain)) = (
                previous.plan.tracks.get(old_index),
                previous.fx.get_mut(old_index),
                self.fx.get_mut(index),
            ) else {
                continue;
            };
            carry_chain(&track.fx, chain, &old_track.fx, old_chain);
        }
        carry_chain(
            &self.plan.master.fx,
            &mut self.master_fx,
            &previous.plan.master.fx,
            &mut previous.master_fx,
        );
    }

    /// Moves a surviving track's compensation delay line from `previous`
    /// (matched by [`TrackId`](bragi_model::generated::TrackId)), so a plan
    /// swap that leaves a track in place does not discard its buffered audio.
    /// If the compensation amount changes the content is kept as-is; the jump
    /// at the new depth is accepted.
    fn carry_delays_from(&mut self, previous: &mut PreparedPlan) {
        for (index, track) in self.plan.tracks.iter().enumerate() {
            let Some(old_index) = previous
                .plan
                .tracks
                .iter()
                .position(|old| old.id == track.id)
            else {
                continue;
            };
            if let (Some(delay), Some(old)) = (
                self.delays.get_mut(index),
                previous.delays.get_mut(old_index),
            ) {
                std::mem::swap(delay, old);
            }
        }
    }

    /// The track processing order (a duck's source track first).
    #[must_use]
    pub fn order(&self) -> &[usize] {
        &self.order
    }

    /// Every segment runtime, in plan order.
    #[must_use]
    pub fn runtimes(&self) -> &[SegmentRuntime] {
        &self.runtimes
    }

    /// The runtimes belonging to the track at `index`.
    #[must_use]
    pub fn track_runtimes(&self, index: usize) -> &[SegmentRuntime] {
        let start = self.offsets.get(index).copied().unwrap_or(0);
        let end = self.offsets.get(index + 1).copied().unwrap_or(start);
        self.runtimes.get(start..end).unwrap_or(&[])
    }

    /// Drops the stream state of every segment and clears every effect (used
    /// after a seek or for a freshly built plan).
    pub fn reset(&mut self) {
        for runtime in &mut self.runtimes {
            runtime.primed = false;
            runtime.next_offset = 0;
            if let Some(stretcher) = runtime.stretcher.as_mut() {
                stretcher.reset();
            }
        }
        for chain in &mut self.fx {
            for runtime in chain {
                if let Some(effect) = runtime.effect.as_mut() {
                    effect.reset();
                }
            }
        }
        for runtime in &mut self.master_fx {
            if let Some(effect) = runtime.effect.as_mut() {
                effect.reset();
            }
        }
        for delay in &mut self.delays {
            delay.reset();
        }
    }
}

/// A prepared plan plus the mutable mix state one renderer needs to play it.
///
/// A slot is built off the audio thread by [`PreparedPlan::into_slot`], so
/// installing or warming one is a move: no vector of [`TrackRuntime`]s is
/// allocated in `process`. Slot 0 is the main (HEAD) plan; slots 1–3 are
/// candidates (`specs/03-audio-engine.md` §5.4).
pub struct PreparedSlot {
    prepared: PreparedPlan,
    tracks: Vec<TrackRuntime>,
    master_gain: Ramp,
    limiter: Limiter,
}

impl std::fmt::Debug for PreparedSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedSlot")
            .field("plan_version", &self.prepared.plan.plan_version)
            .field("tracks", &self.tracks.len())
            .finish()
    }
}

impl PreparedPlan {
    /// Builds the per-plan mix state a warm slot needs, off the audio thread.
    ///
    /// The renderer keeps up to [`MAX_WARM_PLANS`] of these: slot 0 is the main
    /// plan, slots 1–3 are candidates. Warming is the only allocation; switching
    /// between slots only moves state.
    ///
    /// # Examples
    ///
    /// ```
    /// use std::sync::Arc;
    /// use bragi_engine::plan::quality_for;
    /// use bragi_engine::render::PreparedPlan;
    /// # fn plan() -> bragi_engine::plan::RenderPlan {
    /// #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
    /// #     "schemaVersion": 1, "id": "prj_01",
    /// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
    /// #     "sources": [], "analyses": {}, "tracks": [],
    /// #     "arrangement": { "timebase": { "ppq": 960,
    /// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
    /// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
    /// #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
    /// # }
    /// let slot = PreparedPlan::new(Arc::new(plan()), quality_for(false), 128).into_slot();
    /// assert_eq!(slot.plan().plan_version, 1);
    /// ```
    #[must_use]
    pub fn into_slot(self) -> PreparedSlot {
        let sample_rate = self.plan.sample_rate;
        let any_solo = self.plan.any_solo();
        let mute_frames = ramp_frames(MUTE_RAMP_MS, sample_rate);
        let param_frames = ramp_frames(PARAM_RAMP_MS, sample_rate);
        let tracks = self
            .plan
            .tracks
            .iter()
            .map(|track| TrackRuntime::new(track, any_solo, mute_frames, param_frames))
            .collect();
        let master_gain = Ramp::new(self.plan.master.gain, param_frames);
        let limiter = Limiter::new(self.plan.master.ceiling, sample_rate);
        PreparedSlot {
            prepared: self,
            tracks,
            master_gain,
            limiter,
        }
    }
}

impl PreparedSlot {
    /// This slot's immutable plan.
    #[must_use]
    pub fn plan(&self) -> &RenderPlan {
        &self.prepared.plan
    }

    /// Drops all stream state (seek semantics) without touching the plan.
    fn reset(&mut self) {
        self.prepared.reset();
    }

    /// Moves surviving effects, delay lines and current ramp values from
    /// `previous` into a freshly installed main plan, so a plan swap glides
    /// instead of clicking (`specs/03-audio-engine.md` §4).
    fn carry_from(&mut self, previous: &mut PreparedSlot) {
        self.prepared.reset();
        self.prepared.carry_fx_from(&mut previous.prepared);
        self.prepared.carry_delays_from(&mut previous.prepared);
        self.prepared.apply_all_params();
        for runtime in &mut self.tracks {
            if let Some(old) = previous.tracks.iter().find(|old| old.id == runtime.id) {
                runtime.gain.snap(old.gain.value());
                runtime.pan.snap(old.pan.value());
                runtime.audible.snap(old.audible.value());
            }
        }
    }

    /// Renders one block of this slot's full chain (tracks → master fx →
    /// master gain → safety limiter) into `dst`, interleaved stereo.
    ///
    /// The transport has already advanced; `schedule` is shared by every slot
    /// audible in this block, so two plans stay at the same playhead.
    #[allow(clippy::too_many_arguments)]
    fn render_block(
        &mut self,
        scratch: &mut Scratch,
        pcm: &dyn PcmSource,
        stats: &mut RenderStats,
        schedule: &BlockSchedule,
        start: u64,
        len: usize,
        dst: &mut [f32],
        bpm: f64,
        state: TransportState,
        end_playhead: u64,
        meters: &mut Meters,
    ) {
        for sample in dst[..len * 2].iter_mut() {
            *sample = 0.0;
        }

        {
            let mut ctx = MixContext {
                plan: &self.prepared.plan,
                runtimes: &mut self.prepared.runtimes,
                offsets: &self.prepared.offsets,
                fx: &mut self.prepared.fx,
                delays: &mut self.prepared.delays,
                compensation: &self.prepared.compensation,
                order: &self.prepared.order,
                scratch,
                pcm,
                tracks: &mut self.tracks,
                meters,
                stats,
                bpm,
            };
            if schedule.playing {
                let first = schedule.first_frames.min(len);
                let block = &mut dst[..first * 2];
                ctx.render_range(schedule.first_start, first, block);

                let mut resume_at = first;
                if let Some(wrap) = schedule.wrap {
                    let fade = wrap.frames.min(len - first);
                    if fade > 0 {
                        // `mem::take` moves the scratch buffers out so they can
                        // be passed to a method that borrows the rest of `ctx`;
                        // it does not allocate.
                        let mut outgoing = std::mem::take(&mut ctx.scratch.wrap_out);
                        let mut incoming = std::mem::take(&mut ctx.scratch.wrap_in);
                        ctx.render_range(wrap.outgoing_start, fade, &mut outgoing[..fade * 2]);
                        ctx.render_range(wrap.incoming_start, fade, &mut incoming[..fade * 2]);
                        for index in 0..fade {
                            let x = (index as f32 + 0.5) / fade as f32;
                            let fade_in = (x * std::f32::consts::FRAC_PI_2).sin();
                            let fade_out = (x * std::f32::consts::FRAC_PI_2).cos();
                            let out_index = (first + index) * 2;
                            dst[out_index] =
                                outgoing[index * 2] * fade_out + incoming[index * 2] * fade_in;
                            dst[out_index + 1] = outgoing[index * 2 + 1] * fade_out
                                + incoming[index * 2 + 1] * fade_in;
                        }
                        ctx.scratch.wrap_out = outgoing;
                        ctx.scratch.wrap_in = incoming;
                        resume_at += fade;
                    }
                }
                if schedule.resume_frames > 0 && resume_at < len {
                    let frames = schedule.resume_frames.min(len - resume_at);
                    let block = &mut dst[resume_at * 2..(resume_at + frames) * 2];
                    ctx.render_range(schedule.resume_start, frames, block);
                    resume_at += frames;
                }
                // The arrangement ended inside this block: run the chains on the
                // silent remainder so a tail is not gapped for one block.
                if resume_at < len && state == TransportState::Stopped {
                    let block = &mut dst[resume_at * 2..len * 2];
                    ctx.render_range(end_playhead, len - resume_at, block);
                }
            } else if state == TransportState::Stopped {
                // Past the end of the arrangement (an offline render's tail) or
                // stopped: run the chains on silence so reverb/delay ring out.
                // Pausing stays silent while holding all stream state.
                let block = &mut dst[..len * 2];
                ctx.render_range(end_playhead, len, block);
            }
        }

        // Master fx, then master gain (with automation) and the safety limiter.
        self.process_master_fx(scratch, dst, start, len, bpm);
        self.master_gain.set_target(self.master_gain_at(start));
        for frame in 0..len {
            let gain = self.master_gain.next();
            let index = frame * 2;
            dst[index] *= gain;
            dst[index + 1] *= gain;
        }
        self.limiter.process(&mut dst[..len * 2]);
    }

    /// Runs the master chain over `dst[..frames * 2]` in place.
    fn process_master_fx(
        &mut self,
        scratch: &mut Scratch,
        dst: &mut [f32],
        start: u64,
        frames: usize,
        bpm: f64,
    ) {
        if frames == 0 {
            return;
        }
        let frames = frames.min(scratch.frames);
        if self.prepared.master_fx.is_empty() {
            return;
        }
        if !self.prepared.plan.master.fx.is_empty() {
            apply_fx_automation(
                &self.prepared.plan.master.automation,
                &mut self.prepared.master_fx,
                start,
            );
        }
        for index in 0..frames {
            scratch.fx_left[index] = dst[index * 2];
            scratch.fx_right[index] = dst[index * 2 + 1];
        }
        let slots = &self.prepared.plan.master.fx;
        for (slot, runtime) in slots.iter().zip(self.prepared.master_fx.iter_mut()) {
            if runtime.bypassed || slot.bypass {
                continue;
            }
            if let Some(effect) = runtime.effect.as_mut() {
                let ctx = FxContext {
                    bpm,
                    sidechain: None,
                };
                effect.process(
                    &mut scratch.fx_left[..frames],
                    &mut scratch.fx_right[..frames],
                    &ctx,
                );
            }
        }
        for index in 0..frames {
            dst[index * 2] = scratch.fx_left[index];
            dst[index * 2 + 1] = scratch.fx_right[index];
        }
    }

    fn master_gain_at(&self, sample: u64) -> f32 {
        let mut gain = self.prepared.plan.master.gain;
        for lane in &self.prepared.plan.master.automation {
            if lane.target == AutomationTarget::MasterGain
                && let Some(db) = lane.value_at(sample)
            {
                gain *= db_to_gain(db);
            }
        }
        gain
    }
}

/// The latency of a live chain: the sum of the non-bypassed effects'
/// algorithmic latency, exactly what the renderer has to compensate.
fn live_chain_latency(slots: &[FxSlot], chain: &[FxRuntime]) -> usize {
    slots
        .iter()
        .zip(chain.iter())
        .filter(|(slot, runtime)| !slot.bypass && !runtime.bypassed)
        .filter_map(|(_, runtime)| runtime.effect.as_ref())
        .map(|effect| effect.latency())
        .sum()
}

/// Builds the live effect for one slot (allocation allowed: planner side).
fn build_slot(slot: &FxSlot, sample_rate: u32, block_size: usize) -> FxRuntime {
    let bypassed =
        slot.bypass || (slot.kind == FxKind::SidechainDuck && slot.sidechain_source.is_none());
    if bypassed {
        return FxRuntime {
            effect: None,
            bypassed: true,
            kind: slot.kind,
        };
    }
    match create(slot.kind, sample_rate, block_size) {
        Ok(mut effect) => {
            for (index, spec) in slot.kind.params().iter().enumerate() {
                effect.set_param(index, spec.default);
            }
            for &(index, value) in &slot.params {
                effect.set_param(index, value);
            }
            effect.reset();
            FxRuntime {
                effect: Some(effect),
                bypassed: false,
                kind: slot.kind,
            }
        }
        Err(_) => FxRuntime {
            effect: None,
            bypassed: true,
            kind: slot.kind,
        },
    }
}

/// Moves surviving effects (`same id` and kind) from `old_chain` into
/// `chain`, matching by position in the slot lists.
fn carry_chain(
    slots: &[FxSlot],
    chain: &mut [FxRuntime],
    old_slots: &[FxSlot],
    old_chain: &mut [FxRuntime],
) {
    for (slot, runtime) in slots.iter().zip(chain.iter_mut()) {
        for (old_slot, old_runtime) in old_slots.iter().zip(old_chain.iter_mut()) {
            if old_slot.id == slot.id && old_slot.kind == slot.kind {
                if let Some(effect) = old_runtime.effect.take() {
                    runtime.effect = Some(effect);
                }
                break;
            }
        }
    }
}

/// Sends every slot's catalogue default to its effect, then the slot's own
/// values, as *targets*. A freshly built effect is then snapped by `reset`;
/// a carried-over effect glides.
fn apply_params(slots: &[FxSlot], chain: &mut [FxRuntime]) {
    for (slot, runtime) in slots.iter().zip(chain.iter_mut()) {
        let Some(effect) = runtime.effect.as_mut() else {
            continue;
        };
        for (index, spec) in slot.kind.params().iter().enumerate() {
            effect.set_param(index, spec.default);
        }
        for &(index, value) in &slot.params {
            effect.set_param(index, value);
        }
    }
}

/// A sidechain-safe track order with a cycle broken by bypassing the ducks in
/// the cycle.
fn processing_order(plan: &RenderPlan, fx: &mut [Vec<FxRuntime>]) -> Vec<usize> {
    let count = plan.tracks.len();
    let mut indegree = vec![0usize; count];
    let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); count];
    for (index, track) in plan.tracks.iter().enumerate() {
        for slot in &track.fx {
            let Some(source) = slot.sidechain_source else {
                continue;
            };
            if source >= count || source == index {
                continue;
            }
            indegree[index] += 1;
            dependents[source].push(index);
        }
    }
    let mut queue: VecDeque<usize> = (0..count).filter(|index| indegree[*index] == 0).collect();
    let mut order = Vec::with_capacity(count);
    while let Some(index) = queue.pop_front() {
        order.push(index);
        for &dependent in &dependents[index] {
            indegree[dependent] = indegree[dependent].saturating_sub(1);
            if indegree[dependent] == 0 {
                queue.push_back(dependent);
            }
        }
    }
    if order.len() < count {
        // A cycle: bypass every duck in the leftover tracks so the order is
        // still total and the ducks stay silent (03 §6).
        for (index, chain) in fx.iter_mut().enumerate() {
            if order.contains(&index) {
                continue;
            }
            for runtime in chain {
                if runtime.kind == FxKind::SidechainDuck {
                    runtime.bypassed = true;
                    runtime.effect = None;
                }
            }
            order.push(index);
        }
    }
    order
}

fn runtime_for(segment: &Segment, quality: Quality, sample_rate: u32) -> SegmentRuntime {
    let ratio = segment
        .ratio
        .clamp(bragi_dsp::stretch::MIN_RATIO, bragi_dsp::stretch::MAX_RATIO);
    // Reverse + stretch is not supported by the vocoder's forward pull model in
    // v1; those segments stay on the varispeed direct path (a plan warning is
    // emitted at compile time).
    let stretcher = if segment.needs_stretcher() && !segment.reverse {
        PhaseVocoder::new(2, sample_rate)
            .ok()
            .and_then(|mut vocoder| {
                vocoder
                    .configure(ratio, segment.pitch_semitones, quality)
                    .ok()
                    .map(|()| Box::new(vocoder))
            })
    } else {
        None
    };
    SegmentRuntime {
        stretcher,
        ..SegmentRuntime::default()
    }
}

/// A linear parameter ramp of a fixed number of frames.
///
/// The spec asks for 5 ms mute/solo ramps and 10 ms parameter smoothing
/// (`specs/03-audio-engine.md` §4, §5.2), so this is deliberately linear rather
/// than a one-pole filter: after exactly `frames` calls the value *is* the
/// target, which is what the timing tests measure.
#[derive(Clone, Copy, Debug)]
struct Ramp {
    value: f32,
    target: f32,
    remaining: u32,
    frames: u32,
}

impl Ramp {
    fn new(value: f32, frames: u32) -> Self {
        Self {
            value,
            target: value,
            remaining: 0,
            frames,
        }
    }

    fn set_target(&mut self, target: f32) {
        if (target - self.target).abs() > 1e-7 {
            self.target = target;
            self.remaining = self.frames;
        }
    }

    fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.value += (self.target - self.value) / self.remaining as f32;
            self.remaining -= 1;
        }
        self.value
    }

    fn value(&self) -> f32 {
        self.value
    }

    fn snap(&mut self, value: f32) {
        self.value = value;
        self.target = value;
        self.remaining = 0;
    }
}

/// Per-track smoothed mix parameters.
#[derive(Debug)]
struct TrackRuntime {
    id: bragi_model::generated::TrackId,
    gain: Ramp,
    pan: Ramp,
    audible: Ramp,
}

impl TrackRuntime {
    fn new(track: &TrackPlan, any_solo: bool, mute_frames: u32, param_frames: u32) -> Self {
        Self {
            id: track.id.clone(),
            gain: Ramp::new(track.gain, param_frames),
            pan: Ramp::new(track.pan.clamp(-1.0, 1.0), param_frames),
            audible: Ramp::new(audible_target(track, any_solo), mute_frames),
        }
    }
}

fn audible_target(track: &TrackPlan, any_solo: bool) -> f32 {
    if track.mute || (any_solo && !track.solo) {
        0.0
    } else {
        1.0
    }
}

/// Pre-allocated scratch buffers. Their size depends only on the block size and
/// the `MAX_SOURCE_FACTOR` ceiling, not on the plan, so a plan swap never
/// allocates on the audio thread.
#[derive(Debug)]
struct Scratch {
    track: Vec<f32>,
    segment: Vec<f32>,
    source: Vec<f32>,
    planar_in: Vec<f32>,
    planar_out: Vec<f32>,
    wrap_out: Vec<f32>,
    wrap_in: Vec<f32>,
    /// Planar left/right workspace for fx chains.
    fx_left: Vec<f32>,
    fx_right: Vec<f32>,
    /// Post-fader `[L; half][R; half]` per track, for sidechain keys.
    sidechain: Vec<f32>,
    frames: usize,
    source_frames: usize,
}

impl Scratch {
    fn new(block: usize, tracks: usize) -> Self {
        let block = block.max(1);
        let source_frames = (block as f64 * MAX_SOURCE_FACTOR).ceil() as usize + 8;
        let tracks = tracks.max(MAX_MIX_TRACKS);
        Self {
            track: vec![0.0; block * 2],
            segment: vec![0.0; block * 2],
            source: vec![0.0; source_frames * 2],
            planar_in: vec![0.0; source_frames * 2],
            planar_out: vec![0.0; block * 2],
            wrap_out: vec![0.0; block * 2],
            wrap_in: vec![0.0; block * 2],
            fx_left: vec![0.0; block],
            fx_right: vec![0.0; block],
            sidechain: vec![0.0; tracks.max(1) * block * 2],
            frames: block,
            source_frames,
        }
    }

    /// Grows the sidechain buffer to hold `tracks` post-fader blocks. Called
    /// from the control side on a plan swap, never from `process`.
    fn ensure_tracks(&mut self, tracks: usize) {
        let wanted = tracks.max(1) * self.frames * 2;
        if self.sidechain.len() < wanted {
            self.sidechain.resize(wanted, 0.0);
        }
    }
}

/// The master-bus limiter state.
///
/// A zero-latency peak limiter: instant attack, 50 ms release, hard ceiling.
/// `specs/03-audio-engine.md` §6 asks for 5 ms look-ahead and true peak; that
/// needs a delay line and a pre-roll in offline renders, and is recorded as a
/// deviation in `docs/wp/1.1.md`.
#[derive(Debug)]
struct Limiter {
    ceiling: f32,
    gain: f32,
    release: f32,
}

impl Limiter {
    fn new(ceiling: f32, sample_rate: u32) -> Self {
        let release = (-1.0 / (0.050 * sample_rate as f32)).exp();
        Self {
            ceiling: ceiling.max(0.001),
            gain: 1.0,
            release,
        }
    }

    fn process(&mut self, buf: &mut [f32]) {
        for frame in buf.chunks_mut(2) {
            let peak = frame[0].abs().max(frame[1].abs());
            let desired = if peak > self.ceiling {
                self.ceiling / peak
            } else {
                1.0
            };
            if desired < self.gain {
                self.gain = desired;
            } else {
                self.gain = desired + (self.gain - desired) * self.release;
            }
            let ceiling = self.ceiling;
            frame[0] = (frame[0] * self.gain).clamp(-ceiling, ceiling);
            frame[1] = (frame[1] * self.gain).clamp(-ceiling, ceiling);
        }
    }
}

/// An in-progress equal-power crossfade between warm plans.
///
/// `from` is the mix that was audible when the switch started and `to` is the
/// target slot, so a switch during a running crossfade continues from the
/// current mix instead of jumping.
#[derive(Clone, Copy, Debug)]
struct AuditionFade {
    from: [f32; MAX_WARM_PLANS],
    to: [f32; MAX_WARM_PLANS],
    pos: usize,
    len: usize,
}

/// The audio-thread renderer.
#[derive(Debug)]
pub struct Renderer {
    /// Slot 0 is the main (HEAD) plan; 1–3 are candidates. Fixed length, so
    /// warming and releasing never resize this vector.
    slots: Vec<Option<PreparedSlot>>,
    /// The slot a switch is heading to (or the only audible one).
    active: usize,
    /// Audible weight per slot outside a fade (`[1, 0, 0, 0]` at rest).
    gains: [f32; MAX_WARM_PLANS],
    /// The running audition crossfade, if any.
    fade: Option<AuditionFade>,
    transport: Transport,
    scratch: Scratch,
    block: Vec<f32>,
    /// The slot being rendered, mixed into `block` with the fade weights.
    slot_block: Vec<f32>,
    meters: Meters,
    stats: RenderStats,
    block_size: usize,
    /// The sample the next block is expected to start at; a jump (seek) resets
    /// the effects so a delay/reverb tail does not follow the playhead.
    expected_start: Option<u64>,
}

impl Renderer {
    /// Creates a renderer for `plan`, processing blocks of at most
    /// `block_size` frames.
    ///
    /// # Panics
    /// Panics when `block_size` is zero, which is a programming error, not
    /// audio-thread input.
    #[must_use]
    pub fn new(plan: Arc<RenderPlan>, block_size: usize) -> Self {
        Self::with_quality(plan, block_size, crate::plan::quality_for(false))
    }

    /// Creates a renderer with an explicit stretch quality tier — `Render` for
    /// offline mixdowns (`specs/03-audio-engine.md` §9), `Preview` for live
    /// playback.
    ///
    /// # Panics
    /// Panics when `block_size` is zero.
    #[must_use]
    pub fn with_quality(plan: Arc<RenderPlan>, block_size: usize, quality: Quality) -> Self {
        assert!(block_size > 0, "block size must be positive");
        let prepared = PreparedPlan::new(plan, quality, block_size);
        let transport = Transport::new(prepared.plan.length_samples);
        let track_count = prepared.plan.tracks.len();
        let mut slots: Vec<Option<PreparedSlot>> = (0..MAX_WARM_PLANS).map(|_| None).collect();
        slots[0] = Some(prepared.into_slot());
        let mut gains = [0.0; MAX_WARM_PLANS];
        gains[0] = 1.0;
        let meters = Meters::new(track_count);
        let scratch = Scratch::new(block_size, track_count);
        Self {
            slots,
            active: 0,
            gains,
            fade: None,
            transport,
            scratch,
            block: vec![0.0; block_size * 2],
            slot_block: vec![0.0; block_size * 2],
            meters,
            stats: RenderStats::default(),
            block_size,
            expected_start: None,
        }
    }

    /// The main (HEAD) plan, slot 0.
    #[must_use]
    #[allow(clippy::expect_used)] // slot 0 is installed by `new` and never removed
    pub fn plan(&self) -> &RenderPlan {
        &self
            .slots
            .first()
            .and_then(Option::as_ref)
            .expect("slot 0 holds the main plan")
            .prepared
            .plan
    }

    /// The plan that is currently audible (a candidate during an audition).
    #[must_use]
    #[allow(clippy::expect_used)] // `active` always names a loaded slot
    pub fn active_plan(&self) -> &RenderPlan {
        &self.slots[self.active]
            .as_ref()
            .expect("the active slot is loaded")
            .prepared
            .plan
    }

    /// Whether `slot` holds a prepared plan.
    #[must_use]
    pub fn has_slot(&self, slot: usize) -> bool {
        self.slots.get(slot).is_some_and(Option::is_some)
    }

    /// The active transport.
    #[must_use]
    pub fn transport(&self) -> &Transport {
        &self.transport
    }

    /// The active transport, mutably.
    pub fn transport_mut(&mut self) -> &mut Transport {
        &mut self.transport
    }

    /// The prepared plan that is audible, for hosts that inspect stream state.
    #[must_use]
    #[allow(clippy::expect_used)] // `active` always names a loaded slot
    pub fn prepared(&self) -> &PreparedPlan {
        &self.slots[self.active]
            .as_ref()
            .expect("the active slot is loaded")
            .prepared
    }

    /// The meters from the last rendered block.
    #[must_use]
    pub fn meters(&self) -> &Meters {
        &self.meters
    }

    /// The stats from the last rendered block.
    #[must_use]
    pub fn stats(&self) -> RenderStats {
        self.stats
    }

    /// The renderer's total output latency in frames:
    /// `max_track_latency + master_chain_latency` (03 §9).
    ///
    /// Realtime playback does not compensate for it (the maximum is a few
    /// milliseconds), but a transport may use it later to align the playhead or
    /// the metronome. Offline renders trim exactly this many leading frames, so
    /// an exported file is sample-aligned with the timeline.
    ///
    /// # Examples
    ///
    /// ```
    /// # use std::sync::Arc;
    /// # use bragi_engine::render::Renderer;
    /// # fn plan() -> bragi_engine::plan::RenderPlan {
    /// #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
    /// #     "schemaVersion": 1, "id": "prj_01",
    /// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
    /// #     "sources": [], "analyses": {}, "tracks": [],
    /// #     "arrangement": { "timebase": { "ppq": 960,
    /// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
    /// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
    /// #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, 1).unwrap()
    /// # }
    /// let renderer = Renderer::new(Arc::new(plan()), 128);
    /// assert_eq!(renderer.output_latency_frames(), 0);
    /// ```
    #[must_use]
    #[allow(clippy::expect_used)] // slot 0 is installed by `new`
    pub fn output_latency_frames(&self) -> usize {
        self.slots[0]
            .as_ref()
            .expect("slot 0 holds the main plan")
            .prepared
            .output_latency_frames()
    }

    /// Installs a prepared plan as slot 0 (the main plan) and returns the
    /// previous one.
    ///
    /// The caller swaps this on the planner side. The renderer keeps the
    /// transport position; the new plan's stream state starts fresh. If a
    /// candidate slot was audible, the renderer crossfades to the new HEAD
    /// instead of cutting, so accepting while auditioning has no gap.
    #[allow(clippy::expect_used)] // slot 0 is installed by `new` and never removed
    pub fn set_prepared(&mut self, prepared: PreparedPlan) -> PreparedPlan {
        let mut slot = prepared.into_slot();
        // Move surviving live effects (same id and kind) and the current ramp
        // values out of the main plan, so a param change glides rather than
        // jumps (`specs/03-audio-engine.md` §4). When a candidate is audible it
        // keeps its own state and fades out.
        if self.active == 0
            && let Some(previous) = self.slots[0].as_mut()
        {
            slot.carry_from(previous);
        }
        let previous = self.slots[0]
            .replace(slot)
            .map(|slot| slot.prepared)
            .expect("slot 0 holds the main plan");
        self.transport.set_length(self.plan().length_samples);
        let track_count = self.plan().tracks.len();
        if self.meters.len() != track_count {
            // The track set changed; rebuild the meter vector (control thread).
            self.meters = Meters::new(track_count);
        }
        let max_tracks = self
            .slots
            .iter()
            .flatten()
            .map(|slot| slot.tracks.len())
            .max()
            .unwrap_or(track_count);
        self.scratch.ensure_tracks(max_tracks);
        if self.active == 0 {
            self.gains = [0.0; MAX_WARM_PLANS];
            self.gains[0] = 1.0;
            self.fade = None;
        } else {
            self.start_fade_to(0);
        }
        previous
    }

    /// Warms `slot` (1–3) with a prepared plan.
    ///
    /// Returns `Ok` with the plan it replaced (if any), for an off-thread drop.
    /// The slot must be idle: a slot that is audible or still fading out is left
    /// alone and `prepared` comes back as `Err`. Nothing here allocates, so a
    /// host may call it from its control path (a worklet message handler or a
    /// drained command) without violating the audio-thread rule.
    ///
    /// # Errors
    /// `Err(prepared)` for slot 0, an out-of-range slot, or a slot that is
    /// audible or fading.
    // The refused plan is handed back by value: boxing it would allocate on the
    // audio thread of the native host, which calls this from its callback.
    #[allow(clippy::result_large_err)]
    pub fn warm_slot(
        &mut self,
        slot: usize,
        prepared: PreparedSlot,
    ) -> Result<Option<PreparedSlot>, PreparedSlot> {
        if slot == 0
            || slot >= MAX_WARM_PLANS
            || self.gains[slot] > 0.0
            || self.fade.is_some_and(|fade| fade.to[slot] > 0.0)
        {
            return Err(prepared);
        }
        Ok(self.slots[slot].replace(prepared))
    }

    /// Sizes the shared mix scratch for a plan with `tracks` tracks.
    ///
    /// This allocates when the plan is larger than [`MAX_MIX_TRACKS`] and any
    /// plan seen before, so call it on the control side before
    /// [`Renderer::warm_slot`]. A candidate warmed without it still plays; a
    /// track past the scratch's capacity only loses its sidechain feed.
    pub fn reserve_tracks(&mut self, tracks: usize) {
        self.scratch.ensure_tracks(tracks);
    }

    /// Releases the plan in `slot` (1–3), if it is idle, and returns it for an
    /// off-thread drop.
    pub fn release_slot(&mut self, slot: usize) -> Option<PreparedSlot> {
        if slot == 0
            || slot >= MAX_WARM_PLANS
            || self.gains[slot] > 0.0
            || self.fade.is_some_and(|fade| fade.to[slot] > 0.0)
        {
            return None;
        }
        self.slots[slot].take()
    }

    /// Switches the audible plan to `slot` (`None` = slot 0, the main plan).
    ///
    /// The switch is an equal-power crossfade of [`AUDITION_FADE_MS`] at the
    /// same playhead. A switch during a running crossfade starts a new one from
    /// the current mix, so it never jumps. A slot that was idle is reset first
    /// (seek semantics); stretched segments re-prime inside their first block.
    ///
    /// Returns `false` when the target slot is not warm.
    ///
    /// # Examples
    ///
    /// ```
    /// # use std::sync::Arc;
    /// # use bragi_engine::render::Renderer;
    /// # fn plan(version: u64) -> bragi_engine::plan::RenderPlan {
    /// #   let doc: bragi_model::generated::Project = serde_json::from_value(serde_json::json!({
    /// #     "schemaVersion": 1, "id": "prj_01",
    /// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
    /// #     "sources": [], "analyses": {}, "tracks": [],
    /// #     "arrangement": { "timebase": { "ppq": 960,
    /// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }], "timeSignatures": [] },
    /// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } } })).unwrap();
    /// #   bragi_engine::plan::compile(&doc, &bragi_model::AssetIndex::new(), 48_000, version).unwrap()
    /// # }
    /// use bragi_engine::plan::quality_for;
    /// use bragi_engine::render::PreparedPlan;
    /// let mut renderer = Renderer::new(Arc::new(plan(1)), 128);
    /// let warm = PreparedPlan::new(Arc::new(plan(2)), quality_for(false), 128).into_slot();
    /// assert!(matches!(renderer.warm_slot(1, warm), Ok(None)));
    /// assert!(renderer.audition(Some(1)));
    /// assert!(renderer.audition(None));
    /// assert!(!renderer.audition(Some(2)));
    /// ```
    pub fn audition(&mut self, slot: Option<usize>) -> bool {
        let target = slot.unwrap_or(0);
        if target >= MAX_WARM_PLANS || self.slots[target].is_none() {
            return false;
        }
        if self.fade.is_none() && target == self.active && self.gains[target] >= 1.0 {
            self.update_audition_flag();
            return true;
        }
        // Entering an idle slot is a seek: drop its old stream and effect state
        // so a tail from the last activation does not follow the playhead.
        if self.gains[target] <= 0.0
            && let Some(slot) = self.slots[target].as_mut()
        {
            slot.reset();
        }
        self.start_fade_to(target);
        true
    }

    fn start_fade_to(&mut self, target: usize) {
        let frames = (AUDITION_FADE_MS * self.plan().sample_rate as f32 / 1000.0).round() as usize;
        let mut to = [0.0; MAX_WARM_PLANS];
        to[target] = 1.0;
        self.fade = Some(AuditionFade {
            from: self.gains,
            to,
            pos: 0,
            len: frames.max(1),
        });
        self.active = target;
        self.update_audition_flag();
    }

    fn update_audition_flag(&mut self) {
        // A slot other than the main plan is audible now, or still fading out
        // of one, which is what the transport overlay means (03 §5.1).
        let other = self.active != 0 || self.gains.iter().skip(1).any(|gain| *gain > 0.0);
        self.transport.set_auditioning(other);
    }

    /// Drops all stream state without changing the plan (after a seek).
    pub fn reset_stream(&mut self) {
        self.reset_audible();
    }

    fn reset_audible(&mut self) {
        if self.fade.is_some() {
            for (index, slot) in self.slots.iter_mut().enumerate() {
                if self.gains[index] > 0.0
                    && let Some(slot) = slot.as_mut()
                {
                    slot.reset();
                }
            }
        } else if let Some(slot) = self.slots[self.active].as_mut() {
            slot.reset();
        }
    }

    /// Renders into `out[0]` (left) and `out[1]` (right).
    ///
    /// Blocks longer than the renderer's block size are split internally. If
    /// `out` has one channel the mix is folded down; extra channels are filled
    /// with silence.
    pub fn process(&mut self, pcm: &dyn PcmSource, out: &mut [&mut [f32]]) -> RenderStats {
        let _guard = alloc_guard::guard();
        let frames = out.first().map_or(0, |channel| channel.len());
        self.stats.frames = frames;
        self.stats.underruns = 0;
        if frames == 0 {
            return self.stats;
        }

        let block_size = self.block_size;
        let mut offset = 0;
        while offset < frames {
            let len = (frames - offset).min(block_size);
            self.process_chunk(pcm, offset, len, out);
            offset += len;
        }
        self.stats.blocks += 1;
        self.stats
    }

    fn process_chunk(
        &mut self,
        pcm: &dyn PcmSource,
        offset: usize,
        len: usize,
        out: &mut [&mut [f32]],
    ) {
        let fade = (LOOP_FADE_MS * self.plan().sample_rate as f32 / 1000.0).round() as usize;
        let schedule = self.transport.schedule(len, fade);
        // A silent (stopped) block still renders effect tails, so use the
        // playhead rather than the silent schedule's placeholder start.
        let start = if schedule.playing {
            schedule.first_start
        } else {
            self.transport.playhead()
        };
        let state = self.transport.state();
        let end_playhead = self.transport.playhead();

        // A jump in the playhead (a seek) is not a loop wrap: drop the stream
        // state and reset the effects so a tail does not follow the playhead.
        if self
            .expected_start
            .is_some_and(|expected| expected != start)
        {
            self.reset_audible();
        }

        for sample in self.block[..len * 2].iter_mut() {
            *sample = 0.0;
        }

        let fade_state = self.fade;
        // Render the outgoing plans first and the target last, so the meters
        // describe the plan the user is switching to. The array is fixed: no
        // allocation in `process`.
        let mut order = [0usize; MAX_WARM_PLANS];
        let mut count = 0;
        if let Some(fade) = fade_state {
            for index in 0..MAX_WARM_PLANS {
                if index != self.active
                    && (fade.from[index] > 0.0 || fade.to[index] > 0.0)
                    && self.slots[index].is_some()
                {
                    order[count] = index;
                    count += 1;
                }
            }
        }
        if self.slots[self.active].is_some() {
            order[count] = self.active;
            count += 1;
        }

        for &index in &order[..count] {
            let bpm = self.slots[index]
                .as_ref()
                .map_or(120.0, |slot| slot.prepared.plan.bpm_at_sample(start));
            let Some(slot) = self.slots[index].as_mut() else {
                continue;
            };
            slot.render_block(
                &mut self.scratch,
                pcm,
                &mut self.stats,
                &schedule,
                start,
                len,
                &mut self.slot_block[..len * 2],
                bpm,
                state,
                end_playhead,
                &mut self.meters,
            );

            if let Some(fade) = fade_state {
                let from = fade.from[index];
                let to = fade.to[index];
                if from == 0.0 && to == 0.0 {
                    continue;
                }
                for frame in 0..len {
                    let x = ((fade.pos + frame + 1) as f32 / fade.len as f32).min(1.0);
                    let (fade_in, fade_out) = (x * std::f32::consts::FRAC_PI_2).sin_cos();
                    let gain = from * fade_out + to * fade_in;
                    let source = frame * 2;
                    self.block[source] += gain * self.slot_block[source];
                    self.block[source + 1] += gain * self.slot_block[source + 1];
                }
            } else {
                self.block[..len * 2].copy_from_slice(&self.slot_block[..len * 2]);
            }
        }

        if let Some(mut fade) = self.fade {
            let end = fade.pos + len;
            if end >= fade.len {
                self.gains = fade.to;
                self.fade = None;
            } else {
                fade.pos = end;
                let x = end as f32 / fade.len as f32;
                let (fade_in, fade_out) = (x * std::f32::consts::FRAC_PI_2).sin_cos();
                for index in 0..MAX_WARM_PLANS {
                    self.gains[index] = fade.from[index] * fade_out + fade.to[index] * fade_in;
                }
                self.fade = Some(fade);
            }
        }
        self.meters.update_master(&self.block[..len * 2]);
        self.update_audition_flag();

        self.expected_start = Some(self.transport.playhead());
        copy_out(out, offset, &self.block[..len * 2], len);
    }
}

fn ramp_frames(ms: f32, sample_rate: u32) -> u32 {
    ((ms * 0.001 * sample_rate as f32).round() as u32).max(1)
}

fn copy_out(out: &mut [&mut [f32]], offset: usize, block: &[f32], frames: usize) {
    if out.is_empty() {
        return;
    }
    if out.len() == 1 {
        for index in 0..frames {
            out[0][offset + index] = 0.5 * (block[index * 2] + block[index * 2 + 1]);
        }
        return;
    }
    for index in 0..frames {
        out[0][offset + index] = block[index * 2];
        out[1][offset + index] = block[index * 2 + 1];
    }
    for channel in out.iter_mut().skip(2) {
        for sample in channel[offset..offset + frames].iter_mut() {
            *sample = 0.0;
        }
    }
}

/// Everything a range render needs, borrowed as disjoint fields so the plan and
/// the mutable stream state can coexist.
struct MixContext<'a> {
    plan: &'a RenderPlan,
    runtimes: &'a mut Vec<SegmentRuntime>,
    offsets: &'a [usize],
    fx: &'a mut [Vec<FxRuntime>],
    delays: &'a mut [DelayLine],
    compensation: &'a [usize],
    order: &'a [usize],
    scratch: &'a mut Scratch,
    pcm: &'a dyn PcmSource,
    tracks: &'a mut [TrackRuntime],
    meters: &'a mut Meters,
    stats: &'a mut RenderStats,
    bpm: f64,
}

impl MixContext<'_> {
    fn render_range(&mut self, start: u64, frames: usize, dst: &mut [f32]) {
        if frames == 0 {
            return;
        }
        let frames = frames.min(self.scratch.frames);
        for sample in dst[..frames * 2].iter_mut() {
            *sample = 0.0;
        }
        let any_solo = self.plan.any_solo();
        for order_index in 0..self.order.len() {
            let track_index = self.order[order_index];
            let Some(track) = self.plan.tracks.get(track_index) else {
                continue;
            };
            for sample in self.scratch.track[..frames * 2].iter_mut() {
                *sample = 0.0;
            }

            let run_start = self.offsets.get(track_index).copied().unwrap_or(0);
            let run_end = self
                .offsets
                .get(track_index + 1)
                .copied()
                .unwrap_or(run_start);
            for (segment, state) in track
                .segments
                .iter()
                .zip(self.runtimes[run_start..run_end].iter_mut())
            {
                if let Some((offset, len)) = segment.overlap(start, frames) {
                    render_segment(
                        self.scratch,
                        self.pcm,
                        self.stats,
                        segment,
                        state,
                        start,
                        offset,
                        len,
                    );
                }
            }

            // Clips → fx chain → gain/pan/mute/solo (post-fx fader).
            process_track_fx(
                self.plan,
                &mut *self.fx,
                &mut *self.scratch,
                track_index,
                start,
                frames,
                self.bpm,
            );

            // Plugin delay compensation: delay the post-fx, pre-fader signal so
            // every track reaches the master with the same chain latency. Doing
            // it before the fader also puts the sidechain key below at master
            // alignment (03 §6, §9).
            if let (Some(delay), Some(amount)) = (
                self.delays.get_mut(track_index),
                self.compensation.get(track_index),
            ) {
                delay.process(&mut self.scratch.track[..frames * 2], *amount);
            }

            let runtime = &mut self.tracks[track_index];
            let mut gain_target = track.gain;
            if let Some(db) = track_gain_automation(track, start) {
                gain_target *= db_to_gain(db);
            }
            runtime.gain.set_target(gain_target);
            runtime.pan.set_target(track.pan.clamp(-1.0, 1.0));
            runtime.audible.set_target(audible_target(track, any_solo));

            let half = self.scratch.frames;
            let side_base = track_index * half * 2;
            let mut peak = 0.0f32;
            let mut sum_sq = 0.0f32;
            for frame in 0..frames {
                let (left_gain, right_gain) = pan_gains(runtime.pan.next());
                let gain = runtime.gain.next() * runtime.audible.next();
                let index = frame * 2;
                let left = self.scratch.track[index] * gain * left_gain;
                let right = self.scratch.track[index + 1] * gain * right_gain;
                dst[index] += left;
                dst[index + 1] += right;
                // Post-fader copy for any `sidechain_duck` dependent.
                if side_base + half + frame < self.scratch.sidechain.len() {
                    self.scratch.sidechain[side_base + frame] = left;
                    self.scratch.sidechain[side_base + half + frame] = right;
                }
                peak = peak.max(left.abs()).max(right.abs());
                sum_sq += left * left + right * right;
            }
            self.meters
                .update_track(track_index, peak, (sum_sq / (frames as f32 * 2.0)).sqrt());
        }
    }
}

/// De-interleaves the track block, runs its fx chain in order, and
/// re-interleaves. A bypassed or unimplemented slot is skipped.
fn process_track_fx(
    plan: &RenderPlan,
    fx: &mut [Vec<FxRuntime>],
    scratch: &mut Scratch,
    track_index: usize,
    start: u64,
    frames: usize,
    bpm: f64,
) {
    let Some(track) = plan.tracks.get(track_index) else {
        return;
    };
    let Some(chain) = fx.get_mut(track_index) else {
        return;
    };
    if chain.is_empty() {
        return;
    }
    apply_fx_automation(&track.automation, chain, start);

    for index in 0..frames {
        scratch.fx_left[index] = scratch.track[index * 2];
        scratch.fx_right[index] = scratch.track[index * 2 + 1];
    }

    let half = scratch.frames;
    for (slot, runtime) in track.fx.iter().zip(chain.iter_mut()) {
        if runtime.bypassed || slot.bypass {
            continue;
        }
        let mut sidechain = None;
        if let Some(source) = slot.sidechain_source {
            let base = source * half * 2;
            if base + half + frames <= scratch.sidechain.len() {
                sidechain = Some((
                    &scratch.sidechain[base..base + frames],
                    &scratch.sidechain[base + half..base + half + frames],
                ));
            }
        }
        let ctx = FxContext { bpm, sidechain };
        if let Some(effect) = runtime.effect.as_mut() {
            effect.process(
                &mut scratch.fx_left[..frames],
                &mut scratch.fx_right[..frames],
                &ctx,
            );
        }
    }

    for index in 0..frames {
        scratch.track[index * 2] = scratch.fx_left[index];
        scratch.track[index * 2 + 1] = scratch.fx_right[index];
    }
}

/// Sets each automated fx parameter to the lane's value at `start`.
fn apply_fx_automation(lanes: &[AutomationLane], chain: &mut [FxRuntime], start: u64) {
    for lane in lanes {
        let AutomationTarget::FxParam { slot, index } = lane.target else {
            continue;
        };
        let Some(runtime) = chain.get_mut(slot) else {
            continue;
        };
        let Some(effect) = runtime.effect.as_mut() else {
            continue;
        };
        if let Some(value) = lane.value_at(start) {
            effect.set_param(index, value as f32);
        }
    }
}

/// Renders one segment's contribution for a range into `scratch.segment`.
#[allow(clippy::too_many_arguments)]
fn render_segment(
    scratch: &mut Scratch,
    pcm: &dyn PcmSource,
    stats: &mut RenderStats,
    segment: &Segment,
    runtime: &mut SegmentRuntime,
    range_start: u64,
    offset: usize,
    frames: usize,
) {
    let local = (range_start + offset as u64) as i64 - segment.dst_start as i64;
    let use_stretcher = runtime.stretcher.is_some() && segment.needs_stretcher();
    if use_stretcher {
        render_stretched(scratch, pcm, stats, segment, runtime, local, offset, frames);
    } else {
        render_direct(scratch, pcm, stats, segment, local, offset, frames);
    }
    runtime.next_offset = local + frames as i64;
}

fn render_direct(
    scratch: &mut Scratch,
    pcm: &dyn PcmSource,
    stats: &mut RenderStats,
    segment: &Segment,
    local: i64,
    offset: usize,
    frames: usize,
) {
    // Read the source frames the block touches, with one frame of margin on
    // each side for linear interpolation.
    let mut min_pos = f64::MAX;
    let mut max_pos = f64::MIN;
    for index in 0..frames {
        let pos = segment.source_position(local + index as i64);
        min_pos = min_pos.min(pos);
        max_pos = max_pos.max(pos);
    }
    if !min_pos.is_finite() || !max_pos.is_finite() {
        return;
    }
    let lo = (min_pos.floor() as i64 - 1).max(0) as u64;
    let hi = (max_pos.ceil() as i64 + 2).max(0) as u64;
    let count = (hi.saturating_sub(lo) as usize).min(scratch.source_frames);
    let present = {
        let source = &mut scratch.source[..count * 2];
        pcm.read(&segment.asset, lo, count, source)
    };
    if !present {
        stats.underruns += 1;
        return;
    }

    for index in 0..frames {
        let pos = segment.source_position(local + index as i64);
        let base = pos.floor() as i64;
        let frac = (pos - base as f64) as f32;
        let index0 = (base - lo as i64).clamp(0, count as i64 - 1) as usize;
        let index1 = (index0 + 1).min(count - 1);
        let source = &scratch.source;
        let mut left = source[index0 * 2] * (1.0 - frac) + source[index1 * 2] * frac;
        let mut right = source[index0 * 2 + 1] * (1.0 - frac) + source[index1 * 2 + 1] * frac;
        let gain = segment.gain
            * segment.fade_gain((segment.dst_start as i64 + local + index as i64).max(0) as u64);
        left *= gain;
        right *= gain;
        let out_index = (offset + index) * 2;
        scratch.segment[out_index] = left;
        scratch.segment[out_index + 1] = right;
    }
    accumulate(scratch, offset, frames);
}

#[allow(clippy::too_many_arguments)]
fn render_stretched(
    scratch: &mut Scratch,
    pcm: &dyn PcmSource,
    stats: &mut RenderStats,
    segment: &Segment,
    runtime: &mut SegmentRuntime,
    local: i64,
    offset: usize,
    frames: usize,
) {
    // (Re)prime when the stream is not continuous with the previous block: a
    // seek, a loop wrap, or the first block of the segment.
    let reprime = !runtime.primed || runtime.next_offset != local;
    if reprime {
        let start = segment.source_position(local).max(0.0).round() as u64;
        if let Some(stretcher) = runtime.stretcher.as_mut() {
            stretcher.reset();
            let latency = stretcher.latency();
            let mut remaining = latency;
            let mut cursor = start;
            while remaining > 0 {
                let n = remaining.min(frames.max(1));
                let need = stretcher.input_required(n);
                cursor += feed(scratch, pcm, stats, stretcher, segment, cursor, need, n);
                remaining -= n;
            }
            runtime.feed_cursor = cursor;
        }
        runtime.primed = true;
    }

    let out_frames = scratch.frames;
    if let Some(stretcher) = runtime.stretcher.as_mut() {
        let need = stretcher.input_required(frames);
        let cursor = runtime.feed_cursor;
        runtime.feed_cursor += feed(
            scratch, pcm, stats, stretcher, segment, cursor, need, frames,
        );
    }

    let (out_left, out_right) = scratch.planar_out.split_at_mut(out_frames);
    for index in 0..frames {
        let absolute = (segment.dst_start as i64 + local + index as i64).max(0) as u64;
        let gain = segment.gain * segment.fade_gain(absolute);
        let out_index = (offset + index) * 2;
        scratch.segment[out_index] = out_left[index] * gain;
        scratch.segment[out_index + 1] = out_right[index] * gain;
    }
    accumulate(scratch, offset, frames);
}

/// Feeds up to `need` source frames to the stretcher and processes
/// `out_frames`; returns the number of source frames consumed.
#[allow(clippy::too_many_arguments)]
fn feed(
    scratch: &mut Scratch,
    pcm: &dyn PcmSource,
    stats: &mut RenderStats,
    stretcher: &mut PhaseVocoder,
    segment: &Segment,
    cursor: u64,
    need: usize,
    out_frames: usize,
) -> u64 {
    let need = need.min(scratch.source_frames);
    let out_frames = out_frames.min(scratch.frames);
    {
        let source = &mut scratch.source[..need * 2];
        if !pcm.read(&segment.asset, cursor, need, source) {
            stats.underruns += 1;
        }
    }
    let source_frames = scratch.source_frames;
    let (in_left, in_right) = scratch.planar_in.split_at_mut(source_frames);
    for index in 0..need {
        in_left[index] = scratch.source[index * 2];
        in_right[index] = scratch.source[index * 2 + 1];
    }
    let (out_left, out_right) = scratch.planar_out.split_at_mut(scratch.frames);
    stretcher.process(
        &[&in_left[..need], &in_right[..need]],
        &mut [&mut out_left[..out_frames], &mut out_right[..out_frames]],
    );
    need as u64
}

/// Adds `scratch.segment[offset..offset+frames]` into `scratch.track`.
fn accumulate(scratch: &mut Scratch, offset: usize, frames: usize) {
    let (track, segment) = (&mut scratch.track, &scratch.segment);
    for (dst, src) in track[offset * 2..(offset + frames) * 2]
        .iter_mut()
        .zip(segment[offset * 2..(offset + frames) * 2].iter())
    {
        *dst += *src;
    }
}

fn track_gain_automation(track: &TrackPlan, sample: u64) -> Option<f64> {
    track
        .automation
        .iter()
        .find(|lane| lane.target == AutomationTarget::TrackGain)
        .and_then(|lane| lane.value_at(sample))
}

/// Balance law for a stereo track: centre is unity and a hard pan attenuates
/// the opposite channel.
fn pan_gains(pan: f32) -> (f32, f32) {
    let pan = pan.clamp(-1.0, 1.0);
    if pan > 0.0 {
        ((pan * std::f32::consts::FRAC_PI_2).cos().max(0.0), 1.0)
    } else {
        (1.0, ((-pan) * std::f32::consts::FRAC_PI_2).cos().max(0.0))
    }
}

/// The engine's automation curve helper, exposed for tests.
#[must_use]
pub fn interpolate(curve: AutomationCurve, a: f64, b: f64, t: f64) -> f64 {
    match curve {
        AutomationCurve::Step => a,
        AutomationCurve::Linear | AutomationCurve::Exp => a + (b - a) * t,
    }
}
