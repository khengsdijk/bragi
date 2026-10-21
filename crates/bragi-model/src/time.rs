//! Time mapping between ticks, seconds and bars/beats.
//!
//! These are the *only* allowed conversions between the musical time domain and wall-clock time
//! (`specs/02-song-model.md` §2.2). Every function is pure and allocation-free.
//!
//! ## Tempo-map semantics
//!
//! A [`Timebase`] carries a sorted tempo map whose first entry sits at tick 0. A point's `curve`
//! describes the ramp **from that point to the next**:
//!
//! - `step` — the tempo is the point's `bpm` until the next point (a jump, described in 02 §2.2).
//! - `linear` — the tempo ramps linearly from this point's `bpm` to the next point's `bpm`.
//!
//! The last point's tempo holds forever after it; before tick 0 the first point's tempo is used.
//! That reading is written into 02 §2.2 by this work package.
//!
//! ```
//! use bragi_model::{TempoCtx, generated::{TempoCurve, TempoPoint}};
//! // 120 bpm, one quarter note (960 ticks) is half a second.
//! let points = vec![TempoPoint { tick: 0, bpm: 120.0, curve: TempoCurve::Step }];
//! let ctx = TempoCtx::new(&points, 960);
//! assert!((ctx.ticks_to_seconds(960) - 0.5).abs() < 1e-9);
//! assert_eq!(ctx.seconds_to_ticks(0.5), 960);
//! ```

use crate::generated::{Project, TempoCurve, TempoMap, TempoPoint, TickRange, TimeSig, Timebase};

use crate::PPQ;

/// The smallest tempo the specification allows (`specs/02-song-model.md` §4.3, invariant 4).
pub const MIN_BPM: f64 = 20.0;
/// The largest tempo the specification allows (`specs/02-song-model.md` §4.3, invariant 4).
pub const MAX_BPM: f64 = 400.0;

/// A borrowed tempo map together with its PPQ, ready for conversion.
///
/// This is the hot-path type: build it once and convert many ticks without touching the whole
/// document (`specs/02-song-model.md` §8).
#[derive(Clone, Copy, Debug)]
pub struct TempoCtx<'a> {
    points: &'a [TempoPoint],
    ppq: i64,
}

impl<'a> TempoCtx<'a> {
    /// Builds a context from a tempo map and PPQ.
    ///
    /// The map is used as given; [`crate::validate`] is what checks that it is sorted and starts at
    /// tick 0. An empty map is treated as a single 120 bpm step so that conversions stay total.
    #[must_use]
    pub fn new(points: &'a [TempoPoint], ppq: i64) -> Self {
        Self { points, ppq }
    }

    /// Builds a context from a [`Timebase`].
    #[must_use]
    pub fn from_timebase(timebase: &'a Timebase) -> Self {
        Self::new(&timebase.tempo_map.0, *timebase.ppq)
    }

    /// Builds a context from a document's timebase.
    #[must_use]
    pub fn from_project(doc: &'a Project) -> Self {
        Self::from_timebase(&doc.arrangement.timebase)
    }

