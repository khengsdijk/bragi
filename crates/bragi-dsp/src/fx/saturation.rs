//! `saturation` (03 §6): ×2 oversampled asymmetric `tanh` with a gentle tone tilt.
//!
//! `drive` maps to 0..+24 dB of input gain into the shaper; the output is scaled by `g^-0.75`, so
//! pushing the drive adds harmonics rather than loudness. `tone` shifts the
//! `tanh` bias (even harmonics) and tilts the spectrum around 800 Hz. The shaper runs at 2× the
//! host rate through a 61-tap Blackman half-band FIR; the dry path is delayed by the same
//! integer number of frames (`latency()`) so `mix` stays phase-coherent.

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed, db_to_lin};

/// Half-band FIR length; odd, with the centre at an even index so the up/down pair has an
/// integer latency of `(TAPS - 1) / 2` frames.
const TAPS: usize = 61;
/// The half-band filter's centre index.
const CENTRE: usize = TAPS / 2;
/// The oversampling latency in host frames (see the module docs).
const LATENCY: usize = CENTRE;
/// Fixed 800 Hz split for the tone tilt.
const TILT_HZ: f32 = 800.0;
/// The tilt's gain at either side, in dB, at `tone == ±1`.
const TILT_DB: f32 = 3.0;
/// The `tanh` bias at `tone == ±1`; the shaper subtracts `tanh(bias)` to remove the DC it adds.
const BIAS: f32 = 0.5;

// Catalogue order: drive, tone, mix.
const DRIVE: usize = 0;
const TONE: usize = 1;
const MIX: usize = 2;

/// The `saturation` effect.
#[derive(Debug, Clone)]
pub struct Saturation {
    drive: Smoothed,
    tone: Smoothed,
    mix: Smoothed,
    coeffs: [f32; TAPS],
    up_l: [f32; TAPS],
    up_r: [f32; TAPS],
    down_l: [f32; TAPS],
    down_r: [f32; TAPS],
    up_pos: usize,
    down_pos: usize,
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    dry_pos: usize,
    tilt_coeff: f32,
    tilt_low_l: f32,
    tilt_low_r: f32,
}

impl Saturation {
    /// A saturator at the catalogue defaults (drive 0.2, tone 0, mix 1).
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        Self {
            drive: Smoothed::new(0.2, sample_rate, DEFAULT_SMOOTHING_MS),
            tone: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            mix: Smoothed::new(1.0, sample_rate, DEFAULT_SMOOTHING_MS),
            coeffs: halfband(),
            up_l: [0.0; TAPS],
            up_r: [0.0; TAPS],
            down_l: [0.0; TAPS],
            down_r: [0.0; TAPS],
            up_pos: TAPS - 1,
            down_pos: TAPS - 1,
            dry_l: vec![0.0; LATENCY.max(1)],
            dry_r: vec![0.0; LATENCY.max(1)],
            dry_pos: 0,
            tilt_coeff: one_pole_coeff(TILT_HZ, sample_rate),
            tilt_low_l: 0.0,
            tilt_low_r: 0.0,
        }
    }
}

/// A one-pole low-pass coefficient for `freq_hz` at `sample_rate`.
fn one_pole_coeff(freq_hz: f32, sample_rate: u32) -> f32 {
    let w = 2.0 * std::f32::consts::PI * freq_hz / sample_rate as f32;
    if w >= std::f32::consts::PI {
        1.0
    } else {
        1.0 - (-w).exp()
    }
}

/// A Blackman-windowed half-band FIR (DC gain 1, zeros at even offsets, centre 0.5).
fn halfband() -> [f32; TAPS] {
    let mut h = [0.0f32; TAPS];
    let m = CENTRE as f64;
    for (k, slot) in h.iter_mut().enumerate() {
        let d = k as f64 - m;
        if d == 0.0 {
            *slot = 0.5;
        } else {
            let even = (d as i64) % 2 == 0;
            let v = if even {
                0.0
            } else {
                (std::f64::consts::PI * d * 0.5).sin() / (std::f64::consts::PI * d)
            };
            let n = k as f64;
            let w = 0.42 - 0.5 * (2.0 * std::f64::consts::PI * n / (TAPS - 1) as f64).cos()
                + 0.08 * (4.0 * std::f64::consts::PI * n / (TAPS - 1) as f64).cos();
            *slot = (v * w) as f32;
        }
    }
    h[CENTRE] = 0.5;
    let sum: f64 = h.iter().map(|v| f64::from(*v)).sum();
    let scale = 1.0 / sum;
    for slot in &mut h {
        *slot = (f64::from(*slot) * scale) as f32;
    }
    h
}

