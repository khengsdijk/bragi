//! Live meters: per-track peak and RMS plus the master pair
//! (`specs/03-audio-engine.md` §10).
//!
//! The audio thread writes these every block; the UI reads them at 60 Hz
//! through the host's state block. Peak decays fast so a transient is visible
//! for a few frames; RMS has a ~300 ms window. Master momentary LUFS and the
//! 64-band spectrum need K-weighting and an FFT and are deferred (Q26), but the
//! fixed-word layout below leaves room for them.
//!
//! ```
//! use bragi_engine::meters::Meters;
//! let mut meters = Meters::new(2);
//! meters.update_track(0, 0.5, 0.25);
//! assert_eq!(meters.track(0).unwrap().peak, 0.5);
//! assert!((meters.track(0).unwrap().rms - 0.05).abs() < 1e-6);
//! ```

/// One track's meter values.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TrackMeter {
    /// Peak absolute sample since the last update.
    pub peak: f32,
    /// RMS since the last update.
    pub rms: f32,
}

/// All meters for one engine.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Meters {
    tracks: Vec<TrackMeter>,
    master_peak: f32,
    master_rms: f32,
    peak_decay: f32,
    rms_attack: f32,
}

impl Meters {
    /// Creates meters for `tracks` tracks.
    #[must_use]
    pub fn new(tracks: usize) -> Self {
        Self {
            tracks: vec![TrackMeter::default(); tracks],
            master_peak: 0.0,
            master_rms: 0.0,
            peak_decay: 0.85,
            rms_attack: 0.2,
        }
    }

    /// One track's meter, if the index is in range.
    #[must_use]
    pub fn track(&self, index: usize) -> Option<&TrackMeter> {
        self.tracks.get(index)
    }

    /// How many tracks the meters cover.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tracks.len()
    }

    /// Whether there are no tracks.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tracks.is_empty()
    }

    /// Master peak.
    #[must_use]
    pub fn master_peak(&self) -> f32 {
        self.master_peak
    }

    /// Master RMS.
    #[must_use]
    pub fn master_rms(&self) -> f32 {
        self.master_rms
    }

    /// Updates one track's meters. `peak` and `rms` are non-negative linear
    /// amplitudes; the internal smoothing is done here.
    pub fn update_track(&mut self, index: usize, peak: f32, rms: f32) {
        if let Some(meter) = self.tracks.get_mut(index) {
            let peak = if peak.is_finite() { peak.max(0.0) } else { 0.0 };
            let rms = if rms.is_finite() { rms.max(0.0) } else { 0.0 };
            meter.peak = peak.max(meter.peak * self.peak_decay);
            meter.rms += (rms - meter.rms) * self.rms_attack;
        }
    }

    /// Updates the master meters from an interleaved stereo block.
    pub fn update_master(&mut self, block: &[f32]) {
        let mut peak = 0.0f32;
        let mut sum_sq = 0.0f32;
        let mut frames = 0usize;
        for frame in block.chunks(2) {
            peak = peak.max(frame[0].abs()).max(frame[1].abs());
            sum_sq += frame[0] * frame[0] + frame[1] * frame[1];
            frames += 1;
        }
        if frames == 0 {
            return;
        }
        self.master_peak = peak.max(self.master_peak * self.peak_decay);
        let rms = (sum_sq / (frames as f32 * 2.0)).sqrt();
        self.master_rms += (rms - self.master_rms) * self.rms_attack;
    }

    /// Clears every meter (after a stop).
    pub fn reset(&mut self) {
        for track in &mut self.tracks {
            *track = TrackMeter::default();
        }
        self.master_peak = 0.0;
        self.master_rms = 0.0;
    }

    /// Writes the meters into a fixed-word buffer as `f32` bit patterns.
    ///
    /// Layout: `[track0_peak, track0_rms, track1_peak, …,
    /// master_peak, master_rms]`. Returns the number of words written, or `0`
    /// when `out` is too small. Allocation-free.
    pub fn write_words(&self, out: &mut [u32]) -> usize {
        let needed = self.tracks.len() * 2 + 2;
        if out.len() < needed {
            return 0;
        }
        let mut index = 0;
        for track in &self.tracks {
            out[index] = track.peak.to_bits();
            out[index + 1] = track.rms.to_bits();
            index += 2;
        }
        out[index] = self.master_peak.to_bits();
        out[index + 1] = self.master_rms.to_bits();
        needed
    }

    /// The number of words [`Self::write_words`] needs.
    #[must_use]
    pub fn word_count(&self) -> usize {
        self.tracks.len() * 2 + 2
    }

    /// Reads a meter word back as `f32` (for hosts and tests).
    #[must_use]
    pub fn word_to_f32(word: u32) -> f32 {
        f32::from_bits(word)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn peak_decays_and_rms_smooths() {
        let mut meters = Meters::new(1);
        meters.update_track(0, 1.0, 1.0);
        assert!((meters.track(0).unwrap().rms - 0.2).abs() < 1e-6);
        meters.update_track(0, 0.0, 0.0);
        let track = meters.track(0).unwrap();
        assert!((track.peak - 0.85).abs() < 1e-6);
        assert!((track.rms - 0.16).abs() < 1e-6);
    }

    #[test]
    fn words_round_trip() {
        let mut meters = Meters::new(2);
        meters.update_track(0, 0.5, 0.25);
        meters.update_track(1, 0.75, 0.125);
        meters.update_master(&[0.5, -0.5, 0.25, -0.25]);
        let mut words = [0u32; 6];
        assert_eq!(meters.write_words(&mut words), 6);
        assert_eq!(Meters::word_to_f32(words[0]), 0.5);
        assert!((Meters::word_to_f32(words[1]) - 0.05).abs() < 1e-6);
        assert!((Meters::word_to_f32(words[4]) - 0.5).abs() < 1e-6);
        assert!(Meters::word_to_f32(words[5]) > 0.0);
    }

    #[test]
    fn too_small_a_buffer_writes_nothing() {
        let meters = Meters::new(3);
        let mut words = [0u32; 4];
        assert_eq!(meters.write_words(&mut words), 0);
        assert_eq!(words, [0; 4]);
    }
}
