//! Time mapping through the public API (`specs/02-song-model.md` §2.2, §8).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use bragi_model::generated::TempoPoint;
use bragi_model::{
    TempoCtx, apply, bar_beat_to_ticks, seconds_to_ticks, ticks_to_bar_beat, ticks_to_seconds,
};
use common::{BAR_TICKS, assets, fixture, user_batch};
use serde_json::json;

#[test]
fn constant_tempo_converts_both_ways() {
    let doc = fixture(); // 120 bpm, 4/4, PPQ 960
    assert!((ticks_to_seconds(&doc, 1920) - 1.0).abs() < 1e-12);
    assert_eq!(seconds_to_ticks(&doc, 1.0), 1920);
    assert_eq!(seconds_to_ticks(&doc, 0.0), 0);
    assert!((ticks_to_seconds(&doc, -1920) + 1.0).abs() < 1e-12);
}

#[test]
fn bar_and_beat_conversions_are_inverses() {
    let doc = fixture();
    assert_eq!(bar_beat_to_ticks(&doc, 0, 0.0), 0);
    assert_eq!(bar_beat_to_ticks(&doc, 0, 1.0), 960);
    assert_eq!(bar_beat_to_ticks(&doc, 2, 0.0), 2 * BAR_TICKS as i64);
    assert_eq!(ticks_to_bar_beat(&doc, 960), (0, 1.0));
    assert_eq!(
        ticks_to_bar_beat(&doc, 2 * BAR_TICKS as i64 + 480),
        (2, 0.5)
    );
}

#[test]
fn a_tempo_change_scales_the_conversion() {
    let doc = apply(
        &fixture(),
        &user_batch(vec![json!({ "op": "tempo.set", "tempoMap": [
            { "tick": 0, "bpm": 90, "curve": "step" } ] })]),
        &assets(),
    )
    .unwrap();
    // 1920 ticks at 90 bpm is 1920 * 60 / (90 * 960) seconds.
    let expected = 1920.0 * 60.0 / (90.0 * 960.0);
    assert!((ticks_to_seconds(&doc, 1920) - expected).abs() < 1e-12);
    assert_eq!(seconds_to_ticks(&doc, expected), 1920);
}

#[test]
fn a_linear_ramp_round_trips_through_seconds() {
    let points = vec![
        TempoPoint {
            tick: 0,
            bpm: 100.0,
            curve: bragi_model::generated::TempoCurve::Linear,
        },
        TempoPoint {
            tick: 3840,
            bpm: 160.0,
            curve: bragi_model::generated::TempoCurve::Step,
        },
        TempoPoint {
            tick: 7680,
            bpm: 120.0,
            curve: bragi_model::generated::TempoCurve::Step,
        },
    ];
    let ctx = TempoCtx::new(&points, 960);
    for tick in [0_i64, 1, 500, 3839, 3840, 5000, 7680, 12_000] {
        let seconds = ctx.ticks_to_seconds(tick);
        let back = ctx.seconds_to_ticks(seconds);
        assert!(
            (back - tick).abs() <= 1,
            "tick {tick} round-tripped to {back}"
        );
    }
    // The conversion is monotonic.
    let mut previous = f64::NEG_INFINITY;
    for tick in (0..8000).step_by(64) {
        let seconds = ctx.ticks_to_seconds(tick);
        assert!(seconds >= previous);
        previous = seconds;
    }
}
