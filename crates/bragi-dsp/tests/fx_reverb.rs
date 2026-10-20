//! `reverb` (03 §6): the 8-line FDN.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{Effect, FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, run_stereo, set};
use common::signals::noise;

/// Runs a unit impulse through a fresh reverb and returns both channels.
fn impulse_response(fx: &mut dyn Effect, frames: usize) -> (Vec<f32>, Vec<f32>) {
    let mut impulse = vec![0.0f32; frames];
    impulse[0] = 1.0;
    run_stereo(fx, &impulse, &impulse, &FxContext::default())
}

/// Energy-decay-curve RT60 in seconds, fitted between −5 dB and −35 dB (Schroeder backwards
/// integration over both channels).
fn rt60_sec(left: &[f32], right: &[f32]) -> f64 {
    let n = left.len().min(right.len());
    let mut edc = vec![0.0f64; n];
    let mut acc = 0.0f64;
    for i in (0..n).rev() {
        acc += f64::from(left[i]) * f64::from(left[i]) + f64::from(right[i]) * f64::from(right[i]);
        edc[i] = acc;
    }
    let total = edc[0].max(1e-30);
    let db = |i: usize| 10.0 * (edc[i] / total).log10();
    let d5 = (0..n).find(|&i| db(i) <= -5.0).unwrap();
    let d35 = (0..n).find(|&i| db(i) <= -35.0).unwrap();
    let slope = (-35.0 - -5.0) / (d35 as f64 - d5 as f64);
    -60.0 / slope / f64::from(SR)
}

fn configured(decay: f32, predelay: f32, damping: f32, size: f32, mix: f32) -> Box<dyn Effect> {
    let mut fx = make(FxKind::Reverb);
    set(fx.as_mut(), "decaySec", decay);
    set(fx.as_mut(), "predelayMs", predelay);
    set(fx.as_mut(), "damping", damping);
    set(fx.as_mut(), "size", size);
    set(fx.as_mut(), "mix", mix);
    fx.reset();
    fx
}

#[test]
fn impulse_response_decays_to_minus_60_db_at_decay_sec() {
    // `size` moves the line lengths, so the fractional-delay interpolation loss (and the RT60
    // estimate) shifts a little; the catalogue tolerance is ±25 %.
    for (decay, size) in [(1.0f32, 0.0f32), (1.0, 0.5), (1.0, 1.0), (2.0, 0.5)] {
        let mut fx = configured(decay, 0.0, 0.0, size, 1.0);
        let (l, r) = impulse_response(fx.as_mut(), (4.0 * decay * SR as f32) as usize);
        assert_finite(&l);
        let measured = rt60_sec(&l, &r);
        assert!(
            (measured - f64::from(decay)).abs() <= 0.25 * f64::from(decay),
            "decaySec {decay}, size {size}: RT60 {measured:.3} s"
        );
    }
}

#[test]
fn predelay_is_honoured() {
    // 100 ms of pre-delay: the wet path is exactly silent before it (the FDN only taps its
    // lines). The first wet sample is one line length later.
    let mut fx = configured(1.0, 100.0, 0.0, 0.5, 1.0);
    let (l, r) = impulse_response(fx.as_mut(), 2 * SR as usize);
    let predelay = SR as usize / 10;
    assert!(
        l[..predelay].iter().all(|v| *v == 0.0),
        "wet before pre-delay"
    );
    assert!(
        r[..predelay].iter().all(|v| *v == 0.0),
        "wet before pre-delay"
    );
    let peak = l.iter().chain(&r).fold(0.0f32, |a, b| a.max(b.abs()));
    let onset = l.iter().position(|v| v.abs() > peak * 1e-3).unwrap();
    assert!(
        (predelay..=predelay + SR as usize / 16).contains(&onset),
        "onset at {onset} frames, expected just after {predelay}"
    );

    let mut fx = configured(1.0, 0.0, 0.0, 0.5, 1.0);
    let (l, _) = impulse_response(fx.as_mut(), SR as usize);
    let peak = l.iter().fold(0.0f32, |a, b| a.max(b.abs()));
    let onset = l.iter().position(|v| v.abs() > peak * 1e-3).unwrap();
    assert!(
        onset < SR as usize / 33,
        "no pre-delay gave onset at {onset}"
    );
}

