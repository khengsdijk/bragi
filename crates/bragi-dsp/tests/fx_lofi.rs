//! `lofi` (03 §6): sample-and-hold, bit depth, wow, hiss, smoothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, rms_db, run_mono, set};
use common::signals::{noise, sine};

fn lofi_with(
    bits: f32,
    rate: f32,
    wow: f32,
    noise: f32,
    mix: f32,
) -> Box<dyn bragi_dsp::fx::Effect> {
    let mut fx = make(FxKind::Lofi);
    set(fx.as_mut(), "bits", bits);
    set(fx.as_mut(), "rateHz", rate);
    set(fx.as_mut(), "wow", wow);
    set(fx.as_mut(), "noise", noise);
    set(fx.as_mut(), "mix", mix);
    fx.reset();
    fx
}

#[test]
fn defaults_are_within_one_16_bit_step() {
    // Mid-rise 16-bit quantisation over −1..1: step 2⁻¹⁵, so every sample is within 2⁻¹⁶.
    let mut fx = lofi_with(16.0, 48_000.0, 0.0, 0.0, 1.0);
    let input = noise(5, SR as usize / 5, 0.5);
    let out = run_mono(fx.as_mut(), &input);
    let worst = out
        .iter()
        .zip(&input)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    let bound = 2f32.powi(-16) + 1e-6; // half a 16-bit step, plus f32 rounding
    assert!(
        worst <= bound,
        "worst error {worst} above 2^-16 + 1e-6 = {bound}"
    );
}

#[test]
fn four_bits_uses_sixteen_levels_on_a_1_8_step() {
    let mut fx = lofi_with(4.0, 48_000.0, 0.0, 0.0, 1.0);
    let input = sine(220.0, SR, SR as usize / 5, 0.95);
    let out = run_mono(fx.as_mut(), &input);
    let step = 2.0 / 16.0;
    let mut levels = Vec::new();
    for &v in &out {
        let k = (v + 1.0 - step * 0.5) / step;
        assert!(
            (k - k.round()).abs() < 1e-3,
            "value {v} is not on the 1/8 grid (k = {k})"
        );
        let level = ((k.round() as i32).clamp(0, 15)) as f32 * step - 1.0 + step * 0.5;
        if !levels.iter().any(|&l: &f32| (l - level).abs() < 1e-5) {
            levels.push(level);
        }
    }
    assert!(
        levels.len() <= 16,
        "4 bits produced {} levels",
        levels.len()
    );
    assert!(
        levels.len() >= 14,
        "a 0.95 sine should visit most levels, got {}",
        levels.len()
    );
}

#[test]
fn rate_reduction_holds_each_sample_for_six_frames() {
    // 8 kHz at 48 kHz: one hold every six frames.
    let mut fx = lofi_with(16.0, 8_000.0, 0.0, 0.0, 1.0);
    let input = sine(220.0, SR, SR as usize / 5, 0.5);
    let out = run_mono(fx.as_mut(), &input);
    let mut longest = 1usize;
    let mut run = 1usize;
    for i in 1..out.len() {
        if out[i] == out[i - 1] {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 1;
        }
    }
    assert!(
        (5..=7).contains(&longest),
        "longest hold {longest} frames (expected about 6)"
    );
}

#[test]
fn noise_sits_at_the_documented_level_and_wow_changes_the_signal() {
    let silence = vec![0.0f32; SR as usize / 5];
    let mut fx = lofi_with(16.0, 48_000.0, 0.0, 1.0, 1.0);
    let hiss = run_mono(fx.as_mut(), &silence);
    let level = rms_db(&hiss);
    assert!(
        (-40.0..=-30.0).contains(&level),
        "full hiss RMS {level} dBFS (expected about −35 dBFS)"
    );

    let mut quiet = lofi_with(16.0, 48_000.0, 0.0, 0.0, 1.0);
    // 16-bit quantisation of silence lands on the grid's centre (+half a step), not exactly 0.
    let quiet_out = run_mono(quiet.as_mut(), &silence);
    assert!(
        quiet_out.iter().all(|v| v.abs() < 1e-4),
        "silence should stay within a 16-bit step of zero"
    );

    let input = sine(220.0, SR, SR as usize / 5, 0.5);
    let mut wow = lofi_with(16.0, 48_000.0, 1.0, 0.0, 1.0);
    let dry = run_mono(quiet.as_mut(), &input);
    let moved = run_mono(wow.as_mut(), &input);
    assert!(
        dry.iter().zip(&moved).any(|(a, b)| (a - b).abs() > 1e-3),
        "wow did not move the signal"
    );
}

#[test]
fn steps_do_not_zipper() {
    for (from, to) in [(4.0, 16.0), (16.0, 4.0)] {
        // A 4-bit staircase has larger second differences than a sine at 16 bits, so the
        // settled 4-bit state is the fair reference; 2.0 is still tight.
        assert_no_zipper(FxKind::Lofi, "bits", from, to, 2.0);
    }
    for (from, to) in [(2000.0, 48_000.0), (48_000.0, 2000.0)] {
        assert_no_zipper(FxKind::Lofi, "rateHz", from, to, 2.0);
    }
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        // Wow is a modulated delay: it bends the local pitch, so a sine's second difference
        // legitimately changes shape over the glide. 3.0 still catches an unsmoothed jump.
        assert_no_zipper(FxKind::Lofi, "wow", from, to, 3.0);
    }
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        assert_no_zipper(FxKind::Lofi, "noise", from, to, 2.0);
    }
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        assert_no_zipper(FxKind::Lofi, "mix", from, to, 2.0);
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Lofi);
    for name in ["bits", "rateHz", "wow", "noise", "mix"] {
        set(fx.as_mut(), name, f32::NAN);
    }
    set(fx.as_mut(), "bits", 1e9);
    set(fx.as_mut(), "rateHz", -1.0);
    set(fx.as_mut(), "wow", 1e9);
    set(fx.as_mut(), "noise", 1e9);
    set(fx.as_mut(), "mix", 1e9);
    fx.set_param(99, 1.0);
    fx.reset();
    let input = sine(220.0, SR, 4096, 1.0);
    let out = run_mono(fx.as_mut(), &input);
    assert_finite(&out);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Lofi);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
