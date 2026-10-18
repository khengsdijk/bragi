//! Test signals and a block-driving harness for `Stretcher` implementations.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bragi_dsp::stretch::Stretcher;

/// Deterministic xorshift64* generator, so tests never depend on an RNG crate or a seed source.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }
    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    /// Uniform in `[lo, hi]`.
    pub fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + (self.next_u64() % (hi - lo + 1) as u64) as usize
    }
    /// Uniform in `[-1, 1)`.
    pub fn bipolar(&mut self) -> f32 {
        ((self.next_u64() >> 40) as f32 / (1u64 << 23) as f32) - 1.0
    }
}

pub fn sine(freq_hz: f64, sr: u32, frames: usize, amp: f32) -> Vec<f32> {
    (0..frames)
        .map(|i| amp * (2.0 * std::f64::consts::PI * freq_hz * i as f64 / f64::from(sr)).sin() as f32)
        .collect()
}

pub fn noise(seed: u64, frames: usize, amp: f32) -> Vec<f32> {
    let mut r = Rng::new(seed);
    (0..frames).map(|_| amp * r.bipolar()).collect()
}

/// Decaying noise bursts ("clicks") every `period` frames, starting at `first`.
pub fn click_train(sr: u32, frames: usize, first: usize, period: usize) -> Vec<f32> {
    let mut r = Rng::new(7);
    let decay = (-1.0 / (0.004 * f64::from(sr))).exp() as f32;
    let mut out = vec![0.0f32; frames];
    let mut pos = first;
    while pos < frames {
        let mut g = 0.8f32;
        for s in out.iter_mut().skip(pos).take(sr as usize / 20) {
            *s += g * r.bipolar();
            g *= decay;
        }
        pos += period;
    }
    out
}

/// Drives `st` over the whole of `input`, cutting the output into blocks whose sizes come
/// from `block`. Input past the end is fed as silence. Returns `out_frames` per channel and
/// the total number of input frames the stretcher asked for.
pub fn render(
    st: &mut dyn Stretcher,
    input: &[Vec<f32>],
    out_frames: usize,
    mut block: impl FnMut() -> usize,
) -> (Vec<Vec<f32>>, usize) {
    let ch = input.len();
    let mut out = vec![vec![0.0f32; out_frames]; ch];
    let mut in_pos = 0usize;
    let mut out_pos = 0usize;
    let mut scratch = vec![Vec::<f32>::new(); ch];
    while out_pos < out_frames {
        let n = block().max(1).min(out_frames - out_pos);
        let need = st.input_required(n);
        for (c, s) in scratch.iter_mut().enumerate() {
            s.clear();
            for k in 0..need {
                s.push(input[c].get(in_pos + k).copied().unwrap_or(0.0));
            }
        }
        in_pos += need;
        let ins: Vec<&[f32]> = scratch.iter().map(Vec::as_slice).collect();
        let mut outs: Vec<&mut [f32]> = out.iter_mut().map(|o| &mut o[out_pos..out_pos + n]).collect();
        st.process(&ins, &mut outs);
        out_pos += n;
    }
    (out, in_pos)
}
