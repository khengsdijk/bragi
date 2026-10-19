//! Float to integer conversion with optional, seeded TPDF dither
//! (`specs/03-audio-engine.md` §9).
//!
//! Offline output is deterministic: with no seed there is no dither and the
//! conversion is a plain round-to-nearest. With a seed, triangular dither from
//! a xorshift64* generator is added, so the same seed reproduces the same bytes.

/// Converts `f32` samples to signed integers of `bits` bits.
#[derive(Clone, Debug)]
pub struct Quantizer {
    scale: f64,
    min: f64,
    max: f64,
    rng: Option<u64>,
}

impl Quantizer {
    /// A quantizer for `bits` (8..=32) with dither when `seed` is `Some`.
    #[must_use]
    pub fn new(bits: u8, seed: Option<u64>) -> Self {
        let bits = bits.clamp(8, 32);
        let scale = (1u64 << (bits - 1)) as f64;
        Self {
            scale,
            min: -scale,
            max: scale - 1.0,
            // xorshift must never hold 0; mix the seed so seed 0 is valid too.
            rng: seed.map(|seed| seed ^ 0x9e37_79b9_7f4a_7c15),
        }
    }

    fn next_uniform(state: &mut u64) -> f64 {
        let mut x = *state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        *state = x;
        let value = x.wrapping_mul(0x2545_f491_4f6c_dd1d);
        (value >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Converts one sample.
    pub fn quantize(&mut self, sample: f32) -> i32 {
        if !sample.is_finite() {
            return 0;
        }
        let mut value = f64::from(sample) * self.scale;
        if let Some(state) = self.rng.as_mut() {
            // TPDF: the difference of two uniforms spans (-1, 1) LSB.
            value += Self::next_uniform(state) - Self::next_uniform(state);
        }
        value.round().clamp(self.min, self.max) as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_and_clamps_without_dither() {
        let mut q = Quantizer::new(16, None);
        assert_eq!(q.quantize(0.0), 0);
        assert_eq!(q.quantize(0.5), 16384);
        assert_eq!(q.quantize(-1.0), -32768);
        assert_eq!(q.quantize(1.0), 32767);
        assert_eq!(q.quantize(2.0), 32767);
        assert_eq!(q.quantize(f32::NAN), 0);
    }

    #[test]
    fn twenty_four_bit_scale() {
        let mut q = Quantizer::new(24, None);
        assert_eq!(q.quantize(-1.0), -8_388_608);
        assert_eq!(q.quantize(1.0), 8_388_607);
    }

    #[test]
    fn dither_is_reproducible_and_seed_dependent() {
        let run = |seed| {
            let mut q = Quantizer::new(16, Some(seed));
            (0..256).map(|_| q.quantize(0.001)).collect::<Vec<_>>()
        };
        assert_eq!(run(7), run(7));
        assert_ne!(run(7), run(8));
        // Without dither the same input is constant.
        let mut plain = Quantizer::new(16, None);
        assert!((0..256).all(|_| plain.quantize(0.001) == 33));
        // Dither actually moves values around the rounded one.
        assert!(run(7).iter().any(|value| *value != 33));
    }
}
