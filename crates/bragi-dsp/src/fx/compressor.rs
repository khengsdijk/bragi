//! `compressor` (03 §6): feed-forward, RMS/peak-blended detector, soft knee.
//!
//! The detector is the average of a 10 ms mean-square follower and a fast peak hold, so it
//! sits between an RMS compressor (smooth, level-matched) and a peak compressor (catches
//! transients). The gain computer subtracts a 6 dB soft-knee curve and its result glides with
//! one-pole attack/release ballistics **in dB**. Both channels share one gain (linked stereo),
//! so a centred signal does not wander in the stereo image.

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed, db_to_lin};

/// Detector RMS time constant, roughly the "10 ms window" of 03 §6.
const RMS_MS: f32 = 10.0;
/// Peak-hold release: long enough to bridge a waveform cycle, short enough to follow a drum.
const PEAK_MS: f32 = 5.0;
/// Soft-knee width (the curve's quadratic region), in dB.
const KNEE_DB: f32 = 6.0;

// Catalogue order (see `FxKind::params`): thresholdDb, ratio, attackMs, releaseMs, makeupDb, mix.
const THRESHOLD_DB: usize = 0;
const RATIO: usize = 1;
const ATTACK_MS: usize = 2;
const RELEASE_MS: usize = 3;
const MAKEUP_DB: usize = 4;
const MIX: usize = 5;

/// The `compressor` effect.
#[derive(Debug, Clone)]
pub struct Compressor {
    samples_per_ms: f32,
    threshold: Smoothed,
    ratio: Smoothed,
    attack: Smoothed,
    release: Smoothed,
    makeup: Smoothed,
    mix: Smoothed,
    rms_env: f32,
    peak_env: f32,
    /// Current gain reduction in dB (positive while compressing).
    reduction_db: f32,
    rms_coeff: f32,
    peak_coeff: f32,
    attack_coeff: f32,
    release_coeff: f32,
    update_in: usize,
}

impl Compressor {
    /// A compressor at the catalogue defaults (threshold −18 dB, ratio 3:1, 10 ms / 120 ms).
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let samples_per_ms = sample_rate as f32 * 1e-3;
        let mut this = Self {
            samples_per_ms,
            threshold: Smoothed::new(-18.0, sample_rate, DEFAULT_SMOOTHING_MS),
            ratio: Smoothed::new(3.0, sample_rate, DEFAULT_SMOOTHING_MS),
            attack: Smoothed::new(10.0, sample_rate, DEFAULT_SMOOTHING_MS),
            release: Smoothed::new(120.0, sample_rate, DEFAULT_SMOOTHING_MS),
            makeup: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            mix: Smoothed::new(1.0, sample_rate, DEFAULT_SMOOTHING_MS),
            rms_env: 0.0,
            peak_env: 0.0,
            reduction_db: 0.0,
            rms_coeff: 0.0,
            peak_coeff: 0.0,
            attack_coeff: 0.0,
            release_coeff: 0.0,
            update_in: 0,
        };
        this.recompute_coeffs();
        this
    }

    fn recompute_coeffs(&mut self) {
        self.rms_coeff = one_pole_coeff(RMS_MS * self.samples_per_ms);
        self.peak_coeff = one_pole_coeff(PEAK_MS * self.samples_per_ms);
        self.attack_coeff = one_pole_coeff(self.attack.value() * self.samples_per_ms);
        self.release_coeff = one_pole_coeff(self.release.value() * self.samples_per_ms);
        self.update_in = super::COEFF_UPDATE_FRAMES;
    }

    /// Gain reduction in dB for a detector level `level_db` (the static curve; positive).
    fn curve(&self, level_db: f32) -> f32 {
        let over = level_db - self.threshold.value();
        let slope = 1.0 - 1.0 / self.ratio.value().max(1.0);
        let half = KNEE_DB * 0.5;
        if over <= -half {
            0.0
        } else if over >= half {
            over * slope
        } else {
            // Quadratic interpolation between the knee corners, continuous in value and slope.
            slope * (over + half) * (over + half) / (2.0 * KNEE_DB)
        }
    }
}

/// A one-pole coefficient for a time constant of `frames` frames (0 frames snaps).
fn one_pole_coeff(frames: f32) -> f32 {
    if frames <= 1.0 {
        0.0
    } else {
        (-1.0 / frames).exp()
    }
}

impl Effect for Compressor {
    fn kind(&self) -> FxKind {
        FxKind::Compressor
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Compressor.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            THRESHOLD_DB => self.threshold.set_target(value),
            RATIO => self.ratio.set_target(value),
            ATTACK_MS => self.attack.set_target(value),
            RELEASE_MS => self.release.set_target(value),
            MAKEUP_DB => self.makeup.set_target(value),
            MIX => self.mix.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        for value in [
            &mut self.threshold,
            &mut self.ratio,
            &mut self.attack,
            &mut self.release,
            &mut self.makeup,
            &mut self.mix,
        ] {
            value.snap();
        }
        self.rms_env = 0.0;
        self.peak_env = 0.0;
        self.reduction_db = 0.0;
        self.recompute_coeffs();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        // A settled dry/wet of 0 is a bit-exact pass-through: there is nothing wet to blend.
        if self.mix.is_settled() && self.mix.value() == 0.0 {
            return;
        }
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            self.threshold.tick();
            self.ratio.tick();
            self.makeup.tick();
            let mix = self.mix.tick();
            self.attack.advance(1);
            self.release.advance(1);
            self.update_in = self.update_in.saturating_sub(1);
            if self.update_in == 0 {
                self.recompute_coeffs();
            }

            // --- linked detector: mean square + peak hold --------------------------------
            let (l_in, r_in) = (*l, *r);
            let power = 0.5 * (l_in * l_in + r_in * r_in);
            self.rms_env += self.rms_coeff * (power - self.rms_env);
            let peak = l_in.abs().max(r_in.abs());
            self.peak_env = if peak > self.peak_env {
                peak
            } else {
                self.peak_env * self.peak_coeff
            };
            if self.rms_env < 1e-30 {
                self.rms_env = 0.0;
            }
            if self.peak_env < 1e-30 {
                self.peak_env = 0.0;
            }
            let level = 0.5 * self.rms_env.max(0.0).sqrt() + 0.5 * self.peak_env;
            let level_db = 20.0 * level.max(1e-9).log10();

            // --- gain computer + ballistics (one-pole in dB) ------------------------------
            let target = self.curve(level_db);
            let coeff = if target > self.reduction_db {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.reduction_db = target + (self.reduction_db - target) * coeff;
            if self.reduction_db < 1e-12 {
                self.reduction_db = 0.0;
            }

            let gain = db_to_lin(self.makeup.value() - self.reduction_db);
            let wet_l = l_in * gain;
            let wet_r = r_in * gain;
            *l = l_in + mix * (wet_l - l_in);
            *r = r_in + mix * (wet_r - r_in);
        }
    }
}
