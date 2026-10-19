//! `saturation` (03 §6): oversampled shaper, drive/tone behaviour, anti-aliasing, smoothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::f64::consts::PI;

use bragi_dsp::fx::{FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, rms, run_mono, set, sine_gain_db};
use common::signals::sine;

/// Amplitude of the exact-bin component at `freq_hz` in `x` (no window: `x` starts on a bin).
fn tone_amp(x: &[f32], freq_hz: f64) -> f64 {
    let n = x.len() as f64;
    let mut re = 0.0f64;
    let mut im = 0.0f64;
    for (i, &v) in x.iter().enumerate() {
        let phase = 2.0 * PI * freq_hz * i as f64 / f64::from(SR);
        re += f64::from(v) * phase.cos();
        im -= f64::from(v) * phase.sin();
    }
    2.0 * (re * re + im * im).sqrt() / n
}

fn set_all(fx: &mut dyn bragi_dsp::fx::Effect, drive: f32, tone: f32, mix: f32) {
    set(fx, "drive", drive);
    set(fx, "tone", tone);
    set(fx, "mix", mix);
    fx.reset();
}

#[test]
fn drive_zero_is_near_identity() {
    let mut fx = make(FxKind::Saturation);
    set_all(fx.as_mut(), 0.0, 0.0, 1.0);
    let measured = sine_gain_db(fx.as_mut(), 1000.0);
    // `tanh` itself costs ~0.13 dB of RMS on a −12 dBFS sine; that is the linear region's
    // cubic term, not a levelling error.
    assert!(
        measured.abs() < 0.2,
        "drive 0 gain {measured} dB (expected ±0.2 dB)"
    );
}

#[test]
fn oversampling_keeps_aliasing_below_the_bound() {
    // 5 kHz: the 5th/7th/9th harmonics sit above Nyquist and fold back to 23/13/3 kHz.
    let mut fx = make(FxKind::Saturation);
    set_all(fx.as_mut(), 1.0, 0.0, 1.0);
    let input = sine(5000.0, SR, SR as usize * 2, 0.3);
    let out = run_mono(fx.as_mut(), &input);
    let seg = &out[SR as usize..SR as usize + 12_000];
    let fundamental = tone_amp(seg, 5000.0);
    let mut alias = 0.0f64;
    for &bin in &[
        23_000.0, 13_000.0, 3_000.0, 7_000.0, 17_000.0, 21_000.0, 11_000.0,
    ] {
        let a = tone_amp(seg, bin);
        alias += a * a;
    }
    let ratio = alias.sqrt() / fundamental.max(1e-12);
    assert!(ratio < 0.06, "alias/fundamental {ratio:.4} (bound 0.06)");
}

#[test]
fn tone_controls_even_harmonics() {
    let input = sine(1000.0, SR, SR as usize, 0.3);
    let mut second = Vec::new();
    for tone in [0.0f32, 1.0] {
        let mut fx = make(FxKind::Saturation);
        set_all(fx.as_mut(), 0.8, tone, 1.0);
        let out = run_mono(fx.as_mut(), &input);
        let seg = &out[SR as usize / 2..SR as usize / 2 + 12_000];
        let fundamental = tone_amp(seg, 1000.0);
        second.push(tone_amp(seg, 2000.0) / fundamental.max(1e-12));
    }
    assert!(
        second[0] < 0.001,
        "tone 0 2nd harmonic {:.2e} (expected odd-only)",
        second[0]
    );
    assert!(
        second[1] > 20.0 * second[0].max(1e-9),
        "tone 1 2nd harmonic {:.4}, tone 0 {:.2e}",
        second[1],
        second[0]
    );
    assert!(second[1] > 0.02, "tone 1 2nd harmonic {:.4}", second[1]);
}

#[test]
fn drive_does_not_explode_loudness() {
    let input = sine(1000.0, SR, SR as usize, 0.25);
    let mut levels = Vec::new();
    for drive in [0.0f32, 0.5, 1.0] {
        let mut fx = make(FxKind::Saturation);
        set_all(fx.as_mut(), drive, 0.0, 1.0);
        let out = run_mono(fx.as_mut(), &input);
        levels.push(20.0 * (rms(&out[SR as usize / 2..]) / rms(&input[SR as usize / 2..])).log10());
    }
    for (drive, level) in [0.0f32, 0.5, 1.0].iter().zip(&levels) {
        assert!(
            level.abs() < 6.0,
            "drive {drive}: level change {level} dB (expected within ±6 dB)"
        );
    }
}

#[test]
fn steps_do_not_zipper() {
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        // Drive changes the waveform's shape (a clipped wave has much larger second
        // differences than a sine), so the settled state is compared against itself; 2.0 is
        // still tight enough to catch an unsmoothed step.
        assert_no_zipper(FxKind::Saturation, "drive", from, to, 2.0);
    }
    for (from, to) in [(-1.0, 1.0), (1.0, -1.0)] {
        assert_no_zipper(FxKind::Saturation, "tone", from, to, 2.0);
    }
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        assert_no_zipper(FxKind::Saturation, "mix", from, to, 2.0);
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Saturation);
    for name in ["drive", "tone", "mix"] {
        set(fx.as_mut(), name, f32::NAN);
    }
    set(fx.as_mut(), "drive", 1e9);
    set(fx.as_mut(), "tone", -1e9);
    set(fx.as_mut(), "mix", 1e9);
    fx.set_param(99, 1.0);
    fx.reset();
    let input = sine(1000.0, SR, 4096, 0.9);
    let out = run_mono(fx.as_mut(), &input);
    assert_finite(&out);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Saturation);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
