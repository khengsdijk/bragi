//! `transient` (03 §6): an envelope-difference transient shaper.
//!
//! Two peak followers (a fast one and a slow one, each with its own attack/release) run on the
//! linked `max(|L|, |R|)`. Their normalised difference drives a gain: a fast rise over the slow
//! follower is an onset (scaled by `attack`), a slow fall under it is a decay (scaled by
//! `sustain`). The gain is bounded to ±12 dB, and `attack = sustain = 0` is a bit-exact
//! pass-through once settled.

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed, db_to_lin};

// Catalogue order (`FxKind::Transient.params`): attack, sustain.
const ATTACK: usize = 0;
const SUSTAIN: usize = 1;

/// The largest gain the shaper applies, in dB.
const MAX_DB: f32 = 12.0;

/// Envelope follower time constants, in milliseconds: `(attack, release)`.
const FAST: (f32, f32) = (0.2, 25.0);
const SLOW: (f32, f32) = (15.0, 180.0);

fn time_coeff(ms: f32, sample_rate: u32) -> f32 {
    let frames = (ms * 1e-3 * sample_rate as f32).max(1.0);
    (-1.0 / frames).exp()
}

#[inline]
fn follow(env: f32, x: f32, attack_coeff: f32, release_coeff: f32) -> f32 {
    let coeff = if x > env { attack_coeff } else { release_coeff };
    let next = x + (env - x) * coeff;
    if next < 1e-20 { 0.0 } else { next }
}

/// The `transient` effect.
#[derive(Debug, Clone)]
pub struct Transient {
    attack: Smoothed,
    sustain: Smoothed,
    fast_attack: f32,
    fast_release: f32,
    slow_attack: f32,
    slow_release: f32,
    fast: f32,
    slow: f32,
}

impl Transient {
    /// A `transient` at the catalogue defaults: no shaping.
    #[must_use]
    pub fn new(sample_rate: u32, _max_block: usize) -> Self {
        Self {
            attack: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            sustain: Smoothed::new(0.0, sample_rate, DEFAULT_SMOOTHING_MS),
            fast_attack: time_coeff(FAST.0, sample_rate),
            fast_release: time_coeff(FAST.1, sample_rate),
            slow_attack: time_coeff(SLOW.0, sample_rate),
            slow_release: time_coeff(SLOW.1, sample_rate),
            fast: 0.0,
            slow: 0.0,
        }
    }
}

impl Effect for Transient {
    fn kind(&self) -> FxKind {
        FxKind::Transient
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Transient.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            ATTACK => self.attack.set_target(value),
            SUSTAIN => self.sustain.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.attack.snap();
        self.sustain.snap();
        self.fast = 0.0;
        self.slow = 0.0;
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        if self.attack.is_settled()
            && self.sustain.is_settled()
            && self.attack.value() == 0.0
            && self.sustain.value() == 0.0
        {
            return; // 0/0 is a bit-exact pass-through once settled.
        }
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            let attack = self.attack.tick();
            let sustain = self.sustain.tick();
            let x = l.abs().max(r.abs());
            self.fast = follow(self.fast, x, self.fast_attack, self.fast_release);
            self.slow = follow(self.slow, x, self.slow_attack, self.slow_release);
            let normalised = ((self.fast - self.slow) / (self.slow + 1e-3)).clamp(-1.0, 1.0);
            let onset = normalised.max(0.0);
            let decay = (-normalised).max(0.0);
            let gain_db = (MAX_DB * (attack * onset + sustain * decay)).clamp(-MAX_DB, MAX_DB);
            let gain = db_to_lin(gain_db);
            *l *= gain;
            *r *= gain;
        }
    }
}
