//! `width` (03 §6): mid/side stereo width.
//!
//! `L = M + width·S`, `R = M − width·S` with `M = (L+R)/2`, `S = (L−R)/2`. `width` glides with
//! [`Smoothed`]; 0 collapses to mono, 2 doubles the side, and 1 (once settled) is a bit-exact
//! pass-through.

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed};

// Catalogue order (`FxKind::Width.params`): width.
const WIDTH: usize = 0;

/// The `width` effect.
#[derive(Debug, Clone)]
pub struct Width {
    width: Smoothed,
}

impl Width {
    /// A `width` at the catalogue default: 1 (unchanged stereo image).
    #[must_use]
    pub fn new(sample_rate: u32, _max_block: usize) -> Self {
        Self {
            width: Smoothed::new(1.0, sample_rate, DEFAULT_SMOOTHING_MS),
        }
    }
}

impl Effect for Width {
    fn kind(&self) -> FxKind {
        FxKind::Width
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Width.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        if index == WIDTH {
            self.width.set_target(value);
        }
    }

    fn reset(&mut self) {
        self.width.snap();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        if self.width.is_settled() && self.width.value() == 1.0 {
            return; // unity width is a bit-exact pass-through.
        }
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            let width = self.width.tick();
            let mid = (*l + *r) * 0.5;
            let side = (*l - *r) * 0.5;
            *l = mid + width * side;
            *r = mid - width * side;
        }
    }
}
