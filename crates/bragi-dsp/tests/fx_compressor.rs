//! `compressor` (03 §6): static curve, ballistics, linked stereo, smoothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{FxContext, FxKind, db_to_lin};
use common::fx::{
    BLOCK, SR, assert_finite, assert_no_zipper, make, rms, run_mono, set, sine_gain_db,
};
use common::signals::{noise, sine};

/// A square wave of amplitude `amp` (peak == RMS, so the detector sees `amp` exactly).
fn square(amp: f32, frames: usize) -> Vec<f32> {
    (0..frames)
        .map(|i| if (i / 32) % 2 == 0 { amp } else { -amp })
        .collect()
}

#[test]
fn static_curve_is_four_db_of_reduction_six_db_over_threshold() {
    // Threshold −12 dB, input at −6 dBFS (6 dB over), ratio 3:1 → (6)(1 − 1/3) = 4 dB.
    let mut fx = make(FxKind::Compressor);
    set(fx.as_mut(), "thresholdDb", -12.0);
    set(fx.as_mut(), "ratio", 3.0);
    set(fx.as_mut(), "attackMs", 1.0);
    set(fx.as_mut(), "releaseMs", 100.0);
    set(fx.as_mut(), "makeupDb", 0.0);
    set(fx.as_mut(), "mix", 1.0);
    fx.reset();

    let amp = db_to_lin(-6.0);
    let input = square(amp, SR as usize);
    let out = run_mono(fx.as_mut(), &input);
    let settled_in = rms(&input[input.len() / 2..]);
    let settled_out = rms(&out[out.len() / 2..]);
    let reduction = 20.0 * (settled_out / settled_in).log10();
    assert!(
        (reduction + 4.0).abs() < 0.5,
        "gain reduction {reduction} dB, expected −4 dB ± 0.5"
    );
}

/// Time until `out` (a square burst) has fallen to within 10 % of its settled amplitude, in ms.
fn time_to_90_percent(out: &[f32], start: usize, settled: f32) -> f32 {
    let threshold = 1.1 * settled;
    for (i, v) in out.iter().enumerate().skip(start) {
        if v.abs() <= threshold {
            return (i - start) as f32 * 1000.0 / SR as f32;
        }
    }
    f32::INFINITY
}

#[test]
fn attack_and_release_timing_follow_the_parameters() {
    // Attack: a step into a loud square; a shorter attack reaches the settled gain sooner.
    let mut measured = Vec::new();
    for attack in [1.0f32, 50.0] {
        let mut fx = make(FxKind::Compressor);
        set(fx.as_mut(), "thresholdDb", -30.0);
        set(fx.as_mut(), "ratio", 10.0);
        set(fx.as_mut(), "attackMs", attack);
        set(fx.as_mut(), "releaseMs", 200.0);
        set(fx.as_mut(), "mix", 1.0);
        fx.reset();
        let burst = square(0.5, SR as usize);
        let out = run_mono(fx.as_mut(), &burst);
        // Settled amplitude of the last 100 ms.
        let settled = out[out.len() - SR as usize / 10..]
            .iter()
            .map(|v| v.abs())
            .fold(0.0f32, f32::max);
        measured.push(time_to_90_percent(&out, 0, settled));
    }
    assert!(
        measured[0] < measured[1],
        "attack 1 ms took {} ms, attack 50 ms took {} ms",
        measured[0],
        measured[1]
    );

    // Release: a loud burst, then a quiet probe; the 10 ms release lets the probe through sooner.
    let mut recovered = Vec::new();
    for release in [10.0f32, 500.0] {
        let mut fx = make(FxKind::Compressor);
        set(fx.as_mut(), "thresholdDb", -18.0);
        set(fx.as_mut(), "ratio", 4.0);
        set(fx.as_mut(), "attackMs", 1.0);
        set(fx.as_mut(), "releaseMs", release);
        set(fx.as_mut(), "mix", 1.0);
        fx.reset();
        let burst = SR as usize / 2;
        let probe = square(0.01, SR as usize);
        let mut input = square(0.5, burst);
        input.extend_from_slice(&probe);
        let out = run_mono(fx.as_mut(), &input);
        // RMS of the probe 100–150 ms after the burst: near 0.01 once released.
        let from = burst + SR as usize / 10;
        let to = burst + 3 * SR as usize / 20;
        recovered.push(rms(&out[from..to]));
    }
    assert!(
        recovered[0] > 1.5 * recovered[1],
        "release 10 ms probe {:.5}, release 500 ms probe {:.5}",
        recovered[0],
        recovered[1]
    );
}

#[test]
fn mix_zero_is_bit_exact_dry() {
    let mut fx = make(FxKind::Compressor);
    set(fx.as_mut(), "mix", 0.0);
    fx.reset();
    let input = noise(3, SR as usize / 10, 0.5);
    assert_eq!(run_mono(fx.as_mut(), &input), input);
}

#[test]
fn makeup_raises_the_settled_level() {
    let mut fx = make(FxKind::Compressor);
    set(fx.as_mut(), "thresholdDb", 0.0); // never compress a −20 dBFS sine
    set(fx.as_mut(), "makeupDb", 6.0);
    set(fx.as_mut(), "mix", 1.0);
    fx.reset();
    let measured = sine_gain_db(fx.as_mut(), 1000.0);
    assert!(
        (measured - 6.0).abs() < 0.1,
        "makeup 6 dB measured {measured} dB"
    );
}

#[test]
fn steps_do_not_zipper() {
    for (from, to) in [(-60.0, 0.0), (0.0, -60.0)] {
        assert_no_zipper(FxKind::Compressor, "thresholdDb", from, to, 2.0);
    }
    for (from, to) in [(1.0, 20.0), (20.0, 1.0)] {
        assert_no_zipper(FxKind::Compressor, "ratio", from, to, 2.0);
    }
    for (from, to) in [(0.1, 100.0), (100.0, 0.1)] {
        assert_no_zipper(FxKind::Compressor, "attackMs", from, to, 2.0);
    }
    for (from, to) in [(10.0, 1000.0), (1000.0, 10.0)] {
        assert_no_zipper(FxKind::Compressor, "releaseMs", from, to, 2.0);
    }
    for (from, to) in [(0.0, 24.0), (24.0, 0.0)] {
        assert_no_zipper(FxKind::Compressor, "makeupDb", from, to, 2.0);
    }
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        assert_no_zipper(FxKind::Compressor, "mix", from, to, 2.0);
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Compressor);
    for name in [
        "thresholdDb",
        "ratio",
        "attackMs",
        "releaseMs",
        "makeupDb",
        "mix",
    ] {
        set(fx.as_mut(), name, f32::NAN);
    }
    set(fx.as_mut(), "thresholdDb", 100.0);
    set(fx.as_mut(), "ratio", -10.0);
    set(fx.as_mut(), "attackMs", 0.0);
    set(fx.as_mut(), "releaseMs", 1e9);
    set(fx.as_mut(), "makeupDb", 1e9);
    set(fx.as_mut(), "mix", 1e9);
    fx.set_param(99, 1.0);
    fx.reset();
    let input = sine(220.0, SR, BLOCK * 4, 0.5);
    let out = run_mono(fx.as_mut(), &input);
    assert_finite(&out);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Compressor);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
