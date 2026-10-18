//! Clip geometry: where a clip ends and how its source samples map onto ticks.
//!
//! A [`Clip`] window is stored in samples while its position is stored in ticks, and the two are
//! related by its [`Warp`] (`specs/02-song-model.md` §3.6). These helpers are the single definition
//! of that mapping, used by `validate` (overlaps), `section.resize`/`split`, and `region.clear`.
//!
//! In `beatgrid` mode an anchor's `tick` is **section-relative**, the same frame as `clip.start`: it
//! says at which tick of the section that source sample plays. That is not stated in 02 §3.6, so it
//! is recorded here and in the spec.

use crate::assets::AssetIndex;
use crate::generated::{Clip, Warp, WarpAnchor};
use crate::time::TempoCtx;

/// The clip's end tick **relative to the section start** (the same frame as `clip.start`).
///
/// Returns `None` when the clip's asset is not in `assets` and the warp needs the sample rate
/// (`none` and `stretch`). `beatgrid` needs no asset metadata.
///
/// ```
/// # use bragi_model::generated::Clip;
/// # use bragi_model::{AssetIndex, TempoCtx};
/// let clip: Clip = serde_json::from_value(serde_json::json!({
///     "id": "clp_01", "asset": format!("sha256:{}", "0".repeat(64)),
///     "srcStart": 0, "srcEnd": 48000, "start": 960,
///     "warp": { "mode": "beatgrid", "anchors": [ { "srcSample": 0, "tick": 960 },
///                                                { "srcSample": 48000, "tick": 2880 } ] },
///     "gainDb": 0, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
///     "fadeCurve": "equal_power",
///     "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" }
/// })).unwrap();
/// let tempo = TempoCtx::new(&[], 960);
/// // 48000 samples span 1920 ticks between the anchors, starting at tick 960.
/// assert_eq!(bragi_model::clip_end_local(&clip, &tempo, &AssetIndex::new(), 0), Some(2880));
/// ```
#[must_use]
pub fn clip_end_local(
    clip: &Clip,
    tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_abs_start: i64,
) -> Option<i64> {
    match &clip.warp {
        Warp::Beatgrid(beatgrid) => sample_to_tick(&beatgrid.anchors, clip.src_end),
        Warp::Stretch(stretch) => {
            let sample_rate = assets.sample_rate(&clip.asset)? as f64;
            let ratio = if stretch.ratio > 0.0 {
                stretch.ratio
            } else {
                1.0
            };
            let seconds =
                (clip.src_end.saturating_sub(clip.src_start)) as f64 / sample_rate / ratio;
            Some(clip.start + duration_ticks(tempo, section_abs_start + clip.start, seconds))
        }
        Warp::None(_) => {
            let sample_rate = assets.sample_rate(&clip.asset)? as f64;
            let seconds = (clip.src_end.saturating_sub(clip.src_start)) as f64 / sample_rate;
            Some(clip.start + duration_ticks(tempo, section_abs_start + clip.start, seconds))
        }
    }
}

/// The source sample playing at section-relative tick `local`.
///
/// This is the inverse of [`local_at_src_sample`] and is what `clip.split`/`section.split` use to
/// keep both halves of a clip sample-accurate.
#[must_use]
pub fn src_sample_at_local(
    clip: &Clip,
    tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_abs_start: i64,
    local: i64,
) -> Option<u64> {
    match &clip.warp {
        Warp::Beatgrid(beatgrid) => tick_to_sample(&beatgrid.anchors, local),
        Warp::Stretch(stretch) => {
            let sample_rate = assets.sample_rate(&clip.asset)? as f64;
            let ratio = if stretch.ratio > 0.0 {
                stretch.ratio
            } else {
                1.0
            };
            let seconds = tempo.ticks_to_seconds(section_abs_start + local)
                - tempo.ticks_to_seconds(section_abs_start + clip.start);
            Some(clip.src_start + (seconds * sample_rate * ratio).round().max(0.0) as u64)
        }
        Warp::None(_) => {
            let sample_rate = assets.sample_rate(&clip.asset)? as f64;
            let seconds = tempo.ticks_to_seconds(section_abs_start + local)
                - tempo.ticks_to_seconds(section_abs_start + clip.start);
            Some(clip.src_start + (seconds * sample_rate).round().max(0.0) as u64)
        }
    }
}

/// The section-relative tick at which source sample `sample` plays.
#[must_use]
pub fn local_at_src_sample(
    clip: &Clip,
    tempo: &TempoCtx<'_>,
    assets: &AssetIndex,
    section_abs_start: i64,
    sample: u64,
) -> Option<i64> {
    match &clip.warp {
        Warp::Beatgrid(beatgrid) => sample_to_tick(&beatgrid.anchors, sample),
        Warp::Stretch(stretch) => {
            let sample_rate = assets.sample_rate(&clip.asset)? as f64;
            let ratio = if stretch.ratio > 0.0 {
                stretch.ratio
            } else {
                1.0
            };
            let seconds = sample.saturating_sub(clip.src_start) as f64 / sample_rate / ratio;
            Some(clip.start + duration_ticks(tempo, section_abs_start + clip.start, seconds))
        }
        Warp::None(_) => {
            let sample_rate = assets.sample_rate(&clip.asset)? as f64;
            let seconds = sample.saturating_sub(clip.src_start) as f64 / sample_rate;
            Some(clip.start + duration_ticks(tempo, section_abs_start + clip.start, seconds))
        }
    }
}

