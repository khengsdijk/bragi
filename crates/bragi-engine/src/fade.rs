//! Fade curves and the per-sample gain of a clip fade.
//!
//! `specs/02-song-model.md` §3.6 gives three curves. All three are defined for
//! `x ∈ [0, 1]` and return `0` at `x = 0`, `1` at `x = 1`. They are pure and
//! allocation-free.
//!
//! ```
//! use bragi_engine::fade::{curve_gain, FadeShape};
//! assert_eq!(curve_gain(FadeShape::Linear, 0.0), 0.0);
//! assert_eq!(curve_gain(FadeShape::Linear, 1.0), 1.0);
//! assert!((curve_gain(FadeShape::EqualPower, 0.5) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
//! ```

use bragi_model::generated::FadeCurve;

/// The engine's own copy of the schema's fade curve, so the renderer does not
/// depend on the generated enum's layout on the hot path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FadeShape {
    /// A straight line.
    Linear,
    /// `sin(πx/2)`: two equal-power fades sum to a constant power.
    EqualPower,
    /// Smoothstep `x²(3 − 2x)`, with zero slope at both ends.
    SCurve,
}

impl From<FadeCurve> for FadeShape {
    fn from(value: FadeCurve) -> Self {
        match value {
            FadeCurve::Linear => Self::Linear,
            FadeCurve::EqualPower => Self::EqualPower,
            FadeCurve::SCurve => Self::SCurve,
        }
    }
}

/// The gain of a fade curve at normalised position `x`.
///
/// Values outside `[0, 1]` are clamped; NaN maps to `0`.
#[must_use]
pub fn curve_gain(shape: FadeShape, x: f32) -> f32 {
    let x = if x.is_nan() { 0.0 } else { x.clamp(0.0, 1.0) };
    match shape {
        FadeShape::Linear => x,
        FadeShape::EqualPower => (x * std::f32::consts::FRAC_PI_2).sin(),
        FadeShape::SCurve => x * x * (3.0 - 2.0 * x),
    }
}

/// One clip fade: a length in samples and a curve.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fade {
    /// Length in output samples. `0` means no fade.
    pub len_samples: u64,
    /// The curve.
    pub shape: FadeShape,
}

impl Fade {
    /// A fade of `len_samples` with `shape`.
    #[must_use]
    pub fn new(len_samples: u64, shape: FadeShape) -> Self {
        Self { len_samples, shape }
    }

    /// No fade.
    #[must_use]
    pub fn none() -> Self {
        Self {
            len_samples: 0,
            shape: FadeShape::Linear,
        }
    }

    /// The gain at `offset` samples from the fade's *start* (a fade-in).
    #[must_use]
    pub fn gain_in(&self, offset: u64) -> f32 {
        if self.len_samples == 0 || offset >= self.len_samples {
            return 1.0;
        }
        curve_gain(self.shape, offset as f32 / self.len_samples as f32)
    }

    /// The gain at `remaining` samples from the fade's *end* (a fade-out).
    #[must_use]
    pub fn gain_out(&self, remaining: u64) -> f32 {
        if self.len_samples == 0 || remaining >= self.len_samples {
            return 1.0;
        }
        curve_gain(self.shape, remaining as f32 / self.len_samples as f32)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn curves_have_the_documented_endpoints() {
        for shape in [FadeShape::Linear, FadeShape::EqualPower, FadeShape::SCurve] {
            assert_eq!(curve_gain(shape, 0.0), 0.0);
            assert_eq!(curve_gain(shape, 1.0), 1.0);
            let mid = curve_gain(shape, 0.5);
            assert!((0.4..=0.8).contains(&mid), "{shape:?} midpoint {mid}");
        }
    }

    #[test]
    fn equal_power_fades_sum_to_one_power() {
        for i in 0..=100 {
            let x = i as f32 / 100.0;
            let a = curve_gain(FadeShape::EqualPower, x);
            let b = curve_gain(FadeShape::EqualPower, 1.0 - x);
            assert!((a * a + b * b - 1.0).abs() < 1e-5);
        }
    }

    #[test]
    fn zero_length_fade_is_unity() {
        let fade = Fade::none();
        assert_eq!(fade.gain_in(0), 1.0);
        assert_eq!(fade.gain_out(0), 1.0);
    }

    #[test]
    fn fade_gains_clamp_past_the_end() {
        let fade = Fade::new(100, FadeShape::Linear);
        assert_eq!(fade.gain_in(100), 1.0);
        assert_eq!(fade.gain_in(50), 0.5);
        assert_eq!(fade.gain_out(50), 0.5);
        assert_eq!(fade.gain_out(0), 0.0);
    }
}
