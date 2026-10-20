//! `reverb` (03 §6): an 8-line feedback delay network.
//!
//! A pre-delay line and four Schroeder allpasses feed an 8-line FDN. The line lengths are prime
//! at 48 kHz and scale with `size`; a normalised Hadamard matrix mixes the lines every pass, each
//! line is damped by a one-pole low-pass (`damping`) and attenuated by a gain chosen so that every
//! line loses 60 dB in `decaySec` (RT60). The stereo output taps two orthogonal Hadamard rows, so
//! a mono input comes out as two decorrelated tails. Wet only; `mix` blends it under the dry path.

use super::{COEFF_UPDATE_FRAMES, Effect, FxContext, FxKind, Smoothed};

/// Number of delay lines.
const LINES: usize = 8;

/// Prime line lengths in frames at 48 kHz (23–44 ms), pairwise coprime.
const BASE_DELAYS: [usize; LINES] = [1117, 1277, 1423, 1567, 1699, 1847, 1993, 2131];

/// `size` 0..1 maps the line lengths to 0.35×..1.5× of their base.
const SIZE_MIN: f32 = 0.35;
const SIZE_MAX: f32 = 1.5;

/// Prime diffusion-allpass lengths in frames at 48 kHz (2–7 ms).
const DIFFUSION_DELAYS: [usize; 4] = [97, 173, 251, 331];
/// Diffusion coefficient: high enough to smear, low enough to stay stable.
const DIFFUSION_GAIN: f32 = 0.62;

/// How much of the diffused input enters each line.
const INPUT_GAIN: f32 = 0.5;
/// Output tap gain, so the wet signal sits near unity with the dry path.
const OUTPUT_GAIN: f32 = 0.5;

/// The strongest one-pole damping coefficient (at `damping = 1`).
const MAX_DAMP: f32 = 0.72;

/// `size` glides slowly: moving the line lengths is a pitch glide of the tail.
const SIZE_SMOOTHING_MS: f32 = 200.0;
/// `decaySec` also glides slowly: the gains multiply the energy already circulating, so a fast
/// change would sound like a swell rather than a decay change.
const DECAY_SMOOTHING_MS: f32 = 150.0;
/// The pre-delay line is moved slowly for the same reason.
const PREDELAY_SMOOTHING_MS: f32 = 250.0;

const PREDELAY_MAX_MS: f32 = 200.0;

const LN_1000: f32 = 6.907_755;

/// A fractional-read ring buffer. Reads are linear interpolations, so a moving delay length is a
/// smooth pitch glide rather than a splice.
#[derive(Debug, Clone)]
struct Line {
    buf: Vec<f32>,
    pos: usize,
}

impl Line {
    fn new(len: usize) -> Self {
        Self {
            buf: vec![0.0; len.max(2)],
            pos: 0,
        }
    }

    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
    }

    #[inline]
    fn write(&mut self, x: f32) {
        self.buf[self.pos] = x;
        self.pos += 1;
        if self.pos == self.buf.len() {
            self.pos = 0;
        }
    }

    /// The sample `delay` frames ago (0 = the last written sample).
    #[inline]
    fn read(&self, delay: f32) -> f32 {
        let len = self.buf.len();
        let d = delay.clamp(0.0, (len - 2) as f32);
        // `pos` is the next write slot, so the last written sample is at pos - 1.
        let base = self.pos as f32 - 1.0 - d;
        let i0 = base.floor();
        let frac = base - i0;
        let a = self.buf[wrap(i0 as isize, len)];
        let b = self.buf[wrap(i0 as isize + 1, len)];
        a + (b - a) * frac
    }
}

#[inline]
fn wrap(index: isize, len: usize) -> usize {
    index.rem_euclid(len as isize) as usize
}

#[inline]
fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 { 0.0 } else { x }
}

/// Unnormalised fast Walsh–Hadamard transform, then the 1/√8 normalisation: a unitary mixing
/// matrix that costs 24 adds instead of 64 multiply-adds.
#[inline]
fn hadamard(x: &mut [f32; LINES]) {
    let mut h = 1;
    while h < LINES {
        let mut i = 0;
        while i < LINES {
            for j in i..i + h {
                let a = x[j];
                let b = x[j + h];
                x[j] = a + b;
                x[j + h] = a - b;
            }
            i += h * 2;
        }
        h *= 2;
    }
    let scale = 1.0 / (LINES as f32).sqrt();
    for v in x {
        *v = flush(*v * scale);
    }
}

/// The `reverb` effect.
#[derive(Debug, Clone)]
pub struct Reverb {
    sample_rate: u32,
    lines: [Line; LINES],
    damp_state: [f32; LINES],
    predelay_line: Line,
    diffusion: [Line; 4],
    size: Smoothed,
    decay: Smoothed,
    predelay: Smoothed,
    damping: Smoothed,
    mix: Smoothed,
    gains: [f32; LINES],
    damp_coeff: f32,
    /// The target `decaySec`, for [`Effect::tail`].
    decay_target: f32,
    coeff_countdown: usize,
}