#[test]
fn mix_zero_is_a_bit_exact_pass_through() {
    let mut fx = configured(2.0, 20.0, 0.5, 0.5, 0.0);
    let input = noise(1, SR as usize / 10, 0.5);
    let (l, r) = run_stereo(fx.as_mut(), &input, &input, &FxContext::default());
    assert_eq!(l, input);
    assert_eq!(r, input);
}

#[test]
fn stereo_output_is_decorrelated() {
    let mut fx = configured(1.0, 0.0, 0.0, 0.5, 1.0);
    let input = noise(3, SR as usize, 0.5);
    let (l, r) = run_stereo(fx.as_mut(), &input, &input, &FxContext::default());
    assert_finite(&l);
    let skip = SR as usize / 10;
    let (xs, ys) = (&l[skip..], &r[skip..]);
    let n = xs.len() as f64;
    let mx = xs.iter().map(|v| f64::from(*v)).sum::<f64>() / n;
    let my = ys.iter().map(|v| f64::from(*v)).sum::<f64>() / n;
    let cov: f64 = xs
        .iter()
        .zip(ys)
        .map(|(a, b)| (f64::from(*a) - mx) * (f64::from(*b) - my))
        .sum();
    let sx: f64 = xs.iter().map(|a| (f64::from(*a) - mx).powi(2)).sum();
    let sy: f64 = ys.iter().map(|b| (f64::from(*b) - my).powi(2)).sum();
    let corr = cov / (sx * sy).sqrt();
    assert!(corr.abs() < 0.5, "L/R correlation {corr}");
}

#[test]
fn tail_reports_the_decay() {
    for decay in [0.2f32, 2.0, 3.5, 12.0] {
        let mut fx = make(FxKind::Reverb);
        set(fx.as_mut(), "decaySec", decay);
        assert_eq!(fx.tail(), (decay * SR as f32) as usize);
    }
}

#[test]
fn stays_finite_at_extremes() {
    for (size, decay, predelay, damping, mix) in [
        (0.0f32, 0.2f32, 0.0f32, 0.0f32, 0.0f32),
        (1.0, 12.0, 200.0, 1.0, 1.0),
        (1.0, 0.2, 0.0, 1.0, 1.0),
        (0.0, 12.0, 200.0, 0.0, 1.0),
    ] {
        let mut fx = configured(decay, predelay, damping, size, mix);
        let input = noise(5, SR as usize / 4, 1.0);
        let (l, r) = run_stereo(fx.as_mut(), &input, &input, &FxContext::default());
        assert_finite(&l);
        assert_finite(&r);
        assert!(
            l.iter().chain(&r).all(|v| v.abs() < 20.0),
            "reverb blew up: {size}/{decay}/{predelay}/{damping}/{mix}"
        );
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Reverb);
    set(fx.as_mut(), "size", 9.0);
    set(fx.as_mut(), "decaySec", f32::NAN);
    fx.reset();
    let input = noise(7, 512, 0.5);
    let out = run_stereo(fx.as_mut(), &input, &input, &FxContext::default()).0;
    assert_finite(&out);
    fx.set_param(99, 1.0); // out of range: ignored
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Reverb);
    set(fx.as_mut(), "mix", 1.0);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}

#[test]
fn steps_do_not_zipper() {
    // `mix` keeps the FDN running while fully dry, so switching from dry to wet does not expose a
    // frozen tail.
    for (name, min, max) in [
        ("size", 0.0f32, 1.0f32),
        ("decaySec", 0.2, 12.0),
        ("predelayMs", 0.0, 200.0),
        ("damping", 0.0, 1.0),
        ("mix", 0.0, 1.0),
    ] {
        assert_no_zipper(FxKind::Reverb, name, min, max, 2.0);
        assert_no_zipper(FxKind::Reverb, name, max, min, 2.0);
    }
}
