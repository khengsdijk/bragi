//! `delay` (03 §6): a tempo-synced stereo delay with a tone filter in the feedback loop and an
//! optional ping-pong topology.
//!
//! The delay time is always `timeBeats · 60 / ctx.bpm` seconds, recomputed every block, so tempo
//! changes follow immediately. The *read position* glides to the new time as a tape delay would:
//! its speed is limited (at most half a sample per sample, so the pitch shift stays within
//! 0.5×..1.5×) and the velocity itself is smoothed, so a time or tempo jump never clicks. The
//! feedback path is low-passed by `tone`; `pingPong` morphs (over 10 ms) from two independent
//! lines to the classic cross-fed topology with the input on the left line only.

use super::{COEFF_UPDATE_FRAMES, Effect, FxContext, FxKind, Smoothed};

/// The line is allocated for the longest musical time: two beats at 20 BPM = 6 s.
const MAX_DELAY_SEC: f32 = 6.0;

/// The largest read-position velocity, in frames per frame. 0.5 bounds the tape-style pitch
/// shift to 0.5×..1.5× while still settling a full-range change in a few seconds.
const MAX_TIME_RATE: f32 = 0.5;
/// Time constant of the velocity smoother.
const VELOCITY_TAU_MS: f32 = 10.0;
/// Proportional gain of the velocity controller (1 / time constant).
const TIME_APPROACH_MS: f32 = 2.0;

/// `pingPong` crossfade time.
const PINGPONG_SMOOTHING_MS: f32 = 10.0;

/// The longest tail we report, so an offline render cannot run for minutes on a 0.95 feedback.
const MAX_TAIL_SEC: f32 = 60.0;

/// A fractional-read ring buffer (linear interpolation).
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

/// The `delay` effect.
#[derive(Debug, Clone)]
pub struct Delay {
    sample_rate: u32,
    max_frames: f32,
    left: Line,
    right: Line,
    time_beats: f32,
    target_frames: f32,
    current_frames: f32,
    velocity: f32,
    velocity_coeff: f32,
    approach: f32,
    feedback: Smoothed,
    tone: Smoothed,
    ping_pong: Smoothed,
    mix: Smoothed,
    tone_coeff: f32,
    tone_state_l: f32,
    tone_state_r: f32,
    coeff_countdown: usize,
}

impl Delay {
    /// A delay at the catalogue defaults, with both lines allocated for [`MAX_DELAY_SEC`].
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let max_frames = MAX_DELAY_SEC * sample_rate as f32;
        let len = max_frames.ceil() as usize + 4;
        let default_frames = 0.25 * 60.0 / 120.0 * sample_rate as f32;
        let sr = sample_rate as f32;
        let velocity_coeff = 1.0 - (-1.0 / (VELOCITY_TAU_MS * 1e-3 * sr)).exp();
        let approach = 1.0 / (TIME_APPROACH_MS * 1e-3 * sr);
        let mut delay = Self {
            sample_rate,
            max_frames,
            left: Line::new(len),
            right: Line::new(len),
            time_beats: 0.25,
            target_frames: default_frames,
            current_frames: default_frames,
            velocity: 0.0,
            velocity_coeff,
            approach,
            feedback: Smoothed::new(0.35, sample_rate, super::DEFAULT_SMOOTHING_MS),
            tone: Smoothed::new(0.5, sample_rate, super::DEFAULT_SMOOTHING_MS),
            ping_pong: Smoothed::new(0.0, sample_rate, PINGPONG_SMOOTHING_MS),
            mix: Smoothed::new(0.2, sample_rate, super::DEFAULT_SMOOTHING_MS),
            tone_coeff: 0.0,
            tone_state_l: 0.0,
            tone_state_r: 0.0,
            coeff_countdown: 0,
        };
        delay.update_tone();
        delay
    }

    /// The one-pole coefficient for the current smoothed `tone` (200 Hz..20 kHz, exponential).
    fn update_tone(&mut self) {
        let cutoff = 200.0 * (20_000.0f32 / 200.0).powf(self.tone.value());
        let sr = self.sample_rate as f32;
        self.tone_coeff = (-2.0 * std::f32::consts::PI * cutoff / sr).exp();
    }

    /// Advances the tape-style read position and returns the delay in frames.
    #[inline]
    fn advance_time(&mut self) -> f32 {
        let diff = self.target_frames - self.current_frames;
        let desired = (diff * self.approach).clamp(-MAX_TIME_RATE, MAX_TIME_RATE);
        self.velocity += (desired - self.velocity) * self.velocity_coeff;
        self.current_frames += self.velocity;
        if self.velocity.abs() < 1e-6 && diff.abs() < 1e-3 {
            self.current_frames = self.target_frames;
            self.velocity = 0.0;
        }
        self.current_frames.clamp(1.0, self.max_frames - 2.0)
    }

    /// The delay in frames for `time_beats` at `bpm`.
    fn frames_for(&self, time_beats: f32, bpm: f64) -> f32 {
        let bpm = if bpm.is_finite() && bpm > 0.0 {
            bpm as f32
        } else {
            120.0
        };
        (time_beats * 60.0 / bpm * self.sample_rate as f32).clamp(1.0, self.max_frames - 2.0)
    }
}