/// Rounds a duration in seconds to ticks, anchored at an absolute tick.
fn duration_ticks(tempo: &TempoCtx<'_>, abs_start: i64, seconds: f64) -> i64 {
    let end = tempo.seconds_to_ticks(tempo.ticks_to_seconds(abs_start) + seconds.max(0.0));
    (end - abs_start).max(0)
}

/// Piecewise-linear map from a source sample to a section-relative tick.
fn sample_to_tick(anchors: &[WarpAnchor], sample: u64) -> Option<i64> {
    let (first, last) = (anchors.first()?, anchors.last()?);
    if anchors.len() < 2 {
        // A single anchor cannot define a rate; fall back to `start` (the caller's tick frame).
        return Some(first.tick);
    }
    if sample <= first.src_sample {
        return Some(interpolate(first, anchors.get(1)?, sample));
    }
    for pair in anchors.windows(2) {
        if sample <= pair[1].src_sample {
            return Some(interpolate(&pair[0], &pair[1], sample));
        }
    }
    // Beyond the last anchor, continue at the final segment's slope.
    Some(interpolate(&anchors[anchors.len() - 2], last, sample))
}

/// Piecewise-linear inverse map from a section-relative tick to a source sample.
fn tick_to_sample(anchors: &[WarpAnchor], tick: i64) -> Option<u64> {
    let (first, last) = (anchors.first()?, anchors.last()?);
    if anchors.len() < 2 {
        return Some(first.src_sample);
    }
    if tick <= first.tick {
        return Some(inverse_interpolate(first, anchors.get(1)?, tick));
    }
    for pair in anchors.windows(2) {
        if tick <= pair[1].tick {
            return Some(inverse_interpolate(&pair[0], &pair[1], tick));
        }
    }
    Some(inverse_interpolate(&anchors[anchors.len() - 2], last, tick))
}

fn interpolate(a: &WarpAnchor, b: &WarpAnchor, sample: u64) -> i64 {
    let src_delta = b.src_sample as i64 - a.src_sample as i64;
    if src_delta <= 0 {
        return a.tick;
    }
    let tick_delta = b.tick - a.tick;
    a.tick + ((sample as i64 - a.src_sample as i64) * tick_delta).div_euclid(src_delta)
}

fn inverse_interpolate(a: &WarpAnchor, b: &WarpAnchor, tick: i64) -> u64 {
    let tick_delta = b.tick - a.tick;
    if tick_delta <= 0 {
        return a.src_sample;
    }
    let src_delta = b.src_sample as i64 - a.src_sample as i64;
    let offset = (tick - a.tick) * src_delta;
    a.src_sample
        .saturating_add(offset.div_euclid(tick_delta).max(0) as u64)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::generated::{AssetMeta, Clip};

    fn clip(warp: serde_json::Value) -> Clip {
        serde_json::from_value(serde_json::json!({
            "id": "clp_01", "asset": format!("sha256:{}", "0".repeat(64)),
            "srcStart": 0, "srcEnd": 48000, "start": 0, "warp": warp,
            "gainDb": 0, "pitchSemitones": 0, "fadeInTicks": 0, "fadeOutTicks": 0,
            "fadeCurve": "equal_power",
            "provenance": { "kind": "user", "createdAt": "2026-10-18T12:00:00Z" }
        }))
        .unwrap()
    }

    fn assets() -> AssetIndex {
        AssetIndex::from_metas([serde_json::from_value::<AssetMeta>(serde_json::json!({
            "hash": format!("sha256:{}", "0".repeat(64)),
            "mime": "audio/flac", "bytes": 1, "sampleRate": 48000, "channels": 2,
            "durationSamples": 480_000
        }))
        .unwrap()])
    }

    #[test]
    fn beatgrid_maps_samples_to_ticks() {
        let clip = clip(serde_json::json!({
            "mode": "beatgrid",
            "anchors": [ { "srcSample": 0, "tick": 0 }, { "srcSample": 24000, "tick": 960 } ]
        }));
        let tempo = TempoCtx::new(&[], 960);
        assert_eq!(clip_end_local(&clip, &tempo, &assets(), 0), Some(1920));
        assert_eq!(
            src_sample_at_local(&clip, &tempo, &assets(), 0, 480),
            Some(12000)
        );
        assert_eq!(
            local_at_src_sample(&clip, &tempo, &assets(), 0, 24000),
            Some(960)
        );
    }

    #[test]
    fn none_and_stretch_use_the_sample_rate() {
        let none = clip(serde_json::json!({ "mode": "none" }));
        let tempo = TempoCtx::new(&[], 960);
        // 48000 samples at 48 kHz is 1 s = 1920 ticks at 120 bpm.
        assert_eq!(clip_end_local(&none, &tempo, &assets(), 0), Some(1920));
        assert_eq!(
            src_sample_at_local(&none, &tempo, &assets(), 0, 960),
            Some(24000)
        );

        let stretch = clip(serde_json::json!({ "mode": "stretch", "ratio": 2.0 }));
        // ratio 2 halves the playback duration to 0.5 s = 960 ticks.
        assert_eq!(clip_end_local(&stretch, &tempo, &assets(), 0), Some(960));
    }

    #[test]
    fn missing_asset_is_none_not_a_panic() {
        let none = clip(serde_json::json!({ "mode": "none" }));
        let tempo = TempoCtx::new(&[], 960);
        assert_eq!(clip_end_local(&none, &tempo, &AssetIndex::new(), 0), None);
    }
}
