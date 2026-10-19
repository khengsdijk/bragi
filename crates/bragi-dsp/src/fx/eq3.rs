//! `eq3` (03 §6): a low shelf, a mid bell and a high shelf, three RBJ biquads in series.
//!
//! Every parameter glides with [`Smoothed`]; the three biquads' coefficients are recomputed from
//! the smoothed values at most every [`COEFF_UPDATE_FRAMES`] frames, and the biquad state is kept
//! across updates so a sweep is continuous. At 0 dB the RBJ shelves/bell reduce to the identity
//! transfer function, so the default is a flat (bit-exact) pass-through.

use super::{
    BiquadCoeffs, COEFF_UPDATE_FRAMES, DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed,
};

// Catalogue order (`FxKind::Eq3.params`): lowDb, midDb, highDb, lowHz, midHz, highHz, midQ.
const LOW_DB: usize = 0;
const MID_DB: usize = 1;
const HIGH_DB: usize = 2;
const LOW_HZ: usize = 3;
const MID_HZ: usize = 4;
const HIGH_HZ: usize = 5;
const MID_Q: usize = 6;

/// One channel of an RBJ biquad in direct form I.
///
/// `biquad::Biquad` is transposed direct form II, whose state is a function of the coefficients:
/// with a gliding coefficient set it leaves a small modulation transient. Direct form I keeps the
/// input/output history itself, so a coefficient glide changes the transfer function without
/// reinterpreting the state, and the zipper measure stays flat.
#[derive(Debug, Clone, Copy, Default)]
struct Rbj {
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Rbj {
    fn reset(&mut self) {
        *self = Self::default();
    }

    #[inline]
    fn tick(&mut self, x: f32, c: BiquadCoeffs) -> f32 {
        let y = c.b0 * x + c.b1 * self.x1 + c.b2 * self.x2 - c.a1 * self.y1 - c.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        // Flush denormals so a decaying tail never slows the audio thread down.
        if self.x1.abs() < 1e-20 {
            self.x1 = 0.0;
        }
        if self.x2.abs() < 1e-20 {
            self.x2 = 0.0;
        }
        if self.y1.abs() < 1e-20 {
            self.y1 = 0.0;
        }
        if self.y2.abs() < 1e-20 {
            self.y2 = 0.0;
        }
        y
    }
}

/// A stereo pair of [`Rbj`]s sharing one coefficient set.
#[derive(Debug, Clone, Copy)]
struct StereoRbj {
    left: Rbj,
    right: Rbj,
    coeffs: BiquadCoeffs,
}

impl StereoRbj {
    fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            left: Rbj::default(),
            right: Rbj::default(),
            coeffs,
        }
    }

    fn set_coeffs(&mut self, coeffs: BiquadCoeffs) {
        self.coeffs = coeffs;
    }

    fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
    }

    #[inline]
    fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        let c = self.coeffs;
        (self.left.tick(l, c), self.right.tick(r, c))
    }
}

/// The `eq3` effect: low shelf → mid bell → high shelf.
#[derive(Debug, Clone)]
pub struct Eq3 {
    sample_rate: u32,
    low_db: Smoothed,
    mid_db: Smoothed,
    high_db: Smoothed,
    low_hz: Smoothed,
    mid_hz: Smoothed,
    high_hz: Smoothed,
    mid_q: Smoothed,
    low: StereoRbj,
    mid: StereoRbj,
    high: StereoRbj,
}

impl Eq3 {
    /// An `eq3` at the catalogue defaults (flat).
    #[must_use]
    pub fn new(sample_rate: u32, _max_block: usize) -> Self {
        let mut this = Self {
            sample_rate,
            low_db: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            mid_db: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            high_db: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            low_hz: Smoothed::new(120.0, sample_rate, DEFAULT_SMOOTHING_MS),
            mid_hz: Smoothed::new(1000.0, sample_rate, DEFAULT_SMOOTHING_MS),
            high_hz: Smoothed::new(6000.0, sample_rate, DEFAULT_SMOOTHING_MS),
            mid_q: Smoothed::new(0.7, sample_rate, DEFAULT_SMOOTHING_MS),
            low: StereoRbj::new(BiquadCoeffs::IDENTITY),
            mid: StereoRbj::new(BiquadCoeffs::IDENTITY),
            high: StereoRbj::new(BiquadCoeffs::IDENTITY),
        };
        this.update_coeffs();
        this
    }

