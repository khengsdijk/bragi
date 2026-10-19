//! `delay` (03 §6): the tempo-synced stereo delay.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{Effect, FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, run_stereo, set};
use common::signals::noise;

fn configured(
    time_beats: f32,
    feedback: f32,
    tone: f32,
    ping_pong: f32,
    mix: f32,
) -> Box<dyn Effect> {
    let mut fx = make(FxKind::Delay);
    set(fx.as_mut(), "timeBeats", time_beats);
    set(fx.as_mut(), "feedback", feedback);
    set(fx.as_mut(), "tone", tone);
    set(fx.as_mut(), "pingPong", ping_pong);
    set(fx.as_mut(), "mix", mix);
    fx.reset();
    fx
}

fn impulse_response(fx: &mut dyn Effect, frames: usize, bpm: f64) -> (Vec<f32>, Vec<f32>) {
    let mut impulse = vec![0.0f32; frames];
    impulse[0] = 1.0;
    let ctx = FxContext {
        bpm,
        sidechain: None,
    };
    run_stereo(fx, &impulse, &impulse, &ctx)
}

/// The largest |sample| within `radius` frames of `centre`.
fn peak_near(x: &[f32], centre: usize, radius: usize) -> f32 {
    let lo = centre.saturating_sub(radius);
    let hi = (centre + radius).min(x.len());
    x[lo..hi].iter().fold(0.0f32, |a, b| a.max(b.abs()))
}

#[test]
fn echo_lands_at_time_beats_over_bpm() {
    for (bpm, time_beats) in [(120.0f64, 0.25f32), (90.0, 1.0), (140.0, 0.0625)] {
        let mut fx = configured(time_beats, 0.0, 1.0, 0.0, 1.0);
        let expected = (f64::from(time_beats) * 60.0 / bpm * f64::from(SR)) as usize;
        // Let the tempo target settle (a fresh plan knows the tempo on its first block).
        let (mut l, mut r) = (vec![0.0f32; 256], vec![0.0f32; 256]);
        fx.process(
            &mut l,
            &mut r,
            &FxContext {
                bpm,
                sidechain: None,
            },
        );
        fx.reset();
        let (l, _) = impulse_response(fx.as_mut(), expected + SR as usize / 2, bpm);
        let peak = l.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        let onset = l.iter().position(|v| v.abs() > peak * 0.5).unwrap();
        assert!(
            onset.abs_diff(expected) <= 2,
            "{time_beats} beats at {bpm} BPM: echo at {onset}, expected {expected}"
        );
    }
}

#[test]
fn feedback_decays_by_the_feedback_ratio() {
    let mut fx = configured(0.25, 0.5, 1.0, 0.0, 1.0);
    let (l, _) = impulse_response(fx.as_mut(), SR as usize, 120.0);
    let e1 = peak_near(&l, 6_000, 64);
    let e2 = peak_near(&l, 12_000, 64);
    let e3 = peak_near(&l, 18_000, 64);
    assert!(e1 > 0.2, "first echo too quiet: {e1}");
    assert!((e2 / e1 - 0.5).abs() < 0.05, "echo2/echo1 = {}", e2 / e1);
    assert!((e3 / e2 - 0.5).abs() < 0.05, "echo3/echo2 = {}", e3 / e2);
}

#[test]
fn ping_pong_alternates_channels() {
    let mut fx = configured(0.25, 0.6, 1.0, 1.0, 1.0);
    let mut impulse = vec![0.0f32; SR as usize];
    impulse[0] = 1.0;
    let silent = vec![0.0f32; SR as usize];
    let (l, r) = run_stereo(fx.as_mut(), &impulse, &silent, &FxContext::default());
    let (l1, r1) = (peak_near(&l, 6_000, 64), peak_near(&r, 6_000, 64));
    let (l2, r2) = (peak_near(&l, 12_000, 64), peak_near(&r, 12_000, 64));
    let (l3, r3) = (peak_near(&l, 18_000, 64), peak_near(&r, 18_000, 64));
    assert!(l1 > 0.2 && r1 < l1 * 0.05, "tap 1: L {l1}, R {r1}");
    assert!(r2 > 0.1 && l2 < r2 * 0.05, "tap 2: L {l2}, R {r2}");
    assert!(l3 > 0.05 && r3 < l3 * 0.05, "tap 3: L {l3}, R {r3}");
}