/// Runs one FIR pass in place over a circular history whose newest sample is at `pos`.
fn fir(hist: &[f32; TAPS], coeffs: &[f32; TAPS], pos: usize) -> f32 {
    let mut acc = 0.0f32;
    let mut idx = pos;
    for &c in coeffs {
        acc += c * hist[idx];
        idx = if idx == 0 { TAPS - 1 } else { idx - 1 };
    }
    acc
}

impl Effect for Saturation {
    fn kind(&self) -> FxKind {
        FxKind::Saturation
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Saturation.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            DRIVE => self.drive.set_target(value),
            TONE => self.tone.set_target(value),
            MIX => self.mix.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.drive.snap();
        self.tone.snap();
        self.mix.snap();
        self.up_l = [0.0; TAPS];
        self.up_r = [0.0; TAPS];
        self.down_l = [0.0; TAPS];
        self.down_r = [0.0; TAPS];
        self.up_pos = TAPS - 1;
        self.down_pos = TAPS - 1;
        self.dry_l.fill(0.0);
        self.dry_r.fill(0.0);
        self.dry_pos = 0;
        self.tilt_low_l = 0.0;
        self.tilt_low_r = 0.0;
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            self.drive.tick();
            self.tone.tick();
            let mix = self.mix.tick();
            let tone = self.tone.value();
            let low_gain = db_to_lin(-TILT_DB * tone);
            let high_gain = db_to_lin(TILT_DB * tone);

            let gain = db_to_lin(24.0 * self.drive.value());
            // g^-0.75 keeps a −12 dBFS sine within a few dB of its input level across the whole
            // drive range (g^-0.5 over-compensates mid-range, g^-1 dips too far at the top).
            let compensation = gain.powf(-0.75);
            let bias = BIAS * tone;
            let bias_tanh = bias.tanh();
            let (xl, xr) = (*l, *r);

            // Two 2× samples per host frame: input at phase 0, the zero-stuffed phase 1.
            let mut wet_l = 0.0;
            let mut wet_r = 0.0;
            for sub in 0..2 {
                let ul = if sub == 0 { xl } else { 0.0 };
                let ur = if sub == 0 { xr } else { 0.0 };
                self.up_l[self.up_pos] = ul;
                self.up_r[self.up_pos] = ur;
                // The interpolation filter runs with gain 2 to undo the zero-stuffing's ½.
                let up_l = 2.0 * fir(&self.up_l, &self.coeffs, self.up_pos);
                let up_r = 2.0 * fir(&self.up_r, &self.coeffs, self.up_pos);
                self.up_pos = (self.up_pos + 1) % TAPS;

                let shaped_l = ((gain * up_l + bias).tanh() - bias_tanh) * compensation;
                let shaped_r = ((gain * up_r + bias).tanh() - bias_tanh) * compensation;

                self.down_l[self.down_pos] = shaped_l;
                self.down_r[self.down_pos] = shaped_r;
                let down_l = fir(&self.down_l, &self.coeffs, self.down_pos);
                let down_r = fir(&self.down_r, &self.coeffs, self.down_pos);
                self.down_pos = (self.down_pos + 1) % TAPS;
                if sub == 0 {
                    wet_l = down_l;
                    wet_r = down_r;
                }
            }

            // Gentle tilt: split at 800 Hz and weight the two halves by ±3 dB × tone.
            self.tilt_low_l += self.tilt_coeff * (wet_l - self.tilt_low_l);
            self.tilt_low_r += self.tilt_coeff * (wet_r - self.tilt_low_r);
            let tilt_l = wet_l * high_gain + self.tilt_low_l * (low_gain - high_gain);
            let tilt_r = wet_r * high_gain + self.tilt_low_r * (low_gain - high_gain);

            // Dry is delayed to the oversampled path's latency so the blend is coherent.
            let dry_l = self.dry_l[self.dry_pos];
            let dry_r = self.dry_r[self.dry_pos];
            self.dry_l[self.dry_pos] = xl;
            self.dry_r[self.dry_pos] = xr;
            self.dry_pos = (self.dry_pos + 1) % self.dry_l.len();

            *l = dry_l + mix * (tilt_l - dry_l);
            *r = dry_r + mix * (tilt_r - dry_r);
        }
    }

    fn latency(&self) -> usize {
        LATENCY
    }
}