    /// The tempo map, in order.
    #[must_use]
    pub fn points(&self) -> &'a [TempoPoint] {
        self.points
    }

    /// Seconds per tick at `bpm`.
    fn seconds_per_tick(&self, bpm: f64) -> f64 {
        60.0 / (bpm * self.ppq as f64)
    }

    /// Seconds elapsed from tick 0 to `ticks` (negative values extrapolate the first tempo).
    #[must_use]
    pub fn ticks_to_seconds(&self, ticks: i64) -> f64 {
        let Some(first) = self.points.first() else {
            return ticks as f64 * self.seconds_per_tick(120.0);
        };
        if ticks <= 0 {
            return ticks as f64 * self.seconds_per_tick(first.bpm);
        }
        let mut seconds = 0.0;
        for (index, point) in self.points.iter().enumerate() {
            let seg_start = point.tick as i64;
            let Some(next) = self.points.get(index + 1) else {
                // The last point's tempo holds forever after it.
                return seconds + (ticks - seg_start) as f64 * self.seconds_per_tick(point.bpm);
            };
            let seg_end = next.tick as i64;
            let seg_len = (seg_end - seg_start).max(0);
            if ticks >= seg_end {
                seconds += self.segment_seconds(point, next, seg_len, seg_len);
                continue;
            }
            let partial = ticks - seg_start;
            return seconds + self.segment_seconds(point, next, seg_len, partial);
        }
        seconds
    }

    /// Ticks at which `secs` has elapsed since tick 0 (rounds to the nearest tick).
    #[must_use]
    pub fn seconds_to_ticks(&self, secs: f64) -> i64 {
        if !secs.is_finite() {
            return 0;
        }
        let Some(first) = self.points.first() else {
            return (secs / self.seconds_per_tick(120.0)).round() as i64;
        };
        if secs <= 0.0 {
            return (secs / self.seconds_per_tick(first.bpm)).round() as i64;
        }
        let mut seconds = 0.0;
        for (index, point) in self.points.iter().enumerate() {
            let Some(next) = self.points.get(index + 1) else {
                let seg_ticks = (secs - seconds) / self.seconds_per_tick(point.bpm);
                return point.tick as i64 + seg_ticks.round() as i64;
            };
            let seg_len = (next.tick as i64 - point.tick as i64).max(0);
            let seg_seconds = self.segment_seconds(point, next, seg_len, seg_len);
            if seconds + seg_seconds <= secs {
                seconds += seg_seconds;
                continue;
            }
            let remain = secs - seconds;
            let seg_ticks = self.segment_ticks(point, next, seg_len, remain);
            return point.tick as i64 + seg_ticks.round() as i64;
        }
        self.points.last().map_or(0, |p| p.tick as i64)
    }

    /// Seconds spent over `len` ticks of a `full_len`-tick segment starting at a `curve` point.
    fn segment_seconds(
        &self,
        point: &TempoPoint,
        next: &TempoPoint,
        full_len: i64,
        len: i64,
    ) -> f64 {
        if len <= 0 {
            return 0.0;
        }
        match point.curve {
            TempoCurve::Step => len as f64 * self.seconds_per_tick(point.bpm),
            TempoCurve::Linear => {
                let (b0, b1) = (point.bpm, next.bpm);
                if (b1 - b0).abs() < f64::EPSILON || full_len <= 0 {
                    return len as f64 * self.seconds_per_tick(b0);
                }
                // bpm(s) = b0 + (b1 - b0) * s / full_len; ∫ ds / bpm(s) is a logarithm.
                let bpm_at_len = b0 + (b1 - b0) * len as f64 / full_len as f64;
                (60.0 / self.ppq as f64) * (full_len as f64 / (b1 - b0)) * (bpm_at_len / b0).ln()
            }
        }
    }

    /// Ticks covered by `remain` seconds inside a segment of `len` ticks.
    fn segment_ticks(&self, point: &TempoPoint, next: &TempoPoint, len: i64, remain: f64) -> f64 {
        if len <= 0 {
            return 0.0;
        }
        match point.curve {
            TempoCurve::Step => remain / self.seconds_per_tick(point.bpm),
            TempoCurve::Linear => {
                let (b0, b1) = (point.bpm, next.bpm);
                if (b1 - b0).abs() < f64::EPSILON {
                    return remain / self.seconds_per_tick(b0);
                }
                // Invert the logarithm: bpm(n) = b0 * exp(remain * ppq * (b1 - b0) / (60 * len)).
                let len_f = len as f64;
                let growth = (remain * self.ppq as f64 * (b1 - b0) / (60.0 * len_f)).exp();
                len_f * (b0 * growth - b0) / (b1 - b0)
            }
        }
    }
}

/// Seconds elapsed at `ticks`, using the document's tempo map (`specs/02-song-model.md` §2.2).
///
/// ```
/// # use bragi_model::generated::{Project, TempoCurve, TempoPoint, Timebase};
/// # fn project(bpm: f64) -> Project {
/// #     serde_json::from_value(serde_json::json!({
/// #         "schemaVersion": 1, "id": "prj_01",
/// #         "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #         "sources": [], "analyses": {},
/// #         "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
/// #                      "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
/// #         "arrangement": { "timebase": { "ppq": 960,
/// #             "tempoMap": [{ "tick": 0, "bpm": bpm, "curve": "step" }],
/// #             "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #             "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// #     })).unwrap()
/// # }
/// let doc = project(120.0);
/// assert!((bragi_model::ticks_to_seconds(&doc, 1920) - 1.0).abs() < 1e-9);
/// ```
#[must_use]
pub fn ticks_to_seconds(doc: &Project, ticks: i64) -> f64 {
    TempoCtx::from_project(doc).ticks_to_seconds(ticks)
}

