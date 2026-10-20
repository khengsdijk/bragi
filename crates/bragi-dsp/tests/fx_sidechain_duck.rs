//! `sidechain_duck` (03 §6): ducking by another track's envelope.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use bragi_dsp::fx::{Effect, FxContext, FxKind};
use common::fx::{BLOCK, SR, assert_finite, assert_no_zipper, make, run_stereo, set};
use common::signals::noise;

const PROBE: f32 = 0.25;

/// Runs `probe` through `fx` block by block, handing each block its slice of `key` (as the engine
/// does); `key` shorter than the input is silent beyond its end; `None` is no key at all.
fn run_keyed(fx: &mut dyn Effect, probe: &[f32], key: Option<&[f32]>, bpm: f64) -> Vec<f32> {
    let mut l = probe.to_vec();
    let n = l.len();
    let mut start = 0;
    while start < n {
        let end = (start + BLOCK).min(n);
        let ctx = match key {
            Some(key) => {
                let hi = end.min(key.len());
                let kl = if start < hi { &key[start..hi] } else { &[] };
                let kr = kl;
                FxContext {
                    bpm,
                    sidechain: Some((kl, kr)),
                }
            }
            None => FxContext {
                bpm,
                sidechain: None,
            },
        };
        let mut r = vec![0.0f32; end - start];
        // Both channels get the probe, so the stereo output mirrors the mono gain.
        for (dst, src) in r.iter_mut().zip(&l[start..end]) {
            *dst = *src;
        }
        fx.process(&mut l[start..end], &mut r, &ctx);
        start = end;
    }
    l
}

