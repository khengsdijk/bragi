//! `lofi` (03 §6): sample-and-hold rate reduction, bit-depth reduction, wow and hiss.
//!
//! The signal is held at `rateHz` (a fractional phase accumulator, so any rate locks to the
//! host clock), quantised with a mid-rise grid and crossfaded between the two integer bit depths
//! around the smoothed `bits` value, then read through a short delay modulated at 0.4 Hz for
//! `wow`. White noise at up to −30 dBFS is added before the dry/wet mix. At 16 bits / 48 kHz /
//! wow 0 / noise 0 the output differs from the input by at most half a 16-bit step (2⁻¹⁶).

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed, db_to_lin};

/// Wow LFO rate, in Hz.
const WOW_HZ: f32 = 0.4;
/// Maximum wow delay modulation, in seconds.
const WOW_DEPTH_SEC: f32 = 0.006;
/// Hiss amplitude at `noise == 1` (0 dBFS is a full-scale sine; this is its −30 dB peak).
const NOISE_DB: f32 = -30.0;

// Catalogue order: bits, rateHz, wow, noise, mix.
const BITS: usize = 0;
const RATE_HZ: usize = 1;
const WOW: usize = 2;
const NOISE: usize = 3;
const MIX: usize = 4;

/// The `lofi` effect.
#[derive(Debug, Clone)]
pub struct Lofi {
    sample_rate: u32,
    bits: Smoothed,
    rate: Smoothed,
    wow: Smoothed,
    noise: Smoothed,
    mix: Smoothed,
    phase: f32,
    held_l: f32,
    held_r: f32,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    delay_pos: usize,
    wow_phase: f32,
    rng: u64,
}

impl Lofi {
    /// A `lofi` at the catalogue defaults (16 bits, 48 kHz, no wow or noise, fully wet).
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let max_delay = (WOW_DEPTH_SEC * sample_rate as f32).ceil() as usize + 2;
        Self {
            sample_rate,
            bits: Smoothed::new(16.0, sample_rate, DEFAULT_SMOOTHING_MS),
            rate: Smoothed::new(48_000.0, sample_rate, DEFAULT_SMOOTHING_MS),
            wow: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            noise: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            mix: Smoothed::new(1.0, sample_rate, DEFAULT_SMOOTHING_MS),
            phase: 1.0,
            held_l: 0.0,
            held_r: 0.0,
            delay_l: vec![0.0; max_delay],
            delay_r: vec![0.0; max_delay],
            delay_pos: 0,
            wow_phase: 0.0,
            rng: 0x9E37_79B9_7F4A_7C15,
        }
    }

    fn next_noise(&mut self) -> f32 {
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        let bits = x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40;
        (bits as f32 / (1u64 << 23) as f32) - 1.0
    }

    /// Reads `delay` frames behind the write position with linear interpolation.
    fn read_delay(&self, buffer: &[f32], delay: f32) -> f32 {
        let len = buffer.len();
        let position = self.delay_pos as f32 - delay;
        let base = position.floor();
        let frac = position - base;
        let i0 = (base as isize).rem_euclid(len as isize) as usize;
        let i1 = (i0 + 1) % len;
        buffer[i0] * (1.0 - frac) + buffer[i1] * frac
    }
}

/// Mid-rise quantisation of `x` to `bits` bits over the −1..1 range (clipped to the end levels).
/// Computed in `f64`: at 16 bits the grid step is 2⁻¹⁵, so the mid-rise offset is lost if the
/// rounding is done in `f32`.
fn quantize(x: f32, bits: u32) -> f32 {
    let levels = f64::from(1u32 << bits);
    let step = 2.0 / levels;
    let q = ((f64::from(x) + 1.0) / step).floor() + 0.5;
    let q = q * step - 1.0;
    let lo = -1.0 + step * 0.5;
    let hi = 1.0 - step * 0.5;
    q.clamp(lo, hi) as f32
}

impl Effect for Lofi {
    fn kind(&self) -> FxKind {
        FxKind::Lofi
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Lofi.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            BITS => self.bits.set_target(value),
            RATE_HZ => self.rate.set_target(value),
            WOW => self.wow.set_target(value),
            NOISE => self.noise.set_target(value),
            MIX => self.mix.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.bits.snap();
        self.rate.snap();
        self.wow.snap();
        self.noise.snap();
        self.mix.snap();
        self.phase = 1.0;
        self.held_l = 0.0;
        self.held_r = 0.0;
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.delay_pos = 0;
        self.wow_phase = 0.0;
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let sr = self.sample_rate as f32;
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            self.bits.tick();
            self.rate.tick();
            self.wow.tick();
            self.noise.tick();
            let mix = self.mix.tick();

            // --- sample-and-hold ---------------------------------------------------------
            self.phase += (self.rate.value() / sr).clamp(0.0, 1.0);
            if self.phase >= 1.0 {
                self.phase -= 1.0;
                self.held_l = *l;
                self.held_r = *r;
            }

            // --- bit-depth reduction (crossfade between the two integer depths) ---------
            let bits = self.bits.value().clamp(2.0, 16.0);
            let lo = bits.floor() as u32;
            let frac = bits - lo as f32;
            let mut wet_l = quantize(self.held_l, lo);
            let mut wet_r = quantize(self.held_r, lo);
            if frac > 1e-6 && lo < 16 {
                let hi = lo + 1;
                let hi_l = quantize(self.held_l, hi);
                let hi_r = quantize(self.held_r, hi);
                wet_l = wet_l * (1.0 - frac) + hi_l * frac;
                wet_r = wet_r * (1.0 - frac) + hi_r * frac;
            }

            // --- wow: a short delay modulated by a 0.4 Hz sine ---------------------------
            self.delay_l[self.delay_pos] = wet_l;
            self.delay_r[self.delay_pos] = wet_r;
            let depth = self.wow.value() * WOW_DEPTH_SEC * sr;
            let lfo = 0.5 + 0.5 * (std::f32::consts::TAU * self.wow_phase).sin();
            let delay = depth * lfo;
            wet_l = self.read_delay(&self.delay_l, delay);
            wet_r = self.read_delay(&self.delay_r, delay);
            self.delay_pos = (self.delay_pos + 1) % self.delay_l.len();
            self.wow_phase += WOW_HZ / sr;
            if self.wow_phase >= 1.0 {
                self.wow_phase -= 1.0;
            }

            // --- hiss -------------------------------------------------------------------
            let hiss = db_to_lin(NOISE_DB) * self.noise.value();
            if hiss > 0.0 {
                wet_l += hiss * self.next_noise();
                wet_r += hiss * self.next_noise();
            }

            *l += mix * (wet_l - *l);
            *r += mix * (wet_r - *r);
        }
    }
}
