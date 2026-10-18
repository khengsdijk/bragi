//! The pure-Rust phase vocoder ([ADR-0002](../../../specs/decisions/ADR-0002-time-stretch.md)).
//!
//! # How it works
//!
//! Time-stretching only. Pitch-shifting is done by reading the source at `pitch` times the
//! output rate (a resample) and letting the vocoder stretch by `ratio · pitch`, which keeps the
//! duration at `ratio` and the pitch at `pitch` ([03 §7] defines `ratio` as output/input
//! duration and `semitones` as pitch-only). Keeping the two stages separate is what makes the
//! pitch exact: a phase vocoder cannot "shift" a partial to a different bin without either
//! aliasing the phase advance or dropping the partial.
//!
//! [03 §7]: ../../../specs/03-audio-engine.md
//!
//! Analysis frames are centred on a grid of resampled positions `pos(k) = round(k·hop/stretch)`;
//! synthesis frames are centred on output positions `k·hop + latency`. Every source bin's
//! analysis phase advance gives an instantaneous frequency, which accumulates into a synthesis
//! phase; identity phase locking keeps the bins around a peak coherent; and a transient detector
//! resets the synthesis phase to the analysis phase on attacks so drum hits stay sharp.
//!
//! Centring matters: a transient is reconstructed around the synthesis frame whose analysis
//! window is centred on it, so the timing error is one analysis hop, not one window. Everything
//! is a pure function of `k` and the ratio history, so the output never depends on how the host
//! slices its blocks.

use realfft::RealFftPlanner;
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealToComplex};
use std::sync::Arc;

use super::{
    MAX_CHANNELS, MAX_RATIO, MAX_SAMPLE_RATE, MAX_SEMITONES, MIN_RATIO, MIN_SAMPLE_RATE,
    MIN_SEMITONES, Quality, StretchError, Stretcher,
};

/// The largest FFT size across tiers; every per-bin scratch buffer is sized for it.
const MAX_N: usize = 2048;

/// `2π`.
const TAU: f64 = std::f64::consts::TAU;

/// Principal argument in `(-π, π]`.
fn princarg(x: f64) -> f64 {
    x - TAU * (x / TAU).round()
}

/// A power of two `>= x`.
fn next_pow2(x: usize) -> usize {
    x.next_power_of_two()
}

/// FFT plans, windows and scratch for one quality tier. Built once in the constructor.
struct Tier {
    n: usize,
    hs: usize,
    half: usize,
    bins: usize,
    w_ana: Vec<f32>,
    w_syn: Vec<f32>,
    /// `1 / (n · Σ w_ana·w_syn)`: undoes the unnormalised FFT round trip and the window overlap.
    scale: f32,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    fwd_scratch: Vec<Complex<f32>>,
    inv_scratch: Vec<Complex<f32>>,
    spectrum: Vec<Complex<f32>>,
    time: Vec<f32>,
}

impl Tier {
    fn new(planner: &mut RealFftPlanner<f32>, quality: Quality) -> Self {
        let n = quality.fft_size();
        let hs = quality.hop();
        let bins = n / 2 + 1;
        // Periodic Hann. With hop = n/4 the overlap-add of w_ana·w_syn is a constant.
        let w: Vec<f32> = (0..n)
            .map(|i| 0.5 * (1.0 - (TAU * i as f64 / n as f64).cos()) as f32)
            .collect();
        // Σ_m w(q−m·hs)² over the frames that overlap q, sampled well inside the stream.
        let probe = n + n / 2;
        let mut cola = 0.0f64;
        let mut m = 0usize;
        while m * hs <= probe {
            let off = probe - m * hs;
            if off < n {
                cola += f64::from(w[off]) * f64::from(w[off]);
            }
            m += 1;
        }
        let scale = if cola > 0.0 {
            (1.0 / (n as f64 * cola)) as f32
        } else {
            0.0
        };
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);
        let fwd_scratch = vec![Complex::new(0.0f32, 0.0); fwd.get_scratch_len()];
        let inv_scratch = vec![Complex::new(0.0f32, 0.0); inv.get_scratch_len()];
        Self {
            n,
            hs,
            half: n / 2,
            bins,
            w_ana: w.clone(),
            w_syn: w,
            scale,
            fwd,
            inv,
            fwd_scratch,
            inv_scratch,
            spectrum: vec![Complex::new(0.0, 0.0); bins],
            time: vec![0.0; n],
        }
    }
}