/// The tick at which `secs` has elapsed, using the document's tempo map.
///
/// ```
/// # use bragi_model::generated::Project;
/// # fn project() -> Project { serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {},
/// #     "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
/// #                  "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap() }
/// assert_eq!(bragi_model::seconds_to_ticks(&project(), 0.25), 480);
/// ```
#[must_use]
pub fn seconds_to_ticks(doc: &Project, secs: f64) -> i64 {
    TempoCtx::from_project(doc).seconds_to_ticks(secs)
}

/// Ticks per beat at `ticks`, from the time signature in force there.
///
/// A beat is one `denominator`-th note, so a 6/8 bar has six eighth-note beats.
#[must_use]
pub fn beat_ticks(signatures: &[TimeSig], ticks: i64, ppq: i64) -> i64 {
    let denominator = signature_at(signatures, ticks, ppq).map_or(4, |s| *s.denominator);
    // A whole note is 4 * PPQ ticks; one `denominator`-th note is that over the denominator.
    4 * ppq / denominator.max(1)
}

/// The time signature in force at bar `bar`: the last one that starts at or before it.
fn signature_for_bar(signatures: &[TimeSig], bar: u64) -> Option<&TimeSig> {
    signatures
        .iter()
        .rev()
        .find(|s| s.bar <= bar)
        .or_else(|| signatures.first())
}

/// Length in ticks of bar `bar`, from the time signatures.
#[must_use]
pub fn bar_ticks(signatures: &[TimeSig], bar: u64, ppq: i64) -> i64 {
    let (numerator, denominator) =
        signature_for_bar(signatures, bar).map_or((4, 4), |s| (s.numerator.get(), *s.denominator));
    let beats = i64::try_from(numerator).unwrap_or(4);
    beats * 4 * ppq / denominator.max(1)
}

/// The time signature covering `ticks`, so a bar length can be derived from a tick.
fn signature_at(signatures: &[TimeSig], ticks: i64, ppq: i64) -> Option<&TimeSig> {
    if signatures.is_empty() {
        return None;
    }
    let mut elapsed = 0_i64;
    let mut bar = 0_u64;
    loop {
        let len = bar_ticks(signatures, bar, ppq).max(1);
        if ticks < elapsed + len {
            return signature_for_bar(signatures, bar);
        }
        elapsed += len;
        bar += 1;
    }
}

/// The tick at the start of `bar`, plus `beat` beats into it.
///
/// `beat` is 0-based and fractional (`2.5` is halfway through the bar's third beat). `bar` and
/// `beat` are interpreted with the time signatures of `doc`; `bar 0, beat 0` is tick 0.
///
/// ```
/// # use bragi_model::generated::Project;
/// # fn project() -> Project { serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {},
/// #     "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
/// #                  "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [], "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap() }
/// // Two bars of 4/4 is 7680 ticks.
/// assert_eq!(bragi_model::bar_beat_to_ticks(&project(), 2, 0.0), 7680);
/// assert_eq!(bragi_model::bar_beat_to_ticks(&project(), 0, 1.0), 960);
/// ```
#[must_use]
pub fn bar_beat_to_ticks(doc: &Project, bar: u64, beat: f64) -> i64 {
    let ppq = *doc.arrangement.timebase.ppq;
    let signatures = &doc.arrangement.timebase.time_signatures;
    let mut ticks = 0_i64;
    for index in 0..bar {
        ticks += bar_ticks(signatures, index, ppq);
    }
    let beat_len = beat_ticks(signatures, ticks, ppq);
    ticks + (beat * beat_len as f64).round() as i64
}

/// The `(bar, beat)` position of `ticks` — the inverse of [`bar_beat_to_ticks`].
///
/// `beat` is 0-based and fractional within the bar.
#[must_use]
pub fn ticks_to_bar_beat(doc: &Project, ticks: i64) -> (u64, f64) {
    let ppq = *doc.arrangement.timebase.ppq;
    let signatures = &doc.arrangement.timebase.time_signatures;
    if ticks <= 0 {
        let beat_len = beat_ticks(signatures, 0, ppq).max(1);
        return (0, ticks as f64 / beat_len as f64);
    }
    let mut elapsed = 0_i64;
    let mut bar = 0_u64;
    loop {
        let len = bar_ticks(signatures, bar, ppq).max(1);
        if ticks < elapsed + len {
            let beat_len = beat_ticks(signatures, elapsed, ppq).max(1);
            return (bar, (ticks - elapsed) as f64 / beat_len as f64);
        }
        elapsed += len;
        bar += 1;
    }
}