impl Reverb {
    /// A reverb at the catalogue defaults, with every buffer sized for the worst case at
    /// `sample_rate`.
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let rate = sample_rate as f32 / 48_000.0;
        let lines = std::array::from_fn(|i| {
            Line::new((BASE_DELAYS[i] as f32 * SIZE_MAX * rate).ceil() as usize + 4)
        });
        let diffusion = std::array::from_fn(|i| {
            Line::new((DIFFUSION_DELAYS[i] as f32 * rate).ceil() as usize + 4)
        });
        let predelay_len = (PREDELAY_MAX_MS * 1e-3 * sample_rate as f32).ceil() as usize + 4;
        let mut reverb = Self {
            sample_rate,
            lines,
            damp_state: [0.0; LINES],
            predelay_line: Line::new(predelay_len),
            diffusion,
            size: Smoothed::new(0.5, sample_rate, SIZE_SMOOTHING_MS),
            decay: Smoothed::new(2.0, sample_rate, DECAY_SMOOTHING_MS),
            predelay: Smoothed::new(20.0, sample_rate, PREDELAY_SMOOTHING_MS),
            damping: Smoothed::new(0.5, sample_rate, super::DEFAULT_SMOOTHING_MS),
            mix: Smoothed::new(0.2, sample_rate, super::DEFAULT_SMOOTHING_MS),
            gains: [0.0; LINES],
            damp_coeff: 0.0,
            decay_target: 2.0,
            coeff_countdown: 0,
        };
        reverb.update_coeffs();
        reverb
    }

    /// Recomputes the line gains and the damping coefficient from the current smoothed values.
    /// Called at most every [`COEFF_UPDATE_FRAMES`] frames.
    fn update_coeffs(&mut self) {
        let size = self.size.value();
        let decay = self.decay.value().max(0.2);
        let rate = self.sample_rate as f32 / 48_000.0;
        let scale = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * size;
        for (i, gain) in self.gains.iter_mut().enumerate() {
            let frames = BASE_DELAYS[i] as f32 * scale * rate;
            // g^(rt60·sr/frames) = 10^-3, so every line loses 60 dB in `decay` seconds.
            *gain = (-LN_1000 * frames / (decay * self.sample_rate as f32)).exp();
        }
        self.damp_coeff = MAX_DAMP * self.damping.value();
    }

    /// One Schroeder allpass stage.
    #[inline]
    fn allpass(&mut self, index: usize, x: f32) -> f32 {
        let rate = self.sample_rate as f32 / 48_000.0;
        let d = self.diffusion[index].read(DIFFUSION_DELAYS[index] as f32 * rate);
        let w = flush(x + DIFFUSION_GAIN * d);
        let y = flush(d - DIFFUSION_GAIN * w);
        self.diffusion[index].write(w);
        y
    }

    /// One-pole low-pass at `a` (0 = off), with the state flushed against denormals.
    #[inline]
    fn damp(&mut self, index: usize, x: f32) -> f32 {
        let a = self.damp_coeff;
        let y = flush((1.0 - a) * x + a * self.damp_state[index]);
        self.damp_state[index] = y;
        y
    }
}

impl Effect for Reverb {
    fn kind(&self) -> FxKind {
        FxKind::Reverb
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Reverb.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            0 => self.size.set_target(value),
            1 => {
                self.decay_target = value;
                self.decay.set_target(value);
            }
            2 => self.predelay.set_target(value),
            3 => self.damping.set_target(value),
            4 => self.mix.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        for line in &mut self.lines {
            line.clear();
        }
        for line in &mut self.diffusion {
            line.clear();
        }
        self.predelay_line.clear();
        self.damp_state = [0.0; LINES];
        self.size.snap();
        self.decay.snap();
        self.predelay.snap();
        self.damping.snap();
        self.mix.snap();
        self.coeff_countdown = 0;
        self.update_coeffs();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let rate = self.sample_rate as f32 / 48_000.0;
        let sr = self.sample_rate as f32;
        let mut feedback = [0.0f32; LINES];
        for i in 0..frames {
            let size = self.size.tick();
            self.decay.tick();
            let predelay = self.predelay.tick();
            self.damping.tick();
            let mix = self.mix.tick();
            if self.coeff_countdown == 0 {
                self.update_coeffs();
                self.coeff_countdown = COEFF_UPDATE_FRAMES;
            }
            self.coeff_countdown -= 1;

            // Pre-delay the mono wet input, then diffuse it.
            let dry = 0.5 * (left[i] + right[i]);
            self.predelay_line.write(dry);
            let mut wet = self.predelay_line.read(predelay * 1e-3 * sr);
            for stage in 0..4 {
                wet = self.allpass(stage, wet);
            }
            wet *= INPUT_GAIN;

            // Read every line, damp it, and tap two orthogonal Hadamard rows for L/R.
            let scale = SIZE_MIN + (SIZE_MAX - SIZE_MIN) * size;
            let mut y = [0.0f32; LINES];
            for line in 0..LINES {
                let d = BASE_DELAYS[line] as f32 * scale * rate;
                let raw = self.lines[line].read(d);
                y[line] = self.damp(line, raw);
            }
            let wet_l = OUTPUT_GAIN * (y[0] + y[1] + y[2] + y[3] - y[4] - y[5] - y[6] - y[7]);
            let wet_r = OUTPUT_GAIN * (y[0] - y[1] + y[2] - y[3] - y[4] + y[5] - y[6] + y[7]);

            // Energy-preserving feedback, scaled per line for RT60.
            for (f, (value, gain)) in feedback.iter_mut().zip(y.iter().zip(&self.gains)) {
                *f = *value * *gain;
            }
            hadamard(&mut feedback);
            for (line, f) in self.lines.iter_mut().zip(&feedback) {
                line.write(flush(wet + *f));
            }

            let dry_l = left[i];
            let dry_r = right[i];
            left[i] = dry_l + mix * (wet_l - dry_l);
            right[i] = dry_r + mix * (wet_r - dry_r);
        }
    }

    fn tail(&self) -> usize {
        (self.decay_target * self.sample_rate as f32) as usize
    }
}
