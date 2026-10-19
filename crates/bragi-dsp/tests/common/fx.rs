//! Shared checks for the FX catalogue tests (`fx_*.rs`). Every effect test uses the same
//! measures, so "no zipper noise" or "unity at defaults" means the same thing for every kind.

use bragi_dsp::fx::{Effect, FxContext, FxKind, create};

pub const SR: u32 = 48_000;
pub const BLOCK: usize = 128;

/// A fresh effect at its catalogue defaults.
pub fn make(kind: FxKind) -> Box<dyn Effect> {
    create(kind, SR, BLOCK).expect("create")
}

/// Sets `name` on `fx` (by catalogue name) and jumps to it, as a fresh plan would.
pub fn set(fx: &mut dyn Effect, name: &str, value: f32) {
    let index = fx.kind().param_index(name).expect("param");
    fx.set_param(index, value);
}

/// Runs `left`/`right` through `fx` in `BLOCK`-sized blocks with `ctx`.
pub fn run_stereo(
    fx: &mut dyn Effect,
    left: &[f32],
    right: &[f32],
    ctx: &FxContext<'_>,
) -> (Vec<f32>, Vec<f32>) {
    let (mut l, mut r) = (left.to_vec(), right.to_vec());
    let frames = l.len().min(r.len());
    let mut start = 0;
    while start < frames {
        let end = (start + BLOCK).min(frames);
        fx.process(&mut l[start..end], &mut r[start..end], ctx);
        start = end;
    }
    (l, r)
}

/// Runs a mono signal on both channels; returns the left output.
pub fn run_mono(fx: &mut dyn Effect, input: &[f32]) -> Vec<f32> {
    run_stereo(fx, input, input, &FxContext::default()).0
}

/// RMS of `x`.
pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>() / x.len() as f64).sqrt() as f32
}

/// RMS in dBFS.
pub fn rms_db(x: &[f32]) -> f32 {
    20.0 * rms(x).max(1e-12).log10()
}

/// The steady-state gain, in dB, of `fx` on a sine at `freq_hz` (measured after 0.25 s of
/// settling, over 0.25 s).
pub fn sine_gain_db(fx: &mut dyn Effect, freq_hz: f64) -> f32 {
    let n = SR as usize / 2;
    let input = super::signals::sine(freq_hz, SR, n, 0.25);
    let out = run_mono(fx, &input);
    rms_db(&out[n / 2..]) - rms_db(&input[n / 2..])
}

/// The largest second difference of `x` (a click shows up as a spike in |x[n] - 2x[n-1] + x[n-2]|).
pub fn max_second_difference(x: &[f32]) -> f32 {
    x.windows(3)
        .map(|w| (w[2] - 2.0 * w[1] + w[0]).abs())
        .fold(0.0, f32::max)
}

/// Zipper check: feeds a 220 Hz sine at −12 dBFS, jumps parameter `name` from `from` to `to`
/// in the middle of a block, and asserts that the output's largest second difference during the
/// transition (100 ms after the jump) stays within `slack` × the larger of the steady states
/// before the jump and after it has settled (the last 100 ms), plus a 1e-4 floor. A parameter
/// applied without smoothing produces a step, whose second difference is orders of magnitude
/// above a 220 Hz sine's.
pub fn assert_no_zipper(kind: FxKind, name: &str, from: f32, to: f32, slack: f32) {
    let mut fx = make(kind);
    set(fx.as_mut(), name, from);
    fx.reset();
    let n = SR as usize; // 1 s
    let input = super::signals::sine(220.0, SR, n, 0.25);
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
        "{}.{name} {from}→{to}: second difference {during} during the transition vs {before} before / {settled} settled (limit {limit})",
        kind.name()
    );
}

/// Every output sample is finite.
pub fn assert_finite(x: &[f32]) {
    assert!(x.iter().all(|v| v.is_finite()), "non-finite output");
}