/// Which end of the song a [`bar_aligned_context_range`] is anchored to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContextEdge {
    /// The first bar line (tick 0), for a backward extend or an intro.
    Start,
    /// The last bar line at or before the song's end, for a forward extend.
    End,
}

/// A bar-aligned tick range of about `seconds` seconds at one song edge.
///
/// Generation conditioning wants roughly the last (or first) 30 s of the song,
/// but a model that works in bars must be handed bar lines (`specs/03-audio-engine.md`
/// §9, `specs/09-generation.md` §3). This walks the bar lines derived from the
/// tempo map and the time signatures and picks the range whose duration is
/// closest to `seconds`; on a tie it keeps the longer range. The range is at
/// least one bar and clamped to the song, so a short song yields the whole song
/// and a song that ends mid-bar ends the range on the bar line before it.
///
/// `seconds` is a target, not a promise: bars change length across a time
/// signature and a tempo change, so the result lands on the nearest bar line.
/// A non-finite or negative `seconds` picks the shortest one-bar range.
///
/// ```
/// # use bragi_model::generated::Project;
/// # fn project() -> Project { serde_json::from_value(serde_json::json!({
/// #     "schemaVersion": 1, "id": "prj_01",
/// #     "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
/// #     "sources": [], "analyses": {},
/// #     "tracks": [{ "id": "trk_01", "name": "Mix", "role": "full_mix", "color": "#8A8F98",
/// #                  "gainDb": 0, "pan": 0, "mute": false, "solo": false, "hidden": false, "fx": [] }],
/// #     "arrangement": { "timebase": { "ppq": 960,
/// #         "tempoMap": [{ "tick": 0, "bpm": 120, "curve": "step" }],
/// #         "timeSignatures": [{ "bar": 0, "numerator": 4, "denominator": 4 }] },
/// #         "sections": [{ "id": "sec_a", "kind": "custom", "label": "A", "lengthTicks": 15360,
/// #             "lanes": {}, "transitionIn": { "kind": "cut", "lengthTicks": 0 } }],
/// #         "master": { "fx": [], "automation": [], "gainDb": 0 } }
/// # })).unwrap() }
/// // Four bars of 4/4 at 120 bpm (2 s per bar). Five seconds is a tie between
/// // two bars (4 s) and three bars (6 s); the longer range wins.
/// let range = bragi_model::bar_aligned_context_range(
///     &project(), bragi_model::ContextEdge::End, 5.0);
/// assert_eq!((range.start_tick, range.end_tick), (3840, 15360));
/// ```
#[must_use]
pub fn bar_aligned_context_range(doc: &Project, edge: ContextEdge, seconds: f64) -> TickRange {
    let total = crate::spans::total_ticks(doc);
    if total <= 0 {
        return TickRange {
            start_tick: 0,
            end_tick: total.max(0),
        };
    }
    let ppq = *doc.arrangement.timebase.ppq;
    let signatures = &doc.arrangement.timebase.time_signatures;
    let tempo = TempoCtx::from_project(doc);
    let target = if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    };

    // Every bar line from 0 up to the song end, plus the end itself when it
    // lands on one. A partial last bar is not a candidate: the range must end
    // (or start) exactly on a bar line.
    let mut bars = vec![0_i64];
    let mut tick = 0_i64;
    let mut bar = 0_u64;
    loop {
        let next = tick.saturating_add(bar_ticks(signatures, bar, ppq).max(1));
        if next > total {
            break;
        }
        bars.push(next);
        tick = next;
        bar += 1;
        if next == total {
            break;
        }
    }

    // Fewer than two bar lines means the song is shorter than one bar: clamp.
    if bars.len() < 2 {
        return TickRange {
            start_tick: 0,
            end_tick: total,
        };
    }

    let duration =
        |start: i64, end: i64| tempo.ticks_to_seconds(end) - tempo.ticks_to_seconds(start);
    let mut best = match edge {
        ContextEdge::Start => (0, bars[1]),
        ContextEdge::End => (bars[bars.len() - 2], bars[bars.len() - 1]),
    };
    let mut best_diff = (duration(best.0, best.1) - target).abs();
    match edge {
        // Later boundaries are longer ranges; on a tie they win.
        ContextEdge::Start => {
            for &end in &bars[2..] {
                let diff = (duration(0, end) - target).abs();
                if diff <= best_diff {
                    best = (0, end);
                    best_diff = diff;
                }
            }
        }
        // Walk backwards so the earlier (longer) range wins a tie.
        ContextEdge::End => {
            let end = *bars.last().unwrap_or(&total);
            for &start in bars[..bars.len() - 1].iter().rev() {
                let diff = (duration(start, end) - target).abs();
                if diff <= best_diff {
                    best = (start, end);
                    best_diff = diff;
                }
            }
        }
    }
    TickRange {
        start_tick: best.0,
        end_tick: best.1,
    }
}

