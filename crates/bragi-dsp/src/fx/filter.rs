//! `filter` (03 §6): a 24 dB/oct state-variable filter, LP/HP/BP.
//!
//! Two cascaded TPT (topology-preserving transform, "Cytomic") state-variable filters give the
//! 24 dB/oct lowpass/highpass; `mode` picks the low, high or (unity-peak) band tap of each stage.
//! `cutoffHz` glides in log-frequency with [`Smoothed`] and the coefficients are rebuilt from the
//! smoothed cutoff/resonance as they move (checked every [`COEFF_UPDATE_FRAMES`] frames), so a
//! sweep has no coefficient staircase. `mode` is discrete: the stage-2 feed and the output are a
//! blend of the three taps whose weights glide over [`MODE_FADE_MS`], so one cascade morphs
//! between taps without ever reinterpreting its state (which would click).

use super::{COEFF_UPDATE_FRAMES, Effect, FxContext, FxKind, Smoothed};

// Catalogue order (`FxKind::Filter.params`): mode, cutoffHz, resonance.
const MODE: usize = 0;
const CUTOFF_HZ: usize = 1;
const RESONANCE: usize = 2;

/// The mode crossfade, in milliseconds.
const MODE_FADE_MS: f32 = 12.0;

/// Cutoff/resonance glide time, in milliseconds. Slower than the default 20 ms: the reflection of a
/// corner sweeping several octaves per millisecond is a resonant ring that the zipper measure
/// (correctly) reads as a step; 80 ms still feels immediate on a slider.
const CUTOFF_SMOOTHING_MS: f32 = 80.0;

/// Resonance maps to damping `k = 1/Q` linearly: 0 → a mildly overdamped pair (Q = 0.5), 1 → a
/// strong but stable peak (Q = 10). `k` stays positive, so the TPT filter cannot self-oscillate.
fn q_from_resonance(resonance: f32) -> f32 {
    let damping = 2.0 - 1.9 * resonance.clamp(0.0, 1.0);
    1.0 / damping
}

fn g_from_cutoff(cutoff_hz: f32, sample_rate: u32) -> f32 {
    // `g = tan(pi f / fs)`; clamp below Nyquist for sample rates where 20 kHz is out of band.
    let nyquist_guard = sample_rate as f32 * 0.49;
    (std::f32::consts::PI * cutoff_hz.min(nyquist_guard) / sample_rate as f32).tan()
}

/// The TPT coefficients shared by both SVF stages (and both channels) at one moment.
#[derive(Debug, Clone, Copy)]
struct SvfCoeffs {
    a1: f32,
    a2: f32,
    a3: f32,
    k: f32,
}

impl SvfCoeffs {
    fn from_g_k(g: f32, k: f32) -> Self {
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        Self { a1, a2, a3, k }
    }
}

/// One channel of a TPT state-variable filter.
#[derive(Debug, Clone, Copy, Default)]
struct Svf {
    ic1: f32,
    ic2: f32,
}

impl Svf {
    fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }

    /// Filters one sample and returns `(low, band, high)`; `band` is scaled to unity peak gain.
    #[inline]
    fn tick(&mut self, x: f32, c: SvfCoeffs) -> (f32, f32, f32) {
        let v3 = x - self.ic2;
        let v1 = c.a1 * self.ic1 + c.a2 * v3;
        let v2 = self.ic2 + c.a2 * self.ic1 + c.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        // Flush denormals in the integrators.
        if self.ic1.abs() < 1e-20 {
            self.ic1 = 0.0;
        }
        if self.ic2.abs() < 1e-20 {
            self.ic2 = 0.0;
        }
        (v2, c.k * v1, x - c.k * v1 - v2)
    }
}

/// A two-stage cascade whose stage-2 feed and output are a blend of the LP/HP/BP taps.
#[derive(Debug, Clone, Copy, Default)]
struct Cascade {
    stage1: Svf,
    stage2: Svf,
}

impl Cascade {
    fn reset(&mut self) {
        self.stage1.reset();
        self.stage2.reset();
    }

    #[inline]
    fn tick(&mut self, x: f32, c: SvfCoeffs, w: [f32; 3]) -> f32 {
        let (low1, band1, high1) = self.stage1.tick(x, c);
        let fed = w[0] * low1 + w[1] * high1 + w[2] * band1;
        let (low2, band2, high2) = self.stage2.tick(fed, c);
        w[0] * low2 + w[1] * high2 + w[2] * band2
    }
}

