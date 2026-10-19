//! `width` (03 §6): M/S stereo width — mono at 0, bit-exact at 1, doubled side at 2.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{Effect, FxContext, FxKind};
use common::fx::{
    BLOCK, SR, assert_finite, assert_no_zipper, make, max_second_difference, run_stereo, set,
};
use common::signals::noise;

fn stereo(fx: &mut dyn Effect, left: &[f32], right: &[f32]) -> (Vec<f32>, Vec<f32>) {
    run_stereo(fx, left, right, &FxContext::default())
}

#[test]
fn zero_is_mono() {
    let mut fx = make(FxKind::Width);
    set(fx.as_mut(), "width", 0.0);
    fx.reset();
    let (l, r) = (
        noise(1, SR as usize / 10, 0.5),
        noise(2, SR as usize / 10, 0.5),
    );
    let (out_l, out_r) = stereo(fx.as_mut(), &l, &r);
    for (a, b) in out_l.iter().zip(&out_r) {
        assert!((a - b).abs() < 1e-7, "width 0 should be mono: {a} vs {b}");
    }
    for (a, (x, y)) in out_l.iter().zip(l.iter().zip(&r)) {
        assert!((a - (x + y) * 0.5).abs() < 1e-7);
    }
}

#[test]
fn one_is_bit_exact() {
    let mut fx = make(FxKind::Width);
    let (l, r) = (
        noise(3, SR as usize / 10, 0.5),
        noise(4, SR as usize / 10, 0.5),
    );
    let (out_l, out_r) = stereo(fx.as_mut(), &l, &r);
    assert_eq!(out_l, l);
    assert_eq!(out_r, r);
}

#[test]
fn two_doubles_the_side() {
    let mut fx = make(FxKind::Width);
    set(fx.as_mut(), "width", 2.0);
    fx.reset();
    let l = noise(5, 4096, 0.5);
    let r = noise(6, 4096, 0.5);
    let (out_l, out_r) = stereo(fx.as_mut(), &l, &r);
    for (((ol, or), x), y) in out_l.iter().zip(&out_r).zip(&l).zip(&r) {
        assert!((ol - (1.5 * x - 0.5 * y)).abs() < 1e-6);
        assert!((or - (1.5 * y - 0.5 * x)).abs() < 1e-6);
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Width);
    set(fx.as_mut(), "width", 5.0);
    fx.reset();
    let (mut l, mut r) = ([0.25f32; 4], [-0.25f32; 4]);
    fx.process(&mut l, &mut r, &FxContext::default());
    assert_finite(&l);
    assert_finite(&r);

    // NaN is ignored, so a fresh instance stays at its neutral default.
    let mut fx = make(FxKind::Width);
    set(fx.as_mut(), "width", f32::NAN);
    let (l, r) = (noise(9, 64, 0.5), noise(10, 64, 0.5));
    let (out_l, out_r) = stereo(fx.as_mut(), &l, &r);
    assert_eq!(out_l, l);
    assert_eq!(out_r, r);
    fx.set_param(99, 1.0); // out of range: ignored
}

/// The shared zipper check feeds the same signal to both channels, so the side is zero and width
/// cannot show. This variant uses a real side component.
fn assert_side_no_zipper(from: f32, to: f32, slack: f32) {
    let mut fx = make(FxKind::Width);
    set(fx.as_mut(), "width", from);
    fx.reset();
    let n = SR as usize;
    let left: Vec<f32> = (0..n)
        .map(|i| {
            0.25 * (2.0 * std::f64::consts::PI * 220.0 * i as f64 / f64::from(SR)).sin() as f32
        })
        .collect();
    let right: Vec<f32> = (0..n)
        .map(|i| {
            0.25 * (2.0 * std::f64::consts::PI * 220.0 * i as f64 / f64::from(SR)
                + std::f64::consts::FRAC_PI_2)
                .sin() as f32
        })
        .collect();
    let (mut l, mut r) = (left, right);
    let ctx = FxContext::default();
    let jump_at = n / 2 + BLOCK / 2;
    let mut start = 0;
    while start < n {
        let end = (start + BLOCK).min(n);
        if (start..end).contains(&jump_at) {
            let mid = jump_at;
            fx.process(&mut l[start..mid], &mut r[start..mid], &ctx);
            set(fx.as_mut(), "width", to);
            fx.process(&mut l[mid..end], &mut r[mid..end], &ctx);
        } else {
            fx.process(&mut l[start..end], &mut r[start..end], &ctx);
        }
        start = end;
    }
    let tenth = SR as usize / 10;
    for (name, x) in [("left", &l), ("right", &r)] {
        let before = max_second_difference(&x[n / 4..jump_at]);
        let settled = max_second_difference(&x[n - tenth..]);
        let during = max_second_difference(&x[jump_at - 2..jump_at + tenth]);
        let limit = before.max(settled) * slack + 1e-4;
        assert!(
            during <= limit,
            "width.{name} {from}→{to}: second difference {during} during vs {before}/{settled} (limit {limit})"
        );
    }
}

#[test]
fn steps_do_not_zipper() {
    assert_no_zipper(FxKind::Width, "width", 0.0, 2.0, 1.5);
    assert_no_zipper(FxKind::Width, "width", 2.0, 0.0, 1.5);
    assert_side_no_zipper(0.0, 2.0, 1.5);
    assert_side_no_zipper(2.0, 0.0, 1.5);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Width);
    set(fx.as_mut(), "width", 1.5);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
