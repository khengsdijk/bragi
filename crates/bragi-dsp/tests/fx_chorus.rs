//! `chorus` (03 §6): modulated delay voices, stereo spread, smoothing.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, run_mono, run_stereo, set};
use common::signals::{noise, sine};

fn chorus_with(rate: f32, depth: f32, mix: f32) -> Box<dyn bragi_dsp::fx::Effect> {
    let mut fx = make(FxKind::Chorus);
    set(fx.as_mut(), "rateHz", rate);
    set(fx.as_mut(), "depth", depth);
    set(fx.as_mut(), "mix", mix);
    fx.reset();
    fx
}

/// Delay positions (in frames) whose |amplitude| is above `0.05`, for an impulse at frame 0.
fn impulse_delays(depth: f32) -> Vec<usize> {
    let mut fx = chorus_with(0.5, depth, 1.0);
    let mut impulse = vec![0.0f32; SR as usize / 10];
    impulse[0] = 1.0;
    let out = run_mono(fx.as_mut(), &impulse);
    out.iter()
        .enumerate()
        .filter(|(_, v)| v.abs() > 0.05)
        .map(|(i, _)| i)
        .collect()
}

#[test]
fn mix_zero_is_bit_exact_dry() {
    let mut fx = chorus_with(0.6, 0.3, 0.0);
    let input = noise(9, SR as usize / 10, 0.5);
    assert_eq!(run_mono(fx.as_mut(), &input), input);
}

#[test]
fn depth_zero_gives_the_two_base_delays() {
    // 12 ms and 19 ms at 48 kHz.
    let delays = impulse_delays(0.0);
    let near = |target: usize| {
        delays
            .iter()
            .any(|d| (*d as isize - target as isize).abs() <= 1)
    };
    assert!(near(576), "no echo near 12 ms in {delays:?}");
    assert!(near(912), "no echo near 19 ms in {delays:?}");
    assert!(
        delays.iter().all(|d| (560..=930).contains(d)),
        "unexpected echo positions {delays:?}"
    );
}

#[test]
fn modulated_delay_stays_inside_the_depth_range() {
    // Base delays 12/19 ms, ±3 ms of modulation at full depth.
    let delays = impulse_delays(1.0);
    let min = 576 - 144 - 1;
    let max = 912 + 144 + 1;
    assert!(!delays.is_empty());
    assert!(
        delays
            .iter()
            .all(|d| ((min as isize)..=(max as isize)).contains(&(*d as isize))),
        "echo positions outside 9–22 ms: {delays:?}"
    );
    // The two voices are spread over the modulation range, not frozen at one delay.
    let spread = delays.iter().max().unwrap() - delays.iter().min().unwrap();
    assert!(spread >= 20, "modulation spread only {spread} frames");
}

#[test]
fn stereo_spread_decorrelates_a_mono_source() {
    let mut fx = chorus_with(0.6, 0.8, 1.0);
    let input = sine(440.0, SR, SR as usize / 4, 0.5);
    let (l, r) = run_stereo(fx.as_mut(), &input, &input, &FxContext::default());
    let difference = l
        .iter()
        .zip(&r)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    assert!(
        difference > 1e-3,
        "channels identical (max difference {difference})"
    );
}

#[test]
fn steps_do_not_zipper() {
    for (from, to) in [(0.05, 5.0), (5.0, 0.05)] {
        assert_no_zipper(FxKind::Chorus, "rateHz", from, to, 2.0);
    }
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        // depth changes the read position's slope, so a sine's second difference changes shape
        // while the delay glides; 2.0 still catches an unsmoothed jump.
        assert_no_zipper(FxKind::Chorus, "depth", from, to, 2.0);
    }
    for (from, to) in [(0.0, 1.0), (1.0, 0.0)] {
        assert_no_zipper(FxKind::Chorus, "mix", from, to, 2.0);
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Chorus);
    for name in ["rateHz", "depth", "mix"] {
        set(fx.as_mut(), name, f32::NAN);
    }
    set(fx.as_mut(), "rateHz", 1e9);
    set(fx.as_mut(), "depth", -1.0);
    set(fx.as_mut(), "mix", 1e9);
    fx.set_param(99, 1.0);
    fx.reset();
    let input = sine(440.0, SR, 4096, 1.0);
    let out = run_mono(fx.as_mut(), &input);
    assert_finite(&out);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Chorus);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