/// Pure-Rust phase vocoder with identity phase locking and transient phase reset.
///
/// Construct one per clip voice with [`PhaseVocoder::new`], then [`Stretcher::configure`] it and
/// drive it with [`Stretcher::input_required`] / [`Stretcher::process`].
pub struct PhaseVocoder {
    channels: usize,
    sample_rate: u32,
    /// Output/input duration.
    ratio: f64,
    /// Pitch factor `2^(semitones/12)`.
    pitch: f64,
    /// The time ratio the vocoder actually runs at: `ratio · pitch`.
    stretch: f64,
    active: usize,
    tiers: [Tier; 2],
    passthrough: bool,

    /// Output frames handed out so far.
    produced: u64,
    /// Input frames consumed so far.
    in_consumed: u64,
    /// Next synthesis frame to compute.
    frames_done: u64,

    hist: Vec<Vec<f32>>,
    hist_cap: usize,
    ring: Vec<Vec<f32>>,
    ring_cap: usize,

    mags: Vec<Vec<f32>>,
    phases: Vec<Vec<f32>>,
    last_phase: Vec<Vec<f32>>,
    inst_prev: Vec<Vec<f32>>,
    inst_next: Vec<f32>,
    sum_phase: Vec<Vec<f64>>,
    odelta: Vec<f32>,
    peak: Vec<bool>,
    energy_prev: f64,
}

/// `quality` → tier index.
fn tier_index(quality: Quality) -> usize {
    match quality {
        Quality::Preview => 0,
        Quality::Render => 1,
    }
}

