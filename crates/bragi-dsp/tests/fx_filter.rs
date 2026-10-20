//! `filter` (03 §6): a 24 dB/oct SVF with LP/HP/BP, a transparent default, exponential cutoff
//! smoothing, a mode crossfade and finite/panic-free edges.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{FxContext, FxKind};
use common::fx::{
    BLOCK, SR, assert_finite, assert_no_zipper, make, max_second_difference, set, sine_gain_db,
};
use common::signals::sine;

/// Like `assert_no_zipper`, but sets extra parameters first so the swept one has an effect.
fn assert_no_zipper_with(pre: &[(&str, f32)], name: &str, from: f32, to: f32, slack: f32) {
    let mut fx = make(FxKind::Filter);
    for (param, value) in pre {
        set(fx.as_mut(), param, *value);
    }
    set(fx.as_mut(), name, from);
    fx.reset();
    let n = SR as usize;
    let input = sine(220.0, SR, n, 0.25);
    let (mut l, mut r) = (input.clone(), input.clone());
    let ctx = FxContext::default();
    let jump_at = n / 2 + BLOCK / 2;
    let mut start = 0;
    while start < n {
        let end = (start + BLOCK).min(n);
        if (start..end).contains(&jump_at) {
            let mid = jump_at;
            fx.process(&mut l[start..mid], &mut r[start..mid], &ctx);
            set(fx.as_mut(), name, to);
            fx.process(&mut l[mid..end], &mut r[mid..end], &ctx);
        } else {
            fx.process(&mut l[start..end], &mut r[start..end], &ctx);
        }
        start = end;
    }
    let tenth = SR as usize / 10;
    let before = max_second_difference(&l[n / 4..jump_at]);
    let settled = max_second_difference(&l[n - tenth..]);
    let during = max_second_difference(&l[jump_at - 2..jump_at + tenth]);
    let limit = before.max(settled) * slack + 1e-4;
    assert!(
        during <= limit,
        "{name} {from}→{to}: second difference {during} during vs {before}/{settled} (limit {limit})"
    );
}

/// The steady-state gain at `freq_hz` for a filter with `mode`/`cutoff`/`resonance` set.
fn gain(mode: f32, cutoff: f32, resonance: f32, freq_hz: f64) -> f32 {
    let mut fx = make(FxKind::Filter);
    set(fx.as_mut(), "mode", mode);
    set(fx.as_mut(), "cutoffHz", cutoff);
    set(fx.as_mut(), "resonance", resonance);
    fx.reset();
    sine_gain_db(fx.as_mut(), freq_hz)
}

#[test]
fn default_is_transparent_below_10khz() {
    // The spec pins 1 kHz: two 12 dB/oct sections at 20 kHz cost almost nothing there.
    let measured = gain(0.0, 20_000.0, 0.2, 1000.0);
    assert!(measured.abs() <= 0.1, "1 kHz at defaults: {measured} dB");
    let at_5k = gain(0.0, 20_000.0, 0.2, 5000.0);
    assert!(at_5k.abs() <= 1.0, "5 kHz at defaults: {at_5k} dB");
}

#[test]
fn lowpass_is_24_db_per_octave() {
    // Q = 0.707 (resonance 0): an octave above the 1 kHz corner is ~24.6 dB down.
    let measured = gain(0.0, 1000.0, 0.0, 2000.0);
    assert!(measured <= -21.0, "LP at 2 kHz: {measured} dB");
    let two_octaves = gain(0.0, 1000.0, 0.0, 4000.0);
    assert!(two_octaves <= -45.0, "LP at 4 kHz: {two_octaves} dB");
}

#[test]
fn highpass_is_24_db_per_octave() {
    let measured = gain(1.0, 1000.0, 0.0, 500.0);
    assert!(measured <= -21.0, "HP at 500 Hz: {measured} dB");
    let two_octaves = gain(1.0, 1000.0, 0.0, 250.0);
    assert!(two_octaves <= -45.0, "HP at 250 Hz: {two_octaves} dB");
}

#[test]
fn bandpass_has_a_peak_and_rejects_an_octave_out() {
    // The band tap of each SVF stage is normalised to unity peak, so the cascade peaks at 0 dB.
    let peak = gain(2.0, 1000.0, 1.0, 1000.0);
    assert!(peak.abs() <= 0.5, "BP peak at 1 kHz: {peak} dB");
    // A 2-pole band tap is 6 dB/oct per stage: one octave out is well past 21 dB at high Q.
    let above = gain(2.0, 1000.0, 1.0, 2000.0);
    let below = gain(2.0, 1000.0, 1.0, 500.0);
    assert!(above <= -21.0, "BP at 2 kHz: {above} dB");
    assert!(below <= -21.0, "BP at 500 Hz: {below} dB");
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Filter);
    set(fx.as_mut(), "mode", 7.0);
    set(fx.as_mut(), "cutoffHz", -100.0);
    set(fx.as_mut(), "resonance", f32::NAN);
    fx.reset();
    let mut l = [0.5f32; 64];
    let mut r = [-0.5f32; 64];
    fx.process(&mut l, &mut r, &FxContext::default());
    assert_finite(&l);
    assert_finite(&r);
    fx.set_param(99, 1.0); // out of range: ignored
}

#[test]
fn steps_do_not_zipper() {
    assert_no_zipper(FxKind::Filter, "cutoffHz", 20.0, 20_000.0, 1.5);
    assert_no_zipper(FxKind::Filter, "cutoffHz", 20_000.0, 20.0, 1.5);
    assert_no_zipper(FxKind::Filter, "resonance", 0.0, 1.0, 1.5);
    assert_no_zipper(FxKind::Filter, "resonance", 1.0, 0.0, 1.5);
    // Meaningful sweeps: with the corner near the tone, cutoff/resonance do change the output.
    assert_no_zipper_with(&[], "cutoffHz", 300.0, 3000.0, 1.5);
    assert_no_zipper_with(&[], "cutoffHz", 3000.0, 300.0, 1.5);
    assert_no_zipper_with(&[("cutoffHz", 1000.0)], "resonance", 0.0, 1.0, 1.5);
    assert_no_zipper_with(&[("cutoffHz", 1000.0)], "resonance", 1.0, 0.0, 1.5);
}

#[test]
fn mode_switch_crossfades() {
    // `mode` is discrete: LP → HP → BP must not step.
    assert_no_zipper(FxKind::Filter, "mode", 0.0, 1.0, 1.5);
    assert_no_zipper(FxKind::Filter, "mode", 1.0, 2.0, 1.5);
    assert_no_zipper(FxKind::Filter, "mode", 2.0, 0.0, 1.5);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Filter);
    set(fx.as_mut(), "cutoffHz", 500.0);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
