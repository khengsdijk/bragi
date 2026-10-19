//! Parameter smoothing: the one primitive every effect uses against zipper noise.

/// The default glide time for a parameter step, in milliseconds. 20 ms is short enough to feel
/// immediate on a slider and long enough that a full-range gain step does not click.
pub const DEFAULT_SMOOTHING_MS: f32 = 20.0;

/// A value that glides towards its target through two cascaded one-pole low-passes (a
/// critically damped second-order glide).
///
/// One pole alone starts the glide with its steepest slope, which leaves a kink in a modulated
/// signal at the moment of the step; the second pole makes the slope start at zero, so the glide
/// is smooth at both ends. Each pole's time constant is the glide time / 6.6, so the value is
/// within 1 % of the target after `time_ms`. Once both stages are within `1e-6` (relative) they
/// snap to the target exactly, so a settled parameter is bit-exact and [`Smoothed::is_settled`]
/// can short-circuit per-sample work.
///
/// ```
/// use bragi_dsp::fx::Smoothed;
///
/// let mut gain = Smoothed::new(1.0, 48_000, 20.0);
/// gain.set_target(0.0);
/// let first = gain.tick();
/// assert!(first < 1.0 && first > 0.99);
/// for _ in 0..48_000 { gain.tick(); }
/// assert_eq!(gain.value(), 0.0);
/// assert!(gain.is_settled());
/// ```
#[derive(Debug, Clone, Copy)]
pub struct Smoothed {
    current: f32,
    mid: f32,
    target: f32,
    coeff: f32,
}

impl Smoothed {
    /// A settled value at `initial`, gliding over `time_ms` at `sample_rate`.
    #[must_use]
    pub fn new(initial: f32, sample_rate: u32, time_ms: f32) -> Self {
        let tau_frames = (time_ms / 6.6) * 1e-3 * sample_rate as f32;
        let coeff = if tau_frames <= 1.0 {
            0.0
        } else {
            (-1.0 / tau_frames).exp()
        };
        Self {
            current: initial,
            mid: initial,
            target: initial,
            coeff,
        }
    }

    /// Sets where the value glides to.
    pub fn set_target(&mut self, target: f32) {
        self.target = target;
    }

    /// Jumps to the target immediately.
    pub fn snap(&mut self) {
        self.current = self.target;
        self.mid = self.target;
    }

    /// Jumps to `value` and makes it the target.
    pub fn snap_to(&mut self, value: f32) {
        self.target = value;
        self.snap();
    }

    /// The current value, without advancing.
    #[must_use]
    pub fn value(&self) -> f32 {
        self.current
    }

    /// The target value.
    #[must_use]
    pub fn target(&self) -> f32 {
        self.target
    }

    /// Whether the value has reached its target exactly.
    #[must_use]
    pub fn is_settled(&self) -> bool {
        self.current == self.target && self.mid == self.target
    }

    /// Advances one frame and returns the new value.
    #[inline]
    pub fn tick(&mut self) -> f32 {
        if !self.is_settled() {
            self.mid = self.target + (self.mid - self.target) * self.coeff;
            self.current = self.mid + (self.current - self.mid) * self.coeff;
            let eps = 1e-6 * self.target.abs().max(1.0);
            if (self.current - self.target).abs() <= eps && (self.mid - self.target).abs() <= eps {
                self.snap();
            }
        }
        self.current
    }

    /// Advances `frames` frames and returns the new value (for per-sub-block parameters such as
    /// filter coefficients). Costs `frames` ticks while gliding and nothing once settled.
    pub fn advance(&mut self, frames: usize) -> f32 {
        for _ in 0..frames {
            if self.is_settled() {
                break;
            }
            self.tick();
        }
        self.current
    }
}
