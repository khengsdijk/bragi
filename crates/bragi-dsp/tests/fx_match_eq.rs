//! `match_eq` (03 §6, §8.2): the 31-band system EQ.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{FxContext, FxKind};
use common::fx::{SR, assert_finite, assert_no_zipper, make, run_mono, set, sine_gain_db};
use common::signals::noise;

/// The ISO 1/3-octave centres the implementation must use.
const CENTRES_HZ: [f32; 31] = [
    20.0, 25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0,
    500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0, 5000.0, 6300.0,
    8000.0, 10_000.0, 12_500.0, 16_000.0, 20_000.0,
];

#[test]
fn flat_is_a_bit_exact_pass_through() {
    let mut fx = make(FxKind::MatchEq);
    let input = noise(1, SR as usize / 10, 0.5);
    assert_eq!(run_mono(fx.as_mut(), &input), input);

    // `amount` 0 is flat even with non-zero bands, once settled.
    let mut fx = make(FxKind::MatchEq);
    set(fx.as_mut(), "band17", 12.0);
    set(fx.as_mut(), "amount", 0.0);
    fx.reset();
    assert_eq!(run_mono(fx.as_mut(), &input), input);

    // Returning a band to 0 restores the pass-through after it settles.
    let mut fx = make(FxKind::MatchEq);
    set(fx.as_mut(), "band17", 12.0);
    fx.reset();
    let _ = run_mono(fx.as_mut(), &input);
    set(fx.as_mut(), "band17", 0.0);
    fx.reset();
    assert_eq!(run_mono(fx.as_mut(), &input), input);
}

#[test]
fn band_gain_at_its_centre() {
    let mut fx = make(FxKind::MatchEq);
    set(fx.as_mut(), "band17", 6.0); // 1 kHz
    fx.reset();
    let at_centre = sine_gain_db(fx.as_mut(), 1000.0);
    assert!(
        (at_centre - 6.0).abs() < 0.5,
        "1 kHz band: {at_centre:.2} dB at its centre"
    );
    let far_below = sine_gain_db(fx.as_mut(), 100.0);
    let far_above = sine_gain_db(fx.as_mut(), 10_000.0);
    assert!(far_below.abs() < 0.2, "100 Hz: {far_below:.2} dB");
    assert!(far_above.abs() < 0.2, "10 kHz: {far_above:.2} dB");
}

#[test]
fn amount_scales_every_band() {
    let mut fx = make(FxKind::MatchEq);
    set(fx.as_mut(), "band17", 12.0);
    set(fx.as_mut(), "amount", 0.5);
    fx.reset();
    let measured = sine_gain_db(fx.as_mut(), 1000.0);
    assert!(
        (measured - 6.0).abs() < 0.5,
        "amount 0.5 of 12 dB: {measured:.2} dB"
    );

    // A low and a high band, scaled together.
    let mut fx = make(FxKind::MatchEq);
    set(fx.as_mut(), "band7", -8.0); // 100 Hz
    set(fx.as_mut(), "band27", 8.0); // 10 kHz
    set(fx.as_mut(), "amount", 0.25);
    fx.reset();
    let low = sine_gain_db(fx.as_mut(), 100.0);
    let high = sine_gain_db(fx.as_mut(), 10_000.0);
    assert!(
        (low - -2.0).abs() < 0.5,
        "100 Hz at amount 0.25: {low:.2} dB"
    );
    assert!(
        (high - 2.0).abs() < 0.5,
        "10 kHz at amount 0.25: {high:.2} dB"
    );
}

#[test]
fn every_band_centre_is_the_iso_grid() {
    // Moving one band at a time, the response peaks (or dips) at that band's centre.
    for (band, centre) in CENTRES_HZ.iter().enumerate() {
        let mut fx = make(FxKind::MatchEq);
        set(fx.as_mut(), &format!("band{band}"), 12.0);
        fx.reset();
        let at_centre = sine_gain_db(fx.as_mut(), f64::from(*centre));
        assert!(
            at_centre > 6.0,
            "band{band} ({centre} Hz): only {at_centre:.2} dB at its centre"
        );
    }
}

#[test]
fn stays_finite_at_extremes() {
    let mut fx = make(FxKind::MatchEq);
    for band in 0..31 {
        set(
            fx.as_mut(),
            &format!("band{band}"),
            if band % 2 == 0 { 18.0 } else { -18.0 },
        );
    }
    set(fx.as_mut(), "amount", 1.0);
    fx.reset();
    let input = noise(5, SR as usize / 4, 1.0);
    let out = run_mono(fx.as_mut(), &input);
    assert_finite(&out);
    // 31 overlapping +18 dB bells boost a lot, but the response stays bounded (no runaway).
    assert!(out.iter().all(|v| v.abs() < 200.0), "match_eq blew up");
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::MatchEq);
    set(fx.as_mut(), "band0", 100.0); // clamps to +18
    set(fx.as_mut(), "band1", f32::NAN); // ignored
    set(fx.as_mut(), "amount", f32::NAN); // ignored
    fx.reset();
    let input = noise(7, 4096, 0.5);
    let out = run_mono(fx.as_mut(), &input);
    assert_finite(&out);
    assert!(
        out.iter().zip(&input).any(|(a, b)| (a - b).abs() > 1e-4),
        "a clamped band should still process"
    );
    fx.set_param(99, 1.0); // out of range: ignored
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::MatchEq);
    set(fx.as_mut(), "band17", 6.0);
    fx.reset();
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &FxContext::default());
    fx.process(&mut [], &mut [], &FxContext::default());
}

#[test]
fn steps_do_not_zipper() {
    assert_no_zipper(FxKind::MatchEq, "amount", 0.0, 1.0, 2.0);
    assert_no_zipper(FxKind::MatchEq, "amount", 1.0, 0.0, 2.0);
    for band in 0..31 {
        assert_no_zipper(FxKind::MatchEq, &format!("band{band}"), -18.0, 18.0, 2.0);
        assert_no_zipper(FxKind::MatchEq, &format!("band{band}"), 18.0, -18.0, 2.0);
    }
}
