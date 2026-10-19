//! `gain` (03 §6), plus the shared behaviour every effect keeps, proven on the simplest one.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{FxContext, FxKind, db_to_lin};
use common::fx::{SR, assert_no_zipper, make, run_mono, set, sine_gain_db};
use common::signals::noise;

#[test]
fn zero_db_is_a_bit_exact_pass_through() {
    let mut fx = make(FxKind::Gain);
    let input = noise(1, SR as usize / 10, 0.5);
    assert_eq!(run_mono(fx.as_mut(), &input), input);
}

#[test]
fn settles_at_the_requested_gain() {
    for db in [-60.0f32, -12.0, -6.0, 0.0, 6.0, 12.0] {
        let mut fx = make(FxKind::Gain);
        set(fx.as_mut(), "db", db);
        let measured = sine_gain_db(fx.as_mut(), 1000.0);
        assert!((measured - db).abs() < 0.01, "{db} dB → {measured} dB");
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Gain);
    set(fx.as_mut(), "db", 40.0);
    fx.reset();
    let mut l = [1.0f32; 4];
    let mut r = [1.0f32; 4];
    fx.process(&mut l, &mut r, &FxContext::default());
    assert!((l[0] - db_to_lin(12.0)).abs() < 1e-5);
    set(fx.as_mut(), "db", f32::NAN);
    fx.reset();
    fx.process(&mut l, &mut r, &FxContext::default());
    assert!(l.iter().all(|v| v.is_finite()));
    fx.set_param(99, 1.0); // out of range: ignored
}

#[test]
fn steps_do_not_zipper() {
    assert_no_zipper(FxKind::Gain, "db", -60.0, 12.0, 1.5);
    assert_no_zipper(FxKind::Gain, "db", 12.0, -60.0, 1.5);
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Gain);
    set(fx.as_mut(), "db", -6.0);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
