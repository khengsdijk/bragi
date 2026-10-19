//! `match_eq` (03 §6, §8.2): 31 peaking bands at the ISO 1/3-octave centres, used to smooth the
//! colour difference at a seam.
//!
//! Each band is a peaking bell with Q 4.32 built as a **fixed** 0 dB-peak RBJ band-pass at the
//! band centre whose output is scaled by `10^(gain_db/20) − 1` and added back to the input:
//! `y = x + mul · BP(x)`, so the magnitude at the centre is exactly `band_i · amount` dB, the
//! response is 0 dB at DC and Nyquist, and only the scalar `mul` moves when a knob turns. That
//! matters: recomputing resonant biquad coefficients while audio flows excites a ring at the band
//! centre (measured about −41 dBFS during a full-range sweep), whereas a scalar gain is smooth by
//! construction. `mul` is smoothed per sample, and with every band at 0 dB (so `mul == 0`) the
//! effect is a bit-exact pass-through.

use super::{BiquadCoeffs, Effect, FxContext, FxKind, MATCH_EQ_BANDS, Smoothed, StereoBiquad};

/// ISO 1/3-octave band centres, 20 Hz … 20 kHz.
const CENTRES_HZ: [f32; MATCH_EQ_BANDS] = [
    20.0, 25.0, 31.5, 40.0, 50.0, 63.0, 80.0, 100.0, 125.0, 160.0, 200.0, 250.0, 315.0, 400.0,
    500.0, 630.0, 800.0, 1000.0, 1250.0, 1600.0, 2000.0, 2500.0, 3150.0, 4000.0, 5000.0, 6300.0,
    8000.0, 10_000.0, 12_500.0, 16_000.0, 20_000.0,
];

/// Q of one 1/3-octave band: `1 / (2·sinh(ln 2 / 6))`.
const BAND_Q: f32 = 4.32;

/// The `match_eq` effect.
#[derive(Debug, Clone)]
pub struct MatchEq {
    /// The fixed band-pass per band; its coefficients never change after construction.
    bands: [StereoBiquad; MATCH_EQ_BANDS],
    /// The scalar `10^(gain_db/20) − 1` added to the band-pass output, glided per sample.
    mul: [Smoothed; MATCH_EQ_BANDS],
    /// The catalogue targets, so `amount` can rescale every band when it moves.
    band_db: [f32; MATCH_EQ_BANDS],
    amount: f32,
    bypass: bool,
}

impl MatchEq {
    /// A flat `match_eq` (every band 0 dB, `amount` 1).
    #[must_use]
    pub fn new(sample_rate: u32, max_block: usize) -> Self {
        let _ = max_block;
        let mut eq = Self {
            bands: std::array::from_fn(|i| {
                StereoBiquad::new(BiquadCoeffs::band_pass(CENTRES_HZ[i], BAND_Q, sample_rate))
            }),
            mul: [Smoothed::new(0.0, sample_rate, super::DEFAULT_SMOOTHING_MS); MATCH_EQ_BANDS],
            band_db: [0.0; MATCH_EQ_BANDS],
            amount: 1.0,
            bypass: true,
        };
        eq.reset();
        eq
    }

    /// Points band `band`'s multiplier at `10^(band_db · amount / 20) − 1`.
    fn update_band(&mut self, band: usize) {
        let gain_db = self.band_db[band] * self.amount;
        let amp = 10.0f32.powf(gain_db / 20.0);
        self.mul[band].set_target(amp - 1.0);
    }
}

impl Effect for MatchEq {
    fn kind(&self) -> FxKind {
        FxKind::MatchEq
    }

    fn set_param(&mut self, index: usize, value: f32) {
        let Some(spec) = FxKind::MatchEq.params().get(index) else {
            return;
        };
        let Some(value) = spec.clamp(value) else {
            return;
        };
        if index < MATCH_EQ_BANDS {
            self.band_db[index] = value;
            self.update_band(index);
        } else {
            self.amount = value;
            for band in 0..MATCH_EQ_BANDS {
                self.update_band(band);
            }
        }
    }

    fn reset(&mut self) {
        for band in 0..MATCH_EQ_BANDS {
            self.update_band(band);
            self.mul[band].snap();
            self.bands[band].reset();
        }
        self.bypass = self.mul.iter().all(|m| m.value() == 0.0);
    }

    fn process(&mut self, left: &mut [f32], right: &mut [f32], _ctx: &FxContext<'_>) {
        let frames = left.len().min(right.len());
        let active = self.mul.iter().any(|m| m.value() != 0.0 || !m.is_settled());
        if !active {
            if !self.bypass {
                for biquad in &mut self.bands {
                    biquad.reset();
                }
                self.bypass = true;
            }
            return; // every band is 0 dB and settled: bit-exact pass-through.
        }
        self.bypass = false;

        for (l, r) in left[..frames].iter_mut().zip(&mut right[..frames]) {
            let (mut wl, mut wr) = (*l, *r);
            for band in 0..MATCH_EQ_BANDS {
                let mul = self.mul[band].tick();
                let (bl, br) = self.bands[band].tick(wl, wr);
                wl += mul * bl;
                wr += mul * br;
            }
            *l = wl;
            *r = wr;
        }
    }
}
