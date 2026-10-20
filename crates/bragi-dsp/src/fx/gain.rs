//! `gain` (03 §6): a smoothed level change.

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed, db_to_lin};

/// The `gain` effect. Smooths the *linear* factor, so a step is a short fade, not a click.
#[derive(Debug, Clone)]
pub struct Gain {
    db: f32,
    factor: Smoothed,
}

impl Gain {
    /// A `gain` at 0 dB.
    #[must_use]
    pub fn new(sample_rate: u32) -> Self {
        Self {
            db: 0.0,
            factor: Smoothed::new(1.0, sample_rate, DEFAULT_SMOOTHING_MS),
        }
    }
}

impl Effect for Gain {
    fn kind(&self) -> FxKind {
        FxKind::Gain
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Gain.params().get(index) else {
            return;
        };
        let Some(db) = spec.clamp(value) else {
            return;
        };
        self.db = db;
        self.factor.set_target(db_to_lin(db));
    }

    fn reset(&mut self) {
        self.factor.snap();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        if self.factor.is_settled() {
            let factor = self.factor.value();
            if factor == 1.0 {
                return; // 0 dB is a bit-exact pass-through.
            }
            for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
                *l *= factor;
                *r *= factor;
            }
            return;
        }
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            let factor = self.factor.tick();
            *l *= factor;
            *r *= factor;
        }
    }
}
