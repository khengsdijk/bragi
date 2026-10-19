//! RBJ "Audio EQ Cookbook" biquads, shared by `eq3`, `delay`'s tone, `saturation`'s tone and
//! anything else that needs a second-order section.

use std::f64::consts::PI;

/// Normalised biquad coefficients (`a0 == 1`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BiquadCoeffs {
    /// Feed-forward 0.
    pub b0: f32,
    /// Feed-forward 1.
    pub b1: f32,
    /// Feed-forward 2.
    pub b2: f32,
    /// Feedback 1.
    pub a1: f32,
    /// Feedback 2.
    pub a2: f32,
}

impl BiquadCoeffs {
    /// The identity filter.
    pub const IDENTITY: BiquadCoeffs = BiquadCoeffs {
        b0: 1.0,
        b1: 0.0,
        b2: 0.0,
        a1: 0.0,
        a2: 0.0,
    };

    fn normalised(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0: (b0 / a0) as f32,
            b1: (b1 / a0) as f32,
            b2: (b2 / a0) as f32,
            a1: (a1 / a0) as f32,
            a2: (a2 / a0) as f32,
        }
    }

    fn omega(freq_hz: f32, sample_rate: u32) -> (f64, f64) {
        let nyquist_guard = f64::from(sample_rate) * 0.49;
        let w0 = 2.0 * PI * f64::from(freq_hz).clamp(1.0, nyquist_guard) / f64::from(sample_rate);
        (w0.cos(), w0.sin())
    }

    /// Low shelf with gain `gain_db` at `freq_hz`, shelf slope 1.
    ///
    /// ```
    /// use bragi_dsp::fx::BiquadCoeffs;
    /// let flat = BiquadCoeffs::low_shelf(120.0, 0.0, 48_000);
    /// assert!((flat.b0 - 1.0).abs() < 1e-6);
    /// ```
    #[must_use]
    pub fn low_shelf(freq_hz: f32, gain_db: f32, sample_rate: u32) -> Self {
        let a = 10f64.powf(f64::from(gain_db) / 40.0);
        let (cos, sin) = Self::omega(freq_hz, sample_rate);
        let alpha = sin / 2.0 * 2f64.sqrt();
        let sq = 2.0 * a.sqrt() * alpha;
        Self::normalised(
            a * ((a + 1.0) - (a - 1.0) * cos + sq),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
            a * ((a + 1.0) - (a - 1.0) * cos - sq),
            (a + 1.0) + (a - 1.0) * cos + sq,
            -2.0 * ((a - 1.0) + (a + 1.0) * cos),
            (a + 1.0) + (a - 1.0) * cos - sq,
        )
    }

    /// High shelf with gain `gain_db` at `freq_hz`, shelf slope 1.
    #[must_use]
    pub fn high_shelf(freq_hz: f32, gain_db: f32, sample_rate: u32) -> Self {
        let a = 10f64.powf(f64::from(gain_db) / 40.0);
        let (cos, sin) = Self::omega(freq_hz, sample_rate);
        let alpha = sin / 2.0 * 2f64.sqrt();
        let sq = 2.0 * a.sqrt() * alpha;
        Self::normalised(
            a * ((a + 1.0) + (a - 1.0) * cos + sq),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
            a * ((a + 1.0) + (a - 1.0) * cos - sq),
            (a + 1.0) - (a - 1.0) * cos + sq,
            2.0 * ((a - 1.0) - (a + 1.0) * cos),
            (a + 1.0) - (a - 1.0) * cos - sq,
        )
    }

    /// Peaking (bell) filter with gain `gain_db` at `freq_hz` and quality `q`.
    #[must_use]
    pub fn peaking(freq_hz: f32, gain_db: f32, q: f32, sample_rate: u32) -> Self {
        let a = 10f64.powf(f64::from(gain_db) / 40.0);
        let (cos, sin) = Self::omega(freq_hz, sample_rate);
        let alpha = sin / (2.0 * f64::from(q.max(0.01)));
        Self::normalised(
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos,
            1.0 - alpha / a,
        )
    }

    /// Second-order low-pass at `freq_hz` with quality `q`.
    #[must_use]
    pub fn low_pass(freq_hz: f32, q: f32, sample_rate: u32) -> Self {
        let (cos, sin) = Self::omega(freq_hz, sample_rate);
        let alpha = sin / (2.0 * f64::from(q.max(0.01)));
        Self::normalised(
            (1.0 - cos) / 2.0,
            1.0 - cos,
            (1.0 - cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    /// Second-order high-pass at `freq_hz` with quality `q`.
    #[must_use]
    pub fn high_pass(freq_hz: f32, q: f32, sample_rate: u32) -> Self {
        let (cos, sin) = Self::omega(freq_hz, sample_rate);
        let alpha = sin / (2.0 * f64::from(q.max(0.01)));
        Self::normalised(
            (1.0 + cos) / 2.0,
            -(1.0 + cos),
            (1.0 + cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    /// Second-order band-pass (constant 0 dB peak gain) at `freq_hz` with quality `q`.
    #[must_use]
    pub fn band_pass(freq_hz: f32, q: f32, sample_rate: u32) -> Self {
        let (cos, sin) = Self::omega(freq_hz, sample_rate);
        let alpha = sin / (2.0 * f64::from(q.max(0.01)));
        Self::normalised(alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
    }

    /// The magnitude response at `freq_hz`, in dB (for tests and the UI's curve).
    #[must_use]
    pub fn magnitude_db(&self, freq_hz: f32, sample_rate: u32) -> f32 {
        let w = 2.0 * PI * f64::from(freq_hz) / f64::from(sample_rate);
        let (c1, s1) = (w.cos(), w.sin());
        let (c2, s2) = ((2.0 * w).cos(), (2.0 * w).sin());
        let (b0, b1, b2) = (f64::from(self.b0), f64::from(self.b1), f64::from(self.b2));
        let (a1, a2) = (f64::from(self.a1), f64::from(self.a2));
        let num_re = b0 + b1 * c1 + b2 * c2;
        let num_im = -(b1 * s1 + b2 * s2);
        let den_re = 1.0 + a1 * c1 + a2 * c2;
        let den_im = -(a1 * s1 + a2 * s2);
        let mag2 = (num_re * num_re + num_im * num_im) / (den_re * den_re + den_im * den_im);
        (10.0 * mag2.log10()) as f32
    }
}

/// One channel of a biquad in transposed direct form II.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    /// The current coefficients; swap them freely between samples.
    pub coeffs: BiquadCoeffs,
    z1: f32,
    z2: f32,
}

impl Biquad {
    /// A filter with `coeffs` and cleared state.
    #[must_use]
    pub const fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            coeffs,
            z1: 0.0,
            z2: 0.0,
        }
    }

    /// Clears the filter memory.
    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }

    /// Filters one sample.
    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let c = self.coeffs;
        let y = c.b0 * x + self.z1;
        self.z1 = c.b1 * x - c.a1 * y + self.z2;
        self.z2 = c.b2 * x - c.a2 * y;
        // Flush denormals: a decaying tail must not slow the audio thread down.
        if self.z1.abs() < 1e-20 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-20 {
            self.z2 = 0.0;
        }
        y
    }
}

/// A stereo pair of [`Biquad`]s sharing coefficients.
#[derive(Debug, Clone, Copy)]
pub struct StereoBiquad {
    left: Biquad,
    right: Biquad,
}

impl StereoBiquad {
    /// A stereo filter with `coeffs` and cleared state.
    #[must_use]
    pub const fn new(coeffs: BiquadCoeffs) -> Self {
        Self {
            left: Biquad::new(coeffs),
            right: Biquad::new(coeffs),
        }
    }

    /// Replaces the coefficients on both channels (state is kept, so a sweep is continuous).
    pub fn set_coeffs(&mut self, coeffs: BiquadCoeffs) {
        self.left.coeffs = coeffs;
        self.right.coeffs = coeffs;
    }

    /// The shared coefficients.
    #[must_use]
    pub fn coeffs(&self) -> BiquadCoeffs {
        self.left.coeffs
    }

    /// Clears both channels' memory.
    pub fn reset(&mut self) {
        self.left.reset();
        self.right.reset();
    }

    /// Filters one stereo frame.
    #[inline]
    pub fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        (self.left.tick(l), self.right.tick(r))
    }
}
