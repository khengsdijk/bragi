//! `transient` (03 §6): the onset/sustain ratio moves with `attack`, `sustain` shapes the decay,
//! 0/0 is bit-exact, and steps glide without zipper noise.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, rms, run_mono, set};
use common::signals::{Rng, noise, sine};

/// A plucked-note train: every half second, a short attack and a ~50 ms noise decay. Unlike a
/// click train this has real sustain energy to shape.
fn plucks() -> Vec<f32> {
    let n = SR as usize * 2;
    let period = SR as usize / 2;
    let mut out = vec![0.0f32; n];
    let mut rng = Rng::new(11);
    let attack_tau = 0.002 * f64::from(SR);
    let decay_tau = 0.05 * f64::from(SR);
    let mut hit = 0;
    while hit < n {
        for (k, s) in out[hit..].iter_mut().take(period).enumerate() {
            let t = k as f64;
            let env = (1.0 - (-t / attack_tau).exp()) * (-t / decay_tau).exp();
            *s += (0.6 * env) as f32 * rng.bipolar();
        }
        hit += period;
    }
    out
}

/// Onset/tail energy ratio: energy in the first 15 ms after each pluck over energy 90–190 ms in.
fn onset_over_tail(output: &[f32]) -> f32 {
    let period = SR as usize / 2;
    let (onset, tail) = (
        SR as usize * 15 / 1000,
        (SR as usize * 9 / 100, SR as usize * 19 / 100),
    );
    let mut onsets = Vec::new();
    let mut tails = Vec::new();
    let mut hit = 0;
    while hit + tail.1 < output.len() {
        onsets.push(rms(&output[hit..hit + onset]));
        tails.push(rms(&output[hit + tail.0..hit + tail.1]));
        hit += period;
    }
    let onset_energy: f32 = onsets.iter().map(|v| v * v).sum();
    let tail_energy: f32 = tails.iter().map(|v| v * v).sum();
    (onset_energy / tail_energy.max(1e-20)).max(1e-20)
}

fn shaped(attack: f32, sustain: f32) -> Vec<f32> {
    let mut fx = make(FxKind::Transient);
    set(fx.as_mut(), "attack", attack);
    set(fx.as_mut(), "sustain", sustain);
    fx.reset();
    run_mono(fx.as_mut(), &plucks())
}

#[test]
fn zero_is_a_bit_exact_pass_through() {
    let mut fx = make(FxKind::Transient);
    let input = noise(1, SR as usize / 10, 0.5);
    assert_eq!(run_mono(fx.as_mut(), &input), input);
}

#[test]
fn attack_raises_the_onset_ratio() {
    let neutral = onset_over_tail(&shaped(0.0, 0.0));
    let boosted = onset_over_tail(&shaped(1.0, 0.0));
    let reduced = onset_over_tail(&shaped(-1.0, 0.0));
    assert!(
        boosted > neutral * 2.0,
        "attack +1 should raise the onset/tail ratio: {neutral} → {boosted}"
    );
    assert!(
        reduced < neutral * 0.7,
        "attack −1 should lower the onset/tail ratio: {neutral} → {reduced}"
    );
}

#[test]
fn sustain_raises_the_tail() {
    let neutral = onset_over_tail(&shaped(0.0, 0.0));
    let body = onset_over_tail(&shaped(0.0, 1.0));
    assert!(
        body < neutral * 0.7,
        "sustain +1 should lift the tail (lowering the ratio): {neutral} → {body}"
    );
}

#[test]
fn gain_is_bounded_to_12_db() {
    // A full-scale click through attack +1 must not exceed ~4× (+12 dB).
    let mut fx = make(FxKind::Transient);
    set(fx.as_mut(), "attack", 1.0);
    set(fx.as_mut(), "sustain", 1.0);
    fx.reset();
    let input = sine(2000.0, SR, SR as usize, 0.9);
    let output = run_mono(fx.as_mut(), &input);
    assert_finite(&output);
    for (o, i) in output.iter().zip(&input) {
        let ratio = o.abs() / i.abs().max(1e-9);
        assert!(ratio <= 4.01, "gain {ratio} exceeds +12 dB");
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Transient);
    set(fx.as_mut(), "attack", 5.0);
    set(fx.as_mut(), "sustain", f32::NAN);
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
    assert_no_zipper(FxKind::Transient, "attack", -1.0, 1.0, 1.5);
    assert_no_zipper(FxKind::Transient, "attack", 1.0, -1.0, 1.5);
    assert_no_zipper(FxKind::Transient, "sustain", -1.0, 1.0, 1.5);
    assert_no_zipper(FxKind::Transient, "sustain", 1.0, -1.0, 1.5);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Transient);
    set(fx.as_mut(), "attack", 0.5);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