    fn update_coeffs(&mut self) {
        self.low.set_coeffs(BiquadCoeffs::low_shelf(
            self.low_hz.value(),
            self.low_db.value(),
            self.sample_rate,
        ));
        self.mid.set_coeffs(BiquadCoeffs::peaking(
            self.mid_hz.value(),
            self.mid_db.value(),
            self.mid_q.value(),
            self.sample_rate,
        ));
        self.high.set_coeffs(BiquadCoeffs::high_shelf(
            self.high_hz.value(),
            self.high_db.value(),
            self.sample_rate,
        ));
    }

    fn is_settled(&self) -> bool {
        self.low_db.is_settled()
            && self.mid_db.is_settled()
            && self.high_db.is_settled()
            && self.low_hz.is_settled()
            && self.mid_hz.is_settled()
            && self.high_hz.is_settled()
            && self.mid_q.is_settled()
    }

    fn advance(&mut self, frames: usize) {
        self.low_db.advance(frames);
        self.mid_db.advance(frames);
        self.high_db.advance(frames);
        self.low_hz.advance(frames);
        self.mid_hz.advance(frames);
        self.high_hz.advance(frames);
        self.mid_q.advance(frames);
    }
}

/// Linear interpolation between two coefficient sets (the glide between updates).
fn lerp(from: BiquadCoeffs, to: BiquadCoeffs, t: f32) -> BiquadCoeffs {
    BiquadCoeffs {
        b0: from.b0 + (to.b0 - from.b0) * t,
        b1: from.b1 + (to.b1 - from.b1) * t,
        b2: from.b2 + (to.b2 - from.b2) * t,
        a1: from.a1 + (to.a1 - from.a1) * t,
        a2: from.a2 + (to.a2 - from.a2) * t,
    }
}

impl Effect for Eq3 {
    fn kind(&self) -> FxKind {
        FxKind::Eq3
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Eq3.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            LOW_DB => self.low_db.set_target(value),
            MID_DB => self.mid_db.set_target(value),
            HIGH_DB => self.high_db.set_target(value),
            LOW_HZ => self.low_hz.set_target(value),
            MID_HZ => self.mid_hz.set_target(value),
            HIGH_HZ => self.high_hz.set_target(value),
            MID_Q => self.mid_q.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        for value in [
            &mut self.low_db,
            &mut self.mid_db,
            &mut self.high_db,
            &mut self.low_hz,
            &mut self.mid_hz,
            &mut self.high_hz,
            &mut self.mid_q,
        ] {
            value.snap();
        }
        self.update_coeffs();
        self.low.reset();
        self.mid.reset();
        self.high.reset();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let mut start = 0;
        while start < frames {
            let n = (frames - start).min(COEFF_UPDATE_FRAMES);
            let from = [self.low.coeffs, self.mid.coeffs, self.high.coeffs];
            if !self.is_settled() {
                self.advance(n);
                self.update_coeffs();
            }
            let to = [self.low.coeffs, self.mid.coeffs, self.high.coeffs];
            if from == to {
                for (l, r) in left[start..start + n]
                    .iter_mut()
                    .zip(&mut right[start..start + n])
                {
                    let (lo, ro) = self.low.tick(*l, *r);
                    let (lm, rm) = self.mid.tick(lo, ro);
                    let (lh, rh) = self.high.tick(lm, rm);
                    *l = lh;
                    *r = rh;
                }
            } else {
                // Interpolate the coefficients over the update interval: a parameter glide then
                // has no 16-frame staircase to show up as a click.
                let scale = 1.0 / n as f32;
                for (i, (l, r)) in left[start..start + n]
                    .iter_mut()
                    .zip(&mut right[start..start + n])
                    .enumerate()
                {
                    let t = (i + 1) as f32 * scale;
                    self.low.set_coeffs(lerp(from[0], to[0], t));
                    self.mid.set_coeffs(lerp(from[1], to[1], t));
                    self.high.set_coeffs(lerp(from[2], to[2], t));
                    let (lo, ro) = self.low.tick(*l, *r);
                    let (lm, rm) = self.mid.tick(lo, ro);
                    let (lh, rh) = self.high.tick(lm, rm);
                    *l = lh;
                    *r = rh;
                }
                self.low.set_coeffs(to[0]);
                self.mid.set_coeffs(to[1]);
                self.high.set_coeffs(to[2]);
            }
            start += n;
        }
    }
}