#[test]
fn tempo_change_is_followed() {
    // One beat at 120 BPM (0.5 s), then the tempo drops to 60 BPM (1 s).
    let mut fx = configured(1.0, 0.0, 1.0, 0.0, 1.0);
    let (mut l, mut r) = (vec![0.0f32; 256], vec![0.0f32; 256]);
    fx.process(
        &mut l,
        &mut r,
        &FxContext {
            bpm: 120.0,
            sidechain: None,
        },
    );
    fx.reset();
    let (l1, _) = impulse_response(fx.as_mut(), SR as usize, 120.0);
    assert!(
        peak_near(&l1, 24_000, 128) > 0.2,
        "120 BPM: no echo at 0.5 s"
    );

    // Now play 1.5 s of silence at 60 BPM, which glides the read position to 1 s.
    let frames = (1.5 * f64::from(SR)) as usize;
    let (mut l, mut r) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    fx.process(
        &mut l,
        &mut r,
        &FxContext {
            bpm: 60.0,
            sidechain: None,
        },
    );
    let (l2, _) = impulse_response(fx.as_mut(), 2 * SR as usize, 60.0);
    assert!(peak_near(&l2, 48_000, 256) > 0.2, "60 BPM: no echo at 1 s");
    assert!(
        peak_near(&l2, 24_000, 128) < 0.05,
        "60 BPM: stale echo at 0.5 s"
    );
}

#[test]
fn mix_zero_is_a_bit_exact_pass_through() {
    let mut fx = configured(0.25, 0.35, 0.5, 0.0, 0.0);
    let input = noise(1, SR as usize / 10, 0.5);
    let (l, r) = run_stereo(fx.as_mut(), &input, &input, &FxContext::default());
    assert_eq!(l, input);
    assert_eq!(r, input);
}

#[test]
fn tail_grows_with_feedback() {
    let quiet = configured(0.25, 0.1, 0.5, 0.0, 0.2);
    let quiet_tail = quiet.tail();
    let loud = configured(0.25, 0.9, 0.5, 0.0, 0.2);
    let loud_tail = loud.tail();
    assert!(quiet_tail > 0);
    assert!(loud_tail > quiet_tail, "{loud_tail} !> {quiet_tail}");

    // The longest musical time with maximum feedback is capped for offline renders.
    let mut extreme = configured(2.0, 0.95, 0.5, 0.0, 0.2);
    let (mut l, mut r) = (vec![0.0f32; 16], vec![0.0f32; 16]);
    extreme.process(
        &mut l,
        &mut r,
        &FxContext {
            bpm: 20.0,
            sidechain: None,
        },
    );
    assert_eq!(extreme.tail(), 60 * SR as usize);
}

#[test]
fn long_line_is_allocated_for_two_beats_at_20_bpm() {
    // The line must be able to hold 2 beats at 20 BPM = 6 s.
    let mut fx = configured(2.0, 0.0, 1.0, 0.0, 1.0);
    let (mut l, mut r) = (vec![0.0f32; 16], vec![0.0f32; 16]);
    fx.process(
        &mut l,
        &mut r,
        &FxContext {
            bpm: 20.0,
            sidechain: None,
        },
    );
    fx.reset();
    let mut impulse = vec![0.0f32; 6 * SR as usize + SR as usize];
    impulse[0] = 1.0;
    let silence = vec![0.0f32; impulse.len()];
    let (l, _) = run_stereo(
        fx.as_mut(),
        &impulse,
        &silence,
        &FxContext {
            bpm: 20.0,
            sidechain: None,
        },
    );
    assert!(peak_near(&l, 6 * SR as usize, 256) > 0.2, "no 6 s echo");
}

#[test]
fn stays_finite_at_extremes() {
    for (beats, feedback, tone, ping, mix) in [
        (0.0625f32, 0.0f32, 0.0f32, 0.0f32, 0.0f32),
        (2.0, 0.95, 1.0, 1.0, 1.0),
        (0.0625, 0.95, 0.0, 1.0, 1.0),
    ] {
        let mut fx = configured(beats, feedback, tone, ping, mix);
        let input = noise(5, SR as usize / 4, 1.0);
        let (l, r) = run_stereo(fx.as_mut(), &input, &input, &FxContext::default());
        assert_finite(&l);
        assert_finite(&r);
        assert!(l.iter().chain(&r).all(|v| v.abs() < 20.0), "delay blew up");
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Delay);
    set(fx.as_mut(), "timeBeats", 100.0);
    set(fx.as_mut(), "feedback", f32::NAN);
    fx.reset();
    let input = noise(7, 512, 0.5);
    let out = run_stereo(fx.as_mut(), &input, &input, &FxContext::default()).0;
    assert_finite(&out);
    fx.set_param(99, 1.0); // out of range: ignored
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Delay);
    set(fx.as_mut(), "mix", 1.0);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}

#[test]
fn steps_do_not_zipper() {
    for (name, min, max) in [
        ("timeBeats", 0.0625f32, 2.0f32),
        ("feedback", 0.0, 0.95),
        ("tone", 0.0, 1.0),
        ("pingPong", 0.0, 1.0),
        ("mix", 0.0, 1.0),
    ] {
        assert_no_zipper(FxKind::Delay, name, min, max, 2.0);
        assert_no_zipper(FxKind::Delay, name, max, min, 2.0);
    }
}
