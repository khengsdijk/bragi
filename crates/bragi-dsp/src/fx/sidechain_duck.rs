//! `sidechain_duck` (03 §6): ducks the track by the envelope of a source track.
//!
//! The key is `max(|L|, |R|)` of [`FxContext::sidechain`], followed by a peak envelope with a
//! fixed 1 ms attack and the `releaseMs` release. The reduction in dB is proportional to that
//! envelope — a key at 0 dBFS gives the full `amountDb` — and is applied as a broadband gain.
//! No key, or key samples past the end of a short slice, are silence.

use super::{COEFF_UPDATE_FRAMES, Effect, FxContext, FxKind, Smoothed};

/// The attack time constant of the envelope follower.
const ATTACK_MS: f32 = 1.0;

/// The `sidechain_duck` effect.
#[derive(Debug, Clone)]
pub struct SidechainDuck {
    sample_rate: u32,
    amount: Smoothed,
    release: Smoothed,
    attack_coeff: f32,
    release_coeff: f32,
    envelope: f32,
    coeff_countdown: usize,
}

impl SidechainDuck {
    /// A duck at the catalogue defaults.
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let sr = sample_rate as f32;
        let mut duck = Self {
            sample_rate,
            amount: Smoothed::new(6.0, sample_rate, super::DEFAULT_SMOOTHING_MS),
            release: Smoothed::new(150.0, sample_rate, super::DEFAULT_SMOOTHING_MS),
            attack_coeff: (-1.0 / (ATTACK_MS * 1e-3 * sr)).exp(),
            release_coeff: 0.0,
            envelope: 0.0,
            coeff_countdown: 0,
        };
        duck.update_release();
        duck
    }

    fn update_release(&mut self) {
        let release = self.release.value().max(1.0);
        self.release_coeff = (-1.0 / (release * 1e-3 * self.sample_rate as f32)).exp();
    }
}

impl Effect for SidechainDuck {
    fn kind(&self) -> FxKind {
        FxKind::SidechainDuck
    }

    fn set_param(&mut self, index: usize, value: f32) {
        // `sourceTrack` is routing (FxContext::sidechain), not an indexed number: the catalogue
        // has two numeric params, `amountDb` and `releaseMs`.
        let Some(spec) = FxKind::SidechainDuck.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match spec.name {
            "amountDb" => self.amount.set_target(value),
            "releaseMs" => self.release.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.amount.snap();
        self.release.snap();
        self.envelope = 0.0;
        self.coeff_countdown = 0;
        self.update_release();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let Some((key_left, key_right)) = ctx.sidechain else {
            if self.envelope == 0.0 {
                return; // no source and nothing to release: bit-exact identity.
            }
            for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
                // Without a source the key is silent; release rather than jump to unity.
                self.envelope = flush(self.envelope * self.release_coeff);
                let amount = self.amount.tick();
                let gain = reduction_gain(amount, self.envelope);
                *l *= gain;
                *r *= gain;
            }
            return;
        };

        for (i, (l, r)) in left[..frames]
            .iter_mut()
            .zip(&mut right[..frames])
            .enumerate()
        {
            let kl = key_left.get(i).copied().unwrap_or(0.0);
            let kr = key_right.get(i).copied().unwrap_or(0.0);
            let level = if kl.is_finite() && kr.is_finite() {
                kl.abs().max(kr.abs())
            } else {
                0.0
            };
            let coeff = if level > self.envelope {
                self.attack_coeff
            } else {
                self.release_coeff
            };
            self.envelope = flush(level + (self.envelope - level) * coeff);

            if self.coeff_countdown == 0 {
                self.update_release();
                self.coeff_countdown = COEFF_UPDATE_FRAMES;
            }
            self.coeff_countdown -= 1;

            let amount = self.amount.tick();
            let gain = reduction_gain(amount, self.envelope);
            *l *= gain;
            *r *= gain;
        }
    }
}

/// The gain for a reduction of `amount_db · envelope`, where the envelope is a 0 dBFS key.
#[inline]
fn reduction_gain(amount_db: f32, envelope: f32) -> f32 {
    let reduction_db = amount_db * envelope.clamp(0.0, 1.0);
    10.0f32.powf(-reduction_db / 20.0)
}

#[inline]
fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 { 0.0 } else { x }
}