impl PhaseVocoder {
    /// Creates a vocoder for `channels` channels at `sample_rate` Hz.
    ///
    /// This is the only call that allocates. Both quality tiers' buffers are allocated here, so
    /// [`Stretcher::configure`] can switch tier on the audio thread without allocating.
    ///
    /// # Errors
    /// [`StretchError::ChannelCount`] or [`StretchError::SampleRate`] out of range.
    pub fn new(channels: usize, sample_rate: u32) -> Result<Self, StretchError> {
        if channels == 0 || channels > MAX_CHANNELS {
            return Err(StretchError::ChannelCount(channels));
        }
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
            return Err(StretchError::SampleRate(sample_rate));
        }
        let mut planner = RealFftPlanner::<f32>::new();
        let tiers = [
            Tier::new(&mut planner, Quality::Preview),
            Tier::new(&mut planner, Quality::Render),
        ];
        let bins_max = MAX_N / 2 + 1;
        let hist_cap = next_pow2(8 * MAX_N);
        let ring_cap = next_pow2(2 * (MAX_N + MAX_N / 4));
        let zero_bins = || vec![0.0f64; bins_max];
        let zero_bins_f = || vec![0.0f32; bins_max];
        Ok(Self {
            channels,
            sample_rate,
            ratio: 1.0,
            pitch: 1.0,
            stretch: 1.0,
            active: 0,
            tiers,
            passthrough: true,
            produced: 0,
            in_consumed: 0,
            frames_done: 0,
            hist: (0..channels).map(|_| vec![0.0f32; hist_cap]).collect(),
            hist_cap,
            ring: (0..channels).map(|_| vec![0.0f32; ring_cap]).collect(),
            ring_cap,
            mags: (0..channels).map(|_| zero_bins_f()).collect(),
            phases: (0..channels).map(|_| zero_bins_f()).collect(),
            last_phase: (0..channels).map(|_| zero_bins_f()).collect(),
            inst_prev: (0..channels).map(|_| zero_bins_f()).collect(),
            inst_next: vec![0.0f32; bins_max],
            sum_phase: (0..channels).map(|_| zero_bins()).collect(),
            odelta: vec![0.0f32; bins_max],
            peak: vec![false; bins_max],
            energy_prev: 0.0,
        })
    }

    /// The sample rate this instance was built for, in Hz.
    #[must_use]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// The number of channels this instance was built for.
    #[must_use]
    pub fn channels(&self) -> usize {
        self.channels
    }

    fn tier(&self) -> &Tier {
        &self.tiers[self.active]
    }

    /// The active quality tier's FFT size, also the algorithmic latency in output frames.
    fn n(&self) -> usize {
        self.tier().n
    }

    /// Core output position that is final after `frames` synthesis frames.
    fn boundary_after(&self, frames: u64) -> u64 {
        frames * self.tier().hs as u64 + self.tier().half as u64
    }

    /// Resampled-source frame position of synthesis frame `k`.
    fn pos(&self, k: u64) -> u64 {
        let hs = self.tier().hs as f64;
        (k as f64 * hs / self.stretch).round() as u64
    }

    /// Source frames needed to read resampled frames `< up_to`.
    fn orig_needed(&self, up_to: u64) -> u64 {
        (up_to as f64 * self.pitch).floor() as u64 + 3
    }

    /// Synthesis frames needed to have produced `p` output frames.
    fn frames_for(&self, p: u64) -> u64 {
        let half = self.tier().half as u64;
        let hs = self.tier().hs as u64;
        if p <= half {
            0
        } else {
            (p - half).div_ceil(hs)
        }
    }

    /// Total input frames needed to produce `p` output frames.
    fn in_needed(&self, p: u64) -> u64 {
        let k = self.frames_for(p);
        if k == 0 {
            0
        } else {
            self.orig_needed(self.pos(k - 1) + self.n() as u64)
        }
    }

    /// Reads `hist[c]` at absolute frame `abs` (must be `< in_consumed`).
    fn hist_at(&self, c: usize, abs: u64) -> f32 {
        self.hist[c][(abs % self.hist_cap as u64) as usize]
    }

    /// A Catmull-Rom interpolated source sample at resampled position `m`.
    ///
    /// Cubic rather than linear: linear interpolation ripples enough on a steady tone to trip
    /// the transient detector, which then jitters the pitch.
    fn read_resampled(&self, c: usize, m: i64) -> f32 {
        if m < 0 {
            return 0.0;
        }
        let f = m as f64 * self.pitch;
        let i0 = f.floor();
        let t = (f - i0) as f32;
        let i = i0 as i64;
        let p0 = if i < 1 {
            0.0
        } else {
            self.hist_at(c, (i - 1) as u64)
        };
        let p1 = self.hist_at(c, i as u64);
        let p2 = self.hist_at(c, (i + 1) as u64);
        let p3 = self.hist_at(c, (i + 2) as u64);
        let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
        let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
        let c1 = -0.5 * p0 + 0.5 * p2;
        ((a * t + b) * t + c1) * t + p1
    }

    /// Appends source frames to the history until it covers `up_to`, taking samples from `input`.
    fn fill_history(&mut self, up_to: u64, input: &[&[f32]], cursor: &mut usize) {
        while self.in_consumed < up_to {
            let i = self.in_consumed;
            for c in 0..self.channels {
                let v = input
                    .get(c)
                    .and_then(|s| s.get(*cursor))
                    .copied()
                    .unwrap_or(0.0);
                self.hist[c][(i % self.hist_cap as u64) as usize] = v;
            }
            *cursor += 1;
            self.in_consumed += 1;
        }
    }

    /// Writes final output frames `[produced, up_to)` to `out`, zeroing the ring as it goes.
    fn flush(&mut self, up_to: u64, produced_base: u64, out: &mut [&mut [f32]]) {
        while self.produced < up_to {
            let idx = (self.produced % self.ring_cap as u64) as usize;
            let rel = (self.produced - produced_base) as usize;
            for c in 0..self.channels {
                let v = self.ring[c][idx];
                self.ring[c][idx] = 0.0;
                if let Some(ch) = out.get_mut(c)
                    && rel < ch.len()
                {
                    ch[rel] = v;
                }
            }
            self.produced += 1;
        }
    }

    /// Computes synthesis frame `k` and overlap-adds it into the output ring.
    fn render_frame(&mut self, k: u64, cursor: &mut usize, input: &[&[f32]]) {
        let active = self.active;
        let n = self.tier().n;
        let hs = self.tier().hs;
        let bins = self.tier().bins;
        let half = self.tier().half;

        let pos_k = self.pos(k);
        self.fill_history(self.orig_needed(pos_k + n as u64), input, cursor);
        let ha = if k == 0 {
            hs as f64 / self.stretch
        } else {
            (pos_k - self.pos(k - 1)) as f64
        };
        let ha = ha.max(1e-6);

        // 1. Windowed forward FFT per channel, and a pooled frame energy for transient detection.
        let mut energy = 0.0f64;
        let inv_n = 1.0f32 / n as f32;
        for c in 0..self.channels {
            for u in 0..n {
                let m = pos_k as i64 - half as i64 + u as i64;
                let x = self.read_resampled(c, m);
                let w = self.tier().w_ana[u];
                self.tiers[active].time[u] = x * w;
            }
            let tier = &mut self.tiers[active];
            let _ = tier.fwd.process_with_scratch(
                &mut tier.time,
                &mut tier.spectrum,
                &mut tier.fwd_scratch,
            );
            for b in 0..bins {
                let re = self.tier().spectrum[b].re;
                let im = self.tier().spectrum[b].im;
                let m = (re * re + im * im).sqrt();
                self.mags[c][b] = m;
                self.phases[c][b] = im.atan2(re);
                let mn = m * inv_n;
                energy += f64::from(mn * mn);
            }
        }

        // 2. Transient? A rise in frame energy resets every synthesis phase to its analysis
        //    phase, keeping attacks sharp instead of smeared across the window. The energy gate
        //    (not raw spectral flux) is what stops it firing on a steady tone.
        let transient = k == 0 || (energy > 1.5 * self.energy_prev && energy > 1e-6);
        self.energy_prev = energy;

        // 3. Phase propagation with identity phase locking, then inverse FFT and overlap-add.
        let two_pi_over_n = TAU / n as f64;
        let start = k * hs as u64 + (n - half) as u64;
        for c in 0..self.channels {
            for b in 0..bins {
                // Predict the phase advance from the previous frame's instantaneous frequency,
                // not from the bin centre: that is what lets a hop larger than the window's
                // half-period (~time compression) unwrap without aliasing.
                let predicted = f64::from(self.inst_prev[c][b]) * ha;
                let d = princarg(
                    f64::from(self.phases[c][b]) - f64::from(self.last_phase[c][b]) - predicted,
                );
                let inst = f64::from(self.inst_prev[c][b]) + d / ha;
                self.odelta[b] = (inst * hs as f64) as f32;
                self.inst_next[b] = inst as f32;
            }
            if transient {
                for b in 0..bins {
                    self.sum_phase[c][b] = f64::from(self.phases[c][b]);
                    self.inst_next[b] = (two_pi_over_n * b as f64) as f32;
                }
            } else {
                for b in 0..bins {
                    self.sum_phase[c][b] += f64::from(self.odelta[b]);
                }
                for b in 0..bins {
                    self.peak[b] = false;
                }
                for b in 1..bins - 1 {
                    if self.mags[c][b] > self.mags[c][b - 1]
                        && self.mags[c][b] >= self.mags[c][b + 1]
                    {
                        self.peak[b] = true;
                    }
                }
                for b in 1..bins - 1 {
                    if self.peak[b] {
                        for j in [b - 1, b + 1] {
                            if !self.peak[j] {
                                self.sum_phase[c][j] = self.sum_phase[c][b]
                                    + f64::from(self.phases[c][j] - self.phases[c][b]);
                                self.inst_next[j] = self.inst_next[b];
                            }
                        }
                    }
                }
            }
            for b in 0..bins {
                self.tiers[active].spectrum[b] =
                    Complex::from_polar(self.mags[c][b], self.sum_phase[c][b] as f32);
            }
            self.tiers[active].spectrum[0].im = 0.0;
            self.tiers[active].spectrum[bins - 1].im = 0.0;
            let tier = &mut self.tiers[active];
            let _ = tier.inv.process_with_scratch(
                &mut tier.spectrum,
                &mut tier.time,
                &mut tier.inv_scratch,
            );
            let scale = self.tier().scale;
            for u in 0..n {
                let y = self.tier().time[u] * self.tier().w_syn[u] * scale;
                let idx = ((start + u as u64) % self.ring_cap as u64) as usize;
                self.ring[c][idx] += y;
            }
            for b in 0..bins {
                self.last_phase[c][b] = self.phases[c][b];
                self.inst_prev[c][b] = self.inst_next[b];
            }
        }
    }
}