impl Effect for Delay {
    fn kind(&self) -> FxKind {
        FxKind::Delay
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::Delay.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        match index {
            0 => self.time_beats = value,
            1 => self.feedback.set_target(value),
            2 => self.tone.set_target(value),
            3 => self
                .ping_pong
                .set_target(if value >= 0.5 { 1.0 } else { 0.0 }),
            4 => self.mix.set_target(value),
            _ => {}
        }
    }

    fn reset(&mut self) {
        self.left.clear();
        self.right.clear();
        self.current_frames = self.target_frames;
        self.velocity = 0.0;
        self.feedback.snap();
        self.tone.snap();
        self.ping_pong.snap();
        self.mix.snap();
        self.tone_state_l = 0.0;
        self.tone_state_r = 0.0;
        self.coeff_countdown = 0;
        self.update_tone();
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        self.target_frames = self.frames_for(self.time_beats, ctx.bpm);

        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            let feedback = self.feedback.tick();
            let tone = self.tone.tick();
            let ping = self.ping_pong.tick();
            let mix = self.mix.tick();
            if self.coeff_countdown == 0 {
                // `tone` changed this sample; rebuild the coefficient from it.
                let cutoff = 200.0 * (20_000.0f32 / 200.0).powf(tone);
                self.tone_coeff =
                    (-2.0 * std::f32::consts::PI * cutoff / self.sample_rate as f32).exp();
                self.coeff_countdown = COEFF_UPDATE_FRAMES;
            }
            self.coeff_countdown -= 1;

            let delay = self.advance_time();
            let d_l = self.left.read(delay);
            let d_r = self.right.read(delay);

            let a = self.tone_coeff;
            self.tone_state_l = flush((1.0 - a) * d_l + a * self.tone_state_l);
            self.tone_state_r = flush((1.0 - a) * d_r + a * self.tone_state_r);
            let wet_l = self.tone_state_l;
            let wet_r = self.tone_state_r;

            let dry_l = *l;
            let dry_r = *r;

            // Morph the input routing and the cross-feed together: p = 0 is a plain stereo
            // delay, p = 1 is ping-pong (input on the left line, feedback cross-fed).
            let mono = 0.5 * (dry_l + dry_r);
            let in_l = (1.0 - ping) * dry_l
                + ping * mono
                + feedback * ((1.0 - ping) * wet_l + ping * wet_r);
            let in_r = (1.0 - ping) * dry_r + feedback * ((1.0 - ping) * wet_r + ping * wet_l);
            self.left.write(flush(in_l));
            self.right.write(flush(in_r));

            *l = dry_l + mix * (wet_l - dry_l);
            *r = dry_r + mix * (wet_r - dry_r);
        }
    }

    fn tail(&self) -> usize {
        let feedback = self.feedback.target().clamp(0.0, 0.999_9);
        let echoes = if feedback < 1e-4 {
            1.0
        } else {
            (0.001f32.ln() / feedback.ln()).max(1.0)
        };
        let frames = echoes * self.target_frames;
        frames.min(MAX_TAIL_SEC * self.sample_rate as f32) as usize
    }
}
