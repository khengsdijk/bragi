//! `eq3` (03 §6): flat at 0 dB, the three bands' gains match the RBJ magnitude response,
//! parameter steps glide, and edge cases stay finite and panic-free.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{BiquadCoeffs, FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, set, sine_gain_db};

/// A gain set before `reset` is exact, so the measured response is the settled filter's.
fn measure(name: &str, value: f32, freq_hz: f64) -> f32 {
    let mut fx = make(FxKind::Eq3);
    set(fx.as_mut(), name, value);
    fx.reset();
    sine_gain_db(fx.as_mut(), freq_hz)
}

#[test]
fn zero_db_is_flat() {
    for freq in [40.0, 120.0, 1000.0, 6000.0, 18_000.0] {
        let measured = measure("lowDb", 0.0, freq);
        assert!(
            measured.abs() <= 0.01,
            "flat at {freq} Hz, measured {measured} dB"
        );
    }
}

#[test]
fn low_shelf_gain_matches_the_rbj_response() {
    let expected = BiquadCoeffs::low_shelf(120.0, 12.0, SR).magnitude_db(120.0, SR);
    let measured = measure("lowDb", 12.0, 120.0);
    assert!(
        (measured - expected).abs() < 0.1,
        "low shelf at 120 Hz: expected {expected} dB, measured {measured} dB"
    );
    // A shelf reaches its full gain well below the corner, too.
    let expected_low = BiquadCoeffs::low_shelf(120.0, 12.0, SR).magnitude_db(30.0, SR);
    let measured_low = measure("lowDb", 12.0, 30.0);
    assert!((measured_low - expected_low).abs() < 0.1);
}

#[test]
fn mid_bell_gain_matches_the_rbj_response() {
    let mut fx = make(FxKind::Eq3);
    set(fx.as_mut(), "midDb", 9.0);
    set(fx.as_mut(), "midQ", 2.0);
    fx.reset();
    let expected = BiquadCoeffs::peaking(1000.0, 9.0, 2.0, SR).magnitude_db(1000.0, SR);
    let measured = sine_gain_db(fx.as_mut(), 1000.0);
    assert!(
        (measured - expected).abs() < 0.1,
        "mid bell at 1 kHz: expected {expected} dB, measured {measured} dB"
    );
}

#[test]
fn high_shelf_gain_matches_the_rbj_response() {
    let expected = BiquadCoeffs::high_shelf(6000.0, -12.0, SR).magnitude_db(6000.0, SR);
    let measured = measure("highDb", -12.0, 6000.0);
    assert!(
        (measured - expected).abs() < 0.1,
        "high shelf at 6 kHz: expected {expected} dB, measured {measured} dB"
    );
}

#[test]
fn the_three_bands_sum_in_db() {
    let mut fx = make(FxKind::Eq3);
    set(fx.as_mut(), "lowDb", 6.0);
    set(fx.as_mut(), "midDb", -9.0);
    set(fx.as_mut(), "highDb", 3.0);
    fx.reset();
    for freq in [60.0f32, 120.0, 1000.0, 6000.0, 12_000.0] {
        let expected = BiquadCoeffs::low_shelf(120.0, 6.0, SR).magnitude_db(freq, SR)
            + BiquadCoeffs::peaking(1000.0, -9.0, 0.7, SR).magnitude_db(freq, SR)
            + BiquadCoeffs::high_shelf(6000.0, 3.0, SR).magnitude_db(freq, SR);
        let measured = sine_gain_db(fx.as_mut(), f64::from(freq));
        assert!(
            (measured - expected).abs() < 0.15,
            "combined at {freq} Hz: expected {expected} dB, measured {measured} dB"
        );
    }
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::Eq3);
    set(fx.as_mut(), "lowDb", 100.0);
    set(fx.as_mut(), "midDb", f32::NAN);
    set(fx.as_mut(), "midHz", -5.0);
    set(fx.as_mut(), "midQ", f32::INFINITY);
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
    for (name, from, to) in [
        ("lowDb", -18.0, 18.0),
        ("midDb", -18.0, 18.0),
        ("highDb", -18.0, 18.0),
        ("lowHz", 40.0, 400.0),
        ("midHz", 300.0, 5000.0),
        ("highHz", 2000.0, 12_000.0),
        ("midQ", 0.3, 4.0),
    ] {
        assert_no_zipper(FxKind::Eq3, name, from, to, 1.5);
        assert_no_zipper(FxKind::Eq3, name, to, from, 1.5);
    }
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::Eq3);
    set(fx.as_mut(), "lowDb", 6.0);
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}
