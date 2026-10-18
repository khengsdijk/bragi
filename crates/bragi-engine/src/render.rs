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

use std::sync::Arc;

use bragi_dsp::stretch::{PhaseVocoder, Quality, Stretcher};
use bragi_model::generated::AutomationCurve;

use crate::LOOP_FADE_MS;
use crate::MUTE_RAMP_MS;
use crate::PARAM_RAMP_MS;
use crate::meters::Meters;
use crate::pcm::PcmSource;
use crate::plan::AutomationTarget;
use crate::plan::{RenderPlan, Segment, TrackPlan, db_to_gain};
use crate::rt::alloc_guard;
use crate::transport::Transport;

/// The largest source-frames-per-output-frame factor a segment may have. Plans
/// above this are clamped; the scratch buffers are sized once.
const MAX_SOURCE_FACTOR: f64 = 8.0;

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
#[derive(Debug)]
pub struct PreparedPlan {
    /// The immutable plan.
    pub plan: Arc<RenderPlan>,
    /// One runtime per segment, flattened in plan track/segment order.
    pub runtimes: Vec<SegmentRuntime>,
    /// Prefix offsets into `runtimes`, one entry per track plus the end.
    offsets: Vec<usize>,
    /// Stretch quality tier.
    pub quality: Quality,
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
    /// the stream state to be continuous.
    pub next_offset: u64,
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
    /// Prepares `plan` for rendering at the given stretch quality.
    #[must_use]
    pub fn new(plan: Arc<RenderPlan>, quality: Quality) -> Self {
        let mut offsets = Vec::with_capacity(plan.tracks.len() + 1);
        let mut runtimes = Vec::with_capacity(plan.segment_count());
        offsets.push(0);
        for track in &plan.tracks {
            for segment in &track.segments {
                runtimes.push(runtime_for(segment, quality, plan.sample_rate));
            }
            offsets.push(runtimes.len());
        }
        Self {
            plan,
            runtimes,
            offsets,
            quality,
        }
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

    /// Drops the stream state of every segment (used after a seek or a plan
    /// swap).
    pub fn reset(&mut self) {
        for runtime in &mut self.runtimes {
            runtime.primed = false;
            runtime.next_offset = 0;
            if let Some(stretcher) = runtime.stretcher.as_mut() {
                stretcher.reset();
            }
        }
    }
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
    frames: usize,
    source_frames: usize,
}

impl Scratch {
    fn new(block: usize) -> Self {
        let block = block.max(1);
        let source_frames = (block as f64 * MAX_SOURCE_FACTOR).ceil() as usize + 8;
        Self {
            track: vec![0.0; block * 2],
            segment: vec![0.0; block * 2],
            source: vec![0.0; source_frames * 2],
            planar_in: vec![0.0; source_frames * 2],
            planar_out: vec![0.0; block * 2],
            wrap_out: vec![0.0; block * 2],
            wrap_in: vec![0.0; block * 2],
            frames: block,
            source_frames,
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

/// The audio-thread renderer.
#[derive(Debug)]
pub struct Renderer {
    prepared: PreparedPlan,
    transport: Transport,
    tracks: Vec<TrackRuntime>,
    master_gain: Ramp,
    limiter: Limiter,
    scratch: Scratch,
    block: Vec<f32>,
    meters: Meters,
    stats: RenderStats,
    block_size: usize,
    mute_frames: u32,
    param_frames: u32,
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
        let sample_rate = plan.sample_rate;
        let prepared = PreparedPlan::new(plan, quality);
        let transport = Transport::new(prepared.plan.length_samples);
        let any_solo = prepared.plan.any_solo();
        let mute_frames = ramp_frames(MUTE_RAMP_MS, sample_rate);
        let param_frames = ramp_frames(PARAM_RAMP_MS, sample_rate);
        let tracks = prepared
            .plan
            .tracks
            .iter()
            .map(|track| TrackRuntime::new(track, any_solo, mute_frames, param_frames))
            .collect();
        let master_gain = Ramp::new(prepared.plan.master.gain, param_frames);
        let limiter = Limiter::new(prepared.plan.master.ceiling, sample_rate);
        let meters = Meters::new(prepared.plan.tracks.len());
        Self {
            prepared,
            transport,
            tracks,
            master_gain,
            limiter,
            scratch: Scratch::new(block_size),
            block: vec![0.0; block_size * 2],
            meters,
            stats: RenderStats::default(),
            block_size,
            mute_frames,
            param_frames,
        }
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

    /// The active plan.
    #[must_use]
    pub fn plan(&self) -> &RenderPlan {
        &self.prepared.plan
    }

    /// The prepared plan, for hosts that need to inspect stream state.
    #[must_use]
    pub fn prepared(&self) -> &PreparedPlan {
        &self.prepared
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

    /// Installs a prepared plan and returns the previous one.
    ///
    /// The caller swaps this on the planner side. The renderer keeps the
    /// transport position; the new plan's stream state starts fresh.
    pub fn set_prepared(&mut self, mut prepared: PreparedPlan) -> PreparedPlan {
        prepared.reset();
        let any_solo = prepared.plan.any_solo();
        let mute_frames = self.mute_frames;
        let param_frames = self.param_frames;
        let previous = std::mem::take(&mut self.tracks);
        // Carry the *current* ramp values over for tracks that survive, so a
        // delta or a preview that flips mute starts a 5 ms ramp instead of a
        // click.
        self.tracks = prepared
            .plan
            .tracks
            .iter()
            .map(|track| {
                let mut runtime = TrackRuntime::new(track, any_solo, mute_frames, param_frames);
                if let Some(old) = previous.iter().find(|old| old.id == track.id) {
                    runtime.gain.snap(old.gain.value());
                    runtime.pan.snap(old.pan.value());
                    runtime.audible.snap(old.audible.value());
                }
                runtime
            })
            .collect();
        self.transport.set_length(prepared.plan.length_samples);
        self.master_gain = Ramp::new(prepared.plan.master.gain, param_frames);
        self.limiter = Limiter::new(prepared.plan.master.ceiling, prepared.plan.sample_rate);
        std::mem::replace(&mut self.prepared, prepared)
    }

    /// Drops all stream state without changing the plan (after a seek).
    pub fn reset_stream(&mut self) {
        self.prepared.reset();
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
        let fade = (LOOP_FADE_MS * self.prepared.plan.sample_rate as f32 / 1000.0).round() as usize;
        let schedule = self.transport.schedule(len, fade);

        for sample in self.block[..len * 2].iter_mut() {
            *sample = 0.0;
        }

        if schedule.playing {
            {
                let mut ctx = MixContext {
                    plan: &self.prepared.plan,
                    runtimes: &mut self.prepared.runtimes,
                    scratch: &mut self.scratch,
                    pcm,
                    tracks: &mut self.tracks,
                    meters: &mut self.meters,
                    stats: &mut self.stats,
                };
                let first = schedule.first_frames.min(len);
                let block = &mut self.block[..first * 2];
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
                            self.block[out_index] =
                                outgoing[index * 2] * fade_out + incoming[index * 2] * fade_in;
                            self.block[out_index + 1] = outgoing[index * 2 + 1] * fade_out
                                + incoming[index * 2 + 1] * fade_in;
                        }
                        ctx.scratch.wrap_out = outgoing;
                        ctx.scratch.wrap_in = incoming;
                        resume_at += fade;
                    }
                }
                if resume_at < len {
                    let block = &mut self.block[resume_at * 2..len * 2];
                    ctx.render_range(schedule.resume_start, len - resume_at, block);
                }
            }
        }

        // Master gain (with automation) and the safety limiter.
        self.master_gain
            .set_target(self.master_gain_at(schedule.first_start));
        for frame in 0..len {
            let gain = self.master_gain.next();
            let index = frame * 2;
            self.block[index] *= gain;
            self.block[index + 1] *= gain;
        }
        self.limiter.process(&mut self.block[..len * 2]);
        self.meters.update_master(&self.block[..len * 2]);

        copy_out(out, offset, &self.block[..len * 2], len);
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
    scratch: &'a mut Scratch,
    pcm: &'a dyn PcmSource,
    tracks: &'a mut [TrackRuntime],
    meters: &'a mut Meters,
    stats: &'a mut RenderStats,
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
        let mut runtime_index = 0usize;
        for (track_index, track) in self.plan.tracks.iter().enumerate() {
            for sample in self.scratch.track[..frames * 2].iter_mut() {
                *sample = 0.0;
            }

            for segment in &track.segments {
                let overlap = segment.overlap(start, frames);
                let state = &mut self.runtimes[runtime_index];
                runtime_index += 1;
                if let Some((offset, len)) = overlap {
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

            let runtime = &mut self.tracks[track_index];
            let mut gain_target = track.gain;
            if let Some(db) = track_gain_automation(track, start) {
                gain_target *= db_to_gain(db);
            }
            runtime.gain.set_target(gain_target);
            runtime.pan.set_target(track.pan.clamp(-1.0, 1.0));
            runtime.audible.set_target(audible_target(track, any_solo));

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
                peak = peak.max(left.abs()).max(right.abs());
                sum_sq += left * left + right * right;
            }
            self.meters
                .update_track(track_index, peak, (sum_sq / (frames as f32 * 2.0)).sqrt());
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
    let local = (range_start + offset as u64) - segment.dst_start;
    let use_stretcher = runtime.stretcher.is_some() && segment.needs_stretcher();
    if use_stretcher {
        render_stretched(scratch, pcm, stats, segment, runtime, local, offset, frames);
    } else {
        render_direct(scratch, pcm, stats, segment, local, offset, frames);
    }
    runtime.next_offset = local + frames as u64;
}

/// The source position a segment plays at local destination offset `local`.
fn source_position(segment: &Segment, local: u64) -> f64 {
    let pos = segment.src_map.src_at(local);
    if segment.reverse {
        let mirrored = segment.src_end as f64 - 1.0 - (pos - segment.src_start as f64);
        mirrored.clamp(
            segment.src_start as f64,
            (segment.src_end as f64 - 1.0).max(segment.src_start as f64),
        )
    } else {
        pos
    }
}

fn render_direct(
    scratch: &mut Scratch,
    pcm: &dyn PcmSource,
    stats: &mut RenderStats,
    segment: &Segment,
    local: u64,
    offset: usize,
    frames: usize,
) {
    // Read the source frames the block touches, with one frame of margin on
    // each side for linear interpolation.
    let mut min_pos = f64::MAX;
    let mut max_pos = f64::MIN;
    for index in 0..frames {
        let pos = source_position(segment, local + index as u64);
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
        let pos = source_position(segment, local + index as u64);
        let base = pos.floor() as i64;
        let frac = (pos - base as f64) as f32;
        let index0 = (base - lo as i64).clamp(0, count as i64 - 1) as usize;
        let index1 = (index0 + 1).min(count - 1);
        let source = &scratch.source;
        let mut left = source[index0 * 2] * (1.0 - frac) + source[index1 * 2] * frac;
        let mut right = source[index0 * 2 + 1] * (1.0 - frac) + source[index1 * 2 + 1] * frac;
        let gain = segment.gain * segment.fade_gain(segment.dst_start + local + index as u64);
        left *= gain;
        right *= gain;
        let out_index = (offset + index) * 2;
        scratch.segment[out_index] = left;
        scratch.segment[out_index + 1] = right;
    }
    accumulate(scratch, offset, frames);
}

fn render_stretched(
    scratch: &mut Scratch,
    pcm: &dyn PcmSource,
    stats: &mut RenderStats,
    segment: &Segment,
    runtime: &mut SegmentRuntime,
    local: u64,
    offset: usize,
    frames: usize,
) {
    // (Re)prime when the stream is not continuous with the previous block: a
    // seek, a loop wrap, or the first block of the segment.
    let reprime = !runtime.primed || runtime.next_offset != local;
    if reprime {
        let start = source_position(segment, local).max(0.0).round() as u64;
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
        let absolute = segment.dst_start + local + index as u64;
        let gain = segment.gain * segment.fade_gain(absolute);
        let out_index = (offset + index) * 2;
        scratch.segment[out_index] = out_left[index] * gain;
        scratch.segment[out_index + 1] = out_right[index] * gain;
    }
    accumulate(scratch, offset, frames);
}

/// Feeds up to `need` source frames to the stretcher and processes
/// `out_frames`; returns the number of source frames consumed.
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
