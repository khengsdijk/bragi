//! `chorus` (03 §6): two modulated delay voices with stereo-spread LFOs.
//!
//! Each voice is a 7–25 ms delay line read with cubic interpolation and modulated by a sine LFO
//! at `rateHz`; `depth` scales the modulation around a fixed 12 ms and 19 ms base. The left and
//! right channels use quadrature LFO phases, so a mono source widens without the two voices
//! collapsing to one comb. `mix` blends the two-voice average with the dry signal.

use super::{DEFAULT_SMOOTHING_MS, Effect, FxContext, FxKind, Smoothed};

/// Base delays of the two voices, in seconds (inside the 7–25 ms specification).
const BASE_SEC: [f32; 2] = [0.012, 0.019];
/// Peak delay modulation at `depth == 1`, in seconds.
const MOD_SEC: f32 = 0.003;
/// Quadrature LFO offsets for (voice 0 left, voice 1 left, voice 0 right, voice 1 right).
const PHASE_OFFSETS: [f32; 4] = [0.0, 0.5, 0.25, 0.75];

// Catalogue order: rateHz, depth, mix.
const RATE_HZ: usize = 0;
const DEPTH: usize = 1;
const MIX: usize = 2;

/// The `chorus` effect.
#[derive(Debug, Clone)]
pub struct Chorus {
    sample_rate: u32,
    rate: Smoothed,
    depth: Smoothed,
    mix: Smoothed,
    phase: f32,
    buffer_l: Vec<f32>,
    buffer_r: Vec<f32>,
    write: usize,
}

impl Chorus {
    /// A chorus at the catalogue defaults (0.6 Hz, depth 0.3, mix 0.3).
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let frames = (0.025 * sample_rate as f32).ceil() as usize + 4;
        Self {
            sample_rate,
            rate: Smoothed::new(0.6, sample_rate, DEFAULT_SMOOTHING_MS),
            depth: Smoothed::new(0.3, sample_rate, DEFAULT_SMOOTHING_MS),
            mix: Smoothed::new(0.3, sample_rate, DEFAULT_SMOOTHING_MS),
            phase: 0.0,
            buffer_l: vec![0.0; frames],
            buffer_r: vec![0.0; frames],
            write: 0,
        }
    }

    /// Reads `delay` frames behind `write` with a Catmull-Rom cubic.
    fn read_cubic(buffer: &[f32], write: usize, delay: f32) -> f32 {
        let len = buffer.len();
        let position = write as f32 - delay;
        let base = position.floor();
        let t = position - base;
        let index = |offset: isize| {
            let i = base as isize + offset;
            buffer[i.rem_euclid(len as isize) as usize]
        };
        let p0 = index(-1);
        let p1 = index(0);
        let p2 = index(1);
        let p3 = index(2);
        let t2 = t * t;
        let t3 = t2 * t;
        let c0 = 2.0 * p1;
        let c1 = -p0 + p2;
        let c2 = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3;
        let c3 = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
        0.5 * (c0 + c1 * t + c2 * t2 + c3 * t3)
    }
}

impl Effect for Chorus {
    fn kind(&self) -> FxKind {
        FxKind::Chorus
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Chorus.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            RATE_HZ => self.rate.set_target(value),
            DEPTH => self.depth.set_target(value),
            MIX => self.mix.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.rate.snap();
        self.depth.snap();
        self.mix.snap();
        self.phase = 0.0;
        self.buffer_l.fill(0.0);
        self.buffer_r.fill(0.0);
        self.write = 0;
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let sr = self.sample_rate as f32;
        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            self.rate.tick();
            self.depth.tick();
            let mix = self.mix.tick();

            self.buffer_l[self.write] = *l;
            self.buffer_r[self.write] = *r;
            let modulation = MOD_SEC * self.depth.value() * sr;
            let base = [BASE_SEC[0] * sr, BASE_SEC[1] * sr];
            let mut wet_l = 0.0;
            let mut wet_r = 0.0;
            for voice in 0..2 {
                let phase_l = self.phase + PHASE_OFFSETS[voice];
                let phase_r = self.phase + PHASE_OFFSETS[voice + 2];
                let delay_l = base[voice] + modulation * (std::f32::consts::TAU * phase_l).sin();
                let delay_r = base[voice] + modulation * (std::f32::consts::TAU * phase_r).sin();
                wet_l += Self::read_cubic(&self.buffer_l, self.write, delay_l);
                wet_r += Self::read_cubic(&self.buffer_r, self.write, delay_r);
            }
            wet_l *= 0.5;
            wet_r *= 0.5;

            *l += mix * (wet_l - *l);
            *r += mix * (wet_r - *r);

            self.write = (self.write + 1) % self.buffer_l.len();
            self.phase += self.rate.value() / sr;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
            }
        }
    }
}