impl Stretcher for PhaseVocoder {
    fn configure(
        &mut self,
        ratio: f64,
        semitones: f32,
        quality: Quality,
    ) -> Result<(), StretchError> {
        if !ratio.is_finite() || !(MIN_RATIO..=MAX_RATIO).contains(&ratio) {
            return Err(StretchError::RatioOutOfRange(ratio));
        }
        if !semitones.is_finite() || !(MIN_SEMITONES..=MAX_SEMITONES).contains(&semitones) {
            return Err(StretchError::SemitonesOutOfRange(semitones));
        }
        self.ratio = ratio;
        self.pitch = f64::from(2f32.powf(semitones / 12.0));
        self.stretch = ratio * self.pitch;
        self.active = tier_index(quality);
        self.passthrough = ratio == 1.0 && semitones == 0.0;
        self.reset();
        Ok(())
    }

    fn input_required(&self, out_frames: usize) -> usize {
        if self.passthrough {
            return out_frames;
        }
        let target = self.produced + out_frames as u64;
        self.in_needed(target).saturating_sub(self.in_consumed) as usize
    }

    fn process(&mut self, input: &[&[f32]], out: &mut [&mut [f32]]) {
        let nframes = out.iter().map(|c| c.len()).max().unwrap_or(0);
        if self.passthrough {
            for (c, ch) in out.iter_mut().enumerate() {
                let src = input.get(c);
                for (i, s) in ch.iter_mut().enumerate() {
                    *s = src.and_then(|x| x.get(i)).copied().unwrap_or(0.0);
                }
            }
            self.produced += nframes as u64;
            self.in_consumed += nframes as u64;
            return;
        }
        if nframes == 0 {
            return;
        }
        let produced_base = self.produced;
        let target = produced_base + nframes as u64;
        let k_total = self.frames_for(target);

        // Samples before the first synthesis frame's window are silence in the ring.
        let first = self.boundary_after(0).min(target);
        if self.produced < first {
            self.flush(first, produced_base, out);
        }
        let mut cursor = 0usize;
        while self.frames_done < k_total {
            let k = self.frames_done;
            self.render_frame(k, &mut cursor, input);
            self.frames_done += 1;
            let boundary = self.boundary_after(self.frames_done).min(target);
            self.flush(boundary, produced_base, out);
        }
        self.flush(target, produced_base, out);
        debug_assert!(self.produced == target);
    }

    fn latency(&self) -> usize {
        if self.passthrough { 0 } else { self.n() }
    }

    fn look_ahead(&self) -> usize {
        // One window of resampled input (scaled by the pitch factor), plus the analysis-grid
        // rounding (at most `hs / MIN_RATIO` frames). `8·n·pitch` bounds both.
        if self.passthrough {
            0
        } else {
            (8.0 * self.n() as f64 * self.pitch) as usize
        }
    }

    fn reset(&mut self) {
        self.produced = 0;
        self.in_consumed = 0;
        self.frames_done = 0;
        self.energy_prev = 0.0;
        for c in 0..self.channels {
            self.hist[c].fill(0.0);
            self.ring[c].fill(0.0);
            self.mags[c].fill(0.0);
            self.phases[c].fill(0.0);
            self.last_phase[c].fill(0.0);
            self.inst_prev[c].fill(0.0);
            self.sum_phase[c].fill(0.0);
        }
    }

    fn ratio(&self) -> f64 {
        self.ratio
    }
}
