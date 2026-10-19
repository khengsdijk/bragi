//! `limiter` (03 §6, master only): 5 ms look-ahead true-peak limiter.
//!
//! A ×4 cubic peak estimate feeds a sliding minimum over the look-ahead window, so the gain is
//! already down when a peak reaches the output. The gain drops instantly and recovers with a
//! one-pole release (`releaseMs`). The audio path is delayed by exactly `latency()` frames and
//! every delayed sample is scaled by at most `ceiling / |sample|`, so no sample can exceed
//! `ceilingDb`; the cubic estimate is what keeps inter-sample peaks below it too.

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed, db_to_lin};

/// Look-ahead in seconds (03 §6: 5 ms).
const LOOKAHEAD_SEC: f64 = 0.005;
/// A small numerical margin on the gain so the true-peak estimate cannot round above the ceiling.
const GAIN_MARGIN: f32 = 0.9999;

// Catalogue order: ceilingDb, releaseMs.
const CEILING_DB: usize = 0;
const RELEASE_MS: usize = 1;

/// The `limiter` effect.
#[derive(Debug, Clone)]
pub struct Limiter {
    samples_per_ms: f32,
    lookahead: usize,
    ceiling: Smoothed,
    release: Smoothed,
    release_coeff: f32,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    delay_pos: usize,
    gain: f32,
    /// Last four input frames per channel, oldest first, for the cubic peak estimate.
    hist_l: [f32; 4],
    hist_r: [f32; 4],
    /// Monotonic deque of required gains over the look-ahead window.
    deque_idx: Vec<usize>,
    deque_val: Vec<f32>,
    head: usize,
    tail: usize,
    /// Monotonic absolute frame index for the sliding-minimum window.
    seq: usize,
    update_in: usize,
}

impl Limiter {
    /// A limiter at the catalogue defaults (ceiling −1 dB, release 50 ms).
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let lookahead = ((f64::from(sample_rate) * LOOKAHEAD_SEC).round() as usize).max(1);
        let window = lookahead + 1;
        let mut this = Self {
            samples_per_ms: sample_rate as f32 * 1e-3,
            lookahead,
            ceiling: Smoothed::new(-1.0, sample_rate, DEFAULT_SMOOTHING_MS),
            release: Smoothed::new(50.0, sample_rate, DEFAULT_SMOOTHING_MS),
            release_coeff: 0.0,
            delay_l: vec![0.0; lookahead],
            delay_r: vec![0.0; lookahead],
            delay_pos: 0,
            gain: 1.0,
            hist_l: [0.0; 4],
            hist_r: [0.0; 4],
            deque_idx: vec![0; window + 2],
            deque_val: vec![0.0; window + 2],
            head: 0,
            tail: 0,
            seq: 0,
            update_in: 0,
        };
        this.recompute_release();
        this
    }

    fn recompute_release(&mut self) {
        let frames = self.release.value() * self.samples_per_ms;
        self.release_coeff = if frames <= 1.0 {
            0.0
        } else {
            (-1.0 / frames).exp()
        };
        self.update_in = super::COEFF_UPDATE_FRAMES;
    }

    fn push(&mut self, index: usize, value: f32) {
        let cap = self.deque_val.len();
        while self.tail != self.head {
            let back = (self.tail + cap - 1) % cap;
            if self.deque_val[back] >= value {
                self.tail = back;
            } else {
                break;
            }
        }
        self.deque_val[self.tail] = value;
        self.deque_idx[self.tail] = index;
        self.tail = (self.tail + 1) % cap;
    }

    fn pop_before(&mut self, oldest: usize) {
        let cap = self.deque_val.len();
        while self.head != self.tail && self.deque_idx[self.head] < oldest {
            self.head = (self.head + 1) % cap;
        }
    }

    fn minimum(&self) -> f32 {
        self.deque_val[self.head]
    }

    /// The largest ×4 cubic estimate in the last two samples (the segment that has just closed).
    fn true_peak(hist: &[f32; 4]) -> f32 {
        let (p0, p1, p2, p3) = (hist[0], hist[1], hist[2], hist[3]);
        let c0 = 2.0 * p1;
        let c1 = -p0 + p2;
        let c2 = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
        let c3 = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
        let peak = |t: f32| {
            let t2 = t * t;
            let t3 = t2 * t;
            (0.5 * (c0 + c1 * t + c2 * t2 + c3 * t3)).abs()
        };
        p1.abs()
            .max(p2.abs())
            .max(p3.abs())
            .max(peak(0.25))
            .max(peak(0.5))
            .max(peak(0.75))
    }
}

impl Effect for Limiter {
    fn kind(&self) -> FxKind {
        FxKind::Limiter
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Limiter.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            CEILING_DB => self.ceiling.set_target(value),
            RELEASE_MS => self.release.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.ceiling.snap();
        self.release.snap();
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.delay_pos = 0;
        self.gain = 1.0;
        self.hist_l = [0.0; 4];
        self.hist_r = [0.0; 4];
        self.head = 0;
        self.tail = 0;
        self.seq = 0;
        self.recompute_release();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let lookahead = self.lookahead;
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            self.ceiling.tick();
            self.release.advance(1);
            self.update_in = self.update_in.saturating_sub(1);
            if self.update_in == 0 {
                self.recompute_release();
            }

            let xl = *l;
            let xr = *r;
            self.hist_l = [self.hist_l[1], self.hist_l[2], self.hist_l[3], xl];
            self.hist_r = [self.hist_r[1], self.hist_r[2], self.hist_r[3], xr];
            let tip = Self::true_peak(&self.hist_l).max(Self::true_peak(&self.hist_r));

            let ceiling = db_to_lin(self.ceiling.value());
            let required = if tip * GAIN_MARGIN > ceiling {
                ceiling / tip * GAIN_MARGIN
            } else {
                1.0
            };

            // The window [n - look-ahead, n] covers every sample that reaches the output now.
            let absolute = self.seq;
            self.seq = self.seq.wrapping_add(1);
            self.push(absolute, required);
            self.pop_before(absolute.saturating_sub(lookahead));
            let target = self.minimum();
            if target < self.gain {
                self.gain = target;
            } else {
                self.gain = target + (self.gain - target) * self.release_coeff;
            }
            if !self.gain.is_finite() {
                self.gain = 0.0;
            }

            let delayed_l = self.delay_l[self.delay_pos];
            let delayed_r = self.delay_r[self.delay_pos];
            self.delay_l[self.delay_pos] = xl;
            self.delay_r[self.delay_pos] = xr;
            self.delay_pos = (self.delay_pos + 1) % self.delay_l.len();

            *l = delayed_l * self.gain;
            *r = delayed_r * self.gain;
        }
    }

    fn latency(&self) -> usize {
        self.lookahead
    }
}