/// A convenience wrapper for callers that already hold a [`TempoMap`].
#[must_use]
pub fn tempo_map_seconds(points: &TempoMap, ticks: i64) -> f64 {
    TempoCtx::new(&points.0, PPQ).ticks_to_seconds(ticks)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::float_cmp)]
mod tests {
    use super::*;

    fn point(tick: u64, bpm: f64, curve: TempoCurve) -> TempoPoint {
        TempoPoint { tick, bpm, curve }
    }

    #[test]
    fn constant_tempo_is_exact() {
        let points = vec![point(0, 120.0, TempoCurve::Step)];
        let ctx = TempoCtx::new(&points, 960);
        assert!((ctx.ticks_to_seconds(0) - 0.0).abs() < 1e-12);
        assert!((ctx.ticks_to_seconds(960) - 0.5).abs() < 1e-12);
        assert!((ctx.ticks_to_seconds(7680) - 4.0).abs() < 1e-12);
        assert_eq!(ctx.seconds_to_ticks(4.0), 7680);
    }

    #[test]
    fn step_change_applies_from_its_tick() {
        let points = vec![
            point(0, 120.0, TempoCurve::Step),
            point(3840, 60.0, TempoCurve::Step),
        ];
        let ctx = TempoCtx::new(&points, 960);
        // First bar at 120 bpm = 2 s; the next 960 ticks at 60 bpm = 1 s.
        assert!((ctx.ticks_to_seconds(3840) - 2.0).abs() < 1e-12);
        assert!((ctx.ticks_to_seconds(4800) - 3.0).abs() < 1e-12);
        assert_eq!(ctx.seconds_to_ticks(3.0), 4800);
    }

    #[test]
    fn linear_ramp_matches_the_closed_form() {
        // 120 -> 240 bpm over 960 ticks. ∫ (60/960) / bpm(t) dt with bpm linear.
        let points = vec![
            point(0, 120.0, TempoCurve::Linear),
            point(960, 240.0, TempoCurve::Step),
        ];
        let ctx = TempoCtx::new(&points, 960);
        let expected = (60.0 / 960.0) * (960.0 / 120.0) * (240.0_f64 / 120.0).ln();
        assert!((ctx.ticks_to_seconds(960) - expected).abs() < 1e-12);
        assert_eq!(ctx.seconds_to_ticks(expected), 960);
        // Monotonic and between the two constant-tempo values (0.125 s at 240, 0.25 s at 120).
        assert!((0.125..0.25).contains(&ctx.ticks_to_seconds(480)));
    }

    #[test]
    fn negative_ticks_extrapolate_the_first_tempo() {
        let points = vec![point(0, 120.0, TempoCurve::Step)];
        let ctx = TempoCtx::new(&points, 960);
        assert!((ctx.ticks_to_seconds(-960) + 0.5).abs() < 1e-12);
        assert_eq!(ctx.seconds_to_ticks(-0.5), -960);
    }

    #[test]
    fn empty_map_is_total() {
        let ctx = TempoCtx::new(&[], 960);
        assert!((ctx.ticks_to_seconds(960) - 0.5).abs() < 1e-12);
        assert_eq!(ctx.seconds_to_ticks(0.5), 960);
    }