/// The gain in dB at `index` (the probe is a constant `PROBE`, so the output is the gain).
fn gain_db(out: &[f32], index: usize) -> f32 {
    let half = 20;
    let lo = index - half;
    let hi = index + half;
    let avg = out[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
    20.0 * (avg.abs() / PROBE).log10()
}

/// The gain in dB averaged over `[lo, hi)`.
fn gain_db_range(out: &[f32], lo: usize, hi: usize) -> f32 {
    let avg = out[lo..hi].iter().sum::<f32>() / (hi - lo) as f32;
    20.0 * (avg.abs() / PROBE).log10()
}

fn configured(amount_db: f32, release_ms: f32) -> Box<dyn Effect> {
    let mut fx = make(FxKind::SidechainDuck);
    set(fx.as_mut(), "amountDb", amount_db);
    set(fx.as_mut(), "releaseMs", release_ms);
    fx.reset();
    fx
}

#[test]
fn full_scale_key_ducks_by_amount_db() {
    for amount in [6.0f32, 12.0, 24.0] {
        let n = SR as usize;
        let mut fx = configured(amount, 150.0);
        let probe = vec![PROBE; n];
        let key = vec![1.0f32; n]; // 0 dBFS
        let l = run_keyed(fx.as_mut(), &probe, Some(&key), 120.0);
        let measured = -gain_db(&l, n - 100);
        assert!(
            (measured - amount).abs() < 1.0,
            "amountDb {amount}: measured reduction {measured:.2} dB"
        );
        assert_finite(&l);
    }
}

#[test]
fn key_level_scales_the_reduction() {
    let n = SR as usize;
    let mut fx = configured(12.0, 150.0);
    let probe = vec![PROBE; n];
    let key = vec![0.5f32; n]; // −6 dBFS: half the reduction
    let l = run_keyed(fx.as_mut(), &probe, Some(&key), 120.0);
    let measured = -gain_db(&l, n - 100);
    assert!(
        (measured - 6.0).abs() < 0.5,
        "half-scale key: measured reduction {measured:.2} dB"
    );
}

#[test]
fn attack_is_fast() {
    // The 1 ms attack time constant reaches 63 %; by 5 ms the duck is within 1 dB of full depth.
    let n = SR as usize / 20;
    let mut fx = configured(12.0, 150.0);
    let probe = vec![PROBE; n];
    let key = vec![1.0f32; n];
    let l = run_keyed(fx.as_mut(), &probe, Some(&key), 120.0);
    let at_1ms = -gain_db(&l, (SR / 1000) as usize);
    let at_5ms = -gain_db(&l, (5 * SR / 1000) as usize);
    assert!(at_1ms > 7.0, "1 ms after onset: {at_1ms:.2} dB");
    assert!(at_5ms > 11.0, "5 ms after onset: {at_5ms:.2} dB");
}

#[test]
fn release_follows_release_ms() {
    // One release time after the key stops, the reduction should be `amount · 1/e`.
    let amount = 12.0f32;
    let release_ms = 200.0f32;
    let on = SR as usize / 2;
    let off = SR as usize;
    let mut fx = configured(amount, release_ms);
    let probe = vec![PROBE; on + off];
    let mut key = vec![1.0f32; on + off];
    key[on..].fill(0.0);
    let l = run_keyed(fx.as_mut(), &probe, Some(&key), 120.0);
    let frame = on + (release_ms * 1e-3 * SR as f32) as usize;
    let measured = -gain_db(&l, frame);
    let expected = amount * (-1.0f32).exp();
    assert!(
        (measured - expected).abs() < 1.5,
        "at one release time: {measured:.2} dB, expected {expected:.2} dB"
    );
    // Fully recovered shortly after.
    assert!(-gain_db(&l, on + off - 100) < 0.5);
}

#[test]
fn no_key_is_identity() {
    let mut fx = configured(24.0, 20.0);
    let input = noise(1, SR as usize / 10, 0.5);
    let (l, r) = run_stereo(fx.as_mut(), &input, &input, &FxContext::default());
    assert_eq!(l, input);
    assert_eq!(r, input);
}

#[test]
fn short_key_is_silent_beyond_its_end() {
    // A 32-frame key inside the first 128-frame block ducks far less than a full-length key, and
    // past its end the envelope releases.
    let n = 2048usize;
    let probe = vec![PROBE; n];
    let full_key = vec![1.0f32; n];
    let short_key = vec![1.0f32; 32];
    let mut full = configured(24.0, 50.0);
    let mut short = configured(24.0, 50.0);
    let l_full = run_keyed(full.as_mut(), &probe, Some(&full_key), 120.0);
    let l_short = run_keyed(short.as_mut(), &probe, Some(&short_key), 120.0);
    let duck_full = -gain_db_range(&l_full, 200, 232);
    let duck_short = -gain_db_range(&l_short, 200, 232);
    assert!(
        duck_full - duck_short > 8.0,
        "full {duck_full:.1} dB, short {duck_short:.1} dB"
    );
    // Past its end the key is silent, so the envelope releases towards unity.
    let later = -gain_db_range(&l_short, n - 256, n - 1);
    assert!(
        later < duck_short - 3.0,
        "no release: {duck_short:.1} → {later:.1} dB"
    );
}

#[test]
fn clamps_and_ignores_nan() {
    let mut fx = make(FxKind::SidechainDuck);
    set(fx.as_mut(), "amountDb", 100.0);
    set(fx.as_mut(), "releaseMs", f32::NAN);
    fx.reset();
    let n = 256;
    let probe = vec![PROBE; n];
    let key = vec![1.0f32; n];
    let l = run_keyed(fx.as_mut(), &probe, Some(&key), 120.0);
    assert_finite(&l);
    fx.set_param(99, 1.0); // out of range: ignored
}

#[test]
fn mismatched_slices_do_not_panic() {
    let mut fx = make(FxKind::SidechainDuck);
    let key = vec![1.0f32; 3];
    let ctx = FxContext {
        bpm: 120.0,
        sidechain: Some((&key, &key)),
    };
    let mut l = [0.5f32; 8];
    let mut r = [0.5f32; 3];
    fx.process(&mut l, &mut r, &ctx);
    fx.process(&mut [], &mut [], &FxContext::default());
    fx.process(&mut [0.5; 4], &mut [0.5; 4], &FxContext::default());
}

#[test]
fn steps_do_not_zipper() {
    // With no key the duck is identity, so these prove that the parameter glide itself inserts
    // no steps (the keyed path is a single smoothed gain by construction).
    for (name, min, max) in [("amountDb", 0.0f32, 24.0f32), ("releaseMs", 20.0, 800.0)] {
        assert_no_zipper(FxKind::SidechainDuck, name, min, max, 2.0);
        assert_no_zipper(FxKind::SidechainDuck, name, max, min, 2.0);
    }
}