fn blend_for(mode: u8) -> [f32; 3] {
    match mode {
        0 => [1.0, 0.0, 0.0],
        1 => [0.0, 1.0, 0.0],
        _ => [0.0, 0.0, 1.0],
    }
}

/// The `filter` effect.
#[derive(Debug, Clone)]
pub struct Filter {
    sample_rate: u32,
    mode: u8,
    /// The tap-blend weights (`[lp, hp, bp]`), gliding to the one-hot `mode` vector.
    blend: [Smoothed; 3],
    channels: [Cascade; 2],
    log_cutoff: Smoothed,
    resonance: Smoothed,
    g: f32,
    k: f32,
}

impl Filter {
    /// A `filter` at the catalogue defaults: lowpass, 20 kHz, resonance 0.2.
    #[must_use]
    pub fn new(sample_rate: u32, _max_block: usize) -> Self {
        Self {
            sample_rate,
            mode: 0,
            blend: [
                Smoothed::new(1.0, sample_rate, MODE_FADE_MS),
                Smoothed::new(0.0, sample_rate, MODE_FADE_MS),
                Smoothed::new(0.0, sample_rate, MODE_FADE_MS),
            ],
            channels: [Cascade::default(); 2],
            log_cutoff: Smoothed::new(20_000.0f32.ln(), sample_rate, CUTOFF_SMOOTHING_MS),
            resonance: Smoothed::new(0.2, sample_rate, CUTOFF_SMOOTHING_MS),
            g: g_from_cutoff(20_000.0, sample_rate),
            k: 1.0 / q_from_resonance(0.2),
        }
    }

    fn is_settled(&self) -> bool {
        self.log_cutoff.is_settled() && self.resonance.is_settled()
    }

    #[inline]
    fn tick_frame(&mut self, left: f32, right: f32) -> (f32, f32) {
        let w = [
            self.blend[0].tick(),
            self.blend[1].tick(),
            self.blend[2].tick(),
        ];
        let c = SvfCoeffs::from_g_k(self.g, self.k);
        (
            self.channels[0].tick(left, c, w),
            self.channels[1].tick(right, c, w),
        )
    }
}

impl Effect for Filter {
    fn kind(&self) -> FxKind {
        FxKind::Filter
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Filter.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            MODE => {
                let mode = value.round().clamp(0.0, 2.0) as u8;
                if mode != self.mode {
                    self.mode = mode;
                    for (weight, to) in self.blend.iter_mut().zip(blend_for(mode)) {
                        weight.set_target(to);
                    }
                }
            }
            CUTOFF_HZ => self.log_cutoff.set_target(value.max(1.0).ln()),
            RESONANCE => self.resonance.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.log_cutoff.snap();
        self.resonance.snap();
        self.g = g_from_cutoff(self.log_cutoff.value().exp(), self.sample_rate);
        self.k = 1.0 / q_from_resonance(self.resonance.value());
        for cascade in &mut self.channels {
            cascade.reset();
        }
        for (weight, value) in self.blend.iter_mut().zip(blend_for(self.mode)) {
            weight.snap_to(value);
        }
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let mut start = 0;
        while start < frames {
            let n = (frames - start).min(COEFF_UPDATE_FRAMES);
            let (g0, k0) = (self.g, self.k);
            if !self.is_settled() {
                self.log_cutoff.advance(n);
                self.resonance.advance(n);
            }
            let g1 = g_from_cutoff(self.log_cutoff.value().exp(), self.sample_rate);
            let k1 = 1.0 / q_from_resonance(self.resonance.value());
            if g0 == g1 && k0 == k1 {
                for (l, r) in left[start..start + n]
                    .iter_mut()
                    .zip(&mut right[start..start + n])
                {
                    let (ol, or) = self.tick_frame(*l, *r);
                    *l = ol;
                    *r = or;
                }
            } else {
                // Interpolate `g`/`k` over the update interval and rebuild the coefficients each
                // frame: a glide then has no 16-frame staircase to show up as a click.
                let scale = 1.0 / n as f32;
                for (i, (l, r)) in left[start..start + n]
                    .iter_mut()
                    .zip(&mut right[start..start + n])
                    .enumerate()
                {
                    let t = (i + 1) as f32 * scale;
                    self.g = g0 + (g1 - g0) * t;
                    self.k = k0 + (k1 - k0) * t;
                    let (ol, or) = self.tick_frame(*l, *r);
                    *l = ol;
                    *r = or;
                }
            }
            self.g = g1;
            self.k = k1;
            start += n;
        }
    }
}
