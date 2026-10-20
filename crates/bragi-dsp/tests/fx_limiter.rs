//! `limiter` (03 §6): look-ahead, true-peak ceiling, transparency, release, smoothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{Effect, FxContext, FxKind, db_to_lin};
use common::fx::{SR, assert_finite, assert_no_zipper, make, run_mono, set};
use common::signals::{noise, sine};

/// Catmull-Rom reconstruction of the continuous signal between `p1` and `p2`.
fn catmull(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    let t2 = t * t;
    let t3 = t2 * t;
    0.5 * (2.0 * p1
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3)
}

/// The ×4 true-peak estimate: sample peaks plus the cubic values between every pair.
fn true_peak(x: &[f32]) -> f32 {
    let mut peak = x.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
    for w in x.windows(4) {
        for t in [0.25f32, 0.5, 0.75] {
            peak = peak.max(catmull(w[0], w[1], w[2], w[3], t).abs());
        }
    }
    peak
}

fn limiter_with(ceiling: f32, release: f32) -> Box<dyn Effect> {
    let mut fx = make(FxKind::Limiter);
    set(fx.as_mut(), "ceilingDb", ceiling);
    set(fx.as_mut(), "releaseMs", release);
    fx.reset();
    fx
}

#[test]
fn latency_is_five_ms_and_delays_the_signal() {
    let fx = make(FxKind::Limiter);
    let latency = fx.latency();
    assert_eq!(latency, 240, "5 ms at 48 kHz");
    let mut fx = limiter_with(-1.0, 50.0);

    let mut impulse = vec![0.0f32; 1024];
    impulse[0] = 0.5;
    let out = run_mono(fx.as_mut(), &impulse);
    let (peak_index, _) = out
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
        .unwrap();
    assert!(
        (peak_index as isize - latency as isize).abs() <= 1,
        "impulse peak at {peak_index}, latency {latency}"
    );
}

#[test]
fn never_exceeds_the_ceiling_including_true_peak() {
    let ceiling_db = -1.0f32;
    let ceiling = db_to_lin(ceiling_db);
    let frames = SR as usize;
    let mut signals = Vec::new();
    // A 12 kHz sine at 45°: sample peaks are 0.707 but the true peak is 1.0.
    let mut high = sine(12_000.0, SR, frames, 1.0);
    for (i, v) in high.iter_mut().enumerate() {
        let phase = std::f64::consts::PI * 12_000.0 * i as f64 / f64::from(SR);
        *v = (phase + std::f64::consts::FRAC_PI_4).sin() as f32;
    }
    signals.push(high);
    signals.push(sine(1000.0, SR, frames, 1.0));
    signals.push(noise(11, frames, 1.0));

    for input in signals {
        let mut fx = limiter_with(ceiling_db, 50.0);
        let out = run_mono(fx.as_mut(), &input);
        let sample_peak = out.iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        assert!(
            sample_peak <= ceiling + 1e-4,
            "sample peak {sample_peak} above ceiling {ceiling}"
        );
        let tp = true_peak(&out);
        assert!(
            tp <= ceiling * 1.001,
            "true peak {tp} above ceiling {ceiling}"
        );
        assert_finite(&out);
    }
}

#[test]
fn transparent_below_the_ceiling() {
    let latency = make(FxKind::Limiter).latency();
    let mut fx = limiter_with(-1.0, 50.0);
    let input = sine(1000.0, SR, SR as usize / 2, 0.1); // −20 dBFS
    let out = run_mono(fx.as_mut(), &input);
    for i in latency..input.len() {
        assert!(
            (out[i] - input[i - latency]).abs() < 1e-6,
            "output differs at {i}: {} vs {}",
            out[i],
            input[i - latency]
        );
    }
}

#[test]
fn release_recovers_after_a_burst() {
    let burst = SR as usize / 5;
    let probe = SR as usize;
    let mut input = sine(1000.0, SR, burst, 2.0);
    input.extend(sine(1000.0, SR, probe, 0.1));

    let mut levels = Vec::new();
    for release in [10.0f32, 500.0] {
        let mut fx = limiter_with(-6.0, release);
        let out = run_mono(fx.as_mut(), &input);
        // 50–100 ms into the probe, well after the delayed burst has left.
        let from = burst + SR as usize / 20;
        let to = burst + SR as usize / 10;
        levels.push(out[from..to].iter().map(|v| v.abs()).fold(0.0f32, f32::max));
    }
    assert!(
        levels[0] > 2.0 * levels[1],
        "release 10 ms probe peak {:.4}, release 500 ms {:.4}",
        levels[0],
        levels[1]
    );
    assert!(
        levels[0] > 0.08,
        "release 10 ms should recover to the 0.1 probe ({:.4})",
        levels[0]
    );
}

#[test]
fn steps_do_not_zipper() {
    for (from, to) in [(-6.0, 0.0), (0.0, -6.0)] {
        assert_no_zipper(FxKind::Limiter, "ceilingDb", from, to, 2.0);
    }
    for (from, to) in [(1.0, 500.0), (500.0, 1.0)] {
        assert_no_zipper(FxKind::Limiter, "releaseMs", from, to, 2.0);
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Limiter);
    for name in ["ceilingDb", "releaseMs"] {
        set(fx.as_mut(), name, f32::NAN);
    }
    set(fx.as_mut(), "ceilingDb", 12.0);
    set(fx.as_mut(), "releaseMs", -100.0);
    fx.set_param(99, 1.0);
    fx.reset();
    let input = sine(1000.0, SR, 4096, 1.0);
    let out = run_mono(fx.as_mut(), &input);
    assert_finite(&out);
    assert!(out.iter().all(|v| v.abs() <= db_to_lin(0.0) + 1e-4));
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Limiter);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