    /// A document with one section per entry in `lengths`.
    fn context_project(
        tempo: serde_json::Value,
        signatures: serde_json::Value,
        lengths: &[u64],
    ) -> Project {
        let sections: Vec<serde_json::Value> = lengths
            .iter()
            .enumerate()
            .map(|(index, length)| {
                serde_json::json!({
                    "id": format!("sec_{index}"), "kind": "custom", "label": format!("{index}"),
                    "lengthTicks": length, "lanes": {},
                    "transitionIn": { "kind": "cut", "lengthTicks": 0 }
                })
            })
            .collect();
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "id": "prj_01",
            "meta": { "title": "t", "createdAt": "2026-10-18T12:00:00Z", "tags": [] },
            "sources": [], "analyses": {}, "tracks": [],
            "arrangement": { "timebase": { "ppq": 960, "tempoMap": tempo,
                "timeSignatures": signatures },
                "sections": sections,
                "master": { "fx": [], "automation": [], "gainDb": 0 } }
        }))
        .unwrap()
    }

    fn four_four() -> serde_json::Value {
        serde_json::json!([{ "bar": 0, "numerator": 4, "denominator": 4 }])
    }

    #[test]
    fn context_range_snaps_to_bar_lines() {
        // Eight bars of 4/4 at 120 bpm: 2 s per bar, 16 s total.
        let doc = context_project(
            serde_json::json!([{ "tick": 0, "bpm": 120, "curve": "step" }]),
            four_four(),
            &[30_720],
        );
        let edge = bar_aligned_context_range(&doc, ContextEdge::End, 5.0);
        // 4 s and 6 s are equally far from 5 s; the longer range wins.
        assert_eq!((edge.start_tick, edge.end_tick), (19_200, 30_720));
        assert_eq!(ticks_to_bar_beat(&doc, edge.start_tick), (5, 0.0));

        // 4.6 s is closer to two bars (4 s) than to three (6 s).
        let first = bar_aligned_context_range(&doc, ContextEdge::Start, 4.6);
        assert_eq!((first.start_tick, first.end_tick), (0, 7_680));
        assert_eq!(ticks_to_bar_beat(&doc, first.end_tick), (2, 0.0));
    }

    #[test]
    fn context_range_follows_a_tempo_change() {
        // Four bars at 120 bpm (8 s), then four at 60 bpm (16 s).
        let doc = context_project(
            serde_json::json!([
                { "tick": 0, "bpm": 120, "curve": "step" },
                { "tick": 15_360, "bpm": 60, "curve": "step" }
            ]),
            four_four(),
            &[15_360, 15_360],
        );
        let range = bar_aligned_context_range(&doc, ContextEdge::End, 10.0);
        // Two bars are 8 s and three are 12 s, both 2 s from the target; the
        // longer range wins and it spans the tempo change.
        assert_eq!((range.start_tick, range.end_tick), (19_200, 30_720));
        let seconds = TempoCtx::from_project(&doc).ticks_to_seconds(range.end_tick)
            - TempoCtx::from_project(&doc).ticks_to_seconds(range.start_tick);
        assert!((seconds - 12.0).abs() < 1e-9, "{seconds}");
    }

    #[test]
    fn context_range_uses_three_four_bars() {
        // Four bars of 4/4, then four of 3/4 at 120 bpm (1.5 s per bar).
        let doc = context_project(
            serde_json::json!([{ "tick": 0, "bpm": 120, "curve": "step" }]),
            serde_json::json!([
                { "bar": 0, "numerator": 4, "denominator": 4 },
                { "bar": 4, "numerator": 3, "denominator": 4 }
            ]),
            &[15_360, 11_520],
        );
        let range = bar_aligned_context_range(&doc, ContextEdge::End, 3.0);
        // Two 3/4 bars are exactly 3 s and start on bar 6.
        assert_eq!((range.start_tick, range.end_tick), (21_120, 26_880));
        assert_eq!(ticks_to_bar_beat(&doc, range.start_tick), (6, 0.0));
    }

    #[test]
    fn context_range_clamps_to_the_song() {
        let tempo = serde_json::json!([{ "tick": 0, "bpm": 120, "curve": "step" }]);
        // Shorter than one 4/4 bar: the whole song, since no bar line fits.
        let short = context_project(tempo.clone(), four_four(), &[1_920]);
        for edge in [ContextEdge::Start, ContextEdge::End] {
            let range = bar_aligned_context_range(&short, edge, 30.0);
            assert_eq!((range.start_tick, range.end_tick), (0, 1_920));
        }

        // 1.3 bars: the range stops on the last bar line, not mid-bar.
        let partial = context_project(tempo, four_four(), &[5_000]);
        let range = bar_aligned_context_range(&partial, ContextEdge::End, 30.0);
        assert_eq!((range.start_tick, range.end_tick), (0, 3_840));

        // A non-finite target degrades to the shortest range (one bar).
        let eight = context_project(
            serde_json::json!([{ "tick": 0, "bpm": 120, "curve": "step" }]),
            four_four(),
            &[30_720],
        );
        let range = bar_aligned_context_range(&eight, ContextEdge::End, f64::NAN);
        assert_eq!(range.end_tick - range.start_tick, 3_840);
    }
}
