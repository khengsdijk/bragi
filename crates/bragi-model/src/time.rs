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

use crate::generated::{Project, TempoCurve, TempoMap, TempoPoint, TimeSig, Timebase};

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
                seconds += self.segment_seconds(point, next, seg_len);
                continue;
            }
            let partial = ticks - seg_start;
            return seconds + self.segment_seconds(point, next, partial);
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
            let seg_seconds = self.segment_seconds(point, next, seg_len);
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

    /// Seconds spent over `len` ticks starting at a `curve` point with a `next` point.
    fn segment_seconds(&self, point: &TempoPoint, next: &TempoPoint, len: i64) -> f64 {
        if len <= 0 {
            return 0.0;
        }
        match point.curve {
            TempoCurve::Step => len as f64 * self.seconds_per_tick(point.bpm),
            TempoCurve::Linear => {
                let (b0, b1) = (point.bpm, next.bpm);
                if (b1 - b0).abs() < f64::EPSILON {
                    return len as f64 * self.seconds_per_tick(b0);
                }
                // bpm(s) = b0 + (b1 - b0) * s / len; ∫ ds / bpm(s) is a logarithm.
                let total = len as f64;
                let bpm_at_len = b0 + (b1 - b0);
                (60.0 / self.ppq as f64) * total / (b1 - b0) * (bpm_at_len / b0).ln()
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
}
